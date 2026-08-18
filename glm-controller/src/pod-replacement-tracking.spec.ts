import { describe, expect, it } from "vitest";

import type { GatewayPodPlacement } from "@octogee/shared/types/gateway-pod-replacements";
import {
  gatewayPlanToken,
  nextPodReplacementTransition,
  observedPodPlacements,
} from "./pod-replacement-tracking.js";

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const NOW = 1_770_000_000_000;

const RUNNING = gatewayPlanToken({
  desiredRelease: 4,
  liveRelease: 4,
  desiredStatus: "running",
});

function placement(uid: string, overrides: Partial<GatewayPodPlacement> = {}): GatewayPodPlacement {
  return {
    uid,
    nodeName: "gk3-octogee-gateway-nap-1dx2tv8d-3ce41e28-q7zd",
    instanceId: "7311234567890123456",
    nodePool: "nap-1dx2tv8d",
    ...overrides,
  };
}

function transition(overrides: {
  previousPlacements?: readonly GatewayPodPlacement[] | null;
  previousPlanToken?: string | null;
  previous?: Parameters<typeof nextPodReplacementTransition>[0]["previous"];
  observedPlacements?: readonly GatewayPodPlacement[] | null;
  planToken?: string;
  now?: number;
}) {
  return nextPodReplacementTransition({
    previousPlacements: overrides.previousPlacements === undefined
      ? [placement("uid-a")]
      : overrides.previousPlacements,
    previousPlanToken: overrides.previousPlanToken === undefined
      ? RUNNING
      : overrides.previousPlanToken,
    previous: overrides.previous ?? null,
    observedPlacements: overrides.observedPlacements === undefined
      ? [placement("uid-b")]
      : overrides.observedPlacements,
    planToken: overrides.planToken ?? RUNNING,
    now: overrides.now ?? NOW,
  });
}

describe("gatewayPlanToken", () => {
  it("changes when the desired release moves", () => {
    expect(gatewayPlanToken({ desiredRelease: 5, liveRelease: 4, desiredStatus: "running" }))
      .not.toBe(RUNNING);
  });

  it("changes when the live release converges", () => {
    expect(gatewayPlanToken({ desiredRelease: 4, liveRelease: 3, desiredStatus: "running" }))
      .not.toBe(RUNNING);
  });

  it("changes when the desired status moves", () => {
    expect(gatewayPlanToken({ desiredRelease: 4, liveRelease: 4, desiredStatus: "paused" }))
      .not.toBe(RUNNING);
  });

  it("is stable for an unchanged desired state", () => {
    expect(gatewayPlanToken({ desiredRelease: 4, liveRelease: 4, desiredStatus: "running" }))
      .toBe(RUNNING);
  });

  it("distinguishes an unconverged gateway from a null live release", () => {
    expect(gatewayPlanToken({ desiredRelease: 4, liveRelease: null, desiredStatus: "running" }))
      .not.toBe(RUNNING);
  });
});

