import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  extractDoneResponses,
  transcriptLineToDeltas,
  isTerminalAnswerLine,
  newToolCardState,
  ensureWorkspaceTrusted,
} from "../antigravity-protocol.js";

const USER_LINE = `{"step_index":0,"source":"USER_EXPLICIT","type":"USER_INPUT","status":"DONE","content":"<USER_REQUEST>\\nhi\\n</USER_REQUEST>"}`;
const HISTORY_LINE = `{"step_index":1,"source":"SYSTEM","type":"CONVERSATION_HISTORY","status":"DONE"}`;
const MODEL_DONE = `{"step_index":2,"source":"MODEL","type":"PLANNER_RESPONSE","status":"DONE","content":"alpha beta gamma"}`;
const MODEL_INPROGRESS = `{"step_index":3,"source":"MODEL","type":"PLANNER_RESPONSE","status":"IN_PROGRESS","content":"thinking..."}`;
const MODEL_DONE_2 = `{"step_index":4,"source":"MODEL","type":"PLANNER_RESPONSE","status":"DONE","content":"second answer"}`;
const TOOL_RUNNING = `{"step_index":5,"source":"MODEL","type":"RUN_COMMAND","status":"RUNNING","content":"Created At: now"}`;
const TOOL_DONE = `{"step_index":6,"source":"MODEL","type":"RUN_COMMAND","status":"DONE","content":"Completed At: now"}`;
const PLANNER_TOOL_ONLY = `{"step_index":7,"source":"MODEL","type":"PLANNER_RESPONSE","status":"DONE","tool_calls":[{"name":"run_command","args":{"toolAction":"Checking status"}}]}`;
const PLANNER_TEXT_AND_TOOL = `{"step_index":8,"source":"MODEL","type":"PLANNER_RESPONSE","status":"DONE","content":"I will check the files.","tool_calls":[{"name":"view_file","args":{"toolSummary":"View file"}}]}`;

describe("extractDoneResponses", () => {
  it("returns only MODEL/PLANNER_RESPONSE entries with status DONE, in order", () => {
    const content = [USER_LINE, HISTORY_LINE, MODEL_DONE, MODEL_DONE_2].join("\n");
    expect(extractDoneResponses(content)).toEqual(["alpha beta gamma", "second answer"]);
  });

  it("ignores non-DONE responses and non-model rows", () => {
    const content = [USER_LINE, MODEL_INPROGRESS, MODEL_DONE].join("\n");
    expect(extractDoneResponses(content)).toEqual(["alpha beta gamma"]);
  });

  it("skips malformed / blank lines", () => {
    const content = ["", "not json", MODEL_DONE, "  "].join("\n");
    expect(extractDoneResponses(content)).toEqual(["alpha beta gamma"]);
  });

  it("returns empty for an empty transcript", () => {
    expect(extractDoneResponses("")).toEqual([]);
  });
});

describe("transcriptLineToDeltas", () => {
  it("emits a text delta for a DONE model response", () => {
    expect(transcriptLineToDeltas(MODEL_DONE)).toEqual([{ type: "text", content: "alpha beta gamma" }]);
  });

  it("emits a text snapshot for an in-progress model response", () => {
    expect(transcriptLineToDeltas(MODEL_INPROGRESS)).toEqual([{ type: "text_snapshot", content: "thinking..." }]);
  });

  it("emits nothing for user input, history, or junk", () => {
    expect(transcriptLineToDeltas(USER_LINE)).toEqual([]);
    expect(transcriptLineToDeltas(HISTORY_LINE)).toEqual([]);
    expect(transcriptLineToDeltas("garbage")).toEqual([]);
    expect(transcriptLineToDeltas("")).toEqual([]);
  });

  it("emits a tool-use marker for a RUNNING tool row", () => {
    expect(transcriptLineToDeltas(TOOL_RUNNING)).toEqual([
      { type: "tool_use", content: "Using run_command", toolName: "run_command" },
    ]);
  });

  it("synthesizes a full card for an orphaned DONE tool row (no opener)", () => {
    // agy's common case: a tool's only trace is its DONE row, with no RUNNING and
    // no planner tool_call. Stateless (or no open card) → emit BOTH halves so the
    // renderer has a tool_use to attach the result to instead of losing the card.
    expect(transcriptLineToDeltas(TOOL_DONE)).toEqual([
      { type: "tool_use", content: "Using run_command", toolName: "run_command" },
      { type: "tool_result", content: "run_command done", toolName: "run_command" },
    ]);
  });

  it("emits tool-use markers from planner tool_calls", () => {
    expect(transcriptLineToDeltas(PLANNER_TOOL_ONLY)).toEqual([
      { type: "tool_use", content: "Using run_command", toolName: "run_command", toolId: "7:0" },
    ]);
  });

  it("keeps narration and tool calls as separate deltas", () => {
    expect(transcriptLineToDeltas(PLANNER_TEXT_AND_TOOL)).toEqual([
      { type: "text", content: "I will check the files." },
      { type: "tool_use", content: "Using view_file", toolName: "view_file", toolId: "8:0" },
    ]);
  });
});

