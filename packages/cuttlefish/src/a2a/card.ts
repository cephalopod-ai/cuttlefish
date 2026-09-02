import { createHash } from "node:crypto";
import type { AgentCard, AgentSkill, SecurityRequirement } from "@a2a-js/sdk";
import type { CuttlefishConfig, Employee } from "../shared/types.js";
import { getPackageVersion } from "../shared/version.js";
import { buildOrgServices } from "../gateway/org-services.js";
import { scanOrg } from "../gateway/org.js";
import { configuredServiceNames, getA2APublicUrl, normalizeServiceName } from "./config.js";

const BEARER_SCHEME = "cuttlefishBearer";
const API_KEY_SCHEME = "cuttlefishApiKey";

function bearerRequirement(): SecurityRequirement {
  return { schemes: { [BEARER_SCHEME]: { list: [] } } };
}

function apiKeyRequirement(): SecurityRequirement {
  return { schemes: { [API_KEY_SCHEME]: { list: [] } } };
}

function securityRequirements(): SecurityRequirement[] {
  return [bearerRequirement(), apiKeyRequirement()];
}

export function a2aSkillId(serviceName: string): string {
  const normalized = normalizeServiceName(serviceName);
  const slug = normalized.replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 48) || "service";
  const digest = createHash("sha256").update(normalized).digest("hex").slice(0, 10);
  return `${slug}-${digest}`;
}

export interface AdvertisedA2AService {
  name: string;
  description: string;
  skillId: string;
}

export function listAdvertisedA2AServices(
  config: CuttlefishConfig,
  registry: Map<string, Employee> = scanOrg(),
): AdvertisedA2AService[] {
  const allowed = configuredServiceNames(config);
  return buildOrgServices(registry)
    .filter((service) => allowed.has(normalizeServiceName(service.name)))
    .map((service) => ({
      name: service.name,
      description: service.description,
      skillId: a2aSkillId(service.name),
    }));
}

function skill(service: AdvertisedA2AService): AgentSkill {
  return {
    id: service.skillId,
    name: service.name,
    description: service.description,
    tags: ["cuttlefish", "service"],
    examples: [],
    inputModes: ["text/plain", "application/json", "application/octet-stream"],
    outputModes: ["text/plain", "application/json"],
    securityRequirements: securityRequirements(),
  };
}

export function buildA2AAgentCard(
  config: CuttlefishConfig,
  registry?: Map<string, Employee>,
): AgentCard {
  return {
    name: "Cuttlefish",
    description: "A Cuttlefish gateway exposing explicitly allowlisted organization services through A2A.",
    supportedInterfaces: [{
      url: getA2APublicUrl(config),
      protocolBinding: "HTTP+JSON",
      protocolVersion: "1.0",
      tenant: "",
    }],
    provider: undefined,
    version: config.cuttlefish?.version ?? getPackageVersion(),
    capabilities: { streaming: true, pushNotifications: false, extendedAgentCard: false, extensions: [] },
    securitySchemes: {
      [BEARER_SCHEME]: {
        scheme: {
          $case: "httpAuthSecurityScheme",
          value: {
            scheme: "Bearer",
            bearerFormat: "opaque",
            description: "Per-client Cuttlefish A2A bearer credential.",
          },
        },
      },
      [API_KEY_SCHEME]: {
        scheme: {
          $case: "apiKeySecurityScheme",
          value: {
            description: "Per-client Cuttlefish A2A API key credential.",
            location: "header",
            name: "x-api-key",
          },
        },
      },
    },
    securityRequirements: securityRequirements(),
    defaultInputModes: ["text/plain", "application/json", "application/octet-stream"],
    defaultOutputModes: ["text/plain", "application/json"],
    skills: listAdvertisedA2AServices(config, registry).map(skill),
    signatures: [],
  };
}
