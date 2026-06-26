import { test, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { instanceHomeIsPopulated } from "../create.js";

test("empty/half-built home is not considered populated", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cuttlefish-create-"));
  expect(instanceHomeIsPopulated(dir)).toBe(false);
  fs.writeFileSync(path.join(dir, "config.yaml"), "cuttlefish: {}\n");
  expect(instanceHomeIsPopulated(dir)).toBe(true);
  fs.rmSync(dir, { recursive: true, force: true });
});
