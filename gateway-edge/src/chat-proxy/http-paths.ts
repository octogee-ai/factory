export const ACTIVITY_INTAKE_PATH = "/internal/openclaw/activity/v1/events";
export const SCHEDULED_ANCHOR_ADMISSION_PATH = "/internal/openclaw/activity/v1/scheduled-anchor";
export const VOICE_EVENT_RELAY_PATH = "/internal/openclaw/voice/v1/events";

export function chatProxyOwnsHttpPath(
  strippedPath: string,
  originalPath: string = strippedPath,
): boolean {
  return (
    strippedPath === "/healthz" ||
    strippedPath === "/healthz/bridge" ||
    strippedPath === "/internal/openclaw/agent-control/callback" ||
    /^\/internal\/openclaw\/mattermost\/interactions\/[A-Za-z0-9_-]{1,128}$/.test(strippedPath) ||
    ((strippedPath === ACTIVITY_INTAKE_PATH || strippedPath === SCHEDULED_ANCHOR_ADMISSION_PATH || strippedPath === VOICE_EVENT_RELAY_PATH) &&
      originalPath === strippedPath)
  );
}
