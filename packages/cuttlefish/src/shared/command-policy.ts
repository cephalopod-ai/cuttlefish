import type { SecurityReviewTrigger } from "./types.js";

export type CommandPolicyAction = "allow" | "review" | "block";

export interface CommandPolicyDecision {
  action: CommandPolicyAction;
  reason?: string;
  triggers?: SecurityReviewTrigger[];
}

const DESTRUCTIVE: Array<{ re: RegExp; reason: string }> = [
  { re: /(^|[;&|]\s*)rm\s+-[A-Za-z]*r[A-Za-z]*f?\s+(?:\/|~(?:\s|$)|\$HOME(?:\s|$))/i, reason: "Refusing destructive recursive removal of a home/root path" },
  { re: /(^|[;&|]\s*)sudo\s+rm\s+-[A-Za-z]*r[A-Za-z]*f?\s+\//i, reason: "Refusing sudo destructive removal" },
  { re: /(^|[;&|]\s*)(?:mkfs|dd\s+if=.*\sof=\/dev\/|diskutil\s+erase)/i, reason: "Refusing disk-destructive command" },
];

const SECRET_PATH = /(?:~\/\.ssh|\$HOME\/\.ssh|\.ssh\/id_[a-z0-9]+|~\/\.cuttlefish\/secrets|\$HOME\/\.cuttlefish\/secrets|\.env(?:\.[\w.-]+)?|auth\.json)/i;
const EXFIL = /\b(?:curl|wget|nc|ncat|netcat|scp|rsync|ftp|sftp|python\s+-m\s+http\.server)\b/i;
const PRIVILEGED = /\b(?:sudo|su|doas)\b/i;
const DESTRUCTIVE_REVIEW = /\b(?:rm\s+-[A-Za-z]*r|git\s+reset\s+--hard|git\s+clean\s+-[A-Za-z]*f|chmod\s+-[A-Za-z]*R|chown\s+-[A-Za-z]*R)\b/i;
const SECRET_READ = /\b(?:cat|less|more|head|tail|grep|sed|awk|env|printenv)\b/i;
const REMOTE_EXEC = /\b(?:curl|wget)\b[\s\S]{0,120}\|\s*(?:bash|sh|zsh)\b|\bbash\s+<\(\s*(?:curl|wget)\b/i;

export function evaluateCommandPolicy(command: string): CommandPolicyDecision {
  const text = String(command ?? "").trim();
  if (!text) return { action: "allow" };
  for (const rule of DESTRUCTIVE) {
    if (rule.re.test(text)) return { action: "block", reason: rule.reason };
  }
  if (SECRET_PATH.test(text) && EXFIL.test(text)) {
    return { action: "block", reason: "Refusing command that appears to exfiltrate secret files" };
  }
  const triggers = new Set<SecurityReviewTrigger>();
  if (DESTRUCTIVE_REVIEW.test(text)) triggers.add("destructive_shell");
  if (PRIVILEGED.test(text)) triggers.add("privileged_shell");
  if (SECRET_PATH.test(text) && SECRET_READ.test(text)) triggers.add("secret_access");
  if (EXFIL.test(text)) triggers.add("external_network");
  if (REMOTE_EXEC.test(text)) triggers.add("prompt_injection_risk");
  if (triggers.size > 0) {
    return {
      action: "review",
      reason: "Security review required before executing this Bash command",
      triggers: [...triggers],
    };
  }
  return { action: "allow" };
}
