/**
 * Gateway-side integration of the fleet controller architecture.
 *
 *   - Writes `gateways/{gatewayId}` heartbeat every GATEWAY_HEARTBEAT_INTERVAL_MS.
 *   - Starts an HTTPS-ready server on `FLEET_CONTROLLER_PORT` bound to 0.0.0.0
 *     so Cloud Tasks can push jobs in-cluster.
 *   - Composes the production `RestoreAdapter` by wrapping the real
 *     git/blob-sync/apply-config-patch/rpc helpers.
 *
 * Always-on — greenfield, no feature flag. The provisioner calls
 * `startFleetController()` unconditionally at boot.
 *
 * Spec: docs/GATEWAY-FLEET-CONTROLLER-SPEC.md
 */

import express from "express";
import * as fs from "fs";
import * as path from "path";
import { FieldValue, type Firestore } from "firebase-admin/firestore";
import type { Server } from "http";
import {
  GATEWAY_HEARTBEAT_INTERVAL_MS,
  GATEWAYS_COLLECTION,
  type CustomerSnapshot,
} from "../../shared/types/fleet-controller.js";
import { applyConfigPatch } from "./apply-config-patch.js";
import { blobSyncForSlug } from "./blob-sync.js";
import { AGENTS_DIR, CUSTOMERS_DIR } from "./config.js";
import { CREW_IDENTITY } from "./crew.js";
import { createRestoreCustomerHandler, IdempotencyCache } from "./fleet-http.js";
import {
  writeGatewayHeartbeat,
  type FleetStateDeps,
  type FleetStateFirestore,
  type HeartbeatSnapshot,
} from "./fleet-state.js";
import type { GatewayRpcClient } from "./gateway-rpc.js";
import {
  cloneProjectRepo,
  cloneWorkspaceRepo,
  createGiteaUser,
  customerSshKeyPath,
  generateCustomerSshKey,
} from "./git.js";
import {
  buildCustomerAgent,
  buildCustomerBindings,
  buildMattermostAccounts,
  fetchCoachIdentities,
  fetchCoachTokens,
  resolveCoachIdentity,
} from "./openclaw-config-builders.js";
import type { RestoreAdapter } from "./restore-one-customer.js";

// ── Production adapter ──────────────────────────────────────────────────────

export interface BuildAdapterOptions {
  db: Firestore;
  rpc: GatewayRpcClient;
  log: (msg: string) => void;
  adminMmUserId: string | undefined;
}

/**
 * Compose the real `RestoreAdapter` from the existing script helpers. This
 * stays in one place so the seams between the orchestrator and the
 * filesystem / Firestore / RPC are explicit and greppable.
 *
 * Split out from `startFleetController` so tests can construct partial
 * adapters against a real db + mocked rpc, without needing to spin up the
 * full HTTP server.
 */
