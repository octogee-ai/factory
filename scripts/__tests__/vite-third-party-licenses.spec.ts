import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  createThirdPartyLicenseReport,
  thirdPartyLicenses,
} from "../lib/vite-third-party-licenses.mjs";

const repoRoot = path.resolve(import.meta.dirname, "../..");
let fixtureRoot: string;
let reactModule: string;
let domPurifyModule: string;
let firebaseAppModule: string;

function writePackage(
  name: string,
  version: string,
  options: { license?: string; licenseText?: string } = {},
): string {
  const directory = path.join(fixtureRoot, "node_modules", ...name.split("/"));
  mkdirSync(directory, { recursive: true });
  writeFileSync(
    path.join(directory, "package.json"),
    JSON.stringify({
      name,
      version,
      license: options.license ?? "MIT",
      repository: `https://example.test/${name}.git`,
    }),
  );
  writeFileSync(path.join(directory, "index.js"), "export {};\n");
  if (options.licenseText) {
    writeFileSync(path.join(directory, "LICENSE"), options.licenseText);
  }
  return path.join(directory, "index.js");
}

beforeAll(() => {
  fixtureRoot = mkdtempSync(path.join(os.tmpdir(), "octogee-license-plugin-"));
  reactModule = writePackage("react", "19.2.7", {
    licenseText: "Permission is hereby granted to use this test fixture.",
  });
  domPurifyModule = writePackage("dompurify", "3.4.12", {
    license: "(MPL-2.0 OR Apache-2.0)",
    licenseText: "Apache License test fixture.",
  });
  firebaseAppModule = writePackage("@firebase/app", "0.15.1", {
    license: "Apache-2.0",
  });
});

afterAll(() => {
  rmSync(fixtureRoot, { recursive: true, force: true });
});

function bundleWith(...moduleIds: string[]) {
  return {
    "assets/index.js": {
      type: "chunk" as const,
      modules: Object.fromEntries(moduleIds.map((moduleId) => [moduleId, {}])),
    },
  };
}

describe("Vite third-party license artifact", () => {
  it("includes root provenance plus exact bundled package license files", () => {
    const report = createThirdPartyLicenseReport({
      bundle: bundleWith(reactModule, domPurifyModule),
      additionalNoticeFiles: [path.join(repoRoot, "../THIRD_PARTY_NOTICES.md")],
    });

    expect(report).toContain("# Third-Party Notices");
    expect(report).toContain("dompurify@3.4.12");
    expect(report).toContain("react@19.2.7");
    expect(report).toContain("Permission is hereby granted");
    expect(report.indexOf("dompurify@3.4.12")).toBeLessThan(
      report.indexOf("react@19.2.7"),
    );
  });

  it("deduplicates package modules and strips Vite query suffixes", () => {
    const report = createThirdPartyLicenseReport({
      bundle: bundleWith(reactModule, `${reactModule}?commonjs-proxy`),
    });

    expect(report.match(/react@19\.2\.7/g)).toHaveLength(1);
  });

  it("rejects a bundled package whose unpacked artifact and root notices both omit its license", () => {
    expect(() =>
      createThirdPartyLicenseReport({ bundle: bundleWith(firebaseAppModule) }),
    ).toThrow(/@firebase\/app@0\.15\.1.*THIRD_PARTY_NOTICES/s);
  });

  it("emits a stable top-level artifact during production builds", () => {
    const emitFile = vi.fn();
    const plugin = thirdPartyLicenses({
      additionalNoticeFiles: [path.join(repoRoot, "../THIRD_PARTY_NOTICES.md")],
    });

    plugin.generateBundle.call({ emitFile }, {}, bundleWith(reactModule));

    expect(plugin).toMatchObject({
      name: "octogee-third-party-licenses",
      apply: "build",
    });
    expect(emitFile).toHaveBeenCalledOnce();
    expect(emitFile.mock.calls[0][0]).toMatchObject({
      type: "asset",
      fileName: "THIRD_PARTY_LICENSES.txt",
    });
    expect(emitFile.mock.calls[0][0].source).toContain("react@19.2.7");
  });
});
