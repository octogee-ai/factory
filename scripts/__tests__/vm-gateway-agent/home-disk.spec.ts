import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

const run = promisify(execFile);
const script = resolve(import.meta.dirname, "../../../infra/desktop/image/rootfs/usr/local/bin/octo-home-disk");
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

const mock = `#!/usr/bin/python3
import json, os, pathlib, sys
root = pathlib.Path(os.environ['HOME_DISK_FIXTURE'])
command = pathlib.Path(sys.argv[0]).name
args = sys.argv[1:]
with (root / 'calls').open('a') as out: out.write(json.dumps([command, *args]) + '\\n')
layout = json.loads((root / 'layout.json').read_text())
if command == 'blkid':
    if '-s' in args and args[args.index('-s') + 1] == 'UUID':
        print('owned-home-uuid'); sys.exit(0)
    if layout['probe'] == 0: print(layout['fstype'])
    sys.exit(layout['probe'])
if command == 'findmnt':
    if args[-1].endswith('/home/octo'): print(layout.get('desktopMount', 'owned-home-uuid btrfs /desktop-home'))
    else: print(layout.get('stateMount', 'owned-home-uuid btrfs /'))
if command == 'mountpoint':
    sys.exit(0 if args[-1] in layout.get('mounted', []) else 1)
`;

async function fixture(layout: { probe: number; fstype?: string; attached?: boolean; mounted?: string[]; stateMount?: string; desktopMount?: string }) {
  const root = await mkdtemp(`${tmpdir()}/octogee-home-disk-`);
  roots.push(root);
  const paths = { device: `${root}/dev/scsi-0Google_PersistentDisk_octogee-home`, stateRoot: `${root}/srv/octogee`, userHome: `${root}/home/octo` };
  await mkdir(`${root}/bin`);
  await mkdir(`${root}/dev`);
  await mkdir(paths.userHome, { recursive: true });
  await writeFile(`${paths.userHome}/.bashrc`, "image default\n");
  if (layout.attached !== false) await writeFile(paths.device, "");
  const mounted = (layout.mounted ?? []).map((name) => paths[name as keyof typeof paths]);
  await writeFile(`${root}/layout.json`, JSON.stringify({ ...layout, mounted }));
  for (const name of ["blkid", "mkfs.btrfs", "mountpoint", "mount", "btrfs", "findmnt"]) await writeFile(`${root}/bin/${name}`, mock, { mode: 0o755 });
  const env = {
    ...process.env,
    PATH: `${root}/bin:${process.env.PATH}`,
    HOME_DISK_FIXTURE: root,
    OCTO_HOME_DEVICE: paths.device,
    OCTO_VM_STATE_ROOT: paths.stateRoot,
    OCTO_USER_HOME: paths.userHome,
    OCTO_HOME_DEVICE_WAIT_SECONDS: "1",
  };
  const calls = async () => (await readFile(`${root}/calls`, "utf8").catch(() => "")).trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as string[]);
  return { env, calls, paths };
}

