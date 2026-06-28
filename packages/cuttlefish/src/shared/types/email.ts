export interface EmailInboxConfig {
  id: string;
  label?: string;
  address: string;
  username: string;
  password: string;
  imapHost: string;
  imapPort?: number;
  useTls?: boolean;
  folder?: string;
  autoIngest?: boolean;
  unreadOnly?: boolean;
  maxMessagesPerPoll?: number;
}

export interface EmailConfig {
  enabled?: boolean;
  pollIntervalSeconds?: number;
  inboxes?: EmailInboxConfig[];
}

export interface EmailAttachmentRecord {
  id: string;
  filename: string;
  contentType: string;
  size: number;
  artifactId: string | null;
  contentId?: string | null;
}

export interface EmailMessageRecord {
  id: string;
  inboxId: string;
  providerMessageId: string;
  messageIdHeader: string | null;
  threadKey: string;
  fromAddress: string | null;
  toAddresses: string[];
  ccAddresses: string[];
  subject: string | null;
  receivedAt: string | null;
  textBody: string;
  htmlBody: string | null;
  headers: Record<string, string>;
  attachments: EmailAttachmentRecord[];
  status: "cached" | "ingested" | "error";
  sessionId: string | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface EmailInboxHealth {
  inboxId: string;
  status: "idle" | "ok" | "degraded" | "error";
  detail: string | null;
  lastCheckedAt: string | null;
  lastSuccessAt: string | null;
  lastErrorAt: string | null;
  cachedCount: number;
}
