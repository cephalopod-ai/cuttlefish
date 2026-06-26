# Command Center Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a new Command Center page (`/command`) with Graph, Dashboard, and Timeline views organized around project tags, an attention/priority system, and smart decay filtering.

**Architecture:** Backend-first approach. Extend the gateway with project/task CRUD, session PATCH, and auto-tagging. Then build the web UI: shared data layer, three views as tab components, slide-over panel with mini-Kanban. React Flow for the graph, custom CSS Grid for dashboard/timeline.

**Tech Stack:** TypeScript, Node.js (gateway), Next.js 13+ (web), React Flow, CSS Grid, WebSocket, JSON file storage, node:test

**Spec:** `docs/superpowers/specs/2026-03-16-command-center-design.md`

---

## Implementation Notes (MUST READ)

These corrections apply across the plan. The implementer MUST follow these over the inline code snippets where they conflict:

### Gateway API patterns (affects all Chunk 2 route handlers)

1. **`readJsonBody` pattern**: Use `const _parsed = await readJsonBody(req, res); if (!_parsed.ok) return; const body = _parsed.body as any;` - NOT destructuring `{ ok, body }`.
2. **`getSession` import**: Use the standalone `getSession(id)` imported from `../sessions/registry.js` - NOT `context.sessionManager.getSession()`.
3. **Session mutation**: Use `updateSession(id, updates)` from `../sessions/registry.js` - NOT direct property assignment on the session object.
4. **`serializeSession` signature**: Second argument is the full `ApiContext` (context) - NOT just `sessionManager`.
5. **YAML parsing**: Use `import yaml from 'js-yaml'` (already imported in the file) with `yaml.load(content)` - NOT `require('yaml')` with `yaml.parse()`.
6. **Data dir path**: Extract `const dataDir = context.getConfig().dataDir || path.join(os.homedir(), '.cuttlefish')` once at the top of the handler, not repeated in every route.

### Web API client (affects Chunk 3)

7. **`del()` helper and 204 responses**: The existing `del()` calls `res.json()` which will throw on 204 (no body). Fix: modify `del()` to return `undefined` when status is 204, OR have DELETE routes return `json(res, { ok: true })` instead of 204.

### Auto-tagger (affects Task 1.4)

8. **`childSessionIds`**: The Session type has no `childSessionIds` field. The auto-tagger Step 4 must compute children by scanning the session registry: `sessionManager.listSessions().filter(s => s.parentSessionId === session.id)`. Pass the session manager to `autoTagSession` or pre-compute the child map.

### Session status mapping (affects decay filter)

9. **No "completed" status**: Sessions use `"idle" | "running" | "error" | "interrupted"`. Completed sessions go to "idle". The `showCompleted` decay filter covers `idle` sessions (since `showIdle` already handles them, merge the two or document that `idle` = completed). The "interrupted" status falls to the default/completed path.

### Missing spec features (implement as sub-steps within their respective tasks)

10. **Project card "Recent activity"**: `ProjectWithStats` should include `recentSessions: { id: string; title: string | null; employee: string | null; lastActivity: string }[]` (last 3). Compute server-side in GET /api/projects. Show in `ProjectCard`.
11. **Graph node hover tooltip**: Add a tooltip on hover showing session breakdown by status and task summary. Use React Flow's built-in node hover or a simple absolute-positioned div on mouseenter.
12. **Timeline task overlays**: Render translucent bars spanning linked sessions' time ranges. Add after session bars in the lane rendering loop.
13. **Slide-over action buttons**: Add edit/archive/delete buttons in the slide-over header. Wire to `api.updateProject`/`api.deleteProject`.
14. **Session row context menu**: Add right-click menu on session rows with: set priority, toggle attention, remove from project, delete.
15. **Kanban board data migration**: Add a one-time migration step in Task 8.4 that reads existing department boards via `api.getDepartmentBoard()`, maps `backlog→todo`, `review→in-progress`, `high→urgent`, `medium→normal`, `low→low`, and creates Tasks via the new API.
16. **ARIA labels on graph nodes**: Add `aria-label` to the ProjectNode div describing the project status.
17. **WebSocket event debouncing**: Debounce the refresh triggered by WS events (e.g., 500ms) to avoid rapid re-fetching when many events arrive at once.

---

## File Structure

### Gateway (`packages/cuttlefish/src/`)

| File | Action | Responsibility |
|------|--------|---------------|
| `shared/types.ts` | Modify | Add `Project`, `Task`, `ProjectWithStats` interfaces; extend `Session` with `projects`, `attentionRequired`, `priority` fields; extend `CronJob` with `attentionRequired`, `defaultPriority` |
| `gateway/projects.ts` | Create | Project CRUD: `loadProjects()`, `saveProjects()`, `getProjectStats()` - JSON file I/O for `~/.cuttlefish/projects.json` |
| `gateway/tasks.ts` | Create | Task CRUD: `loadTasks()`, `saveTasks()` - JSON file I/O for `~/.cuttlefish/tasks.json` |
| `gateway/project-tagger.ts` | Create | `autoTagSession()` - one-shot auto-tagging logic (5-step waterfall) |
| `gateway/api.ts` | Modify | Add routes: PATCH sessions, CRUD projects, CRUD tasks |
| `cron/runner.ts` | Modify | Propagate `attentionRequired` + `defaultPriority` from job to spawned session |
| `gateway/projects.test.ts` | Create | Tests for project CRUD + stats aggregation |
| `gateway/tasks.test.ts` | Create | Tests for task CRUD + status transitions |
| `gateway/project-tagger.test.ts` | Create | Tests for auto-tagging waterfall logic |

### Web UI (`packages/web/src/`)

| File | Action | Responsibility |
|------|--------|---------------|
| `lib/api.ts` | Modify | Add `patch` helper + project/task/session-patch API methods |
| `lib/command-center/types.ts` | Create | `Project`, `ProjectWithStats`, `Task`, `DecayFilter`, `CommandTab` types |
| `lib/command-center/hooks.ts` | Create | `useProjects()`, `useTasks()`, `useDecayFilter()`, `useCommandCenter()` hooks |
| `lib/command-center/utils.ts` | Create | Decay filter logic, priority sorting, attention counting |
| `lib/nav.ts` | Modify | Add Command Center nav item, remove Kanban |
| `app/command/page.tsx` | Create | Command Center page - tab layout, filter bar, attention badge |
| `components/command-center/graph-view.tsx` | Create | React Flow graph - project nodes, edges, animations, minimap |
| `components/command-center/project-node.tsx` | Create | Custom React Flow node - project card with status indicators |
| `components/command-center/dashboard-view.tsx` | Create | CSS Grid card layout - project cards sorted by attention/activity |
| `components/command-center/project-card.tsx` | Create | Dashboard card - icon, name, stats, task summary, recent activity |
| `components/command-center/timeline-view.tsx` | Create | Swimlane view - horizontal lanes per project, session bars, task overlays |
| `components/command-center/slide-over.tsx` | Create | Right panel - project detail with mini-Kanban + session list |
| `components/command-center/mini-kanban.tsx` | Create | 4-column task board (todo/in-progress/done/blocked) with drag |
| `components/command-center/decay-filter.tsx` | Create | Filter popover - presets + granular controls |
| `components/command-center/attention-badge.tsx` | Create | Red pill badge with attention count |
| `app/kanban/page.tsx` | Modify | Add redirect to /command |

---

## Chunk 1: Gateway - Types & Project/Task Storage

### Task 1.1: Extend shared types

**Files:**
- Modify: `packages/cuttlefish/src/shared/types.ts`

- [ ] **Step 1: Add Project interface**

After the existing `Session` interface, add:

```typescript
export interface Project {
  id: string
  name: string
  color: string
  icon?: string
  parentId?: string
  archived?: boolean
  createdAt: string
  updatedAt: string
}

export interface ProjectWithStats extends Project {
  stats: {
    totalSessions: number
    runningSessions: number
    errorSessions: number
    attentionCount: number
    tasksByStatus: Record<'todo' | 'in-progress' | 'done' | 'blocked', number>
  }
}
```

- [ ] **Step 2: Add Task interface**

```typescript
export type TaskStatus = 'todo' | 'in-progress' | 'done' | 'blocked'
export type TaskPriority = 'urgent' | 'normal' | 'low'
export type SessionPriority = 'urgent' | 'normal' | 'low'

export interface Task {
  id: string
  projectId: string
  title: string
  status: TaskStatus
  priority: TaskPriority | null
  sessionIds: string[]
  attentionRequired: boolean
  createdAt: string
  updatedAt: string
}
```

- [ ] **Step 3: Extend Session interface**

Add three new fields to the existing `Session` interface:

```typescript
  // Add after existing fields:
  projects: string[]
  attentionRequired: boolean
  priority: SessionPriority | null
```

- [ ] **Step 4: Extend CronJob type**

Find the `CronJob` interface/type and add:

```typescript
  attentionRequired?: boolean
  defaultPriority?: SessionPriority | null
```

- [ ] **Step 5: Verify build compiles**

Run: `cd ~/Projects/cuttlefish && npm run build --workspace=packages/cuttlefish 2>&1 | head -30`

Fix any type errors in existing code that now requires the new Session fields. Existing session creation code should default to `projects: []`, `attentionRequired: false`, `priority: null`.

- [ ] **Step 6: Commit**

```bash
git add packages/cuttlefish/src/shared/types.ts
git commit -m "feat(types): add Project, Task interfaces and extend Session with priority/attention fields"
```

### Task 1.2: Project storage module

**Files:**
- Create: `packages/cuttlefish/src/gateway/projects.ts`
- Create: `packages/cuttlefish/src/gateway/projects.test.ts`

- [ ] **Step 1: Write failing tests for project CRUD**

```typescript
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { loadProjects, saveProjects, createProject, updateProject, deleteProject } from './projects.js'

test('loadProjects returns empty array when file does not exist', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cuttlefish-test-'))
  const filePath = path.join(tmpDir, 'projects.json')
  const result = loadProjects(filePath)
  assert.deepEqual(result, [])
  fs.rmSync(tmpDir, { recursive: true })
})

test('saveProjects writes and loadProjects reads back', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cuttlefish-test-'))
  const filePath = path.join(tmpDir, 'projects.json')
  const projects = [{ id: 'project-a', name: 'Project A', color: '#3b82f6', createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z' }]
  saveProjects(projects, filePath)
  const loaded = loadProjects(filePath)
  assert.equal(loaded.length, 1)
  assert.equal(loaded[0].id, 'project-a')
  fs.rmSync(tmpDir, { recursive: true })
})

test('createProject generates id from name and sets timestamps', () => {
  const project = createProject({ name: 'Demo Project', color: '#ef4444' })
  assert.equal(project.id, 'demo-project')
  assert.equal(project.name, 'Demo Project')
  assert.equal(project.color, '#ef4444')
  assert.ok(project.createdAt)
  assert.ok(project.updatedAt)
})

test('createProject with custom id preserves it', () => {
  const project = createProject({ name: 'Demo Project', color: '#ef4444', id: 'custom-id' })
  assert.equal(project.id, 'custom-id')
})

test('updateProject merges fields and updates timestamp', () => {
  const original = createProject({ name: 'Project A', color: '#3b82f6' })
  const updated = updateProject(original, { name: 'Project A Pro', archived: true })
  assert.equal(updated.name, 'Project A Pro')
  assert.equal(updated.color, '#3b82f6')
  assert.equal(updated.archived, true)
  assert.notEqual(updated.updatedAt, original.updatedAt)
})

test('deleteProject removes from array', () => {
  const projects = [
    createProject({ name: 'A', color: '#000' }),
    createProject({ name: 'B', color: '#fff' }),
  ]
  const result = deleteProject(projects, projects[0].id)
  assert.equal(result.length, 1)
  assert.equal(result[0].name, 'B')
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd ~/Projects/cuttlefish && node --test packages/cuttlefish/src/gateway/projects.test.ts`
Expected: FAIL (module not found)

