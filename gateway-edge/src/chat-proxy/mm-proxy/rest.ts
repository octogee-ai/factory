import http from "node:http";
import https from "node:https";
import { URL } from "node:url";

export interface MmRestProxyDeps {
  mmInternalUrl: string;
  log: (msg: string) => void;
}

const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailers",
  "transfer-encoding",
  "upgrade",
  "host",
]);

export function forwardMmRest(
  deps: MmRestProxyDeps,
  req: http.IncomingMessage,
  res: http.ServerResponse,
): void {
  const target = new URL(req.url ?? "/", deps.mmInternalUrl);
  const isHttps = target.protocol === "https:";
  const transport = isHttps ? https : http;

const forwardedHeaders: http.OutgoingHttpHeaders = {};
  for (const [key, value] of Object.entries(req.headers)) {
    if (HOP_BY_HOP_HEADERS.has(key.toLowerCase())) continue;
    if (value !== undefined) forwardedHeaders[key] = value;
  }
  forwardedHeaders["host"] = target.host;

  const upstream = transport.request(
    {
      protocol: target.protocol,
      hostname: target.hostname,
      port: target.port || (isHttps ? 443 : 80),
      path: target.pathname + target.search,
      method: req.method,
      headers: forwardedHeaders,
      timeout: 30_000,
    },
    (upstreamRes) => {
      const responseHeaders: http.OutgoingHttpHeaders = {};
      for (const [key, value] of Object.entries(upstreamRes.headers)) {
        if (HOP_BY_HOP_HEADERS.has(key.toLowerCase())) continue;
        if (value !== undefined) responseHeaders[key] = value;
      }
      res.writeHead(upstreamRes.statusCode ?? 502, responseHeaders);
      upstreamRes.pipe(res);
    },
  );

  upstream.on("error", (err) => {
    deps.log(`[mm-proxy/rest] upstream error: ${err.message} for ${req.method} ${req.url}`);

req.unpipe(upstream);
    req.resume();
    if (!res.headersSent) {
      res.writeHead(502, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Mattermost upstream unavailable" }));
    } else {
      res.end();
    }
  });

  upstream.on("timeout", () => {
    upstream.destroy(new Error("upstream timeout"));
  });

  req.pipe(upstream);
}
