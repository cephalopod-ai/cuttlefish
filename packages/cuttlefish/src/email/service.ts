import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { EmailAttachmentRecord, EmailConfig, EmailInboxConfig, EmailInboxHealth, EmailMessageRecord } from "../shared/types.js";
import { FILES_DIR } from "../shared/paths.js";
import { logger } from "../shared/logger.js";
import { sanitizeUploadFilename } from "../gateway/files/storage.js";
import { emailMessageId, getEmailMessage, listEmailInboxHealth, listEmailMessages, persistEmailMessageWithState, resolveEmailIngestState, setEmailInboxHealth } from "./store.js";

/** Default hard cap on a single raw message's size (25 MiB). Overridable per inbox. */
const DEFAULT_MAX_MESSAGE_BYTES = 25 * 1024 * 1024;

/**
 * Whether an email sender is allowed to auto-trigger an agent run. Fail-closed:
 * if the inbox has no `allowFrom`, NO sender auto-ingests (messages are cached
 * for manual review). Entries match a full address, a bare domain, or `@domain`.
 */
export function emailSenderAllowed(allowFrom: string[] | undefined, fromAddress: string | null): boolean {
  if (!allowFrom || allowFrom.length === 0) return false;
  if (!fromAddress) return false;
  const addr = fromAddress.trim().toLowerCase();
  const domain = addr.includes("@") ? addr.slice(addr.lastIndexOf("@") + 1) : "";
  return allowFrom.some((raw) => {
    const entry = raw.trim().toLowerCase();
    if (!entry) return false;
    if (entry.startsWith("@")) return domain.length > 0 && domain === entry.slice(1);
    if (!entry.includes("@")) return domain.length > 0 && domain === entry;
    return addr === entry;
  });
}

function failedEmailAuth(authResults: string | null): string | null {
  if (!authResults) return null;
  const normalized = authResults.toLowerCase();
  if (normalized.includes("spf=fail")) return "SPF";
  if (normalized.includes("dkim=fail")) return "DKIM";
  return null;
}
import type { EmailMailboxClient } from "./client.js";
import { normalizeEmail, MAX_RAW_MESSAGE_BYTES } from "./normalize.js";
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
  // Sanitize attachment names before persisting because inbound MIME filenames are untrusted.
  const filename = sanitizeUploadFilename(attachment.filename);
  const dir = path.join(FILES_DIR, artifactId);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const filePath = path.join(dir, filename);
  fs.writeFileSync(filePath, attachment.content, { mode: 0o600 });
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
      const maxBytes = Math.min(inbox.maxMessageBytes ?? DEFAULT_MAX_MESSAGE_BYTES, MAX_RAW_MESSAGE_BYTES);
      const results: EmailMessageRecord[] = [];
      for (const message of fetched) {
        // Resource bound: never parse/persist an oversized raw message — mailparser
        // would load the whole buffer into memory. Record it as a visible error.
        if (message.raw.length > maxBytes) {
          const id = emailMessageId(inbox.id, message.providerMessageId);
          const reason = `message exceeds size limit (${message.raw.length} > ${maxBytes} bytes)`;
          results.push(persistEmailMessageWithState({
            id,
            inboxId: inbox.id,
            providerMessageId: message.providerMessageId,
            messageIdHeader: null,
            threadKey: id,
            fromAddress: null,
            toAddresses: [],
            ccAddresses: [],
            subject: null,
            receivedAt: null,
            textBody: "",
            htmlBody: null,
            headers: {},
            authResults: null,
            attachments: [],
            status: "error",
            sessionId: null,
            error: reason,
          }, { status: "error", sessionId: null, error: reason }));
          continue;
        }

        // Dedup with a fallback to the legacy bare-UID key so the deploy that
        // introduced the UIDVALIDITY-namespaced identity does not re-ingest the backlog.
        const existing = resolveEmailIngestState(inbox.id, message.providerMessageId);
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
        // Fail-closed: auto-ingest of untrusted external mail requires explicit opt-in.
        // `dispatching` and `ingested` are already-claimed states that must never be
        // re-dispatched (at-most-once across a crash/replay).
        const alreadyHandled = existing?.status === "ingested" || existing?.status === "dispatching";
        const senderAllowed = emailSenderAllowed(inbox.allowFrom, persisted.fromAddress);
        if (inbox.autoIngest === true && (!inbox.allowFrom || inbox.allowFrom.length === 0)) {
          logger.warn(`[email] Inbox "${inbox.id}" has autoIngest enabled but no allowFrom — all mail cached, none auto-ingested`);
        }
        const failedAuth = failedEmailAuth(persisted.authResults);
        if (failedAuth) {
          logger.warn(`[email] Skipping auto-ingest for inbox "${inbox.id}" because Authentication-Results reported ${failedAuth} failure`);
        }
        if (inbox.autoIngest === true && !alreadyHandled && senderAllowed && !failedAuth && this.onAutoIngest) {
          // Durable claim written BEFORE dispatch so a replay after a mid-dispatch
          // crash sees `dispatching` and does not re-run the agent.
          persistEmailMessageWithState(
            { ...persisted, status: "dispatching", error: null },
            { status: "dispatching", sessionId: persisted.sessionId, error: null },
          );
          try {
            const sessionId = await Promise.resolve().then(() => this.onAutoIngest!(persisted));
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
          // Mark seen after recording (regardless of ingest outcome); errored
          // messages are left unseen so they can be retried on the next poll.
          await this.client.markSeen(inbox, message.providerMessageId).catch(() => {});
        } else {
          results.push(persisted);
          // Mark cached/already-handled messages seen so unread count stays accurate.
          await this.client.markSeen(inbox, message.providerMessageId).catch(() => {});
        }
      }
      // Reachable but not fully processing — a failed ingest or a claim stuck mid-
      // dispatch (crash) — is degraded, not healthy.
      const degraded = results.some((entry) => entry.status === "error" || entry.status === "dispatching");
      setEmailInboxHealth({
        inboxId: inbox.id,
        status: degraded ? "degraded" : "ok",
        detail: degraded ? "one or more messages failed to ingest or are stuck dispatching" : null,
        lastCheckedAt: checkedAt,
        lastSuccessAt: checkedAt,
        lastErrorAt: degraded ? checkedAt : null,
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
