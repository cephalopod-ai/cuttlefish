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
  return path.join(os.homedir(), ".cuttlefish");
}
