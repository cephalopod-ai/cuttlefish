import { logger } from "../shared/logger.js";
import { redactText } from "../shared/redact.js";
import type { Session, Connector } from "../shared/types.js";
import { recordDroppedNotification } from "../shared/process-health.js";
import { createHash } from "node:crypto";
import { canonicalSha256 } from "../shared/canonical-json.js";
import { getSession, patchSessionTransportMeta } from "../sessions/registry.js";
import { currentSessionAttempt } from "./session-dispatch-authorization.js";

/**
 * Connector identity + reply relay helpers.
 *
 * Extracted from `api.ts` (audit AS-001) without behavior change.
 */

/**
 * Sources that are NOT backed by an external chat connector. Anything else
 * (slack, whatsapp, …) is connector-sourced and its turn
 * results must be relayed back to the originating channel.
 */
const NON_CONNECTOR_SOURCES = new Set(["web", "talk", "cron"]);
const DEFAULT_MAX_ATTEMPTS = 2;
const DEFAULT_RETRY_DELAY_MS = 250;

/**
 * Resolve the forwarded SSO identity from request headers, given the configured
 * `gateway.userHeader` (a single header name or a priority-ordered list). Node
 * lowercases incoming header keys, so we look up case-insensitively. Returns the
 * first present, non-empty, trimmed value; `undefined` when the config is unset
 * or no configured header is present. Unset config = single-user no-op: the
 * header is never read and the caller falls back to "web-user".
 */
export function resolveUserHeader(
  headers: Record<string, string | string[] | undefined>,
  userHeaderConfig: string | string[] | undefined,
): string | undefined {
  if (!userHeaderConfig) return undefined;
  const names = Array.isArray(userHeaderConfig) ? userHeaderConfig : [userHeaderConfig];
  for (const name of names) {
    if (!name) continue;
    const raw = headers[name.toLowerCase()];
    const value = Array.isArray(raw) ? raw[0] : raw;
    if (typeof value === "string") {
      const trimmed = value.trim();
      if (trimmed) return trimmed;
    }
  }
  return undefined;
}

export interface ConnectorReplyDeliveryOptions {
  emit?: (event: string, payload: unknown) => void;
  maxAttempts?: number;
  retryDelayMs?: number;
  runId?: string;
  authorize?: () => boolean;
}

/** Only an adapter that knows no send began may request a retry. */
export class ConnectorPreDispatchError extends Error {}

export function connectorReplyOptions(snapshot: Session, emit?: ConnectorReplyDeliveryOptions["emit"]): ConnectorReplyDeliveryOptions {
  const destination = canonicalSha256({ connector: snapshot.connector, source: snapshot.source, replyContext: snapshot.replyContext });
  return { emit, runId: typeof snapshot.transportMeta?.latestRunId === "string" ? snapshot.transportMeta.latestRunId : undefined,
    authorize: () => { const live = currentSessionAttempt(snapshot); return !!live && destination === canonicalSha256({ connector: live.connector, source: live.source, replyContext: live.replyContext }); } };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Relay a completed turn's assistant text back to the connector channel that
 * originated the session. Inbound connector messages reply via `manager.route`,
 * but turns completed through `runWebSession` (parent callbacks, cron
 * follow-ups, rate-limit resumes) otherwise never reach the channel. No-ops for
 * web/talk/cron sources, empty text, or a missing connector/replyContext; errors
 * are surfaced. An unknown outcome is retained, never automatically repeated.
 */
export async function deliverConnectorReply(
  session: Pick<Session, "source" | "connector" | "replyContext"> & { id?: string },
  text: string,
  connectors: Map<string, Connector>,
  options: ConnectorReplyDeliveryOptions = {},
): Promise<void> {
  if (!text || NON_CONNECTOR_SOURCES.has(session.source)) return;
  if (!session.connector || !session.replyContext) return;
  const connector = connectors.get(session.connector);
  if (!connector) return;
  const attempts = Math.max(1, Math.floor(options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS));
  const retryDelayMs = Math.max(0, Math.floor(options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS));
  const payloadHash = createHash("sha256").update(redactText(text)).digest("hex");
  const destinationHash = canonicalSha256({ connector: session.connector, source: session.source, replyContext: session.replyContext });
  const recordOutcome = (state: string) => {
    if (!session.id || !options.runId || getSession(session.id)?.transportMeta?.latestRunId !== options.runId) return;
    patchSessionTransportMeta(session.id, { connectorReplyOutcome: { version: 1, runId: options.runId, payloadHash, destinationHash, state } });
  };
  if (session.id && options.runId) {
    const prior = getSession(session.id)?.transportMeta?.connectorReplyOutcome;
    if (prior && typeof prior === "object" && !Array.isArray(prior) && prior.runId === options.runId) {
      if (prior.payloadHash !== payloadHash || prior.destinationHash !== destinationHash) {
        options.emit?.("connector:reply_denied", { sessionId: session.id, reason: "Reply operation identity reused with changed material" });
        return;
      }
      if (prior.state === "confirmed" || prior.state === "uncertain") return;
      if (prior.state === "sending") { recordOutcome("uncertain"); return; }
    }
  }

  let lastError = "connector returned no message id (delivery outcome unknown)";
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    if (options.authorize && !options.authorize()) return;
    try {
      const target = connector.reconstructTarget(session.replyContext);
      // Audit H3: Slack/WhatsApp replyMessage() swallow send errors and return
      // `undefined` instead of throwing. A missing acknowledgement is unknown,
      // since a send may have succeeded before its response was lost.
      recordOutcome("sending");
      const messageId = await connector.replyMessage(target, redactText(text));
      if (messageId !== undefined) { recordOutcome("confirmed"); return; }
      throw new Error(lastError);
    } catch (err) {
      const message = redactText(err instanceof Error ? err.message : String(err));
      lastError = message;
      options.emit?.("connector:reply_failed", {
        sessionId: session.id ?? null,
        connector: session.connector,
        source: session.source,
        attempt,
        maxAttempts: attempts,
        error: message,
      });
      logger.warn(
        `Connector reply delivery failed for session ${session.id ?? "?"} ` +
        `(attempt ${attempt}/${attempts}): ${message}`,
      );
      if (!(err instanceof ConnectorPreDispatchError)) {
        recordOutcome("uncertain");
        options.emit?.("connector:reply_uncertain", { sessionId: session.id ?? null, connector: session.connector, attempt,
          reason: "Delivery may have happened; reconcile before sending again" });
        recordDroppedNotification(`connector "${session.connector}" reply outcome uncertain; reconciliation required`);
        return;
      }
      recordOutcome("not_sent");
      if (attempt < attempts && retryDelayMs > 0) await sleep(retryDelayMs);
    }
  }
  // All attempts exhausted — the operator's reply never reached the channel.
  // Emit a terminal signal and record the drop so it is observable in health.
  options.emit?.("connector:reply_dropped", {
    sessionId: session.id ?? null,
    connector: session.connector,
    source: session.source,
    attempts,
    error: lastError,
  });
  logger.error(
    `Connector reply for session ${session.id ?? "?"} was NOT delivered after ${attempts} attempt(s): ${lastError}`,
  );
  recordDroppedNotification(`connector "${session.connector}" reply undeliverable after ${attempts} attempt(s)`);
}
