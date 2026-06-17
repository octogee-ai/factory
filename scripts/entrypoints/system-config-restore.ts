import { restoreSystemConfigForSlug } from "../lib/system-config.js";

function log(msg: string): void {
  const ts = new Date().toISOString().replace("Z", "+00:00");
  console.log(`${ts} [system_config] ${msg}`);
}

async function main(): Promise<void> {
  const gatewayClass = process.env.GATEWAY_CLASS ?? process.env.GATEWAY_PROFILE ?? "";
  if (gatewayClass === "shared" || gatewayClass === "standard" || gatewayClass === "") {
    log(`skipping restore for shared/standard gateway class (${gatewayClass || "unset"})`);
    return;
  }

  const slug = process.env.GATEWAY_BUILDER_SLUG?.trim();
  if (!slug) {
    log(`skipping restore for ${gatewayClass}: GATEWAY_BUILDER_SLUG is unset`);
    return;
  }

  const result = await restoreSystemConfigForSlug(slug, { log });
  if (result.skipped) {
    log(`restore skipped: ${result.skipped}`);
  }
}

main().catch((err) => {
  console.error(`[system_config] Warning: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(0);
});
