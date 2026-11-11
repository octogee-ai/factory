import { describe, expect, it } from "vitest";

import {
  createReleaseDigestManifest,
  createMainBuildReleaseDigestManifest,
  selectMainBuildImages,
  releaseDigestManifestReference,
  validateBaselineReleaseDigestManifest,
  validateReleaseDigestManifest,
} from "../../.github/actions/release-digest-manifest/release-digest-manifest.mjs";

const repository = "us-west1-docker.pkg.dev/octogee/octogee";
const sourceSha = "a".repeat(40);
const otherSha = "b".repeat(40);
const openclawSourceSha = "c".repeat(40);
const digest = (suffix: string) => `sha256:${suffix.repeat(64).slice(0, 64)}`;

function manifest() {
  return createReleaseDigestManifest({
    sourceSha,
    openclawVersion: "2026.7.1",
    openclawSourceSha,
    repository,
    images: {
      "artifact-worker": digest("1"),
      "gateway-edge": digest("2"),
      "glm-controller": digest("3"),
      "octogee-api": digest("4"),
      "octogee-gateway": digest("5"),
      "octogee-gateway-builder": digest("6"),
      "octogee-ops-agent": digest("7"),
      "octogee-project-runner": digest("8"),
    },
  });
}

function legacyManifest() {
  return {
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
  };
}

function preUserManifest() {
  return {
    schemaVersion: 2,
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
        "octogee-project-runner": digest("8"),
      },
    },
  };
}

