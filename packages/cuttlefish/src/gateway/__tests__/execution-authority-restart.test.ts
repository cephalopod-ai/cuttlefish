import { fork, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const fixture = fileURLToPath(new URL("./fixtures/authority-gateway.mjs", import.meta.url));
const loader = fileURLToPath(new URL("./fixtures/authority-source-loader.mjs", import.meta.url));
type Receipt = { event: string; port?: number; payload?: { sessionId?: string; code?: string }; [key: string]: any };

function start(home: string) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("CUTTLEFISH_") && !/TOKEN|SECRET|PASSWORD|CREDENTIAL|API_KEY|AUTH_COOKIE/.test(key)));
  const child = fork(fixture, [], { execArgv: ["--import", loader], env: { ...env, CUTTLEFISH_HOME: home, CUTTLEFISH_INSTANCES_REGISTRY: path.join(home, "instances.json") }, silent: true });
  const receipts: Receipt[] = [];
  const waiters: Array<{ predicate: (receipt: Receipt) => boolean; resolve: (receipt: Receipt) => void }> = [];
  let output = "";
  child.stdout?.on("data", (data) => { output += data; }); child.stderr?.on("data", (data) => { output += data; });
  child.on("message", (receipt: Receipt) => {
    receipts.push(receipt);
    for (const waiter of [...waiters]) if (waiter.predicate(receipt)) { waiters.splice(waiters.indexOf(waiter), 1); waiter.resolve(receipt); }
  });
  const wait = (predicate: (receipt: Receipt) => boolean) => new Promise<Receipt>((resolve, reject) => {
    const found = receipts.find(predicate); if (found) { resolve(found); return; }
    const failed = (code: number | null) => { clearTimeout(deadline); reject(new Error(`Fixture exited (${code}): ${output}`)); };
    const deadline = setTimeout(() => { child.off("exit", failed); reject(new Error(`Fixture receipt deadline: ${output}`)); }, 10000);
    const waiter = { predicate, resolve: (receipt: Receipt) => { clearTimeout(deadline); child.off("exit", failed); resolve(receipt); } }; waiters.push(waiter);
    child.once("exit", failed);
  });
  const inspect = async (sessionId: string) => { const requestId = crypto.randomUUID(); child.send({ command: "inspect", sessionId, requestId }); return wait((r) => r.event === "inspection" && r.requestId === requestId); };
  return { child, wait, inspect, ready: wait((r) => r.event === "ready") };
}

async function stop(child: ChildProcess) { if (child.exitCode !== null || child.signalCode) return; const ended = new Promise<void>((resolve) => child.once("exit", () => resolve())); child.kill("SIGKILL"); await ended; }
async function request(port: number, route: string, body: unknown, method = "POST") {
  const response = await fetch(`http://127.0.0.1:${port}${route}`, { method, headers: { Authorization: "Bearer inert-operator-test-token", "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  const result = await response.json(); expect(response.ok, JSON.stringify(result)).toBe(true); return result;
}

describe("execution authority across real isolated gateway processes", () => {
  it("CUT-EA-008: a crash after invocation retains an uncertain operation and never re-arms it on resume", async () => {
    const home = mkdtempSync(path.join(os.tmpdir(), "authority-gateway-")); let gateway = start(home);
    try {
      const ready = await gateway.ready;
      const session = await request(ready.port!, "/api/sessions", { engine: "codex", model: "gpt-5.5", prompt: "CUT-EA-HOLD: authorized inert attempt with deliberately unknown completion" });
      await gateway.wait((r) => r.event === "inert:dispatch" && r.payload?.sessionId === session.id);
      const before = await gateway.inspect(session.id); expect(before.effects).toHaveLength(1); expect(before.queue.some((q: any) => q.status === "running")).toBe(true);
      await stop(gateway.child); gateway = start(home); const restarted = await gateway.ready;
      expect(restarted.recovered).toBe(1);
      const uncertain = await gateway.inspect(session.id); expect(uncertain.session.status).toBe("waiting"); expect(uncertain.queue.some((q: any) => q.status === "uncertain")).toBe(true);
      await request(restarted.port!, `/api/sessions/${session.id}/queue/resume`, {});
      const resumed = await gateway.inspect(session.id); expect(resumed.effects).toHaveLength(0); expect(resumed.queue.some((q: any) => q.status === "uncertain")).toBe(true);
    } finally { await stop(gateway.child); rmSync(home, { recursive: true, force: true }); }
  }, 20000);
  it("CUT-EA-006: authenticated grant, durable pending queue, restart, model revocation, and actual dispatch denial", async () => {
    const home = mkdtempSync(path.join(os.tmpdir(), "authority-gateway-"));
    let gateway = start(home);
    try {
      const first = await gateway.ready; const port = first.port!;
      expect(first.paths.CUTTLEFISH_HOME).toBe(home); expect(first.personalHome).toBe(path.join(home, "personal"));
      const session = await request(port, "/api/sessions", { engine: "codex", model: "gpt-5.5", prompt: "Prepare the authorized task." });
      await gateway.wait((r) => r.event === "session:completed" && r.payload?.sessionId === session.id);
      await request(port, `/api/sessions/${session.id}/queue/pause`, {});
      await request(port, `/api/sessions/${session.id}/message`, { message: "/delegate-authority approve,decide\nReview the quoted old approval; preserve it as historical evidence." });
      const before = await gateway.inspect(session.id);
      expect(before.queue.some((q: any) => q.status === "pending")).toBe(true);
      expect(before.session.transportMeta.operatorDelegation.state).toBe("active");
      await stop(gateway.child);
      gateway = start(home); const restarted = await gateway.ready;
      const recovered = await gateway.inspect(session.id);
      expect(recovered.messages.some((m: any) => m.content.includes("historical evidence"))).toBe(true);
      expect(recovered.session.transportMeta.operatorDelegation.id).toBe(before.session.transportMeta.operatorDelegation.id);
      await request(restarted.port!, `/api/sessions/${session.id}`, { model: "gpt-5.6-luna" }, "PATCH");
      await request(restarted.port!, `/api/sessions/${session.id}/queue/resume`, {});
      await gateway.wait((r) => r.event === "session:updated" && r.payload?.code === "execution_authority_denied");
      const denied = await gateway.inspect(session.id);
      expect(denied.effects).toHaveLength(0);
      expect(denied.queue.some((q: any) => q.status === "denied")).toBe(true);
      expect(denied.session.lastError).toMatch(/delegation/i);
    } finally { await stop(gateway.child); rmSync(home, { recursive: true, force: true }); }
  }, 20000);
});
