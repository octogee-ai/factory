import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";

const repoRoot = path.resolve("..");

function readRepoFile(filePath: string): string {
  return fs.readFileSync(path.join(repoRoot, filePath), "utf8");
}

function installedAptPackages(filePath: string): Set<string> {
  const packages = new Set<string>();
  const installCommand = "apt-get install -y --no-install-recommends";
  let collecting = false;

  for (const rawLine of readRepoFile(filePath).split("\n")) {
    let line = rawLine;

    if (line.includes(installCommand)) {
      collecting = true;
      line = line.slice(line.indexOf(installCommand) + installCommand.length);
    }

    if (!collecting) {
      continue;
    }

    const reachedCleanup = line.includes("rm -rf /var/lib/apt/lists");
    const packageSegment = line
      .split("rm -rf /var/lib/apt/lists")[0]
      .split("#")[0]
      .replace(/\\/g, " ");

    for (const token of packageSegment.split(/\s+/)) {
      if (/^[a-z0-9][a-z0-9+.-]*$/i.test(token)) {
        packages.add(token);
      }
    }

    if (reachedCleanup) {
      collecting = false;
    }
  }

  return packages;
}

function advertisedGatewayBasePackages(): string[] {
  const match = readRepoFile("infra/gateway/Dockerfile").match(/All apt packages \(([^)]+)\)/);
  if (!match) {
    throw new Error("infra/gateway/Dockerfile does not advertise base apt packages");
  }
  return match[1]
    .split(",")
    .map((packageName) => packageName.trim())
    .filter((packageName) => packageName !== "etc.");
}

describe("gateway base image", () => {
  it("pins gitleaks in gateway-edge for fail-closed agent import scanning", () => {
    const dockerfile = readRepoFile("gateway-edge/Dockerfile");
    expect(dockerfile).toContain("ARG GITLEAKS_VERSION=8.30.1");
    expect(dockerfile).toContain("github.com/zricethezav/gitleaks/v8@v${GITLEAKS_VERSION}");
    expect(dockerfile).toContain('test "$(/go/bin/gitleaks version)" = "${GITLEAKS_VERSION}"');
    expect(dockerfile).toContain("COPY --from=gitleaks-builder /go/bin/gitleaks /usr/local/bin/gitleaks");
  });

  it("ships Chromium and screenshot fonts in the shared gateway base image", () => {
    const installed = installedAptPackages("infra/gateway/Dockerfile.base");
    const advertised = advertisedGatewayBasePackages();

    expect(installed.has("chromium")).toBe(true);
    expect(installed.has("fonts-liberation")).toBe(true);
    expect(installed.has("fonts-noto-color-emoji")).toBe(true);
    expect([...installed].sort()).toEqual(expect.arrayContaining(advertised));
  });

  it("keeps Chromium in the operator gateway base image", () => {
    const installed = installedAptPackages("infra/gateway/Dockerfile.operator-base");

    expect(installed.has("chromium")).toBe(true);
  });

  it("ships discovery binaries and disables runtime tool downloads", () => {
    const installed = installedAptPackages("infra/gateway/Dockerfile.base");
    const baseDockerfile = readRepoFile("infra/gateway/Dockerfile.base");
    const dockerfile = readRepoFile("infra/gateway/Dockerfile");

    expect(installed.has("ripgrep")).toBe(true);
    expect(installed.has("fd-find")).toBe(false);
    expect(baseDockerfile).toContain("ARG FD_VERSION=10.3.0");
    expect(baseDockerfile).toContain(
      "f4be8742f936e4ef0e10016b661e4c1cd49e482e388080aa28c05d02f0559509",
    );
    expect(baseDockerfile).toContain(
      'echo "${FD_SHA256}  /tmp/fd.deb" | sha256sum -c -',
    );
    expect(dockerfile).toContain("ENV OPENCLAW_OFFLINE=1");
  });

  it("upgrades the shipped npm only after OpenClaw stages its plugins", () => {
    const dockerfile = readRepoFile("infra/gateway/Dockerfile.base");
    const pluginInstall = dockerfile.indexOf("openclaw plugins install");
    const npmUpgrade = dockerfile.indexOf("npm install --global npm@${NPM_VERSION}");

    expect(pluginInstall).toBeGreaterThan(-1);
    expect(npmUpgrade).toBeGreaterThan(pluginInstall);
  });

  it("binds Codex to the installed OpenClaw core version before staging it", () => {
    const dockerfile = readRepoFile("infra/gateway/Dockerfile.base");

    expect(dockerfile).toContain('OPENCLAW_CORE_VERSION="$(node -e');
    expect(dockerfile).toContain('"$OPENCLAW_ROOT/package.json"');
    expect(dockerfile).toContain(
      'test "$OPENCLAW_CORE_VERSION" = "$OPENCLAW_COMPATIBILITY_HOST_VERSION"',
    );
    expect(dockerfile).toContain('if [ -f "$OC_VENDOR/openclaw-codex.tgz" ]; then');
    expect(dockerfile).toContain('CODEX_REPACK="$(mktemp -d)"');
    expect(dockerfile).toContain('pkg.name !== "@openclaw/codex"');
    expect(dockerfile).toContain('pkg.version = version');
    expect(dockerfile).toContain(
      '"$CODEX_REPACK/package/package.json" "$OPENCLAW_CORE_VERSION"',
    );
    expect(dockerfile).toContain('openclaw plugins install "npm-pack:$VENDORED_CODEX" --force');
    expect(dockerfile).toContain(
      'openclaw plugins install "@openclaw/codex@${OPENCLAW_CORE_VERSION}"',
    );
    expect(dockerfile).toContain('INSTALLED_CODEX="$(node -e');
    expect(dockerfile).toContain('test "$INSTALLED_CODEX" = "$OPENCLAW_CORE_VERSION"');
    expect(dockerfile).not.toContain(
      '"$CODEX_REPACK/package/package.json" "$OPENCLAW_VERSION"',
    );
  });

  it("proves the final Builder image keeps Codex bound to its installed core", () => {
    for (const filePath of [
      "cloudbuild-operator-final.yaml",
      "cloudbuild-operator-final-extra.yaml",
    ]) {
      const cloudbuild = readRepoFile(filePath);

      expect(cloudbuild).toContain(
        'OPENCLAW_CORE_PACKAGE="$$(npm root -g)/openclaw/package.json"',
      );
      expect(cloudbuild).toContain(
        'CODEX_PACKAGE="$$(find /opt/openclaw-codex-deps/npm -type f -path "*/node_modules/@openclaw/codex/package.json" -print -quit)"',
      );
      expect(cloudbuild).toContain(
        'test "$$INSTALLED_CODEX" = "$$INSTALLED_OPENCLAW_CORE"',
      );
    }
  });
});
