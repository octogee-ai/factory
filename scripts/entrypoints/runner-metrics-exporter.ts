#!/usr/bin/env tsx

import { createServer } from "node:http";

import {
  DEFAULT_HEARTBEAT_DIR,
  readHeartbeats,
  renderPrometheus,
} from "../lib/runner-heartbeat.js";

// Always-on (all gateway profiles) Prometheus exporter for the in-pod runner
// heartbeats. One scrape target for every supervised runner; a single
// ServiceMonitor points Prometheus here. See
// docs/specs/GATEWAY-RUNNER-OBSERVABILITY-SPEC.md.
const port = Number(process.env.OCTOGEE_RUNNER_METRICS_PORT ?? 9092);
const dir = process.env.OCTOGEE_RUNNER_HEARTBEAT_DIR ?? DEFAULT_HEARTBEAT_DIR;

const server = createServer((req, res) => {
  if (req.url === "/healthz") {
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("ok");
    return;
  }
  if (req.url === "/metrics") {
    const body = renderPrometheus(readHeartbeats(dir), Date.now());
    res.writeHead(200, { "content-type": "text/plain; version=0.0.4" });
    res.end(body);
    return;
  }
  res.writeHead(404, { "content-type": "text/plain" });
  res.end("not found");
});

server.listen(port, () => {
  console.warn(`[runner-metrics-exporter] listening on :${port} (heartbeats: ${dir})`);
});

process.on("SIGTERM", () => server.close(() => process.exit(0)));
process.on("SIGINT", () => server.close(() => process.exit(0)));
