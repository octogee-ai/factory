import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";

export const PROC_ROOT = "/proc";
const DELETED_LINK_SUFFIX = " (deleted)";
const SQLITE_FAMILY_SUFFIXES = ["", "-wal", "-shm", "-journal"] as const;

export class HeldAgentStoreError extends Error {
  readonly heldPaths: readonly string[];

  constructor(heldPaths: readonly string[]) {
    super(`agent database files are still held open: ${heldPaths.join(", ")}`);
    this.name = "HeldAgentStoreError";
    this.heldPaths = heldPaths;
  }
}

export function sqliteFamily(databasePath: string): string[] {
  return SQLITE_FAMILY_SUFFIXES.map((suffix) => `${databasePath}${suffix}`);
}

export type HeldPathMatcher = (linkedPath: string) => boolean;

export function matchFiles(files: readonly string[]): HeldPathMatcher {
  const candidates = new Set(files);
  return (linked) => candidates.has(linked);
}

export function matchUnder(root: string): HeldPathMatcher {
  const prefix = `${path.resolve(root)}${path.sep}`;
  return (linked) => linked.startsWith(prefix);
}

function isVanishedOrForeignProcess(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  return code === "ENOENT" || code === "ESRCH" || code === "EACCES" || code === "EPERM";
}

function linkedPath(target: string): string {
  return target.endsWith(DELETED_LINK_SUFFIX) ? target.slice(0, -DELETED_LINK_SUFFIX.length) : target;
}

async function heldByProcess(fdDir: string, match: HeldPathMatcher): Promise<string[]> {
  let descriptors: string[];
  try {
    descriptors = await fsp.readdir(fdDir);
  } catch (error) {
    if (isVanishedOrForeignProcess(error)) return [];
    throw error;
  }
  const held: string[] = [];
  for (const descriptor of descriptors) {
    let target: string;
    try {
      target = await fsp.readlink(path.join(fdDir, descriptor));
    } catch (error) {
      if (isVanishedOrForeignProcess(error)) continue;
      throw error;
    }
    const linked = linkedPath(target);
    if (match(linked)) held.push(linked);
  }
  return held;
}

function heldByProcessSync(fdDir: string, match: HeldPathMatcher): string[] {
  let descriptors: string[];
  try {
    descriptors = fs.readdirSync(fdDir);
  } catch (error) {
    if (isVanishedOrForeignProcess(error)) return [];
    throw error;
  }
  const held: string[] = [];
  for (const descriptor of descriptors) {
    let target: string;
    try {
      target = fs.readlinkSync(path.join(fdDir, descriptor));
    } catch (error) {
      if (isVanishedOrForeignProcess(error)) continue;
      throw error;
    }
    const linked = linkedPath(target);
    if (match(linked)) held.push(linked);
  }
  return held;
}

function processIds(entries: readonly string[]): string[] {
  return entries.filter((entry) => /^\d+$/u.test(entry));
}

export async function findHeldPaths(match: HeldPathMatcher, procRoot: string): Promise<string[]> {
  const held = new Set<string>();
  for (const pid of processIds(await fsp.readdir(procRoot))) {
    for (const file of await heldByProcess(path.join(procRoot, pid, "fd"), match)) held.add(file);
  }
  return [...held].sort();
}

export function findHeldPathsSync(match: HeldPathMatcher, procRoot: string): string[] {
  const held = new Set<string>();
  for (const pid of processIds(fs.readdirSync(procRoot))) {
    for (const file of heldByProcessSync(path.join(procRoot, pid, "fd"), match)) held.add(file);
  }
  return [...held].sort();
}

export async function assertNotHeld(match: HeldPathMatcher, procRoot: string): Promise<void> {
  const held = await findHeldPaths(match, procRoot);
  if (held.length > 0) throw new HeldAgentStoreError(held);
}

export function assertNotHeldSync(match: HeldPathMatcher, procRoot: string): void {
  const held = findHeldPathsSync(match, procRoot);
  if (held.length > 0) throw new HeldAgentStoreError(held);
}