export function buildProductionAdapter(opts: BuildAdapterOptions): RestoreAdapter {
  const { db, rpc, log, adminMmUserId } = opts;

  return {
    log,

    hasWorkspaceGitDir: (slug) =>
      fs.existsSync(path.join(CUSTOMERS_DIR, slug, ".git")),

    cloneWorkspaceRepo: (slug, repoUrl) => cloneWorkspaceRepo(slug, repoUrl),

    hasCustomerSshKey: (slug) => fs.existsSync(customerSshKeyPath(slug)),
    generateCustomerSshKey: (slug) => generateCustomerSshKey(slug),
    createGiteaUser: (slug, pubKey) => createGiteaUser(slug, pubKey),
    persistGiteaToken: async (uid, username, token) => {
      await db
        .collection("users")
        .doc(uid)
        .collection("system")
        .doc("config")
        .set(
          { gitea: { username, token } },
          { merge: true },
        );
    },

    blobSyncForSlug: (slug) => blobSyncForSlug(slug),

    listProjectsNeedingClone: async (slug) => {
      const projSnap = await db
        .collection("workspaces")
        .doc(slug)
        .collection("projects")
        .get();
      const out: Array<{ projectSlug: string; giteaRepoName: string }> = [];
      for (const doc of projSnap.docs) {
        const data = doc.data();
        const repoName: string | null = data.giteaRepoName ?? null;
        const state: string | undefined = data.provisioningState;
        if (!repoName) continue;
        if (state !== undefined && state !== "active") continue;
        if (fs.existsSync(
          path.join(CUSTOMERS_DIR, slug, "projects", doc.id, ".git"),
        )) continue;
        out.push({ projectSlug: doc.id, giteaRepoName: repoName });
      }
      return out;
    },
    cloneProjectRepo: (customerSlug, projectSlug, giteaRepoName) =>
      cloneProjectRepo(customerSlug, projectSlug, giteaRepoName),

    applyCustomerConfigPatch: async (snapshot: CustomerSnapshot) => {
      // Fetch coach identity + PAT for this one customer. Both helpers take
      // arrays; we just pass [snapshot] to match their contract.
      const [tokens, identities] = await Promise.all([
        fetchCoachTokens(
          { db: db as unknown as never, log },
          [{ uid: snapshot.uid, slug: snapshot.slug }],
        ),
        fetchCoachIdentities(
          { db: db as unknown as never, log },
          [{ uid: snapshot.uid, slug: snapshot.slug }],
        ),
      ]);
      if (!tokens.has(snapshot.uid)) {
        throw new Error(
          `[restore:${snapshot.slug}] no coach PAT in Firestore — re-provision to heal`,
        );
      }

      const accountsMap = buildMattermostAccounts(
        [snapshot],
        tokens,
        adminMmUserId,
        (m) => log(m),
      );
      const accountId = `${snapshot.slug}-coach`;
      const accountEntry = accountsMap[accountId];
      if (!accountEntry) {
        throw new Error(
          `[restore:${snapshot.slug}] buildMattermostAccounts refused to emit account (likely empty allowlist)`,
        );
      }

      const identity = resolveCoachIdentity(identities.get(snapshot.uid), {
        name: CREW_IDENTITY.coach.name,
        emoji: CREW_IDENTITY.coach.emoji,
      });
      const agentEntry = buildCustomerAgent({
        uid: snapshot.uid,
        slug: snapshot.slug,
        businessName: snapshot.businessName,
        customerDir: path.join(CUSTOMERS_DIR, snapshot.slug),
        agentDir: path.join(AGENTS_DIR, `octogee-${snapshot.slug}-coach`, "agent"),
        coach: {
          name: identity.name,
          emoji: identity.emoji,
          model: CREW_IDENTITY.coach.model,
        },
      });
      const bindings = buildCustomerBindings([
        { slug: snapshot.slug, channels: snapshot.channels },
      ]);
      const agentId = `octogee-${snapshot.slug}-coach`;

      const startedAt = Date.now();
      const result = await applyConfigPatch(
        {
          buildPatch: (current) => {
            const currentCfg = current as {
              bindings?: Array<{ agentId?: unknown }>;
            };
            const existingBindings = Array.isArray(currentCfg.bindings)
              ? currentCfg.bindings.filter(
                  (b) => (b as { agentId?: string }).agentId !== agentId,
                )
              : [];
            return {
              agents: { list: [agentEntry] },
              bindings: [...existingBindings, ...bindings],
              channels: {
                mattermost: {
                  accounts: { [accountId]: accountEntry },
                },
              },
            };
          },
          fallback: (cfg) => {
            cfg.agents ??= {};
            cfg.agents.list ??= [];
            const existingAgents = (cfg.agents.list as unknown[]).filter(
              (a) => (a as { id?: string }).id !== agentId,
            );
            cfg.agents.list = [...existingAgents, agentEntry];
            cfg.bindings ??= [];
            const keep = (cfg.bindings as unknown[]).filter(
              (b) => (b as { agentId?: string }).agentId !== agentId,
            );
            cfg.bindings = [...keep, ...bindings];
            cfg.channels ??= {};
            cfg.channels.mattermost ??= {};
            cfg.channels.mattermost.accounts ??= {};
            (cfg.channels.mattermost.accounts as Record<string, unknown>)[accountId] = accountEntry;
          },
          logPrefix: `[restore:${snapshot.slug}]`,
        },
        { rpc },
      );
      return {
        mode: result.mode === "rpc" ? "rpc" : "fallback-file-write",
        elapsedMs: Date.now() - startedAt,
      };
    },

    waitForAccountHealthy: async ({ slug, timeoutMs }) => {
      const accountId = `${slug}-coach`;
      const deadline = Date.now() + timeoutMs;
      let attempt = 0;
      while (Date.now() < deadline) {
        attempt++;
        try {
          const snapshot = (await rpc.channelsStatus()) as {
            channelAccounts?: Record<string, Record<string, unknown>>;
          };
          const mmAccounts = snapshot.channelAccounts?.mattermost ?? {};
          const entry = mmAccounts[accountId] as
            | { running?: boolean; connected?: boolean }
            | undefined;
          if (entry?.running === true && entry?.connected === true) {
            return true;
          }
        } catch {
          // Swallow; retry after backoff.
        }
        await new Promise<void>((r) =>
          setTimeout(r, Math.min(2_000 * attempt, 5_000)),
        );
      }
      return false;
    },
  };
}

