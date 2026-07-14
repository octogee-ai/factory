import { describe, it, expect } from "vitest";
import { notesWelcomeSeed, projectPlaybookSeeds } from "./index.js";

describe("projectPlaybookSeeds", () => {
  const seeds = () => projectPlaybookSeeds("Wild Card", "2026-06-12");

  it("seeds the project playbook files at repo-relative paths", () => {
    expect(seeds().map((s) => s.relPath).sort()).toEqual([
      "DECISIONS.md",
      "runbook/how-we-build.md",
      "runbook/shipping-on-gcp.md",
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

  it("seeds an Octogee and GCP shipping guide for the project", () => {
    const shipping = seeds().find((s) => s.relPath === "runbook/shipping-on-gcp.md")!;
    expect(shipping.content).toMatch(/Octogee/i);
    expect(shipping.content).toMatch(/Google Cloud|GCP/i);
    expect(shipping.content).toMatch(/Firebase Hosting/i);
    expect(shipping.content).toContain("octogee-{workspaceSlug}-{projectSlug}.web.app");
    expect(shipping.content).toMatch(/Every merge ships/i);
    expect(shipping.content).toMatch(/preview/i);
    expect(shipping.content).toMatch(/secrets/i);
  });

  it("keeps platform doctrine out of the project seeds and points back to the workspace Platform Playbook", () => {
    const all = seeds().map((s) => s.content).join("\n");
    expect(all).toMatch(/Platform Playbook/i);
    expect(all).not.toMatch(/glm-controller/i);
    expect(all).not.toMatch(/gateway pod lifecycle/i);
  });
});

describe("notesWelcomeSeed", () => {
  const seed = () => notesWelcomeSeed("Wild Card");

  it("seeds a flat welcome note (never README — it would pollute the rail label)", () => {
    expect(seed().relPath).toBe("notes/welcome.md");
  });

  it("explains the scratch convention and the promotion ritual in the scope's own name", () => {
    const content = seed().content;
    expect(content).toContain("Wild Card");
    expect(content).toMatch(/scratch|half-formed|thinking/i);
    expect(content).toMatch(/promote|graduate|decisions log/i);
  });

  it("invites deletion — a welcome note is not canon", () => {
    expect(seed().content).toMatch(/delete/i);
  });
});
