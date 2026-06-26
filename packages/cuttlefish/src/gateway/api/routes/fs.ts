import type { ServerResponse } from "node:http";
import { CUTTLEFISH_HOME } from "../../../shared/paths.js";
import { listRecentCwds } from "../../../sessions/registry.js";
import type { ApiContext } from "../context.js";
import { json } from "../responses.js";
import { FsBrowseError, listDirectory } from "../../fs-browse.js";

export async function handleFsRoutes(
  method: string,
  pathname: string,
  url: URL,
  res: ServerResponse,
  context: ApiContext,
): Promise<boolean> {
  if (method === "GET" && pathname === "/api/fs/list") {
    const config = context.getConfig();
    const requested = url.searchParams.get("path") ?? undefined;
    const defaultDir = config.workspaces?.defaultCwd || CUTTLEFISH_HOME;
    try {
      json(res, listDirectory(requested, { roots: config.workspaces?.roots, defaultDir }));
    } catch (err) {
      if (err instanceof FsBrowseError) {
        json(res, { error: err.message }, err.status);
        return true;
      }
      throw err;
    }
    return true;
  }

  if (method === "GET" && pathname === "/api/fs/recent") {
    const config = context.getConfig();
    const defaultDir = config.workspaces?.defaultCwd || CUTTLEFISH_HOME;
    json(res, { default: defaultDir, recent: listRecentCwds(8) });
    return true;
  }

  return false;
}