// ── Heartbeat + HTTP server ─────────────────────────────────────────────────

export interface StartFleetOptions {
  db: Firestore;
  rpc: GatewayRpcClient;
  gatewayId: string;
  log: (msg: string) => void;
  /** Env-var resolved value. Defaults to 3003 upstream of this call. */
  port: number;
  /** HMAC secret shared with the controller. */
  secret: string;
  /** Gateway build SHA — injected via BUILD_SHA env var. */
  version: string;
  /** `openclaw --version` output. */
  openclawVersion: string;
  /** Admin MM user id for allowlist building. Optional. */
  adminMmUserId?: string;
}

export interface StartedFleetController {
  /** Stop the heartbeat timer + close the HTTP server. Idempotent. */
  stop: () => Promise<void>;
}

export async function startFleetController(
  opts: StartFleetOptions,
): Promise<StartedFleetController> {
  const stateDeps: FleetStateDeps = {
    db: opts.db as unknown as FleetStateFirestore,
    serverTimestamp: () => FieldValue.serverTimestamp(),
    log: opts.log,
  };

  const adapter = buildProductionAdapter({
    db: opts.db,
    rpc: opts.rpc,
    log: opts.log,
    adminMmUserId: opts.adminMmUserId,
  });

  // Local mirror of gateway state so the heartbeat payload is accurate.
  // mountedCustomers reflects what's actually mounted on this pod;
  // markJobDoneAndGatewayAcked updates the Firestore side on completion.
  // We deliberately do NOT track inFlightJobId here — that field is
  // controller-owned (controller sets on enqueue, gateway clears on
  // completion via markJob*AndGatewayAcked). Writing it from the
  // heartbeat would stomp the controller's value every 15s and break
  // pick-next serialization. See §Writer split in the spec.
  const runtime: {
    mountedCustomers: string[];
    status: "booting" | "ready";
  } = {
    mountedCustomers: [],
    status: "booting",
  };

  // Load existing mountedCustomers from Firestore so a pod restart
  // mid-restore doesn't re-mount everyone. The controller will reconcile
  // any drift on next pick-next.
  try {
    const snap = await opts.db
      .collection(GATEWAYS_COLLECTION)
      .doc(opts.gatewayId)
      .get();
    if (snap.exists) {
      const data = snap.data();
      if (Array.isArray(data?.mountedCustomers)) {
        runtime.mountedCustomers = data!.mountedCustomers as string[];
      }
    }
  } catch (err) {
    opts.log(
      `[fleet] ⚠ failed to read existing gateways/${opts.gatewayId}: ${String(err)}`,
    );
  }

  const cache = new IdempotencyCache();

  const emitHeartbeat = async (status: HeartbeatSnapshot["status"]) => {
    try {
      await writeGatewayHeartbeat(stateDeps, {
        gatewayId: opts.gatewayId,
        status,
        version: opts.version,
        openclawVersion: opts.openclawVersion,
        mountedCustomers: runtime.mountedCustomers,
      });
    } catch (err) {
      opts.log(
        `[fleet] ⚠ heartbeat write failed: ${String(err)} — will retry next tick`,
      );
    }
  };

  // Initial "booting" heartbeat — controller knows the pod exists but is
  // not yet ready for jobs. Flips to "ready" once the gateway RPC is up.
  await emitHeartbeat("booting");

  // Background poll: once the gateway RPC answers, transition to ready.
  const waitForGatewayReady = async (): Promise<void> => {
    while (runtime.status !== "ready") {
      try {
        const up = await opts.rpc.isGatewayUp(2_000);
        if (up) {
          runtime.status = "ready";
          opts.log(
            `[fleet] gateway RPC up; transitioning gateways/${opts.gatewayId} to status=ready`,
          );
          await emitHeartbeat("ready");
          return;
        }
      } catch {
        // Ignore; keep polling.
      }
      await new Promise<void>((r) => setTimeout(r, 1_000));
    }
  };
  void waitForGatewayReady();

  // Periodic heartbeat. Keeps gateways/{id}.lastHeartbeatAt fresh even
  // when no jobs are flowing, so the controller's reconciler can
  // distinguish "idle gateway" from "dead gateway".
  const heartbeatTimer = setInterval(() => {
    void emitHeartbeat(runtime.status);
  }, GATEWAY_HEARTBEAT_INTERVAL_MS);

  // HTTP server. Raw body capture is required so the signature verifier
  // can sign against byte-exact bytes.
  const app = express();
  app.use(
    express.json({
      verify: (req: express.Request & { rawBody?: string }, _res, buf) => {
        req.rawBody = buf.toString("utf8");
      },
    }),
  );

  app.get("/health", (_req, res) => {
    res.json({
      status: runtime.status,
      gatewayId: opts.gatewayId,
      mounted: runtime.mountedCustomers.length,
      // inFlightJobId is controller-owned (spec §Writer split); not tracked
      // by the gateway. Reader should query gateways/{id}.inFlightJobId in
      // Firestore for the authoritative answer.
    });
  });

  app.post(
    "/restore-customer",
    createRestoreCustomerHandler({
      secret: opts.secret,
      gatewayId: opts.gatewayId,
      stateDeps,
      adapter: {
        ...adapter,
        // Wrap applyCustomerConfigPatch to track inFlight + mounted state
        // locally so heartbeats stay accurate. Success/failure writes via
        // fleet-state are for controller consumption; these tweaks are
        // for the gateway's own status reporting.
        applyCustomerConfigPatch: async (snapshot) => {
          const result = await adapter.applyCustomerConfigPatch(snapshot);
          if (result.mode === "rpc" || result.mode === "fallback-file-write") {
            if (!runtime.mountedCustomers.includes(snapshot.slug)) {
              runtime.mountedCustomers = [
                ...runtime.mountedCustomers,
                snapshot.slug,
              ];
            }
          }
          return result;
        },
      },
      cache,
      log: opts.log,
    }),
  );

  const server: Server = await new Promise((resolve) => {
    const s = app.listen(opts.port, "0.0.0.0", () => resolve(s));
  });
  opts.log(
    `[fleet] listening on 0.0.0.0:${opts.port}; gatewayId=${opts.gatewayId}`,
  );

  return {
    stop: async () => {
      clearInterval(heartbeatTimer);
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    },
  };
}
