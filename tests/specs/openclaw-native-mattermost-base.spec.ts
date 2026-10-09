import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const repoRoot = path.resolve(__dirname, "../..");
const read = (relativePath: string) =>
  readFileSync(path.join(repoRoot, relativePath), "utf8");

describe("native Mattermost base image", () => {
  it("installs the pinned Mattermost artifact directly in preview builds", () => {
    const previewBuild = read("cloudbuild-base-beta.yaml");

    expect(previewBuild).toContain(
      'echo "${_OPENCLAW_ROOT_SHA256}  infra/gateway/openclaw-tarball/openclaw-fork.tgz" | sha256sum -c -',
    );
    expect(previewBuild).toContain('id: "fetch-mattermost-release"');
    expect(previewBuild).toContain(
      'echo "${_OPENCLAW_MATTERMOST_SHA256}  infra/gateway/openclaw-tarball/openclaw-mattermost-fork.tgz" | sha256sum -c -',
    );
    expect(previewBuild).toContain(
      '[ "${_OPENCLAW_MATTERMOST_FORK_SHA}" = "$$(printf \'%.8s\' "${_OPENCLAW_MATTERMOST_SHA256}")" ]',
    );
    expect(previewBuild).toContain(
      'EXPECTED_MATTERMOST_IDENTITY="@openclaw/mattermost|${_OPENCLAW_COMPATIBILITY_HOST_VERSION}|https://github.com/openclaw/openclaw"',
    );
    expect(previewBuild).not.toContain("octogeeSourceCommit");
    expect(previewBuild).toContain("-f=infra/gateway/Dockerfile.base");
    expect(previewBuild).not.toContain("Dockerfile.base-candidate");
    expect(previewBuild).not.toContain("openclaw-mattermost-candidate.tgz");
  });

  it("resolves current rebuilds through the same immutable artifact key", () => {
    const rebuild = read("scripts/rebuild-matrix-bases.sh");
    const matrix = parse(read("infra/gateway/oc-build-matrix.yaml")) as {
      bases: unknown[];
    };

    expect(matrix.bases).toEqual([
      { config: "cloudbuild-base.yaml", label: "current" },
    ]);
    expect(rebuild).toContain("infra/gateway/openclaw-tarball/current.json");
    expect(rebuild).toContain("gcloud storage objects describe");
    expect(rebuild).toContain(
      ".github/actions/openclaw-base-key/base-key.mjs github-output",
    );
    expect(rebuild).toContain(
      "infra/gateway/Dockerfile.base \\\n      infra/gateway/install-cua-driver-patch.mjs \\\n      infra/gateway/cua-desktop-discovery.patch \\\n      infra/gateway/verify-codex-native-hook-runtime.mjs \\\n      infra/gateway/verify-codex-source-match.mjs \\\n      infra/gateway/verify-parallel-source-match.mjs \\\n      cloudbuild-base.yaml",
    );
    expect(rebuild).toContain(
      "_BASE_TAG=${CURRENT_BASE_TAG},_OPENCLAW_FORK_OBJECT=${CURRENT_OPENCLAW_OBJECT},_OPENCLAW_FORK_GENERATION=${CURRENT_OPENCLAW_GENERATION},_OPENCLAW_MATTERMOST_OBJECT=${CURRENT_MATTERMOST_OBJECT},_OPENCLAW_MATTERMOST_GENERATION=${CURRENT_MATTERMOST_GENERATION}",
    );
    expect(rebuild).toContain(
      "--force cannot overwrite a content-addressed current base",
    );
  });

  it("has no legacy verifier for patched Activity gateway methods", () => {
    expect(existsSync(path.join(repoRoot, "infra/gateway/Dockerfile.base-candidate"))).toBe(false);
    expect(
      existsSync(
        path.join(
          repoRoot,
          "infra/gateway/openclaw-candidates/verify-mattermost-install.mjs",
        ),
      ),
    ).toBe(false);
  });
});
