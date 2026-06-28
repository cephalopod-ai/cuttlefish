import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { EmailAttachmentRecord, EmailConfig, EmailInboxConfig, EmailInboxHealth, EmailMessageRecord } from "../shared/types.js";
import { FILES_DIR } from "../shared/paths.js";
import { logger } from "../shared/logger.js";
import { sanitizeUploadFilename } from "../gateway/files/storage.js";
import { getEmailIngestState, getEmailMessage, listEmailInboxHealth, listEmailMessages, persistEmailMessageWithState, setEmailInboxHealth } from "./store.js";
import type { EmailMailboxClient } from "./client.js";
import { normalizeEmail } from "./normalize.js";
import { insertFile } from "../sessions/registry.js";

export interface EmailServiceDeps {
  client: EmailMailboxClient;
  onAutoIngest?: (message: EmailMessageRecord) => Promise<string | null>;
}

export interface EmailCheckResult {
  inboxId: string;
  checked: number;
  messages: EmailMessageRecord[];
}

async function persistAttachment(messageId: string, attachment: {
  id: string;
  filename: string;
  contentType: string;
  size: number;
  content: Buffer;
  contentId?: string | null;
}): Promise<EmailAttachmentRecord> {
  const artifactId = crypto.randomUUID();
  const filename = sanitizeUploadFilename(attachment.filename);
  const dir = path.join(FILES_DIR, artifactId);
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, filename);
  fs.writeFileSync(filePath, attachment.content);
  insertFile({
    id: artifactId,
    filename,
    size: attachment.size,
    mimetype: attachment.contentType,
    path: filePath,
    sha256: crypto.createHash("sha256").update(attachment.content).digest("hex"),
    artifactKind: "downloaded",
    sourcePath: `email:${messageId}:${attachment.id}`,
  });
  return {
    id: attachment.id,
    filename,
    contentType: attachment.contentType,
    size: attachment.size,
    artifactId,
    contentId: attachment.contentId ?? null,
  };
}

export class EmailService {
  private config: EmailConfig;
  private readonly client: EmailMailboxClient;
  private readonly onAutoIngest?: (message: EmailMessageRecord) => Promise<string | null>;
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly inFlight = new Set<string>();

  constructor(config: EmailConfig | undefined, deps: EmailServiceDeps) {
    this.config = config ?? {};
    this.client = deps.client;
    this.onAutoIngest = deps.onAutoIngest;
  }

  setConfig(config: EmailConfig | undefined): void {
    this.config = config ?? {};
  }

  start(): void {
    this.stop();
    if (this.config.enabled !== true || !this.config.inboxes?.length) return;
    const intervalMs = Math.max(15, this.config.pollIntervalSeconds ?? 60) * 1000;
    this.timer = setInterval(() => {
      void this.checkAll().catch((err) => logger.error(`Email poll loop failed: ${err instanceof Error ? err.message : String(err)}`));
    }, intervalMs);
    this.timer.unref?.();
    void this.checkAll().catch((err) => logger.error(`Email startup poll failed: ${err instanceof Error ? err.message : String(err)}`));
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  listInboxes(): Array<EmailInboxConfig & { health?: EmailInboxHealth }> {
    const healthByInbox = new Map(listEmailInboxHealth().map((entry) => [entry.inboxId, entry]));
    return (this.config.inboxes ?? []).map((inbox) => ({ ...inbox, health: healthByInbox.get(inbox.id) }));
  }

  listMessages(inboxId: string, limit = 20): EmailMessageRecord[] {
    return listEmailMessages(inboxId, limit);
  }

  getMessage(messageId: string): EmailMessageRecord | undefined {
    return getEmailMessage(messageId);
  }

  async checkAll(): Promise<EmailCheckResult[]> {
    const results: EmailCheckResult[] = [];
    for (const inbox of this.config.inboxes ?? []) {
      results.push(await this.checkInbox(inbox.id));
    }
    return results;
  }

  async checkInbox(inboxId: string): Promise<EmailCheckResult> {
    const inbox = (this.config.inboxes ?? []).find((entry) => entry.id === inboxId);
    if (!inbox) throw new Error(`Unknown inbox ${inboxId}`);
    if (this.inFlight.has(inbox.id)) {
      return { inboxId: inbox.id, checked: 0, messages: this.listMessages(inbox.id, inbox.maxMessagesPerPoll ?? 10) };
    }
    this.inFlight.add(inbox.id);
    const checkedAt = new Date().toISOString();
    try {
      const fetched = await this.client.fetchUnread(inbox);
      const results: EmailMessageRecord[] = [];
      for (const message of fetched) {
        const existing = getEmailIngestState(inbox.id, message.providerMessageId);
        const existingMessage = existing?.emailMessageId ? getEmailMessage(existing.emailMessageId) : undefined;
        const normalized = await normalizeEmail(inbox, message.providerMessageId, message.raw);
        const persistedAttachments: EmailAttachmentRecord[] = existingMessage?.attachments?.length
          ? existingMessage.attachments
          : await Promise.all(normalized.attachments.map((attachment) => persistAttachment(normalized.record.id, attachment)));
        // Preserve the prior lifecycle status (never downgrade error -> cached) and
        // write the message + its ingest/dedup state atomically so the two tables
        // cannot diverge.
        const baseStatus = existing?.status ?? normalized.record.status;
        const persisted = persistEmailMessageWithState({
          ...normalized.record,
          attachments: persistedAttachments,
          status: baseStatus,
          sessionId: existing?.sessionId ?? null,
          error: existing?.error ?? null,
        }, { status: baseStatus, sessionId: existing?.sessionId ?? null, error: existing?.error ?? null });
        if (inbox.autoIngest !== false && existing?.status !== "ingested" && this.onAutoIngest) {
          try {
            const sessionId = await this.onAutoIngest(persisted);
            results.push(persistEmailMessageWithState(
              { ...persisted, status: "ingested", sessionId, error: null },
              { status: "ingested", sessionId, error: null },
            ));
          } catch (err) {
            const error = err instanceof Error ? err.message : String(err);
            results.push(persistEmailMessageWithState(
              { ...persisted, status: "error", sessionId: null, error },
              { status: "error", sessionId: null, error },
            ));
          }
        } else {
          results.push(persisted);
        }
      }
      // A successful fetch where one or more messages failed to ingest is degraded,
      // not healthy — the inbox is reachable but not fully processing.
      const anyError = results.some((entry) => entry.status === "error");
      setEmailInboxHealth({
        inboxId: inbox.id,
        status: anyError ? "degraded" : "ok",
        detail: anyError ? "one or more messages failed to ingest" : null,
        lastCheckedAt: checkedAt,
        lastSuccessAt: checkedAt,
        lastErrorAt: anyError ? checkedAt : null,
      });
      return { inboxId: inbox.id, checked: fetched.length, messages: results };
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      setEmailInboxHealth({
        inboxId: inbox.id,
        status: "error",
        detail,
        lastCheckedAt: checkedAt,
        lastSuccessAt: null,
        lastErrorAt: checkedAt,
      });
      return { inboxId: inbox.id, checked: 0, messages: [] };
    } finally {
      this.inFlight.delete(inbox.id);
    }
  }
}
