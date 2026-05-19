import type { Express, RequestHandler } from "express";

/**
 * Mount a sub-router at BOTH `/api/<path>` and `/api/g/:gatewayId/<path>`.
 *
 * The unscoped form is the legacy seam (round-robins via the
 * `workspace-api` Service across every gateway pod's sidecar — fine for
 * stateless / unscoped endpoints, broken for any handler that depends
 * on per-customer local state). The gateway-scoped form is the new
 * path-affinity seam: the ingress steers `/api/g/<gatewayId>/*` to the
 * per-instance `workspace-api-<instance>` Service, so the request lands
 * on the user's home gateway pod where local state lives. See
 * `docs/specs/FLEET-API-ROUTING-SPEC.md`.
 *
 * Handlers don't need to change. `:gatewayId` is a routing key, not an
 * authorization input — authz remains Firebase token + slug/project
 * ownership checks. Routers that want to read `:gatewayId` for any
 * reason (telemetry, logging, sanity) must be created with
 * `Router({ mergeParams: true })`.
 */
export function mountApi(
  app: Pick<Express, "use">,
  path: string,
  router: RequestHandler,
): void {
  app.use(`/api${path}`, router);
  app.use(`/api/g/:gatewayId${path}`, router);
}
