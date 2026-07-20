
import express, { Request, Response } from "express";
import { Registry, collectDefaultMetrics, Counter, Histogram } from "prom-client";

import { corsMiddleware } from "../../gateway-edge/src/middleware/cors.js";
import { requestLogger, logger } from "../../gateway-edge/src/middleware/logging.js";
import { errorHandler } from "../../gateway-edge/src/middleware/errors.js";
import {
  helmetMiddleware,
  globalRateLimit,
  internalRateLimit,
} from "../../gateway-edge/src/middleware/security.js";

import { mountClusterRoutes } from "../../gateway-edge/src/routes/mount-cluster-routes.js";
import internalBillingRoutes from "../../gateway-edge/src/routes/internal/billing.js";
import internalGiteaAdminRoutes from "../../gateway-edge/src/routes/internal/gitea-admin.js";
import { createDefaultActivityPairReportRoutes } from "./routes/activity-pair-report.js";
import { installBodyParsers } from "../../gateway-edge/src/middleware/body-parsers.js";
import { validateStripePriceIds } from "../../gateway-edge/src/lib/stripe-price-ids.js";
import { createEmailMetrics, setEmailMetrics } from "../../gateway-edge/src/lib/email-metrics.js";
import { mattermostMintRoutes, mmRestProxyHandler } from "./routes/mattermost-proxy.js";
import { createOpenClawRuntimeBrokerRoutes } from "./routes/openclaw-runtime-broker.js";
import { createConnectorTokenBrokerRoutes } from "./routes/connector-token-broker.js";
import { createGatewayPodOwnerIdentityReader } from "./lib/gateway-pod-owner-identity.js";
import { createByokBrokerRoutes } from "./routes/byok-broker.js";
import { createAgentProjectRoutes } from "./routes/agent-projects.js";
import { createAgentSupportRoutes } from "./routes/agent-support.js";
import { createAgentAccessRoutes } from "./routes/agent-access.js";
import { createFleetBrokerRoutes } from "./routes/fleet-broker.js";
import { createBuilderShellBrokerRoutes } from "./routes/builder-shell-broker.js";
import { createOpenClawControlBrokerRoutes } from "./routes/openclaw-control-broker.js";
import { createAutomationAuthorizationBrokerRoutes } from "./routes/automation-authorization-broker.js";
import { createAgentImportBrokerRoutes } from "./routes/agent-import-broker.js";
import { createModelKeyIssuerRoutes } from "./routes/model-key-issuer.js";
import { createLinkPreviewRoutes } from "./routes/link-preview.js";
import {
  createChatArtifactRoutes,
  createChatArtifactWorkerRoutes,
  requireArtifactWorkerAuth,
} from "./routes/chat-artifacts.js";
import { ArtifactRegistry, createFirestoreArtifactJobStore } from "./lib/chat-artifact-registry.js";
import {
  createGcsArtifactBlobStore,
  createMattermostArtifactAccess,
  createMattermostArtifactSourceReader,
} from "./lib/chat-artifact-adapters.js";
import { resolveActiveArtifactWorkspaceSlug } from "./lib/chat-artifact-workspace.js";
import { db, storage } from "../../gateway-edge/src/lib/db.js";
import { readConnectorAccessToken } from "../../gateway-edge/src/lib/connector-tokens.js";
import { githubListRepos, githubRepoApi } from "../../gateway-edge/src/lib/github.js";
import { readAgent } from "../../gateway-edge/src/lib/firestoreReads.js";
import { syncCoachIdentity } from "../../gateway-edge/src/lib/coach-identity.js";
import { requireAuth, requireAuthenticatedUid } from "../../gateway-edge/src/middleware/auth.js";
import { createKubernetesTokenReviewer } from "./lib/token-review.js";
import {
  createTenantBindingHealthState,
  startTenantBindingSelfCheck,
} from "./lib/tenant-binding-health.js";
import {
  createTenantBindingMiddleware,
  createTenantBindingMetrics,
} from "./middleware/tenant-binding.js";
import { createTenantEnforcementMiddleware } from "./middleware/tenant-enforcement.js";
import type { ModelBrokerTokenStore } from "./lib/model-broker-tokens.js";
import {
  createOpsAgentHttpClient,
  type AskOpsAgent,
} from "./lib/ops-agent-client.js";
import {
  createCachedOpsAgentModelResolver,
  type OpsAgentModelResolver,
} from "./lib/platform-model-config.js";
import { normalizeTenantPolicyPath } from "./lib/tenant-route-policy.js";