- [ ] **Step 3: Implement projects.ts**

```typescript
import fs from 'node:fs'
import path from 'node:path'
import type { Project } from '../shared/types.js'

export function loadProjects(filePath: string): Project[] {
  try {
    const data = fs.readFileSync(filePath, 'utf-8')
    return JSON.parse(data)
  } catch {
    return []
  }
}

export function saveProjects(projects: Project[], filePath: string): void {
  const dir = path.dirname(filePath)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(filePath, JSON.stringify(projects, null, 2) + '\n')
}

function slugify(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
}

export function createProject(data: { name: string; color: string; id?: string; icon?: string; parentId?: string }): Project {
  const now = new Date().toISOString()
  return {
    id: data.id || slugify(data.name),
    name: data.name,
    color: data.color,
    icon: data.icon,
    parentId: data.parentId,
    archived: false,
    createdAt: now,
    updatedAt: now,
  }
}

export function updateProject(project: Project, updates: Partial<Project>): Project {
  return {
    ...project,
    ...updates,
    id: project.id, // id is immutable
    createdAt: project.createdAt, // createdAt is immutable
    updatedAt: new Date().toISOString(),
  }
}

export function deleteProject(projects: Project[], id: string): Project[] {
  return projects.filter(p => p.id !== id)
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd ~/Projects/cuttlefish && node --test packages/cuttlefish/src/gateway/projects.test.ts`
Expected: All 6 tests PASS

- [ ] **Step 5: Commit**

```bash
git add packages/cuttlefish/src/gateway/projects.ts packages/cuttlefish/src/gateway/projects.test.ts
git commit -m "feat(gateway): add project storage module with CRUD and tests"
```

### Task 1.3: Task storage module

**Files:**
- Create: `packages/cuttlefish/src/gateway/tasks.ts`
- Create: `packages/cuttlefish/src/gateway/tasks.test.ts`

- [ ] **Step 1: Write failing tests for task CRUD**

```typescript
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { loadTasks, saveTasks, createTask, updateTask, deleteTask } from './tasks.js'

test('loadTasks returns empty array when file does not exist', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cuttlefish-test-'))
  const filePath = path.join(tmpDir, 'tasks.json')
  const result = loadTasks(filePath)
  assert.deepEqual(result, [])
  fs.rmSync(tmpDir, { recursive: true })
})

test('createTask sets defaults and generates uuid', () => {
  const task = createTask({ projectId: 'project-a', title: 'Localize to German' })
  assert.ok(task.id)
  assert.equal(task.projectId, 'project-a')
  assert.equal(task.title, 'Localize to German')
  assert.equal(task.status, 'todo')
  assert.equal(task.priority, null)
  assert.equal(task.attentionRequired, false)
  assert.deepEqual(task.sessionIds, [])
})

test('blocked tasks auto-set attentionRequired', () => {
  const task = createTask({ projectId: 'p', title: 'Test' })
  const updated = updateTask(task, { status: 'blocked' })
  assert.equal(updated.attentionRequired, true)
})

test('updateTask merges fields', () => {
  const task = createTask({ projectId: 'p', title: 'Test' })
  const updated = updateTask(task, { priority: 'urgent', sessionIds: ['s1'] })
  assert.equal(updated.priority, 'urgent')
  assert.deepEqual(updated.sessionIds, ['s1'])
  assert.equal(updated.title, 'Test')
})

test('deleteTask removes by id', () => {
  const tasks = [
    createTask({ projectId: 'p', title: 'A' }),
    createTask({ projectId: 'p', title: 'B' }),
  ]
  const result = deleteTask(tasks, tasks[0].id)
  assert.equal(result.length, 1)
  assert.equal(result[0].title, 'B')
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd ~/Projects/cuttlefish && node --test packages/cuttlefish/src/gateway/tasks.test.ts`
Expected: FAIL (module not found)

- [ ] **Step 3: Implement tasks.ts**

```typescript
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import type { Task } from '../shared/types.js'

export function loadTasks(filePath: string): Task[] {
  try {
    const data = fs.readFileSync(filePath, 'utf-8')
    return JSON.parse(data)
  } catch {
    return []
  }
}

export function saveTasks(tasks: Task[], filePath: string): void {
  const dir = path.dirname(filePath)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(filePath, JSON.stringify(tasks, null, 2) + '\n')
}

export function createTask(data: { projectId: string; title: string; priority?: Task['priority']; sessionIds?: string[] }): Task {
  const now = new Date().toISOString()
  return {
    id: crypto.randomUUID(),
    projectId: data.projectId,
    title: data.title,
    status: 'todo',
    priority: data.priority ?? null,
    sessionIds: data.sessionIds ?? [],
    attentionRequired: false,
    createdAt: now,
    updatedAt: now,
  }
}

export function updateTask(task: Task, updates: Partial<Task>): Task {
  const merged = {
    ...task,
    ...updates,
    id: task.id,
    projectId: task.projectId,
    createdAt: task.createdAt,
    updatedAt: new Date().toISOString(),
  }
  // Auto-set attentionRequired when blocked
  if (merged.status === 'blocked') {
    merged.attentionRequired = true
  }
  return merged
}

export function deleteTask(tasks: Task[], id: string): Task[] {
  return tasks.filter(t => t.id !== id)
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd ~/Projects/cuttlefish && node --test packages/cuttlefish/src/gateway/tasks.test.ts`
Expected: All 5 tests PASS

- [ ] **Step 5: Commit**

```bash
git add packages/cuttlefish/src/gateway/tasks.ts packages/cuttlefish/src/gateway/tasks.test.ts
git commit -m "feat(gateway): add task storage module with CRUD, blocked auto-attention, and tests"
```

### Task 1.4: Auto-tagger module

**Files:**
- Create: `packages/cuttlefish/src/gateway/project-tagger.ts`
- Create: `packages/cuttlefish/src/gateway/project-tagger.test.ts`

- [ ] **Step 1: Write failing tests for auto-tagging**

```typescript
import test from 'node:test'
import assert from 'node:assert/strict'
import { autoTagSession } from './project-tagger.js'

// Minimal mock types matching the function signature
const projects = [
  { id: 'project-a', name: 'Project A', color: '#000', createdAt: '', updatedAt: '' },
  { id: 'acme', name: 'Acme', color: '#000', createdAt: '', updatedAt: '' },
  { id: 'general', name: 'General', color: '#888', createdAt: '', updatedAt: '' },
]

const orgDepts = {
  'a-lead': 'project-a',
  'content-lead': 'project-a',
  'acme-lead': 'acme',
  'lead-developer': 'platform',
}

test('manual tags take precedence (step 1)', () => {
  const session = { projects: ['custom-tag'], employee: 'a-lead', title: 'Acme blog', parentSessionId: null }
  const result = autoTagSession(session as any, projects, orgDepts, {})
  assert.deepEqual(result, ['custom-tag'])
})

test('employee department mapping (step 2)', () => {
  const session = { projects: [], employee: 'a-lead', title: null, parentSessionId: null }
  const result = autoTagSession(session as any, projects, orgDepts, {})
  assert.deepEqual(result, ['project-a'])
})

test('parent session inheritance (step 3)', () => {
  const session = { projects: [], employee: null, title: null, parentSessionId: 'parent-1' }
  const sessionProjects = { 'parent-1': ['acme'] }
  const result = autoTagSession(session as any, projects, orgDepts, sessionProjects)
  assert.deepEqual(result, ['acme'])
})

test('child session inheritance when no other match (step 4)', () => {
  const session = { id: 'coo-session', projects: [], employee: null, title: null, parentSessionId: null, childSessionIds: ['child-1', 'child-2'] }
  const sessionProjects = { 'child-1': ['project-a'], 'child-2': ['project-a', 'acme'] }
  const result = autoTagSession(session as any, projects, orgDepts, sessionProjects)
  assert.deepEqual(result, ['project-a', 'acme'])
})

test('keyword inference from title (step 5)', () => {
  const session = { projects: [], employee: null, title: 'Fix Project A blog SEO', parentSessionId: null }
  const result = autoTagSession(session as any, projects, orgDepts, {})
  assert.deepEqual(result, ['project-a'])
})

test('falls back to general (step 6)', () => {
  const session = { projects: [], employee: null, title: 'Random unrelated task', parentSessionId: null }
  const result = autoTagSession(session as any, projects, orgDepts, {})
  assert.deepEqual(result, ['general'])
})

test('does not duplicate tags', () => {
  const session = { projects: [], employee: 'a-lead', title: 'Project A blog', parentSessionId: null }
  const result = autoTagSession(session as any, projects, orgDepts, {})
  assert.deepEqual(result, ['project-a'])
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd ~/Projects/cuttlefish && node --test packages/cuttlefish/src/gateway/project-tagger.test.ts`
Expected: FAIL (module not found)

- [ ] **Step 3: Implement project-tagger.ts**

```typescript
import type { Project } from '../shared/types.js'

interface TaggableSession {
  id?: string
  projects: string[]
  employee: string | null
  title: string | null
  parentSessionId: string | null
  childSessionIds?: string[]
}

/**
 * One-shot auto-tagger. Reads related session tags but never writes to them.
 * @param session - The session to tag
 * @param projects - All known projects
 * @param orgDeptMap - Map of employee name → department/project id
 * @param sessionProjectsMap - Map of session id → project ids (for parent/child lookup)
 * @returns Array of project IDs to assign
 */
export function autoTagSession(
  session: TaggableSession,
  projects: Project[],
  orgDeptMap: Record<string, string>,
  sessionProjectsMap: Record<string, string[]>
): string[] {
  // Step 1: Manual tags take precedence
  if (session.projects.length > 0) {
    return session.projects
  }

  const tags = new Set<string>()
  const projectIds = new Set(projects.map(p => p.id))

  // Step 2: Employee → department mapping
  if (session.employee && orgDeptMap[session.employee]) {
    const deptProject = orgDeptMap[session.employee]
    if (projectIds.has(deptProject)) {
      tags.add(deptProject)
    }
  }

  // Step 3: Parent session inheritance (read-only)
  if (tags.size === 0 && session.parentSessionId) {
    const parentTags = sessionProjectsMap[session.parentSessionId]
    if (parentTags) {
      for (const tag of parentTags) tags.add(tag)
    }
  }

  // Step 4: Child session inheritance (only when steps 1-3 yielded nothing)
  if (tags.size === 0 && session.childSessionIds) {
    for (const childId of session.childSessionIds) {
      const childTags = sessionProjectsMap[childId]
      if (childTags) {
        for (const tag of childTags) tags.add(tag)
      }
    }
  }

  // Step 5: Keyword inference from title
  if (session.title) {
    const titleLower = session.title.toLowerCase()
    for (const project of projects) {
      if (project.id === 'general') continue
      if (titleLower.includes(project.name.toLowerCase()) || titleLower.includes(project.id)) {
        tags.add(project.id)
      }
    }
  }

  // Step 6: Fallback to general
  if (tags.size === 0) {
    return ['general']
  }

  return [...tags]
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd ~/Projects/cuttlefish && node --test packages/cuttlefish/src/gateway/project-tagger.test.ts`
Expected: All 7 tests PASS

