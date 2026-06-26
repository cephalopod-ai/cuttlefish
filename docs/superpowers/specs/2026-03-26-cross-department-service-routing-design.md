# Cross-Department Service Routing

**Date**: 2026-03-26
**Issue**: #34
**Inspired by**: @firefloc-nox's PR #27

## Overview

AI employees can declare services they provide. Other employees can discover and request those services via API. The system routes requests directly to the provider and creates a session with a formatted brief.

## Data Model

### ServiceDeclaration

```ts
interface ServiceDeclaration {
  name: string;
  description: string;
}
```

### Employee YAML

Add `provides` field to employee YAMLs:

```yaml
name: platform-dev
displayName: Platform Dev
rank: senior
department: platform
provides:
  - name: code-review
    description: "Review PRs and provide feedback"
  - name: web-development
    description: "Build web features and landing pages"
```

### Employee type change

```ts
// In types.ts - add to Employee interface:
provides?: ServiceDeclaration[];
```

## Service Registry

Built during `scanOrg()` - no new scanner needed. When parsing each employee YAML, also parse the `provides` array. The registry is a flat `Map<string, { provider: Employee; declaration: ServiceDeclaration }>` keyed by service name.

**Collision handling**: If two employees declare the same service name, the higher-ranked one wins. If tied, alphabetical by name. A warning is logged for collisions.

## LCA & Routing (pure functions)

Three pure functions in a new `services.ts` module, operating on the existing `OrgHierarchy` / `OrgNode` tree:

### `findCommonAncestor(employeeA, employeeB, hierarchy)`

Walk up A's `parentName` chain, collect ancestors in a Set. Walk up B's chain until hitting the Set. Return the common ancestor name, or `null` if both are root-level.

Uses the existing `OrgNode.parentName` field. Since `resolveOrgHierarchy` already runs cycle detection (Step 4), infinite loops are impossible - cycles are broken before the tree reaches this function.

### `buildRoutePath(from, to, hierarchy)`

Build `[from, ..., LCA, ..., to]` using `parentName` walks from both sides.

### `resolveManagerChain(routePath, hierarchy)`

Walk the route path, collect each node that has direct reports (i.e., is a manager). Deduplicate. Returns ordered list of manager `OrgNode`s the request conceptually passes through.

**Note**: The route path and manager chain are returned in the API response for audit/tracing. The actual action is simple - create a session with the provider employee directly.

## API Endpoints

### `GET /api/org/services`

List all available services across the org.

```json
{
  "services": [
    {
      "name": "code-review",
      "description": "Review PRs and provide feedback",
      "provider": {
        "name": "platform-dev",
        "displayName": "Platform Dev",
        "department": "platform",
        "rank": "senior"
      }
    }
  ]
}
```

Returns empty `{ "services": [] }` if no employee has `provides` declared.

### `POST /api/org/cross-request`

Route a service request.

**Request**:
```json
{
  "fromEmployee": "content-writer",
  "service": "code-review",
  "prompt": "Review the new blog template component",
  "parentSessionId": "optional-parent-id"
}
```

**Response** (201):
```json
{
  "sessionId": "new-session-id",
  "provider": {
    "name": "platform-dev",
    "displayName": "Platform Dev",
    "department": "platform"
  },
  "route": ["content-writer", "content-lead", "platform-dev"],
  "managers": ["content-lead"],
  "service": "code-review"
}
```

**Session brief** (prompt sent to provider):
```markdown
## Cross-service request

**From**: Content Writer (content)
**Service**: code-review - Review PRs and provide feedback

### Request
Review the new blog template component

---
Handle this as a priority request from a colleague.
```

**Engine/model**: Uses the provider employee's configured `engine` and `model`.

**Errors**:
- 400: Missing `fromEmployee`, `service`, or `prompt`
- 404: `fromEmployee` not found, or service not found
- 500: Provider has no valid engine

## Context Injection

### Chain of Command (upgrade)

Replace the current 2-line `reportsToLine` / `directReportsLine` in `buildEmployeeIdentity` with a richer section:

```markdown
## Chain of command
- **Department**: Content
- **Your manager**: Content Lead (manager)
- **Your direct reports**: Content Writer (employee), Content Designer (employee)
- **Escalation path**: Content Lead -> Jimbo (COO)
```

Built from existing `OrgNode` data: `parentName`, `directReports`, `chain`. The escalation path walks up `parentName` until root, appending `portalName (COO)` at the end.

### Available Services

Appended to employee prompts when services exist in the org:

```markdown
## Available services
Other departments provide the following services. To request one, use the cross-request API:
`POST http://0.0.0.0:8888/api/org/cross-request` with `{"fromEmployee": "your-name", "service": "<name>", "prompt": "<what you need>"}`

- **code-review** -- provided by Platform Dev (senior, platform)
- **keyword-research** -- provided by ASODev Growth (senior, asodev)
```

Skips services provided by the employee's own department. Skipped entirely if no services exist (zero overhead for orgs not using this feature).

## File Changes

| File | Change |
|------|--------|
| `packages/cuttlefish/src/shared/types.ts` | Add `ServiceDeclaration` interface, add `provides?: ServiceDeclaration[]` to `Employee` |
| `packages/cuttlefish/src/gateway/org.ts` | Parse `provides` from YAML in `scanOrg()` |
| `packages/cuttlefish/src/gateway/services.ts` | **New file** - `findCommonAncestor()`, `buildRoutePath()`, `resolveManagerChain()`, `buildServiceRegistry()` |
| `packages/cuttlefish/src/gateway/api.ts` | Add `GET /api/org/services` and `POST /api/org/cross-request` endpoints |
| `packages/cuttlefish/src/sessions/context.ts` | Replace `reportsToLine`/`directReportsLine` with `buildChainOfCommand()`, add `buildServicesContext()` |
| `packages/cuttlefish/src/gateway/__tests__/services.test.ts` | **New file** - tests for LCA, route path, manager chain, service registry |
| Template `CLAUDE.md` + `AGENTS.md` | Add service routing docs to API reference table |

## Non-goals

- Department-level `provides` (keep it on employees for now)
- Service descriptions with input/output schemas
- Approval workflows or access control on cross-requests
- Web UI for service management (API-only for now)
- Caching of `scanOrg()` results (existing pattern, address separately)
