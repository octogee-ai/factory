import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import {
  buildPlanReceipt,
  type TerraformPlan,
} from "../ops/terraform-plan-receipt.mjs";

const plan = (changes: TerraformPlan["resource_changes"]): TerraformPlan => ({
  format_version: "1.2",
  terraform_version: "1.15.8",
  resource_changes: changes,
});

describe("Terraform plan receipt", () => {
  it("emits only secret-free resource actions and deterministic counts", () => {
    const receipt = buildPlanReceipt(
      plan([
        {
          address: "google_compute_network.west",
          change: { actions: ["create"], after: { private_value: "must-not-leak" } },
        },
        {
          address: "google_container_cluster.west",
          change: { actions: ["delete", "create"], before: { token: "must-not-leak" } },
        },
        {
          address: "google_pubsub_topic.gke_notifications",
          change: { actions: ["no-op"] },
        },
      ]),
      {
        target: "west-platform",
        phase: "pre-apply",
        generatedAt: "2026-07-22T19:00:00.000Z",
        gitCommit: "abc123",
        allowedDestructiveAddresses: new Set(["google_container_cluster.west"]),
      },
    );

    expect(receipt.summary).toEqual({ create: 1, update: 0, delete: 0, replace: 1 });
    expect(receipt.changes).toEqual([
      { address: "google_compute_network.west", actions: ["create"] },
      { address: "google_container_cluster.west", actions: ["delete", "create"] },
    ]);
    expect(JSON.stringify(receipt)).not.toContain("must-not-leak");
  });

  it("fails closed on an unreviewed delete or replacement", () => {
    expect(() =>
      buildPlanReceipt(
        plan([
          {
            address: "google_sql_database_instance.unexpected",
            change: { actions: ["delete"] },
          },
        ]),
        {
          target: "west-platform",
          phase: "pre-apply",
          generatedAt: "2026-07-22T19:00:00.000Z",
          gitCommit: "abc123",
          allowedDestructiveAddresses: new Set(),
        },
      ),
    ).toThrow("Plan contains an unauthorized destructive change");
  });

  it("fails closed on every unreviewed mutation when a change allowlist is supplied", () => {
    expect(() =>
      buildPlanReceipt(
        plan([
          {
            address: "google_compute_network.unexpected",
            change: { actions: ["create"] },
          },
        ]),
        {
          target: "west-platform",
          phase: "pre-apply",
          generatedAt: "2026-07-22T19:00:00.000Z",
          gitCommit: "abc123",
          allowedDestructiveAddresses: new Set(),
          allowedChangeAddresses: new Set(),
        },
      ),
    ).toThrow("Plan contains an unauthorized change");
  });

  it("reads plan JSON from stdin and writes the secret-free CLI receipt", () => {
    const output = execFileSync(
      process.execPath,
      [
        resolve(__dirname, "../ops/terraform-plan-receipt.mjs"),
        "--target=west-platform",
        "--phase=pre-apply",
        "--generated-at=2026-07-22T19:00:00.000Z",
        "--git-commit=abc123",
        "--allow-change=google_compute_network.west",
      ],
      {
        input: JSON.stringify(
          plan([
            {
              address: "google_compute_network.west",
              change: { actions: ["create"], after: { private_value: "must-not-leak" } },
            },
          ]),
        ),
        encoding: "utf8",
      },
    );

    expect(JSON.parse(output)).toMatchObject({
      target: "west-platform",
      phase: "pre-apply",
      generatedAt: "2026-07-22T19:00:00.000Z",
      gitCommit: "abc123",
      summary: { create: 1, update: 0, delete: 0, replace: 0 },
    });
    expect(output).not.toContain("must-not-leak");
  });
});
