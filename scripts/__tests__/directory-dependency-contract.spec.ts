import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

const directoryDependencies = [
  ["core", "@octogee/shared", "devDependencies", "file:../shared"],
  ["functions", "@octogee/test-helpers", "devDependencies", "file:../test-helpers"],
  ["gateway-edge", "@octogee/core", "dependencies", "file:../core"],
  ["gateway-edge", "@octogee/shared", "dependencies", "file:../shared"],
  ["gateway-edge", "@octogee/test-helpers", "devDependencies", "file:../test-helpers"],
  ["glm-controller", "@octogee/core", "dependencies", "file:../core"],
  ["glm-controller", "@octogee/shared", "dependencies", "file:../shared"],
  ["octogee-api", "@octogee/core", "dependencies", "file:../core"],
  ["octogee-api", "@octogee/shared", "dependencies", "file:../shared"],
  ["octogee-api", "@octogee/test-helpers", "devDependencies", "file:../test-helpers"],
  ["scripts", "@octogee/core", "dependencies", "file:../core"],
  ["scripts", "@octogee/shared", "dependencies", "file:../shared"],
] as const;

function readJson(filePath: string): Record<string, any> {
  return JSON.parse(fs.readFileSync(path.join(root, filePath), "utf8"));
}

function dockerfile(pathname: string): string {
  return fs.readFileSync(path.join(root, pathname), "utf8");
}

function expectBefore(contents: string, earlier: string, later: string): void {
  expect(contents.indexOf(earlier)).toBeGreaterThanOrEqual(0);
  expect(contents.indexOf(later)).toBeGreaterThanOrEqual(0);
  expect(contents.indexOf(earlier)).toBeLessThan(contents.indexOf(later));
}

function expectLastBefore(contents: string, earlier: string, later: string): void {
  expect(contents.lastIndexOf(earlier)).toBeGreaterThanOrEqual(0);
  expect(contents.indexOf(later)).toBeGreaterThanOrEqual(0);
  expect(contents.lastIndexOf(earlier)).toBeLessThan(contents.indexOf(later));
}