- [ ] **Step 5: Commit**

```bash
git add packages/cuttlefish/src/gateway/project-tagger.ts packages/cuttlefish/src/gateway/project-tagger.test.ts
git commit -m "feat(gateway): add auto-tagger module with 5-step waterfall and tests"
```

---

## Chunk 2: Gateway - API Routes

### Task 2.1: Add `patch` helper and project stats computation

**Files:**
- Modify: `packages/cuttlefish/src/gateway/api.ts`

- [ ] **Step 1: Add PATCH /api/sessions/:id route**

In `api.ts`, find the session routes section. Add after the existing DELETE route:

```typescript
// PATCH /api/sessions/:id - update priority/attention/projects
const patchSession = matchRoute('/api/sessions/:id', pathname)
if (patchSession && req.method === 'PATCH') {
  const { ok, body } = await readJsonBody(req, res)
  if (!ok) return
  const session = context.sessionManager.getSession(patchSession.id)
  if (!session) return notFound(res)

  if (body.projects !== undefined) session.projects = body.projects
  if (body.priority !== undefined) session.priority = body.priority
  if (body.attentionRequired !== undefined) session.attentionRequired = body.attentionRequired

  context.emit('session:updated', { id: patchSession.id, fields: Object.keys(body) })
  return json(res, serializeSession(session, context.sessionManager))
}
```

- [ ] **Step 2: Add project CRUD routes**

Add after the session routes:

```typescript
// GET /api/projects
if (pathname === '/api/projects' && req.method === 'GET') {
  const { loadProjects } = await import('./projects.js')
  const { loadTasks } = await import('./tasks.js')
  const projectsPath = path.join(context.getConfig().dataDir || path.join(os.homedir(), '.cuttlefish'), 'projects.json')
  const tasksPath = path.join(context.getConfig().dataDir || path.join(os.homedir(), '.cuttlefish'), 'tasks.json')
  const projects = loadProjects(projectsPath)
  const tasks = loadTasks(tasksPath)
  const sessions = context.sessionManager.listSessions()

  const withStats = projects.map(p => {
    const projectSessions = sessions.filter(s => s.projects?.includes(p.id))
    const projectTasks = tasks.filter(t => t.projectId === p.id)
    return {
      ...p,
      stats: {
        totalSessions: projectSessions.length,
        runningSessions: projectSessions.filter(s => s.status === 'running').length,
        errorSessions: projectSessions.filter(s => s.status === 'error').length,
        attentionCount: projectSessions.filter(s => s.attentionRequired).length,
        tasksByStatus: {
          'todo': projectTasks.filter(t => t.status === 'todo').length,
          'in-progress': projectTasks.filter(t => t.status === 'in-progress').length,
          'done': projectTasks.filter(t => t.status === 'done').length,
          'blocked': projectTasks.filter(t => t.status === 'blocked').length,
        },
      },
    }
  })
  return json(res, withStats)
}

// POST /api/projects
if (pathname === '/api/projects' && req.method === 'POST') {
  const { ok, body } = await readJsonBody(req, res)
  if (!ok) return
  const { loadProjects, saveProjects, createProject } = await import('./projects.js')
  const projectsPath = path.join(context.getConfig().dataDir || path.join(os.homedir(), '.cuttlefish'), 'projects.json')
  const projects = loadProjects(projectsPath)
  const project = createProject(body)
  projects.push(project)
  saveProjects(projects, projectsPath)
  context.emit('project:created', project)
  return json(res, project, 201)
}

// PUT /api/projects/:id
const putProject = matchRoute('/api/projects/:id', pathname)
if (putProject && req.method === 'PUT') {
  const { ok, body } = await readJsonBody(req, res)
  if (!ok) return
  const { loadProjects, saveProjects, updateProject } = await import('./projects.js')
  const projectsPath = path.join(context.getConfig().dataDir || path.join(os.homedir(), '.cuttlefish'), 'projects.json')
  const projects = loadProjects(projectsPath)
  const idx = projects.findIndex(p => p.id === putProject.id)
  if (idx === -1) return notFound(res)
  projects[idx] = updateProject(projects[idx], body)
  saveProjects(projects, projectsPath)
  context.emit('project:updated', projects[idx])
  return json(res, projects[idx])
}

// DELETE /api/projects/:id
const delProject = matchRoute('/api/projects/:id', pathname)
if (delProject && req.method === 'DELETE') {
  const { loadProjects, saveProjects, deleteProject } = await import('./projects.js')
  const projectsPath = path.join(context.getConfig().dataDir || path.join(os.homedir(), '.cuttlefish'), 'projects.json')
  const projects = loadProjects(projectsPath)
  const filtered = deleteProject(projects, delProject.id)
  saveProjects(filtered, projectsPath)
  context.emit('project:deleted', { id: delProject.id })
  res.writeHead(204)
  return res.end()
}
```

- [ ] **Step 3: Add task CRUD routes**

```typescript
// GET /api/projects/:id/tasks
const getProjectTasks = matchRoute('/api/projects/:id/tasks', pathname)
if (getProjectTasks && req.method === 'GET') {
  const { loadTasks } = await import('./tasks.js')
  const tasksPath = path.join(context.getConfig().dataDir || path.join(os.homedir(), '.cuttlefish'), 'tasks.json')
  const tasks = loadTasks(tasksPath)
  return json(res, tasks.filter(t => t.projectId === getProjectTasks.id))
}

// POST /api/projects/:id/tasks
const postProjectTasks = matchRoute('/api/projects/:id/tasks', pathname)
if (postProjectTasks && req.method === 'POST') {
  const { ok, body } = await readJsonBody(req, res)
  if (!ok) return
  const { loadTasks, saveTasks, createTask } = await import('./tasks.js')
  const tasksPath = path.join(context.getConfig().dataDir || path.join(os.homedir(), '.cuttlefish'), 'tasks.json')
  const tasks = loadTasks(tasksPath)
  const task = createTask({ ...body, projectId: postProjectTasks.id })
  tasks.push(task)
  saveTasks(tasks, tasksPath)
  context.emit('task:created', task)
  return json(res, task, 201)
}

// PUT /api/tasks/:id
const putTask = matchRoute('/api/tasks/:id', pathname)
if (putTask && req.method === 'PUT') {
  const { ok, body } = await readJsonBody(req, res)
  if (!ok) return
  const { loadTasks, saveTasks, updateTask } = await import('./tasks.js')
  const tasksPath = path.join(context.getConfig().dataDir || path.join(os.homedir(), '.cuttlefish'), 'tasks.json')
  const tasks = loadTasks(tasksPath)
  const idx = tasks.findIndex(t => t.id === putTask.id)
  if (idx === -1) return notFound(res)
  tasks[idx] = updateTask(tasks[idx], body)
  saveTasks(tasks, tasksPath)
  context.emit('task:updated', tasks[idx])
  return json(res, tasks[idx])
}

// DELETE /api/tasks/:id
const delTask = matchRoute('/api/tasks/:id', pathname)
if (delTask && req.method === 'DELETE') {
  const { loadTasks, saveTasks, deleteTask } = await import('./tasks.js')
  const tasksPath = path.join(context.getConfig().dataDir || path.join(os.homedir(), '.cuttlefish'), 'tasks.json')
  const tasks = loadTasks(tasksPath)
  const filtered = deleteTask(tasks, delTask.id)
  saveTasks(filtered, tasksPath)
  context.emit('task:deleted', { id: delTask.id })
  res.writeHead(204)
  return res.end()
}
```

- [ ] **Step 4: Verify gateway compiles**

Run: `cd ~/Projects/cuttlefish && npm run build --workspace=packages/cuttlefish 2>&1 | head -30`
Expected: No errors

- [ ] **Step 5: Commit**

```bash
git add packages/cuttlefish/src/gateway/api.ts
git commit -m "feat(gateway): add project/task CRUD routes and session PATCH for priority/attention"
```

### Task 2.2: Integrate auto-tagger into session creation

**Files:**
- Modify: `packages/cuttlefish/src/gateway/api.ts` (session creation section)
- Modify: `packages/cuttlefish/src/cron/runner.ts`

- [ ] **Step 1: Hook auto-tagger into POST /api/sessions**

In the `POST /api/sessions` handler, after the session is created but before the response, add auto-tagging:

```typescript
// After session creation, auto-tag if no manual projects set
if (!session.projects || session.projects.length === 0) {
  const { loadProjects } = await import('./projects.js')
  const { autoTagSession } = await import('./project-tagger.js')
  const projectsPath = path.join(context.getConfig().dataDir || path.join(os.homedir(), '.cuttlefish'), 'projects.json')
  const projects = loadProjects(projectsPath)
  const orgDeptMap = buildOrgDeptMap(context.getConfig())
  const sessionProjectsMap = buildSessionProjectsMap(context.sessionManager)
  session.projects = autoTagSession(session, projects, orgDeptMap, sessionProjectsMap)
}
```

Also add two helper functions near the top of api.ts:

```typescript
function buildOrgDeptMap(config: CuttlefishConfig): Record<string, string> {
  const map: Record<string, string> = {}
  // Read org files to build employee → department mapping
  const orgDir = path.join(os.homedir(), '.cuttlefish', 'org')
  try {
    const files = fs.readdirSync(orgDir).filter(f => f.endsWith('.yaml') || f.endsWith('.yml'))
    for (const file of files) {
      const content = fs.readFileSync(path.join(orgDir, file), 'utf-8')
      const yaml = require('yaml')
      const emp = yaml.parse(content)
      if (emp?.name && emp?.department) {
        map[emp.name] = emp.department
      }
    }
  } catch { /* org dir may not exist */ }
  return map
}

function buildSessionProjectsMap(sessionManager: any): Record<string, string[]> {
  const map: Record<string, string[]> = {}
  for (const session of sessionManager.listSessions()) {
    if (session.projects?.length > 0) {
      map[session.id] = session.projects
    }
  }
  return map
}
```

- [ ] **Step 2: Add attention/priority propagation to cron runner**

In `cron/runner.ts`, modify the session creation to include cron job attention flags:

```typescript
// In the route options, add:
const routeOpts = {
  // ...existing opts
  attentionRequired: job.attentionRequired ?? false,
  priority: job.defaultPriority ?? null,
}
```

Ensure the session created by `sessionManager.route()` picks up these fields.

- [ ] **Step 3: Verify build**

Run: `cd ~/Projects/cuttlefish && npm run build --workspace=packages/cuttlefish 2>&1 | head -30`
Expected: No errors

- [ ] **Step 4: Commit**

```bash
git add packages/cuttlefish/src/gateway/api.ts packages/cuttlefish/src/cron/runner.ts
git commit -m "feat(gateway): integrate auto-tagger into session creation and cron attention propagation"
```

---

## Chunk 3: Web UI - Data Layer & Navigation

### Task 3.1: Extend web API client

**Files:**
- Modify: `packages/web/src/lib/api.ts`

- [ ] **Step 1: Add patch helper function**

After the existing `del` helper:

