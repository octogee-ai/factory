import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = path.resolve(__dirname, "../..");
const read = (relativePath: string) =>
  readFileSync(path.join(repoRoot, relativePath), "utf8");

describe("native Mattermost base image", () => {
  it("installs the pinned Mattermost artifact directly in preview builds", () => {
    const previewBuild = read("cloudbuild-base-beta.yaml");
    const rebuildMatrix = read("scripts/rebuild-matrix-bases.sh");

    expect(previewBuild).toContain('id: "fetch-mattermost-release"');
    expect(previewBuild).toContain(
      'echo "${_OPENCLAW_MATTERMOST_SHA256}  infra/gateway/openclaw-tarball/openclaw-mattermost-fork.tgz" | sha256sum -c -',
    );
    expect(previewBuild).toContain("-f=infra/gateway/Dockerfile.base");
    expect(previewBuild).not.toContain("Dockerfile.base-candidate");
    expect(previewBuild).not.toContain("openclaw-mattermost-candidate.tgz");
    expect(rebuildMatrix).toContain(
      'if not re.fullmatch(r"[0-9a-f]{8}", mattermost_fork):',
    );
    expect(rebuildMatrix).toContain(
      'SUBSTITUTIONS+=",_OPENCLAW_MATTERMOST_FORK_SHA=${MATTERMOST_FORK}"',
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
