import type { IncomingMessage as HttpRequest } from "node:http";
import Busboy from "busboy";

/**
 * One hardened reader for the `multipart/form-data` uploads the gateway accepts.
 *
 * A `limits: { fileSize }` alone bounds one part and nothing else: without a
 * `parts`/`files`/`fields` ceiling a single request can open unbounded parts, a
 * second file part silently displaces the first, an unbounded field value is
 * buffered whole, and the chunks already collected when a limit trips are still
 * held. Every limit here refuses the request rather than truncating it, and the
 * aggregate byte ceiling is enforced twice — once from `Content-Length` before a
 * byte is piped, and again by a streaming counter for a chunked body that
 * declares no length at all.
 */

export interface MultipartLimits {
  /** Ceiling for the single file part. */
  maxFileBytes: number;
  /** Ceiling for one field value. Default 64 KiB. */
  maxFieldBytes?: number;
  /** How many fields the request may carry. Default 32. */
  maxFields?: number;
  /** How many parts (files + fields) the request may carry. Default 40. */
  maxParts?: number;
  /**
   * Slack allowed on top of `maxFileBytes` for headers, boundaries and fields
   * when bounding the whole request. Default 1 MiB.
   */
  overheadBytes?: number;
  /**
   * When set, the file part must be posted under this field name. Left unset by
   * the gateway's own routes: `files: 1` already means only one file part is
   * ever delivered, and pinning the name would refuse third-party callers that
   * have always been accepted.
   */
  fileFieldName?: string;
  /** Caller's wording for the file-too-large refusal. */
  tooLargeMessage?: () => string;
}

export type MultipartOutcome =
  | { ok: true; filename: string; buffer: Buffer; fields: Map<string, string[]> }
  | { ok: false; status: 400 | 413; reason: string };

const DEFAULT_MAX_FIELD_BYTES = 64 * 1024;
const DEFAULT_MAX_FIELDS = 32;
const DEFAULT_MAX_PARTS = 40;
const DEFAULT_OVERHEAD_BYTES = 1024 * 1024;

