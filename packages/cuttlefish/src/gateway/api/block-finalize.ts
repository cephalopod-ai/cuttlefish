import type { ChatBlock, ChatBlockEnvelope, StreamDelta } from "../../shared/types.js";
import { blockFallbackText, validateBlockEnvelope } from "../../shared/blocks.js";

function scopeBlockEnvelopeForTurn(envelope: ChatBlockEnvelope, turnStartedAt: number): ChatBlockEnvelope {
  const suffix = `t${turnStartedAt.toString(36)}`;
  if (envelope.block.id.endsWith(`:${suffix}`)) return envelope;
  const maxBaseLength = Math.max(1, 96 - suffix.length - 1);
  const baseId = envelope.block.id.slice(0, maxBaseLength);
  return {
    ...envelope,
    block: {
      ...envelope.block,
      id: `${baseId}:${suffix}`,
    },
  };
}

export function normalizeBlockDeltaForTurn(delta: StreamDelta, turnStartedAt: number): { ok: true; delta: StreamDelta } | { ok: false; error: string } {
  if (delta.type !== "block") return { ok: true, delta };
  const initial = validateBlockEnvelope(delta.block);
  if (!initial.ok) return initial;
  const scoped = scopeBlockEnvelopeForTurn(initial.envelope, turnStartedAt);
  const validated = validateBlockEnvelope(scoped);
  if (!validated.ok) return validated;
  return {
    ok: true,
    delta: {
      ...delta,
      content: delta.content || blockFallbackText(validated.envelope.block),
      block: validated.envelope,
    },
  };
}

export function shouldPersistFinalAssistantMessage(options: {
  resultText: string;
  finalBlockCount: number;
  resultAlreadyPersisted: boolean;
  quietPreempted: boolean;
}): boolean {
  if (options.resultAlreadyPersisted || options.quietPreempted) return false;
  return options.resultText.trim().length > 0 || options.finalBlockCount > 0;
}

export function finalBlocksForAssistantMessage(blocks: ChatBlock[], preservedBlockIds: Set<string>): ChatBlock[] {
  if (preservedBlockIds.size === 0) return blocks;
  return blocks.filter((block) => !preservedBlockIds.has(block.id));
}
