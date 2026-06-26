import { v4 as uuidv4 } from 'uuid';
import type { ChatBlock, ChatBlockEnvelope } from '../../shared/types.js';
import { blockFallbackText, mergeBlock, validateBlockEnvelope } from '../../shared/blocks.js';
import { initDb } from './core.js';

export interface MessageMedia {
  type: 'image' | 'audio' | 'file';
  url: string;
  name?: string;
  mimeType?: string;
  size?: number;
}

export interface SessionMessage {
  id: string;
  role: string;
  content: string;
  timestamp: number;
  media?: MessageMedia[];
  partial?: boolean;
  toolCall?: string;
  blocks?: ChatBlock[];
}

function parseMediaColumn(value: unknown): MessageMedia[] | undefined {
  if (typeof value !== 'string' || !value.trim()) return undefined;
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) && parsed.length > 0 ? (parsed as MessageMedia[]) : undefined;
  } catch {
    return undefined;
  }
}

function parseBlocksColumn(value: unknown): ChatBlock[] | undefined {
  if (typeof value !== 'string' || !value.trim()) return undefined;
  try {
    const parsed = JSON.parse(value);
    if (!Array.isArray(parsed)) return undefined;
    const blocks = parsed.flatMap((block) => {
      const result = validateBlockEnvelope({ op: "put", block });
      return result.ok ? [result.envelope.block] : [];
    });
    return blocks.length > 0 ? blocks : undefined;
  } catch {
    return undefined;
  }
}

function blockFallbackCandidates(block: ChatBlock, fallbackText?: string): string[] {
  return [
    fallbackText,
    blockFallbackText(block),
    block.title,
    block.summary,
    block.type,
  ].filter((value): value is string => typeof value === "string" && value.trim().length > 0);
}

function isSyntheticBlockContent(content: string, block: ChatBlock | undefined, fallbackText?: string): boolean {
  if (!block) return false;
  const trimmed = content.trim();
  return blockFallbackCandidates(block, fallbackText).some((candidate) => candidate.trim() === trimmed);
}

function isSyntheticBlockRow(rowId: string, content: string, block: ChatBlock | undefined, fallbackText?: string): boolean {
  if (!block) return false;
  if (rowId.startsWith(`block-${block.id}-`)) return true;
  return isSyntheticBlockContent(content, block, fallbackText);
}

export function insertMessage(sessionId: string, role: string, content: string, media?: MessageMedia[], blocks?: ChatBlock[]): string {
  const db = initDb();
  const id = uuidv4();
  const mediaJson = media && media.length > 0 ? JSON.stringify(media) : null;
  const blocksJson = blocks && blocks.length > 0 ? JSON.stringify(blocks) : null;
  db.prepare('INSERT INTO messages (id, session_id, role, content, timestamp, media, blocks) VALUES (?, ?, ?, ?, ?, ?, ?)').run(
    id, sessionId, role, content, Date.now(), mediaJson, blocksJson,
  );
  return id;
}

export function getMessages(sessionId: string): SessionMessage[] {
  const db = initDb();
  const rows = db
    .prepare('SELECT id, role, content, timestamp, media, partial, seq, tool_call, blocks FROM messages WHERE session_id = ? ORDER BY timestamp ASC, seq ASC')
    .all(sessionId) as Array<{ id: string; role: string; content: string; timestamp: number; media: string | null; partial: number | null; seq: number | null; tool_call: string | null; blocks: string | null }>;
  return rows.map((r) => {
    const msg: SessionMessage = { id: r.id, role: r.role, content: r.content, timestamp: r.timestamp };
    const media = parseMediaColumn(r.media);
    const blocks = parseBlocksColumn(r.blocks);
    if (media) msg.media = media;
    if (blocks) msg.blocks = blocks;
    if (r.partial) msg.partial = true;
    if (r.tool_call) msg.toolCall = r.tool_call;
    return msg;
  });
}

