import { authFetch } from "@/lib/auth"

export async function extractErrorMessage(res: Response): Promise<string> {
  try {
    const body = await res.json()
    if (body.error) return String(body.error)
    if (body.message) return String(body.message)
  } catch {
    // Response wasn't JSON — fall through
  }
  return `API error: ${res.status}`
}

export async function get<T>(path: string): Promise<T> {
  const res = await authFetch(path)
  if (!res.ok) throw new Error(await extractErrorMessage(res))
  return res.json()
}

export async function post<T>(path: string, body?: unknown): Promise<T> {
  const res = await authFetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: body ? JSON.stringify(body) : undefined,
  })
  if (!res.ok) throw new Error(await extractErrorMessage(res))
  return res.json()
}

export async function del<T>(path: string): Promise<T> {
  const res = await authFetch(path, { method: "DELETE" })
  if (!res.ok) throw new Error(await extractErrorMessage(res))
  return res.json()
}

export async function put<T>(path: string, body: unknown): Promise<T> {
  const res = await authFetch(path, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify(body),
  })
  if (!res.ok) throw new Error(await extractErrorMessage(res))
  return res.json()
}

export async function patch<T>(path: string, body: unknown): Promise<T> {
  const res = await authFetch(path, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify(body),
  })
  if (!res.ok) throw new Error(await extractErrorMessage(res))
  return res.json()
}

export { authFetch }
