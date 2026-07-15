import { pathToFileURL } from "node:url";

import { openClawConfigPath } from "../lib/openclaw-config-path.js";
import { validateOpenClawConfig } from "../lib/openclaw-config-validation.js";
import { syncSystemConfigForSlug } from "../lib/system-config.js";
import { createSystemConfigWatcher } from "../lib/system-config-watcher.js";

export type SystemConfigWatchPlan =
  | { action: "skip"; reason: "shared-gateway" }
  | { action: "watch"; slug: string; configPath: string };

export function resolveSystemConfigWatchPlan(
  env: NodeJS.ProcessEnv = process.env,
): SystemConfigWatchPlan {
  const gatewayClass = env.GATEWAY_CLASS ?? env.GATEWAY_PROFILE ?? "";
  if (gatewayClass === "shared" || gatewayClass === "standard" || gatewayClass === "") {
    return { action: "skip", reason: "shared-gateway" };
  }
  const slug = env.GATEWAY_BUILDER_SLUG?.trim();
  if (!slug) throw new Error("GATEWAY_BUILDER_SLUG is required for durable config watch");
  const explicitPath = env.OPENCLAW_CONFIG_PATH?.trim();
  if (!explicitPath) throw new Error("OPENCLAW_CONFIG_PATH is required for durable config watch");
  const configPath = openClawConfigPath(env);
  if (!configPath.endsWith("/system_config/openclaw.json")) {
    throw new Error(`OPENCLAW_CONFIG_PATH is not the system_config checkout: ${configPath}`);
  }
  return { action: "watch", slug, configPath };
}

export function runSystemConfigWatch(env: NodeJS.ProcessEnv = process.env): void {
  const plan = resolveSystemConfigWatchPlan(env);
  if (plan.action === "skip") return;
  const watcher = createSystemConfigWatcher({
    configPath: plan.configPath,
    sync: async () => syncSystemConfigForSlug(plan.slug, {
      log: (message) => console.log(message),
      validateConfig: validateOpenClawConfig,
    }),
    log: (message) => console.error(message),
  });
  const close = () => {
    watcher.close();
    process.exit(0);
  };
  process.once("SIGTERM", close);
  process.once("SIGINT", close);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    runSystemConfigWatch();
  } catch (error) {
    console.error(`[system_config] watcher fatal: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}
