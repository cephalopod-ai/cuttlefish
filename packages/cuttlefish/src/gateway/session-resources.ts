import type { Session } from "../shared/types.js";
import {
  buildResolvedRunAttachments,
  enrichRunAttachmentsForSession,
  listRunAttachments,
  mergeRunAttachments,
  resolveIncomingRunAttachments,
  screenRunAttachmentsForSession,
  setRunAttachmentsOnTransportMeta,
} from "./run-attachments.js";
import { fileIdsToMedia, rehomeAttachmentsToSession } from "./files.js";
import { patchSessionTransportMeta } from "../sessions/registry.js";
import type { ApiContext } from "./api/context.js";

function combinedResourceSpecs(body: Record<string, unknown>): unknown[] {
  const attachments = Array.isArray(body.attachments) ? body.attachments : [];
  const resources = Array.isArray(body.resources) ? body.resources : [];
  return [...attachments, ...resources];
}

export interface DescribedSessionResources {
  promptBlock: string | null;
  engineAttachments: string[];
  blocked: boolean;
}

export interface AttachedSessionResources extends DescribedSessionResources {
  session: Session;
}

export async function attachResourcesToSession(
  session: Session,
  body: Record<string, unknown>,
  context: ApiContext,
): Promise<AttachedSessionResources> {
  const existing = enrichRunAttachmentsForSession(session);
  const incomingSpecs = combinedResourceSpecs(body);
  if (incomingSpecs.length === 0) {
    const resolved = buildResolvedRunAttachments(existing);
    return { session, ...resolved };
  }

  const legacyFileIds = Array.isArray(body.attachments)
    ? body.attachments.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
    : [];

  // Validate the complete incoming set before mutating attachment storage. The
  // legacy string-id path re-homes files into the target session; doing that
  // before validating sibling resource objects can leave files moved even
  // though the API request is rejected.
  const validatedIncoming = await resolveIncomingRunAttachments(incomingSpecs, context);
  if (legacyFileIds.length > 0) rehomeAttachmentsToSession(legacyFileIds, session.id);

  const incoming = legacyFileIds.length > 0
    ? await resolveIncomingRunAttachments(incomingSpecs, context)
    : validatedIncoming;
  const merged = mergeRunAttachments(existing, incoming);
  const screened = await screenRunAttachmentsForSession(
    session,
    merged,
    context,
    typeof body.prompt === "string"
      ? body.prompt
      : typeof body.message === "string"
        ? body.message
        : session.promptExcerpt ?? session.title ?? null,
  );
  // Read-merge-write inside one transaction (not a pre-`await` snapshot of
  // session.transportMeta), including resource additions committed while this
  // request was screening. Preserve both those additions and unrelated meta.
  const updated = patchSessionTransportMeta(session.id, (current) =>
    setRunAttachmentsOnTransportMeta(current, mergeRunAttachments(listRunAttachments({ transportMeta: current }), screened)),
  ) ?? session;
  return { session: updated, ...describeSessionResources(updated) };
}

export function describeSessionResources(session: Session): DescribedSessionResources {
  return buildResolvedRunAttachments(enrichRunAttachmentsForSession(session));
}

/** Restore allowed session resources when a durable queue item is replayed.
 * A checkpoint may resume reconsideration without releasing quarantined files;
 * that is not permission to pass the blocked resource set to an engine. */
export function queuedSessionResourceOptions(session: Session): { attachments?: string[]; resourceContext?: string | null } {
  const resources = describeSessionResources(session);
  if (resources.blocked) return {};
  return {
    attachments: resources.engineAttachments.length > 0 ? resources.engineAttachments : undefined,
    resourceContext: resources.promptBlock,
  };
}

export function attachmentMedia(body: Record<string, unknown>) {
  return fileIdsToMedia(Array.isArray(body.attachments) ? body.attachments : undefined);
}
