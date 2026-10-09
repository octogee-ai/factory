import { Router } from "express";
import { requireGatewayInternalAuth } from "../../middleware/gateway-internal-auth.js";
import { persistBuilderProjects } from "../../lib/project-persistence.js";
import { logger } from "../../middleware/logging.js";

export function createProjectPersistenceRouter(persist = persistBuilderProjects): Router {
  const router = Router();
  router.use(requireGatewayInternalAuth);
  router.post("/flush", async (req, res) => {
    const slug = process.env.GATEWAY_BUILDER_SLUG;
    if (process.env.GATEWAY_CLASS !== "builder" || !slug || req.body?.slug !== slug) {
      res.status(403).json({ error: "project owner differs from this Builder" });
      return;
    }
    try {
      res.json(await persist({ root: process.env.CUSTOMERS_DIR || "/home/node/.openclaw/customers", slug }));
    } catch (error) {
      logger.error("project persistence failed; local work must be retained", { slug, error: String(error) });
      res.status(503).json({ error: "Project remote save failed; local work retained" });
    }
  });
  return router;
}
