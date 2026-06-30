import { RUN_LEDGER_DB } from "../shared/paths.js";
import { RunLedgerStore } from "./store.js";

let singleton: { dbPath: string; store: RunLedgerStore } | undefined;

export * from "./store.js";
export * from "./types.js";

export function getRunLedger(dbPath = RUN_LEDGER_DB): RunLedgerStore {
  if (singleton && singleton.dbPath === dbPath) {
    return singleton.store;
  }
  singleton?.store.close();
  singleton = {
    dbPath,
    store: RunLedgerStore.open(dbPath),
  };
  return singleton.store;
}

export function resetRunLedgerForTest(): void {
  singleton?.store.close();
  singleton = undefined;
}
