import type { IPty } from "node-pty";
import type { EngineRunOpts } from "../shared/types.js";
import type { PtyHandle } from "./pty-lifecycle.js";
import { pasteAndSubmit } from "./claude-interactive-args.js";

/** Build the env passed to the claude PTY. */
export function buildClaudePtyEnv(proxyPort?: number): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (k === "CLAUDECODE" || k.startsWith("CLAUDE_CODE_")) continue;
    // Ensure the child resolves to subscription auth, not metered API billing.
    if (k === "ANTHROPIC_API_KEY" || k === "ANTHROPIC_AUTH_TOKEN") continue;
    if (v !== undefined) env[k] = v;
  }
  env.CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN = "1";
  env.CLAUDE_CODE_RESUME_TOKEN_THRESHOLD = "999999999";
  if (proxyPort) env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${proxyPort}`;
  return env;
}

/** Inject a follow-up prompt into a warm PTY via bracketed-paste + CR. */
export function injectPrompt(handle: PtyHandle, opts: EngineRunOpts): void {
  const proc = (handle as any)._proc as IPty | undefined;
  if (!proc) return;
  let text = opts.prompt;
  if (opts.attachments?.length) {
    text += "\n\nAttached files:\n" + opts.attachments.map((a) => `- ${a}`).join("\n");
  }
  pasteAndSubmit(proc, text);
}
