import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const gatewayEdgeRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

describe("gateway-router entrypoint", () => {
  it("boots without sidecar-only Mattermost env", () => {
    const env = {
      ...process.env,
      NODE_ENV: "production",
      GATEWAY_EDGE_MODE: "router",
      GATEWAY_ROUTER_PREVIEW_HOST: "preview-test.octogee.com",
      K8S_NAMESPACE: "octogee-test",
      PORT: "0",
    };
    delete env.MM_INTERNAL_URL;

    const result = spawnSync(
      process.execPath,
      [
        "--import",
        "tsx",
        "-e",
        [
          'import("./src/index.ts").then(',
          "() => setTimeout(() => process.exit(0), 50),",
          "(err) => { console.error(err); process.exit(1); },",
          ");",
        ].join(""),
      ],
      {
        cwd: gatewayEdgeRoot,
        env,
        encoding: "utf8",
        timeout: 5_000,
      },
    );

    expect(result.status, result.stderr || result.stdout).toBe(0);
    expect(result.stderr).not.toContain("MM_INTERNAL_URL is required");
  });
});
