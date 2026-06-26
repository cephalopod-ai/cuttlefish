import type { Connector, Employee, CuttlefishConfig } from "../../shared/types.js";
import { loadConfig } from "../../shared/config.js";
import { logger } from "../../shared/logger.js";
import type { RouteOptions } from "../../sessions/manager.js";
import type { SessionManager } from "../../sessions/manager.js";
import { DiscordConnector, type DiscordConnectorConfig } from "../../connectors/discord/index.js";
import { RemoteDiscordConnector } from "../../connectors/discord/remote.js";
import { SlackConnector } from "../../connectors/slack/index.js";
import { TelegramConnector } from "../../connectors/telegram/index.js";
import { WhatsAppConnector } from "../../connectors/whatsapp/index.js";

interface ConnectorLifecycle {
  connectors: Connector[];
  connectorMap: Map<string, Connector>;
  instanceConnectorIds: Set<string>;
  reloadConnectorInstances: () => Promise<{ started: string[]; stopped: string[]; errors: string[] }>;
}

interface ConnectorSetupDeps {
  config: CuttlefishConfig;
  sessionManager: SessionManager;
  getEmployeeRegistry: () => Map<string, Employee>;
}

function routeConnectorMessage(
  sessionManager: SessionManager,
  getEmployeeRegistry: () => Map<string, Employee>,
  employeeName: string | undefined,
  connector: Connector,
  label: string,
): void {
  connector.onMessage((msg) => {
    const routeOpts: RouteOptions = {};
    if (employeeName) {
      const emp = getEmployeeRegistry().get(employeeName);
      if (emp) routeOpts.employee = emp;
    }
    sessionManager.route(msg, connector, routeOpts).catch((err) => {
      logger.error(`${label} route error: ${err instanceof Error ? err.message : err}`);
    });
  });
}

function buildInstanceConnector(
  instance: Record<string, unknown> & { id: string; type: string; employee?: string },
  config: CuttlefishConfig,
  sessionManager: SessionManager,
  getEmployeeRegistry: () => Map<string, Employee>,
): Connector | null {
  const { id, type, employee, ...typeConfig } = instance;
  switch (type) {
    case "discord": {
      const connector = new DiscordConnector({ ...typeConfig, id } as DiscordConnectorConfig);
      routeConnectorMessage(sessionManager, getEmployeeRegistry, employee, connector, id);
      return connector;
    }
    case "slack": {
      const connector = new SlackConnector({ ...typeConfig, id } as never);
      routeConnectorMessage(sessionManager, getEmployeeRegistry, employee, connector, id);
      return connector;
    }
    case "whatsapp": {
      const connector = new WhatsAppConnector({ ...typeConfig } as never);
      routeConnectorMessage(sessionManager, getEmployeeRegistry, employee, connector, id);
      return connector;
    }
    case "telegram": {
      const connector = new TelegramConnector({ ...typeConfig, id, stt: config.stt } as never);
      routeConnectorMessage(sessionManager, getEmployeeRegistry, employee, connector, id);
      return connector;
    }
    default:
      logger.warn(`Unknown connector type "${type}" for instance "${id}"`);
      return null;
  }
}

