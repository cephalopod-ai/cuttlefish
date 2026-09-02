import { createHash } from "node:crypto";
import type { Message } from "@a2a-js/sdk";
import { RequestMalformedError } from "@a2a-js/sdk/errors";
import type { AdvertisedA2AService } from "./card.js";
import { normalizeServiceName } from "./config.js";

export interface A2AInboundRawFile {
  filename: string;
  mediaType: string;
  buffer: Buffer;
}

export interface ParsedA2AInput {
  prompt: string;
  rawFiles: A2AInboundRawFile[];
  urlResources: Array<{ url: string; access: "read_only"; intendedUse: string }>;
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nested]) => [key, stableValue(nested)]));
  }
  return value;
}

export function hashA2AInput(message: Message): string {
  const canonical = JSON.stringify(stableValue({
    messageId: message.messageId,
    contextId: message.contextId,
    role: message.role,
    parts: message.parts,
    metadata: message.metadata,
    extensions: message.extensions,
    referenceTaskIds: message.referenceTaskIds,
  }));
  return createHash("sha256").update(canonical).digest("hex");
}

export function parseA2AInput(message: Message, maxInputBytes: number, maxArtifactBytes: number): ParsedA2AInput {
  const chunks: string[] = [];
  const rawFiles: A2AInboundRawFile[] = [];
  const urlResources: ParsedA2AInput["urlResources"] = [];
  let rawBytes = 0;
  for (const part of message.parts) {
    if (part.content?.$case === "text") {
      chunks.push(part.content.value);
    } else if (part.content?.$case === "data") {
      chunks.push(JSON.stringify(stableValue(part.content.value)));
    } else if (part.content?.$case === "raw") {
      rawBytes += part.content.value.byteLength;
      if (rawBytes > maxArtifactBytes) {
        throw new RequestMalformedError(`A2A raw-file parts exceed the ${maxArtifactBytes}-byte decoded artifact limit`);
      }
      rawFiles.push({
        filename: part.filename || "a2a-file",
        mediaType: part.mediaType || "application/octet-stream",
        buffer: Buffer.from(part.content.value),
      });
    } else if (part.content?.$case === "url") {
      let parsed: URL;
      try {
        parsed = new URL(part.content.value);
      } catch {
        throw new RequestMalformedError("A2A URL part must contain an absolute URL");
      }
      if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
        throw new RequestMalformedError("A2A URL parts must use http or https");
      }
      urlResources.push({ url: parsed.toString(), access: "read_only", intendedUse: "A2A request input" });
    } else {
      throw new RequestMalformedError("A2A message contains an unsupported empty part");
    }
  }
  if (rawFiles.length + urlResources.length > 16) throw new RequestMalformedError("A2A message may contain at most 16 file or URL parts");
  const prompt = chunks.filter(Boolean).join("\n\n").trim()
    || (rawFiles.length + urlResources.length > 0 ? "Process the attached A2A request resources." : "");
  if (!prompt) throw new RequestMalformedError("A2A message must contain non-empty content");
  if (Buffer.byteLength(prompt, "utf8") > maxInputBytes) {
    throw new RequestMalformedError(`A2A message exceeds the ${maxInputBytes}-byte input limit`);
  }
  return { prompt, rawFiles, urlResources };
}

export function extractA2APrompt(message: Message, maxInputBytes: number): string {
  return parseA2AInput(message, maxInputBytes, 0).prompt;
}

function requestedSkill(message: Message): string | undefined {
  const metadata = message.metadata ?? {};
  for (const key of ["skillId", "service", "cuttlefish.service"]) {
    const value = metadata[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

export function resolveA2AService(message: Message, available: AdvertisedA2AService[]): AdvertisedA2AService {
  const requested = requestedSkill(message);
  if (!requested && available.length === 1) return available[0]!;
  if (requested) {
    const normalized = normalizeServiceName(requested);
    const match = available.find((service) => service.skillId === requested || normalizeServiceName(service.name) === normalized);
    if (match) return match;
  }
  const choices = available.map((service) => `${service.name} (${service.skillId})`).join(", ");
  throw new RequestMalformedError(
    available.length === 0
      ? "No A2A service is available to this caller"
      : `Select an available A2A skill in message metadata: ${choices}`,
  );
}

export function textPart(value: string) {
  return {
    content: { $case: "text" as const, value },
    metadata: undefined,
    filename: "",
    mediaType: "text/plain",
  };
}
