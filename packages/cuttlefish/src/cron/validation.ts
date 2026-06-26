import crypto from "node:crypto";
import cron from "node-cron";
import type { CronDelivery, CronJob } from "../shared/types.js";

const CREATE_FIELDS = new Set(["id", "name", "enabled", "schedule", "timezone", "engine", "model", "employee", "prompt", "delivery"]);
const UPDATE_FIELDS = new Set(["name", "enabled", "schedule", "timezone", "engine", "model", "employee", "prompt", "delivery"]);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function optionalString(body: Record<string, unknown>, key: string): string | undefined {
  const value = body[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") throw new Error(`${key} must be a string`);
  const trimmed = value.trim();
  return trimmed || undefined;
}

function optionalBoolean(body: Record<string, unknown>, key: string): boolean | undefined {
  const value = body[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "boolean") throw new Error(`${key} must be a boolean`);
  return value;
}

export function validateTimezone(tz: string | undefined): string | undefined {
  if (!tz) return undefined;
  try {
    Intl.DateTimeFormat(undefined, { timeZone: tz });
    return tz;
  } catch {
    throw new Error(`timezone is not valid: ${tz}`);
  }
}

function validateDelivery(value: unknown): CronDelivery | undefined {
  if (value === undefined || value === null) return undefined;
  if (!isPlainObject(value)) throw new Error("delivery must be an object");
  const connector = optionalString(value, "connector");
  const channel = optionalString(value, "channel");
  if (!connector || !channel) throw new Error("delivery.connector and delivery.channel are required strings");
  return { connector, channel };
}

function rejectUnknown(body: Record<string, unknown>, allowed: Set<string>): void {
  const unknown = Object.keys(body).filter((key) => !allowed.has(key));
  if (unknown.length > 0) throw new Error(`Unknown cron fields: ${unknown.join(", ")}`);
}

export function buildCronJob(body: unknown): CronJob {
  if (!isPlainObject(body)) throw new Error("Cron job must be an object");
  rejectUnknown(body, CREATE_FIELDS);
  const schedule = optionalString(body, "schedule") ?? "0 * * * *";
  if (!cron.validate(schedule)) throw new Error("schedule must be a valid cron expression");
  return {
    id: optionalString(body, "id") ?? crypto.randomUUID(),
    name: optionalString(body, "name") ?? "untitled",
    enabled: optionalBoolean(body, "enabled") ?? true,
    schedule,
    timezone: validateTimezone(optionalString(body, "timezone")),
    engine: optionalString(body, "engine"),
    model: optionalString(body, "model"),
    employee: optionalString(body, "employee"),
    prompt: optionalString(body, "prompt") ?? "",
    delivery: validateDelivery(body.delivery),
  };
}

export function patchCronJob(existing: CronJob, body: unknown): CronJob {
  if (!isPlainObject(body)) throw new Error("Cron update must be an object");
  rejectUnknown(body, UPDATE_FIELDS);
  const next: CronJob = { ...existing };
  if (body.name !== undefined) next.name = optionalString(body, "name") ?? existing.name;
  if (body.enabled !== undefined) next.enabled = optionalBoolean(body, "enabled") ?? existing.enabled;
  if (body.schedule !== undefined) {
    const schedule = optionalString(body, "schedule");
    if (!schedule || !cron.validate(schedule)) throw new Error("schedule must be a valid cron expression");
    next.schedule = schedule;
  }
  if (body.timezone !== undefined) next.timezone = validateTimezone(optionalString(body, "timezone"));
  if (body.engine !== undefined) next.engine = optionalString(body, "engine");
  if (body.model !== undefined) next.model = optionalString(body, "model");
  if (body.employee !== undefined) next.employee = optionalString(body, "employee");
  if (body.prompt !== undefined) next.prompt = optionalString(body, "prompt") ?? "";
  if (body.delivery !== undefined) next.delivery = validateDelivery(body.delivery);
  return next;
}
