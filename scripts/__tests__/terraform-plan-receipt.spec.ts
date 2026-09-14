import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import {
  buildPlanReceipt,
  type TerraformPlan,
  type TerraformPlanAction,
} from "../ops/terraform-plan-receipt.mjs";

const plan = (changes: TerraformPlan["resource_changes"]): TerraformPlan => ({
  format_version: "1.2",
  terraform_version: "1.16.2",
  resource_changes: changes,
});

const convergencePlan = (overrides: Partial<TerraformPlan> = {}): TerraformPlan => ({
  complete: true,
  errored: false,
  checks: [{ status: "pass" }],
  resource_changes: [],
  ...overrides,
});

const convergenceOptions = {
  target: "test-west",
  phase: "pre-release-convergence",
  generatedAt: "2026-07-24T08:00:00.000Z",
  gitCommit: "abc123",
  allowedDestructiveAddresses: new Set<string>(),
  preReleaseConvergence: true,
};

const firestoreEtagDrift = {
  address: "module.data_project.google_firestore_database.default",
  type: "google_firestore_database",
  change: {
    actions: ["update" as const],
    before: { etag: "before", location_id: "us-west1" },
    after: { etag: "after", location_id: "us-west1" },
    after_unknown: {},
    before_sensitive: { cmek_config: [] },
    after_sensitive: { cmek_config: [] },
  },
};

