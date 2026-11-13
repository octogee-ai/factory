import http from "node:http";
import type { Express } from "express";
import { platformStateStore } from "../../gateway-edge/src/lib/platform-state.js";
import { logger } from "../../gateway-edge/src/middleware/logging.js";
import { createGracefulShutdown } from "./lib/graceful-shutdown.js";

export function serveApi(app: Express): void {
  const port = parseInt(process.env.PORT || "3001", 10);
  const server = app.listen(port, () => {
    (app.locals.attachUpgradeHandlers as ((s: http.Server) => void) | undefined)?.(server);
    logger.info(`octogee-api boot — listening on port ${port}`, {
      port,
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
