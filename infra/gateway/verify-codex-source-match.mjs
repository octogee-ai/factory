import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

const [vendoredDir, installedDir] = process.argv.slice(2);
if (!vendoredDir || !installedDir) {
  throw new Error("usage: verify-codex-source-match <vendored-package-dir> <installed-package-dir>");
}

function distDigests(packageDir) {
  const dist = path.join(packageDir, "dist");
  const digests = new Map();
  const walk = (dir) => {
    for (const entry of readdirSync(dir)) {
      const absolute = path.join(dir, entry);
      if (statSync(absolute).isDirectory()) {
        walk(absolute);
        continue;
      }
      if (!/\.(?:m?js|json)$/u.test(entry)) continue;
      const relative = path.relative(dist, absolute);
      digests.set(relative, createHash("sha256").update(readFileSync(absolute)).digest("hex"));
    }
  };
  walk(dist);
  return digests;
}

const vendored = distDigests(vendoredDir);
const installed = distDigests(installedDir);
const mismatches = [];
for (const [file, digest] of vendored) {
  if (!installed.has(file)) mismatches.push(`${file}: missing from the installed package`);
  else if (installed.get(file) !== digest) mismatches.push(`${file}: content differs`);
}
for (const file of installed.keys()) {
  if (!vendored.has(file)) mismatches.push(`${file}: missing from the vendored package`);
}
if (vendored.size === 0) mismatches.push("vendored package has no dist modules");
if (mismatches.length > 0) {
  const details = mismatches.map((line) => "  " + line).join("\n");
  console.error(`Codex source match: FAIL\n${details}`);
  process.exit(1);
}
console.log(`Codex source match: PASS (${vendored.size} dist modules identical)`);
