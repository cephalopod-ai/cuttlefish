import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  assessWindowsSddl,
  describeOwnerOnlyResult,
  ensureOwnerOnlyDirectory,
  posixNeedsTightening,
  sddlAllowedTrustees,
} from "../owner-only.js";

const isWindows = os.platform() === "win32";

describe("posixNeedsTightening", () => {
  it("accepts owner-only modes and rejects anything wider", () => {
    expect(posixNeedsTightening(0o700)).toBe(false);
    expect(posixNeedsTightening(0o600)).toBe(false);
    expect(posixNeedsTightening(0o000)).toBe(false);

    expect(posixNeedsTightening(0o755)).toBe(true);
    expect(posixNeedsTightening(0o750)).toBe(true);
    expect(posixNeedsTightening(0o701)).toBe(true);
    expect(posixNeedsTightening(0o777)).toBe(true);
  });
});

describe("sddlAllowedTrustees", () => {
  it("reads the trustee out of each allow ace", () => {
    const sddl = "O:BAG:DUD:AI(A;OICIID;FA;;;S-1-5-21-1-2-3-1001)(A;OICIID;FA;;;SY)(A;OICIID;FA;;;BA)";
    expect(sddlAllowedTrustees(sddl)).toEqual(["S-1-5-21-1-2-3-1001", "SY", "BA"]);
  });

  it("ignores deny aces, which can only narrow access", () => {
    const sddl = "D:AI(D;;FA;;;WD)(A;;FA;;;SY)";
    expect(sddlAllowedTrustees(sddl)).toEqual(["SY"]);
  });

  it("ignores a malformed ace rather than guessing at it", () => {
    expect(sddlAllowedTrustees("D:AI(A;;FA)(A;OICIID;FA;;;SY)")).toEqual(["SY"]);
    expect(sddlAllowedTrustees("")).toEqual([]);
  });
});

describe("assessWindowsSddl — principals compared by SID, never by localised name", () => {
  const self = "S-1-5-21-1-2-3-1001";

  it("accepts the running account plus SYSTEM, Administrators and owner rights", () => {
    const sddl = `O:BAG:DUD:AI(A;;FA;;;${self})(A;;FA;;;SY)(A;;FA;;;BA)(A;;FA;;;OW)`;
    expect(assessWindowsSddl(sddl, self)).toEqual({ ok: true, unexpected: [] });
  });

  it("flags Everyone, Authenticated Users and Builtin Users by name and SID", () => {
    const everyone = assessWindowsSddl(`D:AI(A;;FA;;;${self})(A;;FA;;;WD)`, self);
    expect(everyone.ok).toBe(false);
    expect(everyone.unexpected).toEqual(["Everyone (WD)"]);

    const authed = assessWindowsSddl(`D:AI(A;;FA;;;S-1-5-11)`, self);
    expect(authed.unexpected).toEqual(["Authenticated Users (S-1-5-11)"]);

    const users = assessWindowsSddl(`D:AI(A;;FA;;;S-1-5-32-545)`, self);
    expect(users.unexpected).toEqual(["Builtin Users (S-1-5-32-545)"]);
  });

  it("flags another user's SID", () => {
    const other = "S-1-5-21-1-2-3-1002";
    const result = assessWindowsSddl(`D:AI(A;;FA;;;${self})(A;;FA;;;${other})`, self);
    expect(result.ok).toBe(false);
    expect(result.unexpected).toEqual([other]);
  });

  it("is case-insensitive about SIDs, since SDDL casing is not guaranteed", () => {
    expect(assessWindowsSddl(`D:AI(a;;FA;;;${self.toLowerCase()})`, self).ok).toBe(true);
  });

  it("does not silently pass when the running SID could not be determined", () => {
    const result = assessWindowsSddl(`D:AI(A;;FA;;;${self})`, undefined);
    expect(result.ok).toBe(false);
    expect(result.unexpected).toEqual([self]);
  });

  it("reports each unexpected principal once", () => {
    const result = assessWindowsSddl("D:AI(A;;FA;;;WD)(A;;0x1200a9;;;WD)", self);
    expect(result.unexpected).toEqual(["Everyone (WD)"]);
  });
});

describe.skipIf(isWindows)("ensureOwnerOnlyDirectory on POSIX", () => {
  it("tightens a world-readable directory to 700 and reports it", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cuttlefish-owner-only-"));
    fs.chmodSync(dir, 0o755);

    const result = ensureOwnerOnlyDirectory(dir);
    expect(result).toEqual({ platform: "posix", action: "tightened", mode: "755" });
    expect(fs.statSync(dir).mode & 0o777).toBe(0o700);

    const described = describeOwnerOnlyResult(dir, result);
    expect(described?.level).toBe("info");
    expect(described?.message).toContain("700");
  });

  it("leaves an already-owner-only directory alone and says nothing", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cuttlefish-owner-only-"));
    fs.chmodSync(dir, 0o700);

    const result = ensureOwnerOnlyDirectory(dir);
    expect(result).toEqual({ platform: "posix", action: "already_owner_only", mode: "700" });
    expect(describeOwnerOnlyResult(dir, result)).toBeNull();
  });

  it("reports rather than throws when the directory is not there", () => {
    const missing = path.join(os.tmpdir(), "cuttlefish-owner-only-missing-12345");
    const result = ensureOwnerOnlyDirectory(missing);
    expect(result.platform).toBe("posix");
    expect(result.action).toBe("failed");

    const described = describeOwnerOnlyResult(missing, result);
    expect(described?.level).toBe("warn");
  });
});

describe("describeOwnerOnlyResult — the Windows report names the fix, and never claims to have applied it", () => {
  it("warns with the icacls command for an over-broad ACL", () => {
    const described = describeOwnerOnlyResult("C:\\Users\\me\\.cuttlefish", {
      platform: "win32",
      action: "needs_attention",
      unexpected: ["Everyone (WD)"],
      remedy: 'icacls "C:\\Users\\me\\.cuttlefish" /inheritance:r /grant:r "%USERNAME%":(OI)(CI)F /t',
    });
    expect(described?.level).toBe("warn");
    expect(described?.message).toContain("Everyone (WD)");
    expect(described?.message).toContain("does not change Windows ACLs automatically");
    expect(described?.message).toContain("icacls");
  });

  it("says nothing when the Windows ACL is already owner-only", () => {
    expect(describeOwnerOnlyResult("C:\\x", { platform: "win32", action: "owner_only" })).toBeNull();
  });

  it("warns, rather than staying silent, when the ACL could not be read", () => {
    const described = describeOwnerOnlyResult("C:\\x", { platform: "win32", action: "unknown", error: "powershell missing" });
    expect(described?.level).toBe("warn");
    expect(described?.message).toContain("not verified");
  });
});
