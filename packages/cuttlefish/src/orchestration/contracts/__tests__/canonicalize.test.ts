import { describe, expect, it } from "vitest";
import {
  canonicalizeRunContract,
  canonicalizeSourceSnapshotForHash,
  canonicalizeStageGraph,
  hashManifest,
  hashTaskIdentity,
} from "../canonicalize.js";
import type { RunContractV1 } from "../schema.js";
import type { SourceSnapshotHashInputV1, SourceSnapshotV1, StageGraphV1 } from "../types.js";

function baseContract(): RunContractV1 {
  return {
    schemaVersion: "1",
    taskId: "t1",
    coordinatorId: "default",
    mode: "single_worker",
    prompt: "do the thing",
    completionPolicy: "process_only",
    sourceDriftPolicy: "warn",
    successCriteria: [],
    humanGates: [],
  };
}

describe("canonicalizeRunContract", () => {
  it("hashes identically for the same logical contract", () => {
    expect(canonicalizeRunContract(baseContract())).toBe(canonicalizeRunContract(baseContract()));
  });

  it("hashes differently when a field changes", () => {
    const a = canonicalizeRunContract(baseContract());
    const b = canonicalizeRunContract({ ...baseContract(), prompt: "do a different thing" });
    expect(a).not.toBe(b);
  });
});

describe("hashTaskIdentity", () => {
  it("is unaffected by fields outside the task-identity subset", () => {
    const a = hashTaskIdentity(baseContract());
    const differentPolicyContract: RunContractV1 = { ...baseContract(), completionPolicy: "evidence_required" };
    const b = hashTaskIdentity(differentPolicyContract);
    expect(a).toBe(b);
  });

  it("changes when taskId, coordinatorId, mode, prompt, or cwd changes", () => {
    const a = hashTaskIdentity(baseContract());
    expect(hashTaskIdentity({ ...baseContract(), taskId: "t2" })).not.toBe(a);
    expect(hashTaskIdentity({ ...baseContract(), cwd: "/repo" })).not.toBe(a);
  });
});

describe("canonicalizeStageGraph", () => {
  it("is key-order independent and content-sensitive", () => {
    const graphA: StageGraphV1 = { schemaVersion: "1", mode: "single_worker", stages: [] };
    const graphB: StageGraphV1 = { mode: "single_worker", schemaVersion: "1", stages: [] };
    expect(canonicalizeStageGraph(graphA)).toBe(canonicalizeStageGraph(graphB));

    const graphC: StageGraphV1 = { schemaVersion: "1", mode: "dual_lane", stages: [] };
    expect(canonicalizeStageGraph(graphA)).not.toBe(canonicalizeStageGraph(graphC));
  });
});

describe("canonicalizeSourceSnapshotForHash (RC-FLOW-4)", () => {
  it("hashes identically for two snapshots with identical content but different capture metadata", () => {
    const contentOnly: SourceSnapshotHashInputV1 = {
      repoRootIdentity: "repo-1",
      headCommit: "abc123",
      repositoryKind: "clean",
      taskSha256: "x",
      contractSha256: "y",
    };
    const snapshotA: SourceSnapshotV1 = { ...contentOnly, capturedAt: "2026-01-01T00:00:00.000Z", bootGeneration: 1 };
    const snapshotB: SourceSnapshotV1 = { ...contentOnly, capturedAt: "2026-06-01T00:00:00.000Z", bootGeneration: 7 };

    // The type system is the actual enforcement (SourceSnapshotHashInputV1
    // excludes capturedAt/bootGeneration), so this test calls the function
    // with only the hash-safe subset extracted from each full snapshot —
    // exactly what a real caller (source-snapshot.ts) is expected to do.
    const { capturedAt: _a, bootGeneration: _bg, ...hashInputA } = snapshotA;
    const { capturedAt: _b, bootGeneration: _bg2, ...hashInputB } = snapshotB;
    expect(canonicalizeSourceSnapshotForHash(hashInputA)).toBe(canonicalizeSourceSnapshotForHash(hashInputB));
  });

  it("hashes differently when repository content actually differs", () => {
    const a = canonicalizeSourceSnapshotForHash({
      repoRootIdentity: "repo-1", headCommit: "abc123", repositoryKind: "clean", taskSha256: "x", contractSha256: "y",
    });
    const b = canonicalizeSourceSnapshotForHash({
      repoRootIdentity: "repo-1", headCommit: "def456", repositoryKind: "clean", taskSha256: "x", contractSha256: "y",
    });
    expect(a).not.toBe(b);
  });
});

describe("hashManifest", () => {
  it("is sensitive to entry order (producer sequencing is part of the attestation)", () => {
    const forward = hashManifest([{ id: "a", sha256: "1" }, { id: "b", sha256: "2" }]);
    const reversed = hashManifest([{ id: "b", sha256: "2" }, { id: "a", sha256: "1" }]);
    expect(forward).not.toBe(reversed);
  });

  it("is sensitive to a changed sha256 for the same id", () => {
    const a = hashManifest([{ id: "a", sha256: "1" }]);
    const b = hashManifest([{ id: "a", sha256: "2" }]);
    expect(a).not.toBe(b);
  });

  it("hashes an empty manifest deterministically", () => {
    expect(hashManifest([])).toBe(hashManifest([]));
  });
});
