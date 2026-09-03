import { randomUUID } from "node:crypto";
import net from "node:net";
import {
  AgentCard,
  Role,
  TaskState,
  type Message,
  type SendMessageRequest,
  type StreamResponse,
  type Task,
} from "@a2a-js/sdk";
import {
  ClientFactory,
  DefaultAgentCardResolver,
  RestTransportFactory,
  type Client,
} from "@a2a-js/sdk/client";
import type { A2ADestinationConfig, CuttlefishConfig } from "../shared/types.js";
import { isPrivateAddress, safeFetch, SsrfError } from "../shared/ssrf-guard.js";
import { textPart } from "./content.js";
import { getA2AMaxArtifactBytes, getA2AMaxInputBytes } from "./config.js";

const MAX_AGENT_CARD_BYTES = 1024 * 1024;
const AGENT_CARD_CACHE_MS = 30_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 180_000;
const OUTBOUND_TERMINAL_STATES = new Set([
  TaskState.TASK_STATE_COMPLETED,
  TaskState.TASK_STATE_FAILED,
  TaskState.TASK_STATE_CANCELED,
  TaskState.TASK_STATE_REJECTED,
  TaskState.TASK_STATE_INPUT_REQUIRED,
  TaskState.TASK_STATE_AUTH_REQUIRED,
]);

export interface OutboundA2ASendInput {
  destinationId: string;
  skillId: string;
  message: string;
  /** Stable logical-request identity used to reconcile an unknown send outcome. */
  messageId?: string;
  taskId?: string;
  contextId?: string;
  returnImmediately?: boolean;
  historyLength?: number;
  signal?: AbortSignal;
}

type GuardedFetch = (url: string, init: RequestInit, options: {
  allowPrivateHosts: boolean;
  allowedOrigins: ReadonlySet<string>;
}) => Promise<Response>;

export interface OutboundA2AServiceDeps {
  guardedFetch?: GuardedFetch;
}

function destinationOrigins(destination: A2ADestinationConfig): Set<string> {
  const origins = new Set(destination.allowedOrigins ?? []);
  origins.add(new URL(destination.agentCardUrl).origin);
  return origins;
}

function isLocalDevelopmentHttpUrl(url: URL): boolean {
  if (url.protocol !== "http:") return false;
  const hostname = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  return hostname === "localhost"
    || hostname.endsWith(".localhost")
    || (net.isIP(hostname) > 0 && isPrivateAddress(hostname));
}

async function responseJson(response: Response): Promise<unknown> {
  if (!response.ok) throw new Error(`Remote A2A request failed with HTTP ${response.status}`);
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_AGENT_CARD_BYTES) throw new Error("Remote A2A Agent Card is too large");
  if (!response.body) throw new Error("Remote A2A Agent Card response was empty");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const item = await reader.read();
      if (item.done) break;
      total += item.value.byteLength;
      if (total > MAX_AGENT_CARD_BYTES) {
        await reader.cancel();
        throw new Error("Remote A2A Agent Card is too large");
      }
      chunks.push(item.value);
    }
  } finally {
    reader.releaseLock();
  }
  return JSON.parse(Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString("utf8"));
}

function limitResponseBody(response: Response, maxBytes: number): Response {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) throw new Error("Remote A2A response exceeds the configured artifact limit");
  if (!response.body) return response;
  const reader = response.body.getReader();
  let total = 0;
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const item = await reader.read();
        if (item.done) {
          controller.close();
          return;
        }
        total += item.value.byteLength;
        if (total > maxBytes) {
          await reader.cancel();
          controller.error(new Error("Remote A2A response exceeds the configured artifact limit"));
          return;
        }
        controller.enqueue(item.value);
      } catch (error) {
        controller.error(error);
      }
    },
    cancel: (reason) => reader.cancel(reason),
  });
  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

function defaultGuardedFetch(
  url: string,
  init: RequestInit,
  options: { allowPrivateHosts: boolean; allowedOrigins: ReadonlySet<string> },
): Promise<Response> {
  return safeFetch(url, init, {
    allowPrivateHosts: options.allowPrivateHosts,
    allowedOrigins: options.allowedOrigins,
  });
}

