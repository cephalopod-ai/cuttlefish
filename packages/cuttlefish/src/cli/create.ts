import fs from "node:fs";
import path from "node:path";

const RED = "\x1b[31m";
const RESET = "\x1b[0m";

export function instanceHomeIsPopulated(home: string): boolean {
  return fs.existsSync(path.join(home, "config.yaml"));
}

export async function runCreate(name: string, port?: number): Promise<void> {
  void name;
  void port;
  console.error(`${RED}Error:${RESET} Cuttlefish supports one local instance. Use "cuttlefish setup" for ~/.cuttlefish.`);
  process.exit(1);
}
