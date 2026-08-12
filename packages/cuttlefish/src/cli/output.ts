export interface CliErrorPayload {
  status: "error";
  message: string;
}

export function cliErrorPayload(error: unknown): CliErrorPayload {
  return {
    status: "error",
    message: error instanceof Error ? error.message : String(error),
  };
}

/** Keep every --json failure machine-readable on stdout. */
export function printCliError(error: unknown, json = false): void {
  const payload = cliErrorPayload(error);
  if (json) console.log(JSON.stringify(payload));
  else console.error(payload.message);
  process.exitCode = 1;
}
