import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// downloadModel() shells out to `curl` via spawn(); mock it so tests control
// exactly when a "download" writes bytes and when it finishes.
vi.mock("node:child_process", () => ({
  execFile: vi.fn(),
  spawn: vi.fn(),
}));

// assertFileIntegrity() does real sha256 hashing of the (huge) model files;
// mock it so tests can drive success/failure/timing without real model bytes.
vi.mock("../../shared/file-integrity.js", () => ({
  assertFileIntegrity: vi.fn(),
  sha256File: vi.fn(),
}));

import { spawn } from "node:child_process";
import { assertFileIntegrity } from "../../shared/file-integrity.js";
import { STT_MODELS_DIR, setCuttlefishHomeForTest, refreshCuttlefishPaths } from "../../shared/paths.js";
import { downloadModel } from "../stt.js";

interface FakeCurlHandle {
  outPath: string;
  close: (code: number) => void;
  error: (err: Error) => void;
}

/** Install a fake `curl` that writes `content` bytes to the `-o` path immediately,
 * then waits for the test to call `close()`/`error()` — mirroring a real
 * in-flight download that hasn't finished yet. Defaults to non-empty content
 * so a plain `close(0)` still leaves a real file behind for `fs.renameSync()`
 * to move, matching what real curl leaves on disk. */
function mockCurl(content: Buffer = Buffer.from("stub-model-bytes")): { handles: FakeCurlHandle[] } {
  const handles: FakeCurlHandle[] = [];
  vi.mocked(spawn).mockImplementation((_bin: unknown, args: unknown) => {
    const argv = args as string[];
    const outPath = argv[argv.indexOf("-o") + 1];
    if (content.length > 0) fs.writeFileSync(outPath, content);
    const listeners: Record<string, (...a: unknown[]) => void> = {};
    const proc = {
      on(event: string, cb: (...a: unknown[]) => void) {
        listeners[event] = cb;
        return proc;
      },
    };
    handles.push({
      outPath,
      close: (code: number) => listeners.close?.(code),
      error: (err: Error) => listeners.error?.(err),
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return proc as any;
  });
  return { handles };
}

let originalHome: string | undefined;
let tmpHome: string;

beforeEach(() => {
  originalHome = process.env.CUTTLEFISH_HOME;
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "stt-download-"));
  setCuttlefishHomeForTest(tmpHome);
  vi.mocked(spawn).mockReset();
  vi.mocked(assertFileIntegrity).mockReset();
});