export function applyBlockEnvelope(
  sessionId: string,
  input: ChatBlockEnvelope,
  fallbackText?: string,
  options?: { partial?: boolean; seq?: number },
): string | null {
  const result = validateBlockEnvelope(input);
  if (!result.ok) throw new Error(result.error);
  const envelope = result.envelope;
  const db = initDb();
  const partialOnly = options?.partial === true;
  const rows = db
    .prepare(`SELECT id, content, blocks FROM messages WHERE session_id = ? AND role = ?${partialOnly ? ' AND partial = 1' : ''} ORDER BY timestamp ASC, seq ASC`)
    .all(sessionId, 'assistant') as Array<{ id: string; content: string; blocks: string | null }>;
  const existing = rows
    .map((row) => ({ row, blocks: parseBlocksColumn(row.blocks) ?? [] }))
    .find((entry) => entry.blocks.some((block) => block.id === envelope.block.id));

  if (envelope.op === 'remove') {
    if (!existing) return null;
    const oldBlock = existing.blocks.find((block) => block.id === envelope.block.id);
    const remainingBlocks = existing.blocks.filter((block) => block.id !== envelope.block.id);
    if (remainingBlocks.length > 0) {
      db.prepare('UPDATE messages SET blocks = ? WHERE id = ?').run(JSON.stringify(remainingBlocks), existing.row.id);
    } else if (isSyntheticBlockRow(existing.row.id, existing.row.content, oldBlock, fallbackText)) {
      db.prepare('DELETE FROM messages WHERE id = ?').run(existing.row.id);
    } else {
      db.prepare('UPDATE messages SET blocks = NULL WHERE id = ?').run(existing.row.id);
    }
    return existing.row.id;
  }

  if (existing) {
    const oldBlock = existing.blocks.find((block) => block.id === envelope.block.id);
    const nextBlocks = existing.blocks.map((block) =>
      block.id === envelope.block.id
        ? envelope.op === "patch" ? mergeBlock(block, envelope.block) : envelope.block
        : block,
    );
    const target = nextBlocks.find((block) => block.id === envelope.block.id) ?? envelope.block;
    const nextContent = isSyntheticBlockRow(existing.row.id, existing.row.content, oldBlock, fallbackText)
      ? fallbackText?.trim() || blockFallbackText(target)
      : existing.row.content;
    db.prepare('UPDATE messages SET content = ?, blocks = ? WHERE id = ?').run(
      nextContent,
      JSON.stringify(nextBlocks),
      existing.row.id,
    );
    return existing.row.id;
  }

  if (envelope.op === 'patch') return null;

  const id = `block-${envelope.block.id}-${uuidv4()}`;
  if (partialOnly) {
    db.prepare('INSERT INTO messages (id, session_id, role, content, timestamp, partial, seq, blocks) VALUES (?, ?, ?, ?, ?, 1, ?, ?)').run(
      id,
      sessionId,
      'assistant',
      fallbackText?.trim() || blockFallbackText(envelope.block),
      Date.now(),
      options?.seq ?? 0,
      JSON.stringify([envelope.block]),
    );
  } else {
    db.prepare('INSERT INTO messages (id, session_id, role, content, timestamp, blocks) VALUES (?, ?, ?, ?, ?, ?)').run(
      id,
      sessionId,
      'assistant',
      fallbackText?.trim() || blockFallbackText(envelope.block),
      Date.now(),
      JSON.stringify([envelope.block]),
    );
  }
  return id;
}

export function insertPartialMessage(sessionId: string, role: string, content: string, seq: number, toolCall?: string): string {
  const db = initDb();
  const id = uuidv4();
  db.prepare('INSERT INTO messages (id, session_id, role, content, timestamp, partial, seq, tool_call) VALUES (?, ?, ?, ?, ?, 1, ?, ?)').run(
    id, sessionId, role, content, Date.now(), seq, toolCall ?? null,
  );
  return id;
}

export function updatePartialMessage(id: string, content: string): void {
  const db = initDb();
  db.prepare('UPDATE messages SET content = ? WHERE id = ? AND partial = 1').run(content, id);
}

export function updateMessageContent(id: string, content: string): void {
  const db = initDb();
  db.prepare('UPDATE messages SET content = ? WHERE id = ?').run(content, id);
}

export function deletePartialMessages(sessionId: string): number {
  const db = initDb();
  return db.prepare('DELETE FROM messages WHERE session_id = ? AND partial = 1').run(sessionId).changes;
}

export function finalizePartialMessages(sessionId: string): number {
  const db = initDb();
  return db.prepare('UPDATE messages SET partial = NULL WHERE session_id = ? AND partial = 1').run(sessionId).changes;
}

export function clearAllPartialMessages(): number {
  const db = initDb();
  return db.prepare('DELETE FROM messages WHERE partial = 1').run().changes;
}