const PORT = parseInt(process.env.PORT || "3001", 10);
const TENANT_BOUND_API_ROUTES = new Set([
  "/api/model-credentials/subscription/auth-state",
  "/api/model-credentials/subscription/capture",
  "/api/model-credentials/subscription/sync-back",
  "/api/notifications/ingest",
]);

export interface CreateAppOptions {
  tenantBindingReviewer?: Parameters<typeof createTenantBindingMiddleware>[0]["reviewer"];
  tenantBindingSelfCheck?: {
    inCluster?: boolean;
    tokenPath?: string;
  };
  modelKeyTokenStore?: ModelBrokerTokenStore;
  modelKeyIssuerBearerToken?: string;
  modelKeyIssuerTtlSeconds?: number | null;
  askOpsAgent?: AskOpsAgent;
  resolveOpsAgentModel?: OpsAgentModelResolver;
}

function defaultChatArtifactRoutes() {
  const registry = new ArtifactRegistry(createFirestoreArtifactJobStore(db));
  let blobs: ReturnType<typeof createGcsArtifactBlobStore> | undefined;
  const blobStore = {
    put(input: Parameters<ReturnType<typeof createGcsArtifactBlobStore>["put"]>[0]) {
      blobs ??= createGcsArtifactBlobStore(storage.bucket());
      return blobs.put(input);
    },
    open(output: Parameters<ReturnType<typeof createGcsArtifactBlobStore>["open"]>[0]) {
      blobs ??= createGcsArtifactBlobStore(storage.bucket());
      return blobs.open(output);
    },
    delete(output: Parameters<ReturnType<typeof createGcsArtifactBlobStore>["delete"]>[0]) {
      blobs ??= createGcsArtifactBlobStore(storage.bucket());
      return blobs.delete(output);
    },
  };
  let access: ReturnType<typeof createMattermostArtifactAccess> | undefined;
  let source: ReturnType<typeof createMattermostArtifactSourceReader> | undefined;
  const mattermostOptions = () => ({
    mattermostBaseUrl: process.env.MM_INTERNAL_URL ?? "",
    adminToken: process.env.MM_ADMIN_TOKEN ?? "",
    resolveWorkspaceSlugForTeamId: (teamId: string) =>
      resolveActiveArtifactWorkspaceSlug(db, teamId),
  });
  return {
    public: createChatArtifactRoutes({
      registry,
      blobs: blobStore,
      auth: requireAuth,
      access: {
        authorizeRequest(userId, request) {
          access ??= createMattermostArtifactAccess(mattermostOptions());
          return access.authorizeRequest(userId, request);
        },
        assertChannelMember(userId, channelId) {
          access ??= createMattermostArtifactAccess(mattermostOptions());
          return access.assertChannelMember(userId, channelId);
        },
      },
    }),
    worker: createChatArtifactWorkerRoutes({
      registry,
      blobs: blobStore,
      auth: requireArtifactWorkerAuth,
      source: {
        open(fileId) {
          source ??= createMattermostArtifactSourceReader(mattermostOptions());
          return source.open(fileId);
        },
      },
    }),
  };
}

export function shouldAttemptTenantBinding(path: string): boolean {
  const normalized = normalizeTenantPolicyPath(path);
  if (normalized === "/internal" || normalized.startsWith("/internal/")) return true;
  return TENANT_BOUND_API_ROUTES.has(normalized);
}

export function shouldEnforceTenantBinding(req: Request): boolean {
  if (!shouldAttemptTenantBinding(req.path)) return false;
  return Boolean(req.boundTenant || req.get("x-k8s-sa-token"));
}

