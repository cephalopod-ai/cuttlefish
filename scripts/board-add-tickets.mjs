#!/usr/bin/env node
/**
 * board-add-tickets.mjs — Add tickets to a department board via the cuttlefish API.
 *
 * Usage:
 *   node scripts/board-add-tickets.mjs <department> <tickets-json-file>
 *   node scripts/board-add-tickets.mjs software-delivery tickets.json
 *
 * Or pipe JSON directly:
 *   echo '[{"id":"my-ticket","title":"...","status":"backlog"}]' \
 *     | node scripts/board-add-tickets.mjs software-delivery -
 *
 * The script:
 *   1. Reads port + apiToken from ~/.cuttlefish/gateway.json
 *   2. GETs the current board so we have all existing tickets
 *   3. Client-side merges new tickets (skips any whose id already exists)
 *   4. PUTs the FULL merged ticket list (daemon's PUT is replace-then-append-sessions)
 *   5. GETs the board again and verifies every submitted ticket id is present
 *   6. Exits 0 on success, 1 on any failure — never silently succeeds
 *
 * Why client-side merge: PUT /api/org/departments/:name/board merges incoming
 * tickets with existing session-sourced tickets only. Manual backlog tickets
 * must be sent as part of the full list or they are dropped.
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createInterface } from "node:readline";

const GATEWAY_JSON = path.join(os.homedir(), ".cuttlefish", "gateway.json");

function loadGateway() {
  if (!fs.existsSync(GATEWAY_JSON)) {
    throw new Error(`gateway.json not found at ${GATEWAY_JSON} — is cuttlefish running?`);
  }
  const info = JSON.parse(fs.readFileSync(GATEWAY_JSON, "utf-8"));
  if (!info.port || !info.apiToken) throw new Error("gateway.json missing port or apiToken");
  return info;
}

async function apiRequest(method, url, token, body) {
  const opts = {
    method,
    headers: { "Content-Type": "application/json", "Authorization": `Bearer ${token}` },
  };
  if (body !== undefined) opts.body = JSON.stringify(body);
  const res = await fetch(url, opts);
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${url} → ${res.status}: ${text}`);
  return JSON.parse(text);
}

async function readStdin() {
  return new Promise((resolve, reject) => {
    const rl = createInterface({ input: process.stdin });
    const lines = [];
    rl.on("line", (l) => lines.push(l));
    rl.on("close", () => resolve(lines.join("\n")));
    rl.on("error", reject);
  });
}

async function main() {
  const [dept, source] = process.argv.slice(2);
  if (!dept || !source) {
    console.error("Usage: board-add-tickets.mjs <department> <tickets.json|->");
    process.exit(1);
  }

  // Load incoming tickets
  let ticketsRaw;
  if (source === "-") {
    ticketsRaw = await readStdin();
  } else {
    ticketsRaw = fs.readFileSync(source, "utf-8");
  }
  const parsed = JSON.parse(ticketsRaw);
  const incoming = Array.isArray(parsed) ? parsed : parsed.tickets;
  if (!Array.isArray(incoming)) throw new Error("tickets must be a JSON array");

  const { port, apiToken } = loadGateway();
  const base = `http://localhost:${port}`;
  const boardUrl = `${base}/api/org/departments/${encodeURIComponent(dept)}/board`;

  // 1. GET current board
  let currentTickets = [];
  try {
    const board = await apiRequest("GET", boardUrl, apiToken, undefined);
    currentTickets = Array.isArray(board) ? board : (board.tickets ?? []);
    console.log(`Current board: ${currentTickets.length} ticket(s) in ${dept}`);
  } catch (err) {
    if (err.message.includes("404")) {
      console.log(`No board found for ${dept} yet — will create`);
    } else {
      throw err;
    }
  }

  // 2. Client-side merge — only add tickets whose id isn't already present
  const existingIds = new Set(currentTickets.map((t) => t.id));
  const toAdd = incoming.filter((t) => !existingIds.has(t.id));
  const skipped = incoming.filter((t) => existingIds.has(t.id));

  if (skipped.length > 0) {
    console.log(`Skipping ${skipped.length} ticket(s) already on the board:`);
    for (const t of skipped) console.log(`  = ${t.id}`);
  }
  if (toAdd.length === 0) {
    console.log("Nothing to add — all tickets already exist.");
    process.exit(0);
  }

  const mergedTickets = [...currentTickets, ...toAdd];

  // 3. PUT the full merged list
  console.log(`\nAdding ${toAdd.length} ticket(s) → PUT ${mergedTickets.length} total to ${dept}/board ...`);
  await apiRequest("PUT", boardUrl, apiToken, { tickets: mergedTickets });

  // 4. Verify — GET back and confirm every incoming id is on disk
  const after = await apiRequest("GET", boardUrl, apiToken, undefined);
  const afterTickets = Array.isArray(after) ? after : (after.tickets ?? []);
  const onDiskIds = new Set(afterTickets.map((t) => t.id));

  const missing = incoming.map((t) => t.id).filter((id) => id && !onDiskIds.has(id));
  if (missing.length > 0) {
    console.error(`\n✗ VERIFY FAILED — ${missing.length} ticket(s) not found on disk after write:`);
    for (const id of missing) console.error(`  missing: ${id}`);
    process.exit(1);
  }

  console.log(`\n✓ Verified — all ${toAdd.length} ticket(s) confirmed on disk`);
  console.log(`  Board now has ${afterTickets.length} total ticket(s) in ${dept}`);
  for (const t of toAdd) {
    console.log(`  + [${t.status ?? "backlog"}] ${t.id}  ${t.title?.slice(0, 60) ?? ""}`);
  }
}

main().catch((err) => {
  console.error("Error:", err.message);
  process.exit(1);
});
