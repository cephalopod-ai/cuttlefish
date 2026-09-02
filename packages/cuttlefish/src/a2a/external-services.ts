import { Role, TaskState, type Message, type Part, type Task } from "@a2a-js/sdk";
import type { A2ADestinationConfig, CuttlefishConfig } from "../shared/types.js";

export interface ConfiguredExternalA2AService {
  name: string;
  description: string;
  skillId: string;
  destinationId: string;
  providerId: string;
}

export function listConfiguredExternalA2AServices(config: CuttlefishConfig): ConfiguredExternalA2AService[] {
  return (config.a2a?.destinations ?? []).flatMap((destination) =>
    (destination.services ?? []).map((service) => ({
      name: service.name.trim(),
      description: service.description.trim(),
      skillId: service.skillId,
      destinationId: destination.id,
      providerId: `a2a:${destination.id}`,
    })),
  ).sort((left, right) => left.name.localeCompare(right.name));
}

export function findConfiguredExternalA2AService(
  config: CuttlefishConfig,
  serviceName: string,
): ConfiguredExternalA2AService | undefined {
  const normalized = serviceName.trim().toLowerCase();
  return listConfiguredExternalA2AServices(config).find((service) => service.name.toLowerCase() === normalized);
}

export function externalA2AServiceSummary(service: ConfiguredExternalA2AService) {
  return {
    name: service.name,
    description: service.description,
    provider: {
      name: service.providerId,
      displayName: `External A2A peer (${service.destinationId})`,
      department: "external",
      rank: "employee" as const,
      kind: "a2a" as const,
    },
  };
}

/** Merge external service mappings into discovery without shadowing an internal provider. */
export function appendExternalA2AServices<T extends { name: string }>(
  nativeServices: T[],
  config: CuttlefishConfig,
): Array<T | ReturnType<typeof externalA2AServiceSummary>> {
  const nativeNames = new Set(nativeServices.map((service) => service.name.toLowerCase()));
  const externalServices = listConfiguredExternalA2AServices(config)
    .filter((service) => !nativeNames.has(service.name.toLowerCase()))
    .map(externalA2AServiceSummary);
  return [...nativeServices, ...externalServices];
}

function partText(part: Part): string | undefined {
  if (part.content?.$case === "text") return part.content.value;
  if (part.content?.$case === "data") return JSON.stringify(part.content.value);
  if (part.content?.$case === "url") return `[remote artifact URL: ${part.content.value}]`;
  if (part.content?.$case === "raw") return `[remote artifact: ${part.filename || "unnamed"} (${part.mediaType || "application/octet-stream"})]`;
  return undefined;
}

function messageText(message: Message | undefined): string[] {
  if (!message || message.role !== Role.ROLE_AGENT) return [];
  return message.parts.map(partText).filter((value): value is string => Boolean(value));
}

export function isA2ATask(value: Message | Task): value is Task {
  return "id" in value && "status" in value;
}

export function externalA2AResultText(result: Message | Task): string {
  const texts = isA2ATask(result)
    ? [
        ...messageText(result.status?.message),
        ...result.artifacts.flatMap((artifact) => artifact.parts.map(partText).filter((value): value is string => Boolean(value))),
        ...result.history.flatMap(messageText),
      ]
    : messageText(result);
  return [...new Set(texts)].join("\n").slice(0, 512 * 1024);
}

export function externalA2ATaskIsTerminal(task: Task): boolean {
  return new Set([
    TaskState.TASK_STATE_COMPLETED,
    TaskState.TASK_STATE_FAILED,
    TaskState.TASK_STATE_CANCELED,
    TaskState.TASK_STATE_REJECTED,
    TaskState.TASK_STATE_INPUT_REQUIRED,
    TaskState.TASK_STATE_AUTH_REQUIRED,
  ]).has(task.status?.state ?? TaskState.TASK_STATE_UNSPECIFIED);
}

export function destinationForExternalService(
  config: CuttlefishConfig,
  service: ConfiguredExternalA2AService,
): A2ADestinationConfig | undefined {
  return config.a2a?.destinations?.find((destination) => destination.id === service.destinationId);
}
