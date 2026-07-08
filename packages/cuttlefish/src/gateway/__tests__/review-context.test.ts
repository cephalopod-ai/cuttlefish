import { describe, expect, it } from "vitest";
import type { CuttlefishConfig } from "../../shared/types.js";
import { buildReviewContext, REVIEW_DIFF_CHAR_BUDGET } from "../review-context.js";

// process.cwd() is a real directory; with no workspaces.roots configured,
// resolveTaskBaseCwd accepts it, so we can exercise the diff path with an
// injected producer and never touch git.
const realCwd = process.cwd();
const config = {} as CuttlefishConfig;

describe("buildReviewContext", () => {
  it("returns diff mode with a changed-file count when the producer yields a diff", () => {
    const diff = "diff --git a/foo.ts b/foo.ts\n--- a/foo.ts\n+++ b/foo.ts\n@@ -1 +1 @@\n-old\n+new\n";
    const ctx = buildReviewContext({ cwd: realCwd, config, diffProducer: () => diff });
    expect(ctx.mode).toBe("diff");
    expect(ctx.diffText).toContain("+new");
    expect(ctx.changedFiles).toBe(1);
    expect(ctx.reason).toBeUndefined();
  });

  it("truncates an oversized diff with a marker", () => {
    const huge = "diff --git a/foo b/foo\n" + "+x\n".repeat(REVIEW_DIFF_CHAR_BUDGET);
    const ctx = buildReviewContext({ cwd: realCwd, config, diffProducer: () => huge });
    expect(ctx.mode).toBe("diff");
    expect(ctx.diffText!.length).toBeLessThanOrEqual(REVIEW_DIFF_CHAR_BUDGET + 32);
    expect(ctx.diffText).toContain("...[diff truncated]...");
  });

  it("degrades to summary_only when no cwd is set", () => {
    const ctx = buildReviewContext({ cwd: undefined, config });
    expect(ctx).toEqual({ mode: "summary_only", changedFiles: 0, reason: "workspace cwd not set" });
    expect(buildReviewContext({ cwd: "  ", config }).mode).toBe("summary_only");
  });

  it("degrades to summary_only with a reason when the tree is clean (empty diff)", () => {
    const ctx = buildReviewContext({ cwd: realCwd, config, diffProducer: () => "" });
    expect(ctx.mode).toBe("summary_only");
    expect(ctx.reason).toMatch(/no changes detected/);
    expect(ctx.changedFiles).toBe(0);
  });

  it("degrades to summary_only with a reason when the producer throws (e.g. not a git repo)", () => {
    const ctx = buildReviewContext({
      cwd: realCwd,
      config,
      diffProducer: () => { throw new Error("not a git repository"); },
    });
    expect(ctx.mode).toBe("summary_only");
    expect(ctx.reason).toMatch(/diff unavailable: not a git repository/);
  });

  it("degrades to summary_only when the cwd does not exist", () => {
    const ctx = buildReviewContext({ cwd: "/no/such/dir/really", config, diffProducer: () => "diff" });
    expect(ctx.mode).toBe("summary_only");
    expect(ctx.reason).toMatch(/diff unavailable/);
  });
});
