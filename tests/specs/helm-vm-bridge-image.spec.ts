import { describe, expect, it } from "vitest";

import { findDoc, useUmbrellaChart } from "./helpers/umbrella-chart";

const chart = useUmbrellaChart("octogee-vm-bridge-image-");
const DIGEST = `sha256:${"e".repeat(64)}`;
const vms = {
  "global.computer.enabled": "true",
  "global.computer.cidr": "10.8.0.0/16",
  "global.computer.projectId": "example",
  "global.computer.serviceAccountEmail": "vm@example.iam.gserviceaccount.com",
  "global.computer.kubernetesApiHost": "10.0.0.1",
  "global.computer.vmSpec.machineType": "n2-standard-2",
  "global.computer.bridge.image.tag": "aaaaaaa",
  "global.computer.bridge.image.digest": DIGEST,
};

describe("VM bridge image", () => {
  it("runs the VM bridge Build main publishes when VMs are on", () => {
    const bridge = findDoc(chart.helmTemplate({ sets: vms }), "Deployment", "octogee-vm-bridge");
    expect(bridge).toContain(`image: "ghcr.io/octogee-ai/octogee-cloud/vm-bridge:aaaaaaa@${DIGEST}"`);
  });

  it.each(["tag", "digest"])("stops at render when global.computer.bridge.image.%s is empty", (field) => {
    expect(() => chart.helmTemplate({ sets: { ...vms, [`global.computer.bridge.image.${field}`]: "" } }))
      .toThrow(`global.computer.bridge.image.${field} is required`);
  });
});
