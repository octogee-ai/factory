import { describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}));

vi.mock("../middleware/logging.js", () => ({ logger: h.logger }));

const { errorHandler } = await import("../middleware/errors.js");

function response() {
  const res = {
    status: vi.fn<(code: number) => typeof res>(() => res),
    json: vi.fn<(body: unknown) => typeof res>(() => res),
  };
  return res;
}

describe("errorHandler", () => {
  it("maps known auth and authorization errors to their HTTP status", () => {
    const res = response();

    errorHandler(
      new Error("Admin access required"),
      { path: "/admin", method: "POST" } as never,
      res as never,
      vi.fn(),
    );

    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith({ error: "Admin access required" });
    expect(h.logger.error).not.toHaveBeenCalled();
  });

  it("logs unexpected errors and returns 500", () => {
    const res = response();
    const err = new Error("database unavailable");

    errorHandler(
      err,
      { path: "/api/probe", method: "GET" } as never,
      res as never,
      vi.fn(),
    );

    expect(h.logger.error).toHaveBeenCalledWith("Unhandled error: database unavailable", {
      path: "/api/probe",
      method: "GET",
      stack: expect.any(String),
    });
    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith({ error: "database unavailable" });
  });
});
