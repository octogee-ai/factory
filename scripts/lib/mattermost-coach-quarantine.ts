import { CONFIG_PATCH_DEADLINE_MS } from "../../shared/types/fleet-controller.js";
import {
  applyConfigPatch,
  customerConfigReplacePaths,
  type ConfigCache,
} from "./apply-config-patch.js";
import type { GatewayRpcClient } from "./gateway-rpc.js";
import { updateMattermostAccountSecrets } from "./mattermost-account-secrets.js";
import { OPENCLAW_DIR } from "./config.js";

export async function quarantineMalformedCoachMattermostAccount(
  slug: string,
  rpc: GatewayRpcClient,
  cache: ConfigCache,
  log: (message: string) => void,
): Promise<void> {
  const accountId = `${slug}-coach`;
  const accountPath = `channels.mattermost.accounts.${accountId}`;
  await applyConfigPatch(
    {
      buildPatch: () => ({
        channels: { mattermost: { accounts: { [accountId]: null } } },
      }),
      buildReplacePaths: (current) => customerConfigReplacePaths(current, slug)
        .filter((path) => path === accountPath || path.startsWith(`${accountPath}.`)),
      logPrefix: `[quarantine:${slug}]`,
    },
    {
      rpc,
      cache,
      totalDeadlineMs: CONFIG_PATCH_DEADLINE_MS,
      log,
    },
  );
  await updateMattermostAccountSecrets(OPENCLAW_DIR, {
    remove: [accountId],
    removePrefixes: [],
  });
  log(`[quarantine:${slug}] removed malformed workspace coach account`);
}
