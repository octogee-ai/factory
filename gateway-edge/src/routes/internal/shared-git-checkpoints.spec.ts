import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import express from "express";
import request from "supertest";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createProjectPersistenceRouter } from "./project-persistence.js";
import { _setGatewayTokenReviewerForTests, requireGatewayInternalAuth } from "../../middleware/gateway-internal-auth.js";

vi.mock("../../lib/connector-tokens.js", () => ({ readOwnerRuntimeConnectorAccessToken: vi.fn() }));
vi.mock("../../lib/workspace-blob.js", () => ({ storeWorkspaceBlob: vi.fn(async () => { throw new Error("unexpected binary upload in text checkpoint fixture"); }) }));

vi.mock("node:child_process", async importOriginal => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, spawn: (command: string, args: readonly string[], options: import("node:child_process").SpawnOptions) => actual.spawn(command, args, {
    ...options, env: { ...options.env, GIT_SSH_COMMAND: process.env.TEST_GIT_SSH },
  }) };
});

let root: string;
let customer: string;
let remoteRoot: string;
let snapshot: Record<string, unknown>;
let broker: ReturnType<typeof vi.fn>;
let assignment: { uid: string; state: string; epoch: number };
let reviewed: { authenticated: true; namespace: string; saName: string; audiences: string[] };
const personas = { workspace: "# Coach\nExact coach persona α\n", demo: "# Project\nExact project persona β\n" };
function git(cwd: string, ...args: string[]): string {
  return execFileSync("/usr/bin/git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}
function checkout(name: string): string {
  const dir = name === "workspace" ? customer : path.join(customer, "projects", name);
  const remote = path.join(remoteRoot, `${name}.git`);
  git(root, "init", "--bare", "--initial-branch=main", remote);
  mkdirSync(dir, { recursive: true });
  git(dir, "init", "--initial-branch=main");
  git(dir, "config", "user.name", "Alice"); git(dir, "config", "user.email", "alice@example.test");
  writeFileSync(path.join(dir, ".gitignore"), "projects/\n");
  writeFileSync(path.join(dir, "IDENTITY.md"), "initial\n");
  git(dir, "add", "."); git(dir, "commit", "-m", "initial");
  git(dir, "push", remote, "main");
  git(dir, "remote", "add", "origin", `git@gitea:alice/${name}.git`);
  git(dir, "config", "branch.main.remote", "origin"); git(dir, "config", "branch.main.merge", "refs/heads/main");
  const metadata = name === "workspace" ? path.join(root, "git-metadata/alice/workspace.git") : path.join(root, `git-metadata/alice/projects/${name}.git`);
  mkdirSync(path.dirname(metadata), { recursive: true }); renameSync(path.join(dir, ".git"), metadata);
  writeFileSync(path.join(dir, ".git"), `gitdir: ${metadata}\n`);
  writeFileSync(`${metadata}.octogee-trusted-v3`, `octogee-customer-git-v3\ngitea:${name}\n`);
  return dir;
}
function app() { const a = express(); a.use(express.json()); a.use("/internal/projects", createProjectPersistenceRouter()); return a; }
function flush(slug = "alice", token = "workload-token") {
  return request(app()).post("/internal/projects/flush").set("x-k8s-sa-token", token).send({ slug });
}
function restored(name: string): Buffer {
  const dir = path.join(root, "restored", name);
  git(root, "clone", path.join(remoteRoot, `${name}.git`), dir);
  return readFileSync(path.join(dir, "IDENTITY.md"));
}
beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), "shared-git-checkpoint-"));
  customer = path.join(root, "customers/alice"); remoteRoot = path.join(root, "remotes"); mkdirSync(remoteRoot);
  vi.stubEnv("GATEWAY_CLASS", "shared"); vi.stubEnv("GATEWAY_ID", "shared-one");
  vi.stubEnv("CUSTOMERS_DIR", path.join(root, "customers")); vi.stubEnv("INTERNAL_SERVICE_KEY", "");
  vi.stubEnv("K8S_NAMESPACE", "octogee-test"); vi.stubEnv("K8S_SERVICE_ACCOUNT_NAME", "octogee-gw-shared-one");
  vi.stubEnv("FLEET_BROKER_URL", "http://broker.invalid");
  const token = path.join(root, "token"); writeFileSync(token, "workload-token");
  vi.stubEnv("OCTOGEE_GATEWAY_CREDENTIAL_TOKEN_PATH", token);
  vi.stubEnv("OCTOGEE_API_SA_TOKEN_PATH", token);
  reviewed = { authenticated: true, namespace: "octogee-test", saName: "octogee-gw-shared-one", audiences: ["octogee-api"] };
  _setGatewayTokenReviewerForTests(async provided => provided === "workload-token" ? reviewed : { authenticated: false });
  const ssh = path.join(root, "ssh");
  writeFileSync(ssh, `#!/bin/sh\nfor last; do :; done\ncase "$last" in\n` + ["workspace", "demo"].flatMap(name => ["upload", "receive"].map(op =>
    `  "git-${op}-pack 'alice/${name}.git'") exec /usr/bin/git-${op}-pack '${remoteRoot}/${name}.git';;\n`)).join("") + "  *) exit 91;;\nesac\n", { mode: 0o700 });
  vi.stubEnv("TEST_GIT_SSH", ssh);
  snapshot = { uid: "uid-alice", slug: "alice", gatewayId: "shared-one", status: "complete", projects: [{ projectSlug: "demo", giteaRepoName: "demo", provisioningState: "active" }] };
  assignment = { uid: "uid-alice", state: "serving", epoch: 3 };
  broker = vi.fn(async (url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    if (url.endsWith("/uid-for-slug")) return Response.json({ uid: body.slug === "alice" ? "uid-alice" : "uid-bob" });
    if (url.endsWith("/user-snapshot")) return Response.json({ user: snapshot });
    if (url.endsWith("/assignment-roster")) return Response.json({ assignments: [assignment] });
    throw new Error(`unexpected network call ${url}`);
  });
  vi.stubGlobal("fetch", broker);
  checkout("workspace"); checkout("demo");
  writeFileSync(path.join(customer, "IDENTITY.md"), personas.workspace);
  writeFileSync(path.join(customer, "projects/demo/IDENTITY.md"), personas.demo);
});
afterEach(() => { _setGatewayTokenReviewerForTests(null); vi.unstubAllGlobals(); vi.unstubAllEnvs(); rmSync(root, { recursive: true, force: true }); });

