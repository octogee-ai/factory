import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream, openAsBlob } from "node:fs";
import { mkdir, mkdtemp, readdir, rename, rm, stat, utimes, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { promisify } from "node:util";
import type { HomeFs, HomeShell } from "./home-checkpoint.js";

const exec = promisify(execFile);

export const homeShell: HomeShell = {
  run: async (command, args) => {
    try {
      const { stdout, stderr } = await exec(command, args, { maxBuffer: 16 * 1024 * 1024 });
      return { code: 0, stdout, stderr };
    } catch (error) {
      const failure = error as Error & { code?: number | string; stdout?: string; stderr?: string };
      return { code: typeof failure.code === "number" ? failure.code : 127, stdout: failure.stdout ?? "", stderr: `${failure.message}\n${failure.stderr ?? ""}` };
    }
  },
};

async function exists(path: string): Promise<boolean> {
  try { await stat(path); return true; } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

export function createHomeFs(stateRoot: string): HomeFs {
  return {
    listDir: async (path) => (await exists(path)) ? readdir(path) : [],
    exists,
    fileSize: async (path) => (await stat(path)).size,
    sha256: (path) => new Promise((resolve, reject) => {
      const hash = createHash("sha256");
      createReadStream(path).on("error", reject).on("data", (chunk) => hash.update(chunk)).on("end", () => resolve(hash.digest("hex")));
    }),
    mkdtemp: async (prefix) => {
      const root = `${stateRoot}/tmp`;
      await mkdir(root, { recursive: true, mode: 0o700 });
      return mkdtemp(`${root}/${prefix}`);
    },
    rm: (path) => rm(path, { recursive: true, force: true }),
    touch: async (path, at) => {
      if (!(await exists(path))) await writeFile(path, "", { mode: 0o600 });
      await utimes(path, at / 1000, at / 1000);
    },
    uploadBody: (path) => openAsBlob(path),
    saveResponse: async (response, path) => {
      if (!response.body) throw new Error("home checkpoint download has no body");
      await pipeline(Readable.fromWeb(response.body as import("node:stream/web").ReadableStream), createWriteStream(path, { mode: 0o600 }));
    },
    mkdir: (path, mode) => mkdir(path, { recursive: true, mode }).then(() => undefined),
    replaceDirectory: async (source, target) => {
      const stage = `${target}.octogee-restore-stage`;
      const backup = `${target}.octogee-restore-backup`;
      await mkdir(dirname(target), { recursive: true });
      await rm(stage, { recursive: true, force: true });
      await exec("cp", ["-a", "--", source, stage]);
      await rm(backup, { recursive: true, force: true });
      if (await exists(target)) await rename(target, backup);
      await rename(stage, target);
      await rm(backup, { recursive: true, force: true });
    },
  };
}
