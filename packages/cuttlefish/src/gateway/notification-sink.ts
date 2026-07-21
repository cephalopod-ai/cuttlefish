import type { SessionNotificationSink } from "../sessions/notification-sink.js";
import { logger } from "../shared/logger.js";
import type { ApiContext } from "./api/context.js";
import { dispatchSessionNotification } from "./api/session-dispatch.js";
import { recordDroppedNotification } from "../shared/process-health.js";

export function createGatewayNotificationSink(context: ApiContext): SessionNotificationSink {
  return {
    async sendSessionNotification(sessionId, message, displayMessage, sourceChildSessionId) {
      if (sourceChildSessionId) {
        await dispatchSessionNotification(sessionId, message, displayMessage, context, { sourceChildSessionId });
      } else {
        await dispatchSessionNotification(sessionId, message, displayMessage, context);
      }
    },

    async sendConnectorNotification(message) {
      const config = context.getConfig();
      const connectorName = config.notifications?.connector || "slack";
      const channel = config.notifications?.channel;
      if (!channel) {
        logger.debug("[callbacks] No notifications.channel configured — skipping connector notification");
        return;
      }

      const connector = context.connectors.get(connectorName);
      if (!connector) {
        // Audit E7: a dropped operator alert must not be a silent debug/warn — the
        // "someone should notice" signal vanishes exactly when the transport is
        // down. Record it so health reflects undeliverable notifications.
        logger.warn(`[callbacks] Notification connector "${connectorName}" is not running — notification dropped`);
        recordDroppedNotification(`connector "${connectorName}" not running`);
        return;
      }

      try {
        await connector.sendMessage({ channel }, message);
      } catch (err) {
        logger.error(`[callbacks] Connector "${connectorName}" send failed — notification dropped: ${err instanceof Error ? err.message : String(err)}`);
        recordDroppedNotification(`connector "${connectorName}" send failed`);
        throw err;
      }
    },
  };
}
