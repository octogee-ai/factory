export const AUTOMATION_AUTHORIZATION_TIMEOUT_MS = 5_000;
export const AUTOMATION_OPENCLAW_CONNECT_TIMEOUT_MS = 10_000;
export const AUTOMATION_OPENCLAW_RPC_TIMEOUT_MS = 10_000;
export const AUTOMATION_READ_CLIENT_TIMEOUT_MS = 15_000;

const AUTOMATION_READ_METHODS = new Set([
  "cron.list",
  "cron.runs",
  "heartbeat.get",
]);

export function hasAutomationReadClientDeadline(method: string): boolean {
  return AUTOMATION_READ_METHODS.has(method);
}
