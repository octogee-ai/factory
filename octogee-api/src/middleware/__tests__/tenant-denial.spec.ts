import type { Firestore } from "firebase-admin/firestore";
import { describe, expect, it, vi } from "vitest";
import type { NotificationEvent } from "../../../../gateway-edge/src/notifications/types.js";
import {
  TENANT_DENIAL_NOTIFICATION_BUCKET_MS,
  createTenantDenialReporter,
  type TenantDenial,
} from "../tenant-denial.js";

const NOW = 1_800_000_000_000;

function fakeDb(users: Record<string, Record<string, unknown>>): Pick<Firestore, "collection"> {
  const valueAt = (data: Record<string, unknown>, path: string): unknown =>
    path.split(".").reduce<unknown>((cursor, part) =>
      cursor && typeof cursor === "object" ? (cursor as Record<string, unknown>)[part] : undefined, data);
  return {
    collection: (name: string) => {
      if (name !== "users") throw new Error(`unexpected collection ${name}`);
      return {
        where: (field: string, _op: string, value: unknown) => ({
          get: async () => ({
            docs: Object.entries(users)
              .filter(([, data]) => valueAt(data, field) === value)
              .map(([id, data]) => ({ id, data: () => data })),
          }),
        }),
      };
    },
  } as unknown as Pick<Firestore, "collection">;
}

function harness(opts: {
  users?: Record<string, Record<string, unknown>>;
  fanOut?: (event: NotificationEvent, targetUserIds: string[]) => Promise<{ eventId: string; delivered: string[]; deduplicated: string[]; failed: Array<{ uid: string; error: string }> }>;
} = {}) {
  const logger = { warn: vi.fn(), error: vi.fn() };
  const fanOut = vi.fn(opts.fanOut ?? (async (event: NotificationEvent, targetUserIds: string[]) =>
    ({ eventId: event.eventId, delivered: targetUserIds, deduplicated: [], failed: [] })));
  const report = createTenantDenialReporter({
    db: fakeDb(opts.users ?? {
      "uid-alice": {
        provisioning: { openclaw: { gatewayId: "shared-0", agentIds: ["octogee-alice-coach", "octogee-alice-proj-orbit-coach"] } },
      },
      "uid-bob": {
        provisioning: { openclaw: { gatewayId: "shared-0", agentIds: ["octogee-bob-coach"] } },
      },
    }),
    logger,
    fanOut,
    now: () => NOW,
  });
  return { report, logger, fanOut };
}

const DELEGATE_DENIAL: TenantDenial = {
  method: "POST",
  path: "/internal/agent-projects/delegate",
  reason: "route is not admitted for gateway tenants and the request names no owned user, slug, gateway, or flow",
  tenant: { kind: "gateway", gatewayId: "shared-0" },
  agentId: "octogee-alice-coach",
};

describe("tenant denial reporter", () => {
  it("logs every denial with its fields", async () => {
    const { report, logger } = harness();
    await report(DELEGATE_DENIAL);
    expect(logger.warn).toHaveBeenCalledWith("[tenant-enforcement] denied", {
      method: "POST",
      path: "/internal/agent-projects/delegate",
      reason: DELEGATE_DENIAL.reason,
      tenant: { kind: "gateway", gatewayId: "shared-0" },
      agentId: "octogee-alice-coach",
    });
    expect(logger.error).not.toHaveBeenCalled();
  });

  it("notifies the Builder whose agent was denied, deduplicated per gateway, route, and hour", async () => {
    const { report, fanOut } = harness();
    await report(DELEGATE_DENIAL);
    const bucket = Math.floor(NOW / TENANT_DENIAL_NOTIFICATION_BUCKET_MS);
    expect(fanOut).toHaveBeenCalledWith(
      {
        eventId: `tenant-denied:shared-0:/internal/agent-projects/delegate:${bucket}`,
        category: "system.security",
        title: "Your agent hit a platform permission error",
        body:
          "Your workspace agent asked the platform for /internal/agent-projects/delegate and was refused: " +
          `${DELEGATE_DENIAL.reason}. Octogee has logged it for follow-up.`,
        action: { type: "navigate", path: "/@me" },
      },
      ["uid-alice"],
    );
  });

  it("names the project for a project agent and resolves that agent's Builder", async () => {
    const { report, fanOut } = harness();
    await report({ ...DELEGATE_DENIAL, path: "/internal/agent-projects/identity", agentId: "octogee-alice-proj-orbit-coach" });
    const [event, targets] = fanOut.mock.calls[0]!;
    expect(targets).toEqual(["uid-alice"]);
    expect(event.body).toMatch(/^Your orbit project agent asked the platform for \/internal\/agent-projects\/identity/);
  });

  it("falls back to the bound owner when the agent is not on the gateway roster", async () => {
    const { report, fanOut } = harness();
    await report({ ...DELEGATE_DENIAL, tenant: { kind: "gateway", gatewayId: "shared-0", ownerUid: "uid-owner" }, agentId: "octogee-stranger-coach" });
    expect(fanOut.mock.calls[0]![1]).toEqual(["uid-owner"]);
    expect(fanOut.mock.calls[0]![0].body).toMatch(/^Your workspace agent/);
  });

  it("skips the notification when no Builder can be resolved and says so", async () => {
    const { report, fanOut, logger } = harness();
    await report({ ...DELEGATE_DENIAL, agentId: null });
    expect(fanOut).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(
      "[tenant-enforcement] denial names no assigned Builder; inbox notification skipped",
      expect.objectContaining({ path: "/internal/agent-projects/delegate" }),
    );
  });

  it.each([
    { kind: "platform", actor: "cron" } as const,
    { kind: "unbound" } as const,
  ])("only logs a non-gateway denial ($kind)", async (tenant) => {
    const { report, fanOut, logger } = harness();
    await report({ ...DELEGATE_DENIAL, tenant, agentId: null });
    expect(fanOut).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledOnce();
  });

  it("logs and resolves when the notification pipeline throws", async () => {
    const { report, logger } = harness({ fanOut: async () => { throw new Error("firestore down"); } });
    await expect(report(DELEGATE_DENIAL)).resolves.toBeUndefined();
    expect(logger.error).toHaveBeenCalledWith(
      "[tenant-enforcement] denial notification failed",
      expect.objectContaining({ path: "/internal/agent-projects/delegate", error: expect.any(Error) }),
    );
  });

  it("logs a per-recipient fan-out failure", async () => {
    const { report, logger } = harness({
      fanOut: async (event) => ({ eventId: event.eventId, delivered: [], deduplicated: [], failed: [{ uid: "uid-alice", error: "quota" }] }),
    });
    await report(DELEGATE_DENIAL);
    expect(logger.error).toHaveBeenCalledWith(
      "[tenant-enforcement] denial notification failed",
      expect.objectContaining({ uid: "uid-alice", failed: [{ uid: "uid-alice", error: "quota" }] }),
    );
  });
});
