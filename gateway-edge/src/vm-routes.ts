import { readFileSync, statSync } from "node:fs";
import { isValidGatewayId } from "@octogee/shared/types/glm";

export type VmRoutes = Record<string, string>;

export function parseVmRoutes(text: string): VmRoutes {
  const parsed = JSON.parse(text) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("vm routes file must be a JSON object of gatewayId -> internal IP");
  }
  const routes: VmRoutes = {};
  for (const [gatewayId, ip] of Object.entries(parsed as Record<string, unknown>)) {
    if (!isValidGatewayId(gatewayId)) throw new Error(`vm routes: invalid gateway id ${gatewayId}`);
    if (typeof ip !== "string" || !/^[0-9a-fA-F.:]+$/.test(ip)) throw new Error(`vm routes: invalid address for ${gatewayId}`);
    routes[gatewayId] = ip;
  }
  return routes;
}

export interface VmRoutesResolverOptions {
  filePath: string;
  edgePort: number;
  readFile?: (path: string) => string;
  mtimeOf?: (path: string) => number | null;
  log: (message: string, meta?: Record<string, unknown>) => void;
  logInfo: (message: string, meta?: Record<string, unknown>) => void;
}

export function createVmRoutesResolver(opts: VmRoutesResolverOptions): (gatewayId: string) => string | undefined {
  const readFile = opts.readFile ?? ((path) => readFileSync(path, "utf8"));
  const mtimeOf = opts.mtimeOf ?? ((path) => {
    try {
      return statSync(path).mtimeMs;
    } catch {
      return null;
    }
  });
  let loadedMtime: number | null | undefined;
  let routes: VmRoutes = {};
  const load = (): VmRoutes => {
    const mtime = mtimeOf(opts.filePath);
    if (mtime === loadedMtime) return routes;
    if (mtime === null) {
      loadedMtime = null;
      routes = {};
      return routes;
    }
    let loaded: VmRoutes;
    try {
      loaded = parseVmRoutes(readFile(opts.filePath));
    } catch (err) {
      opts.log("[gateway-router] vm routes unreadable; keeping the previous table", {
        error: err instanceof Error ? err.message : String(err),
      });
      return routes;
    }
    routes = loaded;
    loadedMtime = mtime;
    opts.logInfo("[gateway-router] vm routes loaded", { count: Object.keys(routes).length });
    return routes;
  };
  return (gatewayId) => {
    const ip = load()[gatewayId];
    if (!ip) return undefined;
    const host = ip.includes(":") ? `[${ip}]` : ip;
    return `http://${host}:${opts.edgePort}`;
  };
}
