import { execFile as execFileCb } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

export const DEFAULT_GITHUB_CLI_AUTH_CONTROL_URL = "http://127.0.0.1:3001";
export const DEFAULT_GITHUB_CLI_AUTH_TOKEN_PATH = "/var/run/secrets/octogee-gateway-broker/token";
export const DEFAULT_GITHUB_CLI_AUTH_RETRY_TIMEOUT_MS = 120_000;
export const DEFAULT_GITHUB_CLI_AUTH_RETRY_INTERVAL_MS = 2_000;

const execFile = promisify(execFileCb);
const GITHUB_HOST = "github.com";

type HydrateResult =
  | { status: "hydrated"; connectorId: "github" }
  | { status: "cleared"; reason: string }
  | { status: "skipped"; reason: string };

interface FetchResponse {
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
}

interface GithubCliAuthHydrateDeps {
  env?: Record<string, string | undefined>;
  now?: () => number;
  wait?: (ms: number) => Promise<void>;
  readFile?: (path: string) => Promise<string>;
  writeFile?: (path: string, data: string, opts?: { mode?: number }) => Promise<void>;
  chmod?: (path: string, mode: number) => Promise<void>;
  mkdir?: (path: string, opts?: { recursive?: boolean }) => Promise<unknown>;
  execFile?: (file: string, args: string[], opts?: { env?: Record<string, string | undefined> }) => Promise<unknown>;
  fetch?: (url: string, init?: { method?: string; headers?: Record<string, string> }) => Promise<FetchResponse>;
  log?: (msg: string) => void;
}

interface MaterializeFetchResult {
  resp: FetchResponse;
  body: unknown;
}

interface HydrateContext {
  env: Record<string, string | undefined>;
  log: (msg: string) => void;
  readFile: (path: string) => Promise<string>;
  writeFile: (path: string, data: string, opts?: { mode?: number }) => Promise<void>;
  chmod: (path: string, mode: number) => Promise<void>;
  mkdir: (path: string, opts?: { recursive?: boolean }) => Promise<unknown>;
  run: (
    file: string,
    args: string[],
    opts?: { env?: Record<string, string | undefined> },
  ) => Promise<unknown>;
  fetch: NonNullable<GithubCliAuthHydrateDeps["fetch"]>;
  now: () => number;
  wait: (ms: number) => Promise<void>;
}

