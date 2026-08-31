import * as fs from "node:fs/promises";
import * as path from "node:path";

import {
  BUILDER_TOOLCHAIN_COMMANDS,
  readToolchainDetail,
  readToolchainStatus,
  type BuilderToolchainCommand,
  type InstalledBuilderToolchainLock,
} from "./builder-toolchain-hydrator.js";

export interface ResolvedToolchainCommand {
  kind: "ready" | "loading" | "unavailable";
  exitCode: number;
  message?: string;
  executable?: string;
}

async function resolveReadyToolchainCommand(
  root: string,
  command: BuilderToolchainCommand,
): Promise<ResolvedToolchainCommand> {
  try {
    const activePath = await fs.realpath(path.join(root, "active"));
    const objectsPath = await fs.realpath(path.join(root, "objects"));
    if (!activePath.startsWith(`${objectsPath}${path.sep}`)) throw new Error("active object escaped root");
    const installed = JSON.parse(
      await fs.readFile(path.join(activePath, ".toolchain-lock.json"), "utf8"),
    ) as InstalledBuilderToolchainLock;
    const detail = await readToolchainDetail(root);
    if (
      installed.schemaVersion !== 1 || installed.lockSha256 !== detail?.lockSha256 ||
      !BUILDER_TOOLCHAIN_COMMANDS.every((name) =>
        installed.commands?.[name] === `node_modules/.bin/${name}`)
    ) throw new Error("active lock differs");
    const executable = path.join(activePath, installed.commands[command]);
    const stat = await fs.lstat(executable);
    if (!stat.isFile() && !stat.isSymbolicLink()) throw new Error("command is not executable");
    const realExecutable = await fs.realpath(executable);
    if (!realExecutable.startsWith(`${activePath}${path.sep}`)) throw new Error("command escaped object");
    return { kind: "ready", exitCode: 0, executable };
  } catch {
    return {
      kind: "unavailable",
      exitCode: 69,
      message: `${command} is unavailable on this Builder (invalid-active-toolchain).`,
    };
  }
}

export async function resolveToolchainCommand(input: {
  root: string;
  command: string;
}): Promise<ResolvedToolchainCommand> {
  if (!BUILDER_TOOLCHAIN_COMMANDS.includes(input.command as BuilderToolchainCommand)) {
    return {
      kind: "unavailable",
      exitCode: 69,
      message: `Optional Builder tool '${input.command}' is unavailable (unsupported-command).`,
    };
  }
  const command = input.command as BuilderToolchainCommand;
  const status = await readToolchainStatus(input.root);
  if (!status) {
    return {
      kind: "unavailable",
      exitCode: 69,
      message: `${command} is unavailable on this Builder (toolchain-not-configured).`,
    };
  }
  if (["pending", "downloading", "verifying"].includes(status.status)) {
    return {
      kind: "loading",
      exitCode: 75,
      message: `${command} is loading; the core Agent and chat remain available. Try again shortly.`,
    };
  }
  if (status.status === "failed") {
    const detail = await readToolchainDetail(input.root);
    return {
      kind: "unavailable",
      exitCode: 69,
      message: `${command} is unavailable on this Builder (${detail?.reasonCode ?? "hydration-failed"}).`,
    };
  }
  return resolveReadyToolchainCommand(input.root, command);
}
