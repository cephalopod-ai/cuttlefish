import { spawn } from "node:child_process";
import type { CuttlefishConfig } from "./types.js";
import { resolveBin } from "./resolve-bin.js";

type JsonRecord = Record<string, unknown>;

interface CodexAppServerRequest {
  method: string;
  params: unknown;
  timeoutMs?: number;
}

export async function readCodexAppServerResult(
  config: CuttlefishConfig,
  request: CodexAppServerRequest,
): Promise<JsonRecord> {
  const bin = resolveBin("codex", config.engines.codex?.bin);
  const initialize = {
    id: 1,
    method: "initialize",
    params: {
      clientInfo: { name: "cuttlefish", version: "0" },
      capabilities: { experimentalApi: true },
    },
  };
  const rpcRequest = {
    id: 2,
    method: request.method,
    params: request.params,
  };

  return new Promise((resolve, reject) => {
    const child = spawn(bin, ["app-server", "--stdio"], { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let settled = false;

    function killChild(): void {
      try { child.kill("SIGTERM"); } catch { /* already gone */ }
      const force = setTimeout(() => {
        if (child.exitCode === null) {
          try { child.kill("SIGKILL"); } catch { /* already gone */ }
        }
      }, 2_000);
      force.unref?.();
    }

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      killChild();
      reject(new Error(stderr.trim() || `Timed out waiting for Codex app-server ${request.method}`));
    }, request.timeoutMs ?? 5000);

    function settle(value: JsonRecord): void {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      killChild();
      resolve(value);
    }

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      const lines = stdout.split(/\r?\n/);
      stdout = lines.pop() ?? "";
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const msg = JSON.parse(trimmed);
          if (msg?.id !== rpcRequest.id) continue;
          if (msg.error) throw new Error(JSON.stringify(msg.error));
          if (msg.result && typeof msg.result === "object" && !Array.isArray(msg.result)) {
            settle(msg.result as JsonRecord);
          }
        } catch (err) {
          if (trimmed.startsWith("{")) {
            settled = true;
            clearTimeout(timer);
            killChild();
            reject(err instanceof Error ? err : new Error(String(err)));
            return;
          }
        }
      }
    });

    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });

    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err);
    });

    child.on("close", () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error(stderr.trim() || `Codex app-server exited before returning ${request.method}`));
    });

    child.stdin.write(`${JSON.stringify(initialize)}\n${JSON.stringify(rpcRequest)}\n`);
  });
}
