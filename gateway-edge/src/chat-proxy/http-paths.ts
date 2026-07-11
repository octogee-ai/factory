export const ACTIVITY_INTAKE_PATH = "/internal/openclaw/activity/v1/events";

export function chatProxyOwnsHttpPath(
  strippedPath: string,
  originalPath: string = strippedPath,
): boolean {
  return (
    strippedPath === "/healthz" ||
    strippedPath === "/healthz/bridge" ||
    strippedPath === "/api/openclaw/approval/callback" ||
    (strippedPath === ACTIVITY_INTAKE_PATH && originalPath === strippedPath)
  );
}
