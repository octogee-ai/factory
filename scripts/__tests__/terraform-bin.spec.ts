import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

const terraformBin = path.resolve(__dirname, "../ops/terraform-bin.sh");

describe("Terraform binary resolver", () => {
  it("keeps downloaded Terraform in an owner-validated private cache without executing cached binaries", () => {
    const source = readFileSync(terraformBin, "utf-8");

    expect(source).toContain('TOOL_CACHE_ROOT="${XDG_CACHE_HOME:-${HOME:?}/.cache}/octogee-toolchain"');
    expect(source).toContain('secure_path "${TOOL_CACHE_ROOT}"');
    expect(source).toContain('secure_path "${INSTALL_DIR}"');
    expect(source).toContain('secure_path "${TERRAFORM_BIN}"');
    expect(source).toContain('install -m 0700 "${DOWNLOAD_DIR}/terraform" "${TERRAFORM_BIN}"');
    expect(source).not.toContain('"${TERRAFORM_BIN}" version');
    expect(source).not.toContain('${TMPDIR:-/tmp}/octogee-toolchain');
  });

  it("rejects a writable cached binary without executing it", () => {
    const home = mkdtempSync(path.join(tmpdir(), "terraform-bin-home-"));
    const platform = spawnSync("uname", ["-s"], { encoding: "utf-8" }).stdout.trim() === "Darwin"
      ? "darwin_amd64"
      : "linux_amd64";
    const installDir = path.join(home, ".cache", "octogee-toolchain", `terraform-1.15.8-${platform}`);
    const executionLog = path.join(home, "executed");

    try {
      mkdirSync(installDir, { recursive: true, mode: 0o700 });
      const cachedBinary = path.join(installDir, "terraform");
      writeFileSync(cachedBinary, `#!/usr/bin/env bash\nprintf executed > "${executionLog}"\nprintf 'Terraform v1.15.8\\n'\n`);
      chmodSync(cachedBinary, 0o777);

      const result = spawnSync("bash", [terraformBin], {
        env: { ...process.env, HOME: home, PATH: "/usr/bin:/bin" },
        encoding: "utf-8",
      });

      expect(result.status).toBe(1);
      expect(result.stderr).toContain("Terraform cache path is not private to the current user");
      expect(() => readFileSync(executionLog, "utf-8")).toThrow();
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
