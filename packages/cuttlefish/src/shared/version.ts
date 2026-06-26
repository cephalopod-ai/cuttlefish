import fs from "node:fs";
import path from "node:path";
import yaml from "js-yaml";
import { CONFIG_PATH, TEMPLATE_DIR } from "./paths.js";

/**
 * Compare two semver strings. Returns negative if a < b, 0 if equal, positive if a > b.
 */
export function compareSemver(a: string, b: string): number {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

/** Read the package version from cuttlefish-cli's package.json. */
export function getPackageVersion(): string {
  const pkgPath = path.join(TEMPLATE_DIR, "..", "package.json");
  return JSON.parse(fs.readFileSync(pkgPath, "utf-8")).version;
}

/** Read the instance version from config.yaml. Returns "0.0.0" if not set. */
export function getInstanceVersion(): string {
  if (!fs.existsSync(CONFIG_PATH)) return "0.0.0";
  try {
    const config = yaml.load(fs.readFileSync(CONFIG_PATH, "utf-8")) as any;
    return config?.cuttlefish?.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

/**
 * List migration version directories shipped in the template that apply
 * between fromVersion (exclusive) and toVersion (inclusive).
 * Returns sorted ascending by semver.
 */
export function getPendingMigrations(fromVersion: string, toVersion: string): string[] {
  const migrationsDir = path.join(TEMPLATE_DIR, "migrations");
  if (!fs.existsSync(migrationsDir)) return [];

  return fs
    .readdirSync(migrationsDir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .filter((v) => {
      // Only include valid semver-looking directories
      if (!/^\d+\.\d+\.\d+$/.test(v)) return false;
      return compareSemver(v, fromVersion) > 0 && compareSemver(v, toVersion) <= 0;
    })
    .sort(compareSemver);
}
