import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import type { StreamDelta } from "../shared/types.js";
import { logger } from "../shared/logger.js";
import { safeWriteFile } from "../shared/safe-write.js";

/**
 * Pure protocol helpers for the Antigravity (`agy`) engine — no PTY, no I/O
 * orchestration, so they're unit-testable in isolation.
 *
 * `agy` has no headless/`--print` mode and no hook system. The only machine-
 * readable surface is the per-conversation transcript it writes to disk:
 *   ~/.gemini/antigravity-cli/brain/<convId>/.system_generated/logs/transcript.jsonl
 *
 * Each line is a JSON object: { step_index, source, type, status, content }.
 *   - source "USER_EXPLICIT" / type "USER_INPUT"      → our prompt
 *   - source "SYSTEM"        / type "CONVERSATION_HISTORY"
 *   - source "MODEL"         / type "PLANNER_RESPONSE" → assistant turn;
 *       status "DONE" marks turn completion, `content` is the answer.
 */

/** agy's on-disk state dir (shared with Gemini account dir). */
export const ANTIGRAVITY_HOME = path.join(os.homedir(), ".gemini", "antigravity-cli");
export const ANTIGRAVITY_BRAIN_DIR = path.join(ANTIGRAVITY_HOME, "brain");
export const ANTIGRAVITY_SETTINGS_PATH = path.join(ANTIGRAVITY_HOME, "settings.json");

/** Absolute path to a conversation's streaming transcript. */
export function transcriptPathFor(convId: string, brainDir: string = ANTIGRAVITY_BRAIN_DIR): string {
  return path.join(brainDir, convId, ".system_generated", "logs", "transcript.jsonl");
}

/** Absolute path to a conversation's FULL transcript (history + tool calls) —
 *  the closest on-disk proxy for what the model carries as context. */
export function fullTranscriptPathFor(convId: string, brainDir: string = ANTIGRAVITY_BRAIN_DIR): string {
  return path.join(brainDir, convId, ".system_generated", "logs", "transcript_full.jsonl");
}

/** Estimate context tokens for an agy conversation. agy exposes NO usage data, so
 *  this is an APPROXIMATION: bytes of the full transcript / 4 (the standard rough
 *  chars-per-token ratio). Good enough for a "how full is the window" gauge against
 *  a 1M-token model; not an exact count. Returns 0 if the transcript is unreadable. */
export function estimateContextTokens(convId: string, brainDir: string = ANTIGRAVITY_BRAIN_DIR): number {
  try {
    const size = fs.statSync(fullTranscriptPathFor(convId, brainDir)).size;
    return Math.round(size / 4);
  } catch {
    return 0;
  }
}

interface TranscriptRow {
  step_index?: number;
  source?: string;
  type?: string;
  status?: string;
  content?: string;
  tool_calls?: Array<{
    name?: string;
    args?: Record<string, unknown>;
  }>;
}

/**
 * Per-turn tool-card state threaded through {@link transcriptLineToDeltas}.
 *
 * agy opens a tool card two ways: a `tool_calls[]` array on a PLANNER_RESPONSE
 * row, or (rarely) a standalone tool row with `status:"RUNNING"`. Most often the
 * only trace of a tool is its terminal `status:"DONE"` row with NO opener at all.
 *
 * The web/talk renderers open a card on `tool_use` and merely *mutate the last
 * card* on `tool_result` — they never create one. So a lone `tool_result` lands
 * on whatever the previous message was and the tool card is lost. `openCards`
 * counts the cards opened-but-not-yet-closed so a DONE row can either close an
 * existing card (no duplicate) or, when none is open, synthesize its own
 * self-contained `tool_use`+`tool_result` pair (card preserved).
 */
export interface ToolCardState {
  openCards: number;
}

export function newToolCardState(): ToolCardState {
  return { openCards: 0 };
}

function parseRow(line: string): TranscriptRow | null {
  const t = line.trim();
  if (!t) return null;
  try {
    return JSON.parse(t) as TranscriptRow;
  } catch {
    return null;
  }
}

function isModelDone(row: TranscriptRow): boolean {
  return row.source === "MODEL" && row.type === "PLANNER_RESPONSE" && row.status === "DONE";
}

function isModelInProgress(row: TranscriptRow): boolean {
  return row.source === "MODEL" && row.type === "PLANNER_RESPONSE" && row.status === "IN_PROGRESS";
}

function hasToolCalls(row: TranscriptRow): boolean {
  return Array.isArray(row.tool_calls) && row.tool_calls.length > 0;
}

function toolNameFromCall(call: NonNullable<TranscriptRow["tool_calls"]>[number]): string {
  return String(call.name || "tool").toLowerCase();
}

function isToolRow(row: TranscriptRow): boolean {
  return row.source === "MODEL"
    && typeof row.type === "string"
    && row.type !== "PLANNER_RESPONSE"
    && row.type !== "GENERIC";
}

