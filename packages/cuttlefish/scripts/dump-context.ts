/**
 * Debug helper: dump the exact context Cuttlefish constructs for the COO vs an employee.
 *
 * Run:  npx tsx scripts/dump-context.ts [employeeName]
 * Default employee: content-lead
 *
 * Emits 4 files into ~/.cuttlefish/debug-context/:
 *   coo-system-prompt.md        — what Cuttlefish PASSES via --settings appendSystemPrompt (COO/Jimbo)
 *   employee-system-prompt.md   — same, for the employee
 *   coo-CLAUDE.md               — what Claude AUTO-LOADS from cwd (~/.cuttlefish/CLAUDE.md)
 *   employee-CLAUDE.md          — identical file (both run cwd=~/.cuttlefish) — proves employees inherit the COO manual
 */
import { writeFileSync, mkdirSync, copyFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { buildContext } from "../src/sessions/context.js";
import { loadConfig } from "../src/shared/config.js";
import { scanOrg, findEmployee } from "../src/gateway/org.js";
import { resolveOrgHierarchy } from "../src/gateway/org-hierarchy.js";
import { CUTTLEFISH_HOME } from "../src/shared/paths.js";

const empName = process.argv[2] || "content-lead";
const outDir = join(CUTTLEFISH_HOME, "debug-context");
mkdirSync(outDir, { recursive: true });

const config = loadConfig();
const registry = scanOrg();
const hierarchy = resolveOrgHierarchy(registry);
const employee = findEmployee(empName, registry);
if (!employee) {
  console.error(`Employee "${empName}" not found. Available:`, [...registry.keys()].join(", "));
  process.exit(1);
}

const common = {
  source: "slack",
  channel: "C_DEBUG",
  user: "alex",
  connectors: ["slack"],
  config,
  sessionId: "DEBUG-SESSION-0000",
  hierarchy,
} as const;

// COO = no employee passed
const cooPrompt = buildContext({ ...common });
// Employee = employee passed
const empPrompt = buildContext({ ...common, employee });

const banner = (title: string, bytes: number) =>
  `<!-- ${title}\n     ${bytes} bytes / ~${Math.round(bytes / 4)} tokens\n     This is the appendSystemPrompt Cuttlefish writes into the --settings JSON and passes as: claude --settings <file>\n-->\n\n`;

writeFileSync(join(outDir, "coo-system-prompt.md"), banner("COO (Jimbo) — PASSED system prompt", cooPrompt.length) + cooPrompt);
writeFileSync(join(outDir, "employee-system-prompt.md"), banner(`${empName} — PASSED system prompt`, empPrompt.length) + empPrompt);

// CLAUDE.md is auto-loaded by Claude Code from cwd (~/.cuttlefish) — SAME file for both roles.
const claudeMd = join(CUTTLEFISH_HOME, "CLAUDE.md");
if (existsSync(claudeMd)) {
  copyFileSync(claudeMd, join(outDir, "coo-CLAUDE.md"));
  copyFileSync(claudeMd, join(outDir, "employee-CLAUDE.md"));
}

console.log(`Wrote to ${outDir}:`);
console.log(`  coo-system-prompt.md       ${cooPrompt.length} bytes (PASSED via --settings)`);
console.log(`  employee-system-prompt.md  ${empPrompt.length} bytes (PASSED via --settings)  [${empName}]`);
console.log(`  coo-CLAUDE.md / employee-CLAUDE.md  ${existsSync(claudeMd) ? "copied (identical — auto-loaded from cwd)" : "MISSING"}`);
