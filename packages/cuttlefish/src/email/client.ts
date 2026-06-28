import { ImapFlow } from "imapflow";
import type { EmailInboxConfig } from "../shared/types.js";

export interface EmailFetchResult {
  providerMessageId: string;
  raw: Buffer;
}

export interface EmailMailboxClient {
  fetchUnread(inbox: EmailInboxConfig): Promise<EmailFetchResult[]>;
}

export class FakeEmailMailboxClient implements EmailMailboxClient {
  private readonly messages = new Map<string, EmailFetchResult[]>();
  private readonly failures = new Set<string>();

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
}

export class ImapEmailMailboxClient implements EmailMailboxClient {
  async fetchUnread(inbox: EmailInboxConfig): Promise<EmailFetchResult[]> {
    const client = new ImapFlow({
      host: inbox.imapHost,
      port: inbox.imapPort ?? 993,
      secure: inbox.useTls !== false,
      auth: {
        user: inbox.username,
        pass: inbox.password,
      },
    });

    await client.connect();
    try {
      await client.mailboxOpen(inbox.folder || "INBOX");
      const query = inbox.unreadOnly === false ? { all: true } : { seen: false };
      const limit = Math.max(1, Math.min(100, inbox.maxMessagesPerPoll ?? 10));
      const ranges = await client.search(query);
      const selected = Array.isArray(ranges) ? ranges.slice(-limit).reverse() : [];
      const out: EmailFetchResult[] = [];
      for await (const message of client.fetch(selected, { uid: true, source: true })) {
        if (!message.source) continue;
        out.push({
          providerMessageId: String(message.uid),
          raw: Buffer.isBuffer(message.source) ? message.source : Buffer.from(message.source),
        });
      }
      return out;
    } finally {
      await client.logout().catch(() => {});
    }
  }
}
