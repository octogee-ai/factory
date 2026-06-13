import { Router, Request, Response, NextFunction } from "express";
import * as fs from "fs";
import * as path from "path";
import { db } from "../lib/db.js";
import {
  coachAgentId,
  deriveByosubHealth,
  byosubConnectionView,
  isSafeGatewayId,
} from "../lib/byosub.js";
import { resolveUserGateway, type ResolvedGateway } from "../lib/user-gateway.js";
import {
  codexAgentDir,
  isSafeAgentId,
  readCodexAuthStateText,
} from "../../../scripts/lib/byosub-restore.js";
import { readAuthProfileStore } from "../../../scripts/lib/auth-profile-sqlite.js";
import { OPENAI_CODEX_DEFAULT_PROFILE_ID } from "../../../scripts/lib/byot-multi-provider-config.js";

// GET /api/g/<gatewayId>/byosub/health — the DEEP byosub durability check.
//
// /api/byosub/connection (cluster) reads only the glmGateways.byosub Firestore
// ref, which survives a reroll/relocation regardless of whether the destination
// pod re-materialized a working credential. This route runs ON the customer's
// own pod (locality seam) and crosses that expectation with pod reality — is the
// auth-profile store actually present, and does codex consider it alive — so a
// silent boot-sync materialization failure reports `missing` instead of a false
// `connected`. It's the durability harness's real proof and fixes the product
// false-"connected" the ref-only read can't catch.

export interface ByosubHealthDeps {
  resolveUserGateway: (uid: string) => Promise<ResolvedGateway | null>;
  localGatewayId: () => string | null;
  isMounted: (slug: string) => boolean;
  readRefProvider: (gatewayId: string, agentId: string) => Promise<string | null>;
  readStorePresent: (agentId: string) => boolean;
  readAuthStateText: (agentId: string) => string | null;
  now: () => number;
}

function requestedGatewayId(req: Request): string | null {
  const raw = (req.params as { gatewayId?: unknown }).gatewayId;
  return typeof raw === "string" && isSafeGatewayId(raw) ? raw : null;
}

function notOnThisPod(res: Response): void {
  res.json({ connected: false, status: "not_on_this_pod" });
}

export function createByosubHealthRouter(deps: ByosubHealthDeps): Router {
  const router = Router({ mergeParams: true });
  router.get(
    "/health",
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const pathGatewayId = requestedGatewayId(req);
        const localGatewayId = deps.localGatewayId();
        // This endpoint is a per-pod proof, not a cluster ref read. It must only
        // answer for the fleet-scoped gateway path that actually reached this pod;
        // otherwise a stale source pod can masquerade as the relocation target.
        if (!pathGatewayId || !localGatewayId || localGatewayId !== pathGatewayId) {
          notOnThisPod(res);
          return;
        }

        const resolved = await deps.resolveUserGateway(req.uid!);
        if (!resolved) {
          res.status(422).json({ connected: false, status: "not_provisioned" });
          return;
        }
        if (resolved.gatewayId !== pathGatewayId) {
          notOnThisPod(res);
          return;
        }
        const agentId = coachAgentId(resolved.slug);
        // The slug can fall back to the client-writable `username`, and below it
        // feeds filesystem paths (codexAgentDir / CUSTOMERS_DIR). isSafeAgentId
        // ([a-z0-9-]{1,64}) on the derived id transitively constrains the slug to
        // a path-safe charset — refuse before any fs access if it doesn't.
        if (!isSafeAgentId(agentId)) {
          res.status(422).json({ connected: false, status: "not_provisioned" });
          return;
        }
        res.json(
          deriveByosubHealth({
            mountedHere: deps.isMounted(resolved.slug),
            refProvider: await deps.readRefProvider(pathGatewayId, agentId),
            storePresent: deps.readStorePresent(agentId),
            authStateText: deps.readAuthStateText(agentId),
            profileId: OPENAI_CODEX_DEFAULT_PROFILE_ID,
            now: deps.now(),
          }),
        );
      } catch (e) {
        next(e);
      }
    },
  );
  return router;
}

const CUSTOMERS_DIR = process.env.CUSTOMERS_DIR ?? "/home/node/.openclaw/customers";
const OPENCLAW_DIR = process.env.OPENCLAW_DIR ?? path.dirname(CUSTOMERS_DIR);

async function readRefProvider(
  gatewayId: string,
  agentId: string,
): Promise<string | null> {
  const snap = await db.collection("glmGateways").doc(gatewayId).get();
  const ref = (
    (snap.data() || {}) as {
      byosub?: Record<string, { provider?: unknown; status?: unknown } | undefined>;
    }
  ).byosub?.[agentId];
  // Single-source the ref-shape parse via byosubConnectionView (the same reader
  // /connection uses); we only need the provider here — the live status comes
  // from the pod store, not this ref.
  return byosubConnectionView(ref).provider ?? null;
}

const byosubHealthRouter = createByosubHealthRouter({
  resolveUserGateway,
  localGatewayId: () => process.env.GATEWAY_ID?.trim() || null,
  isMounted: (slug) => fs.existsSync(path.join(CUSTOMERS_DIR, slug)),
  readRefProvider,
  readStorePresent: (agentId) =>
    readAuthProfileStore(codexAgentDir(OPENCLAW_DIR, agentId)) !== null,
  // null (empty OR unreadable state) maps to healthy-by-design: this endpoint's
  // contract is store-PRESENCE, and deriveByosubHealth only reaches the auth-state
  // read once storePresent is true. A corrupt-but-present store reading healthy is
  // the boundary of store-presence scope — the deferred 1-token probe is what would
  // catch it.
  readAuthStateText: (agentId) => readCodexAuthStateText(OPENCLAW_DIR, agentId),
  now: () => Date.now(),
});

export default byosubHealthRouter;
