import { restoreSystemConfigForSlug } from "../lib/system-config.js";
import { pathToFileURL } from "node:url";

function log(msg: string): void {
  const ts = new Date().toISOString().replace("Z", "+00:00");
  console.log(`${ts} [system_config] ${msg}`);
}

export type SystemConfigRestorePlan =
  | { action: "restore"; gatewayClass: string; slug: string }
  | { action: "skip"; gatewayClass: string; reason: string };

export function resolveSystemConfigRestorePlan(
  env: NodeJS.ProcessEnv = process.env,
): SystemConfigRestorePlan {
  const gatewayClass = env.GATEWAY_CLASS ?? env.GATEWAY_PROFILE ?? "";
  if (gatewayClass === "shared" || gatewayClass === "standard" || gatewayClass === "") {
    return {
      action: "skip",
      gatewayClass,
      reason: `skipping restore for shared/standard gateway class (${gatewayClass || "unset"})`,
    };
  }

  const slug = env.GATEWAY_BUILDER_SLUG?.trim();
  if (!slug) {
    return {
      action: "skip",
      gatewayClass,
      reason: `skipping restore for ${gatewayClass}: GATEWAY_BUILDER_SLUG is unset`,
    };
  }

  return { action: "restore", gatewayClass, slug };
}

export async function runSystemConfigRestore(
  opts: {
    env?: NodeJS.ProcessEnv;
    log?: (msg: string) => void;
    restore?: typeof restoreSystemConfigForSlug;
  } = {},
): Promise<SystemConfigRestorePlan> {
  const logger = opts.log ?? log;
  const plan = resolveSystemConfigRestorePlan(opts.env);
  if (plan.action === "skip") {
    logger(plan.reason);
    return plan;
  }

  const result = await (opts.restore ?? restoreSystemConfigForSlug)(plan.slug, { log: logger });
  if (result.skipped) {
    logger(`restore skipped: ${result.skipped}`);
  }
  return plan;
}

async function main(): Promise<void> {
  await runSystemConfigRestore();
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(`[system_config] Warning: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(0);
  });
}