it("checkpoints exact Shared coach and Gitea project persona bytes for a cold clone", async () => {
  expect((await flush()).status).toBe(200);
  expect(restored("workspace")).toEqual(Buffer.from(personas.workspace));
  expect(restored("demo")).toEqual(Buffer.from(personas.demo));
});

it("retains local files on remote failure and pushes the existing commit on retry", async () => {
  const remote = path.join(remoteRoot, "demo.git"); const retained = `${remote}.retained`; renameSync(remote, retained);
  expect((await flush()).status).toBe(503);
  expect(readFileSync(path.join(customer, "projects/demo/IDENTITY.md"), "utf8")).toBe(personas.demo);
  renameSync(retained, remote);
  expect((await flush()).status).toBe(200);
  expect(restored("demo")).toEqual(Buffer.from(personas.demo));
});

it("refuses missing authentication, another customer and changed assignment before Git writes", async () => {
  const before = git(path.join(remoteRoot, "workspace.git"), "rev-parse", "main");
  expect((await flush("alice", "wrong")).status).toBe(401);
  expect((await flush("bob")).status).toBe(503);
  snapshot.gatewayId = "shared-other";
  expect((await flush()).status).toBe(503);
  expect(git(path.join(remoteRoot, "workspace.git"), "rev-parse", "main")).toBe(before);
});

it("ignores deferred GitHub workspaces and disabled Gitea checkouts", async () => {
  snapshot.projects = [{ projectSlug: "demo", giteaRepoName: "demo", checkoutEnabled: false }, { projectSlug: "deferred", repoSource: { provider: "github", owner: "alice", repo: "deferred" } }];
  const deferred = path.join(customer, "projects/deferred"); mkdirSync(deferred); writeFileSync(path.join(deferred, "AGENTS.md"), "deferred\n");
  const before = git(path.join(remoteRoot, "demo.git"), "rev-parse", "main");
  expect((await flush()).status).toBe(200);
  expect(git(path.join(remoteRoot, "demo.git"), "rev-parse", "main")).toBe(before);
  expect(readFileSync(path.join(deferred, "AGENTS.md"), "utf8")).toBe("deferred\n");
});

it.each(["missing", "migrating", "epoch"])("refuses %s canonical assignment custody despite an unchanged user mirror", async mode => {
  let reads = 0;
  broker.mockImplementation(async (url: string) => {
    if (url.endsWith("/uid-for-slug")) return Response.json({ uid: "uid-alice" });
    if (url.endsWith("/user-snapshot")) return Response.json({ user: snapshot });
    if (++reads === 2 && mode === "epoch") assignment.epoch++;
    return Response.json({ assignments: mode === "missing" ? [] : [{ ...assignment, state: mode === "migrating" ? "migrating" : "serving" }] });
  });
  const before = git(path.join(remoteRoot, "workspace.git"), "rev-parse", "main");
  expect((await flush()).status).toBe(503);
  expect(git(path.join(remoteRoot, "workspace.git"), "rev-parse", "main")).toBe(before);
});

it("refuses a noncanonical project remote without committing its local persona", async () => {
  const metadata = path.join(root, "git-metadata/alice/projects/demo.git");
  const before = git(metadata, "rev-parse", "HEAD");
  git(metadata, "config", "remote.origin.url", "git@foreign:alice/demo.git");
  expect((await flush()).status).toBe(503);
  expect(git(metadata, "rev-parse", "HEAD")).toBe(before);
  expect(readFileSync(path.join(customer, "projects/demo/IDENTITY.md"), "utf8")).toBe(personas.demo);
});

it.each(["foreign-gateway", "api", "namespace", "audience", "missing-own"])("refuses %s workload credentials without Git effects", async reason => {
  if (reason === "foreign-gateway") reviewed.saName = "octogee-gw-other";
  if (reason === "api") reviewed.saName = "octogee-api";
  if (reason === "namespace") reviewed.namespace = "octogee";
  if (reason === "audience") reviewed.audiences = ["other"];
  if (reason === "missing-own") vi.stubEnv("K8S_SERVICE_ACCOUNT_NAME", "");
  const before = git(path.join(remoteRoot, "workspace.git"), "rev-parse", "main");
  expect((await flush()).status).toBe(401);
  expect(broker).not.toHaveBeenCalled();
  expect(git(path.join(remoteRoot, "workspace.git"), "rev-parse", "main")).toBe(before);
});

it("does not enable workload authentication for unrelated Shared internal routes", async () => {
  const a = express(); a.post("/unrelated", requireGatewayInternalAuth, (_req, res) => res.sendStatus(204));
  expect((await request(a).post("/unrelated").set("x-k8s-sa-token", "workload-token")).status).toBe(503);
});
