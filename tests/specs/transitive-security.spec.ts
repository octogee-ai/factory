import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = path.resolve(import.meta.dirname, "../..");
const firebaseToolLockfiles = [
  "gateway-edge/package-lock.json",
  "octogee-api/package-lock.json",
  "scripts/package-lock.json",
];
const xmlParserLockfiles = [
  "core/package-lock.json",
  "test-helpers/package-lock.json",
];

function packageVersions(packages: Record<string, { version?: string }>, packageName: string): string[] {
  const suffix = `node_modules/${packageName}`;
  const entries = Object.entries(packages).filter(([key]) => key === suffix || key.endsWith(`/${suffix}`));
  if (entries.length === 0) throw new Error(`Lockfile does not resolve ${packageName}`);
  return entries.map(([key, entry]) => {
    if (!entry.version) throw new Error(`${key} has no version`);
    return entry.version;
  });
}

function lockVersions(lockfile: string, packageName: string): string[] {
  const lock = JSON.parse(readFileSync(path.join(repoRoot, lockfile), "utf8")) as {
    packages: Record<string, { version?: string }>;
  };
  return packageVersions(lock.packages, packageName);
}

function isAtLeast(version: string, minimum: [number, number, number]): boolean {
  const current = version.split(".").map(Number);
  return current[0] > minimum[0]
    || (current[0] === minimum[0] && current[1] > minimum[1])
    || (current[0] === minimum[0] && current[1] === minimum[1] && current[2] >= minimum[2]);
}

describe("transitive dependency security floors", () => {
  it("checks every installation and rejects missing versions", () => {
    const packages = {
      "node_modules/@hono/node-server": { version: "2.1.6" },
      "node_modules/sdk/node_modules/@hono/node-server": { version: "2.1.3" },
    };
    expect(packageVersions(packages, "@hono/node-server").every((version) => isAtLeast(version, [2, 1, 6]))).toBe(false);
    expect(() => packageVersions({}, "@hono/node-server")).toThrow();
    expect(() => packageVersions({ "node_modules/@hono/node-server": {} }, "@hono/node-server")).toThrow();
  });

  it.each(firebaseToolLockfiles)("keeps Firebase tooling in %s above advisory ranges", (lockfile) => {
    expect(lockVersions(lockfile, "@hono/node-server").every((version) => isAtLeast(version, [2, 1, 6]))).toBe(true);
    expect(lockVersions(lockfile, "hono").every((version) => isAtLeast(version, [4, 12, 27]))).toBe(true);
    expect(lockVersions(lockfile, "fast-uri").every((version) => isAtLeast(version, [3, 1, 4]))).toBe(true);
  });

  it.each(xmlParserLockfiles)("keeps XML parsing in %s above advisory ranges", (lockfile) => {
    expect(lockVersions(lockfile, "fast-xml-parser").every((version) => isAtLeast(version, [5, 10, 1]))).toBe(true);
  });
});
