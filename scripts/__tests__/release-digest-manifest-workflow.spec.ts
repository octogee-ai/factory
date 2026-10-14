import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const writer = readFileSync(resolve(import.meta.dirname, "../../scripts/ci/publish-manifest.sh"), "utf8");

describe("Build main digest manifest", () => {
  it("authors manifests only from full-SHA provenance tags", () => {
    expect(writer).toContain('ref = f"{os.environ[\'AR_REPO\']}/{image}:{os.environ[\'SOURCE_SHA\']}"');
    expect(writer).not.toContain("SOURCE_SHA'][:7]");

  });

  it("serializes the writer by source SHA and gives downstream consumers a verified OCI digest pin", () => {
    expect(writer).toContain("manifest_digest=");
    expect(writer).toContain("release-digest-manifest@${manifest_digest}");
    expect(writer).toContain("after writing immutable manifest");
    expect(writer).toContain("already contains a different immutable manifest");
  });

  it("supplies an inert command when creating containers from scratch manifest images", () => {
    const containerCreates = writer.match(/docker create [^\n]+/g) ?? [];

    expect(containerCreates).toHaveLength(1);
    for (const create of containerCreates) {
      expect(create).toContain("/bin/true");
    }
  });

  it("reads the baseline manifest as a lookup table instead of schema-gating it", () => {
    expect(writer).not.toContain("release-digest-manifest.mjs validate");
    expect(writer).toContain('prior.get("surfaces"');
    expect(writer).toContain("confirmed absent baseline manifest");
    expect(writer).toContain("could not read baseline digest manifest");
  });

  it("allows the first v2 build to read a v1 baseline without carrying forward an absent runner", () => {
    expect(writer).toContain('"octogee-api", "octogee-project-runner"');
    expect(writer).toContain('"baselineImages": baseline');
  });

  it("carries a main image digest forward only after its exact SHA tag is confirmed absent", () => {
    expect(writer).toContain("resolve-tag-digest.sh");
    expect(writer).toContain("if result.returncode == 3:");
    expect(writer).toContain("could not resolve SHA-addressed image");
  });

  it("uses structured tag lookup for absence and never parses gcloud error prose", () => {
    expect(writer).toContain("resolve-tag-digest.sh");
    expect(writer).not.toContain("NOT_FOUND");
    expect(writer).not.toContain("[[:space:]]404[[:space:]:]");
    expect(writer).toContain('if [ "$lookup_status" = "3" ]; then');
  });
});
