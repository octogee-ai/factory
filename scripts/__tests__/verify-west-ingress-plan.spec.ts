import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import {
  verifyWestIngressAddresses,
  verifyWestIngressPlan,
} from "../ops/verify-west-ingress-plan.mjs";

const names = [
  "gitea-ip-test-west",
  "gitea-ip-west",
  "mattermost-ip-test-west",
  "mattermost-ip-west",
  "preview-ip-test-west",
  "preview-ip-west",
  "workspace-api-ip-test-west",
  "workspace-api-ip-west",
];

const address = (name: string): string =>
  `google_compute_global_address.west_ingress["${name}"]`;

describe("WEST ingress reservation plan", () => {
  it("accepts exactly eight additive address creations", () => {
    expect(verifyWestIngressPlan({
      summary: { create: 8, update: 0, delete: 0, replace: 0 },
      changes: names.map((name) => ({ address: address(name), actions: ["create"] })),
    })).toBe("create");
  });

  it("accepts an idempotent zero-change rerun", () => {
    expect(verifyWestIngressPlan({
      summary: { create: 0, update: 0, delete: 0, replace: 0 },
      changes: [],
    })).toBe("unchanged");
  });

  it.each([
    ["missing address", names.slice(1).map((name) => ({ address: address(name), actions: ["create"] }))],
    ["replacement", names.map((name, index) => ({ address: address(name), actions: index === 0 ? ["delete", "create"] : ["create"] }))],
    ["unexpected address", [...names.slice(1).map((name) => ({ address: address(name), actions: ["create"] })), { address: 'google_compute_global_address.west_ingress["other"]', actions: ["create"] }]],
  ])("rejects a %s", (_label, changes) => {
    expect(() => verifyWestIngressPlan({
      summary: { create: 8, update: 0, delete: 0, replace: 0 },
      changes,
    })).toThrow("WEST ingress plan must be either zero-change or exactly eight address creates");
  });

  it("verifies every Terraform output name has a unique public IPv4 address", () => {
    const outputs = Object.fromEntries(
      names.map((name, index) => [name, `34.100.0.${index + 1}`]),
    );
    expect(verifyWestIngressAddresses(outputs)).toEqual(outputs);
  });

  it("rejects missing, duplicate, or non-IPv4 outputs", () => {
    const outputs = Object.fromEntries(
      names.map((name, index) => [name, `34.100.0.${index + 1}`]),
    );
    outputs[names[0]] = outputs[names[1]];
    expect(() => verifyWestIngressAddresses(outputs)).toThrow(
      "WEST ingress Terraform output must contain eight unique public IPv4 addresses",
    );
  });

  it("provides a stdin CLI for the operator script", () => {
    const output = execFileSync(
      process.execPath,
      [resolve(__dirname, "../ops/verify-west-ingress-plan.mjs"), "--plan"],
      {
        input: JSON.stringify({
          summary: { create: 0, update: 0, delete: 0, replace: 0 },
          changes: [],
        }),
        encoding: "utf8",
      },
    );
    expect(output.trim()).toBe("unchanged");
  });
});