export function createApp(opts: CreateAppOptions = {}) {
  // Fail the rollout, not customer checkouts, if the stripe-secrets price_ids
  // value is malformed JSON.
  validateStripePriceIds();

  const app = express();
  let agentImportBucket: ReturnType<typeof storage.bucket> | undefined;
  const importBucket = {
    file(path: string) {
      agentImportBucket ??= storage.bucket();
      return agentImportBucket.file(path);
    },
    deleteFiles(options: { prefix: string }) {
      agentImportBucket ??= storage.bucket();
      return agentImportBucket.deleteFiles(options);
    },
  };
  // client → GCLB (appends client-ip, lb-ip) → this app
  app.set("trust proxy", 2);

  const metricsRegistry = new Registry();
  collectDefaultMetrics({ register: metricsRegistry });

  const httpRequestDuration = new Histogram({
    name: "http_request_duration_seconds",
    help: "Duration of HTTP requests in seconds",
    labelNames: ["method", "route", "status"] as const,
    buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
    registers: [metricsRegistry],
  });

  const httpRequestTotal = new Counter({
    name: "http_requests_total",
    help: "Total number of HTTP requests",
    labelNames: ["method", "route", "status"] as const,
    registers: [metricsRegistry],
  });

  setEmailMetrics(createEmailMetrics(metricsRegistry));
  const tenantBindingMetrics = createTenantBindingMetrics(metricsRegistry);
  const tenantBindingReviewer = opts.tenantBindingReviewer ?? createKubernetesTokenReviewer();
  const tenantBindingHealth = createTenantBindingHealthState();
  const tenantBindingMiddleware = createTenantBindingMiddleware({
    reviewer: tenantBindingReviewer,
    metrics: tenantBindingMetrics,
  });
  const tenantEnforcementMiddleware = createTenantEnforcementMiddleware({ db });
  startTenantBindingSelfCheck(tenantBindingHealth, {
    reviewer: tenantBindingReviewer,
    ...opts.tenantBindingSelfCheck,
    log: (msg) => logger.error(msg),
  });

  app.use(helmetMiddleware);
  app.use(corsMiddleware);
  app.use(globalRateLimit);
  app.use(internalRateLimit);

  app.use((req, res, next) => {
    if (req.path === "/metrics") return next();
    const end = httpRequestDuration.startTimer();
    res.on("finish", () => {
      const route = req.route?.path || "unmatched";
      const labels = { method: req.method, route, status: String(res.statusCode) };
      end(labels);
      httpRequestTotal.inc(labels);
    });
    next();
  });

  app.use(requestLogger);

  installBodyParsers(app);

  app.get("/metrics", async (_req, res) => {
    res.set("Content-Type", metricsRegistry.contentType);
    res.end(await metricsRegistry.metrics());
  });

  const healthHandler = (_req: Request, res: Response) => {
    const tenantBinding = tenantBindingHealth.get();
    res.status(tenantBinding.status === "unhealthy" ? 503 : 200).json({
      status: tenantBinding.status === "unhealthy" ? "degraded" : "ok",
      service: "octogee-api",
      tenantBinding,
      timestamp: new Date().toISOString(),
    });
  };
  app.get("/health", healthHandler);
  app.get("/api/health", healthHandler);

  app.use((req, res, next) => {
    if (!shouldAttemptTenantBinding(req.path)) {
      next();
      return;
    }
    tenantBindingMiddleware(req, res, next);
  });
  app.use((req, res, next) => {
    if (!shouldEnforceTenantBinding(req)) {
      next();
      return;
    }
    tenantEnforcementMiddleware(req, res, next);
  });
  mountClusterRoutes(app, {
    mmRestProxyHandler,
    mattermostMintRoutes,
  });
  const chatArtifacts = defaultChatArtifactRoutes();
  app.use("/api/chat/artifacts", chatArtifacts.public);
  // App-facing, Firebase-authed: Codex-style link unfurl (SSRF-guarded). Lives
  // here rather than the cluster bundle so it can reuse octogee-api's undici dep.
  app.use("/api/link-preview", createLinkPreviewRoutes());
  // octogee-api-only: trusted singleton billing maintenance. CronJobs call this
  // with their projected octogee-cron KSA token (tenant-bound as kind=platform).
  app.use("/internal/billing", internalBillingRoutes);
  // octogee-api-only: Gitea admin broker. Gateway provisioners call this with
  // their projected gateway KSA token; octogee-api holds the Gitea admin token.
  app.use("/internal/gitea", internalGiteaAdminRoutes);
  app.use("/internal/activity-pairs", createDefaultActivityPairReportRoutes(db));
  app.use("/internal/chat-artifacts", chatArtifacts.worker);
  // octogee-api-only: broker the gateway-edge OpenClaw runtime Firestore
  // dependencies so cattle pods do not need ADC/datastore reach.
  app.use("/internal/openclaw", createOpenClawRuntimeBrokerRoutes({ db }));
  // octogee-api-only: broker standard gateway fleet-mount Firestore/MM
  // operations. The shell-bearing gateway sees only assigned roster snapshots
  // and assigned-scoped mutation endpoints for its own KSA-bound identity.
  app.use("/internal/fleet", createFleetBrokerRoutes({ db }));
  // octogee-api-only: broker sidecar GitHub file-browser token reads
  // so cattle pods do not need Firestore or KMS access to user secrets.
  app.use("/internal/connectors", createConnectorTokenBrokerRoutes({
    db,
    readPodOwnerIdentity: createGatewayPodOwnerIdentityReader({
      namespace: process.env.K8S_NAMESPACE ?? "octogee",
    }),
  }));
  // octogee-api-only: materialize BYOK creds for cattle gateways that can't reach
  // Secret Manager — BYOSUB OAuth (scoped to the caller's user integration) and
  // byok-* API keys (roster-scoped to the gateway's assigned slugs).
  app.use("/internal/byok", createByokBrokerRoutes({ db }));
  // octogee-api-only: agent project CRUD — roster-scoped like /internal/byok;
  // the owner + workspace derive from the pod's assignment, and plan
  // entitlements are enforced by the same service the UI create uses.
  app.use("/internal/agent-projects", createAgentProjectRoutes({ db }));
  app.use(
    "/internal/agent-support",
    createAgentSupportRoutes({
      db,
      askOps:
        opts.askOpsAgent ??
        createOpsAgentHttpClient({
          baseUrl: process.env.OPS_AGENT_URL,
          bearerToken: process.env.OPS_AGENT_BEARER_TOKEN,
        }),
      resolveModel:
        opts.resolveOpsAgentModel ??
        createCachedOpsAgentModelResolver({
          db,
          onError: (error) => logger.error("Ops Agent model resolution failed", { error }),
        }),
      logError: (message, fields) => logger.error(message, fields),
    }),
  );
  app.use("/internal/agent-access", createAgentAccessRoutes({ db }));
  // octogee-api-only: broker BuilderShell ticket, presence, and audit
  // Firestore writes so operator gateway pods can stay datastore.viewer-only.
  app.use("/internal/builder-shell", createBuilderShellBrokerRoutes());
  app.use("/internal/openclaw-control", createOpenClawControlBrokerRoutes({ db }));
  app.use(
    "/internal/automations",
    requireAuthenticatedUid,
    createAutomationAuthorizationBrokerRoutes({ db }),
  );
  app.use(
    "/internal/agent-imports",
    requireAuthenticatedUid,
    createAgentImportBrokerRoutes({
      db,
      bucket: importBucket,
      readGithubToken: (uid) => readConnectorAccessToken(uid, "github"),
      listGithubRepos: githubListRepos,
      readGithubRepoSize: async (owner, repo, token) => {
        const value = await githubRepoApi(owner, repo, token);
        const size = value && typeof value === "object" && !Array.isArray(value)
          ? (value as Record<string, unknown>).size
          : undefined;
        if (typeof size !== "number" || !Number.isSafeInteger(size) || size < 0) {
          throw new Error("GitHub repository size is unavailable");
        }
        return size;
      },
      readIdentity: async (uid) => {
        const agent = await readAgent(uid);
        return agent ? {
          ...(agent.name ? { name: agent.name } : {}),
          ...(typeof agent.persona === "string" ? { persona: agent.persona } : {}),
          ...(typeof agent.avatarEmoji === "string" ? { emoji: agent.avatarEmoji } : {}),
        } : {};
      },
      syncIdentity: async (uid, identity) => {
        await syncCoachIdentity(uid, {
          ...(identity.name ? { name: identity.name } : {}),
          ...(identity.persona !== undefined ? { persona: identity.persona } : {}),
          ...(identity.emoji ? { emoji: identity.emoji } : {}),
        });
      },
      now: () => new Date(),
    }),
  );
  // octogee-api-only: mint/revoke opaque model broker tokens. GLM mirrors
  // these into per-gateway K8s secrets, but the values are no longer provider
  // keys and cannot fetch provider keys from the gateway pod.
  app.use(
    "/internal/model-keys",
    createModelKeyIssuerRoutes({
      db,
      store: opts.modelKeyTokenStore,
      bearerToken:
        opts.modelKeyIssuerBearerToken ?? process.env.GATEWAY_MODEL_KEY_ISSUER_BEARER_TOKEN,
      ttlSeconds: opts.modelKeyIssuerTtlSeconds,
    }),
  );

  app.use(errorHandler);

  return app;
}

const app = createApp();

if (process.env.NODE_ENV !== "test") {
  app.listen(PORT, () => {
    logger.info(`octogee-api boot — listening on port ${PORT}`, {
      port: PORT,
      env: process.env.K8S_NAMESPACE || "local",
      sha: process.env.BUILD_SHA || "unknown",
      node: process.version,
    });
  });
}

export default app;
