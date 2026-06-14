import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

const repoRoot = path.resolve(__dirname, "../..");

function readTemplate() {
  return JSON.parse(
    readFileSync(path.join(repoRoot, "infra/gateway/openclaw.template.json"), "utf8"),
  );
}

describe("infra/gateway/openclaw.template.json — shared Codex runtime", () => {
  it("uses the guardian (auto-review + workspace-write) Codex posture for shared gateways", () => {
    const template = readTemplate();
    const appServer = template.plugins.entries.codex.config.appServer;

    expect(template.plugins.entries.codex.enabled).toBe(true);
    expect(appServer.approvalPolicy).toBe("on-request");
    expect(appServer.approvalsReviewer).toBe("auto_review");
    expect(appServer.sandbox).toBe("workspace-write");
  });

  it("does not set tools.exec.mode globally, so operator gateways can still override Codex explicitly", () => {
    const template = readTemplate();

    expect(template.tools.exec).toBeUndefined();
  });
});
