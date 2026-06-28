export function chatProxyOwnsHttpPath(strippedPath: string): boolean {
  return (
    strippedPath === "/healthz" ||
    strippedPath === "/healthz/bridge" ||
    strippedPath === "/api/openclaw/approval/callback"
  );
}