describe("octo-home-disk", () => {
  it("adds native desktop defaults to a migrated Hobby home without overwriting user files", async () => {
    const h = await fixture({ probe: 0, fstype: "btrfs" });
    await mkdir(`${h.paths.stateRoot}/desktop-home`, { recursive: true });
    await writeFile(`${h.paths.stateRoot}/.octogee-home-layout.json`, JSON.stringify({ version: 1 }));
    await writeFile(`${h.paths.stateRoot}/desktop-home/document.txt`, "keep me");
    await run("bash", [script], { env: h.env });
    expect(await readFile(`${h.paths.stateRoot}/desktop-home/.bashrc`, "utf8")).toBe("image default\n");
    expect(await readFile(`${h.paths.stateRoot}/desktop-home/document.txt`, "utf8")).toBe("keep me");
    await writeFile(`${h.paths.stateRoot}/desktop-home/.bashrc`, "my shell");
    await run("bash", [script], { env: h.env });
    expect(await readFile(`${h.paths.stateRoot}/desktop-home/.bashrc`, "utf8")).toBe("my shell");
  });
  it("formats a blank home disk, mounts it as the agent state root, seeds the desktop home from the image, and binds it over the user's home", async () => {
    const h = await fixture({ probe: 2 });
    const { stdout } = await run("bash", [script], { env: h.env });
    expect(stdout).toContain(`formatting blank ${h.paths.device} as btrfs`);
    expect(await h.calls()).toEqual([
      ["blkid", "-p", "-s", "TYPE", "-o", "value", h.paths.device],
      ["mkfs.btrfs", "-q", "-L", "octogee-home", h.paths.device],
      ["blkid", "-s", "UUID", "-o", "value", h.paths.device],
      ["mountpoint", "-q", h.paths.stateRoot],
      ["mount", "-o", "noatime", h.paths.device, h.paths.stateRoot],
      ["findmnt", "-n", "-o", "UUID,FSTYPE,FSROOT", "--mountpoint", h.paths.stateRoot],
      ["mountpoint", "-q", h.paths.userHome],
      ["btrfs", "filesystem", "resize", "max", h.paths.stateRoot],
      ["mountpoint", "-q", h.paths.userHome],
      ["mount", "--bind", `${h.paths.stateRoot}/desktop-home`, h.paths.userHome],
      ["findmnt", "-n", "-o", "UUID,FSTYPE,FSROOT", "--mountpoint", h.paths.userHome],
    ]);
    expect(await readFile(`${h.paths.stateRoot}/desktop-home/.bashrc`, "utf8")).toBe("image default\n");
  });

  it("reattaches an existing home without formatting it or reseeding over the Builder's files, and grows it to a resized disk", async () => {
    const h = await fixture({ probe: 0, fstype: "btrfs" });
    await mkdir(`${h.paths.stateRoot}/desktop-home`, { recursive: true });
    await writeFile(`${h.paths.stateRoot}/desktop-home/.bashrc`, "builder edit\n");
    await run("bash", [script], { env: h.env });
    const calls = await h.calls();
    expect(calls.map((call) => call[0])).not.toContain("mkfs.btrfs");
    expect(calls).toContainEqual(["btrfs", "filesystem", "resize", "max", h.paths.stateRoot]);
    expect(await readFile(`${h.paths.stateRoot}/desktop-home/.bashrc`, "utf8")).toBe("builder edit\n");
  });

  it("leaves mounts that are already in place alone on a unit restart", async () => {
    const h = await fixture({ probe: 0, fstype: "btrfs", mounted: ["stateRoot", "userHome"] });
    await mkdir(`${h.paths.stateRoot}/desktop-home`, { recursive: true });
    await run("bash", [script], { env: h.env });
    expect((await h.calls()).filter((call) => call[0] === "mount")).toEqual([]);
  });

  it.each([
    [{ stateMount: "another-disk-uuid btrfs /" }, "stateRoot"],
    [{ stateMount: "owned-home-uuid btrfs /another-subvolume" }, "stateRoot"],
    [{ desktopMount: "another-disk-uuid btrfs /desktop-home" }, "userHome"],
    [{ desktopMount: "owned-home-uuid btrfs /wrong-home" }, "userHome"],
  ])("refuses a pre-existing mount with the wrong disk or directory: %j", async (layout, mount) => {
    const h = await fixture({ probe: 0, fstype: "btrfs", mounted: [mount], ...layout });
    await expect(run("bash", [script], { env: h.env })).rejects.toMatchObject({ code: 1, stderr: expect.stringContaining("does not match the attached home") });
    expect((await h.calls()).filter((call) => call[0] === "mkfs.btrfs")).toEqual([]);
  });

  it.each([
    [{ probe: 0, fstype: "ext4" }, "holds ext4, not btrfs; refusing to mount or format it"],
    [{ probe: 4 }, "blkid could not probe"],
    [{ probe: 2, attached: false }, "is not attached; the Builder home stays unmounted rather than landing on the boot disk"],
  ])("fails loudly without formatting or mounting when the disk is %j", async (layout, message) => {
    const h = await fixture(layout);
    await expect(run("bash", [script], { env: h.env })).rejects.toMatchObject({ code: 1, stderr: expect.stringContaining(message) });
    expect((await h.calls()).map((call) => call[0]).filter((command) => command === "mkfs.btrfs" || command === "mount")).toEqual([]);
  });
});
