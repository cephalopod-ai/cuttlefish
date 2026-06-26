/**
 * Curated pool of visually distinct emojis for employee avatars.
 * Each emoji is chosen for uniqueness at small sizes (16–48px).
 */
export const EMOJI_POOL = [
  // Animals
  "🦊", "🐼", "🦉", "🐙", "🦈", "🐺", "🦁", "🐯", "🐸", "🦋",
  "🐝", "🦜", "🐬", "🦩", "🦚", "🐻", "🐨", "🦇", "🐳", "🐧",
  // Fantasy / characters
  "🤖", "👾", "🎃", "👻", "🦄", "🐲", "🧙", "🧛", "🧟", "🥷",
  // Nature / objects
  "🌵", "🍄", "🌻", "🌊", "⚡", "🔥", "❄️", "🌈", "💎", "🪐",
  // Food / items
  "🍕", "🌮", "🍩", "🧁", "🍣", "🥑", "🍉", "🫐", "🥥", "🍋",
  // Activities / symbols
  "🎯", "🎸", "🎮", "🏆", "🚀", "⚔️", "🛡️", "🧲", "🎪", "🎭",
  // Misc
  "🦾", "🧿", "🪬", "🫧", "🧊", "🪸", "🦑", "🦞", "🪷", "🪻",
] as const

export type PoolEmoji = (typeof EMOJI_POOL)[number]

/** Deterministic hash → emoji index from a name string */
export function emojiForName(name: string): string {
  if (!name) return EMOJI_POOL[0]
  let hash = 0
  for (let i = 0; i < name.length; i++) {
    hash = ((hash << 5) - hash + name.charCodeAt(i)) | 0
  }
  return EMOJI_POOL[Math.abs(hash) % EMOJI_POOL.length]
}
