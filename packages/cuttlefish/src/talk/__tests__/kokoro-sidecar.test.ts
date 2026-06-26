import { afterEach, describe, expect, it } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";

const SIDECAR = path.resolve(__dirname, "../kokoro_sidecar.py");
const children: ChildProcess[] = [];

afterEach(() => {
  for (const child of children.splice(0)) {
    if (!child.killed) child.kill("SIGTERM");
  }
});

describe("kokoro_sidecar errors", () => {
  it("returns a stable model_missing error without exposing the model path", async () => {
    const modelDir = fs.mkdtempSync(path.join(os.tmpdir(), "cuttlefish-kokoro-empty-"));
    const port = await freePort();
    const child = spawn("python3", [SIDECAR, "--port", String(port), "--model-dir", modelDir], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    children.push(child);
    await waitForStdout(child, "KOKORO_SIDECAR_LISTENING");

    const response = await postJson(port, "/synth", { text: "hello" });

    expect(response.status).toBe(503);
    expect(JSON.parse(response.body)).toEqual({ error: "model_missing" });
    expect(response.body).not.toContain(modelDir);
  }, 10_000);

  it("fails startup with a stable stdout signal when model dir is missing", async () => {
    const missingDir = path.join(os.tmpdir(), `cuttlefish-kokoro-missing-${Date.now()}`);
    const child = spawn("python3", [SIDECAR, "--port", "0", "--model-dir", missingDir, "--warm"], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    children.push(child);

    const stdout = await collectStdoutUntilExit(child);

    expect(stdout).toContain("KOKORO_SIDECAR_MODEL_DIR_MISSING");
    expect(stdout).not.toContain(missingDir);
  }, 10_000);
});

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => {
        if (typeof address === "object" && address) resolve(address.port);
        else reject(new Error("no port allocated"));
      });
    });
  });
}

function waitForStdout(child: ChildProcess, text: string): Promise<void> {
  return new Promise((resolve, reject) => {
    let stdout = "";
    const timer = setTimeout(() => reject(new Error(`timed out waiting for ${text}; saw ${stdout}`)), 5_000);
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
      if (stdout.includes(text)) {
        clearTimeout(timer);
        resolve();
      }
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`sidecar exited before ready: ${code}; stdout=${stdout}`));
    });
  });
}

function collectStdoutUntilExit(child: ChildProcess): Promise<string> {
  return new Promise((resolve, reject) => {
    let stdout = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.on("error", reject);
    child.on("exit", () => resolve(stdout));
  });
}

function postJson(port: number, requestPath: string, body: unknown): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = http.request({
      host: "127.0.0.1",
      port,
      path: requestPath,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(payload),
      },
    }, (res) => {
      let data = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => {
        data += chunk;
      });
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body: data }));
    });
    req.on("error", reject);
    req.write(payload);
    req.end();
  });
}
