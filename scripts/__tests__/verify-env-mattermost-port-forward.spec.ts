import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const script = readFileSync(resolve(import.meta.dirname, "../verify-env.sh"), "utf8");

describe("verify-env Mattermost admin port-forward", () => {
  it("extracts the dynamically assigned IPv4 loopback port from kubectl output", () => {
    const match = script.match(
      /MM_LOCAL_PORT=\$\(sed -nE '([^']+)' "\$MM_PORT_FORWARD_LOG" \| head -1\)/,
    );

    expect(match?.[1]).toBeDefined();
    const result = spawnSync("sed", ["-nE", match![1]], {
      encoding: "utf8",
      input: "Forwarding from 127.0.0.1:40123 -> 8065\n",
    });

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim()).toBe("40123");
  });
});
