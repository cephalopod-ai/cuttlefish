import fs from "node:fs";
import path from "node:path";
import { INSTANCES_REGISTRY } from "../shared/paths.js";
import { safeWriteFile } from "../shared/safe-write.js";
import { assertSafeDestructivePath } from "../shared/safe-delete.js";
import { homeForInstance } from "../shared/instance-home.js";

export interface Instance {
  name: string;
  port: number;
  home: string;
  createdAt: string;
}

export function loadInstances(): Instance[] {
  if (!fs.existsSync(INSTANCES_REGISTRY)) return [];
  try {
    return JSON.parse(fs.readFileSync(INSTANCES_REGISTRY, "utf-8"));
  } catch {
    return [];
  }
}

export function saveInstances(instances: Instance[]): void {
  fs.mkdirSync(path.dirname(INSTANCES_REGISTRY), { recursive: true });
  safeWriteFile(INSTANCES_REGISTRY, JSON.stringify(instances, null, 2) + "\n", {
    audit: { actor: "cli", op: "instances.save" },
  });
}

export function assertSafeDestructiveHome(home: string, label = "Cuttlefish home"): string {
  return assertSafeDestructivePath(home, { label });
}

export function assertSafeManagedInstanceHome(instance: Instance): string {
  const resolved = assertSafeDestructiveHome(instance.home, `Instance "${instance.name}" home`);
  const expected = homeForInstance(instance.name);
  if (resolved !== path.resolve(expected)) {
    throw new Error(`Instance "${instance.name}" home is outside its managed path: ${resolved}`);
  }
  return resolved;
}

/** Ensure the default "cuttlefish" instance is registered. */
export function ensureDefaultInstance(): void {
  const instances = loadInstances();
  if (instances.some((i) => i.name === "cuttlefish")) return;
  instances.unshift({
    name: "cuttlefish",
    port: 8888,
    home: homeForInstance("cuttlefish"),
    createdAt: new Date().toISOString(),
  });
  saveInstances(instances);
}

export function findInstance(name: string): Instance | undefined {
  return loadInstances().find((i) => i.name === name);
}
