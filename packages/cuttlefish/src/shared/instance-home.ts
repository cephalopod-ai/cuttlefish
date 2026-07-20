import os from "node:os";
import path from "node:path";

export const CANONICAL_INSTANCE_NAME = "cuttlefish";

export function assertCanonicalInstanceName(name: string): void {
  if (name !== CANONICAL_INSTANCE_NAME) {
    throw new Error("Cuttlefish supports one local instance named \"cuttlefish\".");
  }
}

export function homeForInstance(name: string): string {
  assertCanonicalInstanceName(name);
  // `list` and the legacy instance registry must describe the same home as the
  // daemon lifecycle. A custom CUTTLEFISH_HOME is the supported disposable-home
  // and multi-checkout workflow, so never quietly fall back to ~/.cuttlefish.
  if (process.env.CUTTLEFISH_HOME) return process.env.CUTTLEFISH_HOME;
  return path.join(os.homedir(), ".cuttlefish");
}
