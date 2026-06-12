import { describe, it, expect } from "vitest";
import { projectPlaybookSeeds } from "../lib/projects/playbook-seeds.js";

describe("projectPlaybookSeeds", () => {
  const seeds = () => projectPlaybookSeeds("Wild Card", "2026-06-12");

  it("seeds the four playbook files at repo-relative paths", () => {
    expect(seeds().map((s) => s.relPath).sort()).toEqual([
      "DECISIONS.md",
      "runbook/how-we-build.md",
      "runbook/what-done-means.md",
      "runbook/working-with-your-agent.md",
    ]);
  });

  it("seeds DECISIONS.md with a dated, timeline-parseable first entry", () => {
    const decisions = seeds().find((s) => s.relPath === "DECISIONS.md")!;
    expect(decisions.content).toContain("## 2026-06-12 — ");
    expect(decisions.content).toMatch(/^Why: /m);
    expect(decisions.content).toContain("Wild Card");
  });

  it("names the project in the standards so the pages read as the project's own", () => {
    const how = seeds().find((s) => s.relPath === "runbook/how-we-build.md")!;
    expect(how.content).toContain("Wild Card");
  });

  it("carries the record-a-decision contract in working-with-your-agent", () => {
    const working = seeds().find((s) => s.relPath === "runbook/working-with-your-agent.md")!;
    expect(working.content).toMatch(/record a decision/i);
  });

  it("done means shipped", () => {
    const done = seeds().find((s) => s.relPath === "runbook/what-done-means.md")!;
    expect(done.content).toMatch(/shipped/i);
  });
});
