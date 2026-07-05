import type { ContextPacketMetadata } from "./block.js";
import { logger } from "../../shared/logger.js";

export function logContextPacketMetadata(metadata: ContextPacketMetadata, sessionId: string): void {
  logger.debug(`context_manager ${JSON.stringify({ sessionId, ...metadata })}`);
}

