import { describe, expect, it } from "vitest";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, extname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const PKG = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const REPO = join(PKG, "..", "..");

const SCAN_PATHS = [
  join(REPO, "CHANGELOG.md"),
  join(REPO, "LICENSE"),
  join(REPO, "docs"),
  join(PKG, "template"),
  join(PKG, "src"),
  join(REPO, "packages", "web", "src"),
];

const TEXT_EXTENSIONS = new Set([
  ".css",
  ".js",
  ".json",
  ".md",
  ".mjs",
  ".ts",
  ".tsx",
  ".txt",
  ".yaml",
  ".yml",
]);

const SKIP_DIRS = new Set(["audits", "coverage", "dist", "logs", "node_modules"]);

const BLOCKED_TERMS = [
  ["hris", "to"].join(""),
  ["jim", "my"].join(""),
  ["jim", "my", "english"].join(""),
  ["prav", "ko"].join(""),
  ["move", "kit"].join(""),
  ["sql", "noir"].join(""),
  ["ho", "my"].join(""),
  ["spy", "cam"].join(""),
  ["aso", "maniac"].join(""),
  ["kiwi", "labs"].join(""),
  ["kiwi", " labs"].join(""),
  ["tucker", "@"].join(""),
  ["/", "Users", "/", "jim", "my", "english"].join(""),
];

const ALLOWED_LINE_MATCHES = [
  {
    file: "docs/UPSTREAM_DIFF_BASELINE.md",
    term: ["hris", "to"].join(""),
    includes: ["original `", "hris", "to2612/", "ji", "nn`"].join(""),
  },
];

function listTextFiles(path: string): string[] {
  if (!existsSync(path)) return [];
  const rootStat = statSync(path);
  if (rootStat.isFile()) return TEXT_EXTENSIONS.has(extname(path)) ? [path] : [];

  const out: string[] = [];
  for (const entry of readdirSync(path)) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = join(path, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      out.push(...listTextFiles(full));
    } else if (stat.isFile() && TEXT_EXTENSIONS.has(extname(entry))) {
      out.push(full);
    }
  }
  return out;
}

describe("privacy guard", () => {
  it("keeps shipped templates and public source fixtures generic", () => {
    const findings: string[] = [];

    for (const file of SCAN_PATHS.flatMap(listTextFiles)) {
      const text = readFileSync(file, "utf-8");
      const lower = text.toLowerCase();
      for (const term of BLOCKED_TERMS) {
        const index = lower.indexOf(term.toLowerCase());
        if (index === -1) continue;
        const line = text.slice(0, index).split(/\r?\n/).length;
        const relativeFile = relative(REPO, file);
        const lineText = text.split(/\r?\n/)[line - 1] ?? "";
        const allowed = ALLOWED_LINE_MATCHES.some((match) =>
          match.file === relativeFile
          && match.term === term
          && lineText.includes(match.includes),
        );
        if (!allowed) findings.push(`${relativeFile}:${line} contains "${term}"`);
      }
    }

    expect(findings).toEqual([]);
  });
});