describe("transcriptLineToDeltas with ToolCardState (card preservation)", () => {
  const TOOL_ERROR = `{"step_index":9,"source":"MODEL","type":"RUN_COMMAND","status":"ERROR","content":"boom"}`;

  it("closes a RUNNING-opened card with a single tool_result (no duplicate card)", () => {
    const st = newToolCardState();
    expect(transcriptLineToDeltas(TOOL_RUNNING, st)).toEqual([
      { type: "tool_use", content: "Using run_command", toolName: "run_command" },
    ]);
    expect(st.openCards).toBe(1);
    expect(transcriptLineToDeltas(TOOL_DONE, st)).toEqual([
      { type: "tool_result", content: "run_command done", toolName: "run_command" },
    ]);
    expect(st.openCards).toBe(0);
  });

  it("closes a planner tool_calls card with a single tool_result (no duplicate card)", () => {
    const st = newToolCardState();
    transcriptLineToDeltas(PLANNER_TOOL_ONLY, st); // opens one card via tool_calls
    expect(st.openCards).toBe(1);
    expect(transcriptLineToDeltas(TOOL_DONE, st)).toEqual([
      { type: "tool_result", content: "run_command done", toolName: "run_command" },
    ]);
    expect(st.openCards).toBe(0);
  });

  it("synthesizes a full card for an orphaned DONE when no card is open", () => {
    const st = newToolCardState();
    expect(transcriptLineToDeltas(TOOL_DONE, st)).toEqual([
      { type: "tool_use", content: "Using run_command", toolName: "run_command" },
      { type: "tool_result", content: "run_command done", toolName: "run_command" },
    ]);
    expect(st.openCards).toBe(0);
  });

  it("synthesizes a failed card for an orphaned ERROR row", () => {
    expect(transcriptLineToDeltas(TOOL_ERROR, newToolCardState())).toEqual([
      { type: "tool_use", content: "Using run_command", toolName: "run_command" },
      { type: "tool_result", content: "run_command failed", toolName: "run_command" },
    ]);
  });
});

describe("isTerminalAnswerLine", () => {
  it("treats non-empty planner text without tool calls as terminal", () => {
    expect(isTerminalAnswerLine(MODEL_DONE)).toEqual({ terminal: true, content: "alpha beta gamma" });
  });

  it("does not treat planner tool-call rows as terminal", () => {
    expect(isTerminalAnswerLine(PLANNER_TOOL_ONLY)).toEqual({ terminal: false });
    expect(isTerminalAnswerLine(PLANNER_TEXT_AND_TOOL)).toEqual({ terminal: false });
  });
});

describe("ensureWorkspaceTrusted", () => {
  let dir: string;
  let settingsPath: string;
  let ws: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-trust-"));
    settingsPath = path.join(dir, "settings.json");
    ws = fs.mkdtempSync(path.join(os.tmpdir(), "agy-ws-"));
  });
  afterEach(() => {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
    try { fs.rmSync(ws, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it("creates settings.json with the realpath'd workspace when none exists", () => {
    ensureWorkspaceTrusted(ws, settingsPath);
    const data = JSON.parse(fs.readFileSync(settingsPath, "utf-8"));
    expect(data.trustedWorkspaces).toContain(fs.realpathSync(ws));
  });

  it("is idempotent — no duplicate entries on repeat calls", () => {
    ensureWorkspaceTrusted(ws, settingsPath);
    ensureWorkspaceTrusted(ws, settingsPath);
    const data = JSON.parse(fs.readFileSync(settingsPath, "utf-8"));
    const real = fs.realpathSync(ws);
    expect(data.trustedWorkspaces.filter((w: string) => w === real)).toHaveLength(1);
  });

  it("preserves pre-existing settings keys and entries", () => {
    fs.writeFileSync(settingsPath, JSON.stringify({ enableTelemetry: false, trustedWorkspaces: ["/already/here"] }));
    ensureWorkspaceTrusted(ws, settingsPath);
    const data = JSON.parse(fs.readFileSync(settingsPath, "utf-8"));
    expect(data.enableTelemetry).toBe(false);
    expect(data.trustedWorkspaces).toContain("/already/here");
    expect(data.trustedWorkspaces).toContain(fs.realpathSync(ws));
  });

  it("does not throw on a malformed existing settings file (rewrites it)", () => {
    fs.writeFileSync(settingsPath, "{ not valid json");
    expect(() => ensureWorkspaceTrusted(ws, settingsPath)).not.toThrow();
    const data = JSON.parse(fs.readFileSync(settingsPath, "utf-8"));
    expect(data.trustedWorkspaces).toContain(fs.realpathSync(ws));
  });
});
