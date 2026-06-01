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
  it("uses the temporary no-prompt/no-bwrap Codex posture for shared gateways", () => {
    const template = readTemplate();
    const appServer = template.plugins.entries.codex.config.appServer;

    expect(template.plugins.entries.codex.enabled).toBe(true);
    expect(appServer.approvalPolicy).toBe("never");
    expect(appServer.sandbox).toBe("danger-full-access");
  });

  it("does not set tools.exec.mode globally, so operator gateways can still override Codex explicitly", () => {
    const template = readTemplate();

    expect(template.tools.exec).toBeUndefined();
  });
});
