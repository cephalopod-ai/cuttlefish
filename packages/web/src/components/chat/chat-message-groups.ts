import type { Message } from "@/lib/conversations"

export type MessageItem =
  | { kind: "message"; msg: Message; index: number }
  | { kind: "tool-group"; msgs: Message[]; startIndex: number }

// A finished tool call lands in the transcript as "Used <tool>". While it's
// still running the content carries the live tool name instead.
export function isToolDone(msg: Message): boolean {
  return msg.content.startsWith("Used ")
}

export function findActiveToolIndex(msgs: Message[]): number {
  for (let i = msgs.length - 1; i >= 0; i--) {
    if (!isToolDone(msgs[i])) return i
  }
  return -1
}

export function groupMessages(messages: Message[]): MessageItem[] {
  const items: MessageItem[] = []
  let i = 0
  while (i < messages.length) {
    if (messages[i].role === "assistant" && messages[i].toolCall) {
      const toolMsgs: Message[] = []
      const start = i
      while (i < messages.length && messages[i].role === "assistant" && messages[i].toolCall) {
        toolMsgs.push(messages[i])
        i++
      }
      items.push({ kind: "tool-group", msgs: toolMsgs, startIndex: start })
    } else {
      items.push({ kind: "message", msg: messages[i], index: i })
      i++
    }
  }
  return items
}

export function findActiveToolGroupStart(groupedMessages: MessageItem[], loading: boolean): number {
  if (!loading) return -1
  for (let i = groupedMessages.length - 1; i >= 0; i--) {
    const item = groupedMessages[i]
    if (item.kind === "tool-group" && item.msgs.some((msg) => !isToolDone(msg))) {
      return item.startIndex
    }
  }
  return -1
}
