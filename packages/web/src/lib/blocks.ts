import type { Message } from './conversations'
export type {
  ChatBlock,
  ChatBlockEnvelope,
  ChatBlockOp,
  ChatBlockStatus,
  ChatBlockType,
  JsonObject,
  JsonPrimitive,
  JsonValue,
} from '@cuttlefish/contracts'
export {
  blockFallbackContent,
  isBlockEnvelope,
  isChatBlock,
  mergeBlock,
} from '@cuttlefish/contracts'
import type { ChatBlock, ChatBlockEnvelope } from '@cuttlefish/contracts'
import { blockFallbackContent, mergeBlock } from '@cuttlefish/contracts'

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
