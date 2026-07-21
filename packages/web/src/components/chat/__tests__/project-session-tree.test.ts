import { describe, expect, it } from "vitest"
import { groupSessionsByProject } from "../project-session-tree"
import type { Session } from "../sidebar-types"

function session(id: string, parentSessionId?: string, lastActivity = `2026-07-21T10:00:0${id.length}.000Z`): Session {
  return {
    id,
    source: "web",
    sourceRef: `web:${id}`,
    parentSessionId,
    title: `Session ${id}`,
    createdAt: lastActivity,
    lastActivity,
  }
}

describe("groupSessionsByProject", () => {
  it("groups a deep session tree under its root and preserves tree depth", () => {
    const projects = groupSessionsByProject([
      session("grandchild", "child"),
      session("other-root"),
      session("root"),
      session("child", "root"),
    ])

    expect(new Set(projects.map((project) => project.rootSessionId))).toEqual(new Set(["other-root", "root"]))
    const project = projects.find((candidate) => candidate.rootSessionId === "root")!
    expect(project.integrity).toBe("valid")
    expect(project.nodes.map((node) => [node.session.id, node.depth])).toEqual([
      ["root", 0],
      ["child", 1],
      ["grandchild", 2],
    ])
  })

  it("keeps missing-parent sessions visible with an orphan warning", () => {
    const projects = groupSessionsByProject([
      session("loaded-top", "missing-root"),
      session("loaded-child", "loaded-top"),
    ])

    expect(projects).toHaveLength(1)
    expect(projects[0].rootSessionId).toBe("loaded-top")
    expect(projects[0].integrity).toBe("orphan")
    expect(projects[0].nodes.map((node) => node.session.id)).toEqual(["loaded-top", "loaded-child"])
  })

  it("contains cycles deterministically without hiding their sessions", () => {
    const projects = groupSessionsByProject([
      session("cycle-b", "cycle-a"),
      session("cycle-a", "cycle-b"),
      session("descendant", "cycle-b"),
    ])

    expect(projects).toHaveLength(1)
    expect(projects[0].rootSessionId).toBe("cycle-a")
    expect(projects[0].integrity).toBe("cycle")
    expect(new Set(projects[0].nodes.map((node) => node.session.id))).toEqual(
      new Set(["cycle-a", "cycle-b", "descendant"]),
    )
  })

  it("aggregates project activity, participants, and attention state", () => {
    const root = session("root")
    root.employee = "program-manager"
    root.status = "running"
    const child = session("child", "root", "2026-07-21T12:00:00.000Z")
    child.employee = "engineering-lead"
    child.jobState = "needs_attention"

    const [project] = groupSessionsByProject([root, child])
    expect(project.lastActivity).toBe("2026-07-21T12:00:00.000Z")
    expect(project.participantIds).toEqual(["engineering-lead", "program-manager"])
    expect(project.runningCount).toBe(1)
    expect(project.needsAttentionCount).toBe(1)
  })
})
