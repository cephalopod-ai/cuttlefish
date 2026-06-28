// In-memory ring buffer for ad-hoc on-device debugging. Filled by sprinkled
// `dlog()` calls and dumped via the "Share debug log" button in the mobile more
// menu. Cap is small so a long session doesn't hog memory.

const MAX = 500;

interface Entry {
  t: number;
  tag: string;
  msg: string;
}

const buf: Entry[] = [];

export function dlog(tag: string, msg: string): void {
  buf.push({ t: Date.now(), tag, msg });
  if (buf.length > MAX) buf.shift();
}

export function getDebugLog(): string {
  if (buf.length === 0) return "(empty)";
  const t0 = buf[0].t;
  return buf
    .map((e) => {
      const ms = String(e.t - t0).padStart(6, " ");
      return `+${ms}ms [${e.tag}] ${e.msg}`;
    })
    .join("\n");
}

export function clearDebugLog(): void {
  buf.length = 0;
}

/** Share or copy the accumulated log. iOS Safari → native Share sheet; other → clipboard. */
export async function shareDebugLog(): Promise<"shared" | "copied"> {
  const text = getDebugLog();
  const ua = `\n\n--- UA: ${navigator.userAgent}\nViewport: ${window.innerWidth}x${window.innerHeight} dpr=${window.devicePixelRatio}`;
  const payload = text + ua;
  // Prefer native share on supported browsers (mobile Safari, Android Chrome).
  // share() may reject on non-secure-context or user-cancel; fall back to clipboard.
  try {
    if (typeof navigator.share === "function") {
      await navigator.share({ title: "Cuttlefish debug log", text: payload });
      return "shared";
    }
  } catch {
    // user cancelled or share failed — fall through to clipboard
  }
  try {
    await navigator.clipboard.writeText(payload);
    return "copied";
  } catch {
    // Last resort: dump into a textarea and tell the user to copy manually
    prompt("Copy this log:", payload.slice(0, 4000));
    return "copied";
  }
}
