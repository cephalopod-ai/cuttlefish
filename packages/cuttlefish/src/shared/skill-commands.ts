import fs from "node:fs";
import { SKILLS_DIR } from "./paths.js";

/** Names of installed cuttlefish skills (directories under ~/.cuttlefish/skills).
 *  Read fresh per submitted turn — one cheap readdir, never a hot path. */
function cuttlefishSkillNames(): Set<string> {
  try {
    return new Set(
      fs
        .readdirSync(SKILLS_DIR, { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .map((e) => e.name),
    );
  } catch {
    return new Set();
  }
}

/** Decide how a user message must be fed into an engine's TUI.
 *
 *  A leading `@` (mention) or `!` (bash-mode) always gets a space prepended so
 *  the TUI treats it as literal text instead of swallowing the turn.
 *
 *  A leading `/` is space-prepended ONLY when its first token names an installed
 *  cuttlefish skill (so the model reads it and invokes the skill). Any other
 *  `/command` is passed through raw, letting engine-native commands like
 *  `/compact`, `/clear`, `/model` actually fire. */
export function neutralizeForPaste(text: string): string {
  if (/^[@!]/.test(text)) return " " + text;
  if (text.startsWith("/")) {
    const cmd = text.slice(1).split(/\s/, 1)[0];
    return cuttlefishSkillNames().has(cmd) ? " " + text : text;
  }
  return text;
}
