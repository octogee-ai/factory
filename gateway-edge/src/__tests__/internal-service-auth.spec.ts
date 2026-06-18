import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NextFunction, Request, Response } from "express";

const { warn, error, info } = vi.hoisted(() => ({
  warn: vi.fn(),
  error: vi.fn(),
  info: vi.fn(),
}));

vi.mock("../lib/db", () => ({ auth: {}, db: {} }));
vi.mock("../middleware/logging", () => ({ logger: { warn, error, info } }));

import {
  requireInternalServiceAuth,
  requireSocialNotificationAuth,
} from "../middleware/auth.js";

type Middleware = (req: Request, res: Response, next: NextFunction) => void;

function run(
  mw: Middleware,
  req: Partial<Request>,
): Promise<{ status?: number; nextCalled: boolean; body?: unknown }> {
  return new Promise((resolve) => {
    let status: number | undefined;
    const res = {
      status: (c: number) => {
        status = c;
        return res;
      },
      json: (b: unknown) => resolve({ status, nextCalled: false, body: b }),
    } as unknown as Response;
    mw(req as Request, res, () => resolve({ status, nextCalled: true }));
  });
}

describe("requireInternalServiceAuth", () => {
  beforeEach(() => {
    warn.mockReset();
    error.mockReset();
    info.mockReset();
    process.env.INTERNAL_SERVICE_KEY = "platform-key";
  });
  afterEach(() => {
    delete process.env.INTERNAL_SERVICE_KEY;
  });

  it("passes a gateway-bound caller without the legacy key", async () => {
    const r = await run(requireInternalServiceAuth, {
      headers: {},
      boundTenant: { kind: "gateway", gatewayId: "bender" },
    } as unknown as Request);

    expect(r.nextCalled).toBe(true);
    expect(warn).not.toHaveBeenCalled();
  });

  it("passes a platform-bound cron caller without the legacy key", async () => {
    const r = await run(requireInternalServiceAuth, {
      headers: {},
      boundTenant: { kind: "platform", actor: "cron" },
    } as unknown as Request);

    expect(r.nextCalled).toBe(true);
    expect(warn).not.toHaveBeenCalled();
  });

  it("falls back to the legacy key and warns so the cutover is observable", async () => {
    const r = await run(requireInternalServiceAuth, {
      headers: { "x-internal-service-key": "platform-key" },
      path: "/internal/billing/check-trial-expiry",
    } as unknown as Request);

    expect(r.nextCalled).toBe(true);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("legacy INTERNAL_SERVICE_KEY"),
      expect.objectContaining({ route: "/internal/billing/check-trial-expiry" }),
    );
  });

  it("rejects when neither a bound tenant nor a valid key is present", async () => {
    const r = await run(requireInternalServiceAuth, {
      headers: {},
      path: "/internal/billing",
    } as unknown as Request);

    expect(r.nextCalled).toBe(false);
    expect(r.status).toBe(401);
    expect(warn).not.toHaveBeenCalledWith(
      expect.stringContaining("legacy INTERNAL_SERVICE_KEY"),
      expect.anything(),
    );
  });
});

describe("requireSocialNotificationAuth", () => {
  beforeEach(() => {
    warn.mockReset();
    error.mockReset();
    info.mockReset();
    process.env.INTERNAL_SERVICE_KEY = "platform-key";
    process.env.SOCIAL_NOTIFICATION_BEARER_TOKEN = "social-bearer";
  });
  afterEach(() => {
    delete process.env.INTERNAL_SERVICE_KEY;
    delete process.env.SOCIAL_NOTIFICATION_BEARER_TOKEN;
  });

  it("accepts the dedicated bearer without the legacy key", async () => {
    const r = await run(requireSocialNotificationAuth, {
      headers: { authorization: "Bearer social-bearer" },
      path: "/api/notifications/social",
    } as unknown as Request);

    expect(r.nextCalled).toBe(true);
    expect(warn).not.toHaveBeenCalled();
  });

  it("falls back to the legacy key when the bearer is absent", async () => {
    const r = await run(requireSocialNotificationAuth, {
      headers: { "x-internal-service-key": "platform-key" },
      path: "/api/notifications/social",
    } as unknown as Request);

    expect(r.nextCalled).toBe(true);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("legacy INTERNAL_SERVICE_KEY"),
      expect.objectContaining({ route: "/api/notifications/social" }),
    );
  });

  it("rejects a wrong bearer with no key fallback available", async () => {
    const r = await run(requireSocialNotificationAuth, {
      headers: { authorization: "Bearer wrong" },
      path: "/api/notifications/social",
    } as unknown as Request);

    expect(r.nextCalled).toBe(false);
    expect(r.status).toBe(401);
  });

  it("warns distinctly when a bearer is provided but rejected (vs not-yet-cutover)", async () => {
    await run(requireSocialNotificationAuth, {
      headers: { authorization: "Bearer wrong", "x-internal-service-key": "platform-key" },
      path: "/api/notifications/social",
    } as unknown as Request);

    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("bearer rejected"),
      expect.objectContaining({ route: "/api/notifications/social" }),
    );
  });

  it("does not warn about a rejected bearer when none was provided (clean key fallback)", async () => {
    await run(requireSocialNotificationAuth, {
      headers: { "x-internal-service-key": "platform-key" },
      path: "/api/notifications/social",
    } as unknown as Request);

    expect(warn).not.toHaveBeenCalledWith(
      expect.stringContaining("bearer rejected"),
      expect.anything(),
    );
  });
});
