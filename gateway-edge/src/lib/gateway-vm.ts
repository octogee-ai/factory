export function isGatewayVm(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.GATEWAY_CLASS === "builder" && (env.GATEWAY_RUNTIME_KIND === "gce-vm" ||
    (env.GATEWAY_RUNTIME_KIND === "cluster" && env.GATEWAY_COMPUTER_DESKTOP === "x11"));
}
