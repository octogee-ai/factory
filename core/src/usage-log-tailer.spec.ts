import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { extractRole, findSessionFiles, parseLineForUsage } from "./usage-log-tailer.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "octogee-usage-tailer-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("parseLineForUsage", () => {
  it("extracts assistant message usage and cost fields from session jsonl", () => {
    const usage = parseLineForUsage(
      JSON.stringify({
        type: "message",
        message: {
          role: "assistant",
          model: "anthropic/claude-sonnet-4-6",
          usage: {
            input: 100,
            output: 25,
            cacheRead: 4,
            cacheWrite: 8,
            totalTokens: 137,
            cost: {
              input: 0.01,
              output: 0.02,
              cacheRead: 0.003,
              cacheWrite: 0.004,
              total: 0.037,
            },
          },
        },
      }),
    );

    expect(usage).toEqual({
      input: 100,
      output: 25,
      cacheRead: 4,
      cacheWrite: 8,
      totalTokens: 137,
      costUsd: 0.037,
      model: "anthropic/claude-sonnet-4-6",
      costBreakdown: {
        input: 0.01,
        output: 0.02,
        cacheRead: 0.003,
        cacheWrite: 0.004,
      },
    });
  });

  it("ignores malformed lines, non-message events, and non-assistant messages", () => {
    expect(parseLineForUsage("{")).toBeNull();
    expect(parseLineForUsage(JSON.stringify({ type: "tool" }))).toBeNull();
    expect(
      parseLineForUsage(
        JSON.stringify({
          type: "message",
          message: { role: "user", usage: { totalTokens: 10 } },
        }),
      ),
    ).toBeNull();
  });

  it("defaults missing numeric fields to zero and missing models to unknown", () => {
    expect(
      parseLineForUsage(
        JSON.stringify({
          type: "message",
          message: { role: "assistant", usage: {} },
        }),
      ),
    ).toMatchObject({
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      costUsd: 0,
      model: "unknown",
    });
  });
});

describe("findSessionFiles", () => {
  it("discovers jsonl session files under matching agent directories only", () => {
    const agentsDir = path.join(tmpDir, "agents");
    fs.mkdirSync(path.join(agentsDir, "octogee-acme-coach", "sessions"), { recursive: true });
    fs.mkdirSync(path.join(agentsDir, "other-agent", "sessions"), { recursive: true });
    fs.writeFileSync(path.join(agentsDir, "octogee-acme-coach", "sessions", "one.jsonl"), "", "utf-8");
    fs.writeFileSync(
      path.join(agentsDir, "octogee-acme-coach", "sessions", "one.jsonl.lock"),
      "",
      "utf-8",
    );
    fs.writeFileSync(path.join(agentsDir, "other-agent", "sessions", "two.jsonl"), "", "utf-8");

    expect(findSessionFiles(agentsDir, "octogee-")).toEqual([
      path.join(agentsDir, "octogee-acme-coach", "sessions", "one.jsonl"),
    ]);
  });

  it("returns an empty list when the agents directory is missing", () => {
    expect(findSessionFiles(path.join(tmpDir, "missing"), "octogee-")).toEqual([]);
  });
});

describe("extractRole", () => {
  it("recognizes agent agents and treats unrecognized suffixes as agent usage", () => {
    expect(extractRole("octogee-acme-coach")).toBe("coach");
    expect(extractRole("octogee-acme-research")).toBe("coach");
    expect(extractRole("unknown")).toBe("coach");
  });
});
