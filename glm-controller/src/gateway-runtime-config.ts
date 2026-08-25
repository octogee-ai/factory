import type { GatewayMutableConfig } from "@octogee/core/gateway-live-release";

export type ApiServerEgressResolver = () => Promise<string[]>;

export async function prepareGatewayRuntimeConfig<T extends GatewayMutableConfig>(
  config: T,
  gatewayId: string,
  resolveApiServerEgressCidrs: ApiServerEgressResolver,
): Promise<T> {
  if (config.gatewayClass !== "builder") {
    return config;
  }
  const builderAccess = config.builderAccess ?? {};
  const kubeApiServerEgressCidrs = await resolveApiServerEgressCidrs();
  if (kubeApiServerEgressCidrs.length === 0) {
    if ((builderAccess.kubeApiServerEgressCidrs?.length ?? 0) > 0) {
      return config;
    }
    throw new Error(`builder gateway ${gatewayId} has no API-server egress CIDRs`);
  }
  return {
    ...config,
    builderAccess: {
      ...builderAccess,
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
