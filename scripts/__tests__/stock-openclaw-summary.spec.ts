import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { STEPS } from "../ops/kind-stock-openclaw.mjs";
import { report, tails } from "../ci/stock-openclaw-summary.mjs";

const BASE = "0".repeat(39) + "1";
const OVERLAY = "a".repeat(40);

const packaged = (outcomes: Record<string, string>) => ({
  result: "success",
  outputs: {
    upstream: "openclaw/openclaw", fork: "ceckert/openclaw", base: BASE, overlay: OVERLAY, commits: "6", version: "2026.11.13",
    resolve: "success", install: "success", build: "success", pack: "success", ...outcomes,
  },
});

const rowsOf = (markdown: string) => markdown.split("\n").filter(line => line.startsWith("| ") && !line.startsWith("| Step") && !line.startsWith("| ---"))
  .map(line => line.split(" | ").map(cell => cell.replace(/^\| | \|$/g, "")));

describe("stock-openclaw-summary report", () => {
  it("names the upstream commit and lists every step that passed on kind", () => {
    const steps = STEPS.map(step => ({ ...step, status: "passed", seconds: 3, ...(step.id === "reply" ? { note: "1 call(s), $0.001557" } : {}) }));
    const { markdown, failed } = report({
      package: packaged({}),
      kind: { result: "success", outputs: { install: "success", report: JSON.stringify({ steps }) } },
    });

    expect(failed).toBe(0);
    expect(markdown).toContain(`[\`00000000\`](https://github.com/openclaw/openclaw/commit/${BASE}) (version 2026.11.13)`);
    expect(markdown).toContain(`without the 6 overlay commits that end at [\`aaaaaaaa\`](https://github.com/ceckert/openclaw/commit/${OVERLAY})`);
    const rows = rowsOf(markdown);
    expect(rows).toHaveLength(5 + STEPS.length);
    expect(rows.every(([, result]) => result.startsWith("passed"))).toBe(true);
    expect(rows.find(([title]) => title.startsWith("The user's agent replies"))?.[2]).toBe("1 call(s), $0.001557");
    expect(markdown).toContain("Every step passed. This lane does not block the build.");
  });

  it("reports the first failing step on kind and skips the rest", () => {
    const steps = STEPS.map((step, index) => ({
      ...step,
      status: index < 2 ? "passed" : index === 2 ? "failed" : "skipped",
      ...(index === 2 ? { detail: "octogee-fleet user migrate exited with 1: refused | conflict" } : {}),
    }));
    const { markdown, failed } = report({
      package: packaged({}),
      kind: { result: "success", outputs: { install: "success", report: JSON.stringify({ steps }) } },
    });

    expect(failed).toBe(1);
    const migrate = rowsOf(markdown).find(([title]) => title.includes("user migrate"))!;
    expect(migrate[1]).toBe("failed");
    expect(migrate[2]).toBe("octogee-fleet user migrate exited with 1: refused \\| conflict");
    expect(markdown).toContain(`First failure: ${STEPS[2].title}.`);
  });

  it("marks the kind steps skipped when the build of the packages fails", () => {
    const { markdown, failed } = report({ package: packaged({ build: "failure", pack: "skipped" }), kind: { result: "skipped", outputs: {} } });

    expect(failed).toBe(1);
    const rows = rowsOf(markdown);
    expect(rows.map(([, result]) => result)).toEqual(["passed", "passed", "failed", "skipped", "skipped", ...STEPS.map(() => "skipped")]);
  });

  it("fails the first kind step when the install passed but the steps never reported", () => {
    const { markdown, failed } = report({ package: packaged({}), kind: { result: "success", outputs: { install: "success" } } });

    expect(failed).toBe(1);
    expect(rowsOf(markdown)[5]).toEqual([STEPS[0].title, "failed", "The steps on kind did not report a result"]);
  });

  it("says the kind steps did not run when only the packages were requested", () => {
    const { markdown, failed } = report({ package: packaged({}), kind: { result: "skipped", outputs: {} } });

    expect(failed).toBe(0);
    expect(rowsOf(markdown).slice(4).every(([, result]) => result === "not run")).toBe(true);
    expect(markdown).toContain("This run built the stock packages only.");
    expect(markdown).toContain("Every step that ran passed.");
  });
});

describe("stock-openclaw-summary tails", () => {
  let logs: string;

  beforeEach(() => {
    logs = mkdtempSync(join(tmpdir(), "stock-openclaw-logs-"));
  });

  afterEach(() => {
    rmSync(logs, { recursive: true, force: true });
  });

  it("shows the redacted end of each failed step's log and nothing for steps that passed", () => {
    writeFileSync(join(logs, "build.log"), [...Array.from({ length: 60 }, (_, index) => `line ${index}`), "token=hunter2 failed", "```"].join("\n"));
    writeFileSync(join(logs, "install.log"), "all good\n");

    const text = tails({ install: { outcome: "success" }, build: { outcome: "failure" }, pack: { outcome: "skipped" } }, logs);

    expect(text).toContain("#### The last 40 lines of `build`");
    expect(text).not.toContain("line 21\n");
    expect(text).toContain("line 22");
    expect(text).toContain("token=[redacted]");
    expect(text).not.toContain("hunter2");
    expect(text).not.toContain("all good");
    expect(text.match(/```/g)).toHaveLength(2);
  });
});
