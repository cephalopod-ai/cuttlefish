/**
 * Process-local post-turn activity shared by the interactive Claude engine,
 * API serialization, and parent-callback delivery. It is deliberately not
 * persisted: a gateway restart cannot safely infer live upstream streams.
 */
export const sessionBackgroundActivity = new Map<string, { activeStreams: number; lastActivityAt: number }>();

export function setSessionBackgroundActivity(
  sessionId: string,
  info: { activeStreams: number; lastActivityAt: number } | null,
): void {
  if (info?.activeStreams) sessionBackgroundActivity.set(sessionId, info);
  else sessionBackgroundActivity.delete(sessionId);
}

export function hasSessionBackgroundActivity(sessionId: string): boolean {
  return (sessionBackgroundActivity.get(sessionId)?.activeStreams ?? 0) > 0;
}

export function clearSessionBackgroundActivityForTest(): void {
  sessionBackgroundActivity.clear();
}
