import { stop } from "../gateway/lifecycle.js";

export async function runStop(port?: number): Promise<void> {
  const stopped = stop(port);
  if (stopped) {
    console.log("Gateway stopped.");
  } else {
    console.log("Gateway is not running.");
  }
}
