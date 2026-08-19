import { randomUUID } from "node:crypto";

import { signFleetRequest } from "@octogee/core/fleet-signature";
import {
  FLEET_STATE_PATH,
  SIGNATURE_HEADER,
  type FleetStateRequestBody,
} from "@octogee/shared/types/fleet-controller";

import { parseFleetStateResponse, type GatewayFleetState } from "./gateway-heartbeat-poller.js";

export interface FleetStateFetcherDeps {
  privateKey: string;
  resolveBaseUrl: (gatewayId: string) => string;
  timeoutMs: number;
  log: (message: string) => void;
  fetchImpl?: typeof fetch;
  newRequestId?: () => string;
}

// A pod that answers but refuses is a different failure from a pod that is gone,
// and only the poller can tell them apart: an unreachable gateway is routine (rolls,
// preemption), while a rejected read means the fleet keypair or the pod's build is
// wrong and every heartbeat this gateway owes will silently stall until it is fixed.
export function describeFleetStateRejection(status: number): string {
  if (status === 401 || status === 403) {
    return "the pod rejected the fleet controller signature — the pod's " +
      "FLEET_CONTROLLER_PUBLIC_KEY does not match Cowboy's signing key";
  }
  if (status === 404) {
    return "the pod has no /fleet-state route — it predates the signed roster read " +
      "and must be rolled";
  }
  if (status === 400) {
    return "the pod refused the addressed gatewayId — Cowboy and the pod disagree " +
      "about which gateway answers here";
  }
  return "the pod refused the fleet state read";
}

// Reported on change only: these polls run per gateway on a timer, so a persistent
// fault must stay one log line rather than a per-tick flood.
function createOutcomeReporter(
  log: (message: string) => void,
): (gatewayId: string, outcome: string, message: string) => void {
  const lastOutcome = new Map<string, string>();
  return (gatewayId, outcome, message) => {
    if (lastOutcome.get(gatewayId) === outcome) return;
    lastOutcome.set(gatewayId, outcome);
    log(message);
  };
}

// Cowboy is the only holder of the fleet controller private key, so this signed
// read is what separates the trusted fleet authority from any pod that the
// gateway ingress policy lets reach the controller port.
export function createFleetStateFetcher(
  deps: FleetStateFetcherDeps,
): (gatewayId: string) => Promise<GatewayFleetState | null> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const newRequestId = deps.newRequestId ?? randomUUID;
  const report = createOutcomeReporter(deps.log);
  return async (gatewayId) => {
    const body: FleetStateRequestBody = { requestId: newRequestId(), gatewayId };
    const rawBody = JSON.stringify(body);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), deps.timeoutMs);
    try {
      const res = await fetchImpl(
        `${deps.resolveBaseUrl(gatewayId)}${FLEET_STATE_PATH}/${gatewayId}`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            [SIGNATURE_HEADER]: signFleetRequest(deps.privateKey, body.requestId, rawBody),
          },
          body: rawBody,
          signal: controller.signal,
        },
      );
      if (!res.ok) {
        report(
          gatewayId,
          `rejected:${res.status}`,
          `[gateway-poll] ⚠ ${gatewayId}: fleet state read returned HTTP ${res.status} — ` +
            `${describeFleetStateRejection(res.status)}; heartbeats stall until this is fixed`,
        );
        return null;
      }
      const state = parseFleetStateResponse(await res.json());
      if (!state) {
        report(
          gatewayId,
          "malformed",
          `[gateway-poll] ⚠ ${gatewayId}: fleet state body is malformed — treating as unreachable`,
        );
        return null;
      }
      report(gatewayId, "ok", `[gateway-poll] ${gatewayId}: fleet state read healthy`);
      return state;
    } catch (error) {
      report(
        gatewayId,
        "unreachable",
        `[gateway-poll] ${gatewayId}: fleet state read failed — ` +
          `${error instanceof Error ? error.message : String(error)}`,
      );
      return null;
    } finally {
      clearTimeout(timer);
    }
  };
}
