import { firestoreBuilderAccountReader } from "@octogee/core/builder-account";

import http from "node:http";
import express, { Request, Response, type RequestHandler } from "express";
import { Registry, collectDefaultMetrics, Counter, Histogram } from "prom-client";

import { corsMiddleware } from "../../gateway-edge/src/middleware/cors.js";
import { requestLogger, logger, setLogService } from "../../gateway-edge/src/middleware/logging.js";

import { errorHandler } from "../../gateway-edge/src/middleware/errors.js";
import { helmetMiddleware } from "../../gateway-edge/src/middleware/security.js";

import { mountClusterRoutes, type ClusterRouteTable } from "../../gateway-edge/src/routes/mount-cluster-routes.js";
import internalGiteaAdminRoutes from "../../gateway-edge/src/routes/internal/gitea-admin.js";
import { installBodyParsers } from "../../gateway-edge/src/middleware/body-parsers.js";
import { createMattermostMintRoutes, createMmRestProxyHandler } from "./routes/mattermost-proxy.js";
import { createOpenClawRuntimeBrokerRoutes } from "./routes/openclaw-runtime-broker.js";
import { createConnectorTokenBrokerRoutes } from "./routes/connector-token-broker.js";
import { createWorkspaceCommitProofBrokerRoutes } from "./routes/workspace-commit-proof-broker.js";
import { createOwnerAutomationAuthorizationBrokerRoutes } from "./routes/owner-automation-authorization-broker.js";
import { createByokBrokerRoutes } from "./routes/byok-broker.js";
import { createAgentProjectRoutes } from "./routes/agent-projects.js";
import { createAgentProjectRunRoutes, finalizeProjectRun } from "./routes/agent-project-runs.js";
import { createAdminProjectRunRoutes } from "./routes/admin-project-runs.js";
import { createAgentProjectPublishRoutes } from "./routes/agent-project-publish.js";
import { createProjectPublishControlRoutes } from "./routes/project-publish-control.js";
import { createProjectHostingRetirementRoutes } from "./routes/project-hosting-retirement.js";
import {
  createProjectPreviewDiscoveryRoutes,
  createProjectPreviewStaticRoutes,
} from "./routes/project-previews.js";
import {
  createAgentProductivityRoutes,
} from "./routes/agent-productivity.js";
import { createAgentBoardRoutes } from "./routes/agent-board.js";
import { createAgentObsidianRoutes } from "./routes/agent-productivity-obsidian.js";
import { createObsidianPairingRoutes } from "./routes/obsidian-pairing.js";
import { createAgentSupportRoutes } from "./routes/agent-support.js";
import { createAgentComputerContextRoutes } from "./routes/agent-computer-context.js";
import { createFleetBrokerRoutes } from "./routes/fleet-broker.js";
import { createOpenClawControlBrokerRoutes } from "./routes/openclaw-control-broker.js";
import { createAutomationAuthorizationBrokerRoutes } from "./routes/automation-authorization-broker.js";
import { createWorkspaceGitAuthorizationBrokerRoutes } from "./routes/workspace-git-authorization-broker.js";
import { createChannelReadinessAuthorizationBrokerRoutes } from "./routes/channel-agent-readiness-authorization-broker.js";
import { createVoiceConversationRoutes } from "./routes/voice-conversation.js";
import { createToolConversationRoutes, createWorkspaceNativeAccessRoutes } from "./routes/workspace-native-access.js";
import { createAgentImportBrokerRoutes } from "./routes/agent-import-broker.js";
import { createModelKeyIssuerRoutes } from "./routes/model-key-issuer.js";
import { operatorRailRegistry, type ModelBrokerRailRegistry } from "./lib/model-broker-rails.js";
import { createDesktopAuthRoutes } from "./routes/desktop-auth.js";
import { createFeatureRoutes } from "./routes/features.js";
import { FeaturePolicy } from "./lib/feature-policy.js";
import {
  captureProductAnalyticsEvent,
  type ProductAnalytics,
} from "./lib/product-analytics.js";
import type { ProductAnalyticsEvent } from "@octogee/shared/types/product-analytics";
import { createPostHogServices, type PostHogServices } from "./lib/posthog.js";
import { createProductObservability } from "./lib/product-observability.js";
import { createBuilderGatewayRoutes } from "../../gateway-edge/src/routes/builder/gateways.js";
import { createProjectCreateRoutes } from "../../gateway-edge/src/routes/projects/create.js";
import { createProjectRepoSourceRoutes } from "../../gateway-edge/src/routes/projects/repo-source.js";
import { startWorkspaceVoiceConversation } from "./lib/voice-posting-grant.js";
import { resolveVoiceChannel } from './lib/workspace-conversation.js';
import { createVoiceRoutes } from "../../gateway-edge/src/routes/voice.js";
import { createProductivityApprovalRoutes } from "../../gateway-edge/src/routes/productivity-approvals.js";
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
import { auth, db, storage } from "../../gateway-edge/src/lib/db.js";
import { platformStateStore, readBuilderTier } from "../../gateway-edge/src/lib/platform-state.js";
import {
  ConnectorTokenReadError,
  getFreshAccessTokenFromStore,
} from "../../gateway-edge/src/lib/connector-tokens.js";
import { getConnector } from "../../gateway-edge/src/lib/connectors/index.js";
import { githubListRepos, githubRepoApi } from "../../gateway-edge/src/lib/github.js";
import { readAgent } from "../../gateway-edge/src/lib/firestoreReads.js";
import { replaceCoachTextIdentity, syncCoachIdentity } from "../../gateway-edge/src/lib/coach-identity.js";
import { requireAdmin, requireAuth, requireAuthenticatedUid } from "../../gateway-edge/src/middleware/auth.js";
import {
  createKubernetesTokenReviewer,
  IN_CLUSTER_IDENTITY_CA_PATH,
  IN_CLUSTER_IDENTITY_TOKEN_PATH,
} from "./lib/token-review.js";
import {
  createTenantBindingHealthState,
  startTenantBindingSelfCheck,
} from "./lib/tenant-binding-health.js";
import {
  createTenantBindingMiddleware,
  createTenantBindingMetrics,
} from "./middleware/tenant-binding.js";
import { createTenantEnforcementMiddleware } from "./middleware/tenant-enforcement.js";
import { createGatewayIdentityReviewer } from "./lib/gateway-identity-reviewer.js";
import { createOpenAiVoiceCatalog } from "./voice/openai-catalog.js";
import { createOpenAiLiveUpgradeHandler } from "./voice/openai-live.js";
import { createVoiceCatalog, type VoiceCatalog } from "./voice/catalog.js";
import { parseVoiceRelayConfig, type VoiceRelayConfig } from "./voice/config.js";
import {
  createVoiceRelayRoutes,
  createVoiceRelayUpgradeHandler,
  type VoiceRelayUpgradeAuth,
} from "./voice/relay.js";
import { createGatewayCredentialAuth } from "./middleware/gateway-credential-auth.js";
import {
  GATEWAY_CREDENTIAL_TOKEN_AUDIENCE,
  SIDECAR_BROKER_TOKEN_AUDIENCE,
  SIDECAR_BROKER_TOKEN_HEADER,
} from "@octogee/core/internal-fetch";
import { createModelBrokerTokenStore, type ModelBrokerTokenStore } from "./lib/model-broker-tokens.js";
import {
  createOpsAgentHttpClient,
  type AskOpsAgent,
} from "./lib/ops-agent-client.js";
import {
  createCachedOpsAgentModelResolver,
  type OpsAgentModelResolver,
} from "./lib/platform-model-config.js";
import { normalizeTenantPolicyPath } from "./lib/tenant-route-policy.js";
import { createFirestoreProjectRunStore } from "./lib/project-runs/firestore-store.js";
import { createProjectSnapshotSource } from "./lib/project-runs/source.js";
import {
  createProjectRunControlPlaneClient,
  type ProjectRunControlPlane,
} from "./lib/project-runs/control-plane.js";
import {
  createGcsProjectRunArtifactStore,
  type ProjectRunArtifactStore,
} from "./lib/project-runs/artifact-store.js";
import {
  createGcsProjectPreviewArtifactStore,
  type ProjectPreviewArtifactStore,
} from "./lib/project-runs/preview-artifacts.js";
import { startProjectRunRetention } from "./lib/project-runs/retention.js";
import { startProjectRunFinalization } from "./lib/project-runs/finalization.js";
import { createProjectPublishAllocationStore, type ProjectPublishAllocationStore } from "./lib/project-publish/allocation.js";
import { createGcsProjectPublishArtifactSource, type ProjectPublishArtifactSource } from "./lib/project-publish/artifact-source.js";
import { createProjectPublisherClient, type ProjectPublisherClient } from "./lib/project-publish/publisher-client.js";
import { createProjectHostingRetirementService } from "./lib/project-publish/retirement.js";
import { setProjectHostingRetirementHandler } from "../../gateway-edge/src/lib/project-hosting-retirement.js";
import {
  PROJECT_PUBLISH_CONTROL_AUDIENCE,
  PROJECT_HOSTING_RETIREMENT_AUDIENCE,
  requireProjectPublishService,
} from "./lib/project-publish/service-auth.js";

