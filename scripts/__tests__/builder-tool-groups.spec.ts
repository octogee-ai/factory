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
      "@anthropic-ai/claude-code": "2.1.310",
      "@openai/codex": "0.164.0",
      "@sparticuz/chromium": "153.0.0",
      "firebase-tools": "15.34.1",
      "npm-check-updates": "23.1.1",
      "pnpm": "12.15.0",
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
      "pandas==3.1.0",
      "matplotlib==3.11.2",
    ]);
    expect(manifest.standaloneTools).toEqual({
      gcloud: {
        version: "590.0.1",
        sha256: "d1ae7be7e12c4e7d8286fab4774f5441020aca89dc7793ddacbace8d11d20f06",
      },
      gh: { version: "2.103.2" },
      helm: { version: "4.3.1" },
      terraform: { version: "1.17.0" },
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
