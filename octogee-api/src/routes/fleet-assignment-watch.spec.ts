import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import type { Request, Response } from "express";
import type { Firestore } from "firebase-admin/firestore";
import { streamAssignmentChanges } from "./fleet-assignment-watch.js";

function setup() {
  const subscriptions: Array<{ next: () => void; error: (error: Error) => void; stop: ReturnType<typeof vi.fn> }> = [];
  const onSnapshot = (next: () => void, error: (error: Error) => void) => {
    const stop = vi.fn(); subscriptions.push({ next, error, stop }); return stop;
  };
  const assignments = { onSnapshot };
  const where = vi.fn(() => ({ onSnapshot }));
  const doc = vi.fn((_gatewayId: string) => ({ onSnapshot, collection: vi.fn(() => assignments) }));
  const collection = vi.fn((name: string) => name === "users" ? { where } : { doc });
  const req = new EventEmitter();
  const res = Object.assign(new EventEmitter(), {
    status: vi.fn().mockReturnThis(), set: vi.fn().mockReturnThis(),
    flushHeaders: vi.fn(), write: vi.fn(), end: vi.fn(), writableNeedDrain: false,
  });
  const log = vi.fn();
  streamAssignmentChanges(req as Request, res as unknown as Response, { collection } as unknown as Firestore, "shared-a", log);
  return { req, res, subscriptions, doc, where, log };
}

describe("assignment change stream", () => {
  it("watches only the bound gateway and emits invalidations without customer data", () => {
    const h = setup();
    try {
      expect(h.doc).toHaveBeenCalledWith("shared-a");
      expect(h.where).toHaveBeenCalledWith("provisioning.openclaw.gatewayId", "==", "shared-a");
      h.subscriptions.forEach((subscription) => subscription.next());
      expect(h.res.write.mock.calls).toEqual([["data: changed\n\n"], ["data: changed\n\n"], ["data: changed\n\n"]]);
    } finally { h.res.emit("close"); }
    h.subscriptions.forEach((subscription) => expect(subscription.stop).toHaveBeenCalledOnce());
  });

  it("wakes the pod when its own gateway root changes", () => {
    const h = setup();
    try {
      expect(h.subscriptions).toHaveLength(3);
      h.subscriptions[2].next();
      expect(h.res.write.mock.calls).toEqual([["data: changed\n\n"]]);
      expect(h.doc.mock.calls.every(([gatewayId]) => gatewayId === "shared-a")).toBe(true);
    } finally { h.res.emit("close"); }
  });

  it("closes both listeners and logs a failed Firestore watch", () => {
    const h = setup();
    h.subscriptions[0].error(new Error("listener unavailable"));
    expect(h.log).toHaveBeenCalledWith(expect.stringContaining("listener unavailable"));
    expect(h.res.end).toHaveBeenCalledOnce();
    h.subscriptions.forEach((subscription) => expect(subscription.stop).toHaveBeenCalledOnce());
    h.res.emit("close");
    h.subscriptions.forEach((subscription) => expect(subscription.stop).toHaveBeenCalledOnce());
  });

  it("delivers a coalesced notification when a slow connection drains", () => {
    const h = setup();
    try {
      h.res.writableNeedDrain = true;
      h.subscriptions.forEach((subscription) => subscription.next());
      expect(h.res.write).not.toHaveBeenCalled();
      h.res.writableNeedDrain = false;
      h.res.emit("drain");
      h.res.emit("drain");
      expect(h.res.write.mock.calls).toEqual([["data: changed\n\n"]]);
    } finally { h.res.emit("close"); }
  });
});