```typescript
async function patch<T = unknown>(path: string, body: unknown): Promise<T> {
  const res = await fetch(BASE + path, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!res.ok) throw new Error(await extractError(res))
  return res.json()
}
```

- [ ] **Step 2: Add project/task/session API methods**

Add to the exported `api` object:

```typescript
  // Projects
  getProjects: () => get<any[]>('/api/projects'),
  createProject: (data: { name: string; color: string; icon?: string; parentId?: string }) =>
    post<any>('/api/projects', data),
  updateProject: (id: string, data: Record<string, unknown>) =>
    put<any>(`/api/projects/${id}`, data),
  deleteProject: (id: string) => del(`/api/projects/${id}`),

  // Tasks
  getProjectTasks: (projectId: string) => get<any[]>(`/api/projects/${projectId}/tasks`),
  createTask: (projectId: string, data: { title: string; priority?: string; sessionIds?: string[] }) =>
    post<any>(`/api/projects/${projectId}/tasks`, data),
  updateTask: (id: string, data: Record<string, unknown>) =>
    put<any>(`/api/tasks/${id}`, data),
  deleteTask: (id: string) => del(`/api/tasks/${id}`),

  // Session priority/attention
  patchSession: (id: string, data: { projects?: string[]; priority?: string | null; attentionRequired?: boolean }) =>
    patch<any>(`/api/sessions/${id}`, data),
```

- [ ] **Step 3: Commit**

```bash
git add packages/web/src/lib/api.ts
git commit -m "feat(web): extend API client with project, task, and session patch methods"
```

### Task 3.2: Command Center types and utilities

**Files:**
- Create: `packages/web/src/lib/command-center/types.ts`
- Create: `packages/web/src/lib/command-center/utils.ts`

- [ ] **Step 1: Create types**

```typescript
// types.ts
export interface Project {
  id: string
  name: string
  color: string
  icon?: string
  parentId?: string
  archived?: boolean
  createdAt: string
  updatedAt: string
}

export interface ProjectWithStats extends Project {
  stats: {
    totalSessions: number
    runningSessions: number
    errorSessions: number
    attentionCount: number
    tasksByStatus: Record<'todo' | 'in-progress' | 'done' | 'blocked', number>
  }
}

export type TaskStatus = 'todo' | 'in-progress' | 'done' | 'blocked'
export type SessionPriority = 'urgent' | 'normal' | 'low'

export interface Task {
  id: string
  projectId: string
  title: string
  status: TaskStatus
  priority: SessionPriority | null
  sessionIds: string[]
  attentionRequired: boolean
  createdAt: string
  updatedAt: string
}

export interface DecayFilter {
  showCompleted: '24h' | '3d' | '7d' | '30d' | 'all'
  showIdle: '3d' | '7d' | '30d' | 'all'
  showErrors: '7d' | '30d' | 'all'
  showRunning: 'always'
  showAttentionRequired: 'always'
}

export type CommandTab = 'graph' | 'dashboard' | 'timeline'

export interface CommandSession {
  id: string
  title: string | null
  employee: string | null
  status: string
  source: string
  projects: string[]
  attentionRequired: boolean
  priority: SessionPriority | null
  createdAt: string
  lastActivity: string
}
```

- [ ] **Step 2: Create utility functions**

```typescript
// utils.ts
import type { DecayFilter, CommandSession, ProjectWithStats } from './types'

export const DEFAULT_DECAY_FILTER: DecayFilter = {
  showCompleted: '3d',
  showIdle: '7d',
  showErrors: 'all',
  showRunning: 'always',
  showAttentionRequired: 'always',
}

const DURATION_MS: Record<string, number> = {
  '24h': 24 * 60 * 60 * 1000,
  '3d': 3 * 24 * 60 * 60 * 1000,
  '7d': 7 * 24 * 60 * 60 * 1000,
  '30d': 30 * 24 * 60 * 60 * 1000,
}

export function shouldShowSession(session: CommandSession, filter: DecayFilter, now: number): boolean {
  // Attention-required and urgent are always visible
  if (session.attentionRequired || session.priority === 'urgent') return true
  if (session.status === 'running') return true

  const age = now - new Date(session.lastActivity).getTime()

  if (session.status === 'error') {
    if (filter.showErrors === 'all') return true
    return age <= (DURATION_MS[filter.showErrors] ?? Infinity)
  }

  if (session.status === 'idle') {
    if (filter.showIdle === 'all') return true
    return age <= (DURATION_MS[filter.showIdle] ?? Infinity)
  }

  // completed / other
  if (filter.showCompleted === 'all') return true
  return age <= (DURATION_MS[filter.showCompleted] ?? Infinity)
}

export function sortProjectsByAttention(projects: ProjectWithStats[]): ProjectWithStats[] {
  return [...projects].sort((a, b) => {
    // Attention count first
    const attDiff = b.stats.attentionCount - a.stats.attentionCount
    if (attDiff !== 0) return attDiff
    // Then errors
    const errDiff = b.stats.errorSessions - a.stats.errorSessions
    if (errDiff !== 0) return errDiff
    // Then running
    const runDiff = b.stats.runningSessions - a.stats.runningSessions
    if (runDiff !== 0) return runDiff
    // Then total
    return b.stats.totalSessions - a.stats.totalSessions
  })
}

export function getTotalAttentionCount(projects: ProjectWithStats[]): number {
  return projects.reduce((sum, p) => sum + p.stats.attentionCount, 0)
}
```

- [ ] **Step 3: Commit**

```bash
git add packages/web/src/lib/command-center/
git commit -m "feat(web): add Command Center types and decay filter utilities"
```

### Task 3.3: React hooks for Command Center data

**Files:**
- Create: `packages/web/src/lib/command-center/hooks.ts`

- [ ] **Step 1: Create hooks**

```typescript
'use client'

import { useState, useEffect, useCallback } from 'react'
import { api } from '../api'
import type { ProjectWithStats, Task, DecayFilter, CommandTab } from './types'
import { DEFAULT_DECAY_FILTER } from './utils'

const STORAGE_KEYS = {
  decayFilter: 'cuttlefish-decay-filter',
  activeTab: 'cuttlefish-command-tab',
  graphPositions: 'cuttlefish-graph-positions',
}

export function useProjects() {
  const [projects, setProjects] = useState<ProjectWithStats[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    try {
      const data = await api.getProjects()
      setProjects(data)
      setError(null)
    } catch (err: any) {
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { refresh() }, [refresh])

  return { projects, loading, error, refresh }
}

export function useTasks(projectId: string | null) {
  const [tasks, setTasks] = useState<Task[]>([])
  const [loading, setLoading] = useState(false)

  const refresh = useCallback(async () => {
    if (!projectId) { setTasks([]); return }
    setLoading(true)
    try {
      const data = await api.getProjectTasks(projectId)
      setTasks(data)
    } catch { /* silent */ }
    setLoading(false)
  }, [projectId])

  useEffect(() => { refresh() }, [refresh])

  return { tasks, loading, refresh }
}

export function useDecayFilter(): [DecayFilter, (f: DecayFilter) => void] {
  const [filter, setFilter] = useState<DecayFilter>(() => {
    if (typeof window === 'undefined') return DEFAULT_DECAY_FILTER
    try {
      const stored = localStorage.getItem(STORAGE_KEYS.decayFilter)
      return stored ? JSON.parse(stored) : DEFAULT_DECAY_FILTER
    } catch {
      return DEFAULT_DECAY_FILTER
    }
  })

  const updateFilter = useCallback((f: DecayFilter) => {
    setFilter(f)
    localStorage.setItem(STORAGE_KEYS.decayFilter, JSON.stringify(f))
  }, [])

  return [filter, updateFilter]
}

export function useActiveTab(): [CommandTab, (t: CommandTab) => void] {
  const [tab, setTab] = useState<CommandTab>(() => {
    if (typeof window === 'undefined') return 'graph'
    return (localStorage.getItem(STORAGE_KEYS.activeTab) as CommandTab) || 'graph'
  })

  const updateTab = useCallback((t: CommandTab) => {
    setTab(t)
    localStorage.setItem(STORAGE_KEYS.activeTab, t)
  }, [])

  return [tab, updateTab]
}

export function useGraphPositions(): [Record<string, { x: number; y: number }>, (pos: Record<string, { x: number; y: number }>) => void] {
  const [positions, setPositions] = useState<Record<string, { x: number; y: number }>>(() => {
    if (typeof window === 'undefined') return {}
    try {
      const stored = localStorage.getItem(STORAGE_KEYS.graphPositions)
      return stored ? JSON.parse(stored) : {}
    } catch {
      return {}
    }
  })

  const updatePositions = useCallback((pos: Record<string, { x: number; y: number }>) => {
    setPositions(pos)
    localStorage.setItem(STORAGE_KEYS.graphPositions, JSON.stringify(pos))
  }, [])

  return [positions, updatePositions]
}
```

- [ ] **Step 2: Commit**

```bash
git add packages/web/src/lib/command-center/hooks.ts
git commit -m "feat(web): add React hooks for projects, tasks, decay filter, and graph positions"
```

### Task 3.4: Update navigation

**Files:**
- Modify: `packages/web/src/lib/nav.ts`

- [ ] **Step 1: Read current nav.ts to understand exact format**

Read the file, check the import list and NAV_ITEMS array.

- [ ] **Step 2: Add Command Center, remove Kanban**

Add `Radar` to lucide-react imports. Add Command Center as second item (after Home). Remove the Kanban entry.

- [ ] **Step 3: Commit**

```bash
git add packages/web/src/lib/nav.ts
git commit -m "feat(web): add Command Center to nav, remove Kanban"
```

### Task 3.5: Kanban redirect

**Files:**
- Modify: `packages/web/src/app/kanban/page.tsx`

- [ ] **Step 1: Replace kanban page with redirect**

Replace the entire page content with a client-side redirect:

```typescript
'use client'

import { useEffect } from 'react'
import { useRouter } from 'next/navigation'

export default function KanbanRedirect() {
  const router = useRouter()
  useEffect(() => { router.replace('/command') }, [router])
  return null
}
```

- [ ] **Step 2: Commit**

```bash
git add packages/web/src/app/kanban/page.tsx
git commit -m "feat(web): redirect /kanban to /command (Command Center replaces Kanban)"
```

---

## Chunk 4: Web UI - Command Center Page Shell & Dashboard View

### Task 4.1: Command Center page with tab layout

**Files:**
- Create: `packages/web/src/app/command/page.tsx`
- Create: `packages/web/src/components/command-center/attention-badge.tsx`
- Create: `packages/web/src/components/command-center/decay-filter.tsx`

- [ ] **Step 1: Create attention badge component**

```typescript
// attention-badge.tsx
'use client'

export function AttentionBadge({ count }: { count: number }) {
  if (count === 0) return null
  return (
    <span style={{
      display: 'inline-flex',
      alignItems: 'center',
      justifyContent: 'center',
      minWidth: 20,
      height: 20,
      padding: '0 6px',
      borderRadius: 'var(--radius-full)',
      backgroundColor: 'var(--system-red)',
      color: '#fff',
      fontSize: 'var(--text-caption1)',
      fontWeight: 'var(--weight-bold)',
    }}>
      {count}
    </span>
  )
}
```

- [ ] **Step 2: Create decay filter popover**

