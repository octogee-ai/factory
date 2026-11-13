import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { FleetLogsQueryError, parseFleetLogsQuery, streamFleetLogs, } from "./fleet-logs.js";
function errorMessage(error) {
    return error instanceof Error ? error.message : String(error);
}
export function addAdminLogsRoutes(router, deps) {
    router.get("/logs", async (req, res, next) => {
        let query;
        try {
            query = parseFleetLogsQuery(req.query);
        }
        catch (error) {
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
                    if (!res.write(`${JSON.stringify(entry)}\n`))
                        await once(res, "drain", { signal: controller.signal });
                },
            });
            res.end();
        }
        catch (error) {
            if (controller.signal.aborted)
                return;
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