function nonBlank(value: string | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function isRuntimeGateway(env: Record<string, string | undefined>): boolean {
  const gatewayClass = nonBlank(env.GATEWAY_CLASS);
  if (gatewayClass) return gatewayClass === "builder" || gatewayClass === "operator";
  return nonBlank(env.GATEWAY_PROFILE) === "operator";
}

function ghConfigDir(env: Record<string, string | undefined>): string {
  const explicit = nonBlank(env.GH_CONFIG_DIR);
  if (explicit) return explicit;
  const xdg = nonBlank(env.XDG_CONFIG_HOME);
  if (xdg) return path.join(xdg, "gh");
  return path.join(nonBlank(env.HOME) ?? "/home/node", ".config", "gh");
}

function hostsPath(configDir: string): string {
  return path.join(configDir, "hosts.yml");
}

function trimBaseUrl(value: string): string {
  let out = value.trim();
  while (out.endsWith("/")) out = out.slice(0, -1);
  return out;
}

function parseDurationMs(value: string | undefined, fallback: number): number {
  const trimmed = nonBlank(value);
  if (!trimmed) return fallback;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

async function readOptionalFile(
  readFile: (path: string) => Promise<string>,
  filePath: string,
): Promise<string> {
  try {
    return await readFile(filePath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return "";
    throw err;
  }
}

function hostBlock(accessToken: string): string {
  return `${GITHUB_HOST}:\n    git_protocol: https\n    oauth_token: ${accessToken}\n`;
}

function hostBlocks(input: string): Array<{ host: string; text: string }> {
  const blocks: Array<{ host: string; text: string }> = [];
  const lines = input.split("\n");
  let currentHost: string | null = null;
  let currentLines: string[] = [];

  function flush(): void {
    if (!currentHost) return;
    blocks.push({ host: currentHost, text: `${currentLines.join("\n")}\n` });
  }

  for (const line of lines) {
    if (!line) continue;
    const match = /^([A-Za-z0-9_.-]+):\s*$/.exec(line);
    if (match) {
      flush();
      currentHost = match[1];
      currentLines = [line];
    } else if (currentHost) {
      currentLines.push(line);
    }
  }
  flush();
  return blocks;
}

export function removeGithubHost(input: string): string {
  return hostBlocks(input)
    .filter((block) => block.host !== GITHUB_HOST)
    .map((block) => block.text)
    .join("");
}

export function upsertGithubHost(input: string, accessToken: string): string {
  return `${removeGithubHost(input)}${hostBlock(accessToken)}`;
}

async function clearGithubHost(
  deps: Required<Pick<GithubCliAuthHydrateDeps, "readFile" | "writeFile" | "chmod" | "mkdir">>,
  configDir: string,
): Promise<void> {
  const filePath = hostsPath(configDir);
  const existing = await readOptionalFile(deps.readFile, filePath);
  const next = removeGithubHost(existing);
  if (next === existing) return;
  await deps.mkdir(configDir, { recursive: true });
  await deps.writeFile(filePath, next, { mode: 0o600 });
  await deps.chmod(filePath, 0o600);
}

function disconnectedReason(body: unknown): string | null {
  const data = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
  if (data.status !== "disconnected") return null;
  return typeof data.reason === "string" ? data.reason : "not_connected";
}

function materializeFailureMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function resolveHydrateContext(deps: GithubCliAuthHydrateDeps): HydrateContext {
  const env = deps.env ?? process.env;
  const doFetch = deps.fetch ?? (globalThis.fetch as unknown as GithubCliAuthHydrateDeps["fetch"]);
  if (!doFetch) throw new Error("global fetch is unavailable");
  return {
    env,
    log: deps.log ?? ((msg: string) => console.log(`[github-cli-auth] ${msg}`)),
    readFile: deps.readFile ?? ((filePath) => fs.readFile(filePath, "utf8")),
    writeFile:
      deps.writeFile ?? ((filePath, data, opts) => fs.writeFile(filePath, data, opts)),
    chmod: deps.chmod ?? ((filePath, mode) => fs.chmod(filePath, mode)),
    mkdir: deps.mkdir ?? ((dir, opts) => fs.mkdir(dir, opts)),
    run: deps.execFile ?? ((file, args, opts) => execFile(file, args, opts)),
    fetch: doFetch,
    now: deps.now ?? (() => Date.now()),
    wait: deps.wait ?? ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms))),
  };
}

async function fetchMaterializedGithubAuth(
  doFetch: NonNullable<GithubCliAuthHydrateDeps["fetch"]>,
  url: string,
  gatewayToken: string,
  opts: {
    now: () => number;
    wait: (ms: number) => Promise<void>;
    retryTimeoutMs: number;
    retryIntervalMs: number;
    log: (msg: string) => void;
  },
): Promise<MaterializeFetchResult> {
  const deadline = opts.now() + opts.retryTimeoutMs;
  let attempts = 0;
  let lastFailure = "unknown failure";

  while (true) {
    attempts += 1;
    try {
      const resp = await doFetch(url, {
        method: "GET",
        headers: { "X-K8s-Sa-Token": gatewayToken },
      });
      const body = await resp.json().catch(() => undefined);
      if (resp.ok || resp.status < 500) return { resp, body };
      lastFailure = `HTTP ${resp.status}`;
    } catch (err) {
      lastFailure = materializeFailureMessage(err);
    }

    const remainingMs = deadline - opts.now();
    if (remainingMs <= 0) {
      throw new Error(
        `GitHub connector materialize failed after ${attempts} attempt(s): ${lastFailure}`,
      );
    }
    const delayMs = Math.min(opts.retryIntervalMs, remainingMs);
    opts.log(`materialize unavailable (${lastFailure}); retrying in ${delayMs}ms`);
    await opts.wait(delayMs);
  }
}

function skipped(log: (msg: string) => void, message: string, reason: string): HydrateResult {
  log(`skipped: ${message}`);
  return { status: "skipped", reason };
}