```typescript
// decay-filter.tsx
'use client'

import { useState, useRef, useEffect } from 'react'
import type { DecayFilter } from '@/lib/command-center/types'

const PRESETS: { label: string; filter: Partial<DecayFilter> }[] = [
  { label: 'Last 24h', filter: { showCompleted: '24h', showIdle: '24h', showErrors: '7d' } },
  { label: 'Last 3 days', filter: { showCompleted: '3d', showIdle: '3d', showErrors: '7d' } },
  { label: 'Last week', filter: { showCompleted: '7d', showIdle: '7d', showErrors: '30d' } },
  { label: 'Everything', filter: { showCompleted: 'all', showIdle: 'all', showErrors: 'all' } },
]

interface Props {
  filter: DecayFilter
  onChange: (filter: DecayFilter) => void
}

export function DecayFilterPopover({ filter, onChange }: Props) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [])

  return (
    <div ref={ref} style={{ position: 'relative' }}>
      <button
        onClick={() => setOpen(!open)}
        style={{
          padding: '6px 12px',
          borderRadius: 'var(--radius-md)',
          border: '1px solid var(--separator)',
          backgroundColor: 'var(--fill-secondary)',
          color: 'var(--text-secondary)',
          fontSize: 'var(--text-caption1)',
          cursor: 'pointer',
        }}
      >
        Filter: {filter.showCompleted === 'all' ? 'Everything' : filter.showCompleted}
      </button>
      {open && (
        <div style={{
          position: 'absolute',
          right: 0,
          top: '100%',
          marginTop: 4,
          padding: 'var(--space-3)',
          borderRadius: 'var(--radius-md)',
          backgroundColor: 'var(--bg)',
          border: '1px solid var(--separator)',
          boxShadow: 'var(--shadow-card)',
          zIndex: 50,
          minWidth: 200,
        }}>
          <div style={{ fontSize: 'var(--text-caption1)', color: 'var(--text-tertiary)', marginBottom: 'var(--space-2)' }}>
            Quick presets
          </div>
          {PRESETS.map(p => (
            <button
              key={p.label}
              onClick={() => {
                onChange({ ...filter, ...p.filter } as DecayFilter)
                setOpen(false)
              }}
              style={{
                display: 'block',
                width: '100%',
                textAlign: 'left',
                padding: '6px 8px',
                borderRadius: 'var(--radius-sm)',
                border: 'none',
                backgroundColor: 'transparent',
                color: 'var(--text-primary)',
                fontSize: 'var(--text-footnote)',
                cursor: 'pointer',
              }}
            >
              {p.label}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
```

- [ ] **Step 3: Create Command Center page shell**

```typescript
// app/command/page.tsx
'use client'

import { useCallback } from 'react'
import { PageLayout } from '@/components/page-layout'
import { useProjects } from '@/lib/command-center/hooks'
import { useDecayFilter, useActiveTab } from '@/lib/command-center/hooks'
import { getTotalAttentionCount, sortProjectsByAttention } from '@/lib/command-center/utils'
import { AttentionBadge } from '@/components/command-center/attention-badge'
import { DecayFilterPopover } from '@/components/command-center/decay-filter'
import { DashboardView } from '@/components/command-center/dashboard-view'
import type { CommandTab } from '@/lib/command-center/types'

const TABS: { key: CommandTab; label: string; shortcut: string }[] = [
  { key: 'graph', label: 'Graph', shortcut: '1' },
  { key: 'dashboard', label: 'Dashboard', shortcut: '2' },
  { key: 'timeline', label: 'Timeline', shortcut: '3' },
]

export default function CommandCenterPage() {
  const { projects, loading, error, refresh } = useProjects()
  const [activeTab, setActiveTab] = useActiveTab()
  const [decayFilter, setDecayFilter] = useDecayFilter()

  const sorted = sortProjectsByAttention(projects)
  const attentionCount = getTotalAttentionCount(projects)

  const handleProjectClick = useCallback((projectId: string) => {
    // TODO: open slide-over panel (Task 6)
    console.log('Open project:', projectId)
  }, [])

  return (
    <PageLayout>
      <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
        {/* Top bar */}
        <div style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: 'var(--space-3) var(--space-4)',
          borderBottom: '1px solid var(--separator)',
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-3)' }}>
            <h1 style={{ fontSize: 'var(--text-title2)', fontWeight: 'var(--weight-bold)', margin: 0 }}>
              Command Center
            </h1>
            <AttentionBadge count={attentionCount} />
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-3)' }}>
            {/* Tab buttons */}
            <div style={{ display: 'flex', gap: 2, borderRadius: 'var(--radius-md)', overflow: 'hidden', border: '1px solid var(--separator)' }}>
              {TABS.map(tab => (
                <button
                  key={tab.key}
                  onClick={() => setActiveTab(tab.key)}
                  style={{
                    padding: '6px 14px',
                    border: 'none',
                    backgroundColor: activeTab === tab.key ? 'var(--accent)' : 'var(--fill-secondary)',
                    color: activeTab === tab.key ? 'var(--accent-contrast)' : 'var(--text-secondary)',
                    fontSize: 'var(--text-caption1)',
                    fontWeight: 'var(--weight-semibold)',
                    cursor: 'pointer',
                  }}
                >
                  {tab.label}
                </button>
              ))}
            </div>
            <DecayFilterPopover filter={decayFilter} onChange={setDecayFilter} />
          </div>
        </div>

        {/* Main view area */}
        <div style={{ flex: 1, overflow: 'hidden' }}>
          {loading && (
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', color: 'var(--text-tertiary)' }}>
              Loading...
            </div>
          )}
          {error && (
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: '100%', gap: 'var(--space-2)' }}>
              <span style={{ color: 'var(--system-red)' }}>Failed to load: {error}</span>
              <button onClick={refresh} style={{ padding: '6px 12px', borderRadius: 'var(--radius-md)', border: '1px solid var(--separator)', cursor: 'pointer' }}>
                Retry
              </button>
            </div>
          )}
          {!loading && !error && activeTab === 'dashboard' && (
            <DashboardView projects={sorted} onProjectClick={handleProjectClick} />
          )}
          {!loading && !error && activeTab === 'graph' && (
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', color: 'var(--text-tertiary)' }}>
              Graph view (Task 5)
            </div>
          )}
          {!loading && !error && activeTab === 'timeline' && (
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', color: 'var(--text-tertiary)' }}>
              Timeline view (Task 7)
            </div>
          )}
        </div>
      </div>
    </PageLayout>
  )
}
```

- [ ] **Step 4: Verify page loads**

Run: `cd ~/Projects/cuttlefish && npm run dev --workspace=packages/web`
Navigate to `/command` - should see the page shell with tab buttons and filter.

- [ ] **Step 5: Commit**

```bash
git add packages/web/src/app/command/ packages/web/src/components/command-center/attention-badge.tsx packages/web/src/components/command-center/decay-filter.tsx
git commit -m "feat(web): add Command Center page shell with tabs, attention badge, and decay filter"
```

### Task 4.2: Dashboard view with project cards

**Files:**
- Create: `packages/web/src/components/command-center/dashboard-view.tsx`
- Create: `packages/web/src/components/command-center/project-card.tsx`

- [ ] **Step 1: Create project card component**

```typescript
// project-card.tsx
'use client'

import type { ProjectWithStats } from '@/lib/command-center/types'

interface Props {
  project: ProjectWithStats
  onClick: () => void
}

export function ProjectCard({ project, onClick }: Props) {
  const { stats } = project
  const hasAttention = stats.attentionCount > 0
  const hasErrors = stats.errorSessions > 0
  const hasRunning = stats.runningSessions > 0
  const isUrgent = hasAttention || hasErrors

  return (
    <button
      onClick={onClick}
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 'var(--space-2)',
        padding: 'var(--space-3)',
        borderRadius: 'var(--radius-md)',
        border: `1px solid ${isUrgent ? project.color : 'var(--separator)'}`,
        borderLeftWidth: 4,
        borderLeftColor: project.color,
        backgroundColor: 'var(--bg)',
        boxShadow: isUrgent ? `0 0 12px ${project.color}33` : 'var(--shadow-subtle)',
        cursor: 'pointer',
        textAlign: 'left',
        width: '100%',
        transition: 'box-shadow 0.2s, border-color 0.2s',
      }}
    >
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)' }}>
          {project.icon && <span style={{ fontSize: 18 }}>{project.icon}</span>}
          <span style={{ fontWeight: 'var(--weight-semibold)', fontSize: 'var(--text-body)', color: 'var(--text-primary)' }}>
            {project.name}
          </span>
        </div>
        <div style={{ display: 'flex', gap: 4 }}>
          {hasRunning && <StatusDot color="var(--system-blue)" pulse />}
          {hasErrors && <StatusDot color="var(--system-red)" />}
          {hasAttention && <StatusDot color="var(--system-orange)" shape="diamond" />}
        </div>
      </div>

      {/* Task summary */}
      <div style={{ fontSize: 'var(--text-caption1)', color: 'var(--text-tertiary)' }}>
        {stats.tasksByStatus.todo > 0 && `${stats.tasksByStatus.todo} todo`}
        {stats.tasksByStatus['in-progress'] > 0 && ` · ${stats.tasksByStatus['in-progress']} in progress`}
        {stats.tasksByStatus.blocked > 0 && ` · ${stats.tasksByStatus.blocked} blocked`}
        {stats.totalSessions === 0 && stats.tasksByStatus.todo === 0 && 'No activity'}
      </div>

      {/* Session count */}
      <div style={{ fontSize: 'var(--text-caption1)', color: 'var(--text-quaternary)' }}>
        {stats.totalSessions} session{stats.totalSessions !== 1 ? 's' : ''}
        {stats.runningSessions > 0 && ` · ${stats.runningSessions} running`}
      </div>
    </button>
  )
}

function StatusDot({ color, pulse, shape }: { color: string; pulse?: boolean; shape?: 'diamond' }) {
  const size = 8
  return (
    <span style={{
      display: 'inline-block',
      width: size,
      height: size,
      backgroundColor: color,
      borderRadius: shape === 'diamond' ? 0 : '50%',
      transform: shape === 'diamond' ? 'rotate(45deg)' : undefined,
      animation: pulse ? 'pulse 2s infinite' : undefined,
    }} />
  )
}
```

- [ ] **Step 2: Create dashboard view**

```typescript
// dashboard-view.tsx
'use client'

import type { ProjectWithStats } from '@/lib/command-center/types'
import { ProjectCard } from './project-card'

interface Props {
  projects: ProjectWithStats[]
  onProjectClick: (projectId: string) => void
}

export function DashboardView({ projects, onProjectClick }: Props) {
  if (projects.length === 0) {
    return (
      <div style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        height: '100%',
        gap: 'var(--space-3)',
        color: 'var(--text-tertiary)',
      }}>
        <span style={{ fontSize: 'var(--text-title3)' }}>No projects yet</span>
        <span style={{ fontSize: 'var(--text-footnote)' }}>Create one to get started.</span>
      </div>
    )
  }

  return (
    <div style={{
      display: 'grid',
      gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))',
      gap: 'var(--space-3)',
      padding: 'var(--space-4)',
      overflow: 'auto',
      height: '100%',
    }}>
      {projects.map(project => (
        <ProjectCard
          key={project.id}
          project={project}
          onClick={() => onProjectClick(project.id)}
        />
      ))}
    </div>
  )
}
```

- [ ] **Step 3: Commit**

