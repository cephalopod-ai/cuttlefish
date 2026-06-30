import { z } from "zod";

export const LINEAGE_RELATION_TYPES = ["parent", "derived_from", "version_of", "source"] as const;
export const QUARANTINE_STATES = ["active", "resolved"] as const;

export const lineageRelationTypeSchema = z.enum(LINEAGE_RELATION_TYPES);
export const quarantineStateSchema = z.enum(QUARANTINE_STATES);

export const artifactRecordSchema = z.object({
  artifactId: z.string().min(1),
  canonicalKind: z.string().min(1),
  locator: z.string().nullable(),
  sha256: z.string().nullable(),
  sizeBytes: z.number().nullable(),
  mimeType: z.string().nullable(),
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1),
}).strict();

export const artifactVersionSchema = z.object({
  versionId: z.string().min(1),
  artifactId: z.string().min(1),
  locator: z.string().nullable(),
  sha256: z.string().nullable(),
  createdAt: z.string().min(1),
  note: z.string().nullable(),
}).strict();

export const sourceReferenceSchema = z.object({
  refId: z.string().min(1),
  artifactId: z.string().min(1),
  sourceKind: z.string().min(1),
  sourceId: z.string().nullable(),
  sourceLocator: z.string().nullable(),
  createdAt: z.string().min(1),
}).strict();

export const lineageEdgeSchema = z.object({
  edgeId: z.string().min(1),
  fromArtifactId: z.string().min(1),
  toArtifactId: z.string().min(1),
  relationType: lineageRelationTypeSchema,
  runId: z.string().nullable(),
  createdAt: z.string().min(1),
}).strict();

export const quarantineRecordSchema = z.object({
  recordId: z.string().min(1),
  artifactId: z.string().nullable(),
  reason: z.string().min(1),
  runId: z.string().nullable(),
  createdAt: z.string().min(1),
  resolvedAt: z.string().nullable(),
}).strict();

export const runArtifactXrefSchema = z.object({
  xrefId: z.string().min(1),
  runId: z.string().min(1),
  artifactId: z.string().min(1),
  relation: z.string().min(1),
  createdAt: z.string().min(1),
}).strict();

export type LineageRelationType = z.infer<typeof lineageRelationTypeSchema>;
export type ArtifactRecord = z.infer<typeof artifactRecordSchema>;
export type ArtifactVersion = z.infer<typeof artifactVersionSchema>;
export type SourceReference = z.infer<typeof sourceReferenceSchema>;
export type LineageEdge = z.infer<typeof lineageEdgeSchema>;
export type QuarantineRecord = z.infer<typeof quarantineRecordSchema>;
export type RunArtifactXref = z.infer<typeof runArtifactXrefSchema>;

export interface RegisterArtifactInput {
  artifactId: string;
  canonicalKind: string;
  locator?: string | null;
  sha256?: string | null;
  sizeBytes?: number | null;
  mimeType?: string | null;
  producingRunId?: string | null;
  createdAt?: string;
}

export interface AddLineageEdgeInput {
  fromArtifactId: string;
  toArtifactId: string;
  relationType: LineageRelationType;
  runId?: string | null;
  createdAt?: string;
}

export interface AddQuarantineRecordInput {
  artifactId?: string | null;
  reason: string;
  runId?: string | null;
  createdAt?: string;
}