async function readGatewayToken(
  ctx: HydrateContext,
): Promise<{ token: string; tokenPath: string }> {
  const tokenPath = nonBlank(ctx.env.OCTOGEE_API_SA_TOKEN_PATH) ?? DEFAULT_GITHUB_CLI_AUTH_TOKEN_PATH;
  const token = nonBlank(await readOptionalFile(ctx.readFile, tokenPath)) ?? "";
  return { token, tokenPath };
}

async function materializeGithubAuth(
  ctx: HydrateContext,
  gatewayToken: string,
): Promise<MaterializeFetchResult> {
  const controlUrl = trimBaseUrl(
    nonBlank(ctx.env.GITHUB_CLI_AUTH_CONTROL_URL) ?? DEFAULT_GITHUB_CLI_AUTH_CONTROL_URL,
  );
  return fetchMaterializedGithubAuth(
    ctx.fetch,
    `${controlUrl}/internal/connectors/github/materialize`,
    gatewayToken,
    {
      now: ctx.now,
      wait: ctx.wait,
      retryTimeoutMs: parseDurationMs(
        ctx.env.GITHUB_CLI_AUTH_RETRY_TIMEOUT_MS,
        DEFAULT_GITHUB_CLI_AUTH_RETRY_TIMEOUT_MS,
      ),
      retryIntervalMs: parseDurationMs(
        ctx.env.GITHUB_CLI_AUTH_RETRY_INTERVAL_MS,
        DEFAULT_GITHUB_CLI_AUTH_RETRY_INTERVAL_MS,
      ),
      log: ctx.log,
    },
  );
}

function materializeClearReason(resp: FetchResponse, body: unknown): string | null {
  const reason = disconnectedReason(body);
  if (reason) return reason;
  if (resp.status === 403) return "forbidden";
  return null;
}

async function clearGithubAuth(
  ctx: HydrateContext,
  configDir: string,
  reason: string,
): Promise<HydrateResult> {
  await clearGithubHost(ctx, configDir);
  ctx.log(`cleared GitHub CLI auth: ${reason}`);
  return { status: "cleared", reason };
}

function assertMaterializeOk(resp: FetchResponse): void {
  if (!resp.ok) throw new Error(`GitHub connector materialize failed: HTTP ${resp.status}`);
}

function githubAccessToken(body: unknown): string {
  const data = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
  const accessToken = typeof data.accessToken === "string" ? data.accessToken : "";
  if (!accessToken) throw new Error("GitHub connector materialize returned no accessToken");
  return accessToken;
}

async function hydrateNativeGithubAuth(
  ctx: HydrateContext,
  configDir: string,
  accessToken: string,
): Promise<void> {
  const filePath = hostsPath(configDir);
  const existing = await readOptionalFile(ctx.readFile, filePath);
  await ctx.mkdir(configDir, { recursive: true });
  await ctx.writeFile(filePath, upsertGithubHost(existing, accessToken), { mode: 0o600 });
  await ctx.chmod(filePath, 0o600);
  await ctx.run("gh", ["auth", "setup-git", "--hostname", GITHUB_HOST], {
    env: { ...ctx.env, GH_CONFIG_DIR: configDir, GH_PROMPT_DISABLED: "1" },
  });
}

export async function hydrateGithubCliAuth(
  deps: GithubCliAuthHydrateDeps = {},
): Promise<HydrateResult> {
  const ctx = resolveHydrateContext(deps);
  if (!isRuntimeGateway(ctx.env)) return skipped(ctx.log, "shared gateway", "shared_gateway");

  const { token, tokenPath } = await readGatewayToken(ctx);
  if (!token) {
    return skipped(
      ctx.log,
      `projected service-account token unavailable at ${tokenPath}`,
      "gateway_token_unavailable",
    );
  }

  const configDir = ghConfigDir(ctx.env);
  const { resp, body } = await materializeGithubAuth(ctx, token);
  const clearReason = materializeClearReason(resp, body);
  if (clearReason) return clearGithubAuth(ctx, configDir, clearReason);

  assertMaterializeOk(resp);
  await hydrateNativeGithubAuth(ctx, configDir, githubAccessToken(body));
  ctx.log("hydrated GitHub CLI auth and configured git credential helper");
  return { status: "hydrated", connectorId: "github" };
}
