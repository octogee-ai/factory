import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const helper = resolve(import.meta.dirname, "../lib/grafana-health.sh");

function probe(body: string, exitCode = 0) {
  const root = mkdtempSync(join(tmpdir(), "octogee-grafana-health-"));
  try {
    const kubectl = join(root, "kubectl");
    const log = join(root, "calls.log");
    writeFileSync(kubectl, `#!/usr/bin/env bash
printf '%s\\n' "$*" >>"$GRAFANA_TEST_LOG"
printf '%s' "$GRAFANA_TEST_BODY"
exit "$GRAFANA_TEST_EXIT"
`);
    chmodSync(kubectl, 0o755);
    const result = spawnSync("bash", ["-c", 'source "$1"; octogee_verify_grafana_health test-context', "probe", helper], {
      encoding: "utf8",
      env: { ...process.env, PATH: `${root}:${process.env.PATH}`, GRAFANA_TEST_LOG: log,
        GRAFANA_TEST_BODY: body, GRAFANA_TEST_EXIT: String(exitCode) },
    });
    return { ...result, calls: result.status === 0 ? readFileSync(log, "utf8") : "" };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

describe("Grafana health verification", () => {
  it("checks the database over the Kubernetes service proxy without a container shell", () => {
    const result = probe('{"database":"ok","version":"13.2.1"}');
    expect(result.status).toBe(0);
    expect(result.calls).toContain("--raw=/api/v1/namespaces/monitoring/services/http:grafana:80/proxy/api/health");
    expect(result.calls).toContain("--context=test-context --request-timeout=15s");
  });

  it.each(['{"database":"failing"}', '{}', 'not-json'])("rejects an unhealthy or invalid response: %s", (body) => {
    const result = probe(body);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("Grafana health verification failed");
  });

  it("fails when the service proxy request fails", () => {
    const result = probe("", 1);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("Could not query Grafana health");
  });
});
