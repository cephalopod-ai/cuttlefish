// Constants + config contract for the settings page.
// Extracted from settings/page.tsx (audit AS-001 modularization) — no behavior change.

export const ACCENT_PRESETS = [
  { label: "Red", value: "#EF4444" },
  { label: "Orange", value: "#F97316" },
  { label: "Amber", value: "#F59E0B" },
  { label: "Yellow", value: "#EAB308" },
  { label: "Lime", value: "#84CC16" },
  { label: "Green", value: "#22C55E" },
  { label: "Emerald", value: "#10B981" },
  { label: "Cyan", value: "#06B6D4" },
  { label: "Blue", value: "#3B82F6" },
  { label: "Indigo", value: "#6366F1" },
  { label: "Violet", value: "#8B5CF6" },
  { label: "Pink", value: "#EC4899" },
]

// Whisper STT language list (curated top ~35). First language is the default.
export const WHISPER_LANGUAGES: Record<string, string> = {
  en: "English", bg: "Bulgarian", de: "German", fr: "French", es: "Spanish",
  it: "Italian", pt: "Portuguese", ru: "Russian", zh: "Chinese", ja: "Japanese",
  ko: "Korean", ar: "Arabic", hi: "Hindi", tr: "Turkish", pl: "Polish",
  nl: "Dutch", sv: "Swedish", cs: "Czech", el: "Greek", ro: "Romanian",
  uk: "Ukrainian", he: "Hebrew", da: "Danish", fi: "Finnish", hu: "Hungarian",
  no: "Norwegian", sk: "Slovak", hr: "Croatian", ca: "Catalan", th: "Thai",
  vi: "Vietnamese", id: "Indonesian", ms: "Malay", tl: "Filipino", sr: "Serbian",
  lt: "Lithuanian", lv: "Latvian", sl: "Slovenian", et: "Estonian",
}

// Config type (gateway API)
export interface Config {
  email?: {
    enabled?: boolean
    pollIntervalSeconds?: number
    inboxes?: Array<{
      id?: string
      label?: string
      address?: string
      username?: string
      password?: string
      imapHost?: string
      imapPort?: number
      useTls?: boolean
      folder?: string
      autoIngest?: boolean
      unreadOnly?: boolean
      maxMessagesPerPoll?: number
    }>
  }
  workspaces?: {
    roots?: string[]
    defaultCwd?: string
  }
  gateway?: {
    port?: number
    host?: string
    turnStallInactivityMs?: number
    turnStallCeilingMs?: number
    turnStallRetries?: number
  }
  engines?: {
    default?: string
    claude?: { bin?: string; model?: string; effortLevel?: string; maxLivePtys?: number }
    codex?: { bin?: string; model?: string; effortLevel?: string }
    antigravity?: { bin?: string; model?: string; effortLevel?: string }
    grok?: { bin?: string; model?: string; effortLevel?: string }
    pi?: { bin?: string; model?: string; effortLevel?: string }
    kiro?: { bin?: string; model?: string; effortLevel?: string; creditBudget?: number; billingAnchorDay?: number }
    ollama?: { bin?: string; model?: string }
    kilo?: { bin?: string; model?: string; effortLevel?: string }
    aider?: { bin?: string; model?: string }
  }
  modelFallback?: {
    enabled?: boolean
    defaultMode?: "auto" | "ask_user" | "never"
    globalChain?: Array<{
      engine: string
      model?: string
      effortLevel?: string
      employee?: string
      reason?: string
    }>
  }
  sessions?: {
    maxDurationMinutes?: number
    maxCostUsd?: number
    interruptOnNewMessage?: boolean
    rateLimitStrategy?: "wait" | "fallback"
    fallbackEngine?: "claude" | "codex" | "antigravity" | "grok" | "pi" | "kiro" | "ollama" | "kilo" | "aider"
  }
  connectors?: {
    slack?: {
      appToken?: string
      botToken?: string
      shareSessionInChannel?: boolean
      allowFrom?: string | string[]
      ignoreOldMessagesOnBoot?: boolean
    }
    discord?: {
      botToken?: string
      allowFrom?: string | string[]
      guildId?: string
      channelId?: string
    }
    telegram?: {
      botToken?: string
      allowFrom?: number[]
      ignoreOldMessagesOnBoot?: boolean
    }
    whatsapp?: {
      authDir?: string
      allowFrom?: string[]
    }
    web?: Record<string, never>
    instances?: Array<{
      id: string
      type: "discord" | "discord-remote" | "slack" | "whatsapp" | "telegram"
      employee?: string
      botToken?: string
      allowFrom?: string | string[]
      guildId?: string
      channelId?: string
      appToken?: string
      authDir?: string
      ignoreOldMessagesOnBoot?: boolean
      [key: string]: unknown
    }>
  }
  logging?: {
    level?: string
    stdout?: boolean
    file?: boolean
  }
  cron?: {
    defaultDelivery?: { connector?: string; channel?: string }
  }
  boardWorker?: {
    enabled?: boolean
    idleMinutes?: number
    timezone?: string
    schedule?: {
      weekday?: { start?: string; end?: string }
      weekend?: { start?: string; end?: string }
    }
    usage?: {
      minRemainingPercent?: number
    }
  }
  orchestration?: {
    enabled?: boolean
    configDir?: string
    dbPath?: string
    worktreeRoot?: string
    maxWorktrees?: number
    sameFamilyReviewerFallback?: boolean
    empiricalRouting?: boolean
  }
  portal?: {
    portalName?: string
    operatorName?: string
  }
}
