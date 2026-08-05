import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_GITHUB_CLI_AUTH_CONTROL_URL,
  DEFAULT_GITHUB_CLI_AUTH_RETRY_INTERVAL_MS,
  DEFAULT_GITHUB_CLI_AUTH_TOKEN_PATH,
  hydrateGithubCliAuth,
  removeGithubHost,
  upsertGithubHost,
} from "../lib/github-cli-auth-hydrate.js";

type MaterializeResponse = {
  ok: boolean;
  status: number;
  body: unknown;
  headers?: Record<string, string>;
};
type MaterializeStep = MaterializeResponse | Error;

function makeDeps(
  env: Record<string, string | undefined>,
  materialize: MaterializeStep | MaterializeStep[] = {
    ok: true,
    status: 200,
    body: { status: "connected", connectorId: "github", accessToken: "gho_secret" },
  },
) {
  const materializeSteps = Array.isArray(materialize) ? materialize : [materialize];
  let nowMs = 0;
  const files = new Map<string, string>([[DEFAULT_GITHUB_CLI_AUTH_TOKEN_PATH, "gateway-sa-token\n"]]);
  const writes: Array<{ path: string; data: string; mode?: number }> = [];
  const chmods: Array<{ path: string; mode: number }> = [];
  const mkdirs: string[] = [];
  const execs: Array<{ file: string; args: string[]; env: Record<string, string | undefined> }> = [];
  const fetches: Array<{ url: string; headers?: Record<string, string> }> = [];
  const waits: number[] = [];
  const logs: string[] = [];

  return {
    files,
    writes,
    chmods,
    mkdirs,
    execs,
    fetches,
    waits,
    logs,
    deps: {
      env,
      log: (msg: string) => logs.push(msg),
      now: () => nowMs,
      wait: vi.fn(async (ms: number) => {
        waits.push(ms);
        nowMs += ms;
      }),
      readFile: vi.fn(async (path: string) => {
        const value = files.get(path);
        if (value === undefined) {
          const err = new Error(`ENOENT: ${path}`) as NodeJS.ErrnoException;
          err.code = "ENOENT";
          throw err;
        }
        return value;
      }),
      writeFile: vi.fn(async (path: string, data: string, opts?: { mode?: number }) => {
        files.set(path, data);
        writes.push({ path, data, mode: opts?.mode });
      }),
      chmod: vi.fn(async (path: string, mode: number) => chmods.push({ path, mode })),
      mkdir: vi.fn(async (path: string) => mkdirs.push(path)),
      execFile: vi.fn(async (file: string, args: string[], opts?: { env?: Record<string, string | undefined> }) => {
        execs.push({ file, args, env: opts?.env ?? {} });
      }),
      fetch: vi.fn(async (url: string, init?: { headers?: Record<string, string> }) => {
        const step = materializeSteps[Math.min(fetches.length, materializeSteps.length - 1)];
        fetches.push({ url, headers: init?.headers });
        if (step instanceof Error) throw step;
        return {
          ok: step.ok,
          status: step.status,
          json: async () => step.body,
          headers: {
            get: (name: string) => step.headers?.[name.toLowerCase()] ?? null,
          },
        };
      }),
    },
  };
}

