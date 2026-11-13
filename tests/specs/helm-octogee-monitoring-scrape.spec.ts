import { describe, it, expect } from "vitest";
import { findDoc, useUmbrellaChart } from "./helpers/umbrella-chart";

// The umbrella's allow-monitoring-scrape NetworkPolicy opens gitea :3000 to the
// metrics scraper. Under Google Managed Service for Prometheus the scrapers are
// the managed collector DaemonSet in gke-gmp-system — NOT the monitoring
// namespace (which only holds Grafana + the gmp-frontend proxy). Pointing the
// allowance at the wrong namespace silently firewalls gitea metrics (up=0).
const chart = useUmbrellaChart("octogee-monscrape-chart-");

function helmTemplate(): string {
  return chart.helmTemplate();
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
