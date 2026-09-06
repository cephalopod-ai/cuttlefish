import fs from "node:fs";
import os from "node:os";
import { execFileSync } from "node:child_process";

/**
 * UPS-A3: make `~/.cuttlefish` owner-only in each platform's own permission
 * model.
 *
 * The directory holds the gateway auth token (`gateway.json`), connector
 * secrets (`config.yaml`), the auth-device store and every session transcript.
 * Individual files are written with POSIX mode `0600`, which is the right thing
 * on Linux and macOS and *a no-op on Windows* — NTFS has no mode bits, so on
 * Windows the directory silently keeps whatever access it inherited from the
 * user profile, and the mode-based protection is protection in name only.
 *
 * Two platform models, one intent:
 *
 *  - **POSIX** — the directory itself is tightened to `0700` when it is wider.
 *    A `0755` home created by an older build is repaired at startup; it is our
 *    own directory and narrowing it cannot break anything outside Cuttlefish.
 *  - **Windows** — the ACL is *inspected and reported, never rewritten*.
 *    Rewriting an inherited ACL from a daemon is how people lose access to
 *    their own profile directory, and a wrong repair is worse than an accurate
 *    warning. The report names the `icacls` command the operator can run.
 *
 * Principals are compared by **security identifier**, never by name: the
 * built-in groups are localised (`Administrators` / `Administratoren` /
 * `Administrateurs`), so a name comparison silently passes on a non-English
 * Windows install — which is the bug upstream jinn had to fix once already.
 */

export type OwnerOnlyResult =
  | { platform: "posix"; action: "already_owner_only" | "tightened"; mode: string }
  | { platform: "posix"; action: "failed"; error: string }
  | { platform: "win32"; action: "owner_only" }
  | { platform: "win32"; action: "needs_attention"; unexpected: string[]; remedy: string }
  | { platform: "win32"; action: "unknown"; error: string };

/** Bits that must be clear for a directory to be owner-only on POSIX. */
const POSIX_GROUP_OTHER_MASK = 0o077;

export function posixNeedsTightening(mode: number): boolean {
  return (mode & POSIX_GROUP_OTHER_MASK) !== 0;
}

/**
 * SDDL principals that may legitimately hold rights on an owner-only directory.
 *
 * `SY`/`S-1-5-18` is LocalSystem and `BA`/`S-1-5-32-544` is the Administrators
 * group — both can read anything on the machine regardless of this ACL, so
 * their presence is not a finding. `OW`/`CO` describe the owner itself.
 */
const ACCEPTABLE_SDDL_PRINCIPALS = new Set([
  "SY", "S-1-5-18", // LocalSystem
  "BA", "S-1-5-32-544", // Builtin Administrators
  "OW", "S-1-3-4", // Owner Rights
  "CO", "S-1-3-0", // Creator Owner
]);

/** Human-readable names for the broad principals worth naming in a warning. */
const PRINCIPAL_LABELS: Record<string, string> = {
  WD: "Everyone",
  "S-1-1-0": "Everyone",
  AU: "Authenticated Users",
  "S-1-5-11": "Authenticated Users",
  BU: "Builtin Users",
  "S-1-5-32-545": "Builtin Users",
  IU: "Interactive Users",
  "S-1-5-4": "Interactive Users",
  AN: "Anonymous",
  "S-1-5-7": "Anonymous",
};

/**
 * Pull the trustee of every ACCESS ALLOWED ace out of an SDDL string.
 *
 * An ACE is `(type;flags;rights;object_guid;inherit_object_guid;account_sid)`,
 * so the trustee is the sixth semicolon-separated field. Only allow-aces matter:
 * a deny-ace narrows access and can never be the reason a directory is too open.
 */
export function sddlAllowedTrustees(sddl: string): string[] {
  const trustees: string[] = [];
  for (const match of sddl.matchAll(/\(([^)]*)\)/g)) {
    const fields = match[1].split(";");
    if (fields.length < 6) continue;
    const aceType = fields[0].trim().toUpperCase();
    // "A" = ACCESS_ALLOWED, "AI"/"OA" and friends still start with A; deny aces
    // start with D.
    if (!aceType.startsWith("A")) continue;
    const trustee = fields[5].trim().toUpperCase();
    if (trustee) trustees.push(trustee);
  }
  return trustees;
}

