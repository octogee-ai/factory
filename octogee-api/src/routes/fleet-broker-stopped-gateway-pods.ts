import type { Request, Response, Router } from "express";

import type { GatewayPodExists } from "../lib/gateway-pod-presence.js";

type GatewayBinding = Extract<Express.Request["boundTenant"], { kind: "gateway" }>;

const MAX_HOSTNAMES = 8;
const MAX_HOSTNAME_LENGTH = 63;

const REPLICA_SET_POD_SUFFIX = /^[a-z0-9]{1,10}-[a-z0-9]{5}$/u;

function isDeploymentPodOf(gatewayId: string, hostname: string): boolean {
  const prefix = `octogee-gateway-${gatewayId}-`;
  return hostname.length <= MAX_HOSTNAME_LENGTH && hostname.startsWith(prefix) &&
    REPLICA_SET_POD_SUFFIX.test(hostname.slice(prefix.length));
}

function requestedHostnames(body: unknown, bound: GatewayBinding): string[] | null {
  const hostnames = (body as { hostnames?: unknown } | undefined)?.hostnames;
  if (!Array.isArray(hostnames) || hostnames.length === 0 || hostnames.length > MAX_HOSTNAMES) return null;
  const valid = hostnames.every((hostname) => typeof hostname === "string" &&
    isDeploymentPodOf(bound.gatewayId, hostname) && hostname !== bound.podName);
  return valid ? [...new Set(hostnames as string[])] : null;
}

export function installStoppedGatewayPodsRoute(router: Router, deps: {
  bound: (req: Request, res: Response) => GatewayBinding | null;
  podExists: GatewayPodExists;
}): void {
  router.post("/stopped-gateway-pods", async (req, res) => {
    const bound = deps.bound(req, res);
    if (!bound) return;
    const hostnames = requestedHostnames(req.body, bound);
    if (!hostnames) {
      res.status(400).json({ error: "invalid_gateway_pod_hostnames" });
      return;
    }
    try {
      const stopped: string[] = [];
      for (const hostname of hostnames) {
        if (!await deps.podExists(hostname)) stopped.push(hostname);
      }
      res.json({ stopped });
    } catch (error) {
      res.status(502).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });
}
