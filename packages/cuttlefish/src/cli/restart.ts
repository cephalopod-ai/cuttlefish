import fs from "node:fs";
import { CUTTLEFISH_HOME } from "../shared/paths.js";
import { restartDetached } from "../gateway/lifecycle.js";

/**
 * `cuttlefish restart` — race-free, in-session-safe gateway restart.
 *
 * Forks a detached helper that does stop → wait-for-port-free → start out of
 * band, so it survives the gateway killing its own sessions. Safe to run from
 * inside a Cuttlefish chat session: this command returns immediately, the helper
 * brings the gateway back, and the gateway resumes the interrupted session.
 */
export async function runRestart(): Promise<void> {
  if (!fs.existsSync(CUTTLEFISH_HOME)) {
    console.error(`Error: ${CUTTLEFISH_HOME} does not exist. Run "cuttlefish setup" first.`);
    process.exit(1);
  }

  restartDetached();
  console.log("Gateway restarting in the background (detached). It will be back in a few seconds.");
}
