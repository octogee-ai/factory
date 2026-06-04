import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawnSync } from "node:child_process";
import * as os from "node:os";
import * as path from "node:path";
import * as fs from "node:fs";

// The umbrella's allow-monitoring-scrape NetworkPolicy opens gitea :3000 to the
// metrics scraper. Under Google Managed Service for Prometheus the scrapers are
// the managed collector DaemonSet in gke-gmp-system — NOT the monitoring
// namespace (which only holds Grafana + the gmp-frontend proxy). Pointing the
// allowance at the wrong namespace silently firewalls gitea metrics (up=0).
const REPO_ROOT = path.resolve(__dirname, "../..");
const UMBRELLA_PATH = path.join(REPO_ROOT, "helm/octogee");
const VALUES_TEST = path.join(REPO_ROOT, "helm/octogee/values.test.yaml");
const LOCAL_SUBCHART_PACKAGES = new Set([
  "chat-proxy-0.1.0.tgz",
  "cloud-sql-proxy-0.1.0.tgz",
  "glm-controller-0.1.0.tgz",
  "mattermost-0.1.0.tgz",
  "gateway-edge-0.1.0.tgz",
]);

let chartUnderTest = UMBRELLA_PATH;
let tempChartRoot: string | null = null;

beforeAll(() => {
  if (!fs.existsSync(UMBRELLA_PATH)) {
    throw new Error(`umbrella chart not found at ${UMBRELLA_PATH}`);
  }
  tempChartRoot = fs.mkdtempSync(path.join(os.tmpdir(), "octogee-monscrape-chart-"));
  chartUnderTest = path.join(tempChartRoot, "octogee");
  fs.cpSync(UMBRELLA_PATH, chartUnderTest, {
    recursive: true,
    filter: (src) => !LOCAL_SUBCHART_PACKAGES.has(path.basename(src)),
  });
});

afterAll(() => {
  if (tempChartRoot) fs.rmSync(tempChartRoot, { recursive: true, force: true });
});

function helmTemplate(): string {
  const result = spawnSync(
    "helm",
    ["template", "octogee", chartUnderTest, "-f", VALUES_TEST, "-n", "octogee-test"],
    { encoding: "utf-8" },
  );
  if (result.status !== 0) {
    throw new Error(
      `helm template failed (status=${result.status}):\n--- stderr ---\n${result.stderr.slice(0, 2000)}`,
    );
  }
  return result.stdout;
}

function findDoc(out: string, kind: string, name: string): string | null {
  const docs = out.split(/^---\s*$/m);
  return (
    docs.find((d) => {
      if (!new RegExp(`^kind:\\s*${kind}\\s*$`, "m").test(d)) return false;
      return new RegExp(`^  name:\\s*${name}\\s*$`, "m").test(d);
    }) ?? null
  );
}

describe("umbrella — allow-monitoring-scrape NetworkPolicy (gitea metrics)", () => {
  it("scopes the policy to gitea pods only", () => {
    const np = findDoc(helmTemplate(), "NetworkPolicy", "allow-monitoring-scrape");
    expect(np).not.toBeNull();
    expect(np!).toMatch(/podSelector:[\s\S]*?app\.kubernetes\.io\/name:\s*gitea/);
  });

  it("admits the GMP collector namespace (gke-gmp-system), not the monitoring namespace, to gitea :3000", () => {
    const np = findDoc(helmTemplate(), "NetworkPolicy", "allow-monitoring-scrape");
    expect(np).not.toBeNull();
    expect(np!).toMatch(/namespaceSelector:[\s\S]*?kubernetes\.io\/metadata\.name:\s*gke-gmp-system/);
    expect(np!).toMatch(/port:\s*3000/);
    // Regression guard: the pre-GMP monitoring-namespace allowance firewalls the
    // managed collectors and takes gitea metrics dark.
    expect(np!).not.toMatch(/kubernetes\.io\/metadata\.name:\s*monitoring\b/);
  });
});
