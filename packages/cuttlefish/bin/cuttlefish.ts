#!/usr/bin/env node
import { Command } from "commander";
import pkg from "../package.json" with { type: "json" };
import { CANONICAL_INSTANCE_NAME, homeForInstance } from "../src/shared/instance-home.js";

const program = new Command();

function parsePortArg(value: string): number {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("port must be an integer from 1 to 65535");
  }
  return port;
}

program
  .name("cuttlefish")
  .description("Lightweight AI gateway daemon")
  .version(pkg.version)
  .option("-i, --instance <name>", "Target the canonical instance (must be cuttlefish)");

// Pre-parse to set CUTTLEFISH_HOME before any module imports resolve paths
program.hook("preAction", (thisCommand) => {
  const opts = thisCommand.opts();
  if (process.env.CUTTLEFISH_INSTANCE && process.env.CUTTLEFISH_INSTANCE !== CANONICAL_INSTANCE_NAME) {
    console.error(`Error: Cuttlefish supports one local instance named "${CANONICAL_INSTANCE_NAME}".`);
    process.exit(1);
  }
  if (opts.instance) {
    if (opts.instance !== CANONICAL_INSTANCE_NAME) {
      console.error(`Error: Cuttlefish supports one local instance named "${CANONICAL_INSTANCE_NAME}".`);
      process.exit(1);
    }
    process.env.CUTTLEFISH_INSTANCE = opts.instance;
    process.env.CUTTLEFISH_HOME = homeForInstance(opts.instance);
  }
});

program
  .command("setup")
  .description("Initialize Cuttlefish and install dependencies")
  .option("--force", "Delete existing home dir and reinitialize from scratch")
  .action(async (opts) => {
    const { runSetup } = await import("../src/cli/setup.js");
    await runSetup(opts);
  });

program
  .command("start")
  .description("Start the gateway daemon")
  .option("--daemon", "Run in background")
  .option("-p, --port <port>", "Override the gateway port from config")
  .action(async (opts) => {
    const { runStart } = await import("../src/cli/start.js");
    await runStart({ daemon: opts.daemon, port: opts.port ? parsePortArg(opts.port) : undefined });
  });

program
  .command("stop")
  .description("Stop the gateway daemon")
  .option("-p, --port <port>", "Port to kill the process on (default: from config or 8888)")
  .action(async (opts: { port?: string }) => {
    const { runStop } = await import("../src/cli/stop.js");
    await runStop(opts.port ? parsePortArg(opts.port) : undefined);
  });

program
  .command("restart")
  .description("Restart the gateway (detached — safe to run from inside a session)")
  .action(async () => {
    const { runRestart } = await import("../src/cli/restart.js");
    await runRestart();
  });

program
  .command("status")
  .description("Show gateway status")
  .action(async () => {
    const { runStatus } = await import("../src/cli/status.js");
    await runStatus();
  });

program
  .command("pair")
  .description("Create a one-time code for pairing another browser")
  .option("--json", "Print raw JSON")
  .action(async (opts: { json?: boolean }) => {
    const { runPair } = await import("../src/cli/pair.js");
    await runPair(opts);
  });

program
  .command("unpair [deviceId]")
  .description("List paired browsers or unpair one by id")
  .option("--json", "Print raw JSON")
  .action(async (deviceId: string | undefined, opts: { json?: boolean }) => {
    const { runUnpair } = await import("../src/cli/pair.js");
    await runUnpair(deviceId, opts);
  });

program
  .command("limits")
  .description("Show engine rate limits, quota windows, and model capabilities")
  .option("-e, --engine <name>", "Only show one engine")
  .option("--json", "Print raw JSON")
  .action(async (opts: { engine?: string; json?: boolean }) => {
    const { runLimits } = await import("../src/cli/limits.js");
    await runLimits(opts);
  });

program
  .command("create <name>")
  .description("Disabled: Cuttlefish supports one local instance")
  .option("-p, --port <port>", "Set gateway port (auto-assigned if omitted)")
  .action(async (name: string, opts: { port?: string }) => {
    const { runCreate } = await import("../src/cli/create.js");
    await runCreate(name, opts.port ? parsePortArg(opts.port) : undefined);
  });

program
  .command("list")
  .description("Show the canonical Cuttlefish instance")
  .action(async () => {
    const { runList } = await import("../src/cli/list.js");
    await runList();
  });

program
  .command("remove <name>")
  .description("Legacy cleanup for non-canonical registry entries")
  .option("--force", "Also delete the instance home directory")
  .action(async (name: string, opts: { force?: boolean }) => {
    const { runRemove } = await import("../src/cli/remove.js");
    await runRemove(name, opts);
  });

program
  .command("nuke [name]")
  .description("Legacy cleanup for non-canonical registry entries")
  .action(async (name?: string) => {
    const { runNuke } = await import("../src/cli/nuke.js");
    await runNuke(name);
  });

program
  .command("migrate")
  .description("Apply pending template migrations to update this instance")
  .option("--check", "Only check for pending migrations, don't apply")
  .option("--auto", "Apply safe changes automatically without launching AI")
  .action(async (opts) => {
    const { runMigrate } = await import("../src/cli/migrate.js");
    await runMigrate(opts);
  });

// Skills subcommands (cuttlefish skills find|add|remove|list|update|restore)
{
  const skillsCmd = program
    .command("skills")
    .description("Manage skills from the skills.sh registry");

  skillsCmd
    .command("find [query]")
    .description("Search the skills.sh registry")
    .action(async (query?: string) => {
      const { skillsFind } = await import("../src/cli/skills.js");
      skillsFind(query);
    });

  skillsCmd
    .command("add <package>")
    .description("Install a skill from skills.sh")
    .action(async (pkg: string) => {
      const { skillsAdd } = await import("../src/cli/skills.js");
      skillsAdd(pkg);
    });

  skillsCmd
    .command("remove <name>")
    .description("Remove a skill from this instance")
    .action(async (name: string) => {
      const { skillsRemove } = await import("../src/cli/skills.js");
      skillsRemove(name);
    });

  skillsCmd
    .command("list")
    .description("List installed skills")
    .action(async () => {
      const { skillsList } = await import("../src/cli/skills.js");
      skillsList();
    });

  skillsCmd
    .command("update")
    .description("Re-install all skills to get latest versions")
    .action(async () => {
      const { skillsUpdate } = await import("../src/cli/skills.js");
      skillsUpdate();
    });

  skillsCmd
    .command("restore")
    .description("Install all skills listed in skills.json")
    .action(async () => {
      const { skillsRestore } = await import("../src/cli/skills.js");
      skillsRestore();
    });
}

program.parse();