export function startConfiguredConnectors({
  config,
  sessionManager,
  getEmployeeRegistry,
}: ConnectorSetupDeps): ConnectorLifecycle {
  const connectors: Connector[] = [];
  const connectorMap = new Map<string, Connector>();
  const instanceConnectorIds = new Set<string>();

  const registerAndStart = (id: string, connector: Connector, startMsg?: string): void => {
    connectors.push(connector);
    connectorMap.set(id, connector);
    connector.start().catch((err) => {
      logger.error(`Failed to start ${id} connector: ${err instanceof Error ? err.message : err}`);
    });
    if (startMsg) logger.info(startMsg);
  };

  if (config.connectors?.slack?.appToken && config.connectors?.slack?.botToken) {
    const slackConfig = config.connectors.slack;
    const connector = new SlackConnector({
      appToken: slackConfig.appToken,
      botToken: slackConfig.botToken,
      allowFrom: slackConfig.allowFrom,
      ignoreOldMessagesOnBoot: slackConfig.ignoreOldMessagesOnBoot,
    });
    routeConnectorMessage(sessionManager, getEmployeeRegistry, config.connectors.slack?.employee, connector, "Slack");
    registerAndStart("slack", connector);
  }

  if (config.connectors?.discord?.proxyVia) {
    const discordConfig = config.connectors.discord;
    const connector = new RemoteDiscordConnector({
      proxyVia: discordConfig.proxyVia!,
      apiToken: discordConfig.proxyToken,
      channelId: discordConfig.channelId,
    });
    routeConnectorMessage(sessionManager, getEmployeeRegistry, config.connectors.discord?.employee, connector, "remote Discord");
    registerAndStart("discord", connector, "Discord remote connector starting");
  } else if (config.connectors?.discord?.botToken) {
    const connector = new DiscordConnector(config.connectors.discord as DiscordConnectorConfig);
    routeConnectorMessage(sessionManager, getEmployeeRegistry, config.connectors.discord?.employee, connector, "Discord");
    registerAndStart("discord", connector, "Discord connector starting");
  }

  if (config.connectors?.telegram?.botToken) {
    const telegramConfig = config.connectors.telegram;
    const connector = new TelegramConnector({
      botToken: telegramConfig.botToken,
      allowFrom: telegramConfig.allowFrom,
      ignoreOldMessagesOnBoot: telegramConfig.ignoreOldMessagesOnBoot,
      stt: config.stt,
    });
    routeConnectorMessage(sessionManager, getEmployeeRegistry, config.connectors.telegram?.employee, connector, "Telegram");
    registerAndStart("telegram", connector);
  }

  if (config.connectors?.whatsapp) {
    const connector = new WhatsAppConnector(config.connectors.whatsapp ?? {});
    routeConnectorMessage(sessionManager, getEmployeeRegistry, config.connectors.whatsapp?.employee, connector, "WhatsApp");
    registerAndStart("whatsapp", connector, "WhatsApp connector starting (scan QR code if first run)");
  }

  if (config.connectors?.instances) {
    for (const instance of config.connectors.instances) {
      const { id, type, employee } = instance;
      if (!id || !type) {
        logger.warn("Skipping connector instance without id or type");
        continue;
      }
      if (connectorMap.has(id)) {
        logger.warn(`Duplicate connector instance id "${id}", skipping`);
        continue;
      }
      try {
        const connector = buildInstanceConnector(instance, config, sessionManager, getEmployeeRegistry);
        if (!connector) continue;
        connectors.push(connector);
        connectorMap.set(id, connector);
        instanceConnectorIds.add(id);
        void connector.start().catch((err) => {
          logger.error(`Failed to start connector instance "${id}": ${err instanceof Error ? err.message : err}`);
        });
        logger.info(`Connector instance "${id}" (type: ${type}, employee: ${employee || "default"}) started`);
      } catch (err) {
        logger.error(`Failed to start connector instance "${id}": ${err instanceof Error ? err.message : err}`);
      }
    }
  }

  const reloadConnectorInstances = async (): Promise<{ started: string[]; stopped: string[]; errors: string[] }> => {
    const freshConfig = loadConfig();
    const started: string[] = [];
    const stopped: string[] = [];
    const errors: string[] = [];

    for (const [id, connector] of connectorMap.entries()) {
      if (!instanceConnectorIds.has(id)) continue;
      try {
        await connector.stop();
        connectorMap.delete(id);
        instanceConnectorIds.delete(id);
        const idx = connectors.indexOf(connector);
        if (idx >= 0) connectors.splice(idx, 1);
        stopped.push(id);
        logger.info(`Stopped connector instance "${id}" for reload`);
      } catch (err) {
        errors.push(`Failed to stop ${id}: ${err instanceof Error ? err.message : err}`);
      }
    }

    if (freshConfig.connectors?.instances) {
      for (const instance of freshConfig.connectors.instances) {
        const { id, type, employee } = instance;
        if (!id || !type || connectorMap.has(id)) continue;
        try {
          const connector = buildInstanceConnector(instance, config, sessionManager, getEmployeeRegistry);
          if (!connector) {
            errors.push(`Unknown connector type "${type}" for instance "${id}"`);
            continue;
          }
          void connector.start().catch((err) => {
            const msg = `Failed to start "${id}": ${err instanceof Error ? err.message : err}`;
            errors.push(msg);
            logger.error(`Failed to start connector instance "${id}": ${err instanceof Error ? err.message : err}`);
          });
          connectors.push(connector);
          connectorMap.set(id, connector);
          instanceConnectorIds.add(id);
          started.push(id);
          logger.info(`Connector instance "${id}" (type: ${type}, employee: ${employee || "default"}) started`);
        } catch (err) {
          errors.push(`Failed to start "${id}": ${err instanceof Error ? err.message : err}`);
          logger.error(`Failed to start connector instance "${id}": ${err instanceof Error ? err.message : err}`);
        }
      }
    }

    return { started, stopped, errors };
  };

  return { connectors, connectorMap, instanceConnectorIds, reloadConnectorInstances };
}