describe("observedPodPlacements", () => {
  it("returns null when diagnostics are unreadable so nothing is attributed", () => {
    expect(observedPodPlacements({ status: "unknown", totalPods: 0, readyPods: 0 })).toBeNull();
    expect(observedPodPlacements(undefined)).toBeNull();
    expect(observedPodPlacements({
      status: "ready", totalPods: 1, readyPods: 1, error: "kubectl exploded",
    })).toBeNull();
  });

  it("returns an empty set for a legitimately observed missing pod", () => {
    expect(observedPodPlacements({ status: "missing", totalPods: 0, readyPods: 0, pods: [] }))
      .toEqual([]);
  });

  it("carries the node identity needed to join a preemption record", () => {
    expect(observedPodPlacements({
      status: "ready",
      totalPods: 1,
      readyPods: 1,
      pods: [{
        uid: "uid-a",
        nodeName: "gk3-octogee-gateway-nap-1dx2tv8d-3ce41e28-q7zd",
        instanceId: "7311234567890123456",
        nodePool: "nap-1dx2tv8d",
      }],
    })).toEqual([{
      uid: "uid-a",
      nodeName: "gk3-octogee-gateway-nap-1dx2tv8d-3ce41e28-q7zd",
      instanceId: "7311234567890123456",
      nodePool: "nap-1dx2tv8d",
    }]);
  });

  it("tolerates a pod that has not been scheduled onto a node yet", () => {
    expect(observedPodPlacements({
      status: "not-ready", totalPods: 1, readyPods: 0, pods: [{ uid: "uid-a" }],
    })).toEqual([{ uid: "uid-a", nodeName: null, instanceId: null, nodePool: null }]);
  });

  it("sorts and de-duplicates identities so set comparison is order-independent", () => {
    const placements = observedPodPlacements({
      status: "ready",
      totalPods: 3,
      readyPods: 3,
      pods: [{ uid: "uid-c" }, { uid: "uid-a" }, { uid: "uid-c" }],
    });
    expect(placements?.map((pod) => pod.uid)).toEqual(["uid-a", "uid-c"]);
  });

  it("refuses to guess when a pod carries no uid", () => {
    expect(observedPodPlacements({
      status: "ready", totalPods: 1, readyPods: 1, pods: [{ uid: null }],
    })).toBeNull();
  });
});

