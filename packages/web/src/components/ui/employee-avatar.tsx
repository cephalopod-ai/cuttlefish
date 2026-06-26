import { useSettings } from "@/routes/settings-provider"
import { emojiForName } from "@/lib/emoji-pool"
import { oceanAvatarPath } from "@/lib/ocean-avatar-pool"

/** Parse "aquatic:<id>" / "nautical:<id>" avatar fields into a resolved image URL. */
function resolveOceanAvatar(value: string | undefined): string | null {
  return oceanAvatarPath(value)
}

interface EmployeeAvatarProps {
  name: string
  /** Ocean avatar id from the employee YAML, e.g. "aquatic:cuttlefish". When set,
   *  renders a PNG instead of an emoji. Settings overrides still take precedence. */
  avatar?: string
  size?: number
  className?: string
  onClick?: () => void
}

export function EmployeeAvatar({
  name,
  avatar: avatarProp,
  size = 32,
  className,
  onClick,
}: EmployeeAvatarProps) {
  const { settings } = useSettings()
  const override = name ? settings.employeeOverrides[name] : undefined

  // Resolution order: settings.profileImage > settings.emoji (if ocean avatar) > avatarProp > settings.emoji > emojiForName
  const imgSrc =
    resolveOceanAvatar(override?.profileImage) ??
    resolveOceanAvatar(override?.emoji) ??
    resolveOceanAvatar(avatarProp)

  const emoji = resolveOceanAvatar(override?.emoji) ? undefined : (override?.emoji || emojiForName(name || ''))
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

/** Standalone avatar preview without settings context (for pickers / settings page) */
export function AvatarPreview({
  name,
  size = 32,
  className,
  onClick,
  emoji: overrideEmoji,
  avatar: avatarProp,
}: EmployeeAvatarProps & { emoji?: string }) {
  const imgSrc =
    resolveOceanAvatar(overrideEmoji) ??
    resolveOceanAvatar(avatarProp)

  const emoji = resolveOceanAvatar(overrideEmoji) ? undefined : (overrideEmoji || emojiForName(name))
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