/** All completed assistant responses (content of MODEL/PLANNER_RESPONSE/DONE rows), in order. */
export function extractDoneResponses(transcript: string): string[] {
  const out: string[] = [];
  for (const line of transcript.split("\n")) {
    const row = parseRow(line);
    if (row && isModelDone(row) && typeof row.content === "string") {
      out.push(row.content);
    }
  }
  return out;
}

/**
 * Map one transcript line to StreamDeltas for the parsed (Chat-view) stream.
 *
 * Pass a per-turn `state` (see {@link newToolCardState}) so tool cards survive
 * agy's DONE-only tool rows: planner `tool_calls` and `RUNNING` rows open a card
 * and bump `openCards`; a DONE/ERROR row closes one if open, else synthesizes its
 * own `tool_use`+`tool_result` pair. Called statelessly, every DONE/ERROR tool
 * row is treated as orphaned and synthesizes a full card.
 */
export function transcriptLineToDeltas(line: string, state?: ToolCardState): StreamDelta[] {
  const row = parseRow(line);
  if (!row) return [];
  if (isModelDone(row)) {
    const deltas: StreamDelta[] = [];
    if (typeof row.content === "string" && row.content) {
      deltas.push({ type: "text", content: row.content });
    }
    if (hasToolCalls(row)) {
      row.tool_calls!.forEach((call, idx) => {
        const toolName = toolNameFromCall(call);
        deltas.push({
          type: "tool_use",
          content: `Using ${toolName}`,
          toolName,
          toolId: typeof row.step_index === "number" ? `${row.step_index}:${idx}` : undefined,
        });
        if (state) state.openCards++;
      });
    }
    return deltas;
  }
  if (isModelInProgress(row) && typeof row.content === "string" && row.content) {
    return [{ type: "text_snapshot", content: row.content }];
  }
  if (isToolRow(row)) {
    const toolName = String(row.type || "tool").toLowerCase();
    if (row.status === "RUNNING") {
      if (state) state.openCards++;
      return [{ type: "tool_use", content: `Using ${toolName}`, toolName }];
    }
    if (row.status === "DONE" || row.status === "ERROR") {
      const result: StreamDelta = {
        type: "tool_result",
        content: `${toolName} ${row.status === "ERROR" ? "failed" : "done"}`,
        toolName,
      };
      // A card is already open (planner tool_calls or a RUNNING row): just close it.
      if (state && state.openCards > 0) {
        state.openCards--;
        return [result];
      }
      // Orphaned DONE/ERROR — no opener was ever emitted, so the renderer has no
      // card to attach the result to. Synthesize a self-contained card.
      return [{ type: "tool_use", content: `Using ${toolName}`, toolName }, result];
    }
  }
  return [];
}

/** A non-empty planner response with no tool call is agy's strongest turn-final signal. */
export function isTerminalAnswerLine(line: string): { terminal: boolean; content?: string } {
  const row = parseRow(line);
  if (!row || !isModelDone(row) || hasToolCalls(row)) return { terminal: false };
  return typeof row.content === "string" && row.content
    ? { terminal: true, content: row.content }
    : { terminal: false };
}

/**
 * Pre-seed agy's workspace trust so a headless PTY spawn in `workspacePath`
 * doesn't block on the interactive "do you trust this folder?" prompt.
 * agy stores trust as realpath'd entries in settings.json → trustedWorkspaces.
 * Idempotent; tolerant of a missing or malformed existing file.
 */
export function ensureWorkspaceTrusted(workspacePath: string, settingsPath: string = ANTIGRAVITY_SETTINGS_PATH): void {
  let real = workspacePath;
  try {
    real = fs.realpathSync(workspacePath);
  } catch {
    /* dir may not exist yet — fall back to the given path */
  }

  let settings: Record<string, unknown> = {};
  try {
    if (fs.existsSync(settingsPath)) {
      settings = JSON.parse(fs.readFileSync(settingsPath, "utf-8")) as Record<string, unknown>;
    }
  } catch {
    logger.warn(`antigravity: settings.json at ${settingsPath} was unreadable/malformed — recreating`);
    settings = {};
  }

  const list = Array.isArray(settings.trustedWorkspaces)
    ? (settings.trustedWorkspaces as string[]).filter((w) => typeof w === "string")
    : [];
  if (!list.includes(real)) list.push(real);
  settings.trustedWorkspaces = list;

  try {
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    safeWriteFile(settingsPath, JSON.stringify(settings, null, 2)); // atomic + fsync (antigravity workspace trust)
  } catch (err) {
    logger.warn(`antigravity: failed to seed workspace trust: ${err instanceof Error ? err.message : err}`);
  }
}

/** Snapshot of existing conversation directory names under brain/ (for new-conv detection). */
export function listConvDirs(brainDir: string = ANTIGRAVITY_BRAIN_DIR): Set<string> {
  try {
    return new Set(
      fs.readdirSync(brainDir, { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .map((e) => e.name),
    );
  } catch {
    return new Set();
  }
}
