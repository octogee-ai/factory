import fs from "node:fs";
import path from "node:path";

const LICENSE_FILE_PATTERN = /^(licen[cs]e|notice|copying)([._-].*)?$/i;

function cleanModuleId(moduleId) {
  return moduleId.replace(/^\0/, "").split(/[?#]/, 1)[0];
}

function readPackageAt(directory) {
  const manifestPath = path.join(directory, "package.json");
  if (!fs.existsSync(manifestPath)) return null;
  try {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    if (typeof manifest.name !== "string" || typeof manifest.version !== "string") {
      return null;
    }
    return { directory, manifest };
  } catch {
    return null;
  }
}

function resolvePackage(moduleId) {
  const cleanId = cleanModuleId(moduleId);
  if (!path.isAbsolute(cleanId)) return null;

  let directory = path.dirname(cleanId);
  while (directory !== path.dirname(directory)) {
    if (directory.includes(`${path.sep}node_modules${path.sep}`)) {
      const packageInfo = readPackageAt(directory);
      if (packageInfo) return packageInfo;
    }
    directory = path.dirname(directory);
  }
  return null;
}

function packageRepository(manifest) {
  if (typeof manifest.repository === "string") return manifest.repository;
  if (manifest.repository && typeof manifest.repository.url === "string") {
    return manifest.repository.url;
  }
  return null;
}

function readLicenseFiles(directory) {
  return fs
    .readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && LICENSE_FILE_PATTERN.test(entry.name))
    .map((entry) => ({
      name: entry.name,
      text: fs.readFileSync(path.join(directory, entry.name), "utf8").trim(),
    }))
    .filter((entry) => entry.text.length > 0)
    .sort((left, right) => left.name.localeCompare(right.name));
}

function bundledPackages(bundle) {
  const packages = new Map();
  for (const output of Object.values(bundle)) {
    if (output.type !== "chunk" || !output.modules) continue;
    for (const moduleId of Object.keys(output.modules)) {
      const packageInfo = resolvePackage(moduleId);
      if (!packageInfo) continue;
      const key = `${packageInfo.manifest.name}@${packageInfo.manifest.version}`;
      if (!packages.has(key)) packages.set(key, packageInfo);
    }
  }
  return [...packages.entries()].sort(([left], [right]) => left.localeCompare(right));
}

function renderPackage(key, packageInfo, incorporatedNotices) {
  const license =
    typeof packageInfo.manifest.license === "string"
      ? packageInfo.manifest.license
      : "not declared in package.json";
  const repository = packageRepository(packageInfo.manifest);
  const licenseFiles = readLicenseFiles(packageInfo.directory);
  const lines = [key, `Declared license: ${license}`];
  if (repository) lines.push(`Source: ${repository}`);
  if (licenseFiles.length === 0) {
    if (!incorporatedNotices.includes(`\`${packageInfo.manifest.name}\``)) {
      throw new Error(
        `${key} does not publish a standalone license or notice file. ` +
          `Record the package and its applicable attribution in THIRD_PARTY_NOTICES.md.`,
      );
    }
    lines.push(
      "No standalone license or notice file was published in this package artifact.",
      "Its license and attribution are recorded in the incorporated material notice above.",
    );
  } else {
    for (const file of licenseFiles) {
      lines.push("", `--- ${file.name} ---`, "", file.text);
    }
  }
  return lines.join("\n");
}

export function createThirdPartyLicenseReport({ bundle, additionalNoticeFiles = [] }) {
  const additionalNotices = additionalNoticeFiles.map((noticePath) => ({
    noticePath,
    text: fs.readFileSync(noticePath, "utf8").trim(),
  }));
  const incorporatedNotices = additionalNotices.map(({ text }) => text).join("\n");
  const sections = [
    "OCTOGEE THIRD-PARTY LICENSES AND NOTICES",
    "",
    "This artifact accompanies the built application. Package versions and notices",
    "are generated from the modules included in this build.",
  ];

  for (const { noticePath, text } of additionalNotices) {
    sections.push(
      "",
      "=".repeat(80),
      `INCORPORATED MATERIAL NOTICE: ${path.basename(noticePath)}`,
      "=".repeat(80),
      "",
      text,
    );
  }

  sections.push("", "=".repeat(80), "BUNDLED PACKAGE NOTICES", "=".repeat(80));
  for (const [key, packageInfo] of bundledPackages(bundle)) {
    sections.push(
      "",
      "-".repeat(80),
      "",
      renderPackage(key, packageInfo, incorporatedNotices),
    );
  }
  sections.push("");
  return sections.join("\n");
}

export function thirdPartyLicenses({
  additionalNoticeFiles = [],
  fileName = "THIRD_PARTY_LICENSES.txt",
} = {}) {
  return {
    name: "octogee-third-party-licenses",
    apply: "build",
    generateBundle(_outputOptions, bundle) {
      this.emitFile({
        type: "asset",
        fileName,
        source: createThirdPartyLicenseReport({ bundle, additionalNoticeFiles }),
      });
    },
  };
}
