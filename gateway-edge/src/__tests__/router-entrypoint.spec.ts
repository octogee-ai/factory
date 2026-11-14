import { spawnSync } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const gatewayEdgeRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

const agentControlRouterKey = generateKeyPairSync("ed25519").privateKey.export({ type: "pkcs8", format: "pem" }).toString();

describe("gateway-edge router entrypoints", () => {
  it.each([
    { mode: "router", modeEnv: {} },
    { mode: "agent-control-router", modeEnv: { AGENT_CONTROL_ROUTER_KEY: agentControlRouterKey } },
  ])("boots $mode mode without sidecar-only env", ({ mode, modeEnv }) => {
    const env = {
      ...process.env,
      ...modeEnv,
      NODE_ENV: "production",
      GATEWAY_EDGE_MODE: mode,
      K8S_NAMESPACE: "octogee-test",
      PORT: "0",
    };
    delete env.MM_INTERNAL_URL;
    delete env.GATEWAY_ID;
    delete env.OPENCLAW_RUNTIME_BROKER_URL;

    const result = spawnSync(
      process.execPath,
      [
        "--import",
        "tsx",
        "-e",
        [
          'import("./src/main.ts").then(',
          "() => setTimeout(() => process.exit(0), 50),",
          "(err) => { console.error(err); process.exit(1); },",
          ");",
        ].join(""),
      ],
      {
        cwd: gatewayEdgeRoot,
        env,
        encoding: "utf8",
        timeout: 50_000,
      },
    );

    expect(result.status, result.stderr || result.stdout).toBe(0);
    expect(result.stderr).not.toContain("MM_INTERNAL_URL is required");
  });
});
