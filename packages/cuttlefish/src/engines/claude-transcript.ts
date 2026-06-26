import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CUTTLEFISH_HOME } from "../shared/paths.js";

export function findTranscriptForSession(
  claudeSessionId: string,
  homeDir: string = CUTTLEFISH_HOME,
  projectsDir: string = path.join(os.homedir(), ".claude", "projects"),
): string | undefined {
  if (!claudeSessionId) return undefined;
  const slug = homeDir.replace(/[/.]/g, "-");
  const direct = path.join(projectsDir, slug, `${claudeSessionId}.jsonl`);
  if (fs.existsSync(direct)) return direct;
  try {
    for (const d of fs.readdirSync(projectsDir)) {
      const p = path.join(projectsDir, d, `${claudeSessionId}.jsonl`);
      if (fs.existsSync(p)) return p;
    }
  } catch {
    /* projects dir missing */
  }
  return undefined;
}

function isInternalNotificationPrompt(content: string): boolean {
  const t = content.trim();
  return (
    (
      t.startsWith("📩 Employee ") &&
      t.includes(" replied in child session ") &&
      t.includes("To read the full reply:")
    ) ||
    (
      t.startsWith("⚠️ Employee ") &&
      t.includes(" (child session ") &&
      t.includes(" hit an error and could not finish:")
    ) ||
    (
      t.startsWith("📩 Thread ") &&
      t.includes(" reported back.") &&
      t.includes("To follow up,")
    ) ||
    (
      t.startsWith("⚠️ Thread ") &&
      t.includes(" hit an error.") &&
      t.includes("Tell the operator plainly")
    )
  );
}

function isControlText(content: string): boolean {
  const t = content.trim();
  return (
    t.startsWith("<command-name>") ||
    t.startsWith("<local-command-") ||
    t.startsWith("<task-notification>") ||
    isInternalNotificationPrompt(t) ||
    t.startsWith("This session is being continued from a previous conversation")
  );
}

export function isPersistableClaudeTranscriptEntry(obj: any): boolean {
  if (!obj || typeof obj !== "object") return false;
  const type = obj?.type;
  if (type !== "user" && type !== "assistant") return false;
  if (obj.isSidechain === true || obj.isMeta === true) return false;
  if (obj.sourceToolAssistantUUID || obj.toolUseResult) return false;
  if (obj.promptSource === "system") return false;
  if (obj?.origin?.kind === "task-notification") return false;
  if (obj?.message?.model === "<synthetic>") return false;
  const raw = obj?.message?.content;
  if (typeof raw === "string" && isControlText(raw)) return false;
  return true;
}

export function transcriptEntryText(obj: any): { role: "user" | "assistant"; content: string } | null {
  if (!isPersistableClaudeTranscriptEntry(obj)) return null;
  let content = obj?.message?.content;
  if (Array.isArray(content)) {
    content = content
      .filter((b: Record<string, unknown>) => b?.type === "text")
      .map((b: Record<string, unknown>) => String(b.text ?? ""))
      .join("");
  }
  if (typeof content !== "string" || !content.trim()) return null;
  if (isControlText(content)) return null;
  return { role: obj.type, content: content.trim() };
}
