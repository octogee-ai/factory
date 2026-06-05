
import { isValidGatewayId } from "../../../shared/types/glm.js";

const FLEET_PREFIX = "/api/g/";

export function stripGatewayPrefix(urlPath: string): string {
  if (!urlPath.startsWith(FLEET_PREFIX)) return urlPath;
  const rest = urlPath.slice(FLEET_PREFIX.length); 
  const slashIdx = rest.indexOf("/");
  const gwId = slashIdx === -1 ? rest : rest.slice(0, slashIdx);

  if (!isValidGatewayId(gwId)) return urlPath;

  if (slashIdx === -1) return "/";
  return rest.slice(slashIdx);
}

export function applyGatewayPrefixStripInPlace(
  req: { url?: string | undefined | null },
): string {
  const original = req.url || "";
  const qIdx = original.indexOf("?");
  const rawPath = qIdx === -1 ? original : original.slice(0, qIdx);
  const query = qIdx === -1 ? "" : original.slice(qIdx);
  const strippedPath = stripGatewayPrefix(rawPath);
  if (strippedPath !== rawPath) {
    req.url = strippedPath + query;
  }
  return strippedPath;
}
