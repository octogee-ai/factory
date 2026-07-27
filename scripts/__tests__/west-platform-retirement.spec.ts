import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { verifyWestPlatformRetirementPlan } from "../ops/verify-west-platform-retirement.mjs";

const repoRoot = path.resolve(__dirname, "../..");
const read = (relativePath: string) => readFileSync(path.join(repoRoot, relativePath), "utf8");

const change = (address: string, actions: string[]) => ({ address, actions });

describe("WEST platform retirement contract", () => {
  it("rejects every destructive action while normal protection is selected", () => {
    expect(() => verifyWestPlatformRetirementPlan({
      retirementEnabled: false,
      changes: [change("google_container_cluster.west", ["delete"])],
    })).toThrow("retirement mode is not enabled");
  });

  it("allows only the declared WEST global-address destruction set", () => {
    expect(verifyWestPlatformRetirementPlan({
      retirementEnabled: true,
      changes: [
        change('google_compute_global_address.west_ingress["gitea-ip-west"]', ["delete"]),
        change("google_compute_global_address.private_services", ["delete"]),
      ],
    })).toEqual("retirement");

    expect(() => verifyWestPlatformRetirementPlan({
      retirementEnabled: true,
      changes: [change('google_compute_global_address.monitoring_grafana', ["delete"])],
    })).toThrow("grafana-ip");
  });

  it("moves the shared Grafana address to the Central control-plane root", () => {
    const west = read("terraform/environments/west-platform/main.tf");
    const central = read("terraform/environments/control-plane/main.tf");

    expect(west).not.toContain('"grafana-ip"');
    expect(central).toContain('resource "google_compute_global_address" "monitoring_grafana"');
    expect(central).toContain('name    = "grafana-ip"');
    expect(central).toContain('prevent_destroy = true');
    expect(central).toContain('resource "google_project_iam_member" "monitoring_iap_operator"');
  });

  it("keeps normal mode protected and requires a named retirement confirmation", () => {
    const main = read("terraform/environments/west-platform/main.tf");
    const variables = read("terraform/environments/west-platform/variables.tf");

    expect(variables).toContain('variable "west_platform_retirement_mode"');
    expect(variables).toContain('variable "west_platform_retirement_confirmation"');
    expect(main).toContain("!local.west_platform_deletion_permitted");
    expect(main).toContain('local.west_platform_deletion_permitted ? "DELETE" : "PREVENT"');
    expect(main).toContain("retain_backups_on_delete    = !local.west_platform_deletion_permitted");
    expect(main).toContain("RETIRE-WEST-PLATFORM");
  });
});
