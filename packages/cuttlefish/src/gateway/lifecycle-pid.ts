/** PID files identify one process; reject partial parses and process-group values. */
export function parseGatewayPid(contents: string): number | null {
  const value = contents.trim();
  if (!/^\d+$/.test(value)) return null;
  const pid = Number(value);
  return Number.isInteger(pid) && pid > 0 && pid <= 0x7fffffff ? pid : null;
}
