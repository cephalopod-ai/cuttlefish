export function safePathSegment(value: string, label = "path segment"): string {
  const safe = value.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  if (!safe) throw new Error(`invalid ${label}: ${value}`);
  return safe.slice(0, 80);
}
