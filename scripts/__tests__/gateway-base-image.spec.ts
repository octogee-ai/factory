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

function runInstructionContaining(dockerfile: string, needle: string): string {
  const instruction = dockerfile
    .split(/\n(?=[A-Z]+\s)/u)
    .find((block) => block.startsWith("RUN ") && block.includes(needle));
  if (!instruction) throw new Error(`missing RUN instruction containing ${needle}`);
  return instruction;
}

describe("gateway base image", () => {
  it("layers the controlled workstation over the full bootable gateway base", () => {
    const base = readRepoFile("infra/gateway/Dockerfile.base");
    const builderBase = readRepoFile("infra/gateway/Dockerfile.builder-base");
    const builderConfig = readRepoFile("infra/gateway/openclaw.builder.template.json");

    expect(base).toContain("FROM node:26-bookworm-slim AS gateway-core-system");
    expect(base).toContain("FROM gateway-core-system AS gateway-core-runtime");
    expect(builderBase).toContain("ARG GATEWAY_BASE_IMAGE");
    expect(builderBase).toContain("FROM ${GATEWAY_BASE_IMAGE}");
    expect(builderBase).toContain("infra/gateway/builder-toolchain/package.json /octogee/toolchain/package.json");
    expect(builderBase).toContain("infra/gateway/builder-toolchain/package-lock.json /octogee/toolchain/package-lock.json");
    expect(builderBase).toContain("infra/gateway/builder-toolchain/groups.json /octogee/toolchain/groups.json");
    expect(builderBase).toContain("OCTOGEE_BUILDER_TOOLCHAIN_LOCK_SHA256");
    expect(builderBase).toContain("OCTOGEE_BUILDER_TOOL_GROUPS_SHA256");
    expect(builderBase).toContain("DEBIAN_PACKAGES=");
    expect(builderBase).toContain("standaloneTools.gcloud.version");
    expect(builderBase).toContain("pip3 install --break-system-packages --no-cache-dir");
    expect(builderConfig).not.toContain('"codex": {');
    expect(builderConfig).not.toContain('"browser": {\n    "enabled": true');
  });

  it("keeps post-readiness hydration npm-only", () => {
    const hydrator = readRepoFile("scripts/lib/builder-toolchain-hydrator.ts");
    const builderBase = readRepoFile("infra/gateway/Dockerfile.builder-base");

    expect(hydrator).toContain('"ci",');
    expect(hydrator).toContain("--prefer-offline");
    expect(hydrator).not.toContain("apt-get");
    expect(hydrator).not.toContain("dpkg-deb");
    expect(hydrator).not.toContain("/usr/bin/curl");
    expect(builderBase).toContain("apt-get install -y --no-install-recommends $DEBIAN_PACKAGES");
    expect(builderBase).toContain("google-cloud-cli-${GCLOUD_VERSION}-linux-x86_64.tar.gz");
  });

  it("pins the post-readiness Builder tools and their npm integrity", () => {
    const packageJson = JSON.parse(
      readRepoFile("infra/gateway/builder-toolchain/package.json"),
    ) as {
      dependencies: Record<string, string>;
      allowScripts: Record<string, boolean>;
    };
    const packageLock = JSON.parse(
      readRepoFile("infra/gateway/builder-toolchain/package-lock.json"),
    ) as { packages: Record<string, { version?: string; integrity?: string }> };

    expect(packageJson.dependencies).toEqual({
      "@anthropic-ai/claude-code": "2.1.257",
      "@openai/codex": "0.152.0",
      "@sparticuz/chromium": "149.0.0",
      "firebase-tools": "15.28.2",
      "npm-check-updates": "23.1.0",
      "pnpm": "12.2.1",
      "tsx": "4.23.13",
      "typescript": "7.0.2",
    });
    expect(packageJson.allowScripts).toEqual({
      "@anthropic-ai/claude-code@2.1.257": true,
      "esbuild@0.28.2": true,
      "pnpm@12.2.1": true,
      "protobufjs@7.6.6": true,
      "re2@1.26.1": true,
    });
    expect(packageLock.packages["node_modules/@anthropic-ai/claude-code"]).toMatchObject({
      version: "2.1.257",
      integrity: expect.stringMatching(/^sha512-/),
    });
    expect(packageLock.packages["node_modules/@openai/codex"]).toMatchObject({
      version: "0.152.0",
      integrity: expect.stringMatching(/^sha512-/),
    });
    expect(packageLock.packages["node_modules/@sparticuz/chromium"]).toMatchObject({
      version: "149.0.0",
      integrity: expect.stringMatching(/^sha512-/),
    });
    for (const packageName of [
      "firebase-tools", "npm-check-updates", "pnpm", "tsx", "typescript",
    ]) {
      expect(packageLock.packages[`node_modules/${packageName}`]).toMatchObject({
        version: packageJson.dependencies[packageName],
        integrity: expect.stringMatching(/^sha512-/),
      });
    }

    const builderBase = readRepoFile("infra/gateway/Dockerfile.builder-base");
    expect(builderBase).toContain("npm ci --omit=dev --include=optional");
    expect(builderBase).toContain("node_modules/.bin/claude --version");
    expect(builderBase).toContain("node_modules/.bin/codex --version");
    expect(builderBase).toContain("node_modules/@sparticuz/chromium/bin/chromium.br");
    expect(builderBase).toContain("node_modules/.bin/firebase --version");
    expect(builderBase).toContain("node_modules/.bin/pnpm --version");
    expect(builderBase).toContain("unexpected Anthropic platform payload");
    expect(builderBase).toContain("unexpected OpenAI platform payload");
  });

  it("keeps the OpenClaw launcher rooted beside its imported package files", () => {
    const base = readRepoFile("infra/gateway/Dockerfile.base");

    expect(base).not.toContain(
      "COPY --from=openclaw-installer /usr/local/bin/openclaw /usr/local/bin/openclaw",
    );
    expect(base.match(/ln -s \.\.\/lib\/node_modules\/openclaw\/openclaw\.mjs \/usr\/local\/bin\/openclaw/g))
      .toHaveLength(2);
    expect(base.match(/require\('\/usr\/local\/lib\/node_modules\/openclaw\/package\.json'\)\.bin\.openclaw/g))
      .toHaveLength(2);
  });

  it("keys the immutable Builder base on the exact npm lock", () => {
    const workflow = readRepoFile(".github/workflows/gateway-build-operator-base.yml");
    const cloudbuild = readRepoFile("cloudbuild-builder-base.yaml");

    expect(workflow.match(/infra\/gateway\/builder-toolchain\/package-lock\.json/g))
      .toHaveLength(2);
    expect(workflow.match(/infra\/gateway\/builder-toolchain\/groups\.json/g))
      .toHaveLength(2);
    expect(workflow).toContain("BUILDER_BASE_INPUT_HASH=$(sha256sum");
    expect(cloudbuild).toContain(
      "TOOLCHAIN_LOCK_SHA256=\"$$(sha256sum infra/gateway/builder-toolchain/package-lock.json",
    );
    expect(cloudbuild).toContain("--build-arg=BUILDER_TOOLCHAIN_LOCK_SHA256=$$TOOLCHAIN_LOCK_SHA256");
    expect(cloudbuild).toContain("--build-arg=BUILDER_TOOL_GROUPS_SHA256=$$TOOL_GROUPS_SHA256");
  });

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
    expect(baseDockerfile).toContain("ARG FD_VERSION=10.5.0");
    expect(baseDockerfile).toContain(
      "1fca9f8fb221f26fe37b425db4935dc8180099bdecfd8e031538bfc9396e95f8",
    );
    expect(baseDockerfile).toContain(
      'echo "${FD_SHA256}  /tmp/fd.deb" | sha256sum -c -',
    );
    expect(dockerfile).toContain("ENV OPENCLAW_OFFLINE=1");
    expect(dockerfile).toContain("/usr/local/libexec/octogee-builder-toolchain");
    expect(dockerfile).toContain("ENV CLAUDE_BIN=/usr/local/bin/claude");
    expect(dockerfile).not.toMatch(/npm install[^\n]*@anthropic-ai\/claude-code/);
  });

  it("leaves preinstalled Claude and Codex binaries intact for the standard image", () => {
    const dockerfile = readRepoFile("infra/gateway/Dockerfile");
    const standardBuild = readRepoFile("cloudbuild.yaml");
    const wrapperInstruction = runInstructionContaining(
      dockerfile,
      "ENABLE_BUILDER_TOOLCHAIN_WRAPPER",
    );
    const disabledArm = wrapperInstruction.match(/false\)([\s\S]*?);;/u)?.[1];

    expect(dockerfile).toContain("ARG ENABLE_BUILDER_TOOLCHAIN_WRAPPER=false");
    expect(standardBuild).not.toContain(
      "--build-arg=ENABLE_BUILDER_TOOLCHAIN_WRAPPER=true",
    );
    expect(disabledArm).toContain("test -x /usr/local/bin/claude");
    expect(disabledArm).toContain("test -x /usr/local/bin/codex");
    expect(disabledArm).not.toContain("rm -f");
    expect(disabledArm).not.toContain("ln -s");
  });

  it("keeps boot-critical tools preinstalled in Builder final builds", () => {
    const dockerfile = readRepoFile("infra/gateway/Dockerfile");
    const wrapperInstruction = runInstructionContaining(
      dockerfile,
      "ENABLE_BUILDER_TOOLCHAIN_WRAPPER",
    );
    const enabledArm = wrapperInstruction.match(/true\)([\s\S]*?);;/u)?.[1];

    for (const filePath of [
      "cloudbuild-operator-final.yaml",
      "cloudbuild-operator-final-extra.yaml",
    ]) {
      expect(readRepoFile(filePath)).not.toContain(
        "--build-arg=ENABLE_BUILDER_TOOLCHAIN_WRAPPER=true",
      );
    }
    expect(enabledArm).toContain(
      "rm -f /usr/local/bin/claude /usr/local/bin/codex /usr/bin/chromium",
    );
    expect(enabledArm).toContain(
      "ln -s /usr/local/libexec/octogee-builder-toolchain /usr/local/bin/claude",
    );
    expect(enabledArm).toContain(
      "ln -s /usr/local/libexec/octogee-builder-toolchain /usr/local/bin/codex",
    );
    expect(enabledArm).toContain(
      "ln -s /usr/local/libexec/octogee-builder-toolchain /usr/bin/chromium",
    );
  });

  it("pins the npm runtime shared by core boot and post-readiness hydration", () => {
    const dockerfile = readRepoFile("infra/gateway/Dockerfile.base");
    const npmUpgrade = dockerfile.indexOf("npm install --global npm@${NPM_VERSION}");

    expect(npmUpgrade).toBeGreaterThan(dockerfile.indexOf("AS gateway-core-system"));
    expect(npmUpgrade).toBeLessThan(dockerfile.indexOf("AS gateway-system"));
    expect(runInstructionContaining(dockerfile, "npm@${NPM_VERSION}"))
      .toContain("npm cache clean --force");
  });

  it("copies only staged OpenClaw runtime outputs into the shipped stage", () => {
    const dockerfile = readRepoFile("infra/gateway/Dockerfile.base");
    const cloudbuild = readRepoFile("cloudbuild-base.yaml");
    const runtimeStage = dockerfile.slice(dockerfile.indexOf("FROM gateway-system AS gateway-runtime"));

    expect(dockerfile).toContain("FROM gateway-core-system AS openclaw-installer");
    expect(runtimeStage).toContain(
      "COPY --from=openclaw-installer /usr/local/lib/node_modules/openclaw",
    );
    expect(runtimeStage).toContain(
      "COPY --from=openclaw-core-plugin-installer /usr/local/lib/node_modules/openclaw/dist/extensions/mattermost",
    );
    expect(runtimeStage).toContain(
      "COPY --from=openclaw-full-plugin-installer --chown=node:node /opt/openclaw-runtime-deps",
    );
    expect(runtimeStage).not.toContain("openclaw-tarball/");
    expect(runtimeStage).not.toContain("/home/node/.openclaw");
    expect(cloudbuild).toContain('test -d /opt/openclaw-runtime-deps/npm');
    expect(cloudbuild).toContain('openclaw/dist/extensions/mattermost/package.json');
    expect(cloudbuild).toContain('node_modules/@openclaw/parallel-plugin');
    expect(cloudbuild).toContain('node_modules/@openclaw/codex');
  });

  it("does not retain package-manager caches in runtime install layers", () => {
    const dockerfile = readRepoFile("infra/gateway/Dockerfile.base");

    expect(
      runInstructionContaining(dockerfile, "@anthropic-ai/claude-code"),
    ).toContain("npm cache clean --force");
    expect(
      runInstructionContaining(dockerfile, "npm@${NPM_VERSION}"),
    ).toContain("npm cache clean --force");
    expect(runInstructionContaining(dockerfile, "pip3 install")).toContain("--no-cache-dir");
  });

  it("copies pruned gateway runtime trees out of the build stage", () => {
    const dockerfile = readRepoFile("infra/gateway/Dockerfile");
    const runtimeStageMarker = "FROM ${OPENCLAW_BASE_IMAGE} AS gateway-runtime";
    const runtimeStage = dockerfile.slice(dockerfile.indexOf(runtimeStageMarker));
    const runtimeInstructions = runtimeStage
      .split("\n")
      .filter((line) => !line.trimStart().startsWith("#"))
      .join("\n");

    expect(dockerfile).toContain("FROM ${OPENCLAW_BASE_IMAGE} AS gateway-build");
    expect(runtimeStage).toContain("COPY --from=gateway-build --chown=node:node /octogee/scripts");
    expect(runtimeStage).toContain("COPY --from=gateway-build --chown=node:node /octogee/shared");
    expect(runtimeStage).toContain("COPY --from=gateway-build --chown=node:node /octogee/extensions");
    expect(runtimeInstructions).not.toMatch(/npm (?:ci|install|prune)/u);
    expect(runtimeStage).not.toContain("chown -R node:node /octogee/extensions");
  });

  it("gates each final image on its required OpenClaw runtime plugin set", () => {
    const dockerfile = readRepoFile("infra/gateway/Dockerfile");
    const standardBuild = readRepoFile("cloudbuild.yaml");
    const builderBuild = readRepoFile("cloudbuild-operator-final.yaml");
    const extraBuilderBuild = readRepoFile("cloudbuild-operator-final-extra.yaml");

    expect(dockerfile).toContain(
      "COPY infra/gateway/verify-openclaw-runtime-deps.sh /usr/local/bin/verify-openclaw-runtime-deps",
    );
    expect(dockerfile).toContain(
      '/usr/local/bin/verify-openclaw-runtime-deps "$OPENCLAW_RUNTIME_PLUGINS"',
    );
    expect(standardBuild).toContain(
      "--build-arg=OPENCLAW_RUNTIME_PLUGINS=mattermost,parallel-plugin,codex",
    );
    for (const build of [builderBuild, extraBuilderBuild]) {
      expect(build).toContain(
        "--build-arg=OPENCLAW_RUNTIME_PLUGINS=mattermost,parallel-plugin,codex",
      );
    }
  });

  it("uses the installed OpenClaw core version when staging Codex", () => {
    const dockerfile = readRepoFile("infra/gateway/Dockerfile.base");

    expect(dockerfile).toContain('OPENCLAW_CORE_VERSION="$(node -e');
    expect(dockerfile).toContain('"$OPENCLAW_ROOT/package.json"');
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
    expect(dockerfile).not.toContain("OPENCLAW_COMPATIBILITY_HOST_VERSION");
  });

  it("proves the final Builder image retains its boot-critical payloads", () => {
    const cloudbuild = readRepoFile("cloudbuild-operator-final.yaml");
    const dockerfile = readRepoFile("infra/gateway/Dockerfile");
    const gate = readRepoFile("infra/gateway/verify-runtime-image.sh");

    expect(cloudbuild).toContain("--build-arg=IMAGE_PROFILE=builder");
    expect(dockerfile).toContain('RUN /usr/local/bin/verify-runtime-image "$IMAGE_PROFILE"');
    expect(gate).toContain("staged_plugin \"$plugin\" || fail \"@openclaw/$plugin is absent");
    expect(gate).toContain("for plugin in parallel-plugin codex; do");
    expect(gate).toContain("! staged_plugin mattermost");
    expect(gate).toContain('"$global_root/@anthropic-ai/claude-code"');
    expect(gate).toContain('"$global_root/@openai/codex"');
    expect(gate).toContain('test -x "$tool_bin/claude"');
    expect(gate).toContain('test -x "$tool_bin/codex"');
    expect(gate).toContain('test -x "$chromium_bin"');
    expect(gate).toContain('test ! -e "$global_root/@sparticuz/chromium"');
    expect(gate).toContain("OCTOGEE_BUILDER_TOOLCHAIN_LOCK_SHA256");
    expect(gate).toContain("OCTOGEE_BUILDER_TOOL_GROUPS_SHA256");

    const extraCloudbuild = readRepoFile("cloudbuild-operator-final-extra.yaml");
    expect(extraCloudbuild).toContain(
      'find /opt/openclaw-runtime-deps/npm -type d -path "*/node_modules/@openclaw/codex"',
    );
    expect(extraCloudbuild).not.toContain(
      '! find /opt/openclaw-runtime-deps/npm -type d -path "*/node_modules/@openclaw/codex"',
    );
    expect(extraCloudbuild).toContain('test -e "$$(npm root -g)/@anthropic-ai/claude-code"');
    expect(extraCloudbuild).toContain('test -e "$$(npm root -g)/@openai/codex"');
    expect(extraCloudbuild).toContain("test -x /usr/local/bin/claude");
    expect(extraCloudbuild).toContain("test -x /usr/local/bin/codex");
    expect(extraCloudbuild).toContain("test -x /usr/bin/chromium");
    expect(extraCloudbuild).toContain('test ! -e "$$(npm root -g)/@sparticuz/chromium"');
    expect(extraCloudbuild).toContain("OCTOGEE_BUILDER_TOOLCHAIN_LOCK_SHA256");
    expect(extraCloudbuild).toContain("OCTOGEE_BUILDER_TOOL_GROUPS_SHA256");
  });

  it("validates the extra Builder candidate against the current Mattermost schema", () => {
    const cloudbuild = readRepoFile("cloudbuild-operator-final-extra.yaml");

    expect(cloudbuild).toContain(
      String.raw`\"replyToModeByChatType\":{\"direct\":\"all\"}`,
    );
    expect(cloudbuild).not.toContain("threadSessionScope");
    expect(cloudbuild).toContain("openclaw config validate");
  });
});
