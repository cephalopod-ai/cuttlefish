import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect } from "vitest";
import { withStaticTempCuttlefishHome } from "../../test-utils/cuttlefish-home.js";

// SKILLS_DIR resolves from CUTTLEFISH_HOME at module load — set it before importing.
const { home: tmp } = withStaticTempCuttlefishHome("cuttlefish-skills-traversal-");
const { copySkillToInstance } = await import("../skills.js");
const { SKILLS_DIR } = await import("../../shared/paths.js");

function makeSource(): string {
  const src = fs.mkdtempSync(path.join(os.tmpdir(), "cuttlefish-skill-src-"));
  fs.writeFileSync(path.join(src, "SKILL.md"), "# test skill\n");
  return src;
}

describe("copySkillToInstance path-traversal guard (CRC-01)", () => {
  it("refuses names that escape SKILLS_DIR", () => {
    const src = makeSource();
    const root = path.resolve(SKILLS_DIR);
    const escapeTarget = path.resolve(path.dirname(root), "evil");
    fs.rmSync(escapeTarget, { recursive: true, force: true });

    expect(() => copySkillToInstance("../evil", src)).toThrow(/outside skills directory/i);
    expect(() => copySkillToInstance("../../evil", src)).toThrow(/outside skills directory/i);
    expect(() => copySkillToInstance("/etc/evil", src)).toThrow(/outside skills directory/i);

    // Nothing was written outside the skills directory.
    expect(fs.existsSync(escapeTarget)).toBe(false);
  });

  it("still installs a well-formed skill name", () => {
    const src = makeSource();
    copySkillToInstance("good-skill", src);
    expect(fs.existsSync(path.join(SKILLS_DIR, "good-skill", "SKILL.md"))).toBe(true);
  });
});