afterEach(() => {
  if (originalHome === undefined) {
    delete process.env.CUTTLEFISH_HOME;
    refreshCuttlefishPaths();
  } else {
    setCuttlefishHomeForTest(originalHome);
  }
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

describe("downloadModel concurrency guard", () => {
  it("claims the in-progress guard synchronously so a second call is rejected before it can start its own download", async () => {
    const { handles } = mockCurl();
    vi.mocked(assertFileIntegrity).mockResolvedValue(undefined);

    // Fired back-to-back with no `await` between them: the second call runs
    // while the first call's synchronous prefix has already claimed the
    // guard (a prior implementation set the guard flag only after an
    // `await`, so both calls could pass the `if (downloading)` check).
    const p1 = downloadModel("tiny", () => {});
    const p2 = downloadModel("tiny", () => {});

    await expect(p2).rejects.toThrow("Download already in progress");
    expect(spawn).toHaveBeenCalledTimes(1);

    handles[0].close(0);
    await p1; // first call completes normally once its own curl process closes
  });

  it("rejects a concurrent call even while the first call is still verifying an existing on-disk model file", async () => {
    // Pre-seed a same-size (sparse) local file so getModelPath() resolves it
    // and downloadModel() takes the async "verify existing file" branch —
    // this is exactly the branch where the guard flag used to be set only
    // *after* the `await verifyModelFile(...)` call.
    fs.mkdirSync(STT_MODELS_DIR, { recursive: true });
    const modelPath = path.join(STT_MODELS_DIR, "ggml-tiny.bin");
    fs.writeFileSync(modelPath, Buffer.alloc(0));
    fs.truncateSync(modelPath, 77_691_713); // MODEL_ASSETS.tiny.size — sparse, no real IO

    let releaseVerify!: () => void;
    const verifyGate = new Promise<void>((resolve) => {
      releaseVerify = resolve;
    });
    vi.mocked(assertFileIntegrity).mockImplementationOnce(async () => {
      await verifyGate; // simulate a slow-but-real async integrity check
    });
    mockCurl();

    const p1 = downloadModel("tiny", () => {});
    const p2 = downloadModel("tiny", () => {}); // arrives while p1 awaits verification

    await expect(p2).rejects.toThrow("Download already in progress");
    // Neither call has started a network download — p1 is still verifying.
    expect(spawn).not.toHaveBeenCalled();

    releaseVerify();
    await p1; // existing file "verifies" OK -> resolves via the early return
  });

  it("only one download attempt happens for two concurrent calls, and the destination is never observably partial", async () => {
    const payload = Buffer.from("whisper-model-bytes");
    const { handles } = mockCurl(Buffer.from("partial-bytes-mid-flight"));
    vi.mocked(assertFileIntegrity).mockImplementation(async (filePath: string) => {
      // Simulate curl having finished writing full content by the time
      // integrity verification runs.
      fs.writeFileSync(filePath, payload);
    });
    const destPath = path.join(STT_MODELS_DIR, "ggml-tiny.bin");

    const p1 = downloadModel("tiny", () => {});
    const p2 = downloadModel("tiny", () => {});
    await expect(p2).rejects.toThrow("Download already in progress");
    expect(spawn).toHaveBeenCalledTimes(1);

    // Mid-flight: the destination path must not exist yet — only the
    // per-invocation tmp path has (partial) content.
    expect(fs.existsSync(destPath)).toBe(false);
    expect(fs.existsSync(handles[0].outPath)).toBe(true);

    handles[0].close(0);
    await p1;

    // After completion: the destination has the full, verified content, and
    // the tmp file is gone (renamed away, not copied/left behind).
    expect(fs.readFileSync(destPath)).toEqual(payload);
    expect(fs.existsSync(handles[0].outPath)).toBe(false);
  });

  it("uses a unique per-invocation temp path (pid + random token), not a fixed shared name", async () => {
    vi.mocked(assertFileIntegrity).mockResolvedValue(undefined);
    const destPath = path.join(STT_MODELS_DIR, "ggml-tiny.bin");

    // First attempt: capture the tmp path curl was told to write to, then
    // fail it so the guard is released without leaving a completed model.
    const first = mockCurl(Buffer.alloc(0));
    let p = downloadModel("tiny", () => {});
    await Promise.resolve(); // let the sync prefix of downloadModel spawn curl
    const tmpPath1 = first.handles[0].outPath;
    first.handles[0].error(new Error("network blip"));
    await expect(p).rejects.toThrow("network blip");

    // Second attempt for the same model/destination.
    vi.mocked(spawn).mockReset();
    const second = mockCurl(Buffer.alloc(0));
    p = downloadModel("tiny", () => {});
    await Promise.resolve();
    const tmpPath2 = second.handles[0].outPath;
    second.handles[0].error(new Error("network blip again"));
    await expect(p).rejects.toThrow("network blip again");

    expect(tmpPath1).not.toEqual(tmpPath2);
    expect(tmpPath1.startsWith(`${destPath}.downloading-`)).toBe(true);
    expect(tmpPath2.startsWith(`${destPath}.downloading-`)).toBe(true);
    // pid + random token, not the old fixed ".downloading" suffix.
    expect(tmpPath1).toMatch(new RegExp(`\\.downloading-${process.pid}-[0-9a-f-]+$`));
    expect(tmpPath2).toMatch(new RegExp(`\\.downloading-${process.pid}-[0-9a-f-]+$`));
  });

  it("resets the guard after a failed download so a later call can proceed", async () => {
    const { handles } = mockCurl();
    vi.mocked(assertFileIntegrity).mockResolvedValue(undefined);

    const p1 = downloadModel("tiny", () => {});
    handles[0].error(new Error("boom"));
    await expect(p1).rejects.toThrow("boom");

    // The guard must be released in a `finally`, even on failure.
    const { handles: handles2 } = mockCurl();
    vi.mocked(assertFileIntegrity).mockResolvedValue(undefined);
    const p2 = downloadModel("tiny", () => {});
    handles2[0].close(0);
    await expect(p2).resolves.toBeUndefined();
  });
});
