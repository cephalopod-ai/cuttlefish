import type { Session } from "./sidebar-types"

export type ProjectIntegrity = "valid" | "orphan" | "cycle"

export interface ProjectSessionNode {
  session: Session
  depth: number
}

export interface SessionProject {
  rootSessionId: string
  rootSession: Session
  title: string
  lastActivity: string
  sessions: Session[]
  nodes: ProjectSessionNode[]
  participantIds: string[]
  runningCount: number
  needsAttentionCount: number
  integrity: ProjectIntegrity
}

interface ProjectResolution {
  rootSessionId: string
  integrity: ProjectIntegrity
}

const integrityRank: Record<ProjectIntegrity, number> = {
  valid: 0,
  orphan: 1,
  cycle: 2,
}

function sessionActivity(session: Session): string {
  return session.lastActivity || session.createdAt || ""
}

function sessionTitle(session: Session): string {
  const title = session.title?.trim()
  if (title) return title
  const excerpt = session.promptExcerpt?.trim()
  if (excerpt) return excerpt
  return session.employee ? `Project with ${session.employee}` : "Untitled project"
}

function resolveProject(
  start: Session,
  sessionsById: Map<string, Session>,
  memo: Map<string, ProjectResolution>,
): ProjectResolution {
  const path: Session[] = []
  const positions = new Map<string, number>()
  let current = start

  while (true) {
    const cached = memo.get(current.id)
    if (cached) {
      for (const session of path) memo.set(session.id, cached)
      return cached
    }

    const cycleStart = positions.get(current.id)
    if (cycleStart !== undefined) {
      const cycleIds = path.slice(cycleStart).map((session) => session.id)
      const resolution: ProjectResolution = {
        rootSessionId: [...cycleIds].sort()[0] ?? current.id,
        integrity: "cycle",
      }
      for (const session of path) memo.set(session.id, resolution)
      return resolution
    }

    positions.set(current.id, path.length)
    path.push(current)

    const parentId = current.parentSessionId?.trim()
    if (!parentId) {
      const resolution: ProjectResolution = {
        rootSessionId: current.id,
        integrity: "valid",
      }
      for (const session of path) memo.set(session.id, resolution)
      return resolution
    }

    const parent = sessionsById.get(parentId)
    if (!parent) {
      const resolution: ProjectResolution = {
        rootSessionId: current.id,
        integrity: "orphan",
      }
      for (const session of path) memo.set(session.id, resolution)
      return resolution
    }
    current = parent
  }
}

function buildProjectNodes(
  rootSessionId: string,
  projectSessions: Session[],
): ProjectSessionNode[] {
  const projectIds = new Set(projectSessions.map((session) => session.id))
  const children = new Map<string, Session[]>()
  for (const session of projectSessions) {
    const parentId = session.parentSessionId?.trim()
    if (!parentId || !projectIds.has(parentId)) continue
    const siblings = children.get(parentId) ?? []
    siblings.push(session)
    children.set(parentId, siblings)
  }
  for (const siblings of children.values()) {
    siblings.sort((a, b) => sessionActivity(b).localeCompare(sessionActivity(a)))
  }

  const nodes: ProjectSessionNode[] = []
  const seen = new Set<string>()
  const visit = (session: Session, depth: number) => {
    if (seen.has(session.id)) return
    seen.add(session.id)
    nodes.push({ session, depth })
    for (const child of children.get(session.id) ?? []) visit(child, depth + 1)
  }

  const root = projectSessions.find((session) => session.id === rootSessionId)
  if (root) visit(root, 0)
  for (const session of [...projectSessions].sort((a, b) => sessionActivity(b).localeCompare(sessionActivity(a)))) {
    if (!seen.has(session.id)) visit(session, 0)
  }
  return nodes
}

/**
 * Derive presentation-only projects from the durable session graph.
 * A project is one root session plus every loaded recursive descendant. The
 * function never mutates sessions or changes their transport/authority scope.
 */
export function groupSessionsByProject(sessions: Session[]): SessionProject[] {
  const sessionsById = new Map(sessions.map((session) => [session.id, session]))
  const memo = new Map<string, ProjectResolution>()
  const groups = new Map<string, { sessions: Session[]; integrity: ProjectIntegrity }>()

  for (const session of sessions) {
    const resolution = resolveProject(session, sessionsById, memo)
    const existing = groups.get(resolution.rootSessionId)
    if (existing) {
      existing.sessions.push(session)
      if (integrityRank[resolution.integrity] > integrityRank[existing.integrity]) {
        existing.integrity = resolution.integrity
      }
    } else {
      groups.set(resolution.rootSessionId, {
        sessions: [session],
        integrity: resolution.integrity,
      })
    }
  }

  const projects: SessionProject[] = []
  for (const [rootSessionId, group] of groups) {
    const rootSession = sessionsById.get(rootSessionId) ?? group.sessions[0]
    const sortedSessions = [...group.sessions].sort((a, b) => sessionActivity(b).localeCompare(sessionActivity(a)))
    const participants = new Set<string>()
    let runningCount = 0
    let needsAttentionCount = 0
    for (const session of group.sessions) {
      if (session.employee) participants.add(session.employee)
      if (session.status === "running") runningCount += 1
      if (session.jobState === "needs_attention" || session.status === "waiting") needsAttentionCount += 1
    }
    projects.push({
      rootSessionId,
      rootSession,
      title: sessionTitle(rootSession),
      lastActivity: sessionActivity(sortedSessions[0] ?? rootSession),
      sessions: sortedSessions,
      nodes: buildProjectNodes(rootSessionId, group.sessions),
      participantIds: [...participants].sort(),
      runningCount,
      needsAttentionCount,
      integrity: group.integrity,
    })
  }

  projects.sort((a, b) => b.lastActivity.localeCompare(a.lastActivity) || a.title.localeCompare(b.title))
  return projects
}
