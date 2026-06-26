import fs from "node:fs";
import path from "node:path";
import { CUTTLEFISH_HOME } from "../shared/paths.js";
import { safeWriteFile } from "../shared/safe-write.js";
import type { EngineFailureReason, Session } from "../shared/types.js";
import type { ModelFallbackCandidate } from "../shared/model-fallback.js";

function safe(s: string): string {
  return s.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80) || "fallback";
}

function isoStamp(): string {
  return new Date().toISOString().replace(/[:.]/g, "").replace("Z", "Z");
}

export function createModelFallbackHandoff(opts: {
  session: Session;
  employeeName?: string | null;
  fromEngine: string;
  fromModel?: string | null;
  target: ModelFallbackCandidate;
  failureReason: EngineFailureReason;
  prompt: string;
  recentMessages: Array<{ role: string; content: string; timestamp?: number }>;
  detail?: string;
}): { path: string; relativePath: string; markdown: string } {
  const dir = path.join(CUTTLEFISH_HOME, "handoffs", "model-fallback", opts.session.id);
  fs.mkdirSync(dir, { recursive: true });
  const file = isoStamp() + "_" + safe(opts.fromEngine) + "-to-" + safe(opts.target.engine) + ".md";
  const full = path.join(dir, file);
  const recent = opts.recentMessages
    .slice(-20)
    .map((m) => "## " + m.role.toUpperCase() + "\n\n" + (m.content || "").slice(0, 6000))
    .join("\n\n");

  const md = [
    "# Model Fallback Handoff",
    "",
    "- Original agent: " + (opts.employeeName || opts.session.employee || "(none)"),
    "- Session: " + opts.session.id,
    "- Failure reason: " + opts.failureReason,
    "- Detail: " + (opts.detail || ""),
    "- From: " + opts.fromEngine + "/" + (opts.fromModel || "default"),
    "- To: " + opts.target.engine + "/" + opts.target.model + (opts.target.effortLevel ? " / effort " + opts.target.effortLevel : ""),
    "- Fallback source: " + opts.target.source + " (" + opts.target.via + ")",
    "- Target employee override: " + (opts.target.employee || "(none)"),
    "- Created: " + new Date().toISOString(),
    "",
    "## Current task",
    "",
    opts.prompt.slice(0, 12000),
    "",
    "## Constraints",
    "",
    "Continue the same task without assuming hidden context. Preserve technical truth and prior decisions. If source artifacts conflict, stop and ask/route back to the owning department.",
    "",
    "## Recent transcript",
    "",
    recent || "No recent transcript available.",
    "",
    "## Next recommended action",
    "",
    "Resume from this handoff packet, verify current files/artifacts before editing, and record that this turn is running on fallback.",
    "",
  ].join("\n");

  // Atomic + audited: handoff packets are a rare, security-relevant record of a
  // model fallback the operator may later approve (F1), so they enter the ledger.
  safeWriteFile(full, md, { audit: { actor: "gateway", op: "model-fallback.handoff" } });
  return { path: full, relativePath: path.relative(CUTTLEFISH_HOME, full), markdown: md };
}
