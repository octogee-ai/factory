import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const archiveEvidence = resolve(import.meta.dirname, "../lib/ops-agent-evidence.sh");

const git = (cwd: string, ...args: string[]): string =>
  execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

const write = (cwd: string, path: string, contents: string) => {
  const destination = resolve(cwd, path);
  mkdirSync(resolve(destination, ".."), { recursive: true });
  writeFileSync(destination, contents);
};

describe("ops-agent source evidence archive", () => {
  it("archives only the exact committed non-sensitive tree with recorded provenance", () => {
    const source = mkdtempSync(resolve(tmpdir(), "octogee-ops-agent-evidence-source-"));
    git(source, "init");
    git(source, "config", "user.email", "ops-agent-evidence@example.test");
    git(source, "config", "user.name", "Ops Agent Evidence Test");
    write(source, "src/visible.ts", "export const release = 'committed';\n");
    write(source, ".env.example", "SAFE_EXAMPLE=false\n");
    write(source, "functions/.env.octogee", "TRACKED_SECRET=do-not-ship\n");
    write(source, "nested/.env.test", "TRACKED_TEST_SECRET=do-not-ship\n");
    write(source, "certificates/service.pem", "private certificate\n");
    write(source, "keys/service.key", "private key\n");
    write(source, "keys/service.p12", "pkcs12\n");
    write(source, "keys/service.pfx", "pfx\n");
    git(source, "add", ".");
    git(source, "commit", "-m", "seed evidence");
    const sourceCommit = git(source, "rev-parse", "HEAD");

    write(source, "src/visible.ts", "export const release = 'uncommitted';\n");
    write(source, "untracked.txt", "must not be archived\n");
    const destination = resolve(mkdtempSync(resolve(tmpdir(), "octogee-ops-agent-evidence-output-")), "source");

    const result = spawnSync("bash", [archiveEvidence, source, sourceCommit, destination], {
      encoding: "utf8",
    });

    expect(result.status, result.stderr).toBe(0);
    expect(readFileSync(resolve(destination, "src/visible.ts"), "utf8")).toBe(
      "export const release = 'committed';\n",
    );
    expect(readFileSync(resolve(destination, ".octogee-source-commit"), "utf8")).toBe(
      `${sourceCommit}\n`,
    );
    expect(existsSync(resolve(destination, ".git"))).toBe(false);
    expect(existsSync(resolve(destination, ".env.example"))).toBe(false);
    expect(existsSync(resolve(destination, "functions/.env.octogee"))).toBe(false);
    expect(existsSync(resolve(destination, "nested/.env.test"))).toBe(false);
    expect(existsSync(resolve(destination, "certificates/service.pem"))).toBe(false);
    expect(existsSync(resolve(destination, "keys/service.key"))).toBe(false);
    expect(existsSync(resolve(destination, "keys/service.p12"))).toBe(false);
    expect(existsSync(resolve(destination, "keys/service.pfx"))).toBe(false);
    expect(existsSync(resolve(destination, "untracked.txt"))).toBe(false);
  });
});
