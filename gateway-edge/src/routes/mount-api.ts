import type { Express, RequestHandler } from "express";

export function mountApi(
  app: Pick<Express, "use">,
  path: string,
  router: RequestHandler,
): void {
  app.use(`/api${path}`, router);
  app.use(`/api/g/:gatewayId${path}`, router);
}
