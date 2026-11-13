#!/usr/bin/env node

import { pathToFileURL } from "node:url";

export const selectExistingProtectionTargets = (stateAddresses, candidateAddresses) => {
  const state = new Set(stateAddresses.filter(Boolean));
  return candidateAddresses.filter((address) => state.has(address));
};

const readStandardInput = async () => {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
};

const run = async () => {
  const candidates = process.argv.slice(2).map((argument) => {
    if (!argument.startsWith("--candidate=") || argument.length === "--candidate=".length) {
      throw new Error(`Expected --candidate=ADDRESS, received: ${argument}`);
    }
    return argument.slice("--candidate=".length);
  });
  if (candidates.length === 0) throw new Error("At least one --candidate=ADDRESS is required");

  const stateAddresses = (await readStandardInput()).split(/\r?\n/);
  const targets = selectExistingProtectionTargets(stateAddresses, candidates);
  process.stdout.write(targets.length > 0 ? `${targets.join("\n")}\n` : "");
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
