import { describe, expect, it } from "vitest";
import { testFleetPodObservations, testFleetVmObservation } from "../lib/test-fleet-observation.js";

const digest = `sha256:${"a".repeat(64)}`;
const image = `registry/gateway:tag@${digest}`;
const pod = {
  metadata: { uid: "pod-1", labels: { "gateway-instance": "shared-0" } },
  spec: { containers: [{ name: "gateway", image }] },
  status: { phase: "Running", conditions: [{ type: "Ready", status: "True" }], containerStatuses: [{ name: "gateway", imageID: `docker-pullable://registry/gateway@${digest}`, ready: true, state: { running: {} } }] },
};

describe("TEST live image observations", () => {
  it("uses observed Kubernetes imageID rather than accepting the pod image specification", () => {
    const current = structuredClone(pod);
    current.status.containerStatuses[0].imageID = `docker-pullable://registry/gateway@sha256:${"b".repeat(64)}`;
    expect(testFleetPodObservations({ items: [current] }, 123).get("shared-0")?.instances[0].containers[0]).toMatchObject({ image, digests: [`sha256:${"b".repeat(64)}`], running: true });
  });
  it("retains terminating old pods as not ready until they disappear", () => {
    const current = { ...pod, metadata: { ...pod.metadata, deletionTimestamp: "now" } };
    expect(testFleetPodObservations({ items: [current] }, 123).get("shared-0")?.instances[0].ready).toBe(false);
  });
  it("does not count terminal pods as live instances", () => {
    expect(testFleetPodObservations({ items: [{ ...pod, status: { ...pod.status, phase: "Succeeded" } }] }, 123).get("shared-0")?.instances).toEqual([]);
  });
  it("refuses unidentifiable gateway pods", () => {
    expect(() => testFleetPodObservations({ items: [{ ...pod, metadata: {} }] }, 123)).toThrow("gateway-instance");
  });
  it("binds guest observations to the currently running VM instance", () => {
    const runtime = { vm: { instanceId: "1", status: "RUNNING" }, vmImages: { instanceId: "1", observedAt: 123, containers: ["gateway", "gateway-edge"].map((name) => ({ name, imageReference: image, digests: [`registry/gateway@${digest}`], running: true })) } };
    expect(testFleetVmObservation(runtime)?.instances[0].containers[0].digests).toEqual([digest]);
    expect(testFleetVmObservation({ ...runtime, vm: { instanceId: "2", status: "RUNNING" } })).toBeNull();
    expect(testFleetVmObservation({ ...runtime, vm: { instanceId: "1", status: "TERMINATED" } })).toBeNull();
  });
});
