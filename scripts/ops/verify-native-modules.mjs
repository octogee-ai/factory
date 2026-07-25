#!/usr/bin/env node
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const REQUIRED_NATIVE_MODULES = ["node-pty"];

const TOP_LEVEL_ENTRY = /^node_modules\/(?:@[^/]+\/)?[^/]+$/;

export function discoverNativeModules({ lockfile, packageRoot, exists = existsSync, policy = {} }) {
  const packages = lockfile?.packages ?? {};
  const names = [];

  for (const [key, entry] of Object.entries(packages)) {
    if (!entry?.hasInstallScript || !TOP_LEVEL_ENTRY.test(key)) {
      continue;
    }
    const name = key.slice("node_modules/".length);
    if (policy[name] === false) {
      continue;
    }
    if (exists(path.join(packageRoot, "node_modules", name, "binding.gyp"))) {
      names.push(name);
    }
  }

  return names.sort();
}

export function nativeModulesToVerify({ lockfile, packageRoot, exists = existsSync, policy = {} }) {
  const discovered = discoverNativeModules({ lockfile, packageRoot, exists, policy });
  return [...new Set([...REQUIRED_NATIVE_MODULES, ...discovered])].sort();
}

export function verifyNativeModules({ names, load }) {
  const failures = [];

  for (const name of names) {
    try {
      load(name);
    } catch (error) {
      failures.push({ name, message: error instanceof Error ? error.message : String(error) });
    }
  }

  return failures;
}

export function describeBindingLayout({
  packageRoot,
  name,
  platform = process.platform,
  arch = process.arch,
  exists = existsSync,
  readdir = readdirSync,
}) {
  const moduleRoot = path.join(packageRoot, "node_modules", name);
  const prebuildsRoot = path.join(moduleRoot, "prebuilds");
  const platformPrebuild = path.join(prebuildsRoot, `${platform}-${arch}`);
  const gypOutput = path.join(moduleRoot, "build", "Release");

  const parts = [];

  if (exists(platformPrebuild)) {
    parts.push(`prebuilds/${platform}-${arch} present`);
  } else {
    const shipped = exists(prebuildsRoot) ? readdir(prebuildsRoot) : [];
    parts.push(
      `prebuilds/${platform}-${arch} missing (shipped: ${shipped.length > 0 ? shipped.join(", ") : "none"})`,
    );
  }

  parts.push(exists(gypOutput) ? "build/Release present" : "build/Release missing");

  return `node_modules/${name}: ${parts.join(", ")}`;
}

function main({ packageRoot }) {
  const lockfile = JSON.parse(readFileSync(path.join(packageRoot, "package-lock.json"), "utf8"));
  const manifest = JSON.parse(readFileSync(path.join(packageRoot, "package.json"), "utf8"));
  const requireFromPackage = createRequire(path.join(packageRoot, "package.json"));
  const names = nativeModulesToVerify({
    lockfile,
    packageRoot,
    policy: manifest.allowScripts ?? {},
  });
  const failures = verifyNativeModules({ names, load: (name) => requireFromPackage(name) });
  const failed = new Set(failures.map((failure) => failure.name));

  for (const name of names) {
    if (!failed.has(name)) {
      console.error(`[native-modules] ok: ${name}`);
    }
  }

  if (failures.length === 0) {
    console.error(
      `[native-modules] ${names.length} native module(s) load on ${process.platform}-${process.arch}`,
    );
    return;
  }

  for (const { name, message } of failures) {
    console.error(
      `[native-modules] FAILED to load "${name}" on ${process.platform}-${process.arch}: ${message}`,
    );
    console.error(`[native-modules]   ${describeBindingLayout({ packageRoot, name })}`);
  }
  console.error(
    '[native-modules] a native binding is missing: npm skips a dependency\'s install script unless package.json "allowScripts" names it, and node-gyp needs python3 + make + g++ in the image',
  );
  process.exit(1);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main({ packageRoot: path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..") });
}
