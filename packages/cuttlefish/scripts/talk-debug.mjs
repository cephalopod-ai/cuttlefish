#!/usr/bin/env node
/**
 * Cuttlefish Talk — headless E2E debug harness for the AURA voice orchestrator.
 *
 * Drives a REAL talk session over the gateway HTTP API exactly like the phone
 * does — no browser, no mic, no TTS — so the conversational + delegation +
 * relay-back behaviour can be exercised and scored deterministically while we
 * tune the persona (which is hot-reloaded from ~/.cuttlefish/talk/orchestrator-persona.md,
 * so edits apply to NEW turns with no rebuild/restart).
 *
 * For each scripted turn it:
 *   1. sends the utterance to the orchestrator,
 *   2. waits for the orchestrator to go idle with a fresh assistant reply,
 *   3. records who it spawned (child COO sessions = satellite orbs),
 *   4. when asked, waits for those children to finish AND for the orchestrator
 *      to wake and narrate the result back (the relay),
 *   5. scores the spoken reply for voice-friendliness (length, no markdown/URLs).
 *
 * Usage:
 *   node packages/cuttlefish/scripts/talk-debug.mjs [scenario.json] [--gateway URL] [--keep]
 *   node packages/cuttlefish/scripts/talk-debug.mjs --say "one quick line"   # single ad-hoc turn
 *
 * Output: a pretty transcript to stdout + a full JSON log next to the scenario
 * (or /tmp/talk-debug-<ts>.json) for review without re-running.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join, dirname, basename } from "node:path";

// ---- args ------------------------------------------------------------------
const argv = process.argv.slice(2);
let scenarioPath = null;
let gateway = "http://127.0.0.1:8888";
let keep = false;
let adhoc = null;
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === "--gateway") gateway = argv[++i];
  else if (a === "--keep") keep = true;
  else if (a === "--say") adhoc = argv[++i];
  else if (!a.startsWith("--")) scenarioPath = a;
}

const DEFAULT_SCENARIO = {
  fresh: true,
  turns: [
    { say: "Hey AURA, you there?", expect: "direct" },
    { say: "Give me the one-line state of the org.", expect: "direct" },
    {
      say: "Have the team do a quick health check on the demo project and report one line back.",
      expect: "delegate",
      relay: true,
      relaySec: 240,
    },
  ],
};

// ---- tiny http helpers -----------------------------------------------------
async function api(path, opts = {}) {
  const res = await fetch(`${gateway}${path}`, {
    method: opts.method || "GET",
    headers: opts.body ? { "Content-Type": "application/json" } : undefined,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const text = await res.text();
  let json;
  try { json = text ? JSON.parse(text) : null; } catch { json = { raw: text }; }
  if (!res.ok) throw new Error(`${res.status} ${path}: ${text.slice(0, 200)}`);
  return json;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getSession(id) {
  return api(`/api/sessions/${id}?last=40`);
}
async function getChildren(id) {
  try { return (await api(`/api/sessions/${id}/children`)) || []; }
  catch { return []; }
}
function assistantMsgs(session) {
  return (session.messages || []).filter((m) => m.role === "assistant");
}
function lastAssistantAfter(session, ts) {
  const a = assistantMsgs(session).filter((m) => (m.timestamp || 0) > ts);
  return a.length ? a[a.length - 1] : null;
}

// ---- voice-quality scoring -------------------------------------------------
function scoreReply(text) {
  const flags = [];
  const words = (text || "").trim().split(/\s+/).filter(Boolean).length;
  if (words > 70) flags.push(`too_long(${words}w)`);
  if (/(^|\n)\s*[-*•]\s/.test(text)) flags.push("bullet_list");
  if (/\|.*\|/.test(text)) flags.push("table");
  if (/```|`[^`]+`/.test(text)) flags.push("code/backticks");
  if (/https?:\/\//.test(text)) flags.push("url");
  if (/\*\*|##|__/.test(text)) flags.push("markdown");
  if (/\b[0-9a-f]{8}-[0-9a-f]{4}-/.test(text)) flags.push("raw_uuid");
  if (/\b(Sure|Of course|I can help|Happy to|Certainly)\b/i.test(text)) flags.push("preamble");
  if (/\b(Ready\?|Shall I|Want me to|should I|do you want me)\b/i.test(text)) flags.push("asks_permission");
  return { words, flags, voiceOk: flags.length === 0 };
}

// ---- wait primitives -------------------------------------------------------
async function waitIdleReply(id, sinceTs, timeoutMs) {
  const start = Date.now();
  let lastSeen = sinceTs;
  while (Date.now() - start < timeoutMs) {
    await sleep(2000);
    const s = await getSession(id);
    const reply = lastAssistantAfter(s, sinceTs);
    if (s.status === "idle" && reply) {
      // settle: confirm stable on a second read so we don't catch mid-stream.
      await sleep(1200);
      const s2 = await getSession(id);
      const r2 = lastAssistantAfter(s2, sinceTs);
      if (s2.status === "idle" && r2) return { reply: r2, session: s2 };
    }
    if (reply && (reply.timestamp || 0) > lastSeen) lastSeen = reply.timestamp;
  }
  return { reply: null, session: await getSession(id), timedOut: true };
}

async function waitNewChildren(id, knownIds, timeoutMs) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const kids = await getChildren(id);
    const fresh = kids.filter((k) => !knownIds.has(k.id));
    if (fresh.length) return fresh;
    await sleep(2000);
  }
  return [];
}

async function waitChildrenDone(childIds, timeoutMs) {
  const start = Date.now();
  const done = {};
  while (Date.now() - start < timeoutMs) {
    let allDone = true;
    for (const cid of childIds) {
      const s = await getSession(cid).catch(() => null);
      if (!s) { allDone = false; continue; }
      done[cid] = { status: s.status, turns: s.totalTurns };
      if (s.status !== "idle") allDone = false;
    }
    if (allDone && childIds.length) return done;
    await sleep(3000);
  }
  return done;
}

// ---- main ------------------------------------------------------------------
function loadScenario() {
  if (adhoc) return { fresh: false, turns: [{ say: adhoc, expect: "auto" }] };
  if (!scenarioPath) return DEFAULT_SCENARIO;
  return JSON.parse(readFileSync(scenarioPath, "utf-8"));
}

function line(s = "") { process.stdout.write(s + "\n"); }
function hr() { line("─".repeat(74)); }

async function main() {
  const scenario = loadScenario();
  line(`\n🎙  Cuttlefish Talk debug harness → ${gateway}`);

  const boot = await api("/api/talk/session", { method: "POST", body: { fresh: scenario.fresh !== false } });
  const orch = boot.sessionId;
  line(`   orchestrator session: ${orch}  (${boot.reused ? "reused" : "fresh"})`);

  const knownChildren = new Set((await getChildren(orch)).map((c) => c.id));
  const log = { gateway, orchestrator: orch, startedAt: new Date().toISOString(), turns: [] };

  for (let i = 0; i < scenario.turns.length; i++) {
    const turn = scenario.turns[i];
    const pre = await getSession(orch);
    const sinceTs = Date.now();
    hr();
    line(`\n👤 You: ${turn.say}`);

    await api(`/api/sessions/${orch}/message`, { method: "POST", body: { message: turn.say } });

    const { reply, timedOut } = await waitIdleReply(orch, sinceTs, turn.timeoutMs || 150000);
    const rec = { i, say: turn.say, expect: turn.expect };
    if (!reply) {
      line(`\n⚠️  AURA: <no reply — timed out / froze>`);
      rec.error = "no_reply_timeout";
      log.turns.push(rec);
      continue;
    }
    const score = scoreReply(reply.content);
    rec.reply = reply.content;
    rec.score = score;
    line(`\n🟠 AURA: ${reply.content}`);
    line(`   ↳ voice: ${score.voiceOk ? "✅ clean" : "⚠️  " + score.flags.join(", ")}  (${score.words} words)`);

    // delegation check
    const fresh = await waitNewChildren(orch, knownChildren, turn.expect === "delegate" ? 25000 : 6000);
    fresh.forEach((c) => knownChildren.add(c.id));
    rec.spawned = fresh.map((c) => ({ id: c.id, title: c.title, employee: c.employee }));
    if (fresh.length) {
      line(`   ↳ 🛰  spawned ${fresh.length} child session(s): ${fresh.map((c) => c.title || c.employee || c.id.slice(0, 8)).join(", ")}`);
    } else if (turn.expect === "delegate") {
      line(`   ↳ ❌ expected a delegation but NO child session was spawned`);
      rec.delegationMissing = true;
    }

    // relay-back: wait for children to finish, then for AURA to narrate
    if (turn.relay && fresh.length) {
      line(`   ↳ ⏳ waiting for ${fresh.length} child(ren) to finish + AURA to relay…`);
      const relaySince = Date.now();
      const childIds = fresh.map((c) => c.id);
      const childDone = await waitChildrenDone(childIds, (turn.relaySec || 240) * 1000);
      rec.childResults = childDone;
      const relay = await waitIdleReply(orch, relaySince, (turn.relaySec || 240) * 1000);
      if (relay.reply) {
        const rscore = scoreReply(relay.reply.content);
        rec.relay = relay.reply.content;
        rec.relayScore = rscore;
        line(`\n🔁 AURA relays: ${relay.reply.content}`);
        line(`   ↳ voice: ${rscore.voiceOk ? "✅ clean" : "⚠️  " + rscore.flags.join(", ")}  (${rscore.words} words)`);
      } else {
        line(`   ↳ ❌ AURA never relayed the result back (no narration turn)`);
        rec.relayMissing = true;
      }
    }
    if (timedOut) rec.replySlow = true;
    log.turns.push(rec);
  }

  // summary
  hr();
  const t = log.turns;
  const cleanReplies = t.filter((x) => x.score?.voiceOk).length;
  const delegations = t.filter((x) => (x.spawned || []).length).length;
  const missedDeleg = t.filter((x) => x.delegationMissing).length;
  const missedRelay = t.filter((x) => x.relayMissing).length;
  line(`\n📊 Summary`);
  line(`   turns: ${t.length}   voice-clean replies: ${cleanReplies}/${t.length}`);
  line(`   delegations observed: ${delegations}   missed delegations: ${missedDeleg}   missed relays: ${missedRelay}`);
  const allFlags = t.flatMap((x) => [...(x.score?.flags || []), ...(x.relayScore?.flags || [])]);
  const tally = {};
  for (const f of allFlags) { const k = f.split("(")[0]; tally[k] = (tally[k] || 0) + 1; }
  if (Object.keys(tally).length) line(`   quality flags: ${Object.entries(tally).map(([k, v]) => `${k}×${v}`).join(", ")}`);

  const outPath = scenarioPath
    ? join(dirname(scenarioPath), basename(scenarioPath).replace(/\.json$/, "") + `.result.json`)
    : `/tmp/talk-debug-${Date.now()}.json`;
  log.finishedAt = new Date().toISOString();
  log.summary = { turns: t.length, cleanReplies, delegations, missedDeleg, missedRelay, tally };
  writeFileSync(outPath, JSON.stringify(log, null, 2));
  line(`\n💾 full log: ${outPath}`);
  if (!keep && scenario.fresh !== false) line(`   (orchestrator left running: ${orch})`);
  line("");
}

main().catch((e) => { console.error("\n💥 harness error:", e.message); process.exit(1); });
