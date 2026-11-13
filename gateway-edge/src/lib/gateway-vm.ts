import { isIsolatedGatewayClassValue } from "@octogee/shared/types/glm";

export function isGatewayVm(env: NodeJS.ProcessEnv = process.env): boolean {
  return isIsolatedGatewayClassValue(env.GATEWAY_CLASS) && (env.GATEWAY_RUNTIME_KIND === "gce-vm" ||
    (env.GATEWAY_RUNTIME_KIND === "cluster" && env.GATEWAY_COMPUTER_DESKTOP === "x11"));
}
