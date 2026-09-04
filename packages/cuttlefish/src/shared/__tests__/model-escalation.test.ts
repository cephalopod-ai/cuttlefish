import { describe, it, expect } from "vitest";
import { resolveModelEscalation, rungKey, DEFAULT_MODEL_LADDER } from "../model-escalation.js";

const allAvailable = () => true;

describe("resolveModelEscalation — a rung the install cannot run is skipped", () => {
  it("falls through the pinned claude-opus-5 rung to the opus alias when only the alias is registered", () => {
    // Mirrors an upgraded install whose Claude registry still has the old
    // shipped shape: the literal `opus` id, but not the pinned `claude-opus-5`.
    // Escalating into tier 2 must not hand the CLI a --model it never
    // advertised; it should keep walking the tier to a rung that works.
    const registered = new Set(["opus", "gpt-5.5"]);
    const got = resolveModelEscalation({
      fromEngine: "claude",
      fromModel: "claude-sonnet-5",
      triedRungs: new Set([
        rungKey("claude", "claude-sonnet-5"),
        rungKey("codex", "gpt-5.5"),
      ]),
      isAvailable: (_engine, model) => registered.has(model),
    });
    expect(got).toEqual({ engine: "claude", model: "opus", via: "higher" });
  });
});

describe("resolveModelEscalation (default ladder)", () => {
  it.each([
    ["gpt-5.6-terra", "gpt-5.6-sol"],
    ["gpt-5.6-luna", "gpt-5.6-sol"],
    ["gpt-5.6-sol", "gpt-6-astra"],
  ])("escalates %s to %s", (fromModel, model) => {
    expect(resolveModelEscalation({
      fromEngine: "codex", fromModel,
      triedRungs: new Set([rungKey("codex", fromModel)]),
      isAvailable: allAvailable,
    })).toEqual({ engine: "codex", model, via: "higher" });
  });

  it("does not downgrade Astra to another Codex model when no peer provider is available", () => {
    expect(resolveModelEscalation({
      fromEngine: "codex", fromModel: "gpt-6-astra",
      triedRungs: new Set([rungKey("codex", "gpt-6-astra")]),
      isAvailable: (engine) => engine === "codex",
    })).toBeNull();
  });

  it("user example: a small model (haiku) climbs to the mid tier (Sol first)", () => {
    const got = resolveModelEscalation({
      fromEngine: "claude",
      fromModel: "claude-haiku-4-5",
      triedRungs: new Set([rungKey("claude", "claude-haiku-4-5")]),
      isAvailable: allAvailable,
    });
    expect(got).toEqual({ engine: "codex", model: "gpt-5.6-sol", via: "higher" });
  });

  it("user example: gemini-flash (small) climbs to the mid tier", () => {
    const got = resolveModelEscalation({
      fromEngine: "antigravity",
      fromModel: "gemini-3.8-flash-high",
      triedRungs: new Set([rungKey("antigravity", "gemini-3.8-flash-high")]),
      isAvailable: allAvailable,
    });
    expect(got?.via).toBe("higher");
    expect(got).toEqual({ engine: "codex", model: "gpt-5.6-sol", via: "higher" });
  });

  it("user example: sonnet (mid) climbs to the large tier (Astra first)", () => {
    const got = resolveModelEscalation({
      fromEngine: "claude",
      fromModel: "claude-sonnet-5",
      triedRungs: new Set([rungKey("claude", "claude-sonnet-5")]),
      isAvailable: allAvailable,
    });
    expect(got).toEqual({ engine: "codex", model: "gpt-6-astra", via: "higher" });
  });

  it("usage exhaustion: excluding the current engine forces a higher model on another provider", () => {
    // sonnet on claude is rate-limited → exclude claude → large tier, non-claude → Astra.
    const got = resolveModelEscalation({
      fromEngine: "claude",
      fromModel: "claude-sonnet-5",
      triedRungs: new Set([rungKey("claude", "claude-sonnet-5")]),
      excludeEngines: new Set(["claude"]),
      isAvailable: allAvailable,
    });
    expect(got).toEqual({ engine: "codex", model: "gpt-6-astra", via: "higher" });
  });

  it("usage exhaustion from a cheap codex model rolls to sonnet (codex excluded)", () => {
    const got = resolveModelEscalation({
      fromEngine: "codex",
      fromModel: "gpt-5.4-mini",
      triedRungs: new Set([rungKey("codex", "gpt-5.4-mini")]),
      excludeEngines: new Set(["codex"]),
      isAvailable: allAvailable,
    });
    // tier 1 with codex excluded → sonnet.
    expect(got).toEqual({ engine: "claude", model: "claude-sonnet-5", via: "higher" });
  });

  it("stall from gpt-5.4 (mid) climbs to Astra on the SAME engine (no exclusion)", () => {
    const got = resolveModelEscalation({
      fromEngine: "codex",
      fromModel: "gpt-5.4",
      triedRungs: new Set([rungKey("codex", "gpt-5.4"), rungKey("codex", "gpt-5.6-sol")]),
      isAvailable: allAvailable,
    });
    expect(got).toEqual({ engine: "codex", model: "gpt-6-astra", via: "higher" });
  });

  it("top tier whose engine is exhausted falls sideways to a same-tier peer (sibling)", () => {
    // opus on claude is rate-limited; nothing higher exists → sibling on another engine.
    const got = resolveModelEscalation({
      fromEngine: "claude",
      fromModel: "opus",
      triedRungs: new Set([rungKey("claude", "opus")]),
      excludeEngines: new Set(["claude"]),
      isAvailable: allAvailable,
    });
    expect(got?.via).toBe("sibling");
    expect(["codex", "antigravity"]).toContain(got?.engine);
    expect(got?.engine).not.toBe("claude");
  });

  it("returns null at the top tier when no higher/sibling engine is available", () => {
    const got = resolveModelEscalation({
      fromEngine: "codex",
      fromModel: "gpt-5.5",
      triedRungs: new Set([rungKey("codex", "gpt-5.5")]),
      // every other top-tier engine down
      isAvailable: (e) => e === "codex",
    });
    expect(got).toBeNull();
  });

  it("skips already-tried rungs so repeated escalations keep climbing", () => {
    // Already tried Sol and gpt-5.4 (mid). Next escalation from haiku should skip it and
    // take the other mid rung (sonnet) before climbing further.
    const got = resolveModelEscalation({
      fromEngine: "claude",
      fromModel: "claude-haiku-4-5",
      triedRungs: new Set([rungKey("claude", "claude-haiku-4-5"), rungKey("codex", "gpt-5.4"), rungKey("codex", "gpt-5.6-sol")]),
      isAvailable: allAvailable,
    });
    expect(got).toEqual({ engine: "claude", model: "claude-sonnet-5", via: "higher" });
  });

  it("unknown current model is treated as lowest tier and climbs into tier 1", () => {
    const got = resolveModelEscalation({
      fromEngine: "codex",
      fromModel: "some-custom-model-not-on-ladder",
      triedRungs: new Set([rungKey("codex", "some-custom-model-not-on-ladder")]),
      isAvailable: allAvailable,
    });
    expect(got?.via).toBe("higher");
    expect(got).toEqual({ engine: "codex", model: "gpt-5.6-sol", via: "higher" });
  });

  it("honors a custom ladder override", () => {
    const ladder = [
      [{ engine: "pi", model: "qwen" }],
      [{ engine: "codex", model: "gpt-x" }],
    ];
    const got = resolveModelEscalation({
      fromEngine: "pi",
      fromModel: "qwen",
      ladder,
      triedRungs: new Set([rungKey("pi", "qwen")]),
      isAvailable: allAvailable,
    });
    expect(got).toEqual({ engine: "codex", model: "gpt-x", via: "higher" });
  });

  it("sanity: the default ladder is ordered low → high", () => {
    expect(DEFAULT_MODEL_LADDER).toHaveLength(3);
    expect(DEFAULT_MODEL_LADDER[0].some((r) => r.model === "claude-haiku-4-5")).toBe(true);
    expect(DEFAULT_MODEL_LADDER[2].some((r) => r.model === "gpt-5.5")).toBe(true);
  });
});