describe("nextPodReplacementTransition", () => {
  it("counts a vanished pod when the desired state did not move", () => {
    const result = transition({});
    expect(result).not.toBeNull();
    expect(result!.vacated.map((pod) => pod.uid)).toEqual(["uid-a"]);
    expect(result!.replacements.total).toBe(1);
    expect(result!.replacements.recentAt).toEqual([NOW]);
    expect(result!.replacements.lastAt).toBe(NOW);
    expect(result!.placements.map((pod) => pod.uid)).toEqual(["uid-b"]);
  });

  it("records the vacated node identity that joins to the preemption record", () => {
    const result = transition({
      previousPlacements: [placement("uid-a", {
        nodeName: "gk3-octogee-gateway-nap-1dx2tv8d-3ce41e28-q7zd",
        instanceId: "7311234567890123456",
        nodePool: "nap-1dx2tv8d",
      })],
    });
    expect(result!.replacements.lastVacatedPodUid).toBe("uid-a");
    expect(result!.replacements.lastVacatedNodeName)
      .toBe("gk3-octogee-gateway-nap-1dx2tv8d-3ce41e28-q7zd");
    expect(result!.replacements.lastVacatedInstanceId).toBe("7311234567890123456");
    expect(result!.replacements.lastVacatedNodePool).toBe("nap-1dx2tv8d");
  });

  it("attributes the vacated node even when no successor pod exists yet", () => {
    const result = transition({ observedPlacements: [] });
    expect(result!.vacated.map((pod) => pod.uid)).toEqual(["uid-a"]);
    expect(result!.replacements.total).toBe(1);
    expect(result!.replacements.lastVacatedInstanceId).toBe("7311234567890123456");
    expect(result!.placements).toEqual([]);
  });

  it("does not count pod churn across a release change", () => {
    const result = transition({
      planToken: gatewayPlanToken({
        desiredRelease: 5,
        liveRelease: 4,
        desiredStatus: "running",
      }),
    });
    expect(result!.vacated).toEqual([]);
    expect(result!.replacements.total).toBe(0);
    expect(result!.replacements.recentAt).toEqual([]);
    expect(result!.replacements.lastVacatedPodUid).toBeNull();
    expect(result!.placements.map((pod) => pod.uid)).toEqual(["uid-b"]);
  });

  it("does not count pod churn across a desired-status change", () => {
    const result = transition({
      planToken: gatewayPlanToken({
        desiredRelease: 4,
        liveRelease: 4,
        desiredStatus: "paused",
      }),
    });
    expect(result!.vacated).toEqual([]);
    expect(result!.replacements.total).toBe(0);
  });

  it("does not count the first observation of a gateway", () => {
    const result = transition({ previousPlacements: null, previousPlanToken: null });
    expect(result!.vacated).toEqual([]);
    expect(result!.placements.map((pod) => pod.uid)).toEqual(["uid-b"]);
  });

  it("does not count an unchanged pod identity set", () => {
    const result = transition({
      previousPlacements: [placement("uid-a")],
      observedPlacements: [placement("uid-a")],
    });
    expect(result!.vacated).toEqual([]);
    expect(result!.replacements.total).toBe(0);
  });

  it("does not count a newly appeared pod on its own", () => {
    const result = transition({
      previousPlacements: [],
      observedPlacements: [placement("uid-b")],
    });
    expect(result!.vacated).toEqual([]);
    expect(result!.replacements.total).toBe(0);
  });

  it("counts the loss once across the empty window and its recovery", () => {
    const gone = transition({
      previousPlacements: [placement("uid-a")],
      observedPlacements: [],
    });
    const back = transition({
      previousPlacements: gone!.placements,
      previous: gone!.replacements,
      observedPlacements: [placement("uid-b")],
      now: NOW + HOUR,
    });
    expect(gone!.replacements.total).toBe(1);
    expect(back!.replacements.total).toBe(1);
    expect(back!.replacements.lastVacatedPodUid).toBe("uid-a");
  });

  it("counts each vanished identity when several pods are lost at once", () => {
    const result = transition({
      previousPlacements: [placement("uid-a"), placement("uid-b")],
      observedPlacements: [placement("uid-c")],
    });
    expect(result!.vacated.map((pod) => pod.uid)).toEqual(["uid-a", "uid-b"]);
    expect(result!.replacements.recentAt).toEqual([NOW, NOW]);
    expect(result!.replacements.total).toBe(2);
  });

  it("skips accounting entirely when diagnostics are unreadable", () => {
    expect(transition({ observedPlacements: null })).toBeNull();
  });

  it("counts the loss after diagnostics recover from an unreadable window", () => {
    expect(transition({ observedPlacements: null })).toBeNull();
    const recovered = transition({
      previousPlacements: [placement("uid-a")],
      observedPlacements: [placement("uid-b")],
    });
    expect(recovered!.replacements.total).toBe(1);
  });

  it("carries prior history forward and appends the new loss", () => {
    const result = transition({
      previous: {
        recentAt: [NOW - 2 * HOUR],
        lastAt: NOW - 2 * HOUR,
        lastVacatedPodUid: "uid-old",
        lastVacatedNodeName: "node-old",
        lastVacatedInstanceId: "111",
        lastVacatedNodePool: "nap-old",
        total: 5,
      },
    });
    expect(result!.replacements.recentAt).toEqual([NOW - 2 * HOUR, NOW]);
    expect(result!.replacements.total).toBe(6);
  });

  it("drops window entries older than seven days while keeping the lifetime total", () => {
    const result = transition({
      previous: {
        recentAt: [NOW - 8 * DAY, NOW - 2 * DAY],
        lastAt: NOW - 2 * DAY,
        lastVacatedPodUid: "uid-old",
        lastVacatedNodeName: null,
        lastVacatedInstanceId: null,
        lastVacatedNodePool: null,
        total: 7,
      },
    });
    expect(result!.replacements.recentAt).toEqual([NOW - 2 * DAY, NOW]);
    expect(result!.replacements.total).toBe(8);
  });

  it("bounds the retained window so a hot-looping gateway cannot grow the document", () => {
    const result = transition({
      previous: {
        recentAt: Array.from({ length: 200 }, (_, index) => NOW - 200 * 1000 + index),
        lastAt: NOW - 1000,
        lastVacatedPodUid: "uid-old",
        lastVacatedNodeName: null,
        lastVacatedInstanceId: null,
        lastVacatedNodePool: null,
        total: 200,
      },
    });
    expect(result!.replacements.recentAt.length).toBe(64);
    expect(result!.replacements.recentAt.at(-1)).toBe(NOW);
    expect(result!.replacements.total).toBe(201);
  });

  it("treats identity order as insignificant", () => {
    const result = transition({
      previousPlacements: [placement("uid-b"), placement("uid-a")],
      observedPlacements: [placement("uid-a"), placement("uid-b")],
    });
    expect(result!.vacated).toEqual([]);
  });
});
