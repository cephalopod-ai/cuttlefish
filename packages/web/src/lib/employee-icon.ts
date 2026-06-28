/**
 * Split a single picker value into the canonical {avatar, emoji} patch.
 *
 * The EmojiPicker emits one value: ocean avatar ids carry a "kind:id" colon
 * ("nautical:life_ring"); everything else is a plain emoji. Exactly one field
 * is persisted at a time, so the non-chosen field is sent as "" — the backend
 * treats an empty string as "clear this key" (XOR normalization).
 */
export function iconPatchFromPickerValue(value: string): { avatar: string; emoji: string } {
  return value.includes(":")
    ? { avatar: value, emoji: "" }
    : { avatar: "", emoji: value }
}

/** The current canonical icon for an employee (avatar wins over emoji), or "". */
export function canonicalIcon(employee: { avatar?: string; emoji?: string }): string {
  return employee.avatar || employee.emoji || ""
}
