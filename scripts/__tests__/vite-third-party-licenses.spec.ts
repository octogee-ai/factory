import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  createThirdPartyLicenseReport,
  thirdPartyLicenses,
} from "../lib/vite-third-party-licenses.mjs";

const repoRoot = path.resolve(import.meta.dirname, "../..");
const reactModule = path.join(repoRoot, "app/node_modules/react/index.js");
const domPurifyModule = path.join(
  repoRoot,
  "app/node_modules/dompurify/dist/purify.es.mjs",
);
const firebaseAppModule = path.join(
  repoRoot,
  "app/node_modules/@firebase/app/dist/esm/index.esm.js",
);

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
      additionalNoticeFiles: [path.join(repoRoot, "THIRD_PARTY_NOTICES.md")],
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
      additionalNoticeFiles: [path.join(repoRoot, "THIRD_PARTY_NOTICES.md")],
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