setLogService("api");

const TENANT_BOUND_API_ROUTES = new Set([
  "/api/model-credentials/subscription/auth-state",
  "/api/model-credentials/subscription/capture",
  "/api/model-credentials/subscription/sync-back",
  "/api/notifications/ingest",
]);
export const GATEWAY_CREDENTIAL_ROUTES = new Set([
  "/internal/fleet/blob/materialization/read-url",
  "/internal/fleet/blob/materialization/manifest/read-url",
  "/internal/connectors/access-token",
  "/internal/fleet/vm-runtime",
  "/internal/fleet/computer-home/checkpoint-url",
  "/internal/fleet/computer-home/commit",
  "/internal/fleet/computer-home/download-url",
  "/internal/fleet/computer-home/prune",
  "/internal/fleet/assigned-users",
  "/internal/fleet/assignment-watch",
  "/internal/fleet/configured-builder-bootstrap",
  "/internal/fleet/builder-identity",
  "/internal/fleet/npm-registry-credentials",
  "/internal/fleet/user-snapshot",
  "/internal/fleet/runtime-reset-ack",
  "/internal/fleet/provision-mattermost",
]);

export const SIDECAR_BROKER_ROUTES = new Set([
  "/internal/fleet/blob/project/upload-url",
  "/internal/fleet/blob/workspace/upload",
  "/internal/connectors/github-project-clone-access",
  "/internal/openclaw/activity/agent-identity",
  "/internal/workspace-commit/verify-proof",
  "/internal/owner-automations/authorize",
]);

