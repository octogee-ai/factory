import type { GatewayMutableConfig } from "@octogee/core/gateway-live-release";

import { prepareGatewayConfigWithWorkloadIdentity } from "./gateway-workload-identity-config.js";

export type ApiServerEgressResolver = () => Promise<string[]>;

export async function prepareGatewayRuntimeConfig<T extends GatewayMutableConfig>(
  config: T,
  gatewayId: string,
  resolveApiServerEgressCidrs: ApiServerEgressResolver,
): Promise<T> {
  const prepared = await prepareGatewayConfigWithWorkloadIdentity(config, gatewayId);
  if (
    prepared.gatewayClass !== "operator" ||
    prepared.operatorAccess?.shellsEnabled !== true
  ) {
    return prepared;
  }
  const kubeApiServerEgressCidrs = await resolveApiServerEgressCidrs();
  if (kubeApiServerEgressCidrs.length === 0) {
    if ((prepared.operatorAccess.kubeApiServerEgressCidrs?.length ?? 0) > 0) {
      return prepared;
    }
    throw new Error(`operator gateway ${gatewayId} has no API-server egress CIDRs`);
  }
  return {
    ...prepared,
    operatorAccess: {
      ...prepared.operatorAccess,
      kubeApiServerEgressCidrs,
    },
  } as T;
}

export function createGatewayRuntimeConfigPreparer(
  resolveApiServerEgressCidrs: ApiServerEgressResolver,
): <T extends GatewayMutableConfig & { gatewayId: string }>(config: T) => Promise<T> {
  return <T extends GatewayMutableConfig & { gatewayId: string }>(config: T) =>
    prepareGatewayRuntimeConfig(
      config,
      config.gatewayId,
      resolveApiServerEgressCidrs,
    );
}
