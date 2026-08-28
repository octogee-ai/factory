export const VOICE_EVENT_RELAY_PATH = "/internal/openclaw/voice/v1/events";

export function chatProxyOwnsHttpPath(
  strippedPath: string,
  originalPath: string = strippedPath,
): boolean {
  return (
    strippedPath === "/healthz" ||
    /^\/internal\/openclaw\/mattermost\/interactions\/[A-Za-z0-9_-]{1,128}$/.test(strippedPath) ||
    (strippedPath === VOICE_EVENT_RELAY_PATH &&
      originalPath === strippedPath)
  );
}
