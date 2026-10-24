import * as fs from "node:fs/promises";
import * as path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { isValidUsername } from "../../shared/types/identity.js";
import { brokerTokenExpiryDirectory, removeBrokerTokenExpiriesForSlug } from "./broker-token-refresh.js";
import { OPENCLAW_DIR } from "./config.js";

const run = promisify(execFile);
const DEPARTED_CUSTOMER_GIT_STATE_ROOTS = [
  "git-metadata",
  "git-metadata-quarantine",
  "git-source-switch-locks",
  "git-worktree-quarantine",
  "git-metadata-source-switch-backups",
];
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

export async function flushCustomerFiles(slug: string, { root = OPENCLAW_DIR, persistProjects }: { root?: string; persistProjects?: (slug: string) => Promise<void> } = {}): Promise<void> {
  const workspace = customerPath(root, slug);
  if (!(await fs.lstat(workspace)).isDirectory()) throw new Error(`Customer workspace is not a directory: ${slug}`);
  await persistProjects?.(slug);
  for (const source of await customerFileStatePaths(root, slug)) {
    await run("/usr/bin/sync", ["-f", path.join(source.cwd, source.path)]);
  }
}

export async function flushAllCustomerFiles({ root = OPENCLAW_DIR, persistProjects, slugs }: { root?: string; persistProjects?: (slug: string) => Promise<void>; slugs?: readonly string[] } = {}): Promise<void> {
  const customers = path.join(root, "customers");
  let targets = slugs;
  try { targets ??= (await fs.readdir(customers, { withFileTypes: true })).filter(entry => entry.isDirectory() && isValidUsername(entry.name)).map(entry => entry.name); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  const failures: Error[] = [];
  for (const slug of targets) {
    try { await flushCustomerFiles(slug, { root, persistProjects }); }
    catch (error) { failures.push(new Error(`${slug}: ${String(error)}`, { cause: error })); }
  }
  if (failures.length) throw new AggregateError(failures, `Customer file flush failed: ${failures.map(error => error.message).join("; ")}`);
}

export async function removeDepartedCustomerFileState(
  slug: string,
  { root = OPENCLAW_DIR, log }: { root?: string; log: (message: string) => void },
): Promise<void> {
  const workspace = customerPath(root, slug);
  for (const directory of DEPARTED_CUSTOMER_GIT_STATE_ROOTS) {
    await fs.rm(path.join(root, directory, slug), { recursive: true, force: true });
  }
  removeBrokerTokenExpiriesForSlug(brokerTokenExpiryDirectory(root), slug, log);
  await fs.rm(workspace, { recursive: true, force: true });
}