function makeMessage(input: OutboundA2ASendInput): Message {
  return {
    messageId: input.messageId ?? randomUUID(),
    taskId: input.taskId ?? "",
    contextId: input.contextId ?? "",
    role: Role.ROLE_USER,
    parts: [textPart(input.message.trim())],
    metadata: { skillId: input.skillId },
    extensions: [],
    referenceTaskIds: [],
  };
}

export class OutboundA2AService {
  private readonly guardedFetch: GuardedFetch;
  private readonly cardCache = new Map<string, { key: string; expiresAt: number; card: AgentCard }>();

  constructor(
    private readonly getConfig: () => CuttlefishConfig,
    deps: OutboundA2AServiceDeps = {},
  ) {
    this.guardedFetch = deps.guardedFetch ?? defaultGuardedFetch;
  }

  private destination(id: string): A2ADestinationConfig {
    const destination = this.getConfig().a2a?.destinations?.find((entry) => entry.id === id);
    if (!destination) throw new Error(`Unknown A2A destination "${id}"`);
    return destination;
  }

  private authorizedFetch(destination: A2ADestinationConfig): typeof fetch {
    const allowedOrigins = destinationOrigins(destination);
    return (async (input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      let origin: string;
      try {
        origin = new URL(url).origin;
      } catch {
        throw new SsrfError("Refusing malformed outbound A2A URL");
      }
      const parsedUrl = new URL(url);
      if (parsedUrl.protocol !== "https:" && !(destination.allowPrivateHosts === true && isLocalDevelopmentHttpUrl(parsedUrl))) {
        throw new SsrfError("Outbound A2A credentials require HTTPS except for explicitly enabled local-development HTTP peers");
      }
      if (!allowedOrigins.has(origin)) {
        throw new SsrfError(`Refusing outbound A2A request outside the destination origin allowlist: ${origin}`);
      }
      const inheritedHeaders = input instanceof Request ? input.headers : undefined;
      const headers = new Headers(inheritedHeaders);
      new Headers(init.headers).forEach((value, key) => headers.set(key, value));
      headers.delete("authorization");
      headers.delete("x-api-key");
      if (destination.credentialType === "x-api-key") {
        headers.set("x-api-key", destination.token);
      } else {
        headers.set("Authorization", `Bearer ${destination.token}`);
      }
      const body = init.body ?? (input instanceof Request && input.method !== "GET" && input.method !== "HEAD"
        ? await input.clone().arrayBuffer()
        : undefined);
      const timeoutSignal = AbortSignal.timeout(destination.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS);
      const signal = init.signal ? AbortSignal.any([init.signal, timeoutSignal]) : timeoutSignal;
      const response = await this.guardedFetch(url, {
        ...init,
        method: init.method ?? (input instanceof Request ? input.method : undefined),
        headers,
        body,
        signal,
      }, {
        allowPrivateHosts: destination.allowPrivateHosts === true,
        allowedOrigins,
      });
      return limitResponseBody(response, getA2AMaxArtifactBytes(this.getConfig()));
    }) as typeof fetch;
  }

  async discover(destinationId: string): Promise<AgentCard> {
    const destination = this.destination(destinationId);
    const cacheKey = JSON.stringify({
      agentCardUrl: destination.agentCardUrl,
      allowedSkills: destination.allowedSkills,
      allowedOrigins: [...destinationOrigins(destination)].sort(),
      allowPrivateHosts: destination.allowPrivateHosts === true,
    });
    const cached = this.cardCache.get(destinationId);
    if (cached && cached.key === cacheKey && cached.expiresAt > Date.now()) return cached.card;
    const fetchImpl = this.authorizedFetch(destination);
    const response = await fetchImpl(destination.agentCardUrl, { headers: { "A2A-Version": "1.0" } });
    const raw = await responseJson(response);
    const resolver = new DefaultAgentCardResolver();
    const normalized = resolver.normalizeAgentCard?.(raw) ?? AgentCard.fromJSON(raw);
    const allowedOrigins = destinationOrigins(destination);
    const interfaces = normalized.supportedInterfaces.filter((entry) => {
      if (entry.protocolBinding !== "HTTP+JSON" || entry.protocolVersion !== "1.0") return false;
      try { return allowedOrigins.has(new URL(entry.url).origin); } catch { return false; }
    });
    if (interfaces.length === 0) throw new Error(`A2A destination "${destination.id}" advertises no allowed HTTP+JSON 1.0 interface`);
    const allowedSkills = new Set(destination.allowedSkills);
    const skills = normalized.skills.filter((entry) => allowedSkills.has(entry.id));
    if (skills.length === 0) throw new Error(`A2A destination "${destination.id}" advertises none of its configured allowed skills`);
    const card = { ...normalized, supportedInterfaces: interfaces, skills };
    this.cardCache.set(destinationId, { key: cacheKey, expiresAt: Date.now() + AGENT_CARD_CACHE_MS, card });
    return card;
  }

