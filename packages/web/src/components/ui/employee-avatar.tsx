import { emojiForName } from "@/lib/emoji-pool"
import { oceanAvatarPath } from "@/lib/ocean-avatar-pool"

/** Parse "aquatic:<id>" / "nautical:<id>" avatar fields into a resolved image URL. */
function resolveOceanAvatar(value: string | undefined): string | null {
  return oceanAvatarPath(value)
}

interface EmployeeAvatarProps {
  name: string
  /** Canonical ocean avatar id from the org ("nautical:lighthouse"). When set,
   *  renders a PNG. Takes precedence over `emoji`. */
  avatar?: string
  /** Canonical plain emoji from the org. Used when no `avatar` is set. */
  emoji?: string
  size?: number
  className?: string
  onClick?: () => void
}

/**
 * Render an employee's canonical icon. Resolution order:
 *   org ocean avatar (PNG) > org plain emoji > deterministic emoji fallback.
 *
 * The icon comes solely from the persisted org employee record passed in via
 * props — browser-local `employeeOverrides` no longer affect rendering, so the
 * same icon shows on every surface (org chart, sidebar, pickers, suggestions).
 */
export function EmployeeAvatar({
  name,
  avatar: avatarProp,
  emoji: emojiProp,
  size = 32,
  className,
  onClick,
}: EmployeeAvatarProps) {
  const imgSrc = resolveOceanAvatar(avatarProp) ?? resolveOceanAvatar(emojiProp)
  const emoji = imgSrc ? undefined : (emojiProp || emojiForName(name || ""))
  const fontSize = Math.round(size * 0.6)

  const sharedStyle: React.CSSProperties = {
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    width: size,
    height: size,
    lineHeight: 1,
    borderRadius: "50%",
    flexShrink: 0,
    cursor: onClick ? "pointer" : undefined,
    userSelect: "none",
    overflow: "hidden",
  }
  const buttonProps = onClick
    ? {
        role: "button",
        tabIndex: 0,
        onKeyDown: (event: React.KeyboardEvent<HTMLSpanElement>) => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault()
            onClick()
          }
        },
      }
    : {}

  if (imgSrc) {
    return (
      <span
        className={className}
        onClick={onClick}
        {...buttonProps}
        style={sharedStyle}
      >
        <img
          src={imgSrc}
          alt={name}
          width={size}
          height={size}
          style={{ width: size, height: size, objectFit: "contain", display: "block", borderRadius: "50%" }}
          draggable={false}
        />
      </span>
    )
  }

  return (
    <span
      className={className}
      onClick={onClick}
      {...buttonProps}
      style={{ ...sharedStyle, fontSize }}
    >
      {emoji}
    </span>
  )
}

/**
 * Alias kept for callers (pickers / settings page) that historically used the
 * "no settings context" variant. Behaviour is now identical to EmployeeAvatar.
 */
export function AvatarPreview(props: EmployeeAvatarProps) {
  return <EmployeeAvatar {...props} />
}
