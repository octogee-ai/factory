import * as fs from "node:fs/promises";
import * as path from "node:path";

import {
  BUILDER_TOOLCHAIN_COMMANDS,
  parseBuilderToolchainManifest,
  readToolchainDetail,
  readToolchainStatus,
  type BuilderToolchainCommand,
} from "./builder-toolchain-hydrator.js";

export interface ResolvedToolchainCommand {
  kind: "ready" | "loading" | "unavailable";
  exitCode: number;
  message?: string;
  executable?: string;
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
  try {
    const activePath = await fs.realpath(path.join(input.root, "active"));
    const objectsPath = await fs.realpath(path.join(input.root, "objects"));
    if (!activePath.startsWith(`${objectsPath}${path.sep}`)) throw new Error("active object escaped root");
    const manifest = parseBuilderToolchainManifest(JSON.parse(
      await fs.readFile(path.join(activePath, ".toolchain-manifest.json"), "utf8"),
    ));
    const detail = await readToolchainDetail(input.root);
    if (manifest.artifact.sha256 !== detail?.artifactSha256) throw new Error("active digest differs");
    const executable = path.join(activePath, manifest.commands[command]);
    const stat = await fs.lstat(executable);
    if (!stat.isFile()) throw new Error("command is not a file");
    const realExecutable = await fs.realpath(executable);
    if (!realExecutable.startsWith(`${activePath}${path.sep}`)) throw new Error("command escaped object");
    return { kind: "ready", exitCode: 0, executable: realExecutable };
  } catch {
    return {
      kind: "unavailable",
      exitCode: 69,
      message: `${command} is unavailable on this Builder (invalid-active-toolchain).`,
    };
  }
}
