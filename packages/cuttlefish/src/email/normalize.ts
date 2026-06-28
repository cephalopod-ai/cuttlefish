import crypto from "node:crypto";
import { simpleParser } from "mailparser";
import type { EmailAttachmentRecord, EmailInboxConfig, EmailMessageRecord } from "../shared/types.js";
import { emailMessageId } from "./store.js";

interface ParsedAddressList {
  value?: Array<{ address?: string | null }>;
}

interface ParsedAttachment {
  filename?: string | null;
  contentType?: string | null;
  size?: number | null;
  content: Buffer;
  cid?: string | null;
}

interface ParsedMailLike {
  references?: string[];
  inReplyTo?: string | null;
  messageId?: string | null;
  from?: ParsedAddressList;
  to?: ParsedAddressList;
  cc?: ParsedAddressList;
  subject?: string | null;
  date?: Date | null;
  text?: string | null;
  html?: string | false;
  attachments: ParsedAttachment[];
  headers: Iterable<[string, unknown]>;
}

export interface NormalizedAttachmentPayload {
  id: string;
  filename: string;
  contentType: string;
  size: number;
  content: Buffer;
  contentId?: string | null;
}

export interface NormalizedEmailPayload {
  record: Omit<EmailMessageRecord, "createdAt" | "updatedAt">;
  raw: Buffer;
  attachments: NormalizedAttachmentPayload[];
}

function cleanAddressList(value: ParsedAddressList | undefined): string[] {
  return value?.value?.map((entry) => entry.address).filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0) ?? [];
}

function headerMap(mail: ParsedMailLike): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of mail.headers) {
    if (typeof value === "string") out[key] = value;
  }
  return out;
}

function threadKey(mail: ParsedMailLike, providerMessageId: string): string {
  const refs = mail.references?.map((entry) => entry.trim()).filter(Boolean) ?? [];
  const inReplyTo = typeof mail.inReplyTo === "string" ? mail.inReplyTo.trim() : "";
  const messageId = typeof mail.messageId === "string" ? mail.messageId.trim() : "";
  const seed = refs[0] || inReplyTo || messageId || providerMessageId;
  return crypto.createHash("sha256").update(seed).digest("hex").slice(0, 24);
}

function attachmentId(providerMessageId: string, index: number, filename: string): string {
  return `email-att-${crypto.createHash("sha256").update(`${providerMessageId}:${index}:${filename}`).digest("hex").slice(0, 16)}`;
}

export async function normalizeEmail(
  inbox: EmailInboxConfig,
  providerMessageId: string,
  raw: Buffer,
): Promise<NormalizedEmailPayload> {
  const mail = await simpleParser(raw) as ParsedMailLike;
  const attachments: NormalizedAttachmentPayload[] = mail.attachments.map((attachment, index) => ({
    id: attachmentId(providerMessageId, index, attachment.filename || `attachment-${index + 1}`),
    filename: attachment.filename || `attachment-${index + 1}`,
    contentType: attachment.contentType || "application/octet-stream",
    size: attachment.size ?? attachment.content.length,
    content: attachment.content,
    contentId: attachment.cid ?? null,
  }));
  const recordId = emailMessageId(inbox.id, providerMessageId);
  const attachmentRecords: EmailAttachmentRecord[] = attachments.map((attachment) => ({
    id: attachment.id,
    filename: attachment.filename,
    contentType: attachment.contentType,
    size: attachment.size,
    artifactId: null,
    contentId: attachment.contentId ?? null,
  }));

  return {
    raw,
    attachments,
    record: {
      id: recordId,
      inboxId: inbox.id,
      providerMessageId,
      messageIdHeader: mail.messageId ?? null,
      threadKey: threadKey(mail, providerMessageId),
      fromAddress: mail.from?.value?.[0]?.address ?? null,
      toAddresses: cleanAddressList(mail.to),
      ccAddresses: cleanAddressList(mail.cc),
      subject: mail.subject ?? null,
      receivedAt: mail.date ? mail.date.toISOString() : null,
      textBody: mail.text ?? "",
      htmlBody: typeof mail.html === "string" ? mail.html : null,
      headers: headerMap(mail),
      attachments: attachmentRecords,
      status: "cached",
      sessionId: null,
      error: null,
    },
  };
}
