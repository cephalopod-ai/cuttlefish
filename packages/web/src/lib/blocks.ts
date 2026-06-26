import type { Message } from './conversations'

export type ChatBlockType = 'task-list'
export type ChatBlockStatus = 'queued' | 'running' | 'done' | 'error'
export type ChatBlockOp = 'put' | 'patch' | 'remove'
export type JsonPrimitive = string | number | boolean | null
export type JsonValue = JsonPrimitive | JsonObject | JsonValue[]
export interface JsonObject { [key: string]: JsonValue }

export interface ChatBlock {
  id: string
  type: ChatBlockType
  version: number
  status?: ChatBlockStatus
  sourceEngine?: string
  title?: string
  summary?: string
  payload: JsonObject
}

export interface ChatBlockEnvelope {
  op: ChatBlockOp
  block: ChatBlock
}

const SUPPORTED_BLOCK_TYPES = new Set<ChatBlockType>(['task-list'])

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

export function isChatBlock(value: unknown): value is ChatBlock {
  if (!isRecord(value)) return false
  if (typeof value.id !== 'string' || !value.id) return false
  if (typeof value.type !== 'string' || !SUPPORTED_BLOCK_TYPES.has(value.type as ChatBlockType)) return false
  if (typeof value.version !== 'number') return false
  return isRecord(value.payload)
}

export function isBlockEnvelope(value: unknown): value is ChatBlockEnvelope {
  if (!isRecord(value)) return false
  if (value.op !== 'put' && value.op !== 'patch' && value.op !== 'remove') return false
  return isChatBlock(value.block)
}

export function blockFallbackContent(block: ChatBlock): string {
  const prefix = block.title || block.summary || block.type
  if (block.type === 'task-list') {
    const items = Array.isArray(block.payload.items) ? block.payload.items : []
    return `${prefix}: ${items.length} item${items.length === 1 ? '' : 's'}`
  }
  return prefix
}

export function mergeBlock(existing: ChatBlock, patch: ChatBlock): ChatBlock {
  return {
    ...existing,
    ...patch,
    id: existing.id,
    type: existing.type,
    version: patch.version ?? existing.version,
    payload: {
      ...existing.payload,
      ...patch.payload,
    },
  }
}

function blockFallbackCandidates(block: ChatBlock): string[] {
  return [
    blockFallbackContent(block),
    block.title,
    block.summary,
    block.type,
  ].filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
}

function isSyntheticBlockMessage(message: Message, block: ChatBlock | undefined): boolean {
  if (!block) return false
  if (message.id.startsWith(`block-${block.id}-`)) return true
  const content = message.content.trim()
  return blockFallbackCandidates(block).some((candidate) => candidate.trim() === content)
}

export function applyBlockEnvelopeToMessages(
  messages: Message[],
  envelope: ChatBlockEnvelope,
  fallback: string,
  timestamp: number = Date.now(),
): Message[] {
  const existingIndex = messages.findIndex((message) =>
    Array.isArray(message.blocks) && message.blocks.some((block) => block.id === envelope.block.id),
  )

  if (envelope.op === 'remove') {
    if (existingIndex < 0) return messages
    return messages.flatMap((message, index) => {
      if (index !== existingIndex) return [message]
      const oldBlock = (message.blocks || []).find((block) => block.id === envelope.block.id)
      const blocks = (message.blocks || []).filter((block) => block.id !== envelope.block.id)
      if (blocks.length > 0) return [{ ...message, blocks }]
      if (isSyntheticBlockMessage(message, oldBlock)) return []
      const next = { ...message }
      delete next.blocks
      return [next]
    })
  }

  if (existingIndex >= 0) {
    return messages.map((message, index) => {
      if (index !== existingIndex) return message
      const oldBlock = (message.blocks || []).find((block) => block.id === envelope.block.id)
      const blocks = (message.blocks || []).map((block) =>
        block.id === envelope.block.id
          ? envelope.op === 'patch' ? mergeBlock(block, envelope.block) : envelope.block
          : block,
      )
      const target = blocks.find((block) => block.id === envelope.block.id) || envelope.block
      return {
        ...message,
        content: isSyntheticBlockMessage(message, oldBlock)
          ? fallback || blockFallbackContent(target)
          : message.content,
        timestamp,
        blocks,
      }
    })
  }

  const content = fallback || blockFallbackContent(envelope.block)
  return [
    ...messages,
    {
      id: `block-${envelope.block.id}-${timestamp}`,
      role: 'assistant',
      content,
      timestamp,
      blocks: [envelope.block],
    },
  ]
}