export interface ProductRouteDeps {
  featurePolicy: FeaturePolicy;
  analytics: ProductAnalytics;
  observability: ReturnType<typeof createProductObservability>;
}

export interface ProductExtension {
  validateBoot(): void;
  registerMetrics(registry: Registry): void;
  clusterRoutes(deps: ProductRouteDeps): ClusterRouteTable;
  apiRoutes(deps: ProductRouteDeps): ClusterRouteTable;
  internalRoutes(deps: ProductRouteDeps): ClusterRouteTable;
  modelBrokerRails?: ModelBrokerRailRegistry;
}

export interface PlatformAppOptions {
  product?: ProductExtension;
  tenantBindingReviewer?: Parameters<typeof createTenantBindingMiddleware>[0]["reviewer"];
  gatewayCredentialReviewer?: Parameters<typeof createGatewayCredentialAuth>[0]["reviewer"];
  sidecarBrokerReviewer?: Parameters<typeof createGatewayCredentialAuth>[0]["reviewer"];
  tenantBindingSelfCheck?: {
    inCluster?: boolean;
    tokenPath?: string;
  };
  modelKeyTokenStore?: ModelBrokerTokenStore;
  modelKeyIssuerBearerToken?: string;
  modelKeyIssuerTtlSeconds?: number | null;
  askOpsAgent?: AskOpsAgent;
  resolveOpsAgentModel?: OpsAgentModelResolver;
  featurePolicy?: FeaturePolicy;
  voiceRelayConfig?: VoiceRelayConfig | null;
  voiceOpenAiApiKey?: string | null;
  productAnalytics?: ProductAnalytics;
  postHogServices?: PostHogServices;
  projectRunControlPlane?: ProjectRunControlPlane;
  projectRunArtifactStore?: ProjectRunArtifactStore;
  projectPreviewArtifactStore?: ProjectPreviewArtifactStore;
  previewOrigin?: string;
  appOrigin?: string;
  projectRunnerImage?: string;
  customerHostingProjectId?: string;
  projectPublishAllocations?: ProjectPublishAllocationStore;
  projectPublishArtifacts?: ProjectPublishArtifactSource;
  projectPublisher?: ProjectPublisherClient;
  projectPublishControlReviewer?: Parameters<typeof requireProjectPublishService>[0]["reviewer"];
}

