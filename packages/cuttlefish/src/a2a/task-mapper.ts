import os from "node:os";
import { createHash } from "node:crypto";
import {
  Role,
  TaskState,
  type Artifact,
  type Message,
  type Task,
  type TaskStatus,
} from "@a2a-js/sdk";
import type { ApiContext } from "../gateway/api/context.js";
import { listApprovals } from "../gateway/approvals.js";
import { buildSessionJobStateMap } from "../gateway/api/serialize-session.js";
import { CUTTLEFISH_HOME } from "../shared/paths.js";
import { getMessages, getSession, listArtifacts, listSessions, type FileMeta } from "../sessions/registry.js";
import type { A2ATaskProjector, A2ATaskRecord } from "./store.js";
import { textPart } from "./content.js";

function sanitizeText(value: string): string {
  let sanitized = value;
  const paths = [CUTTLEFISH_HOME, process.cwd(), os.homedir()]
    .filter((path, index, all) => path && all.indexOf(path) === index)
    .sort((left, right) => right.length - left.length);
  for (const path of paths) sanitized = sanitized.split(path).join("[redacted-path]");
  return sanitized.slice(0, 512 * 1024);
}

function agentMessage(task: Task, messageId: string, content: string): Message {
  return {
    messageId,
    taskId: task.id,
    contextId: task.contextId,
    role: Role.ROLE_AGENT,
    parts: [textPart(sanitizeText(content))],
    metadata: {},
    extensions: [],
    referenceTaskIds: [],
  };
}

function status(task: Task, state: TaskState, message?: Message, timestamp = new Date().toISOString()): TaskStatus {
  return { state, message, timestamp };
}

function stableArtifact(task: Task, messageId: string, content: string): Artifact {
  const digest = createHash("sha256").update(messageId).digest("hex").slice(0, 16);
  return {
    artifactId: `output-${digest}`,
    name: "Cuttlefish response",
    description: "Final response from the invoked Cuttlefish service.",
    parts: [textPart(sanitizeText(content))],
    metadata: { source: "cuttlefish-session-message" },
    extensions: [],
  };
}

/** Export internal generated files as metadata only; local paths never cross the A2A boundary. */
export function a2aArtifactFromFileMeta(meta: FileMeta): Artifact {
  return {
    artifactId: `file-${meta.id}`,
    name: meta.filename,
    description: "Cuttlefish generated-file metadata. Content transfer is not enabled for this artifact.",
    parts: [{
      content: {
        $case: "data",
        value: {
          artifactId: meta.id,
          filename: meta.filename,
          size: meta.size,
          mediaType: meta.mimetype,
          sha256: meta.sha256,
          artifactKind: meta.artifactKind,
          transferPolicy: "metadata-only",
        },
      },
      metadata: { transferPolicy: "metadata-only" },
      filename: meta.filename,
      mediaType: "application/json",
    }],
    metadata: { transferPolicy: "metadata-only" },
    extensions: [],
  };
}

function generatedFileArtifacts(session: NonNullable<ReturnType<typeof getSession>>): Artifact[] {
  const runId = session.transportMeta?.["employeeRunId"];
  if (typeof runId !== "string" || !runId) return [];
  return listArtifacts({ kind: "generated", producingRunId: runId, limit: 100 }).map(a2aArtifactFromFileMeta);
}

function relatedSessionIds(rootSessionId: string, sessions: ReturnType<typeof listSessions>): string[] {
  const children = new Map<string, string[]>();
  for (const session of sessions) {
    if (!session.parentSessionId) continue;
    const group = children.get(session.parentSessionId) ?? [];
    group.push(session.id);
    children.set(session.parentSessionId, group);
  }
  const ids: string[] = [];
  const seen = new Set<string>();
  const visit = (sessionId: string): void => {
    if (seen.has(sessionId)) return;
    seen.add(sessionId);
    ids.push(sessionId);
    for (const childId of children.get(sessionId) ?? []) visit(childId);
  };
  visit(rootSessionId);
  return ids;
}

