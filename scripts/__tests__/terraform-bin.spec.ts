import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

const terraformBin = path.resolve(__dirname, "../ops/terraform-bin.sh");

const PLATFORM_BY_HOST: Record<string, string> = {
  "Darwin-arm64": "darwin_arm64",
  "Darwin-x86_64": "darwin_amd64",
  "Linux-x86_64": "linux_amd64",
  "Linux-aarch64": "linux_arm64",
};

function hostPlatform(): string {
  const uname = (flag: string) => spawnSync("uname", [flag], { encoding: "utf-8" }).stdout.trim();
  const host = `${uname("-s")}-${uname("-m")}`;
  const platform = PLATFORM_BY_HOST[host];
  if (!platform) {
    throw new Error(`Unsupported Terraform platform: ${host}`);
  }
  return platform;
}

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

  it("resolves the cache platform from the same host table the resolver uses", () => {
    const source = readFileSync(terraformBin, "utf-8");

    expect(source).toContain('INSTALL_DIR="${TOOL_CACHE_ROOT}/terraform-${TERRAFORM_VERSION}-${PLATFORM}"');
    expect(source).toContain('case "$(uname -s)-$(uname -m)" in');
    for (const [host, platform] of Object.entries(PLATFORM_BY_HOST)) {
      expect(source).toContain(`  ${host})`);
      expect(source).toContain(`PLATFORM="${platform}"`);
    }
  });

  it("rejects a writable cached binary without executing it or downloading a replacement", () => {
    const platform = hostPlatform();
    const home = mkdtempSync(path.join(tmpdir(), "terraform-bin-home-"));
    const cacheRoot = path.join(home, ".cache");
    const installDir = path.join(cacheRoot, "octogee-toolchain", `terraform-1.16.2-${platform}`);
    const stubBin = path.join(home, "stub-bin");
    const executionLog = path.join(home, "executed");
    const downloadLog = path.join(home, "downloaded");

    try {
      mkdirSync(installDir, { recursive: true, mode: 0o700 });
      mkdirSync(stubBin, { mode: 0o700 });
      writeFileSync(
        path.join(stubBin, "curl"),
        `#!/usr/bin/env bash\nprintf attempted > "${downloadLog}"\nexit 1\n`,
        { mode: 0o755 },
      );

      const cachedBinary = path.join(installDir, "terraform");
      writeFileSync(cachedBinary, `#!/usr/bin/env bash\nprintf executed > "${executionLog}"\nprintf 'Terraform v1.16.2\\n'\n`);
      chmodSync(cachedBinary, 0o777);

      const result = spawnSync("bash", [terraformBin], {
        env: {
          ...process.env,
          HOME: home,
          XDG_CACHE_HOME: cacheRoot,
          PATH: `${stubBin}:/usr/bin:/bin`,
        },
        encoding: "utf-8",
      });

      expect(result.status).toBe(1);
      expect(result.stderr).toContain("Terraform cache path is not private to the current user");
      expect(existsSync(executionLog)).toBe(false);
      expect(existsSync(downloadLog)).toBe(false);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
