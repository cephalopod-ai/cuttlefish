import fs from "node:fs";
import path from "node:path";
import { LOGS_DIR } from "./paths.js";
import { redactText } from "./redact.js";

const LEVELS = { debug: 0, info: 1, warn: 2, error: 3 } as const;
type LogLevel = keyof typeof LEVELS;

let minLevel: LogLevel = "info";
let writeToStdout = true;
let logStream: fs.WriteStream | null = null;

export function configureLogger(opts: {
  level?: string;
  stdout?: boolean;
  file?: boolean;
}) {
  if (opts.level && opts.level in LEVELS) minLevel = opts.level as LogLevel;
  if (opts.stdout !== undefined) writeToStdout = opts.stdout;
  if (opts.file !== false) {
    fs.mkdirSync(LOGS_DIR, { recursive: true });
    logStream = fs.createWriteStream(path.join(LOGS_DIR, "gateway.log"), {
      flags: "a",
    });
  }
}

function log(level: LogLevel, message: string) {
  if (LEVELS[level] < LEVELS[minLevel]) return;
  const safeMessage = redactText(message);
  const line = `${new Date().toISOString()} [${level.toUpperCase()}] ${safeMessage}`;
  if (writeToStdout) console.log(line);
  if (logStream) logStream.write(line + "\n");
}

export const logger = {
  debug: (msg: string) => log("debug", msg),
  info: (msg: string) => log("info", msg),
  warn: (msg: string) => log("warn", msg),
  error: (msg: string) => log("error", msg),
};
