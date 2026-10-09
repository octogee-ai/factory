import * as path from "node:path";

export function builderToolchainRoot(env: NodeJS.ProcessEnv = process.env): string {
  return env.OCTOGEE_BUILDER_TOOLCHAIN_ROOT?.trim() || path.join(env.HOME?.trim() || "/home/node", ".octogee", "toolchains");
}
