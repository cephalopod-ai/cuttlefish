import { authFetch, extractErrorMessage } from "./api-core"

/**
 * UPS-A7: the config client, separated from the generic `get`/`put` because it
 * is the one surface that has to see response headers.
 *
 * `GET /api/config` stamps a revision over the bytes of `config.yaml` as they
 * are on disk. Sending it back on `PUT` is what lets the gateway tell a save
 * that has seen the current file from one that has not, so an edit somebody made
 * at a terminal is not silently overwritten by a Settings page that has been
 * open since before it.
 */

export const CONFIG_REVISION_HEADER = "X-Cuttlefish-Config-Revision"

export interface ConfigDocument {
  config: Record<string, unknown>
  /** Undefined when the gateway predates the revision header. */
  revision: string | undefined
}

/** A save refused because the file moved on. Carries the revision to adopt. */
export class ConfigConflictError extends Error {
  readonly revision: string | undefined

  constructor(message: string, revision: string | undefined) {
    super(message)
    this.name = "ConfigConflictError"
    this.revision = revision
  }
}

export async function getConfigDocument(): Promise<ConfigDocument> {
  const res = await authFetch("/api/config")
  if (!res.ok) throw new Error(await extractErrorMessage(res))
  const config = (await res.json()) as Record<string, unknown>
  return { config, revision: res.headers.get(CONFIG_REVISION_HEADER) ?? undefined }
}

/**
 * Save the config document.
 *
 * `revision` is optional on purpose: a caller performing a partial merge into a
 * document it never read has nothing to clobber, and omitting the header keeps
 * the gateway's pre-existing behavior for it exactly as it was.
 */
export async function putConfigDocument(
  data: Record<string, unknown>,
  revision?: string,
): Promise<{ revision: string | undefined }> {
  const res = await authFetch("/api/config", {
    method: "PUT",
    headers: {
      "Content-Type": "application/json",
      ...(revision ? { [CONFIG_REVISION_HEADER]: revision } : {}),
    },
    credentials: "include",
    body: JSON.stringify(data),
  })

  if (res.status === 409) {
    let message = "config.yaml changed since this page loaded it."
    let current: string | undefined
    try {
      const body = (await res.json()) as { error?: string; revision?: string }
      if (body.error) message = String(body.error)
      if (body.revision) current = String(body.revision)
    } catch {
      // Not JSON — the header below is still authoritative.
    }
    throw new ConfigConflictError(message, current ?? res.headers.get(CONFIG_REVISION_HEADER) ?? undefined)
  }

  if (!res.ok) throw new Error(await extractErrorMessage(res))

  const body = (await res.json().catch(() => ({}))) as { revision?: string }
  return { revision: body.revision ?? res.headers.get(CONFIG_REVISION_HEADER) ?? undefined }
}
