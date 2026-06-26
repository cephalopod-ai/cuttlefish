// Deterministic low-saturation hue per department (djb2, same family as
// emoji-pool's hash). The actual S/L is applied in CSS (.org-dept-accent in
// globals.css) so dark and light themes each get an in-palette tone. We only
// derive the hue here; amber --accent stays reserved for selection.
export function deptHue(dept: string): number {
  let hash = 0
  for (let i = 0; i < dept.length; i++) {
    hash = ((hash << 5) - hash + dept.charCodeAt(i)) | 0
  }
  return Math.abs(hash) % 360
}