function approvalPrompt(task: Task, sessionIds: string[]): Message | undefined {
  const pending = sessionIds.flatMap((sessionId) => listApprovals({ state: "pending", sessionId }));
  if (pending.length === 0) return undefined;
  const first = pending[0]!;
  const payload = first.payload as Record<string, unknown>;
  const safeContext = [payload.decisionNeeded, payload.why]
    .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    .map((value) => sanitizeText(value.trim()));
  const detail = safeContext.length > 0 ? ` ${safeContext.join(" ")}` : "";
  return agentMessage(task, `approval-${first.id}`, `Operator input is required for a pending ${first.type} approval.${detail}`);
}

function latestAssistantMessage(sessionId: string) {
  const messages = getMessages(sessionId);
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]!;
    if (message.role === "assistant" && !message.partial) return message;
  }
  return undefined;
}

/** Project Cuttlefish's durable/live session state into the A2A task lifecycle. */
export function createA2ATaskProjector(context: ApiContext): A2ATaskProjector {
  return async (record: A2ATaskRecord): Promise<Task> => {
    const task = structuredClone(record.task);
    if (record.canceledAt) {
      task.status = status(task, TaskState.TASK_STATE_CANCELED, undefined, record.canceledAt);
      return task;
    }
    // Recovery failures are protocol state, not a live-session projection.
    // Preserve them even when a crash occurred after the session was linked.
    if (typeof task.metadata?.["cuttlefish.dispatchFailedAt"] === "string") return task;
    if (!record.sessionId) return task;
    const session = getSession(record.sessionId);
    if (!session) {
      task.status = status(
        task,
        TaskState.TASK_STATE_FAILED,
        agentMessage(task, `missing-${task.id}`, "The backing Cuttlefish session is no longer available."),
      );
      return task;
    }

    const sessions = listSessions();
    const relatedIds = relatedSessionIds(session.id, sessions);
    const related = new Set(relatedIds);
    const approval = approvalPrompt(task, relatedIds);
    const relatedSessionWaiting = sessions.some((candidate) => related.has(candidate.id) && candidate.status === "waiting");
    if (approval || relatedSessionWaiting) {
      task.status = status(
        task,
        TaskState.TASK_STATE_INPUT_REQUIRED,
        approval ?? agentMessage(task, `input-${task.id}`, "Operator input is required before this task can continue."),
        session.lastActivity,
      );
      return task;
    }

    const jobState = buildSessionJobStateMap(sessions, context).get(session.id);
    if (jobState === "working") {
      task.status = status(task, TaskState.TASK_STATE_WORKING, undefined, session.lastActivity);
      return task;
    }
    if (jobState === "failed" || session.status === "error" || session.status === "interrupted") {
      task.status = status(
        task,
        TaskState.TASK_STATE_FAILED,
        agentMessage(task, `failure-${task.id}`, sanitizeText(session.lastError || "The Cuttlefish task failed.")),
        session.lastActivity,
      );
      return task;
    }

    const response = latestAssistantMessage(session.id);
    if (response || session.totalTurns > 0 || jobState === "finished") {
      const fileArtifacts = generatedFileArtifacts(session);
      if (response) {
        task.artifacts = [stableArtifact(task, response.id, response.content), ...fileArtifacts];
        const message = agentMessage(task, response.id, response.content);
        if (!task.history.some((entry) => entry.messageId === message.messageId)) task.history.push(message);
      } else {
        task.artifacts = fileArtifacts;
      }
      task.status = status(task, TaskState.TASK_STATE_COMPLETED, undefined, session.lastActivity);
      return task;
    }

    task.status = status(task, TaskState.TASK_STATE_SUBMITTED, undefined, session.lastActivity);
    return task;
  };
}

export function canceledA2ATask(task: Task, timestamp = new Date().toISOString()): Task {
  return { ...task, status: status(task, TaskState.TASK_STATE_CANCELED, undefined, timestamp) };
}

export function interruptedDispatchA2ATask(task: Task, timestamp = new Date().toISOString()): Task {
  return {
    ...task,
    metadata: { ...(task.metadata ?? {}), "cuttlefish.dispatchFailedAt": timestamp },
    status: status(
      task,
      TaskState.TASK_STATE_FAILED,
      agentMessage(task, `dispatch-interrupted-${task.id}`, "The gateway restarted before this A2A message obtained a durable dispatch confirmation. Retry with a new messageId."),
      timestamp,
    ),
  };
}