function declaredContentLength(req: HttpRequest): number | null {
  const raw = req.headers["content-length"];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (typeof value !== "string") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

/**
 * Read exactly one file part plus its accompanying fields, or refuse.
 *
 * Resolves rather than rejects: every refusal is a `{ ok: false }` outcome the
 * caller turns into its own error response, so a malformed body is never an
 * unhandled stream error.
 */
export function readSingleFileMultipart(req: HttpRequest, limits: MultipartLimits): Promise<MultipartOutcome> {
  const maxFieldBytes = limits.maxFieldBytes ?? DEFAULT_MAX_FIELD_BYTES;
  const maxFields = limits.maxFields ?? DEFAULT_MAX_FIELDS;
  const maxParts = limits.maxParts ?? DEFAULT_MAX_PARTS;
  const maxRequestBytes = limits.maxFileBytes + (limits.overheadBytes ?? DEFAULT_OVERHEAD_BYTES);
  const tooLarge = limits.tooLargeMessage?.() ?? `File exceeds ${Math.floor(limits.maxFileBytes / 1024 / 1024)} MB limit`;

  return new Promise((resolve) => {
    const declared = declaredContentLength(req);
    if (declared !== null && declared > maxRequestBytes) {
      resolve({ ok: false, status: 413, reason: tooLarge });
      return;
    }

    let settled = false;
    let chunks: Buffer[] | null = [];
    let collected = 0;
    let filename = "";
    let sawFilePart = false;
    let received = 0;
    const fields = new Map<string, string[]>();

    const busboy = Busboy({
      headers: req.headers,
      limits: {
        fileSize: limits.maxFileBytes,
        files: 1,
        fields: maxFields,
        fieldSize: maxFieldBytes,
        parts: maxParts,
      },
    });

    /** Settle once, drop everything buffered, and stop reading the request. */
    const finish = (outcome: MultipartOutcome): void => {
      if (settled) return;
      settled = true;
      chunks = null;
      try { req.unpipe(busboy); } catch { /* already detached */ }
      // Deliberately NOT busboy.destroy(): tearing the parser down part-way
      // through a part makes it throw "Unexpected end of file" out of its own
      // _destroy, which Node surfaces as an unhandled error rather than as an
      // 'error' event we could absorb. Unpiped and unreferenced, it simply
      // stops being fed and is collected; the buffered remainder is already
      // bounded by the limits above. A no-op listener stays attached so a late
      // parser error from bytes already in flight cannot escape either.
      busboy.removeAllListeners("error");
      busboy.on("error", () => { /* abandoned deliberately */ });
      // Drain the rest of the request so the connection is not left half-read
      // while the caller writes its error response.
      req.resume();
      resolve(outcome);
    };

    const refuse = (status: 400 | 413, reason: string): void => finish({ ok: false, status, reason });

    // A chunked body declares no length, so count what actually arrives too.
    req.on("data", (chunk: Buffer) => {
      received += chunk.length;
      if (received > maxRequestBytes) refuse(413, tooLarge);
    });
    req.on("error", (err: Error) => refuse(400, err.message || "Upload transport failed"));
    // A client that disconnects mid-body never lets busboy reach 'close', so
    // without this the promise would never settle and the handler would leak.
    // `req.complete` distinguishes a truncated body from an ordinary end-of-
    // request close, which busboy is still entitled to finish parsing.
    req.on("close", () => {
      if (settled || req.complete) return;
      refuse(400, "Upload connection closed before the body finished");
    });

    busboy.on("file", (fieldname: string, file: NodeJS.ReadableStream, info: { filename: string }) => {
      if (sawFilePart) {
        refuse(400, "Exactly one file part is accepted");
        return;
      }
      sawFilePart = true;
      if (limits.fileFieldName && fieldname !== limits.fileFieldName) {
        refuse(400, `Unexpected file field "${fieldname}"; the file part must be named "${limits.fileFieldName}"`);
        return;
      }
      filename = info.filename;
      file.on("data", (chunk: Buffer) => {
        if (settled || !chunks) return;
        collected += chunk.length;
        chunks.push(chunk);
      });
      (file as NodeJS.EventEmitter).on("limit", () => refuse(413, tooLarge));
      file.on("error", (err: Error) => refuse(400, err.message || "File part failed"));
    });

    busboy.on("field", (name: string, value: string, info: { nameTruncated: boolean; valueTruncated: boolean }) => {
      if (settled) return;
      if (info.nameTruncated || info.valueTruncated) {
        refuse(413, `Field "${name}" exceeds the ${Math.floor(maxFieldBytes / 1024)} KB limit`);
        return;
      }
      const existing = fields.get(name);
      if (existing) existing.push(value);
      else fields.set(name, [value]);
    });

    busboy.on("filesLimit", () => refuse(400, "Exactly one file part is accepted"));
    busboy.on("fieldsLimit", () => refuse(400, `At most ${maxFields} fields are accepted`));
    busboy.on("partsLimit", () => refuse(400, `At most ${maxParts} parts are accepted`));
    busboy.on("error", (err: unknown) => refuse(400, err instanceof Error ? err.message : "Malformed multipart body"));

    busboy.on("close", () => {
      if (settled) return;
      if (!sawFilePart || !filename || !chunks) {
        refuse(400, "No file provided");
        return;
      }
      const buffer = Buffer.concat(chunks, collected);
      chunks = null;
      finish({ ok: true, filename, buffer, fields });
    });

    req.pipe(busboy);
  });
}

/** First value posted for `name`, or undefined. */
export function firstField(fields: Map<string, string[]>, name: string): string | undefined {
  return fields.get(name)?.[0];
}

/**
 * Tags as both upload routes have always accepted them: repeated `tag` parts,
 * and/or a comma-separated `tags` value. Undefined when neither is present, so
 * a caller that sends no tags keeps writing no tags.
 */
export function collectTagFields(fields: Map<string, string[]>): string[] | undefined {
  const raw = [
    ...(fields.get("tag") ?? []),
    ...(fields.get("tags") ?? []).flatMap((value) => value.split(",")),
  ];
  if (raw.length === 0) return undefined;
  return raw.map((tag) => tag.trim()).filter(Boolean);
}