describe("release digest manifest", () => {
  it("refuses baseline digests for a changed scope when its exact-SHA build output is absent", () => {
    expect(() => selectMainBuildImages({
      baselineImages: {
        ...manifest().surfaces.gateway,
        ...manifest().surfaces.platform,
      },
      exactImages: {},
      changedScopes: { platform: true, gateway: false },
    })).toThrow("missing exact-SHA image for changed platform scope: artifact-worker");
  });

  it("carries baseline digests only for an unchanged scope", () => {
    const baseline = manifest();

    expect(selectMainBuildImages({
      baselineImages: {
        ...baseline.surfaces.gateway,
        ...baseline.surfaces.platform,
      },
      exactImages: baseline.surfaces.platform,
      changedScopes: { platform: true, gateway: false },
    })).toEqual({
      ...baseline.surfaces.gateway,
      ...baseline.surfaces.platform,
    });
  });

  it("records the complete immutable platform and gateway digest set under its full source SHA", () => {
    expect(manifest()).toEqual({
      schemaVersion: 4,
      sourceSha,
      openclawVersion: "2026.7.1",
      openclawSourceSha,
      repository,
      surfaces: {
        gateway: {
          "gateway-edge": digest("2"),
          "octogee-gateway": digest("5"),
          "octogee-gateway-builder": digest("6"),
        },
        platform: {
          "artifact-worker": digest("1"),
          "glm-controller": digest("3"),
          "octogee-api": digest("4"),
          "octogee-ops-agent": digest("7"),
          "octogee-project-runner": digest("8"),
        },
      },
    });
  });

  it("rejects incomplete or non-digest payloads before a manifest can be published", () => {
    expect(() => createReleaseDigestManifest({
      sourceSha,
      openclawVersion: "2026.7.1",
      openclawSourceSha,
      repository,
      images: {
        "artifact-worker": digest("1"),
        "gateway-edge": digest("2"),
        "glm-controller": digest("3"),
        "octogee-api": digest("4"),
        "octogee-gateway": digest("5"),
        "octogee-gateway-builder": "latest",
        "octogee-ops-agent": digest("7"),
        "octogee-project-runner": digest("8"),
      },
    })).toThrow("octogee-gateway-builder must be an immutable sha256 digest");

    const missingRunner = manifest();
    delete missingRunner.surfaces.platform["octogee-project-runner"];
    expect(() => validateReleaseDigestManifest(missingRunner, sourceSha, repository)).toThrow(
      "manifest platform surface must contain exactly: artifact-worker, glm-controller, octogee-api, octogee-ops-agent, octogee-project-runner",
    );
  });

  it("rejects a stored manifest that places an image on the wrong release surface", () => {
    const malformed = manifest();
    malformed.surfaces.platform["gateway-edge"] = malformed.surfaces.gateway["gateway-edge"];
    delete malformed.surfaces.gateway["gateway-edge"];

    expect(() => validateReleaseDigestManifest(malformed, sourceSha, repository)).toThrow(
      "manifest gateway surface must contain exactly: gateway-edge, octogee-gateway, octogee-gateway-builder",
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

  it("accepts retired manifest schemas only for baseline carry-forward", () => {
    const preOpenclawSourceManifest = { ...manifest(), schemaVersion: 3 };
    delete preOpenclawSourceManifest.openclawSourceSha;
    expect(validateBaselineReleaseDigestManifest(legacyManifest(), sourceSha, repository)).toEqual(
      legacyManifest(),
    );
    expect(validateBaselineReleaseDigestManifest(preUserManifest(), sourceSha, repository)).toEqual(
      preUserManifest(),
    );
    expect(validateBaselineReleaseDigestManifest(
      preOpenclawSourceManifest,
      sourceSha,
      repository,
    )).toEqual(preOpenclawSourceManifest);
    expect(validateBaselineReleaseDigestManifest(manifest(), sourceSha, repository)).toEqual(manifest());
    expect(() => validateReleaseDigestManifest(legacyManifest(), sourceSha, repository)).toThrow(
      "manifest schemaVersion must be 4",
    );
    expect(() => validateReleaseDigestManifest(preUserManifest(), sourceSha, repository)).toThrow(
      "manifest schemaVersion must be 4",
    );
  });

  it("carries the gateway build identity when the gateway surface is unchanged", () => {
    const baseline = manifest();
    expect(createMainBuildReleaseDigestManifest({
      sourceSha: otherSha,
      openclawVersion: "2026.7.2",
      openclawSourceSha: "d".repeat(40),
      baselineOpenclawVersion: baseline.openclawVersion,
      baselineOpenclawSourceSha: baseline.openclawSourceSha,
      repository,
      baselineImages: { ...baseline.surfaces.gateway, ...baseline.surfaces.platform },
      exactImages: {},
      changedScopes: { platform: false, gateway: false },
    })).toMatchObject({
      openclawVersion: "2026.7.1",
      openclawSourceSha,
    });
  });

  it("rejects legacy baselines with any image-set change other than the absent runner", () => {
    const missingApi = structuredClone(legacyManifest());
    delete missingApi.surfaces.platform["octogee-api"];
    expect(() => validateBaselineReleaseDigestManifest(missingApi, sourceSha, repository)).toThrow(
      "manifest platform surface must contain exactly: artifact-worker, glm-controller, octogee-api, octogee-ops-agent",
    );

    const addedRunner = structuredClone(legacyManifest());
    addedRunner.surfaces.platform["octogee-project-runner"] = digest("8");
    expect(() => validateBaselineReleaseDigestManifest(addedRunner, sourceSha, repository)).toThrow(
      "manifest platform surface must contain exactly: artifact-worker, glm-controller, octogee-api, octogee-ops-agent",
    );

    const movedGatewayImage = structuredClone(legacyManifest());
    movedGatewayImage.surfaces.platform["gateway-edge"] = movedGatewayImage.surfaces.gateway["gateway-edge"];
    delete movedGatewayImage.surfaces.gateway["gateway-edge"];
    expect(() => validateBaselineReleaseDigestManifest(movedGatewayImage, sourceSha, repository)).toThrow(
      "manifest gateway surface must contain exactly: gateway-edge, octogee-gateway, octogee-gateway-operator",
    );
  });

  it("rejects legacy baselines whose identity or digest contract is mutated", () => {
    const mutableDigest = structuredClone(legacyManifest());
    mutableDigest.surfaces.platform["octogee-api"] = "latest";
    expect(() => validateBaselineReleaseDigestManifest(mutableDigest, sourceSha, repository)).toThrow(
      "octogee-api must be an immutable sha256 digest",
    );
    expect(() => validateBaselineReleaseDigestManifest(legacyManifest(), otherSha, repository)).toThrow(
      "manifest sourceSha does not match the expected SHA",
    );
    expect(() => validateBaselineReleaseDigestManifest(legacyManifest(), sourceSha, `${repository}-other`)).toThrow(
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

it("retains the accepted desktop artifact when authoring and validating a main manifest", () => {
  const baseline = manifest();
  const desktopImage = { project: "firebase-test", name: "octogee-computer-fixture", id: "123", sourceSha, inputFingerprint: "b".repeat(64), acceptance: "resize-reboot-v1" };
  const result = createMainBuildReleaseDigestManifest({ sourceSha, openclawVersion: baseline.openclawVersion, openclawSourceSha,
    baselineOpenclawVersion: baseline.openclawVersion, baselineOpenclawSourceSha: openclawSourceSha, repository,
    baselineImages: { ...baseline.surfaces.gateway, ...baseline.surfaces.platform }, exactImages: {},
    changedScopes: { gateway: false, platform: false }, desktopImage });
  expect(validateReleaseDigestManifest(result, sourceSha, repository).desktopImage).toEqual(desktopImage);
});
