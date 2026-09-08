import * as fs from "node:fs/promises";
import * as path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { isValidUsername } from "../../shared/types/identity.js";
import { OPENCLAW_DIR } from "./config.js";

const run = promisify(execFile);
function customerPath(root: string, slug: string): string {
  if (!isValidUsername(slug)) throw new Error("Invalid customer slug");
  return path.join(root, "customers", slug);
}

export async function customerFileStatePaths(root: string, slug: string): Promise<Array<{ cwd: string; path: string }>> {
  customerPath(root, slug);
  const sources: Array<{ cwd: string; path: string }> = [];
  for (const directory of ["customers", "git-metadata", "customer-keys"]) {
    const relative = path.join(directory, slug);
    try {
      const stat = await fs.lstat(path.join(root, relative));
      if (!stat.isDirectory()) throw new Error(`Customer state is not a directory: ${relative}`);
      sources.push({ cwd: root, path: relative });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  return sources;
}

export async function flushCustomerFiles(slug: string, { root = OPENCLAW_DIR } = {}): Promise<void> {
  const workspace = customerPath(root, slug);
  if (!(await fs.lstat(workspace)).isDirectory()) throw new Error(`Customer workspace is not a directory: ${slug}`);
  for (const source of await customerFileStatePaths(root, slug)) {
    await run("/usr/bin/sync", ["-f", path.join(source.cwd, source.path)]);
  }
}

export async function flushAllCustomerFiles({ root = OPENCLAW_DIR } = {}): Promise<void> {
  const customers = path.join(root, "customers");
  let entries;
  try { entries = await fs.readdir(customers, { withFileTypes: true }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  for (const entry of entries) {
    if (entry.isDirectory() && isValidUsername(entry.name)) await flushCustomerFiles(entry.name, { root });
  }
}
