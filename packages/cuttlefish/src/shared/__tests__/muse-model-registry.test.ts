import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ModelInfo } from "../types.js";

const discovery = vi.hoisted(() => ({ discover: vi.fn() }));
vi.mock("../muse-models.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../muse-models.js")>()),
  discoverMuseModels: discovery.discover,
}));
// Every engine probe answers "installed" without spawning a CLI.
vi.mock("../resolve-bin.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../resolve-bin.js")>()),
  isInstalled: () => true,
}));

import { getModelRegistry, invalidateModelRegistry, refreshMuseModels } from "../models.js";
import type { CuttlefishConfig } from "../types.js";

const config = { engines: { default: "claude", claude: {}, codex: {}, muse: { bin: "/opt/muse" } } } as unknown as CuttlefishConfig;
const live = (id: string): { defaultModel: string; models: ModelInfo[] } => ({
  defaultModel: id,
  models: [{ id, label: id, supportsEffort: true, effortLevels: ["low"] }],
});
const museIds = () => getModelRegistry(config).muse.models.map((model) => model.id);

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  discovery.discover.mockReset();
  invalidateModelRegistry();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("Muse model catalog freshness", () => {
  it("keeps serving a live-only model after the catalog TTL while it revalidates once", async () => {
    discovery.discover.mockResolvedValueOnce(live("muse-live-1"));
    await refreshMuseModels(config);
    expect(museIds()).toContain("muse-live-1");

    let finish!: (value: ReturnType<typeof live>) => void;
    discovery.discover.mockReturnValueOnce(new Promise((resolve) => { finish = resolve; }));
    vi.setSystemTime(Date.now() + 6 * 60_000);

    // Expired: still advertised (session and employee validation read this),
    // and repeated reads start only one background discovery.
    expect(museIds()).toContain("muse-live-1");
    expect(museIds()).toContain("muse-live-1");
    expect(discovery.discover).toHaveBeenCalledTimes(2);

    finish(live("muse-live-2"));
    await vi.waitFor(() => expect(museIds()).toContain("muse-live-2"));
    expect(museIds()).not.toContain("muse-live-1");
  });

  it("does not let a slower, older discovery overwrite a newer catalog", async () => {
    let finishOld!: (value: ReturnType<typeof live>) => void;
    discovery.discover
      .mockReturnValueOnce(new Promise((resolve) => { finishOld = resolve; }))
      .mockResolvedValueOnce(live("muse-new"));
    const older = refreshMuseModels(config);
    await refreshMuseModels(config);
    finishOld(live("muse-old"));
    await older;
    expect(museIds()).toContain("muse-new");
    expect(museIds()).not.toContain("muse-old");
  });

  it("falls back to the labeled static catalog when discovery fails", async () => {
    discovery.discover.mockResolvedValueOnce(live("muse-live-1"));
    await refreshMuseModels(config);
    discovery.discover.mockRejectedValueOnce(new Error("offline"));
    await refreshMuseModels(config);
    const labels = getModelRegistry(config).muse.models.map((model) => model.label);
    expect(museIds()).not.toContain("muse-live-1");
    expect(labels.every((label) => label.includes("(fallback)"))).toBe(true);
  });
});