```bash
git add packages/web/src/components/command-center/dashboard-view.tsx packages/web/src/components/command-center/project-card.tsx
git commit -m "feat(web): add Dashboard view with project cards, status indicators, and task summaries"
```

---

## Chunk 5: Web UI - Graph View (React Flow)

### Task 5.1: Install React Flow

- [ ] **Step 1: Install dependency**

Run: `cd ~/Projects/cuttlefish/packages/web && npm install @xyflow/react`

- [ ] **Step 2: Commit**

```bash
git add packages/web/package.json packages/web/package-lock.json
git commit -m "chore(web): install @xyflow/react for Command Center graph view"
```

### Task 5.2: Custom project node

**Files:**
- Create: `packages/web/src/components/command-center/project-node.tsx`

- [ ] **Step 1: Create custom React Flow node**

```typescript
// project-node.tsx
'use client'

import { memo } from 'react'
import { Handle, Position, type NodeProps } from '@xyflow/react'
import type { ProjectWithStats } from '@/lib/command-center/types'

interface ProjectNodeData {
  project: ProjectWithStats
}

export const ProjectNode = memo(function ProjectNode({ data }: NodeProps & { data: ProjectNodeData }) {
  const { project } = data
  const { stats } = project
  const hasAttention = stats.attentionCount > 0
  const hasErrors = stats.errorSessions > 0
  const hasRunning = stats.runningSessions > 0
  const isGeneral = project.id === 'general'

  // Scale node size by activity
  const baseSize = 140
  const scale = Math.min(1 + stats.totalSessions * 0.02, 1.6)
  const width = baseSize * scale
  const height = 80 * scale

  return (
    <>
      <Handle type="target" position={Position.Left} style={{ opacity: 0 }} />
      <div
        style={{
          width,
          minHeight: height,
          padding: 'var(--space-2) var(--space-3)',
          borderRadius: 'var(--radius-md)',
          border: `2px ${isGeneral ? 'dashed' : 'solid'} ${project.color}`,
          backgroundColor: 'var(--bg)',
          boxShadow: hasErrors
            ? `0 0 16px var(--system-red)`
            : hasAttention
            ? `0 0 16px var(--system-orange)`
            : 'var(--shadow-subtle)',
          animation: hasAttention ? 'commandPulse 2s infinite' : hasRunning ? 'commandSpin 3s linear infinite' : undefined,
          display: 'flex',
          flexDirection: 'column',
          gap: 4,
          cursor: 'pointer',
        }}
      >
        {/* Header */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          {project.icon && <span style={{ fontSize: 14 }}>{project.icon}</span>}
          <span style={{
            fontWeight: 'var(--weight-semibold)',
            fontSize: 'var(--text-caption1)',
            color: 'var(--text-primary)',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}>
            {project.name}
          </span>
        </div>
        {/* Status line */}
        <div style={{ fontSize: 10, color: 'var(--text-tertiary)', lineHeight: 1.3 }}>
          {stats.runningSessions > 0 && `${stats.runningSessions} active`}
          {stats.tasksByStatus.blocked > 0 && ` · ${stats.tasksByStatus.blocked} blocked`}
          {stats.attentionCount > 0 && ` · ${stats.attentionCount} attention`}
          {stats.totalSessions === 0 && 'Idle'}
        </div>
      </div>
      <Handle type="source" position={Position.Right} style={{ opacity: 0 }} />
    </>
  )
})
```

- [ ] **Step 2: Commit**

```bash
git add packages/web/src/components/command-center/project-node.tsx
git commit -m "feat(web): add custom React Flow project node with status animations"
```

### Task 5.3: Graph view component

**Files:**
- Create: `packages/web/src/components/command-center/graph-view.tsx`

- [ ] **Step 1: Create graph view**

```typescript
// graph-view.tsx
'use client'

import { useCallback, useMemo, useEffect } from 'react'
import {
  ReactFlow,
  MiniMap,
  Controls,
  Background,
  useNodesState,
  useEdgesState,
  type Node,
  type Edge,
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import { ProjectNode } from './project-node'
import { useGraphPositions } from '@/lib/command-center/hooks'
import type { ProjectWithStats, CommandSession } from '@/lib/command-center/types'

const nodeTypes = { project: ProjectNode }

interface Props {
  projects: ProjectWithStats[]
  sessions: CommandSession[]
  onProjectClick: (projectId: string) => void
}

export function GraphView({ projects, sessions, onProjectClick }: Props) {
  const [savedPositions, savePositions] = useGraphPositions()

  // Build nodes from projects
  const initialNodes: Node[] = useMemo(() => {
    return projects.map((project, i) => {
      const saved = savedPositions[project.id]
      // Default: arrange in a grid
      const cols = Math.ceil(Math.sqrt(projects.length))
      const row = Math.floor(i / cols)
      const col = i % cols
      return {
        id: project.id,
        type: 'project',
        position: saved || { x: col * 220, y: row * 140 },
        data: { project },
      }
    })
  }, [projects, savedPositions])

  // Build edges from sessions with multiple project tags
  const initialEdges: Edge[] = useMemo(() => {
    const edgeMap = new Map<string, { source: string; target: string; count: number; hasRunning: boolean }>()
    for (const session of sessions) {
      if (session.projects.length < 2) continue
      const sorted = [...session.projects].sort()
      for (let i = 0; i < sorted.length; i++) {
        for (let j = i + 1; j < sorted.length; j++) {
          const key = `${sorted[i]}→${sorted[j]}`
          const existing = edgeMap.get(key)
          if (existing) {
            existing.count++
            if (session.status === 'running') existing.hasRunning = true
          } else {
            edgeMap.set(key, {
              source: sorted[i],
              target: sorted[j],
              count: 1,
              hasRunning: session.status === 'running',
            })
          }
        }
      }
    }
    return Array.from(edgeMap.entries()).map(([key, data]) => ({
      id: key,
      source: data.source,
      target: data.target,
      style: {
        strokeWidth: Math.min(1 + data.count, 6),
        stroke: 'var(--text-quaternary)',
      },
      animated: data.hasRunning,
    }))
  }, [sessions])

  const [nodes, setNodes, onNodesChange] = useNodesState(initialNodes)
  const [edges, setEdges, onEdgesChange] = useEdgesState(initialEdges)

  // Sync when projects change
  useEffect(() => { setNodes(initialNodes) }, [initialNodes, setNodes])
  useEffect(() => { setEdges(initialEdges) }, [initialEdges, setEdges])

  // Persist positions on drag end
  const onNodeDragStop = useCallback((_: any, node: Node) => {
    savePositions({ ...savedPositions, [node.id]: node.position })
  }, [savedPositions, savePositions])

  const onNodeClick = useCallback((_: any, node: Node) => {
    onProjectClick(node.id)
  }, [onProjectClick])

  if (projects.length === 0) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', color: 'var(--text-tertiary)' }}>
        No projects yet. Create one to get started.
      </div>
    )
  }

  return (
    <div style={{ width: '100%', height: '100%' }}>
      <ReactFlow
        nodes={nodes}
        edges={edges}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onNodeDragStop={onNodeDragStop}
        onNodeClick={onNodeClick}
        nodeTypes={nodeTypes}
        fitView
        minZoom={0.3}
        maxZoom={2}
      >
        <MiniMap />
        <Controls />
        <Background />
      </ReactFlow>
    </div>
  )
}
```

- [ ] **Step 2: Update Command Center page to use GraphView**

In `app/command/page.tsx`, import `GraphView` and replace the graph placeholder:

```typescript
import { GraphView } from '@/components/command-center/graph-view'

// In the render, replace the graph placeholder with:
{!loading && !error && activeTab === 'graph' && (
  <GraphView projects={sorted} sessions={[]} onProjectClick={handleProjectClick} />
)}
```

Note: `sessions` is passed as empty for now - it will be populated when we integrate sessions into the Command Center data flow. The sessions prop is needed for edge computation.

- [ ] **Step 3: Add CSS animations**

Add to `app/globals.css` (or equivalent global stylesheet):

```css
@keyframes commandPulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.7; }
}
```

- [ ] **Step 4: Verify graph renders**

Run dev server, navigate to `/command`, switch to Graph tab. Should see project nodes in a grid layout, draggable, with minimap.

- [ ] **Step 5: Commit**

```bash
git add packages/web/src/components/command-center/graph-view.tsx packages/web/src/app/command/page.tsx
git commit -m "feat(web): add Graph view with React Flow, project nodes, edges, and persistent positions"
```

---

## Chunk 6: Web UI - Slide-Over Panel & Mini-Kanban

### Task 6.1: Slide-over panel

**Files:**
- Create: `packages/web/src/components/command-center/slide-over.tsx`

- [ ] **Step 1: Create slide-over component**

