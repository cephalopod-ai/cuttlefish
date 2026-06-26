#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pnpmDir = path.join(repoRoot, "node_modules", ".pnpm");

if (!fs.existsSync(pnpmDir)) {
  process.exit(0);
}

const helpers = [];
for (const entry of fs.readdirSync(pnpmDir, { withFileTypes: true })) {
  if (!entry.isDirectory() || !entry.name.startsWith("node-pty@")) continue;
  const prebuildsDir = path.join(
    pnpmDir,
    entry.name,
    "node_modules",
    "node-pty",
    "prebuilds",
  );
  if (!fs.existsSync(prebuildsDir)) continue;
  for (const prebuild of fs.readdirSync(prebuildsDir, { withFileTypes: true })) {
    if (!prebuild.isDirectory()) continue;
    const helperPath = path.join(prebuildsDir, prebuild.name, "spawn-helper");
    if (fs.existsSync(helperPath)) helpers.push(helperPath);
  }
}

for (const helperPath of helpers) {
  fs.chmodSync(helperPath, 0o755);
}
