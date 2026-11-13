import { constants } from "node:fs";
import * as fs from "node:fs/promises";
import path from "node:path";

async function mkdirIfAbsent(directory: string): Promise<void> {
  try { await fs.mkdir(directory, { mode: 0o700 }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
}

export async function withPinnedDirectory<T>(root: string, parts: readonly string[], use: (location: string, assertCurrent: () => Promise<void>) => Promise<T>, create = false): Promise<T> {
  if (await fs.realpath(root) !== root) throw new Error("Directory root is not canonical");
  const handles: fs.FileHandle[] = [];
  const fdRoot = process.platform === "linux" ? "/proc/self/fd" : "/dev/fd";
  const flags = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;
  try {
    handles.push(await fs.open(root, flags));
    for (const part of parts) {
      if (part === "." || part === ".." || path.basename(part) !== part) throw new Error("Invalid directory component");
      const next = `${fdRoot}/${handles.at(-1)!.fd}/${part}`;
      if (create) await mkdirIfAbsent(next);
      handles.push(await fs.open(next, flags));
    }
    const directory = handles.at(-1)!;
    const expected = await directory.stat();
    const workspace = path.join(root, ...parts);
    const assertCurrent = async () => {
      const current = await fs.lstat(workspace);
      if (!current.isDirectory() || current.dev !== expected.dev || current.ino !== expected.ino || await fs.realpath(workspace) !== workspace) {
        throw new Error("Workspace directory changed");
      }
    };
    await assertCurrent();
    const result = await use(`${fdRoot}/${directory.fd}`, assertCurrent);
    await assertCurrent();
    return result;
  } finally { for (const handle of handles.reverse()) await handle.close(); }
}