```typescript
// slide-over.tsx
'use client'

import { useEffect, useRef } from 'react'
import { useRouter } from 'next/navigation'
import { api } from '@/lib/api'
import { useTasks } from '@/lib/command-center/hooks'
import { MiniKanban } from './mini-kanban'
import type { ProjectWithStats, CommandSession } from '@/lib/command-center/types'

interface Props {
  project: ProjectWithStats
  sessions: CommandSession[]
  onClose: () => void
  onRefresh: () => void
}

export function SlideOver({ project, sessions, onClose, onRefresh }: Props) {
  const router = useRouter()
  const { tasks, refresh: refreshTasks } = useTasks(project.id)
  const panelRef = useRef<HTMLDivElement>(null)

  // Trap focus + Escape to close
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [onClose])

  const projectSessions = sessions
    .filter(s => s.projects.includes(project.id))
    .sort((a, b) => {
      // attention → running → errors → recent
      if (a.attentionRequired !== b.attentionRequired) return a.attentionRequired ? -1 : 1
      if (a.status === 'running' && b.status !== 'running') return -1
      if (b.status === 'running' && a.status !== 'running') return 1
      if (a.status === 'error' && b.status !== 'error') return -1
      if (b.status === 'error' && a.status !== 'error') return 1
      return new Date(b.lastActivity).getTime() - new Date(a.lastActivity).getTime()
    })
    .slice(0, 20) // paginated: show first 20

  const handleSessionClick = (sessionId: string) => {
    router.push(`/chat?session=${sessionId}`)
  }

  const handleTaskStatusChange = async (taskId: string, status: string) => {
    await api.updateTask(taskId, { status })
    refreshTasks()
    onRefresh()
  }

  const handleAddTask = async (title: string) => {
    await api.createTask(project.id, { title })
    refreshTasks()
    onRefresh()
  }

  return (
    <>
      {/* Backdrop */}
      <div
        onClick={onClose}
        style={{
          position: 'fixed',
          inset: 0,
          backgroundColor: 'rgba(0,0,0,0.3)',
          zIndex: 40,
        }}
      />
      {/* Panel */}
      <div
        ref={panelRef}
        style={{
          position: 'fixed',
          right: 0,
          top: 0,
          bottom: 0,
          width: '40%',
          minWidth: 360,
          maxWidth: 600,
          backgroundColor: 'var(--bg)',
          borderLeft: '1px solid var(--separator)',
          boxShadow: 'var(--shadow-card)',
          zIndex: 50,
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
        }}
      >
        {/* Header */}
        <div style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: 'var(--space-3) var(--space-4)',
          borderBottom: '1px solid var(--separator)',
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)' }}>
            {project.icon && <span style={{ fontSize: 20 }}>{project.icon}</span>}
            <span style={{
              fontWeight: 'var(--weight-bold)',
              fontSize: 'var(--text-title3)',
              color: project.color,
            }}>
              {project.name}
            </span>
          </div>
          <button
            onClick={onClose}
            style={{
              padding: 4,
              border: 'none',
              backgroundColor: 'transparent',
              color: 'var(--text-tertiary)',
              cursor: 'pointer',
              fontSize: 18,
            }}
          >
            ✕
          </button>
        </div>

        {/* Mini-Kanban */}
        <div style={{ flex: '0 0 auto', maxHeight: '45%', overflow: 'auto', borderBottom: '1px solid var(--separator)' }}>
          <MiniKanban
            tasks={tasks}
            onStatusChange={handleTaskStatusChange}
            onAddTask={handleAddTask}
          />
        </div>

        {/* Session list */}
        <div style={{ flex: 1, overflow: 'auto', padding: 'var(--space-3)' }}>
          <div style={{ fontSize: 'var(--text-caption1)', color: 'var(--text-tertiary)', marginBottom: 'var(--space-2)' }}>
            Sessions ({projectSessions.length})
          </div>
          {projectSessions.map(session => (
            <button
              key={session.id}
              onClick={() => handleSessionClick(session.id)}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 'var(--space-2)',
                width: '100%',
                padding: 'var(--space-2)',
                border: 'none',
                borderRadius: 'var(--radius-sm)',
                backgroundColor: 'transparent',
                cursor: 'pointer',
                textAlign: 'left',
              }}
            >
              <SessionStatusDot status={session.status} attentionRequired={session.attentionRequired} />
              <span style={{ flex: 1, fontSize: 'var(--text-footnote)', color: 'var(--text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {session.title || session.employee || session.id.slice(0, 8)}
              </span>
              <span style={{ fontSize: 'var(--text-caption1)', color: 'var(--text-quaternary)', flexShrink: 0 }}>
                {relativeTime(session.lastActivity)}
              </span>
            </button>
          ))}
        </div>
      </div>
    </>
  )
}

function SessionStatusDot({ status, attentionRequired }: { status: string; attentionRequired: boolean }) {
  let color = 'var(--text-quaternary)'
  if (status === 'running') color = 'var(--system-blue)'
  else if (status === 'error') color = 'var(--system-red)'
  else if (attentionRequired) color = 'var(--system-orange)'
  return (
    <span style={{
      display: 'inline-block',
      width: 6,
      height: 6,
      borderRadius: attentionRequired ? 0 : '50%',
      transform: attentionRequired ? 'rotate(45deg)' : undefined,
      backgroundColor: color,
      flexShrink: 0,
    }} />
  )
}

function relativeTime(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime()
  if (ms < 60000) return 'just now'
  if (ms < 3600000) return `${Math.floor(ms / 60000)}m ago`
  if (ms < 86400000) return `${Math.floor(ms / 3600000)}h ago`
  return `${Math.floor(ms / 86400000)}d ago`
}
```

- [ ] **Step 2: Commit**

```bash
git add packages/web/src/components/command-center/slide-over.tsx
git commit -m "feat(web): add slide-over panel with session list and keyboard shortcuts"
```

### Task 6.2: Mini-Kanban

**Files:**
- Create: `packages/web/src/components/command-center/mini-kanban.tsx`

- [ ] **Step 1: Create mini-kanban component**

```typescript
// mini-kanban.tsx
'use client'

import { useState } from 'react'
import type { Task, TaskStatus } from '@/lib/command-center/types'

const COLUMNS: { key: TaskStatus; label: string }[] = [
  { key: 'todo', label: 'Todo' },
  { key: 'in-progress', label: 'In Progress' },
  { key: 'done', label: 'Done' },
  { key: 'blocked', label: 'Blocked' },
]

interface Props {
  tasks: Task[]
  onStatusChange: (taskId: string, status: string) => void
  onAddTask: (title: string) => void
}

export function MiniKanban({ tasks, onStatusChange, onAddTask }: Props) {
  const [newTaskTitle, setNewTaskTitle] = useState('')
  const [adding, setAdding] = useState(false)

  const handleAdd = () => {
    if (!newTaskTitle.trim()) return
    onAddTask(newTaskTitle.trim())
    setNewTaskTitle('')
    setAdding(false)
  }

  return (
    <div style={{
      display: 'grid',
      gridTemplateColumns: `repeat(${COLUMNS.length}, 1fr)`,
      gap: 'var(--space-2)',
      padding: 'var(--space-3)',
      minHeight: 120,
    }}>
      {COLUMNS.map(col => {
        const colTasks = tasks.filter(t => t.status === col.key)
        return (
          <div
            key={col.key}
            onDragOver={e => e.preventDefault()}
            onDrop={e => {
              const taskId = e.dataTransfer.getData('taskId')
              if (taskId) onStatusChange(taskId, col.key)
            }}
            style={{
              display: 'flex',
              flexDirection: 'column',
              gap: 'var(--space-1)',
            }}
          >
            <div style={{
              fontSize: 10,
              fontWeight: 'var(--weight-semibold)',
              color: 'var(--text-tertiary)',
              textTransform: 'uppercase',
              letterSpacing: '0.05em',
              marginBottom: 4,
            }}>
              {col.label} ({colTasks.length})
            </div>
            {colTasks.map(task => (
              <div
                key={task.id}
                draggable
                onDragStart={e => e.dataTransfer.setData('taskId', task.id)}
                style={{
                  padding: '6px 8px',
                  borderRadius: 'var(--radius-sm)',
                  backgroundColor: 'var(--fill-secondary)',
                  fontSize: 'var(--text-caption1)',
                  color: 'var(--text-primary)',
                  cursor: 'grab',
                  borderLeft: task.priority === 'urgent' ? '3px solid var(--system-red)' : task.attentionRequired ? '3px solid var(--system-orange)' : '3px solid transparent',
                }}
              >
                {task.title}
              </div>
            ))}
            {col.key === 'todo' && (
              adding ? (
                <div style={{ display: 'flex', gap: 4 }}>
                  <input
                    autoFocus
                    value={newTaskTitle}
                    onChange={e => setNewTaskTitle(e.target.value)}
                    onKeyDown={e => { if (e.key === 'Enter') handleAdd(); if (e.key === 'Escape') setAdding(false) }}
                    placeholder="Task title..."
                    style={{
                      flex: 1,
                      padding: '4px 6px',
                      fontSize: 'var(--text-caption1)',
                      borderRadius: 'var(--radius-sm)',
                      border: '1px solid var(--separator)',
                      backgroundColor: 'var(--bg)',
                      color: 'var(--text-primary)',
                    }}
                  />
                </div>
              ) : (
                <button
                  onClick={() => setAdding(true)}
                  style={{
                    padding: '4px 8px',
                    fontSize: 'var(--text-caption1)',
                    color: 'var(--text-tertiary)',
                    border: '1px dashed var(--separator)',
                    borderRadius: 'var(--radius-sm)',
                    backgroundColor: 'transparent',
                    cursor: 'pointer',
                  }}
                >
                  + Add task
                </button>
              )
            )}
          </div>
        )
      })}
    </div>
  )
}
```

- [ ] **Step 2: Commit**

```bash
git add packages/web/src/components/command-center/mini-kanban.tsx
git commit -m "feat(web): add mini-Kanban with drag-and-drop task management"
```

### Task 6.3: Wire slide-over into Command Center page

**Files:**
- Modify: `packages/web/src/app/command/page.tsx`

- [ ] **Step 1: Add slide-over state and sessions fetching**

Update the page to:
1. Fetch sessions alongside projects
2. Track selected project for slide-over
3. Render SlideOver when a project is selected

Add imports for `SlideOver`, and add state:

```typescript
const [sessions, setSessions] = useState<CommandSession[]>([])
const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null)

// Fetch sessions
useEffect(() => {
  api.getSessions().then((data: any[]) => {
    setSessions(data.map(s => ({
      id: s.id,
      title: s.title,
      employee: s.employee,
      status: s.status,
      source: s.source,
      projects: s.projects || [],
      attentionRequired: s.attentionRequired || false,
      priority: s.priority || null,
      createdAt: s.createdAt,
      lastActivity: s.lastActivity,
    })))
  }).catch(() => {})
}, [])

const handleProjectClick = useCallback((projectId: string) => {
  setSelectedProjectId(projectId)
}, [])

const selectedProject = projects.find(p => p.id === selectedProjectId) || null
```

Add the SlideOver render at the end (inside the root div):

```typescript
{selectedProject && (
  <SlideOver
    project={selectedProject}
    sessions={sessions}
    onClose={() => setSelectedProjectId(null)}
    onRefresh={refresh}
  />
)}
```

Also pass `sessions` to `GraphView`.

- [ ] **Step 2: Verify end-to-end flow**

Create a test project via API:
```bash
curl -X POST http://0.0.0.0:8888/api/projects -H 'Content-Type: application/json' -d '{"name":"Project A","color":"#3b82f6","icon":"⚖️"}'
```

Navigate to `/command`. Verify:
- Dashboard shows the project card
- Graph shows the project node
- Clicking opens the slide-over
- Mini-Kanban shows (empty, can add tasks)
- Session list shows (filtered by project)

- [ ] **Step 3: Commit**

```bash
git add packages/web/src/app/command/page.tsx
git commit -m "feat(web): wire slide-over panel into Command Center with sessions and project selection"
```

---

## Chunk 7: Web UI - Timeline View

### Task 7.1: Timeline view component

**Files:**
- Create: `packages/web/src/components/command-center/timeline-view.tsx`

- [ ] **Step 1: Create timeline view**