/**
 * Decide whether an SDDL descriptor describes an owner-only directory, given
 * the SID of the account Cuttlefish is running as.
 */
export function assessWindowsSddl(sddl: string, selfSid: string | undefined): { ok: boolean; unexpected: string[] } {
  const self = selfSid?.trim().toUpperCase();
  const unexpected: string[] = [];
  for (const trustee of sddlAllowedTrustees(sddl)) {
    if (self && trustee === self) continue;
    if (ACCEPTABLE_SDDL_PRINCIPALS.has(trustee)) continue;
    const label = PRINCIPAL_LABELS[trustee];
    const rendered = label ? `${label} (${trustee})` : trustee;
    if (!unexpected.includes(rendered)) unexpected.push(rendered);
  }
  return { ok: unexpected.length === 0, unexpected };
}

function powershell(command: string): string {
  return execFileSync(
    "powershell",
    ["-NoProfile", "-NonInteractive", "-Command", command],
    { encoding: "utf-8", windowsHide: true, timeout: 15_000 },
  ).trim();
}

function currentWindowsSid(): string | undefined {
  try {
    const sid = powershell("[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value");
    return /^S-1-[\d-]+$/i.test(sid) ? sid : undefined;
  } catch {
    return undefined;
  }
}

function directorySddl(dir: string): string {
  // -LiteralPath so a directory containing [ or ] is not read as a wildcard.
  return powershell(`(Get-Acl -LiteralPath ${JSON.stringify(dir)}).Sddl`);
}

/**
 * Make `dir` owner-only where that is safe to do, and report what was found.
 *
 * Never throws: a permission model that cannot be read is a warning to surface,
 * not a reason to refuse to start the gateway.
 */
export function ensureOwnerOnlyDirectory(dir: string, platform: NodeJS.Platform = os.platform()): OwnerOnlyResult {
  if (platform === "win32") {
    try {
      const assessment = assessWindowsSddl(directorySddl(dir), currentWindowsSid());
      if (assessment.ok) return { platform: "win32", action: "owner_only" };
      return {
        platform: "win32",
        action: "needs_attention",
        unexpected: assessment.unexpected,
        // Reported, never run: rewriting an inherited profile ACL from a daemon
        // is how an operator loses access to their own files.
        remedy: `icacls "${dir}" /inheritance:r /grant:r "%USERNAME%":(OI)(CI)F /t`,
      };
    } catch (err) {
      return { platform: "win32", action: "unknown", error: err instanceof Error ? err.message : String(err) };
    }
  }

  try {
    const mode = fs.statSync(dir).mode & 0o777;
    if (!posixNeedsTightening(mode)) {
      return { platform: "posix", action: "already_owner_only", mode: mode.toString(8).padStart(3, "0") };
    }
    fs.chmodSync(dir, 0o700);
    return { platform: "posix", action: "tightened", mode: mode.toString(8).padStart(3, "0") };
  } catch (err) {
    return { platform: "posix", action: "failed", error: err instanceof Error ? err.message : String(err) };
  }
}

/** One operator-facing line for a result, or null when there is nothing to say. */
export function describeOwnerOnlyResult(dir: string, result: OwnerOnlyResult): { level: "info" | "warn"; message: string } | null {
  if (result.platform === "posix") {
    if (result.action === "tightened") {
      return { level: "info", message: `Tightened ${dir} from mode ${result.mode} to 700 (it holds the gateway token, connector secrets and every transcript).` };
    }
    if (result.action === "failed") {
      return { level: "warn", message: `Could not verify permissions on ${dir}: ${result.error}. It holds the gateway token and connector secrets — check it is readable only by you.` };
    }
    return null;
  }
  if (result.action === "needs_attention") {
    return {
      level: "warn",
      message: `${dir} is readable by ${result.unexpected.join(", ")}. It holds the gateway auth token, connector secrets and every session transcript. Cuttlefish does not change Windows ACLs automatically; to restrict it run: ${result.remedy}`,
    };
  }
  if (result.action === "unknown") {
    return { level: "warn", message: `Could not read the Windows ACL on ${dir} (${result.error}); its permissions were not verified.` };
  }
  return null;
}
