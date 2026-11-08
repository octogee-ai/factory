import { accountAllowsInteractiveAccess } from "@octogee/shared/types/account-lifecycle";
import { readGatewayAuthorizationInStore } from "@octogee/core/gateway-live-release";
import type { BuilderTierReader } from "@octogee/core/builder-activation-lease";
import type { BuilderRecord, PlatformStateStore } from "@octogee/core/platform-state";
import {
  perUserOwnerUid,
  principalAccess,
  withGatewayOwnerTier,
  workspaceScopeFor,
} from "../routes/builder/gateways.js";

export interface ConnectorReviewerAccessDeps {
  store: PlatformStateStore;
  readBuilderTier: BuilderTierReader;
  now: () => number;
}

function interactive(builder: BuilderRecord | null): boolean {
  return accountAllowsInteractiveAccess(builder ? { accountLifecycle: builder.accountLifecycle ?? undefined } : undefined);
}

export async function connectorReviewerHasWorkspaceAccess(
  deps: ConnectorReviewerAccessDeps,
  data: Record<string, unknown>,
  uid: string,
): Promise<boolean> {
  const { ownerUid, gatewayId } = data;
  if (typeof ownerUid !== "string" || typeof gatewayId !== "string") return false;
  const [owner, reviewer] = await Promise.all([deps.store.builders.records.get(ownerUid), deps.store.builders.records.get(uid)]);
  if (!interactive(owner) || !interactive(reviewer)) return false;
  if (uid === ownerUid) return true;
  const auth = await readGatewayAuthorizationInStore(deps.store, gatewayId);
  if (!auth) return false;
  return withGatewayOwnerTier(
    { store: deps.store, readBuilderTier: deps.readBuilderTier, ownerUid: perUserOwnerUid(auth), now: deps.now() },
    async (ownerTier) => {
      const scope = await workspaceScopeFor(auth, auth.config.builderSlug, deps.store, true);
      if (!scope || scope.ownerUid !== ownerUid || data.agentId !== `octogee-${scope.workspaceSlug}-coach`) return false;
      return (await principalAccess(scope, uid, deps.store, ownerTier)).kind === "member";
    },
  );
}
