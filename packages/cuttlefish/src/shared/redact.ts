const SECRET_KEY_RE = /(token|secret|password|passwd|pwd|api[_-]?key|private[_-]?key|client[_-]?secret|signing[_-]?secret|auth)/i;

export function isSecretKey(key: string): boolean {
  return SECRET_KEY_RE.test(key);
}

export function redactJson<T>(value: T): T {
  if (Array.isArray(value)) return value.map((v) => redactJson(v)) as T;
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = isSecretKey(k) ? "[REDACTED]" : redactJson(v);
    }
    return out as T;
  }
  return value;
}

export function redactText(input: string): string {
  let s = String(input ?? "");
  s = s.replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, "[REDACTED PRIVATE KEY]");
  s = s.replace(/\b(Authorization\s*:\s*(?:Bearer|Basic)\s+)[^\s,;]+/gi, "$1[REDACTED]");
  s = s.replace(/\b([A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|API_KEY|PRIVATE_KEY|ACCESS_KEY)[A-Z0-9_]*\s*=\s*)[^\s]+/gi, "$1[REDACTED]");
  s = s.replace(/\b((?:sk|pk|rk|xox[baprs]|gh[pousr]|glpat|hf|api)[-_][A-Za-z0-9._-]{8,})\b/g, "[REDACTED]");
  s = s.replace(/\b([a-z][a-z0-9+.-]*:\/\/)([^\s/@:]+):([^\s/@]+)@/gi, "$1$2:[REDACTED]@");
  s = s.replace(/("(?:token|secret|password|api[_-]?key|private[_-]?key|client[_-]?secret|signing[_-]?secret|auth)"\s*:\s*")[^"]+(")/gi, "$1[REDACTED]$2");
  s = s.replace(/^(\s*(?!authorization\b)[\w.-]*(?:token|secret|password|passwd|pwd|api[_-]?key|private[_-]?key|client[_-]?secret|signing[_-]?secret|auth)[\w.-]*\s*:\s*)[^\n#]+/gim, "$1[REDACTED]");
  return s;
}