```typescript
// timeline-view.tsx
'use client'

import { useMemo, useState, useRef, useCallback } from 'react'
import type { ProjectWithStats, CommandSession } from '@/lib/command-center/types'

type ZoomLevel = 'hours' | 'days' | 'weeks'

interface Props {
  projects: ProjectWithStats[]
  sessions: CommandSession[]
  onProjectClick: (projectId: string) => void
  onSessionClick: (sessionId: string) => void
}

const LANE_HEIGHT = 48
const LABEL_WIDTH = 160
const ZOOM_PX: Record<ZoomLevel, number> = { hours: 60, days: 120, weeks: 40 }

export function TimelineView({ projects, sessions, onProjectClick, onSessionClick }: Props) {
  const [zoom, setZoom] = useState<ZoomLevel>('days')
  const containerRef = useRef<HTMLDivElement>(null)

  // Compute time range
  const { minTime, maxTime } = useMemo(() => {
    const now = Date.now()
    let min = now - 7 * 86400000 // default 7 days back
    let max = now
    for (const s of sessions) {
      const created = new Date(s.createdAt).getTime()
      const activity = new Date(s.lastActivity).getTime()
      if (created < min) min = created
      if (activity > max) max = activity
    }
    return { minTime: min, maxTime: max + 3600000 } // pad 1h future
  }, [sessions])

  const pxPerMs = useMemo(() => {
    if (zoom === 'hours') return ZOOM_PX.hours / 3600000
    if (zoom === 'days') return ZOOM_PX.days / 86400000
    return ZOOM_PX.weeks / (7 * 86400000)
  }, [zoom])

  const totalWidth = (maxTime - minTime) * pxPerMs
  const nowOffset = (Date.now() - minTime) * pxPerMs

  // Group sessions by project
  const lanes = useMemo(() => {
    return projects.map(project => ({
      project,
      sessions: sessions.filter(s => s.projects.includes(project.id)),
    }))
  }, [projects, sessions])

  if (projects.length === 0) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', color: 'var(--text-tertiary)' }}>
        No projects yet. Create one to get started.
      </div>
    )
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      {/* Zoom controls */}
      <div style={{ display: 'flex', gap: 'var(--space-2)', padding: 'var(--space-2) var(--space-3)', borderBottom: '1px solid var(--separator)' }}>
        {(['hours', 'days', 'weeks'] as ZoomLevel[]).map(z => (
          <button
            key={z}
            onClick={() => setZoom(z)}
            style={{
              padding: '4px 10px',
              fontSize: 'var(--text-caption1)',
              borderRadius: 'var(--radius-sm)',
              border: '1px solid var(--separator)',
              backgroundColor: zoom === z ? 'var(--accent)' : 'transparent',
              color: zoom === z ? 'var(--accent-contrast)' : 'var(--text-secondary)',
              cursor: 'pointer',
            }}
          >
            {z.charAt(0).toUpperCase() + z.slice(1)}
          </button>
        ))}
      </div>

      {/* Swimlanes */}
      <div ref={containerRef} style={{ flex: 1, overflow: 'auto', position: 'relative' }}>
        <div style={{ display: 'flex', minWidth: LABEL_WIDTH + totalWidth }}>
          {/* Labels column */}
          <div style={{ width: LABEL_WIDTH, flexShrink: 0, borderRight: '1px solid var(--separator)', position: 'sticky', left: 0, backgroundColor: 'var(--bg)', zIndex: 10 }}>
            {lanes.map(({ project }) => (
              <button
                key={project.id}
                onClick={() => onProjectClick(project.id)}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 6,
                  height: LANE_HEIGHT,
                  padding: '0 var(--space-2)',
                  border: 'none',
                  borderBottom: '1px solid var(--separator)',
                  backgroundColor: 'transparent',
                  cursor: 'pointer',
                  width: '100%',
                  textAlign: 'left',
                }}
              >
                {project.icon && <span style={{ fontSize: 14 }}>{project.icon}</span>}
                <span style={{ fontSize: 'var(--text-caption1)', color: 'var(--text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {project.name}
                </span>
              </button>
            ))}
          </div>

          {/* Timeline area */}
          <div style={{ position: 'relative', width: totalWidth }}>
            {/* Now marker */}
            <div style={{
              position: 'absolute',
              left: nowOffset,
              top: 0,
              bottom: 0,
              width: 2,
              backgroundColor: 'var(--system-red)',
              zIndex: 5,
            }} />

            {/* Lanes */}
            {lanes.map(({ project, sessions: laneSessions }, laneIdx) => (
              <div key={project.id} style={{
                height: LANE_HEIGHT,
                borderBottom: '1px solid var(--separator)',
                position: 'relative',
              }}>
                {laneSessions.map(session => {
                  const start = (new Date(session.createdAt).getTime() - minTime) * pxPerMs
                  const end = session.status === 'running'
                    ? nowOffset
                    : (new Date(session.lastActivity).getTime() - minTime) * pxPerMs
                  const width = Math.max(end - start, 4)

                  let bgColor = 'var(--text-quaternary)' // idle
                  if (session.status === 'running') bgColor = 'var(--system-blue)'
                  else if (session.status === 'error') bgColor = 'var(--system-red)'
                  else if (session.status === 'idle') bgColor = 'var(--system-green)'

                  const isUrgent = session.priority === 'urgent'

                  return (
                    <button
                      key={session.id}
                      onClick={() => onSessionClick(session.id)}
                      title={`${session.title || session.employee || session.id.slice(0, 8)} (${session.status})`}
                      style={{
                        position: 'absolute',
                        left: start,
                        top: LANE_HEIGHT * 0.25,
                        width,
                        height: isUrgent ? LANE_HEIGHT * 0.5 : LANE_HEIGHT * 0.4,
                        backgroundColor: bgColor,
                        borderRadius: 3,
                        border: 'none',
                        cursor: 'pointer',
                        opacity: 0.8,
                        boxShadow: isUrgent ? `0 0 6px ${bgColor}` : undefined,
                      }}
                    >
                      {session.attentionRequired && (
                        <span style={{
                          position: 'absolute',
                          top: -4,
                          right: -4,
                          width: 6,
                          height: 6,
                          backgroundColor: 'var(--system-orange)',
                          transform: 'rotate(45deg)',
                        }} />
                      )}
                    </button>
                  )
                })}
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}
```

- [ ] **Step 2: Wire into Command Center page**

Import `TimelineView` and replace the timeline placeholder:

```typescript
{!loading && !error && activeTab === 'timeline' && (
  <TimelineView
    projects={sorted}
    sessions={sessions}
    onProjectClick={handleProjectClick}
    onSessionClick={(id) => router.push(`/chat?session=${id}`)}
  />
)}
```

- [ ] **Step 3: Commit**

```bash
git add packages/web/src/components/command-center/timeline-view.tsx packages/web/src/app/command/page.tsx
git commit -m "feat(web): add Timeline view with swimlanes, session bars, zoom levels, and now marker"
```

---

## Chunk 8: Integration & Polish

### Task 8.1: WebSocket real-time updates in Command Center

**Files:**
- Modify: `packages/web/src/app/command/page.tsx`

- [ ] **Step 1: Subscribe to WebSocket events**

Use the existing `useGateway` hook. On relevant events, refresh projects and sessions:

```typescript
import { useGateway } from '@/hooks/use-gateway'

// Inside component:
const { events } = useGateway()

// Refresh on relevant events
useEffect(() => {
  const last = events[events.length - 1]
  if (!last) return
  const relevantEvents = ['session:started', 'session:completed', 'session:deleted', 'session:error', 'session:updated', 'project:created', 'project:updated', 'project:deleted', 'task:created', 'task:updated', 'task:deleted']
  if (relevantEvents.includes(last.event)) {
    refresh()
    // Also refresh sessions
    api.getSessions().then((data: any[]) => {
      setSessions(data.map(s => ({
        id: s.id,
        title: s.title,
        employee: s.employee,
        status: s.status,
        source: s.source,
        projects: s.projects || [],
        attentionRequired: s.attentionRequired || false,
        priority: s.priority || null,
        createdAt: s.createdAt,
        lastActivity: s.lastActivity,
      })))
    }).catch(() => {})
  }
}, [events, refresh])
```

- [ ] **Step 2: Commit**

```bash
git add packages/web/src/app/command/page.tsx
git commit -m "feat(web): add real-time WebSocket updates to Command Center"
```

### Task 8.2: Keyboard shortcuts

**Files:**
- Modify: `packages/web/src/app/command/page.tsx`

- [ ] **Step 1: Add keyboard handler for tab switching**

```typescript
useEffect(() => {
  const handler = (e: KeyboardEvent) => {
    // Don't capture when typing in inputs
    if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return
    if (e.key === '1') setActiveTab('graph')
    else if (e.key === '2') setActiveTab('dashboard')
    else if (e.key === '3') setActiveTab('timeline')
  }
  document.addEventListener('keydown', handler)
  return () => document.removeEventListener('keydown', handler)
}, [setActiveTab])
```

- [ ] **Step 2: Commit**

```bash
git add packages/web/src/app/command/page.tsx
git commit -m "feat(web): add keyboard shortcuts for Command Center tab switching (1/2/3)"
```

### Task 8.3: Session decay filtering integration

**Files:**
- Modify: `packages/web/src/app/command/page.tsx`

- [ ] **Step 1: Filter sessions through decay filter before passing to views**

```typescript
import { shouldShowSession } from '@/lib/command-center/utils'

// After fetching sessions, filter:
const filteredSessions = useMemo(() => {
  const now = Date.now()
  return sessions.filter(s => shouldShowSession(s, decayFilter, now))
}, [sessions, decayFilter])
```

Pass `filteredSessions` instead of `sessions` to all three views and the slide-over.

- [ ] **Step 2: Commit**

```bash
git add packages/web/src/app/command/page.tsx
git commit -m "feat(web): apply smart decay filter to Command Center session views"
```

### Task 8.4: Seed default projects from org departments

**Files:**
- Modify: `packages/cuttlefish/src/gateway/api.ts` (or create a startup migration)

- [ ] **Step 1: Add project seeding on first load**

In the `GET /api/projects` handler, if the projects file doesn't exist or is empty, auto-seed from org departments:

```typescript
// After loading projects, if empty, seed from org
if (projects.length === 0) {
  const orgDir = path.join(os.homedir(), '.cuttlefish', 'org')
  const departments = new Set<string>()
  try {
    const files = fs.readdirSync(orgDir).filter(f => f.endsWith('.yaml') || f.endsWith('.yml'))
    for (const f of files) {
      const content = fs.readFileSync(path.join(orgDir, f), 'utf-8')
      const yaml = require('yaml')
      const emp = yaml.parse(content)
      if (emp?.department) departments.add(emp.department)
    }
  } catch {}

  const colors = ['#3b82f6', '#ef4444', '#10b981', '#f59e0b', '#8b5cf6', '#ec4899', '#06b6d4', '#84cc16', '#f97316']
  let i = 0
  for (const dept of departments) {
    projects.push(createProject({ name: dept.charAt(0).toUpperCase() + dept.slice(1), color: colors[i % colors.length], id: dept }))
    i++
  }
  // Always add "general" as catch-all
  projects.push(createProject({ name: 'General', color: '#6b7280', id: 'general', icon: '📥' }))
  saveProjects(projects, projectsPath)
}
```

- [ ] **Step 2: Verify seeding works**

Delete `~/.cuttlefish/projects.json` if it exists. Hit `GET /api/projects`. Should return projects auto-created from org departments.

- [ ] **Step 3: Commit**

```bash
git add packages/cuttlefish/src/gateway/api.ts
git commit -m "feat(gateway): auto-seed projects from org departments on first load"
```

### Task 8.5: Final verification

- [ ] **Step 1: Run all gateway tests**

Run: `cd ~/Projects/cuttlefish && node --test packages/cuttlefish/src/gateway/projects.test.ts packages/cuttlefish/src/gateway/tasks.test.ts packages/cuttlefish/src/gateway/project-tagger.test.ts`
Expected: All tests PASS

- [ ] **Step 2: Run full build**

Run: `cd ~/Projects/cuttlefish && npm run build 2>&1 | tail -20`
Expected: No errors

- [ ] **Step 3: End-to-end manual smoke test**

1. Start gateway: `cd ~/Projects/cuttlefish && npm run dev --workspace=packages/cuttlefish`
2. Start web: `cd ~/Projects/cuttlefish && npm run dev --workspace=packages/web`
3. Navigate to `/command`
4. Verify: Graph view shows project nodes, draggable, positions persist
5. Verify: Dashboard view shows project cards, sorted by attention
6. Verify: Timeline view shows swimlanes with session bars
7. Verify: Click project → slide-over opens with mini-Kanban + sessions
8. Verify: Add task → appears in Kanban, drag to change status
9. Verify: Decay filter changes which sessions are visible
10. Verify: Keyboard shortcuts (1/2/3) switch tabs
11. Verify: `/kanban` redirects to `/command`

- [ ] **Step 4: Commit any final fixes**

```bash
git add -A
git commit -m "fix: polish and final adjustments for Command Center"
```