export function createLazyProjectRunBucket(
  acquire: () => ReturnType<typeof storage.bucket> = () => storage.bucket(),
) {
  let bucket: ReturnType<typeof storage.bucket> | undefined;
  const current = () => {
    bucket ??= acquire();
    return bucket;
  };
  return {
    get name() {
      return current().name;
    },
    file(path: string, options?: { generation?: string }) {
      return current().file(path, options);
    },
    getFiles(options: { prefix: string; autoPaginate: false; maxResults: number }) {
      return current().getFiles(options);
    },
  };
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
      resolveActiveArtifactWorkspaceSlug(platformStateStore, teamId),
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

async function readFreshGithubToken(uid: string): Promise<string | null> {
  const connector = getConnector("github");
  if (!connector) throw new Error("GitHub connector is unavailable");
  const token = await getFreshAccessTokenFromStore(platformStateStore, uid, connector);
  if (token.ok) return token.accessToken;
  if (token.reason === "not_connected") return null;
  throw new ConnectorTokenReadError(409, token.reason);
}

function productRuntime(opts: PlatformAppOptions, metricsRegistry: Registry) {
  const observability = createProductObservability(metricsRegistry);
  const postHog = opts.postHogServices ?? createPostHogServices(process.env, {
    featureMetrics: observability,
    logger,
  });
  return {
    observability,
    postHog,
    featurePolicy: opts.featurePolicy ?? postHog.featurePolicy,
    analytics: opts.productAnalytics ?? postHog.productAnalytics,
  };
}

function mountFeatureRoutes(app: ReturnType<typeof express>, runtime: ReturnType<typeof productRuntime>): void {
  app.use("/api/features", createFeatureRoutes({ featurePolicy: runtime.featurePolicy }));
}

function mountRouteTable(app: ReturnType<typeof express>, routes: ClusterRouteTable): void {
  for (const [path, route] of routes) app.use(path, route);
}

function recordProductEvent(
  runtime: ReturnType<typeof productRuntime>,
  uid: string,
  event: ProductAnalyticsEvent,
): void {
  try {
    captureProductAnalyticsEvent({
      analytics: runtime.analytics,
      metrics: runtime.observability,
      uid,
      event,
    });
  } catch (error) {
    runtime.observability.event(event.name, "dropped");
    logger.error("product analytics capture failed", { event: event.name, error });
  }
}

function clusterRouteOverrides(
  featurePolicy: FeaturePolicy,
  voiceCatalog: VoiceCatalog,
  prewarmProjectRunCapacity: () => Promise<void>,
  productRoutes: ClusterRouteTable,
) {
  return {
    mmRestProxyHandler: createMmRestProxyHandler(platformStateStore),
    mattermostMintRoutes: createMattermostMintRoutes(platformStateStore),
    productRoutes,
    builderGatewaysRoutes: createBuilderGatewayRoutes({ featurePolicy }),
    projectsCreateRoutes: createProjectCreateRoutes({ featurePolicy, prewarmProjectRunCapacity }),
    projectsRepoSourceRoutes: createProjectRepoSourceRoutes({ featurePolicy }),
    voiceRoutes: createVoiceRoutes({ featurePolicy, catalog: voiceCatalog, resolveChannel: async (uid, channelId) => {
      const result = await resolveVoiceChannel({ db, store: platformStateStore, readBuilderTier }, { uid, channelId });
      return result ? { gatewayId: result.scope.gatewayId, channelId } : null;
    }, resolveConversation: async (uid, channelId, threadRootPostId) => {
      const result = await startWorkspaceVoiceConversation({ db, store: platformStateStore, readBuilderTier }, { uid, channelId, threadRootPostId });
      return result ? { gatewayId: result.scope.gatewayId, workspaceSlug: result.scope.workspaceSlug, ownerUid: result.scope.ownerUid, channelId, threadRootPostId: result.context.threadRootPostId, sessionKey: result.context.sessionKey } : null;
    } }),
    productivityApprovalRoutes: express.Router()
      .use(requireAuth)
      .use(createProductivityApprovalRoutes({ db })),
  };
}

function createHttpRequestMetrics(metricsRegistry: Registry): RequestHandler {
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
  return (req, res, next) => {
    if (req.path === "/metrics") return next();
    const end = httpRequestDuration.startTimer();
    res.on("finish", () => {
      const route = req.route?.path || "unmatched";
      const labels = { method: req.method, route, status: String(res.statusCode) };
      end(labels);
      httpRequestTotal.inc(labels);
    });
    next();
  };
}

function mountDiagnosticRoutes(
  app: ReturnType<typeof express>,
  metricsRegistry: Registry,
  tenantBindingHealth: ReturnType<typeof createTenantBindingHealthState>,
): void {
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
}

async function authorizeVoiceRelayUpgrade(
  app: ReturnType<typeof express>,
  bindTenant: RequestHandler,
  upgradeReq: http.IncomingMessage,
): Promise<VoiceRelayUpgradeAuth> {
  const req = Object.setPrototypeOf(upgradeReq, app.request) as Request;
  const res = Object.setPrototypeOf(new http.ServerResponse(upgradeReq), app.response) as Response;
  req.res = res;
  res.req = req;
  await new Promise<void>((resolve, reject) => {
    bindTenant(req, res, (err?: unknown) => {
      if (!err) {
        resolve();
        return;
      }
      reject(err instanceof Error ? err : new Error(String(err)));
    });
  });
  const bound = req.boundTenant;
  if (!bound || bound.kind !== "gateway") return { ok: false, status: 403 };
  const claimed = new URL(upgradeReq.url ?? "/", "https://relay.local").searchParams.get("gatewayId");
  if (claimed && claimed !== bound.gatewayId) return { ok: false, status: 403 };
  return { ok: true, gatewayId: bound.gatewayId };
}

// eslint-disable-next-line max-lines-per-function, complexity -- application assembly keeps route ownership and dependency wiring explicit
export function createPlatformApp(opts: PlatformAppOptions = {}) {
  opts.product?.validateBoot();

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
  const projectRunStore = createFirestoreProjectRunStore(db);
  const lazyProjectRunBucket = createLazyProjectRunBucket();
  const projectRunArtifactStore = opts.projectRunArtifactStore
    ?? createGcsProjectRunArtifactStore(lazyProjectRunBucket);
  const projectPreviewArtifactStore = opts.projectPreviewArtifactStore
    ?? createGcsProjectPreviewArtifactStore(lazyProjectRunBucket);
  const projectPublishAllocations = opts.projectPublishAllocations ?? createProjectPublishAllocationStore(db);
  const projectPublishArtifacts = opts.projectPublishArtifacts
    ?? createGcsProjectPublishArtifactSource(lazyProjectRunBucket);
  const previewOrigin = opts.previewOrigin ?? process.env.PREVIEW_PUBLIC_URL
    ?? (process.env.NODE_ENV === "test" ? "https://preview-test.octogee.com" : "");
  const appOrigin = opts.appOrigin ?? process.env.APP_URL
    ?? (process.env.NODE_ENV === "test" ? "https://app-test.octogee.com" : "");
  if (process.env.NODE_ENV !== "test") {
    startProjectRunRetention({
      runs: projectRunStore,
      artifacts: projectRunArtifactStore,
      previews: projectPreviewArtifactStore,
      onError: (error) => logger.error("[project-runs] retention sweep failed", { error }),
    });
  }
  const projectRunSource = createProjectSnapshotSource({
    readGithubToken: readFreshGithubToken,
  });
  const namespace = process.env.K8S_NAMESPACE ?? "octogee";
  const customerHostingProjectId = opts.customerHostingProjectId
    ?? process.env.OCTOGEE_CUSTOMER_HOSTING_PROJECT_ID
    ?? (process.env.NODE_ENV === "test" ? "octogee-customer-hosting-test" : "");
  const projectPublisher = opts.projectPublisher ?? createProjectPublisherClient({
    baseUrl: process.env.PROJECT_PUBLISHER_URL
      ?? `http://octogee-project-publisher.${namespace}.svc.cluster.local:3005`,
  });
  const retireProjectHosting = createProjectHostingRetirementService({
    customerHostingProjectId,
    allocations: projectPublishAllocations,
    publisher: projectPublisher,
  });
  setProjectHostingRetirementHandler(retireProjectHosting);
  const runnerImage = opts.projectRunnerImage ?? process.env.PROJECT_RUNNER_IMAGE ?? "";
  const projectRunControlPlane = opts.projectRunControlPlane ?? createProjectRunControlPlaneClient({
    brokerBaseUrl: process.env.PROJECT_RUN_BROKER_URL
      ?? `http://octogee-project-run-broker.${namespace}.svc.cluster.local:3002`,
    controllerBaseUrl: process.env.PROJECT_RUN_CONTROLLER_URL
      ?? `http://octogee-project-run-controller.${namespace}.svc.cluster.local:3003`,
  });
  // client → GCLB (appends client-ip, lb-ip) → this app
  app.set("trust proxy", 2);
  app.use("/p", createProjectPreviewStaticRoutes({
    store: projectRunStore,
    artifacts: projectPreviewArtifactStore,
    previewOrigin,
    appOrigin,
  }));

  const metricsRegistry = new Registry();
  collectDefaultMetrics({ register: metricsRegistry });
  const httpRequestMetrics = createHttpRequestMetrics(metricsRegistry);
  opts.product?.registerMetrics(metricsRegistry);
  const product = productRuntime(opts, metricsRegistry);
  const productRouteDeps: ProductRouteDeps = {
    featurePolicy: product.featurePolicy,
    analytics: product.analytics,
    observability: product.observability,
  };
  const featurePolicy = product.featurePolicy;
  const modelBrokerRails = opts.product?.modelBrokerRails ?? operatorRailRegistry();
  app.locals.postHogShutdown = product.postHog.shutdown;
  const tenantBindingMetrics = createTenantBindingMetrics(metricsRegistry);
  const tenantBindingReviewer = opts.tenantBindingReviewer ?? createGatewayIdentityReviewer({
    reviewerTokenPath: IN_CLUSTER_IDENTITY_TOKEN_PATH,
    caPath: IN_CLUSTER_IDENTITY_CA_PATH,
  }, { namespace });
  const tenantBindingHealth = createTenantBindingHealthState();
  const tenantBindingMiddleware = createTenantBindingMiddleware({
    reviewer: tenantBindingReviewer,
    store: platformStateStore,
    metrics: tenantBindingMetrics,
  });
  const tenantEnforcementMiddleware = createTenantEnforcementMiddleware({ db, store: platformStateStore, enforceWhen: shouldEnforceTenantBinding });
  const gatewayCredentialReviewer = opts.gatewayCredentialReviewer ?? createGatewayIdentityReviewer({
    reviewerTokenPath: IN_CLUSTER_IDENTITY_TOKEN_PATH,
    caPath: IN_CLUSTER_IDENTITY_CA_PATH,
    audience: GATEWAY_CREDENTIAL_TOKEN_AUDIENCE,
  }, { namespace });
  const gatewayCredentialAuth = createGatewayCredentialAuth({
    reviewer: gatewayCredentialReviewer,
    store: platformStateStore,
    namespace,
  });
  const sidecarBrokerReviewer = opts.sidecarBrokerReviewer ?? createGatewayIdentityReviewer({
    reviewerTokenPath: IN_CLUSTER_IDENTITY_TOKEN_PATH,
    caPath: IN_CLUSTER_IDENTITY_CA_PATH,
    audience: SIDECAR_BROKER_TOKEN_AUDIENCE,
  }, { namespace });
  const sidecarBrokerAuth = createGatewayCredentialAuth({
    reviewer: sidecarBrokerReviewer,
    store: platformStateStore,
    namespace,
    tokenHeader: SIDECAR_BROKER_TOKEN_HEADER,
    audience: SIDECAR_BROKER_TOKEN_AUDIENCE,
  });
  startTenantBindingSelfCheck(tenantBindingHealth, {
    reviewer: tenantBindingReviewer,
    ...opts.tenantBindingSelfCheck,
    log: (msg) => logger.error(msg),
  });

  app.use(helmetMiddleware);
  app.use(corsMiddleware);
  app.use(httpRequestMetrics);

  app.use(requestLogger);

  installBodyParsers(app);
  mountDiagnosticRoutes(app, metricsRegistry, tenantBindingHealth);
  app.use("/api/auth/desktop", createDesktopAuthRoutes({ db, auth, store: platformStateStore }));
  mountFeatureRoutes(app, product);
  app.use("/api/projects", createProjectPreviewDiscoveryRoutes({
    db,
    state: platformStateStore,
    store: projectRunStore,
    previewOrigin,
    auth: requireAuth,
  }));
  app.use("/api/admin/project-runs", requireAdmin, createAdminProjectRunRoutes({
    db,
    controlPlane: projectRunControlPlane,
    previewOrigin,
  }));
  app.use(
    "/api/connect/obsidian/pair",
    createObsidianPairingRoutes({ db, featurePolicy }),
  );
  const projectPublishControlReviewer = opts.projectPublishControlReviewer ?? createKubernetesTokenReviewer({
    reviewerTokenPath: IN_CLUSTER_IDENTITY_TOKEN_PATH,
    caPath: IN_CLUSTER_IDENTITY_CA_PATH,
    audience: PROJECT_PUBLISH_CONTROL_AUDIENCE,
  });
  const projectHostingRetirementReviewer = createKubernetesTokenReviewer({
    reviewerTokenPath: IN_CLUSTER_IDENTITY_TOKEN_PATH,
    caPath: IN_CLUSTER_IDENTITY_CA_PATH,
    audience: PROJECT_HOSTING_RETIREMENT_AUDIENCE,
  });
  app.use("/internal/project-publish-control", createProjectPublishControlRoutes({
    allocations: projectPublishAllocations,
    auth: requireProjectPublishService({
      reviewer: projectPublishControlReviewer,
      namespace,
      serviceAccount: "octogee-project-publisher",
      audience: PROJECT_PUBLISH_CONTROL_AUDIENCE,
    }),
  }));
  app.use("/internal/project-hosting", createProjectHostingRetirementRoutes({
    db,
    retire: retireProjectHosting,
    auth: requireProjectPublishService({
      reviewer: projectHostingRetirementReviewer,
      namespace,
      serviceAccount: "glm-controller",
      audience: PROJECT_HOSTING_RETIREMENT_AUDIENCE,
    }),
  }));
  app.use((req, res, next) => {
    if (!shouldAttemptTenantBinding(req.path)) {
      next();
      return;
    }
    tenantBindingMiddleware(req, res, next);
  });
  app.use((req, res, next) => {
    if (!shouldAttemptTenantBinding(req.path)) {
      next();
      return;
    }
    tenantEnforcementMiddleware(req, res, next);
  });
  app.use((req, res, next) => {
    if (!GATEWAY_CREDENTIAL_ROUTES.has(normalizeTenantPolicyPath(req.path))) {
      next();
      return;
    }
    gatewayCredentialAuth(req, res, next);
  });
  app.use((req, res, next) => {
    if (!SIDECAR_BROKER_ROUTES.has(normalizeTenantPolicyPath(req.path))) {
      next();
      return;
    }
    sidecarBrokerAuth(req, res, next);
  });
  const voiceRelayConfig = opts.voiceRelayConfig === undefined ? parseVoiceRelayConfig() : opts.voiceRelayConfig;
  const voiceOpenAiApiKey = opts.voiceOpenAiApiKey === undefined ? process.env.VOICE_OPENAI_API_KEY?.trim() || null : opts.voiceOpenAiApiKey;
  const voiceRelayLog = (message: string, fields?: Record<string, unknown>) => logger.warn(message, fields ?? {});
  mountClusterRoutes(app, clusterRouteOverrides(
    featurePolicy,
    voiceOpenAiApiKey ? createOpenAiVoiceCatalog(voiceOpenAiApiKey) : createVoiceCatalog(voiceRelayConfig, { log: voiceRelayLog }),
    () => projectRunControlPlane.prewarm(),
    opts.product?.clusterRoutes(productRouteDeps) ?? [],
  ));
  mountRouteTable(app, opts.product?.apiRoutes(productRouteDeps) ?? []);
  mountRouteTable(app, opts.product?.internalRoutes(productRouteDeps) ?? []);
  const chatArtifacts = defaultChatArtifactRoutes();
  app.use("/api/chat/artifacts", chatArtifacts.public);
  // octogee-api-only: Gitea admin broker. Gateway provisioners call this with
  // their projected gateway KSA token; octogee-api holds the Gitea admin token.
  app.use("/internal/gitea", internalGiteaAdminRoutes);
  app.use("/internal/chat-artifacts", chatArtifacts.worker);
  // octogee-api-only: broker the gateway-edge OpenClaw runtime Firestore
  // dependencies so cattle pods do not need ADC/datastore reach.
  app.use("/internal/openclaw", createOpenClawRuntimeBrokerRoutes({ db, store: platformStateStore }));
  // octogee-api-only: voice relay. gateway-edge Talk engines stream microphone
  // audio and fetch speech here so provider keys never reach a gateway pod.
  app.use("/internal/voice", createVoiceRelayRoutes({ config: voiceRelayConfig, nativeOpenAi: Boolean(voiceOpenAiApiKey), log: voiceRelayLog }));
  const voiceRelayUpgrade = createVoiceRelayUpgradeHandler({
    config: voiceRelayConfig,
    log: voiceRelayLog,
    authorize: (upgradeReq) => authorizeVoiceRelayUpgrade(app, tenantBindingMiddleware, upgradeReq),
  });
  const openAiLiveUpgrade = createOpenAiLiveUpgradeHandler({
    apiKey: voiceOpenAiApiKey,
    log: voiceRelayLog,
    authorize: (upgradeReq) => authorizeVoiceRelayUpgrade(app, tenantBindingMiddleware, upgradeReq),
  });
  app.locals.attachUpgradeHandlers = (server: http.Server) => {
    server.on("upgrade", (upgradeReq, socket, head) => {
      if (openAiLiveUpgrade(upgradeReq, socket, head)) return;
      if (voiceRelayUpgrade(upgradeReq, socket, head)) return;
      socket.destroy();
    });
  };
  // octogee-api-only: broker standard gateway fleet-mount Firestore/MM
  // operations. The OpenClaw gateway sees only assigned roster snapshots
  // and assigned-scoped mutation endpoints for its own KSA-bound identity.
  app.use("/internal/fleet", createFleetBrokerRoutes({
    db,
    store: platformStateStore,
    modelBrokerRails,
    onSignupOfferBudgetInterruption: ({ uid, reason }) => recordProductEvent(product, uid, {
      name: "model_budget_interrupted",
      properties: { reason },
    }),
  }));
  // octogee-api-only: broker sidecar GitHub file-browser token reads
  // so cattle pods do not need Firestore or KMS access to user secrets.
  app.use("/internal/connectors", createConnectorTokenBrokerRoutes({ db, store: platformStateStore }));
  app.use("/internal/workspace-commit", createWorkspaceCommitProofBrokerRoutes({ store: platformStateStore }));
  app.use("/internal/owner-automations", createOwnerAutomationAuthorizationBrokerRoutes({ store: platformStateStore }));
  // octogee-api-only: materialize BYOK creds for cattle gateways that can't reach
  // Secret Manager — BYOSUB OAuth (scoped to the caller's user integration) and
  // byok-* API keys (roster-scoped to the gateway's assigned slugs).
  app.use("/internal/byok", createByokBrokerRoutes({ db, store: platformStateStore, rails: modelBrokerRails }));
  // octogee-api-only: agent project CRUD — roster-scoped like /internal/byok;
  // the owner + workspace derive from the pod's assignment, and plan
  // entitlements are enforced by the same service the UI create uses.
  app.use("/internal/agent-projects", createAgentProjectRoutes({
    db,
    store: platformStateStore,
    prewarmProjectRunCapacity: () => projectRunControlPlane.prewarm(),
    actionBaseUrl: appOrigin,
    onProjectCreated: (uid) => recordProductEvent(product, uid, {
      name: "project_created",
      properties: { source: "agent" },
    }),
  }));
  const projectRunFinalizerDeps = {
    store: projectRunStore,
    controlPlane: projectRunControlPlane,
    artifactStore: projectRunArtifactStore,
    previewArtifactStore: projectPreviewArtifactStore,
    previewOrigin,
  };
  app.use("/internal/project-runs", createAgentProjectRunRoutes({
    db,
    state: platformStateStore,
    ...projectRunFinalizerDeps,
    source: projectRunSource,
    runnerImage,
  }));
  if (process.env.NODE_ENV !== "test") {
    startProjectRunFinalization({
      runs: projectRunStore,
      finalize: async (run) => { await finalizeProjectRun(run, projectRunFinalizerDeps); },
      onError: (error) => logger.error("[project-runs] finalization sweep failed", { error }),
    });
  }
  app.use("/internal/openclaw", createAgentProjectPublishRoutes({
    db,
    state: platformStateStore,
    runStore: projectRunStore,
    source: projectRunSource,
    artifacts: projectPublishArtifacts,
    allocations: projectPublishAllocations,
    publisher: projectPublisher,
    customerHostingProjectId,
    actionBaseUrl: appOrigin,
  }));
  app.use("/internal/agent-board", createAgentBoardRoutes({ store: platformStateStore }));
  app.use("/internal/agent-productivity", createAgentProductivityRoutes({
    db,
    store: platformStateStore,
    actionBaseUrl: appOrigin,
  }));
  app.use("/internal/agent-productivity", createAgentObsidianRoutes({
    db,
    store: platformStateStore,
    featurePolicy,
    actionBaseUrl: appOrigin,
  }));
  app.use(
    "/internal/agent-support",
    createAgentSupportRoutes({
      db,
      store: platformStateStore,
      askOps:
        opts.askOpsAgent ??
        createOpsAgentHttpClient({
          baseUrl: process.env.OPS_AGENT_URL,
          bearerToken: process.env.OPS_AGENT_BEARER_TOKEN,
          logError: (message, fields) => logger.error(message, fields),
        }),
      resolveModel:
        opts.resolveOpsAgentModel ??
        createCachedOpsAgentModelResolver({
          platformConfig: platformStateStore.config.platform,
          onError: (error) => logger.error("Ops Agent model resolution failed", { error }),
        }),
      logError: (message, fields) => logger.error(message, fields),
    }),
  );
  app.use("/internal/computer", createAgentComputerContextRoutes({ store: platformStateStore }));
  app.use("/internal/openclaw-control", createOpenClawControlBrokerRoutes({ db, store: platformStateStore }));
  app.use(
    "/internal/automations",
    requireAuthenticatedUid,
    createAutomationAuthorizationBrokerRoutes({ store: platformStateStore }),
  );
  app.use("/internal/voice", createVoiceConversationRoutes({ db, store: platformStateStore, readBuilderTier }));
  app.use("/internal/openclaw-control", createToolConversationRoutes({ db, store: platformStateStore, readBuilderTier }));
  app.use("/internal/openclaw-control", requireAuthenticatedUid, createWorkspaceNativeAccessRoutes({ store: platformStateStore, readBuilderTier }));
  app.use("/internal/workspace-git", requireAuth, createWorkspaceGitAuthorizationBrokerRoutes({ store: platformStateStore }));
  app.use("/internal/channel-agent-readiness", requireAuth, createChannelReadinessAuthorizationBrokerRoutes({ store: platformStateStore }));
  app.use(
    "/internal/agent-imports",
    requireAuthenticatedUid,
    createAgentImportBrokerRoutes({
      store: platformStateStore,
      accounts: firestoreBuilderAccountReader(db),
      bucket: importBucket,
      readGithubToken: readFreshGithubToken,
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
        return {
          name: agent?.name ?? null,
          persona: typeof agent?.persona === "string" ? agent.persona : null,
          emoji: typeof agent?.avatarEmoji === "string" ? agent.avatarEmoji : null,
        };
      },
      syncIdentity: async (uid, identity) => {
        await syncCoachIdentity(uid, {
          ...(identity.name ? { name: identity.name } : {}),
          ...(identity.persona !== undefined ? { persona: identity.persona } : {}),
          ...(identity.emoji ? { emoji: identity.emoji } : {}),
        });
      },
      replaceIdentity: replaceCoachTextIdentity,
      now: () => new Date(),
      featurePolicy,
    }),
  );
  // octogee-api-only: mint/revoke opaque model broker tokens. GLM mirrors
  // these into per-gateway K8s secrets, but the values are no longer provider
  // keys and cannot fetch provider keys from the gateway pod.
  app.use(
    "/internal/model-keys",
    createModelKeyIssuerRoutes({
      rails: modelBrokerRails,
      tokens: opts.modelKeyTokenStore ?? createModelBrokerTokenStore(platformStateStore),
      state: platformStateStore,
      accounts: firestoreBuilderAccountReader(db),
      bearerToken:
        opts.modelKeyIssuerBearerToken ?? process.env.GATEWAY_MODEL_KEY_ISSUER_BEARER_TOKEN,
      ttlSeconds: opts.modelKeyIssuerTtlSeconds,
    }),
  );

  app.use(errorHandler);

  return app;
}

