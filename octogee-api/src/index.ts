import http from "node:http";
import { platformStateStore } from "../../gateway-edge/src/lib/platform-state.js";
import { logger } from "../../gateway-edge/src/middleware/logging.js";
import { createGracefulShutdown } from "./lib/graceful-shutdown.js";
import { createPlatformApp, type PlatformAppOptions } from "./app.js";
import { createOctogeeProduct, type OctogeeProductOptions } from "./product.js";

export { createLazyProjectRunBucket } from "./product-project-runtime.js";

export {
  GATEWAY_CREDENTIAL_ROUTES,
  SIDECAR_BROKER_ROUTES,
  shouldAttemptTenantBinding,
  shouldEnforceTenantBinding,
} from "./app.js";

export type CreateAppOptions = Omit<PlatformAppOptions, "product"> & OctogeeProductOptions;

export function createApp(opts: CreateAppOptions = {}) {
  return createPlatformApp({ ...opts, product: createOctogeeProduct(opts) });
}

const PORT = parseInt(process.env.PORT || "3001", 10);
const app = createApp();

if (process.env.NODE_ENV !== "test") {
  const server = app.listen(PORT, () => {
    (app.locals.attachUpgradeHandlers as ((s: http.Server) => void) | undefined)?.(server);
    logger.info(`octogee-api boot — listening on port ${PORT}`, {
      port: PORT,
      env: process.env.K8S_NAMESPACE || "local",
      sha: process.env.BUILD_SHA || "unknown",
      node: process.version,
    });
  });
  const shutdown = createGracefulShutdown({
    server,
    flushPostHog: app.locals.productShutdown as (() => Promise<void>) | undefined,
    closePlatformState: () => platformStateStore.close(),
    onError(message, error) {
      process.exitCode = 1;
      logger.error(message, { error });
    },
  });
  process.once("SIGTERM", () => { void shutdown(); });
  process.once("SIGINT", () => { void shutdown(); });
}

export default app;
