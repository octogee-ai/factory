import { lstat, readdir } from "node:fs/promises";
import path from "node:path";
import { readProjectRestoreReady } from "@octogee/core/project-asset-state";
import { isValidProjectId, isValidUsername } from "@octogee/shared/types/identity";
import { commitAndPushWorkspace, isTrustedGithubCustomerCheckout, resolveProjectDir } from "./workspace-git.js";
import { divertWorktreeBinaries } from "./binary-diversion.js";
import { readOwnerRuntimeConnectorAccessToken } from "./connector-tokens.js";

interface ProjectPersistenceDeps {
  resolveProject: typeof resolveProjectDir;
  commit: typeof commitAndPushWorkspace;
  divert: typeof divertWorktreeBinaries;
  githubToken: (dir: string) => Promise<string | undefined>;
}
const defaults: ProjectPersistenceDeps = {
  resolveProject: resolveProjectDir,
  commit: commitAndPushWorkspace,
  divert: (dir, target) => divertWorktreeBinaries(dir, target, undefined, { retainLocalFiles: true }),
  githubToken: async dir => {
    if (!isTrustedGithubCustomerCheckout(dir)) return undefined;
    const token = await readOwnerRuntimeConnectorAccessToken("github");
    if (!token) throw new Error("Reconnect GitHub before saving this project");
    return token;
  },
};

export async function persistBuilderProjects(input: { root: string; slug: string }, deps: ProjectPersistenceDeps = defaults): Promise<{ projects: number }> {
  if (!isValidUsername(input.slug)) throw new Error("invalid project owner");
  const directory = path.join(input.root, input.slug, "projects");
  for (const candidate of [input.root, path.join(input.root, input.slug), directory]) {
    if (!(await lstat(candidate)).isDirectory()) throw new Error("project root is not a directory");
  }
  const entries = (await readdir(directory, { withFileTypes: true })).filter(entry => entry.name !== ".octogee-state");
  for (const entry of entries) {
    if (!entry.isDirectory() || !isValidProjectId(entry.name)) throw new Error(`project is not a valid directory: ${entry.name}`);
    if (!await readProjectRestoreReady(path.join(directory, entry.name), input.slug, entry.name)) throw new Error(`project restore is incomplete: ${entry.name}`);
    const dir = await deps.resolveProject(input.root, input.slug, entry.name);
    if (!dir) throw new Error(`project repository unavailable: ${entry.name}`);
    const githubToken = await deps.githubToken(dir);
    const saved = await deps.commit(dir, {
      message: "autosave: project changes",
      author: { name: "Octogee autosave", email: `${input.slug}@octogee.com` },
      ...(githubToken ? { githubToken } : {}),
      beforeCommit: async () => {
        const result = await deps.divert(dir, { slug: input.slug, projectSlug: entry.name, gcsPrefix: `customers/${input.slug}/projects/${entry.name}` });
        return result.failures.length
          ? { ok: false, error: { code: "BLOB_DIVERSION_FAILED", cwd: dir, paths: result.failedPaths } }
          : { ok: true, excludePaths: result.diverted.map(blob => blob.path) };
      },
    });
    if (!saved.ok) throw new Error(`project ${entry.name}: ${saved.error.code}`);
    if (!saved.result.pushed) throw new Error(`project ${entry.name}: ${saved.result.pushError || "remote push unconfirmed"}`);
  }
  return { projects: entries.length };
}
