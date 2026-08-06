import { describe, expect, it } from "vitest";

import {
  createReleaseDigestManifest,
  releaseDigestManifestReference,
  releaseDigestAliasPlan,
  validateReleaseDigestManifest,
} from "../../.github/actions/release-digest-manifest/release-digest-manifest.mjs";

const repository = "us-west1-docker.pkg.dev/octogee/octogee";
const sourceSha = "a".repeat(40);
const releaseSha = sourceSha;
const otherSha = "b".repeat(40);
const digest = (suffix: string) => `sha256:${suffix.repeat(64).slice(0, 64)}`;

function manifest() {
  return createReleaseDigestManifest({
    sourceSha,
    openclawVersion: "2026.7.1",
    repository,
    images: {
      "artifact-worker": digest("1"),
      "gateway-edge": digest("2"),
      "glm-controller": digest("3"),
      "octogee-api": digest("4"),
      "octogee-gateway": digest("5"),
      "octogee-gateway-operator": digest("6"),
      "octogee-ops-agent": digest("7"),
    },
  });
}

describe("release digest manifest", () => {
  it("records the complete immutable platform and gateway digest set under its full source SHA", () => {
    expect(manifest()).toEqual({
      schemaVersion: 1,
      sourceSha,
      openclawVersion: "2026.7.1",
      repository,
      surfaces: {
        gateway: {
          "gateway-edge": digest("2"),
          "octogee-gateway": digest("5"),
          "octogee-gateway-operator": digest("6"),
        },
        platform: {
          "artifact-worker": digest("1"),
          "glm-controller": digest("3"),
          "octogee-api": digest("4"),
          "octogee-ops-agent": digest("7"),
        },
      },
    });
  });

  it("creates release aliases directly from recorded digests, including the gateway OpenClaw tag", () => {
    expect(releaseDigestAliasPlan(manifest(), releaseSha)).toEqual([
      {
        source: `${repository}/artifact-worker@${digest("1")}`,
        target: `${repository}/artifact-worker:aaaaaaa`,
      },
      {
        source: `${repository}/gateway-edge@${digest("2")}`,
        target: `${repository}/gateway-edge:aaaaaaa`,
      },
      {
        source: `${repository}/gateway-edge@${digest("2")}`,
        target: `${repository}/gateway-edge:aaaaaaa-oc2026.7.1`,
      },
      {
        source: `${repository}/glm-controller@${digest("3")}`,
        target: `${repository}/glm-controller:aaaaaaa`,
      },
      {
        source: `${repository}/octogee-api@${digest("4")}`,
        target: `${repository}/octogee-api:aaaaaaa`,
      },
      {
        source: `${repository}/octogee-gateway@${digest("5")}`,
        target: `${repository}/octogee-gateway:aaaaaaa`,
      },
      {
        source: `${repository}/octogee-gateway@${digest("5")}`,
        target: `${repository}/octogee-gateway:aaaaaaa-oc2026.7.1`,
      },
      {
        source: `${repository}/octogee-gateway-operator@${digest("6")}`,
        target: `${repository}/octogee-gateway-operator:aaaaaaa`,
      },
      {
        source: `${repository}/octogee-gateway-operator@${digest("6")}`,
        target: `${repository}/octogee-gateway-operator:aaaaaaa-oc2026.7.1`,
      },
      {
        source: `${repository}/octogee-ops-agent@${digest("7")}`,
        target: `${repository}/octogee-ops-agent:aaaaaaa`,
      },
    ]);
  });

  it("rejects incomplete or non-digest payloads before a manifest can be published", () => {
    expect(() => createReleaseDigestManifest({
      sourceSha,
      openclawVersion: "2026.7.1",
      repository,
      images: {
        "artifact-worker": digest("1"),
        "gateway-edge": digest("2"),
        "glm-controller": digest("3"),
        "octogee-api": digest("4"),
        "octogee-gateway": digest("5"),
        "octogee-gateway-operator": "latest",
        "octogee-ops-agent": digest("7"),
      },
    })).toThrow("octogee-gateway-operator must be an immutable sha256 digest");
  });

  it("rejects a stored manifest that places an image on the wrong release surface", () => {
    const malformed = manifest();
    malformed.surfaces.platform["gateway-edge"] = malformed.surfaces.gateway["gateway-edge"];
    delete malformed.surfaces.gateway["gateway-edge"];

    expect(() => releaseDigestAliasPlan(malformed, releaseSha)).toThrow(
      "manifest gateway surface must contain exactly: gateway-edge, octogee-gateway, octogee-gateway-operator",
    );
  });

  it("rejects a manifest whose source SHA does not match the release being cut", () => {
    expect(() => releaseDigestAliasPlan(manifest(), otherSha)).toThrow(
      "manifest sourceSha does not match the release SHA",
    );
  });

  it("refuses to alias a release manifest from a different repository", () => {
    expect(() => releaseDigestAliasPlan(manifest(), releaseSha, `${repository}-other`)).toThrow(
      "manifest repository does not match the expected repository",
    );
  });

  it("validates a carried-forward manifest against the exact baseline SHA and repository", () => {
    expect(validateReleaseDigestManifest(manifest(), sourceSha, repository)).toEqual(manifest());
    expect(() => validateReleaseDigestManifest(manifest(), otherSha, repository)).toThrow(
      "manifest sourceSha does not match the expected SHA",
    );
    expect(() => validateReleaseDigestManifest(manifest(), sourceSha, `${repository}-other`)).toThrow(
      "manifest repository does not match the expected repository",
    );
  });

  it("pins a manifest consumer to an immutable OCI digest rather than its mutable SHA tag", () => {
    expect(releaseDigestManifestReference(repository, digest("8"))).toBe(
      `${repository}/release-digest-manifest@${digest("8")}`,
    );
    expect(() => releaseDigestManifestReference(repository, "latest")).toThrow(
      "release-digest-manifest must be an immutable sha256 digest",
    );
  });
});
