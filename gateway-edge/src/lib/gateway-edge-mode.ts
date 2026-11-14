export type GatewayEdgeMode = "sidecar" | "router" | "agent-control-router";

export function gatewayEdgeMode(env: Record<string, string | undefined> = process.env): GatewayEdgeMode {
  const mode = env.GATEWAY_EDGE_MODE;
  return mode === "router" || mode === "agent-control-router" ? mode : "sidecar";
}
