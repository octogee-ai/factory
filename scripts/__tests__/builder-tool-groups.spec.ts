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
      "@anthropic-ai/claude-code": "2.1.251",
      "@openai/codex": "0.151.0",
      "@sparticuz/chromium": "149.0.0",
      "firebase-tools": "15.28.2",
      "npm-check-updates": "23.1.0",
      "pnpm": "12.1.0",
      "tsx": "4.23.13",
      "typescript": "7.0.2",
    });

    const debianPackages = new Set(
      manifest.groups.flatMap((group) => group.debianPackages ?? []),
    );
    expect(debianPackages).toEqual(new Set([
      "bash-completion", "bc", "build-essential", "cloc", "cmake", "dnsutils",
      "fd-find", "ffmpeg", "file", "fonts-liberation", "fonts-noto-color-emoji",
      "fzf", "git-lfs", "htop", "imagemagick", "iproute2", "iputils-ping", "less", "lsof",
      "make", "nano", "net-tools", "netcat-openbsd", "pandoc", "pipx", "pkg-config",
      "postgresql-client", "procps", "psmisc", "python3", "python3-pip", "python3-venv",
      "redis-tools", "ripgrep", "sqlite3", "socat", "strace", "traceroute", "tree",
      "unzip", "vim", "wget", "xxd", "zip", "zsh",
    ]));

    expect(manifest.pythonPackages).toEqual([
      "PyYAML==6.0.3",
      "beautifulsoup4==4.15.0",
      "pandas==3.0.5",
      "matplotlib==3.11.1",
    ]);
    expect(manifest.standaloneTools).toEqual({
      gcloud: {
        version: "579.0.0",
        sha256: "a9a7fbe51cda37cf6142b1bbcff12227550e60a6c67e8cf84644fb301371c4de",
      },
      gh: { version: "2.98.0" },
      helm: { version: "4.2.4" },
      terraform: { version: "1.15.8" },
      yq: { version: "4.53.6" },
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
