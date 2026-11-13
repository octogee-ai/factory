import { mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export function replaceFileAtomically(path: string, contents: string, mode = 0o600): void {
  const staging = mkdtempSync(join(dirname(path), ".octogee-write-"));
  try {
    const pending = join(staging, "pending");
    writeFileSync(pending, contents, { encoding: "utf8", flag: "wx", mode });
    renameSync(pending, path);
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}
