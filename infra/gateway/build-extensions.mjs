#!/usr/bin/env node

import { existsSync, readdirSync, rmSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

import { extensionDirectories, readExtensionPackage } from "./extension-manifest.mjs";

const extensionsRoot = path.resolve(process.argv[2] ?? "/octogee/extensions");
const esbuild = path.resolve(
  process.argv[3] ?? "/octogee/scripts/node_modules/.bin/esbuild",
);

function removeTypeScriptSources(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules") continue;
    const target = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      removeTypeScriptSources(target);
      continue;
    }
    if (/\.(?:cts|mts|ts|tsx)$/u.test(entry.name)) rmSync(target);
  }
}

const directories = extensionDirectories(extensionsRoot);
if (directories.length === 0) throw new Error(`no Octogee extensions found in ${extensionsRoot}`);

for (const dir of directories) {
  const packageJson = readExtensionPackage(dir);
  if (packageJson.type !== "module") {
    throw new Error(`${path.basename(dir)} must declare package.json type=module`);
  }
  const entry = path.join(dir, "index.ts");
  if (!existsSync(entry)) throw new Error(`${path.basename(dir)} is missing index.ts`);
  const output = path.join(dir, "index.js");
  const compiled = spawnSync(
    esbuild,
    [
      entry,
      "--bundle",
      "--platform=node",
      "--format=esm",
      "--target=node24",
      "--packages=external",
      `--outfile=${output}`,
    ],
    { stdio: "inherit" },
  );
  if (compiled.error) throw compiled.error;
  if (compiled.status !== 0) {
    throw new Error(`${path.basename(dir)} compilation failed with status ${compiled.status}`);
  }
}

for (const dir of directories) removeTypeScriptSources(dir);
