import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import type { NextFunction, Request, Response, Router } from "express";
import {
  FleetLogsQueryError,
  parseFleetLogsQuery,
  streamFleetLogs,
  type FleetLogsQuery,
  type LogEntriesSource,
} from "./fleet-logs.js";

export interface AdminLogsDeps {
  readonly source: LogEntriesSource | null;
  readonly namespace: string;
  readonly logger: { warn(message: string, meta?: Record<string, unknown>): void };
  readonly now?: () => number;
  readonly sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function addAdminLogsRoutes(router: Router, deps: AdminLogsDeps): Router {
  router.get("/logs", async (req: Request, res: Response, next: NextFunction) => {
    let query: FleetLogsQuery;
    try {
      query = parseFleetLogsQuery(req.query as Record<string, unknown>);
    } catch (error) {
      if (error instanceof FleetLogsQueryError) {
        res.status(400).json({ error: error.message });
        return;
      }
      next(error);
      return;
    }
    if (deps.source === null) {
      res.status(503).json({ error: "logs are not configured for this environment" });
      return;
    }
    const controller = new AbortController();
    res.on("close", () => controller.abort());
    let started = false;
    try {
      await streamFleetLogs({
        source: deps.source,
        namespace: deps.namespace,
        query,
        signal: controller.signal,
        now: deps.now ?? Date.now,
        sleep: deps.sleep ?? ((ms, signal) => delay(ms, undefined, { signal })),
        onStart: () => {
          res.status(200).type("application/x-ndjson");
          res.flushHeaders();
          started = true;
        },
        write: async (entry) => {
          if (!res.write(`${JSON.stringify(entry)}\n`)) await once(res, "drain", { signal: controller.signal });
        },
      });
      res.end();
    } catch (error) {
      if (controller.signal.aborted) return;
      if (!started) {
        next(error);
        return;
      }
      deps.logger.warn("fleet log stream failed", { error: errorMessage(error) });
      res.destroy(error instanceof Error ? error : new Error(errorMessage(error)));
    }
  });
  return router;
}
