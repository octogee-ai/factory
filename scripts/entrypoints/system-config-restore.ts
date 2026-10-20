import { createServiceLogger } from "@octogee/shared/server/service-logger";
const runtimeLogger = createServiceLogger("system-config-restore");
import { discardInterruptedClaimAdoption, restoreSystemConfigForSlug } from "../lib/system-config.js";
import { pathToFileURL } from "node:url";
import {
  DEFAULT_OPENCLAW_DIR,
  builderClaimSlug,
  markBuilderClaimAdopted,
  readBuilderClaimFromEnv,
} from "@octogee/shared/server/builder-claim";

const log = runtimeLogger.info;

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

  const slug = builderClaimSlug(env);
  if (!slug) {
    return {
      action: "skip",
      gatewayClass,
      reason: `skipping restore for ${gatewayClass}: this gateway has no Builder claim`,
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

  const env = opts.env ?? process.env;
  const openclawDir = env.OPENCLAW_DIR?.trim() || DEFAULT_OPENCLAW_DIR;
  const claim = readBuilderClaimFromEnv(env);
  if (claim?.adoptionPending) {
    logger(`[system_config] resuming ${plan.slug}'s interrupted standby claim: discarding the standby system_config`);
    discardInterruptedClaimAdoption(openclawDir, claim.generation);
  }
  const result = await (opts.restore ?? restoreSystemConfigForSlug)(plan.slug, { log: logger, openclawDir });
  if (result.skipped) {
    throw new Error(`durable system_config restore failed: ${result.skipped}`);
  }
  if (!result.restored || !result.configPath) {
    throw new Error("durable system_config restore did not produce an active config path");
  }
  if (claim?.adoptionPending) {
    markBuilderClaimAdopted(openclawDir, claim.gatewayId);
    logger(`[system_config] ${plan.slug}'s standby claim adopted its durable system_config on boot`);
  }
  return plan;
}

async function main(): Promise<void> {
  await runSystemConfigRestore();
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    runtimeLogger.error(`[system_config] Fatal: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
}
