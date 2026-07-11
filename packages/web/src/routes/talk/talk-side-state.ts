import { loadDismissedThreads, loadThreadLabels } from "./talk-storage"
import type { DockSideMap } from "./work-dock-layout"

/**
 * Build the dock side-state map from the existing talk-storage localStorage
 * (label overrides + dismiss tombstones). Reusing the same keys migrates any
 * previously-persisted thread renames/dismissals onto the graph-node dock with
 * no data conversion. Hue is derived (channel-identity), not persisted; the
 * route target is the separate `targetThreadId`, so neither lives here.
 */
export function loadSideState(): DockSideMap {
  const m: DockSideMap = new Map()
  for (const [id, labelOverride] of Object.entries(loadThreadLabels())) {
    m.set(id, { ...(m.get(id) ?? {}), labelOverride })
  }
  for (const id of loadDismissedThreads()) {
    m.set(id, { ...(m.get(id) ?? {}), dismissed: true })
  }
  return m
}

/** Most recent cards kept on the surface at once (older ones drift out). */
export const MAX_CARDS = 6
