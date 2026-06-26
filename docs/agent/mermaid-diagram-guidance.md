<!-- giles-managed: mermaid-diagram-guidance -->
<!-- source: giles/docs/agent/mermaid-diagram-guidance.md -->
<!-- policy-id: GDIA -->
<!-- policy-version: 1 -->
<!-- template-hash: 26f02e41fa20c8597eb1ba82050cbc1453cbb4419ed62056f2e39dbae2d0f5eb -->

# Mermaid diagram guidance

This file is the operational reference for agents creating or editing
Mermaid diagrams in this repo. The canonical template lives in the
Giles repo at `docs/agent/mermaid-diagram-guidance.md` and is
materialized into each Giles-managed repo with a hash stamp; the
`mermaid_diagram_watcher` flags local copies whose hash has drifted
from the canonical.

## Scope

This guidance applies to:

- Markdown fenced blocks using `mermaid`
- standalone `.mmd` files
- architecture, runtime, workflow, state, and governance diagrams

## System-map layout rule

Prefer **layered, monotonic** diagrams. The canonical layer order for
system maps is:

1. Actor / operator
2. Entrypoints
3. Control plane
4. Runtime / integrations
5. Watchers / validators / policies
6. State / artifacts / reports

Edges should generally move **top-to-bottom**. Use left-to-right only
**inside a layer**.

Use `flowchart TB` for system maps. Use `flowchart LR` only when the
diagram is genuinely a horizontal pipeline (e.g. a state machine that
reads naturally left-to-right).

Wrap each layer in an invisible subgraph with `direction LR` to pin
ranks; this prevents the renderer from collapsing two layers into one
when the connectivity is sparse.

## Fan-out rule

Do not draw dense many-to-many edge sets directly. If multiple
producers write to multiple sinks, insert a **named boundary node**
that represents the relationship. Examples:

- `Persisted outputs` — for code that writes to several storage sinks
- `Policy decision` — for a multi-input policy result that drives several actions
- `Provider boundary` — for a provider-abstraction seam
- `Report emission` — for a one-shot fan-out into multiple report files
- `State update boundary` — for an idempotent write barrier
- `Validation result` — for a downstream-gated decision

The boundary node should reflect a real seam in the architecture. Do
not introduce fictional boundaries just to clean up a diagram — that
is dishonest. If the architecture truly has many-to-many fan-out, the
diagram is signalling that the code does too; consider whether the
code itself should be refactored.

## Complexity rule

If a single diagram exceeds **14 nodes** or **18 edges**, split it.
Prefer:

- one system map
- one state map
- one workflow map

over one unreadable mega-diagram. The watcher emits `GDIA-006` as an
advisory when the threshold is crossed.

## Rendering rule

After editing a Mermaid diagram, **preview or render it** when tooling
is available (`mmdc` from `@mermaid-js/mermaid-cli` works fine).
Verify visually that:

- arrows do not cross boxes
- the layer order matches the diagram's narrative
- the labels are legible
- the diagram still reads as one picture, not many disconnected
  clusters

If rendering is unavailable in your environment, state that
explicitly in the session log or final report. The watcher's
`GDIA-007` finding asks for render evidence on diagram edits.

## Prohibited patterns

Avoid:

- actor arrows that cross through entrypoint boxes
- state/artifact sinks mixed into runtime execution layers
- unlabeled diagonal edges across multiple layers
- direct many-to-many fan-out without a boundary node
- diagrams that optimize source-code neatness but render poorly

## Watcher findings (this policy)

The Giles `mermaid_diagram_watcher` (observability tier, non-blocking)
emits finding codes `GDIA-001..GDIA-008`:

| Code      | Trigger                                                              |
| --------- | -------------------------------------------------------------------- |
| GDIA-001  | repo has Mermaid content but no local `docs/agent/mermaid-diagram-guidance.md` |
| GDIA-002  | `AGENTS.md` does not point at the local mermaid guidance file        |
| GDIA-003  | local guidance file's `template-hash` is stale relative to canonical |
| GDIA-004  | a system map lacks named layered subgraphs                           |
| GDIA-005  | likely many-to-many fan-out without a named boundary node            |
| GDIA-006  | diagram exceeds node/edge complexity threshold (>14 nodes or >18 edges) |
| GDIA-007  | a diagram edit lacks render/preview evidence in the session log     |
| GDIA-008  | possible visual clutter; human render review recommended (heuristic only). |

`GDIA-008` is a heuristic flag — it does not claim to detect
arrow-crossings via SVG geometry. Treat it as "please open the
rendered diagram and look at it."

## Where this file came from

This is a managed copy of the canonical Giles template. Edit the
canonical at `giles/docs/agent/mermaid-diagram-guidance.md` and
re-run the fleet materialization step; do not edit local copies in
place, because the watcher will flag drift.
