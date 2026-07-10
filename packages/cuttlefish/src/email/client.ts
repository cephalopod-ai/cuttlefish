import { ImapFlow } from "imapflow";
import type { EmailInboxConfig } from "../shared/types.js";

export interface EmailFetchResult {
  providerMessageId: string;
  raw: Buffer;
}

export interface EmailMailboxClient {
  fetchUnread(inbox: EmailInboxConfig): Promise<EmailFetchResult[]>;
  markSeen(inbox: EmailInboxConfig, providerMessageId: string): Promise<void>;
}

export class FakeEmailMailboxClient implements EmailMailboxClient {
  private readonly messages = new Map<string, EmailFetchResult[]>();
  private readonly failures = new Set<string>();
  readonly seenIds: string[] = [];

  setMessages(inboxId: string, messages: EmailFetchResult[]): void {
    this.messages.set(inboxId, [...messages]);
  }

  failInbox(inboxId: string): void {
    this.failures.add(inboxId);
  }

  async fetchUnread(inbox: EmailInboxConfig): Promise<EmailFetchResult[]> {
    if (this.failures.has(inbox.id)) throw new Error(`simulated inbox failure for ${inbox.id}`);
    return [...(this.messages.get(inbox.id) ?? [])];
  }

  async markSeen(_inbox: EmailInboxConfig, providerMessageId: string): Promise<void> {
    this.seenIds.push(providerMessageId);
  }
}

export class ImapEmailMailboxClient implements EmailMailboxClient {
  async fetchUnread(inbox: EmailInboxConfig): Promise<EmailFetchResult[]> {
    const client = new ImapFlow({
      host: inbox.imapHost,
      port: inbox.imapPort ?? 993,
      secure: inbox.useTls !== false,
      // Audit H7: bound the external mailbox boundary so a hung/slow IMAP server
      // cannot wedge the ingest poll indefinitely.
      greetingTimeout: 15_000,
      socketTimeout: 60_000,
      auth: {
        user: inbox.username,
        pass: inbox.password,
      },
    });

    await client.connect();
    try {
      const mailbox = await client.mailboxOpen(inbox.folder || "INBOX");
      // IMAP UIDs are only unique within a UIDVALIDITY generation. Namespace the
      // dedup identity by uidValidity so a UID reused after the mailbox is
      // recreated is not mistaken for an already-ingested message (which would
      // silently skip new mail).
      const uidValidity = mailbox && mailbox.uidValidity !== undefined ? String(mailbox.uidValidity) : "0";
      const query = inbox.unreadOnly === false ? { all: true } : { seen: false };
      const limit = Math.max(1, Math.min(100, inbox.maxMessagesPerPoll ?? 10));
      const ranges = await client.search(query);
      const selected = Array.isArray(ranges) ? ranges.slice(-limit).reverse() : [];
      const out: EmailFetchResult[] = [];
      for await (const message of client.fetch(selected, { uid: true, source: true })) {
        if (!message.source) continue;
        out.push({
          providerMessageId: `${uidValidity}:${String(message.uid)}`,
          raw: Buffer.isBuffer(message.source) ? message.source : Buffer.from(message.source),
        });
      }
      return out;
    } finally {
      await client.logout().catch(() => {});
    }
  }

  async markSeen(inbox: EmailInboxConfig, providerMessageId: string): Promise<void> {
    // providerMessageId is encoded as "${uidValidity}:${uid}"
    const colonIdx = providerMessageId.indexOf(":");
    if (colonIdx < 0) return;
    const uid = providerMessageId.slice(colonIdx + 1);
    if (!uid) return;
    const client = new ImapFlow({
      host: inbox.imapHost,
      port: inbox.imapPort ?? 993,
      secure: inbox.useTls !== false,
      // Audit H7: bound the external mailbox boundary so a hung/slow IMAP server
      // cannot wedge the ingest poll indefinitely.
      greetingTimeout: 15_000,
      socketTimeout: 60_000,
      auth: { user: inbox.username, pass: inbox.password },
    });
    await client.connect();
    try {
      await client.mailboxOpen(inbox.folder || "INBOX");
      await client.messageFlagsAdd({ uid: Number(uid) }, ["\\Seen"]);
    } finally {
      await client.logout().catch(() => {});
    }
  }
}
