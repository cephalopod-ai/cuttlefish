export type ViewMode = "chat" | "cli";

/** Minimal key-value store interface — satisfied by `localStorage` and by test fakes. */
export interface KVStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export function viewModeKey(sessionId: string): string {
  return `cuttlefish-view-mode-${sessionId}`;
}

function defaultStore(): KVStore | null {
  return typeof localStorage !== "undefined" ? localStorage : null;
}

export function readViewMode(sessionId: string, store: KVStore | null = defaultStore()): ViewMode {
  const raw = store?.getItem(viewModeKey(sessionId));
  return raw === "cli" ? "cli" : "chat";
}

export function writeViewMode(sessionId: string, mode: ViewMode, store: KVStore | null = defaultStore()): void {
  store?.setItem(viewModeKey(sessionId), mode);
}
