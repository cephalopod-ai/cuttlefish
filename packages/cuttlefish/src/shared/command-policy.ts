export type CommandPolicyAction = "allow" | "block";

export interface CommandPolicyDecision {
  action: CommandPolicyAction;
  reason?: string;
}

const DESTRUCTIVE: Array<{ re: RegExp; reason: string }> = [
  { re: /(^|[;&|]\s*)rm\s+-[A-Za-z]*r[A-Za-z]*f?\s+(?:\/|~(?:\s|$)|\$HOME(?:\s|$))/i, reason: "Refusing destructive recursive removal of a home/root path" },
  { re: /(^|[;&|]\s*)sudo\s+rm\s+-[A-Za-z]*r[A-Za-z]*f?\s+\//i, reason: "Refusing sudo destructive removal" },
  { re: /(^|[;&|]\s*)(?:mkfs|dd\s+if=.*\sof=\/dev\/|diskutil\s+erase)/i, reason: "Refusing disk-destructive command" },
];

const SECRET_PATH = /(?:~\/\.ssh|\$HOME\/\.ssh|\.ssh\/id_[a-z0-9]+|~\/\.cuttlefish\/secrets|\$HOME\/\.cuttlefish\/secrets|\.env(?:\.[\w.-]+)?|auth\.json)/i;
const EXFIL = /\b(?:curl|wget|nc|ncat|netcat|scp|rsync|ftp|sftp|python\s+-m\s+http\.server)\b/i;

export function evaluateCommandPolicy(command: string): CommandPolicyDecision {
  const text = String(command ?? "").trim();
  if (!text) return { action: "allow" };
  for (const rule of DESTRUCTIVE) {
    if (rule.re.test(text)) return { action: "block", reason: rule.reason };
  }
  if (SECRET_PATH.test(text) && EXFIL.test(text)) {
    return { action: "block", reason: "Refusing command that appears to exfiltrate secret files" };
  }
  return { action: "allow" };
}
