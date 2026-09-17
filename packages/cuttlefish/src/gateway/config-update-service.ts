import fs from "node:fs";
import * as yaml from "js-yaml";
import { CONFIG_PATH } from "../shared/paths.js";
import { saveConfigAtomic, validateConfigShape } from "../shared/config.js";
import { deepMerge } from "./config-sanitize.js";

type ConfigUpdateResult =
  | { ok: true }
  | { ok: false; status: 400; error: string }
  | { ok: false; status: 409; code: "CONFIG_INVALID_ON_DISK" | "CONFIG_UNREADABLE"; error: string };

/** Merge and save synchronously so unreadable existing state is never replaced. */
export function updateConfigFromApi(body: Record<string, unknown>): ConfigUpdateResult {
  let existing: Record<string, unknown> = {};
  let raw: string | undefined;
  try {
    raw = fs.readFileSync(CONFIG_PATH, "utf-8");
  } catch (err) {
    // A genuinely absent file has no bytes to preserve; other I/O failures do.
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      return {
        ok: false, status: 409, code: "CONFIG_UNREADABLE",
        error: "config.yaml cannot be read; repair its access before saving.",
      };
    }
  }
  if (raw !== undefined) {
    let parsed: unknown;
    try {
      parsed = yaml.load(raw);
    } catch {
      return invalidExistingConfig();
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(parsed))) {
      return invalidExistingConfig();
    }
    existing = parsed as Record<string, unknown>;
  }
  const merged = deepMerge(existing, body);
  const problems = validateConfigShape(merged);
  if (problems.length > 0) {
    return { ok: false, status: 400, error: `Invalid config:\n- ${problems.join("\n- ")}` };
  }
  saveConfigAtomic(merged);
  return { ok: true };
}

function invalidExistingConfig(): Extract<ConfigUpdateResult, { status: 409 }> {
  // Do not include YAML parser excerpts: config lines can contain credentials.
  return {
    ok: false, status: 409, code: "CONFIG_INVALID_ON_DISK",
    error: "config.yaml is not a valid mapping; repair the existing file before saving.",
  };
}
