import type { Message } from "@/lib/conversations"

export function formatTimestamp(ts: number): string {
  const now = new Date()
  const date = new Date(ts)
  const isToday = now.toDateString() === date.toDateString()
  const yesterday = new Date(now)
  yesterday.setDate(yesterday.getDate() - 1)
  const isYesterday = yesterday.toDateString() === date.toDateString()
  const time = date.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", hour12: true })

  if (isToday) return `Today ${time}`
  if (isYesterday) return `Yesterday ${time}`
  return date.toLocaleDateString("en-US", { month: "short", day: "numeric" }) + ` ${time}`
}

export function shouldShowTimestamp(messages: Message[], index: number): boolean {
  if (index === 0) return true
  const gap = messages[index].timestamp - messages[index - 1].timestamp
  return gap > 5 * 60 * 1000
}