describe("GitHub CLI native auth hydration", () => {
  it("writes native gh hosts.yml and configures git on builder gateways", async () => {
    const h = makeDeps({
      GATEWAY_CLASS: "builder",
      GATEWAY_PROFILE: "builder",
      HOME: "/home/node",
    });

    await expect(hydrateGithubCliAuth(h.deps)).resolves.toEqual({
      status: "hydrated",
      connectorId: "github",
    });

    expect(h.fetches).toEqual([
      {
        url: `${DEFAULT_GITHUB_CLI_AUTH_CONTROL_URL}/internal/connectors/github/materialize`,
        headers: { "X-K8s-Sa-Token": "gateway-sa-token" },
      },
    ]);
    expect(h.writes).toEqual([
      {
        path: "/home/node/.config/gh/hosts.yml",
        data: "github.com:\n    git_protocol: https\n    oauth_token: gho_secret\n",
        mode: 0o600,
      },
    ]);
    expect(h.chmods).toEqual([{ path: "/home/node/.config/gh/hosts.yml", mode: 0o600 }]);
    expect(h.execs).toEqual([
      {
        file: "gh",
        args: ["auth", "setup-git", "--hostname", "github.com"],
        env: expect.objectContaining({
          GH_CONFIG_DIR: "/home/node/.config/gh",
          GH_PROMPT_DISABLED: "1",
        }) as Record<string, string | undefined>,
      },
    ]);
  });

  it("skips the retired operator gateway class", async () => {
    const h = makeDeps({
      GATEWAY_CLASS: "operator",
      GATEWAY_PROFILE: "operator",
      HOME: "/home/node",
    });

    await expect(hydrateGithubCliAuth(h.deps)).resolves.toEqual({
      status: "skipped",
      reason: "shared_gateway",
    });

    expect(h.fetches).toHaveLength(0);
    expect(h.writes).toHaveLength(0);
    expect(h.execs).toHaveLength(0);
  });

  it("skips shared gateways without reading or writing credentials", async () => {
    const h = makeDeps({ GATEWAY_CLASS: "shared", HOME: "/home/node" });

    await expect(hydrateGithubCliAuth(h.deps)).resolves.toEqual({
      status: "skipped",
      reason: "shared_gateway",
    });

    expect(h.fetches).toHaveLength(0);
    expect(h.writes).toHaveLength(0);
    expect(h.execs).toHaveLength(0);
  });

  it("clears stale github.com auth when the connector is disconnected", async () => {
    const h = makeDeps(
      { GATEWAY_CLASS: "builder", GATEWAY_PROFILE: "builder", HOME: "/home/node" },
      {
        ok: false,
        status: 404,
        body: { status: "disconnected", connectorId: "github", reason: "not_connected" },
      },
    );
    h.files.set(
      "/home/node/.config/gh/hosts.yml",
      "github.com:\n    oauth_token: stale\nenterprise.internal:\n    oauth_token: keep\n",
    );

    await expect(hydrateGithubCliAuth(h.deps)).resolves.toEqual({
      status: "cleared",
      reason: "not_connected",
    });

    expect(h.files.get("/home/node/.config/gh/hosts.yml")).toBe(
      "enterprise.internal:\n    oauth_token: keep\n",
    );
    expect(h.chmods).toEqual([{ path: "/home/node/.config/gh/hosts.yml", mode: 0o600 }]);
    expect(h.execs).toHaveLength(0);
  });

  it("retries materialize until the gateway-edge sidecar is ready", async () => {
    const h = makeDeps(
      { GATEWAY_CLASS: "builder", GATEWAY_PROFILE: "builder", HOME: "/home/node" },
      [
        new Error("connect ECONNREFUSED 127.0.0.1:3001"),
        { ok: false, status: 503, body: { status: "starting" } },
        {
          ok: true,
          status: 200,
          body: { status: "connected", connectorId: "github", accessToken: "gho_late" },
        },
      ],
    );

    await expect(hydrateGithubCliAuth(h.deps)).resolves.toEqual({
      status: "hydrated",
      connectorId: "github",
    });

    expect(h.fetches).toHaveLength(3);
    expect(h.waits).toEqual([
      DEFAULT_GITHUB_CLI_AUTH_RETRY_INTERVAL_MS,
      DEFAULT_GITHUB_CLI_AUTH_RETRY_INTERVAL_MS,
    ]);
    expect(h.writes[0].data).toContain("oauth_token: gho_late");
  });

  it("honors numeric Retry-After hints from a transient materialize response", async () => {
    const h = makeDeps(
      { GATEWAY_CLASS: "builder", GATEWAY_PROFILE: "builder", HOME: "/home/node" },
      [
        {
          ok: false,
          status: 503,
          body: { status: "starting" },
          headers: { "retry-after": "12" },
        },
        {
          ok: true,
          status: 200,
          body: { status: "connected", connectorId: "github", accessToken: "gho_late" },
        },
      ],
    );

    await expect(hydrateGithubCliAuth(h.deps)).resolves.toMatchObject({ status: "hydrated" });

    expect(h.waits).toEqual([12_000]);
  });

  it("honors Retry-After on rate limiting as well as server failures", async () => {
    const h = makeDeps(
      { GATEWAY_CLASS: "builder", GATEWAY_PROFILE: "builder", HOME: "/home/node" },
      [
        { ok: false, status: 429, body: { status: "busy" }, headers: { "retry-after": "3" } },
        {
          ok: true,
          status: 200,
          body: { status: "connected", connectorId: "github", accessToken: "gho_late" },
        },
      ],
    );

    await expect(hydrateGithubCliAuth(h.deps)).resolves.toMatchObject({ status: "hydrated" });

    expect(h.waits).toEqual([3_000]);
  });

  it("honors HTTP-date Retry-After hints within the materialize deadline", async () => {
    const h = makeDeps(
      {
        GATEWAY_CLASS: "builder",
        GATEWAY_PROFILE: "builder",
        HOME: "/home/node",
        GITHUB_CLI_AUTH_RETRY_TIMEOUT_MS: "5000",
      },
      [
        {
          ok: false,
          status: 503,
          body: { status: "starting" },
          headers: { "retry-after": new Date(20_000).toUTCString() },
        },
        {
          ok: true,
          status: 200,
          body: { status: "connected", connectorId: "github", accessToken: "gho_late" },
        },
      ],
    );

    await expect(hydrateGithubCliAuth(h.deps)).resolves.toMatchObject({ status: "hydrated" });

    expect(h.waits).toEqual([5_000]);
  });

  it("falls back to the local retry interval for an invalid Retry-After hint", async () => {
    const h = makeDeps(
      { GATEWAY_CLASS: "builder", GATEWAY_PROFILE: "builder", HOME: "/home/node" },
      [
        {
          ok: false,
          status: 503,
          body: { status: "starting" },
          headers: { "retry-after": "tomorrow" },
        },
        {
          ok: true,
          status: 200,
          body: { status: "connected", connectorId: "github", accessToken: "gho_late" },
        },
      ],
    );

    await expect(hydrateGithubCliAuth(h.deps)).resolves.toMatchObject({ status: "hydrated" });

    expect(h.waits).toEqual([DEFAULT_GITHUB_CLI_AUTH_RETRY_INTERVAL_MS]);
  });

  it("clears stale github.com auth when materialize is forbidden for the gateway", async () => {
    const h = makeDeps(
      { GATEWAY_CLASS: "builder", GATEWAY_PROFILE: "builder", HOME: "/home/node" },
      { ok: false, status: 403, body: { error: "forbidden" } },
    );
    h.files.set(
      "/home/node/.config/gh/hosts.yml",
      "github.com:\n    oauth_token: stale\nenterprise.internal:\n    oauth_token: keep\n",
    );

    await expect(hydrateGithubCliAuth(h.deps)).resolves.toEqual({
      status: "cleared",
      reason: "forbidden",
    });

    expect(h.files.get("/home/node/.config/gh/hosts.yml")).toBe(
      "enterprise.internal:\n    oauth_token: keep\n",
    );
    expect(h.chmods).toEqual([{ path: "/home/node/.config/gh/hosts.yml", mode: 0o600 }]);
    expect(h.execs).toHaveLength(0);
  });
});

describe("GitHub CLI hosts.yml transforms", () => {
  it("replaces the github.com block while preserving other hosts", () => {
    expect(
      upsertGithubHost(
        "github.com:\n    oauth_token: old\nenterprise.internal:\n    oauth_token: keep\n",
        "gho_new",
      ),
    ).toBe(
      "enterprise.internal:\n    oauth_token: keep\ngithub.com:\n    git_protocol: https\n    oauth_token: gho_new\n",
    );
  });

  it("removes only the github.com block", () => {
    expect(
      removeGithubHost(
        "github.com:\n    oauth_token: old\nenterprise.internal:\n    oauth_token: keep\n",
      ),
    ).toBe("enterprise.internal:\n    oauth_token: keep\n");
  });
});