describe("directory dependency repository contract", () => {
  it("declares every internal package as a packed directory dependency", () => {
    for (const [consumer, packageName, section, spec] of directoryDependencies) {
      const packageJson = readJson(`${consumer}/package.json`);
      const lockfile = readJson(`${consumer}/package-lock.json`);
      const entry = lockfile.packages[`node_modules/${packageName}`];

      expect(packageJson[section][packageName]).toBe(spec);
      expect(entry.resolved).toBe(spec);
      expect(entry.integrity).toBeUndefined();
    }
    expect(readJson("core/package.json").peerDependencies["@octogee/shared"]).toBe("^1.0.0");
  });

  it.each(["core", "functions", "gateway-edge", "glm-controller", "octogee-api"])(
    "%s supplies install-links and a supply-chain release-age cooldown locally",
    (consumer) => {
      expect(fs.readFileSync(path.join(root, consumer, ".npmrc"), "utf8")).toBe(
        "install-links=true\nmin-release-age=7\n",
      );
    },
  );

  it("scripts preserves strict install-script review on top of the shared npm config", () => {
    expect(fs.readFileSync(path.join(root, "scripts", ".npmrc"), "utf8")).toBe(
      "install-links=true\nmin-release-age=7\nstrict-allow-scripts=true\n",
    );
  });

  it.each(["core", "functions", "gateway-edge", "glm-controller", "octogee-api", "scripts"])(
    "%s refreshes packed dependencies before tests",
    (consumer) => {
      expect(readJson(`${consumer}/package.json`).scripts.pretest).toBe(
        "node ../scripts/ops/sync-local-file-deps.mjs --consumer .",
      );
    },
  );

  it("copies each packed dependency and consumer npm config before Docker installs", () => {
    const api = dockerfile("octogee-api/Dockerfile");
    for (const source of ["core", "shared", "test-helpers"]) {
      expectBefore(api, `COPY ${source}/package.json`, "RUN npm ci --ignore-scripts");
      expectBefore(api, `COPY ${source}/dist`, "RUN npm ci --ignore-scripts");
    }
    expectBefore(api, "COPY octogee-api/.npmrc", "RUN npm ci --ignore-scripts");
    expectBefore(api, "COPY gateway-edge/.npmrc", "RUN npm ci --prefix /gateway-edge --ignore-scripts");
    const apiRuntimeInstall = "RUN npm ci --omit=dev --ignore-scripts\nRUN npm rebuild";
    for (const source of ["core", "shared"]) {
      expectLastBefore(api, `COPY ${source}/package.json`, apiRuntimeInstall);
      expectLastBefore(api, `COPY ${source}/dist`, apiRuntimeInstall);
    }
    expectLastBefore(api, "COPY octogee-api/.npmrc", apiRuntimeInstall);
    expectBefore(api, "COPY octogee-api/runner/package.json", "RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund");

    const edge = dockerfile("gateway-edge/Dockerfile");
    for (const source of ["core", "shared", "test-helpers"]) {
      expectBefore(edge, `COPY ${source}/package.json`, "RUN npm ci --ignore-scripts");
      expectBefore(edge, `COPY ${source}/dist`, "RUN npm ci --ignore-scripts");
    }
    expectBefore(edge, "COPY gateway-edge/.npmrc", "RUN npm ci --ignore-scripts");
    for (const source of ["core", "shared"]) {
      expectLastBefore(edge, `COPY ${source}/package.json`, "RUN npm ci --omit=dev");
      expectLastBefore(edge, `COPY ${source}/dist`, "RUN npm ci --omit=dev");
    }
    expectLastBefore(edge, "COPY gateway-edge/.npmrc", "RUN npm ci --omit=dev");

    const glm = dockerfile("glm-controller/Dockerfile");
    for (const source of ["core", "shared"]) {
      expectBefore(glm, `COPY ${source}/package.json`, "RUN npm ci");
      expectBefore(glm, `COPY ${source}/dist`, "RUN npm ci");
    }
    expectBefore(glm, "COPY glm-controller/.npmrc", "RUN npm ci");

    const gateway = dockerfile("infra/gateway/Dockerfile");
    for (const source of ["core", "shared"]) {
      expectBefore(gateway, `COPY --chown=node:node ${source}/package.json`, "RUN npm install --no-audit --no-fund");
      expectBefore(gateway, `COPY --chown=node:node ${source}/dist`, "RUN npm install --no-audit --no-fund");
    }
    expectBefore(gateway, "COPY --chown=node:node scripts/.npmrc", "RUN npm install --no-audit --no-fund");
  });

  it("re-includes every packed interface in Docker and Cloud Build upload contexts", () => {
    for (const ignoreFile of [".dockerignore", ".gcloudignore"]) {
      const lines = fs
        .readFileSync(path.join(root, ignoreFile), "utf8")
        .split("\n")
        .map((line) => line.trim());
      for (const source of ["core", "shared", "test-helpers"]) {
        expect(lines).toContain(`!${source}/dist/`);
        expect(lines).toContain(`!${source}/dist/**`);
      }
    }
  });

  it("uploads every packed interface to Cloud Build", () => {
    const gcloudignore = fs.readFileSync(path.join(root, ".gcloudignore"), "utf8");

    for (const source of ["core", "shared", "test-helpers"]) {
      expect(gcloudignore).toContain(`!${source}/dist/**`);
    }
  });

  it("excludes local environment secrets from Cloud Build uploads", () => {
    const lines = fs
      .readFileSync(path.join(root, ".gcloudignore"), "utf8")
      .split("\n")
      .map((line) => line.trim());

    expect(lines).toContain(".env*");
    expect(lines).toContain("**/.env*");
    expect(lines).toContain("**/secrets");
  });

  it("keeps the Helm charts required by the controller image in Cloud Build uploads", () => {
    const lines = fs
      .readFileSync(path.join(root, ".gcloudignore"), "utf8")
      .split("\n")
      .map((line) => line.trim());

    expect(lines).not.toContain("helm/");
  });

  it("retires tarball transport and its maintenance commands", () => {
    for (const filePath of [
      "core/octogee-core.tgz",
      "shared/octogee-shared.tgz",
      "test-helpers/octogee-test-helpers.tgz",
      "core/verify-tarball.sh",
      "shared/verify-tarball.sh",
      "test-helpers/verify-tarball.sh",
      "scripts/ops/rebase-resolve-tarballs.mjs",
    ]) {
      expect(fs.existsSync(path.join(root, filePath))).toBe(false);
    }
    const rootPackage = readJson("package.json");
    expect(rootPackage.scripts["regen:file-deps"]).toBeUndefined();
    expect(rootPackage.scripts["rebase:resolve"]).toBeUndefined();
  });
});
