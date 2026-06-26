import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";
import yaml from "js-yaml";
import {
  CUTTLEFISH_HOME,
  CONFIG_PATH,
  MIGRATIONS_DIR,
  TEMPLATE_DIR,
  SKILLS_DIR,
  CLAUDE_SKILLS_DIR,
  AGENTS_SKILLS_DIR,
} from "../shared/paths.js";
import { loadConfig } from "../shared/config.js";
import { safeWriteYaml } from "../shared/safe-write.js";
import { safeRmSync } from "../shared/safe-delete.js";
import {
  compareSemver,
  getPackageVersion,
  getInstanceVersion,
  getPendingMigrations,
} from "../shared/version.js";
import { CLAUDE_BYPASS_PERMISSIONS_CONSENT_SETTINGS } from "../shared/claude-settings.js";

const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const RED = "\x1b[31m";
const DIM = "\x1b[2m";
const RESET = "\x1b[0m";

/**
 * Recursively copy a directory tree, overwriting existing files.
 * Used to stage migration files into the instance home.
 */
function copyDirRecursive(src: string, dest: string): void {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDirRecursive(srcPath, destPath);
    } else if (entry.name !== ".gitkeep") {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

/**
 * Ensure symlinks exist for a skill directory in .claude/skills/ and .agents/skills/.
 */
function ensureSkillSymlinks(skillName: string): void {
  const relTarget = path.join("..", "..", "skills", skillName);
  for (const targetDir of [CLAUDE_SKILLS_DIR, AGENTS_SKILLS_DIR]) {
    fs.mkdirSync(targetDir, { recursive: true });
    const linkPath = path.join(targetDir, skillName);
    if (!fs.existsSync(linkPath)) {
      try {
        fs.symlinkSync(relTarget, linkPath);
      } catch {
        // ignore — may fail on some platforms
      }
    }
  }
}

/**
 * Stamp the cuttlefish.version field in config.yaml.
 */
function stampVersion(version: string): void {
  const raw = fs.readFileSync(CONFIG_PATH, "utf-8");
  const config = yaml.load(raw) as any;

  if (!config.cuttlefish) config.cuttlefish = {};
  config.cuttlefish.version = version;

  // Atomic + fsync (live gateway hot-reloads config.yaml; a partial write corrupts it).
  safeWriteYaml(CONFIG_PATH, config, { dumpOptions: { lineWidth: -1 } });
}

/**
 * Build engine-specific CLI args for running a one-shot migration prompt.
 * Each engine CLI uses different flags for prompt input.
 */
function writeClaudeMigrateSettings(): { settingsPath: string; tempDir: string } {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cuttlefish-claude-migrate-"));
  const settingsPath = path.join(tempDir, "settings.json");
  // safeWrite EXCEPTION (intentional): throwaway file in a fresh mkdtemp, read
  // once by the spawned CLI then discarded. Atomicity/fsync add nothing here, so
  // this stays a plain write.
  fs.writeFileSync(settingsPath, JSON.stringify(CLAUDE_BYPASS_PERMISSIONS_CONSENT_SETTINGS, null, 2), { mode: 0o600 });
  return { settingsPath, tempDir };
}

function buildMigrateArgs(engine: string, prompt: string, model?: string, claudeSettingsPath?: string): string[] {
  switch (engine) {
    case "kilo":
      return [
        "run",
        "--auto",
        "--dangerously-skip-permissions",
        ...(model ? ["--model", model] : []),
        prompt,
      ];
    case "ollama":
      return ["run", model || "gemma4", prompt];
    case "codex":
      // `codex exec` is Codex's own non-interactive mode (not a claude `-p`).
      return ["exec", "--dangerously-bypass-approvals-and-sandbox", "--skip-git-repo-check", prompt];
    case "grok":
      return ["--no-auto-update", "--always-approve", "-p", prompt];
    case "claude":
    default:
      // No `-p`: launch the interactive claude TUI (cc_entrypoint=cli, subsidy-safe)
      // instead of the headless Agent-SDK `--print` pool. `cuttlefish migrate` is an
      // operator-run, supervised one-shot launched from a real terminal, so the
      // inherited TTY (stdio: "inherit") renders the TUI and the operator watches
      // the migration apply. Trade-off vs `-p`: the TUI does not self-exit after
      // the turn — the operator closes it (e.g. /exit) once the migration looks
      // complete. Acceptable for a rare maintenance command, and it keeps the
      // call fully subsidy-safe with no trace of `-p`.
      return [
        "--dangerously-skip-permissions",
        ...(claudeSettingsPath ? ["--settings", claudeSettingsPath] : []),
        prompt,
      ];
  }
}

export async function runMigrate(opts: { check?: boolean; auto?: boolean }): Promise<void> {
  // Ensure instance exists
  if (!fs.existsSync(CUTTLEFISH_HOME)) {
    console.error(`${RED}Error:${RESET} ${CUTTLEFISH_HOME} does not exist. Run "cuttlefish setup" first.`);
    process.exit(1);
  }

  const packageVersion = getPackageVersion();
  const instanceVersion = getInstanceVersion();

  console.log(`\n${DIM}Instance version:${RESET} ${instanceVersion}`);
  console.log(`${DIM}Package version:${RESET}  ${packageVersion}\n`);

  // Already up to date
  if (compareSemver(instanceVersion, packageVersion) >= 0) {
    console.log(`${GREEN}Up to date.${RESET} No migrations needed.\n`);
    return;
  }

  // Find pending migrations
  const pending = getPendingMigrations(instanceVersion, packageVersion);

  if (pending.length === 0) {
    console.log(`${YELLOW}No migration scripts found${RESET} for ${instanceVersion} → ${packageVersion}.`);

    if (!opts.check) {
      console.log(`Updating version stamp to ${packageVersion}...`);
      stampVersion(packageVersion);
      console.log(`${GREEN}Done.${RESET}\n`);
    }
    return;
  }

  // List pending migrations
  console.log(`${YELLOW}Pending migrations:${RESET}`);
  for (const v of pending) {
    const migrationMd = path.join(TEMPLATE_DIR, "migrations", v, "MIGRATION.md");
    const hasMd = fs.existsSync(migrationMd);
    console.log(`  ${v} ${hasMd ? "" : `${RED}(missing MIGRATION.md)${RESET}`}`);
  }
  console.log("");

  // --check: just show what's pending, don't apply
  if (opts.check) {
    console.log(`Run ${DIM}cuttlefish migrate${RESET} to apply.\n`);
    return;
  }

  // Stage migration files into ~/.cuttlefish/migrations/
  console.log("Staging migration files...");
  fs.mkdirSync(MIGRATIONS_DIR, { recursive: true });

  for (const version of pending) {
    const src = path.join(TEMPLATE_DIR, "migrations", version);
    const dest = path.join(MIGRATIONS_DIR, version);
    copyDirRecursive(src, dest);
    console.log(`  ${GREEN}[staged]${RESET} ${version}`);
  }

  // Also ensure the migrate skill is available in the instance
  const migrateSkillSrc = path.join(TEMPLATE_DIR, "skills", "migrate");
  const migrateSkillDest = path.join(SKILLS_DIR, "migrate");
  if (fs.existsSync(migrateSkillSrc) && !fs.existsSync(migrateSkillDest)) {
    copyDirRecursive(migrateSkillSrc, migrateSkillDest);
    ensureSkillSymlinks("migrate");
    console.log(`  ${GREEN}[staged]${RESET} migrate skill`);
  }

  // --auto: apply safe changes deterministically without launching AI
  if (opts.auto) {
    console.log("\nApplying safe changes automatically...");
    await applyAutoMigrations(pending, instanceVersion, packageVersion);
    return;
  }

  // Launch AI session to apply migrations
  console.log(`\nLaunching AI to apply ${pending.length} migration(s)...\n`);

  const config = loadConfig();
  const defaultEngine = config.engines.default ?? "claude";
  const engineConfig = config.engines[defaultEngine] ?? config.engines.claude;
  const claudeMigrateSettings = defaultEngine === "claude" ? writeClaudeMigrateSettings() : undefined;

  try {
    const prompt = [
      `Apply all pending migrations in ${MIGRATIONS_DIR}.`,
      `Follow the migrate skill instructions at ${path.join(SKILLS_DIR, "migrate", "SKILL.md")}.`,
      `Current instance version: ${instanceVersion}`,
      `Target version: ${packageVersion}`,
      `Pending versions: ${pending.join(", ")}`,
      ``,
      `For each version in order, read its MIGRATION.md and apply the changes.`,
      `After all migrations, update cuttlefish.version in config.yaml to "${packageVersion}".`,
      `Clean up the migrations/ directory when done.`,
    ].join("\n");

    const args = buildMigrateArgs(defaultEngine, prompt, engineConfig.model, claudeMigrateSettings?.settingsPath);
    // `bin` may be absent for engines with optional config (e.g. antigravity);
    // fall back to the engine name so spawn resolves via PATH (or fails clearly).
    // Note: antigravity (`agy`) has no headless mode, so migrate is unsupported there.
    const migrateBin = engineConfig.bin ?? defaultEngine;
    console.log(`${DIM}Engine: ${defaultEngine} (${migrateBin})${RESET}\n`);

    execFileSync(migrateBin, args, {
      stdio: "inherit",
      cwd: CUTTLEFISH_HOME,
    });

    console.log(`\n${GREEN}Migration complete.${RESET}\n`);
  } catch (err: any) {
    console.error(`\n${RED}Migration failed.${RESET} You can retry with: cuttlefish migrate`);
    console.error(`The staged files are still in ${MIGRATIONS_DIR}\n`);
    process.exit(1);
  } finally {
    if (claudeMigrateSettings) {
      safeRmSync(claudeMigrateSettings.tempDir, { within: os.tmpdir(), label: "claude migrate temp dir" });
    }
  }
}

/**
 * Auto-migration: deterministically apply safe changes without AI.
 * Copies new files, adds new config keys. Does NOT modify user-customized files.
 */
async function applyAutoMigrations(
  pending: string[],
  instanceVersion: string,
  packageVersion: string,
): Promise<void> {
  let applied = 0;

  for (const version of pending) {
    const migrationDir = path.join(MIGRATIONS_DIR, version);
    const filesDir = path.join(migrationDir, "files");

    if (!fs.existsSync(filesDir)) {
      console.log(`  ${DIM}${version}: no files to auto-apply${RESET}`);
      continue;
    }

    // Copy new files (skip files that already exist)
    const newFiles = collectFiles(filesDir, filesDir);
    for (const relPath of newFiles) {
      const destPath = path.join(CUTTLEFISH_HOME, relPath);
      if (!fs.existsSync(destPath)) {
        fs.mkdirSync(path.dirname(destPath), { recursive: true });
        fs.copyFileSync(path.join(filesDir, relPath), destPath);
        console.log(`  ${GREEN}[new]${RESET} ${relPath}`);
        applied++;

        // If it's a skill, create symlinks
        const parts = relPath.split(path.sep);
        if (parts[0] === "skills" && parts.length >= 2) {
          ensureSkillSymlinks(parts[1]);
        }
      } else {
        console.log(`  ${YELLOW}[skip]${RESET} ${relPath} (exists — needs AI merge)`);
      }
    }
  }

  // Stamp version
  stampVersion(packageVersion);
  console.log(`\n  ${GREEN}[version]${RESET} ${instanceVersion} → ${packageVersion}`);
  console.log(`\n${GREEN}Auto-migration complete.${RESET} ${applied} file(s) added.`);

  // Clean up
  safeRmSync(MIGRATIONS_DIR, { within: CUTTLEFISH_HOME, label: "migrations dir" });

  console.log(`\n${DIM}Tip: Run ${RESET}cuttlefish migrate${DIM} (without --auto) to also merge updated files with AI.${RESET}\n`);
}

/** Recursively collect relative file paths under a directory. */
function collectFiles(baseDir: string, currentDir: string): string[] {
  const files: string[] = [];
  for (const entry of fs.readdirSync(currentDir, { withFileTypes: true })) {
    const fullPath = path.join(currentDir, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectFiles(baseDir, fullPath));
    } else if (entry.name !== ".gitkeep") {
      files.push(path.relative(baseDir, fullPath));
    }
  }
  return files;
}
