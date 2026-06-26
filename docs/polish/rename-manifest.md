# Rename Manifest

## Policy

Renames must preserve behavior and update all references. Public or externally documented paths require compatibility handling or explicit deferral.

## Renames Applied

| Old path | New path | Reason | Reference update strategy | Risk | Verified |
|---|---|---|---|---|---|
| None | None | No low-risk code or file rename was justified in this pass. | Not applicable. | none | Not applicable. |

## Rename Candidates Deferred

| Current path | Proposed path | Reason | Risk | Deferral reason |
|---|---|---|---|---|
| `.claude/`, `.agents/`, `.fissure/` tracked support surfaces | None proposed | These may appear tool-specific, but they are currently part of the repo's agent/tooling surface. | medium | Public staging already treats broad local artifacts separately; changing these paths could confuse tool integrations. |

## Old-Name Reference Check

| Old name/path | Search result | Disposition |
|---|---|---|
| `.playwright-mcp/` | Tracked only as generated logs/snapshots before this pass. | Removed from Git index and ignored; no code references required. |

