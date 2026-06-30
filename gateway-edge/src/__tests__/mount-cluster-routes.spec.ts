import type { Express, RequestHandler } from "express";
import { Router } from "express";
import { describe, expect, it, vi } from "vitest";

import { mountClusterRoutes } from "../routes/mount-cluster-routes.js";

type MountCall = {
  method: "all" | "use";
  path: string;
  handlers: unknown[];
};

function recordingApp(): Express & { calls: MountCall[] } {
  const calls: MountCall[] = [];
  return {
    calls,
    all: vi.fn((path: string, ...handlers: unknown[]) => {
      calls.push({ method: "all", path, handlers });
    }),
    use: vi.fn((path: string, ...handlers: unknown[]) => {
      calls.push({ method: "use", path, handlers });
    }),
  } as unknown as Express & { calls: MountCall[] };
}

function useCalls(app: { calls: MountCall[] }, path: string): MountCall[] {
  return app.calls.filter((c) => c.method === "use" && c.path === path);
}

describe("mountClusterRoutes", () => {
  it("mounts the Mattermost REST proxy before all cluster routes when provided", () => {
    const app = recordingApp();
    const mmRestProxyHandler: RequestHandler = vi.fn();

    mountClusterRoutes(app, { mmRestProxyHandler });

    expect(app.calls[0]).toMatchObject({
      method: "all",
      path: "/api/v4/*splat",
      handlers: [mmRestProxyHandler],
    });
  });

  it("keeps workspace auth in front of every workspace route", () => {
    const app = recordingApp();

    mountClusterRoutes(app);

    const workspace = useCalls(app, "/api/workspace");
    expect(workspace).toHaveLength(10);
    expect((workspace[0].handlers[0] as { name?: string }).name).toBe("requireAuth");
  });

  it("keeps public project read/delete mounted before project auth", () => {
    const app = recordingApp();

    mountClusterRoutes(app);

    const projects = useCalls(app, "/api/projects");
    expect(projects).toHaveLength(8);
    expect((projects[2].handlers[0] as { name?: string }).name).toBe("requireAuth");
  });

  it("mounts the optional Mattermost mint route at the browser credential path", () => {
    const app = recordingApp();
    const mattermostMintRoutes = Router();

    mountClusterRoutes(app, { mattermostMintRoutes });

    expect(useCalls(app, "/api/auth/mattermost")[0].handlers).toEqual([mattermostMintRoutes]);
  });

  it("keeps internal cluster routes as the final mount tail", () => {
    const app = recordingApp();

    mountClusterRoutes(app);

    const tail = app.calls.slice(-5).map((c) => c.path);
    expect(tail).toEqual([
      "/internal/agents",
      "/internal/notifications",
      "/internal/notifications",
      "/internal/workspace",
      "/internal/project",
    ]);
  });

  it("mounts the public API table in the intended order", () => {
    const app = recordingApp();

    mountClusterRoutes(app);

    expect(app.calls.map((c) => c.path)).toEqual([
      "/api/workspace",
      "/api/workspace",
      "/api/workspace",
      "/api/workspace",
      "/api/workspace",
      "/api/workspace",
      "/api/workspace",
      "/api/workspace",
      "/api/workspace",
      "/api/workspace",
      "/api/projects",
      "/api/projects",
      "/api/projects",
      "/api/projects",
      "/api/projects",
      "/api/projects",
      "/api/projects",
      "/api/projects",
      "/api/auth/email",
      "/api/sharing",
      "/api/email/unsubscribe",
      "/api/email",
      "/api/entities",
      "/api/mattermost",
      "/api/openclaw",
      "/api/billing",
      "/api/model-credentials",
      "/api/legal",
      "/api/admin",
      "/api/invites",
      "/api/integrations",
      "/api/connect",
      "/api/discord",
      "/api/notifications",
      "/api/profile",
      "/api/onboarding",
      "/api/posts",
      "/api/agents",
      "/api/builder",
      "/api/shells",
      "/internal/agents",
      "/internal/notifications",
      "/internal/notifications",
      "/internal/workspace",
      "/internal/project",
    ]);
  });
});
