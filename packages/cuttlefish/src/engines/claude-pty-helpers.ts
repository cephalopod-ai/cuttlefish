import type { IPty } from "node-pty";
import type { EngineRunOpts } from "../shared/types.js";
import { buildEngineEnv } from "../shared/engine-env.js";
import type { PtyHandle } from "./pty-lifecycle.js";
import { pasteAndSubmit } from "./claude-interactive-args.js";

/** Build the env passed to the claude PTY. */
export function buildClaudePtyEnv(proxyPort?: number): Record<string, string> {
  const env = buildEngineEnv({}, { stripPrefixes: ["CLAUDECODE", "CLAUDE_CODE_"] });
  env.CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN = "1";
  env.CLAUDE_CODE_RESUME_TOKEN_THRESHOLD = "999999999";
  // The claude CLI refuses `--dangerously-skip-permissions` when it detects it is
  // running as root/sudo, unless IS_SANDBOX=1 is set. Cuttlefish always passes that
  // flag, so in a root context (containers, CI, some cloud sandboxes) the very first
  // turn dies instantly with `read EIO` and no visible error. When we are already
  // root, opt into the sandbox acknowledgement so the engine can start; on a normal
  // non-root install this is a no-op. Respect an explicit operator override.
  if (env.IS_SANDBOX === undefined && typeof process.getuid === "function" && process.getuid() === 0) {
    env.IS_SANDBOX = "1";
  }
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
