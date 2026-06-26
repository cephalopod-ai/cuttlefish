import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeEach, vi } from "vitest";
import { refreshCuttlefishPaths, setCuttlefishHomeForTest } from "../shared/paths.js";
import { safeRmSync } from "../shared/safe-delete.js";

export interface TempCuttlefishHomeHandle {
  home: () => string;
  setup: () => string;
  cleanup: () => void;
}

export function createTempCuttlefishHomeForTest(prefix = "cuttlefish-test-"): TempCuttlefishHomeHandle {
  let previousHome: string | undefined;
  let tmpHome = "";

  return {
    home: () => tmpHome,
    setup: () => {
      previousHome = process.env.CUTTLEFISH_HOME;
      tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
      setCuttlefishHomeForTest(tmpHome);
      vi.resetModules();
      return tmpHome;
    },
    cleanup: () => {
      if (previousHome === undefined) {
        delete process.env.CUTTLEFISH_HOME;
        refreshCuttlefishPaths();
      } else {
        setCuttlefishHomeForTest(previousHome);
      }
      vi.resetModules();
      safeRmSync(tmpHome, { within: os.tmpdir(), label: "temp cuttlefish home" });
      tmpHome = "";
    },
  };
}

export function withTempCuttlefishHome(prefix = "cuttlefish-test-"): { home: () => string } {
  const handle = createTempCuttlefishHomeForTest(prefix);
  beforeEach(() => {
    handle.setup();
  });
  afterEach(() => {
    handle.cleanup();
  });
  return { home: handle.home };
}

export function withStaticTempCuttlefishHome(prefix = "cuttlefish-test-"): { home: string } {
  const previousHome = process.env.CUTTLEFISH_HOME;
  const home = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  setCuttlefishHomeForTest(home);

  afterAll(() => {
    if (previousHome === undefined) {
      delete process.env.CUTTLEFISH_HOME;
      refreshCuttlefishPaths();
    } else {
      setCuttlefishHomeForTest(previousHome);
    }
    safeRmSync(home, { within: os.tmpdir(), label: "temp cuttlefish home" });
  });

  return { home };
}
