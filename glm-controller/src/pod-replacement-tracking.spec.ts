import { describe, expect, it } from "vitest";

import {
  gatewayPlanToken,
  nextPodReplacementTransition,
  observedPodUids,
} from "./pod-replacement-tracking.js";

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const NOW = 1_770_000_000_000;

const RUNNING = gatewayPlanToken({
  desiredRelease: 4,
  liveRelease: 4,
  desiredStatus: "running",
});

function transition(overrides: {
  previousPodUids?: readonly string[] | null;
  previousPlanToken?: string | null;
  previous?: Parameters<typeof nextPodReplacementTransition>[0]["previous"];
  observedPodUids?: readonly string[] | null;
  planToken?: string;
  now?: number;
}) {
  return nextPodReplacementTransition({
    previousPodUids: overrides.previousPodUids === undefined
      ? ["uid-a"]
      : overrides.previousPodUids,
    previousPlanToken: overrides.previousPlanToken === undefined
      ? RUNNING
      : overrides.previousPlanToken,
    previous: overrides.previous ?? null,
    observedPodUids: overrides.observedPodUids === undefined
      ? ["uid-b"]
      : overrides.observedPodUids,
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

describe("observedPodUids", () => {
  it("returns null when diagnostics are unreadable so nothing is attributed", () => {
    expect(observedPodUids({ status: "unknown", totalPods: 0, readyPods: 0 })).toBeNull();
    expect(observedPodUids(undefined)).toBeNull();
    expect(observedPodUids({
      status: "ready", totalPods: 1, readyPods: 1, error: "kubectl exploded",
    })).toBeNull();
  });

  it("returns an empty set for a legitimately observed missing pod", () => {
    expect(observedPodUids({ status: "missing", totalPods: 0, readyPods: 0, pods: [] }))
      .toEqual([]);
  });

  it("sorts and de-duplicates identities so set comparison is order-independent", () => {
    expect(observedPodUids({
      status: "ready",
      totalPods: 3,
      readyPods: 3,
      pods: [{ uid: "uid-c" }, { uid: "uid-a" }, { uid: "uid-c" }],
    })).toEqual(["uid-a", "uid-c"]);
  });

  it("refuses to guess when a pod carries no uid", () => {
    expect(observedPodUids({
      status: "ready", totalPods: 1, readyPods: 1, pods: [{ uid: null }],
    })).toBeNull();
  });
});

describe("nextPodReplacementTransition", () => {
  it("counts pod churn when the desired state did not move", () => {
    const result = transition({});
    expect(result).not.toBeNull();
    expect(result!.replacedCount).toBe(1);
    expect(result!.replacements.total).toBe(1);
    expect(result!.replacements.recentAt).toEqual([NOW]);
    expect(result!.replacements.lastAt).toBe(NOW);
    expect(result!.replacements.lastPodUid).toBe("uid-b");
    expect(result!.podUids).toEqual(["uid-b"]);
  });

  it("does not count pod churn across a release change", () => {
    const result = transition({
      planToken: gatewayPlanToken({
        desiredRelease: 5,
        liveRelease: 4,
        desiredStatus: "running",
      }),
    });
    expect(result!.replacedCount).toBe(0);
    expect(result!.replacements.total).toBe(0);
    expect(result!.replacements.recentAt).toEqual([]);
    expect(result!.replacements.lastPodUid).toBeNull();
    expect(result!.podUids).toEqual(["uid-b"]);
  });

  it("does not count pod churn across a desired-status change", () => {
    const result = transition({
      planToken: gatewayPlanToken({
        desiredRelease: 4,
        liveRelease: 4,
        desiredStatus: "paused",
      }),
    });
    expect(result!.replacedCount).toBe(0);
  });

  it("does not count the first observation of a gateway", () => {
    const result = transition({ previousPodUids: null, previousPlanToken: null });
    expect(result!.replacedCount).toBe(0);
    expect(result!.podUids).toEqual(["uid-b"]);
  });

  it("does not count an unchanged pod identity set", () => {
    const result = transition({ previousPodUids: ["uid-a"], observedPodUids: ["uid-a"] });
    expect(result!.replacedCount).toBe(0);
  });

  it("does not count a pod that only disappeared", () => {
    const result = transition({ previousPodUids: ["uid-a"], observedPodUids: [] });
    expect(result!.replacedCount).toBe(0);
    expect(result!.podUids).toEqual([]);
  });

  it("counts the replacement once when the pod reappears after a gap", () => {
    const gone = transition({ previousPodUids: ["uid-a"], observedPodUids: [] });
    const back = transition({
      previousPodUids: gone!.podUids,
      previous: gone!.replacements,
      observedPodUids: ["uid-b"],
      now: NOW + HOUR,
    });
    expect(back!.replacedCount).toBe(1);
    expect(back!.replacements.total).toBe(1);
  });

  it("counts each newly observed identity when several pods are replaced at once", () => {
    const result = transition({
      previousPodUids: ["uid-a", "uid-b"],
      observedPodUids: ["uid-c", "uid-d"],
    });
    expect(result!.replacedCount).toBe(2);
    expect(result!.replacements.recentAt).toEqual([NOW, NOW]);
  });

  it("skips accounting entirely when diagnostics are unreadable", () => {
    expect(transition({ observedPodUids: null })).toBeNull();
  });

  it("counts the replacement after diagnostics recover from an unreadable window", () => {
    expect(transition({ observedPodUids: null })).toBeNull();
    const recovered = transition({ previousPodUids: ["uid-a"], observedPodUids: ["uid-b"] });
    expect(recovered!.replacedCount).toBe(1);
  });

  it("carries prior history forward and appends the new replacement", () => {
    const result = transition({
      previous: {
        recentAt: [NOW - 2 * HOUR],
        lastAt: NOW - 2 * HOUR,
        lastPodUid: "uid-a",
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
        lastPodUid: "uid-a",
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
        lastPodUid: "uid-a",
        total: 200,
      },
    });
    expect(result!.replacements.recentAt.length).toBe(64);
    expect(result!.replacements.recentAt.at(-1)).toBe(NOW);
    expect(result!.replacements.total).toBe(201);
  });

  it("treats identity order as insignificant", () => {
    const result = transition({
      previousPodUids: ["uid-b", "uid-a"],
      observedPodUids: ["uid-a", "uid-b"],
    });
    expect(result!.replacedCount).toBe(0);
  });
});
