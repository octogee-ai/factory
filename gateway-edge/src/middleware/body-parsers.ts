import express, { type Express, type Request } from "express";

const MM_REST_PROXY_PREFIX = "/api/v4/";
// Webhook paths whose signature is verified against the EXACT bytes received —
// JSON-parsing would mutate the wire form. The handler reads req.rawBody.
const RAW_BODY_WEBHOOK_PATHS = new Set([
  "/api/billing/webhook",
  "/api/email/webhook",
]);

export function installBodyParsers(app: Express): void {
  app.use((req, res, next) => {
    if (req.path.startsWith(MM_REST_PROXY_PREFIX)) return next();
    if (RAW_BODY_WEBHOOK_PATHS.has(req.path)) {
      express.raw({ type: "application/json" })(req, res, (err) => {
        if (err) return next(err);
        (req as Request & { rawBody?: Buffer }).rawBody = req.body;
        next();
      });
      return;
    }
    express.json({ limit: "10mb" })(req, res, next);
  });
  app.use((req, res, next) => {
    if (req.path.startsWith(MM_REST_PROXY_PREFIX)) return next();
    express.urlencoded({ extended: true })(req, res, next);
  });
}