  private async client(destinationId: string): Promise<{ client: Client; card: AgentCard; destination: A2ADestinationConfig }> {
    const destination = this.destination(destinationId);
    const card = await this.discover(destinationId);
    const factory = new ClientFactory({
      transports: [new RestTransportFactory({ fetchImpl: this.authorizedFetch(destination) })],
      preferredTransports: ["HTTP+JSON"],
      clientConfig: { polling: false },
    });
    return { client: await factory.createFromAgentCard(card), card, destination };
  }

  private request(input: OutboundA2ASendInput, card: AgentCard): SendMessageRequest {
    if (!input.message.trim()) throw new Error("Outbound A2A message is required");
    if (Buffer.byteLength(input.message, "utf8") > getA2AMaxInputBytes(this.getConfig())) {
      throw new Error("Outbound A2A message exceeds the configured input limit");
    }
    const skill = card.skills.find((entry) => entry.id === input.skillId);
    if (!skill) throw new Error(`A2A skill "${input.skillId}" is not allowlisted for destination "${input.destinationId}"`);
    return {
      tenant: "",
      message: makeMessage(input),
      configuration: {
        acceptedOutputModes: skill.outputModes?.length ? skill.outputModes : (card.defaultOutputModes ?? []),
        taskPushNotificationConfig: undefined,
        historyLength: input.historyLength,
        returnImmediately: input.returnImmediately === true,
      },
      metadata: undefined,
    };
  }

  async send(input: OutboundA2ASendInput) {
    const { client, card } = await this.client(input.destinationId);
    return client.sendMessage(this.request(input, card), { signal: input.signal });
  }

  async *sendStream(input: OutboundA2ASendInput): AsyncGenerator<StreamResponse, void, undefined> {
    const { client, card } = await this.client(input.destinationId);
    yield* client.sendMessageStream(this.request(input, card), { signal: input.signal });
  }

  async getTask(destinationId: string, taskId: string, historyLength?: number, signal?: AbortSignal): Promise<Task> {
    const { client } = await this.client(destinationId);
    return client.getTask({ tenant: "", id: taskId, historyLength }, { signal });
  }

  async cancelTask(destinationId: string, taskId: string): Promise<Task> {
    const { client } = await this.client(destinationId);
    return client.cancelTask({ tenant: "", id: taskId, metadata: undefined });
  }

  async waitForTask(
    destinationId: string,
    taskId: string,
    options: {
      pollIntervalMs?: number;
      timeoutMs?: number;
      signal?: AbortSignal;
      onUpdate?: (task: Task) => void | Promise<void>;
    } = {},
  ): Promise<Task> {
    const startedAt = Date.now();
    const interval = options.pollIntervalMs ?? 500;
    const timeout = options.timeoutMs ?? 10 * 60 * 1000;
    while (true) {
      if (options.signal?.aborted) throw options.signal.reason ?? new Error("Outbound A2A wait aborted");
      const task = await this.getTask(destinationId, taskId, undefined, options.signal);
      await options.onUpdate?.(task);
      if (task.status?.state !== undefined && OUTBOUND_TERMINAL_STATES.has(task.status.state)) return task;
      if (Date.now() - startedAt >= timeout) throw new Error(`Timed out waiting for outbound A2A task ${taskId}`);
      await new Promise((resolve) => setTimeout(resolve, interval));
    }
  }
}
