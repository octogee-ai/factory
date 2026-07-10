import { describe, it, expect, vi } from "vitest";
import {
  createGatewayServiceAccountEnsurer,
  serviceAccountManifest,
} from "../gateway-service-account-ensurer.js";
import type { KubectlSubprocessResult } from "../fleet-ingress.js";

function ok(stdout = ""): KubectlSubprocessResult {
  return { stdout, stderr: "", code: 0 };
}

describe("serviceAccountManifest", () => {
  it("always renders Helm's keep policy on the gateway-scoped ServiceAccount", () => {
    const m = serviceAccountManifest({ namespace: "octogee", serviceAccountName: "octogee-gw-default" });
    expect(m).toContain("kind: ServiceAccount");
    expect(m).toContain("name: octogee-gw-default");
    expect(m).toContain("namespace: octogee");
    expect(m).toContain("annotations:");
    expect(m).toContain("helm.sh/resource-policy: keep");
  });

  it("renders the Workload Identity annotation for operator gateways", () => {
    const m = serviceAccountManifest({
      namespace: "octogee",
      serviceAccountName: "octogee-gw-bender",
      annotations: { "iam.gke.io/gcp-service-account": "gw@proj.iam.gserviceaccount.com" },
    });
    expect(m).toContain("iam.gke.io/gcp-service-account: gw@proj.iam.gserviceaccount.com");
    expect(m).toContain("helm.sh/resource-policy: keep");
  });
});

describe("createGatewayServiceAccountEnsurer", () => {
  it("applies the gateway-scoped KSA via kubectl apply -f - (idempotent create-or-update)", async () => {
    const runKubectl = vi.fn(async () => ok());
    const log = vi.fn();
    const ensurer = createGatewayServiceAccountEnsurer({ runKubectl, log });

    await ensurer.ensureServiceAccount({
      namespace: "octogee",
      serviceAccountName: "octogee-gw-default",
    });

    expect(runKubectl).toHaveBeenCalledTimes(1);
    const [args, opts] = runKubectl.mock.calls[0];
    expect(args).toEqual(["apply", "-n", "octogee", "-f", "-"]);
    expect(opts?.stdin).toContain("name: octogee-gw-default");
  });

  it("passes the operator Workload Identity annotation into the applied manifest", async () => {
    const runKubectl = vi.fn(async () => ok());
    const ensurer = createGatewayServiceAccountEnsurer({ runKubectl, log: vi.fn() });

    await ensurer.ensureServiceAccount({
      namespace: "octogee",
      serviceAccountName: "octogee-gw-bender",
      annotations: { "iam.gke.io/gcp-service-account": "gw@proj.iam.gserviceaccount.com" },
    });

    const [, opts] = runKubectl.mock.calls[0];
    expect(opts?.stdin).toContain("iam.gke.io/gcp-service-account: gw@proj.iam.gserviceaccount.com");
  });

  it("throws (no silent failure) when kubectl apply fails", async () => {
    const runKubectl = vi.fn(async () => ({ stdout: "", stderr: "boom", code: 1 }));
    const ensurer = createGatewayServiceAccountEnsurer({ runKubectl, log: vi.fn() });

    await expect(
      ensurer.ensureServiceAccount({ namespace: "octogee", serviceAccountName: "octogee-gw-default" }),
    ).rejects.toThrow(/octogee-gw-default/);
  });
});
