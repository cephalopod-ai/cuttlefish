import { ARTIFACT_LINEAGE_DB } from "../shared/paths.js";
import { ArtifactLineageStore } from "./store.js";

let singleton: { dbPath: string; store: ArtifactLineageStore } | undefined;

export * from "./store.js";
export * from "./types.js";

export function getArtifactLineage(dbPath = ARTIFACT_LINEAGE_DB): ArtifactLineageStore {
  if (singleton && singleton.dbPath === dbPath) {
    return singleton.store;
  }
  singleton?.store.close();
  singleton = {
    dbPath,
    store: ArtifactLineageStore.open(dbPath),
  };
  return singleton.store;
}

export function resetArtifactLineageForTest(): void {
  singleton?.store.close();
  singleton = undefined;
}
