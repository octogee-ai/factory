import { mkdtemp, mkdir, readFile, readdir, rename, rm, symlink, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { prepareBuilderProjectStorage } from "../lib/builder-project-storage.js";

let root: string;
let home: string;
let projects: string;
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "builder-projects-"));
  home = path.join(root, "home"); projects = path.join(root, "projects");
  await mkdir(path.join(home, ".openclaw/customers/alice/projects/demo"), { recursive: true });
  await mkdir(projects);
});
afterEach(async () => { await rm(root, { recursive: true, force: true }); });
const mounted = { assertMount: vi.fn(async () => {}) };
it("copies editable project state to the separate mount and preserves its source until remote save", async () => {
  const source = path.join(home, ".openclaw/customers/alice/projects/demo");
  await writeFile(path.join(source, "unsaved.txt"), "dirty");
  await writeFile(path.join(source, ".env"), "ignored local state");
  await writeFile(path.join(source, ".git"), "gitdir: /home/node/.openclaw/git-metadata/alice/projects/demo.git\n");
  await prepareBuilderProjectStorage({ home, projects, slug: "alice" }, mounted);
  for (const name of ["unsaved.txt", ".env", ".git"]) expect(await readFile(path.join(projects, "projects/demo", name), "utf8")).toBe(await readFile(path.join(home, ".openclaw/project-imports/alice/demo", name), "utf8"));
  expect(await readdir(path.dirname(source))).toEqual([]);
  await writeFile(path.join(projects, "projects/demo/unsaved.txt"), "newer");
  await mkdir(path.join(projects, "projects/.octogee-state"));
  await writeFile(path.join(projects, "projects/.octogee-state/demo.assets.json"), "materialization state");
  await writeFile(path.join(projects, "projects/.octogee-state/demo.json"), "previous ready marker");
  await prepareBuilderProjectStorage({ home, projects, slug: "alice" }, mounted);
  expect(await readFile(path.join(projects, "projects/demo/unsaved.txt"), "utf8")).toBe("newer");
  expect(await readdir(path.join(projects, "projects/.octogee-state"))).toEqual(["demo.assets.json"]);
});
it("invalidates a retained working set when the home returns from another project mount", async () => {
  await prepareBuilderProjectStorage({ home, projects, slug: "alice" }, mounted);
  await writeFile(path.join(projects, "projects/demo/unsaved.txt"), "retained Hobby work");
  const native = path.join(root, "native-projects");
  await mkdir(native);
  await prepareBuilderProjectStorage({ home, projects: native, slug: "alice" }, mounted);
  await mkdir(path.join(native, "projects/demo"));
  await writeFile(path.join(native, "projects/demo/newer.txt"), "native work saved remotely");
  const metadata = path.join(home, ".openclaw/git-metadata/alice/projects");
  await mkdir(metadata, { recursive: true });
  await writeFile(path.join(metadata, "local-commit"), "preserve unpublished commit objects");
  await prepareBuilderProjectStorage({ home, projects, slug: "alice" }, mounted);
  expect(await readdir(path.join(projects, "projects"))).toEqual([]);
  await expect(readdir(metadata)).rejects.toMatchObject({ code: "ENOENT" });
  const history = path.join(home, ".openclaw/project-storage-history/alice");
  const [generation] = await readdir(history);
  expect(await readFile(path.join(history, generation, "local-commit"), "utf8")).toBe("preserve unpublished commit objects");
  const retained = await readdir(path.join(projects, ".octogee-retained"));
  expect(retained).toHaveLength(1);
  expect(await readFile(path.join(projects, ".octogee-retained", retained[0], "demo/unsaved.txt"), "utf8")).toBe("retained Hobby work");
  await mkdir(path.join(projects, "projects/demo"));
  await writeFile(path.join(projects, "projects/demo/newer.txt"), "new canonical checkout");
  await prepareBuilderProjectStorage({ home, projects, slug: "alice" }, mounted);
  expect(await readFile(path.join(projects, "projects/demo/newer.txt"), "utf8")).toBe("new canonical checkout");
});
it.each([false, true])("resumes an interrupted runtime transition after retaining the old checkout: %s", async (alreadyRetained) => {
  await prepareBuilderProjectStorage({ home, projects, slug: "alice" }, mounted);
  await writeFile(path.join(projects, "projects/demo/local.txt"), "keep");
  const marker = path.join(projects, ".octogee-storage.json");
  const previous = JSON.parse(await readFile(marker, "utf8"));
  await writeFile(marker, JSON.stringify({ ...previous, status: "preparing", generation: randomUUID(), previousGeneration: previous.generation }));
  const retained = path.join(projects, ".octogee-retained", previous.generation);
  if (alreadyRetained) {
    await mkdir(path.dirname(retained));
    await rename(path.join(projects, "projects"), retained);
  }
  await prepareBuilderProjectStorage({ home, projects, slug: "alice" }, mounted);
  expect(await readdir(path.join(projects, "projects"))).toEqual([]);
  expect(await readFile(path.join(retained, "demo/local.txt"), "utf8")).toBe("keep");
  await prepareBuilderProjectStorage({ home, projects, slug: "alice" }, mounted);
  expect(await readdir(path.dirname(retained))).toEqual([previous.generation]);
});
it("returns to Hobby at the canonical native commit and can push again", async () => {
  const git = (...args: string[]) => execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  const remote = path.join(root, "remote.git"), seed = path.join(root, "seed");
  git("init", "--bare", "--initial-branch=main", remote);
  git("clone", remote, seed);
  const commit = async (repo: string, text: string) => {
    await writeFile(path.join(repo, "file.txt"), text);
    git("-C", repo, "add", "file.txt");
    git("-C", repo, "-c", "user.name=Builder", "-c", "user.email=builder@example.test", "commit", "-m", text);
    git("-C", repo, "push", "origin", "main");
  };
  await commit(seed, "Hobby version");
  await prepareBuilderProjectStorage({ home, projects, slug: "alice" }, mounted);
  const hobby = path.join(projects, "projects/demo");
  git("clone", remote, hobby);
  const native = path.join(root, "native-projects");
  await mkdir(native);
  await prepareBuilderProjectStorage({ home, projects: native, slug: "alice" }, mounted);
  const nativeRepo = path.join(native, "projects/demo");
  git("clone", remote, nativeRepo);
  await commit(nativeRepo, "Native version");
  const nativeHead = git("-C", nativeRepo, "rev-parse", "HEAD");
  await prepareBuilderProjectStorage({ home, projects, slug: "alice" }, mounted);
  git("clone", remote, hobby);
  expect(git("-C", hobby, "rev-parse", "HEAD")).toBe(nativeHead);
  expect(await readFile(path.join(hobby, "file.txt"), "utf8")).toBe("Native version");
  await commit(hobby, "Returned Hobby version");
  expect(git("--git-dir", remote, "rev-parse", "main")).toBe(git("-C", hobby, "rev-parse", "HEAD"));
});
it("refuses an unverified existing mount instead of overwriting work", async () => {
  await mkdir(path.join(projects, "demo"));
  await writeFile(path.join(projects, "demo/local.txt"), "keep");
  await expect(prepareBuilderProjectStorage({ home, projects, slug: "alice" }, mounted)).rejects.toThrow(/uninitialized/);
  expect(await readFile(path.join(projects, "demo/local.txt"), "utf8")).toBe("keep");
});
it("initializes an ext4 project volume while preserving its recovery directory", async () => {
  await mkdir(path.join(projects, "lost+found"));
  await writeFile(path.join(projects, "lost+found/recovered-file"), "filesystem recovery data");
  await prepareBuilderProjectStorage({ home, projects, slug: "alice" }, mounted);
  expect(JSON.parse(await readFile(path.join(projects, ".octogee-storage.json"), "utf8"))).toMatchObject({ slug: "alice", status: "ready" });
  expect(await readFile(path.join(projects, "lost+found/recovered-file"), "utf8")).toBe("filesystem recovery data");
});
it.each(["file", "symlink"])("refuses a %s masquerading as the filesystem recovery directory", async (kind) => {
  const recovery = path.join(projects, "lost+found");
  if (kind === "file") await writeFile(recovery, "existing work");
  else await symlink(home, recovery);
  await expect(prepareBuilderProjectStorage({ home, projects, slug: "alice" }, mounted)).rejects.toThrow(/uninitialized/);
  expect(await readdir(projects)).toEqual(["lost+found"]);
});
it("fails before copying if the working set is not separately mounted", async () => {
  await expect(prepareBuilderProjectStorage({ home, projects, slug: "alice" })).rejects.toThrow(/filesystem/);
  expect(await readdir(projects)).toEqual([]);
});
it("rejects a symlink source root and foreign mount ownership", async () => {
  await rm(path.join(home, ".openclaw/customers/alice/projects"), { recursive: true });
  await symlink(projects, path.join(home, ".openclaw/customers/alice/projects"));
  await expect(prepareBuilderProjectStorage({ home, projects, slug: "alice" }, mounted)).rejects.toThrow(/directory/);
  await rm(path.join(home, ".openclaw/customers/alice/projects"));
  await writeFile(path.join(projects, ".octogee-storage.json"), JSON.stringify({ version: 1, slug: "bob" }));
  await expect(prepareBuilderProjectStorage({ home, projects, slug: "alice" }, mounted)).rejects.toThrow(/owner/);
});