const cloudSqlClientEtagDrift = {
  address: "module.iam.google_project_iam_member.cloudsql_client",
  type: "google_project_iam_member",
  change: {
    actions: ["update" as const],
    before: {
      condition: [],
      etag: "before",
      id: "octogee-data-test/roles/cloudsql.client/serviceAccount:cloudsql@test",
      member: "serviceAccount:cloudsql@test",
      project: "octogee-data-test",
      role: "roles/cloudsql.client",
    },
    after: {
      condition: [],
      etag: "after",
      id: "octogee-data-test/roles/cloudsql.client/serviceAccount:cloudsql@test",
      member: "serviceAccount:cloudsql@test",
      project: "octogee-data-test",
      role: "roles/cloudsql.client",
    },
    after_unknown: {},
    before_sensitive: { condition: [] },
    after_sensitive: { condition: [] },
  },
};

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

  it("permits the reviewed Cloud SQL recovery IAM replacement but no other IAM replacement", () => {
    const reviewedAddress = "google_storage_bucket_iam_member.cloud_sql_recovery";
    const options = {
      target: "west-platform",
      phase: "pre-apply",
      generatedAt: "2026-07-23T19:00:00.000Z",
      gitCommit: "abc123",
      allowedDestructiveAddresses: new Set([reviewedAddress]),
    };

    expect(
      buildPlanReceipt(
        plan([{ address: reviewedAddress, change: { actions: ["delete", "create"] } }]),
        options,
      ).summary,
    ).toEqual({ create: 0, update: 0, delete: 0, replace: 1 });
    expect(() =>
      buildPlanReceipt(
        plan([
          {
            address: "google_storage_bucket_iam_member.unexpected",
            change: { actions: ["delete", "create"] },
          },
        ]),
        options,
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

  it.each([["create"], ["update"], ["delete"], ["delete", "create"]])(
    "never emits a v1 all-zero receipt for provider-reported %s drift",
    (...actions) => {
      expect(() =>
        buildPlanReceipt(
          { ...plan([]), resource_drift: [{ address: "google_project.data", change: { actions } }] },
          {
            target: "west-platform",
            phase: "pre-apply",
            generatedAt: "2026-07-24T08:00:00.000Z",
            gitCommit: "abc123",
            allowedDestructiveAddresses: new Set(),
          },
        ),
      ).toThrow("Plan contains provider-reported resource drift");
    },
  );

  it("rejects unknown provider-reported drift actions in a v1 receipt", () => {
    expect(() =>
      buildPlanReceipt(
        {
          ...plan([]),
          resource_drift: [{
            address: "google_project.data",
            change: { actions: ["future-action"] as unknown as TerraformPlanAction[] },
          }],
        },
        {
          target: "west-platform",
          phase: "pre-apply",
          generatedAt: "2026-07-24T08:00:00.000Z",
          gitCommit: "abc123",
          allowedDestructiveAddresses: new Set(),
        },
      ),
    ).toThrow("Plan contains provider-reported resource drift");
  });

  it("records the exact Firestore etag drift source in the schema-v2 convergence receipt", () => {
    const receipt = buildPlanReceipt(
      convergencePlan({ resource_drift: [firestoreEtagDrift] }),
      convergenceOptions,
    );

    expect(receipt).toMatchObject({
      schemaVersion: 2,
      phase: "pre-release-convergence",
      summary: { create: 0, update: 0, delete: 0, replace: 0 },
      changes: [],
      knownVolatileMetadataExceptions: [{
        source: "resource_drift",
        address: "module.data_project.google_firestore_database.default",
        resourceType: "google_firestore_database",
        actions: ["update"],
        changedTopLevelPaths: ["etag"],
      }],
    });
    expect(JSON.stringify(receipt)).not.toContain("before");
    expect(JSON.stringify(receipt)).not.toContain("after");
  });

  it("records both independently understood etag-only provider drifts in the schema-v2 convergence receipt", () => {
    const receipt = buildPlanReceipt(
      convergencePlan({ resource_drift: [firestoreEtagDrift, cloudSqlClientEtagDrift] }),
      convergenceOptions,
    );

    expect(receipt.knownVolatileMetadataExceptions).toEqual([
      {
        source: "resource_drift",
        address: "module.data_project.google_firestore_database.default",
        resourceType: "google_firestore_database",
        actions: ["update"],
        changedTopLevelPaths: ["etag"],
      },
      {
        source: "resource_drift",
        address: "module.iam.google_project_iam_member.cloudsql_client",
        resourceType: "google_project_iam_member",
        actions: ["update"],
        changedTopLevelPaths: ["etag"],
      },
    ]);
  });

  it.each([
    ["a matching resource change", convergencePlan({ resource_changes: [firestoreEtagDrift] })],
    ["a duplicate exact drift entry", convergencePlan({ resource_drift: [firestoreEtagDrift, firestoreEtagDrift] })],
    ["an unexpected provider type", convergencePlan({
      resource_drift: [{ ...firestoreEtagDrift, type: "google_project_iam_member" }],
    })],
    ["unreviewed IAM metadata that remains equal on both sides", convergencePlan({
      resource_drift: [{
        ...cloudSqlClientEtagDrift,
        change: {
          ...cloudSqlClientEtagDrift.change,
          before: { ...cloudSqlClientEtagDrift.change.before, unreviewed_metadata: "same" },
          after: { ...cloudSqlClientEtagDrift.change.after, unreviewed_metadata: "same" },
        },
      }],
    })],
    ["an incomplete plan", convergencePlan({ complete: false })],
    ["an errored plan", convergencePlan({ errored: true })],
    ["a failed check", convergencePlan({ checks: [{ status: "fail" }] })],
    ["an unknown check", convergencePlan({ checks: [{ status: "unknown" }] })],
    ["a deferred change", convergencePlan({ deferred_changes: [] })],
    ["unknown Firestore metadata", convergencePlan({
      resource_drift: [{
        ...firestoreEtagDrift,
        change: { ...firestoreEtagDrift.change, after_unknown: { location_id: true } },
      }],
    })],
    ["an introduced etag", convergencePlan({
      resource_drift: [{
        ...firestoreEtagDrift,
        change: {
          ...firestoreEtagDrift.change,
          before: { location_id: "us-west1" },
        },
      }],
    })],
    ["a removed etag", convergencePlan({
      resource_drift: [{
        ...firestoreEtagDrift,
        change: {
          ...firestoreEtagDrift.change,
          after: { location_id: "us-west1" },
        },
      }],
    })],
    ["an empty etag", convergencePlan({
      resource_drift: [{
        ...firestoreEtagDrift,
        change: { ...firestoreEtagDrift.change, after: { etag: "", location_id: "us-west1" } },
      }],
    })],
    ["a null etag", convergencePlan({
      resource_drift: [{
        ...firestoreEtagDrift,
        change: { ...firestoreEtagDrift.change, after: { etag: null, location_id: "us-west1" } },
      }],
    })],
    ["a non-string etag", convergencePlan({
      resource_drift: [{
        ...firestoreEtagDrift,
        change: { ...firestoreEtagDrift.change, after: { etag: 42, location_id: "us-west1" } },
      }],
    })],
    ["an unchanged etag", convergencePlan({
      resource_drift: [{
        ...firestoreEtagDrift,
        change: { ...firestoreEtagDrift.change, after: { etag: "before", location_id: "us-west1" } },
      }],
    })],
    ["extra sensitivity metadata", convergencePlan({
      resource_drift: [{
        ...firestoreEtagDrift,
        change: {
          ...firestoreEtagDrift.change,
          before_sensitive: { cmek_config: [], extra: [] },
          after_sensitive: { cmek_config: [], extra: [] },
        },
      }],
    })],
  ])("rejects schema-v2 convergence evidence containing %s", (_label, invalidPlan) => {
    expect(() => buildPlanReceipt(invalidPlan, convergenceOptions)).toThrow();
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
