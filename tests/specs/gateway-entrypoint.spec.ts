// infra/gateway/entrypoint.sh runs in every gateway image (standard +
// operator). Operator-only boot steps must be gated on the
// GATEWAY_PROFILE env (threaded by helm from .Values.profile), AND on
// presence of the relevant artifact in the image — so the gate's
// behavior on the cattle image (where the artifact isn't COPYed in) is
// "do nothing," not "fail."
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

const repoRoot = path.resolve(__dirname, "../..");
const entrypoint = readFileSync(
  path.join(repoRoot, "infra/gateway/entrypoint.sh"),
  "utf8",
);

describe("infra/gateway/entrypoint.sh — per-gateway Mac ops bootstrap (#998)", () => {
  it("invokes bootstrap-mac-ops.mjs BEFORE OpenClaw starts so accounts.default.botToken is patched", () => {
    // The Mac ops bootstrap must run AFTER openclaw.json exists (it
    // patches the file) AND BEFORE OpenClaw connects to MM (otherwise
    // OpenClaw uses the shared mac-gw-prod token).
    const bootstrapIdx = entrypoint.indexOf("bootstrap-mac-ops.mjs");
    expect(bootstrapIdx).toBeGreaterThan(-1);
    const openclawStartIdx = entrypoint.indexOf("openclaw gateway run");
    expect(openclawStartIdx).toBeGreaterThan(-1);
    expect(bootstrapIdx).toBeLessThan(openclawStartIdx);
  });

  it("guards on MM_URL + MM_ADMIN_PAT + openclaw.json so a misconfigured pod doesn't even try", () => {
    const bootstrapBlock = entrypoint.slice(
      entrypoint.indexOf("Pre-boot: per-gateway Mac ops"),
      entrypoint.indexOf("bootstrap-mac-ops.mjs") + 200,
    );
    expect(bootstrapBlock).toMatch(/MM_URL/);
    expect(bootstrapBlock).toMatch(/MM_ADMIN_PAT/);
    expect(bootstrapBlock).toMatch(/openclaw\.json/);
  });

  it("invocation is non-fatal so a transient MM error doesn't crash the boot", () => {
    const bootstrapLine = entrypoint
      .split("\n")
      .find((l) => l.includes("bootstrap-mac-ops.mjs"));
    expect(bootstrapLine).toBeTruthy();
    expect(bootstrapLine!).toMatch(/\|\|\s+log/);
  });
});

describe("infra/gateway/entrypoint.sh — operator-profile boot hooks", () => {
  it("invokes the Claude first-run stamper when GATEWAY_PROFILE=operator AND the script exists", () => {
    // Both guards required: profile env (intent) + file exists
    // (defensive against an image that legitimately doesn't ship it,
    // e.g. cattle). Same path the operator Dockerfile COPYs into.
    expect(entrypoint).toMatch(/GATEWAY_PROFILE[^\n]*=[^\n]*"?operator"?/);
    // Canonical path the operator Dockerfile COPYs into.
    expect(entrypoint).toMatch(
      /\/octogee\/infra\/gateway\/stamp-claude-first-run\.mjs/,
    );
    // Invocation must be via `node` (the file is .mjs, not chmod +x).
    expect(entrypoint).toMatch(/node\s+[^\n]*stamp-claude-first-run/);
  });

  it("the stamper is gated by BOTH the env guard AND the file-exists guard (defense in depth — single-guard removal must trip this)", () => {
    // Two guards are load-bearing: removing the file-exists guard
    // breaks cattle (script absent → spurious failure), and removing
    // the profile env guard breaks the COPY-set invariant for any
    // future cattle image that accidentally ships the script. The
    // spec asserts both are present in the same region as the
    // stamper invocation.
    const stamperRegion = entrypoint.match(
      /[\s\S]{0,400}stamp-claude-first-run\.mjs[\s\S]{0,200}/,
    )?.[0];
    expect(stamperRegion).toBeDefined();
    expect(stamperRegion).toMatch(/GATEWAY_PROFILE[\s\S]*operator/);
    // -f guard accepts either inline path or a "$STAMPER"-style indirection
    // (entrypoint uses the variable form to single-source the script path).
    expect(stamperRegion).toMatch(/\[\s*-f\s+/);
  });
});
