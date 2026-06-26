// Ocean avatar manifest for Cuttlefish agents.
// PNGs live under packages/web/public/avatars/{aquatic,nautical}/64/.
// Vite serves them at /avatars/{aquatic,nautical}/64/<id>.png.

export type OceanAvatarKind = "aquatic" | "nautical"

export interface OceanAvatar {
  id: string
  kind: OceanAvatarKind
  label: string
  path: string
  keywords: string[]
}

function title(id: string): string {
  return id
    .split("_")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ")
}

function avatar(kind: OceanAvatarKind, id: string, keywords: string[] = []): OceanAvatar {
  return {
    id,
    kind,
    label: title(id),
    path: `/avatars/${kind}/64/${id}.png`,
    keywords: [kind, ...id.split("_"), ...keywords],
  }
}

export const OCEAN_AVATARS: readonly OceanAvatar[] = [
  avatar("aquatic", "cuttlefish", ["brand", "coo", "adaptive"]),
  avatar("aquatic", "octopus", ["planning", "many", "arms"]),
  avatar("aquatic", "squid", ["speed", "deep"]),
  avatar("aquatic", "nautilus", ["architecture", "shell"]),
  avatar("aquatic", "manta_ray", ["research", "wide"]),
  avatar("aquatic", "hammerhead_shark", ["security", "scan"]),
  avatar("aquatic", "dolphin", ["support", "friendly"]),
  avatar("aquatic", "whale", ["strategy", "large"]),
  avatar("aquatic", "orca", ["lead", "focus"]),
  avatar("aquatic", "beluga_whale", ["voice", "talk"]),
  avatar("aquatic", "anglerfish", ["debug", "dark"]),
  avatar("aquatic", "clownfish", ["creative", "bright"]),
  avatar("aquatic", "pufferfish", ["guard", "defense"]),
  avatar("aquatic", "seahorse", ["careful", "small"]),
  avatar("aquatic", "jellyfish", ["ambient", "flow"]),
  avatar("aquatic", "starfish", ["repair", "restore"]),
  avatar("aquatic", "crab_blue", ["ops", "sideways"]),
  avatar("aquatic", "lobster", ["durable", "ops"]),
  avatar("aquatic", "shrimp_amano", ["small", "clean"]),
  avatar("aquatic", "sea_turtle", ["steady", "long"]),
  avatar("aquatic", "penguin", ["docs", "polish"]),
  avatar("aquatic", "pelican", ["delivery", "carrier"]),
  avatar("aquatic", "koi", ["calm", "quality"]),
  avatar("aquatic", "neon_tetra", ["fast", "signal"]),
  avatar("aquatic", "zebra_danio", ["test", "lab"]),
  avatar("nautical", "anchor", ["stability", "ops"]),
  avatar("nautical", "buoy", ["alert", "marker"]),
  avatar("nautical", "lighthouse", ["guidance", "review"]),
  avatar("nautical", "ship_wheel", ["control", "routing"]),
  avatar("nautical", "captains_wheel", ["leadership", "routing"]),
  avatar("nautical", "sailboat", ["travel", "launch"]),
  avatar("nautical", "submarine", ["deep", "investigate"]),
  avatar("nautical", "message_bottle", ["handoff", "message"]),
  avatar("nautical", "life_ring", ["rescue", "support"]),
  avatar("nautical", "trident", ["authority", "power"]),
  avatar("nautical", "treasure_chest", ["archive", "value"]),
]

export type OceanAvatarId = (typeof OCEAN_AVATARS)[number]["id"]

export function oceanAvatarPath(value: string | undefined): string | null {
  if (!value) return null
  const [kind, id] = value.split(":")
  if (kind !== "aquatic" && kind !== "nautical") return null
  return OCEAN_AVATARS.find((item) => item.kind === kind && item.id === id)?.path ?? null
}
