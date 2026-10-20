import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { parseBuilderToolGroups } from "../lib/builder-tool-groups.js";

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const manifestPath = `${repoRoot}/infra/gateway/builder-toolchain/groups.json`;

describe("Builder tool groups", () => {
  it("restores the complete pre-slim Builder workstation as named groups", () => {
    const manifest = parseBuilderToolGroups(
      JSON.parse(readFileSync(manifestPath, "utf8")) as unknown,
    );

    expect(manifest.groups.map((group) => group.id)).toEqual([
      "core",
      "agent-clis",
      "browser",
      "computer",
      "web-development",
      "languages",
      "build",
      "shell",
      "media",
      "diagnostics",
      "data",
      "version-control",
      "cloud",
    ]);
    expect(manifest.groups.every((group) => group.enabled)).toBe(true);
    expect(manifest.groups.filter((group) => group.delivery === "npm").map((group) => group.id))
      .toEqual(["agent-clis", "browser", "web-development"]);

    const npmPackages = Object.fromEntries(
      manifest.groups.flatMap((group) => Object.entries(group.npmPackages ?? {})),
    );
    expect(npmPackages).toEqual({
      "@anthropic-ai/claude-code": "2.1.296",
      "@openai/codex": "0.162.1",
      "@sparticuz/chromium": "153.0.0",
      "firebase-tools": "15.33.0",
      "npm-check-updates": "23.1.1",
      "pnpm": "12.13.0",
      "tsx": "4.23.15",
      "typescript": "7.0.2",
    });

    const debianPackages = new Set(
      manifest.groups.flatMap((group) => group.debianPackages ?? []),
    );
    expect(debianPackages).toEqual(new Set([
      "bash-completion", "bc", "build-essential", "cloc", "cmake", "dbus-bin", "dnsutils",
      "ffmpeg", "file", "fonts-liberation", "fonts-noto-color-emoji",
      "fzf", "git-lfs", "htop", "imagemagick", "iproute2", "iputils-ping", "less", "lsof",
      "make", "nano", "net-tools", "netcat-openbsd", "pandoc", "pipx", "pkg-config",
      "postgresql-client", "procps", "psmisc", "python3", "python3-pip", "python3-venv",
      "redis-tools", "ripgrep", "sqlite3", "socat", "strace", "traceroute", "tree",
      "unzip", "vim", "wget", "wtype", "xxd", "zip", "zsh",
    ]));

    expect(manifest.pythonPackages).toEqual([
      "PyYAML==6.0.3",
      "beautifulsoup4==4.15.0",
      "pandas==3.0.6",
      "matplotlib==3.11.2",
    ]);
    expect(manifest.standaloneTools).toEqual({
      gcloud: {
        version: "588.0.0",
        sha256: "e38ceac43022bb5a4d94d5a4a9c9c51f90f28c910b59a018ae07011e220c4412",
      },
      gh: { version: "2.102.0" },
      helm: { version: "4.3.0" },
      terraform: { version: "1.16.5" },
      yq: { version: "4.54.1" },
    });
  });

  it("rejects a duplicate package across groups", () => {
    expect(() => parseBuilderToolGroups({
      schemaVersion: 1,
      groups: [
        { id: "one", enabled: true, delivery: "base", debianPackages: ["ripgrep"] },
        { id: "two", enabled: true, delivery: "base", debianPackages: ["ripgrep"] },
      ],
      pythonPackages: [],
      standaloneTools: {},
    })).toThrow("invalid-builder-tool-groups");
  });
});
