import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

const repoRoot = path.resolve(__dirname, "../..");

const templateRaw = readFileSync(
  path.join(repoRoot, "infra/gateway/openclaw.template.json"),
  "utf8",
);
const entrypoint = readFileSync(path.join(repoRoot, "infra/gateway/entrypoint.sh"), "utf8");
const deployment = readFileSync(
  path.join(repoRoot, "helm/octogee-gateway/templates/deployment.yaml"),
  "utf8",
);

function macOpsBootstrapBlock(): string {
  const start = deployment.indexOf("mac-ops-bootstrap");
  expect(start).toBeGreaterThan(-1);
  const end = deployment.indexOf("containers:", start);
  expect(end).toBeGreaterThan(start);
  return deployment.slice(start, end);
}

function envsubst(src: string, env: Record<string, string>): string {
  return src.replace(/\$\{([A-Z_][A-Z0-9_]*)\}/g, (_, name: string) => env[name] ?? "");
}

function agentListPlaceholders(): string[] {
  const template = JSON.parse(templateRaw) as { agents: { list: unknown[] } };
  const matches = JSON.stringify(template.agents.list).matchAll(/\$\{([A-Z_][A-Z0-9_]*)\}/g);
  return [...new Set([...matches].map((m) => m[1]))];
}

describe("openclaw.template.json agents.list rendering — no empty-id entry on any render path", () => {
  it("every agents.list placeholder is exported by BOTH render paths (entrypoint.sh AND the mac-ops-bootstrap init container)", () => {
    // openclaw's id-keyed array merge (config/merge-patch.ts) requires a
    // non-empty string id on EVERY base entry; a placeholder that envsubsts to
    // "" on either render path degrades every agents.list patch on that pod to
    // whole-list replacement. This is exactly what happened on customer
    // gateways: the init container rendered without OPERATOR_AGENT_ID set.
    const placeholders = agentListPlaceholders();
    expect(placeholders).toContain("OPERATOR_AGENT_ID");
    const bootstrap = macOpsBootstrapBlock();
    for (const name of placeholders) {
      expect(entrypoint, `entrypoint.sh must export ${name}`).toMatch(
        new RegExp(`export ${name}\\b`),
      );
      expect(bootstrap, `mac-ops-bootstrap init must export ${name}`).toMatch(
        new RegExp(`export ${name}\\b`),
      );
    }
  });

  it("customer (shared, no builder slug) render: every agents.list entry carries a non-empty string id", () => {
    // Mirrors the init container derivation: OPERATOR_AGENT_SLUG falls back to
    // GATEWAY_ID when GATEWAY_BUILDER_SLUG is empty.
    const GATEWAY_ID = "gw-shared-1";
    const OPERATOR_AGENT_SLUG = GATEWAY_ID;
    const rendered = JSON.parse(
      envsubst(templateRaw, {
        GATEWAY_ID,
        OPERATOR_AGENT_SLUG,
        OPERATOR_AGENT_ID: `octogee-ops-${OPERATOR_AGENT_SLUG}`,
      }),
    ) as { agents: { list: Array<{ id?: unknown }> } };
    expect(rendered.agents.list.length).toBeGreaterThan(0);
    for (const entry of rendered.agents.list) {
      expect(typeof entry.id).toBe("string");
      expect((entry.id as string).length).toBeGreaterThan(0);
    }
    expect(rendered.agents.list[0].id).toBe("octogee-ops-gw-shared-1");
  });

  it("operator (builder-slug) render is unchanged: the id stays builder-stable across blue/green gatewayIds", () => {
    const rendered = JSON.parse(
      envsubst(templateRaw, {
        GATEWAY_ID: "gw-bender-green",
        OPERATOR_AGENT_SLUG: "bender",
        OPERATOR_AGENT_ID: "octogee-ops-bender",
      }),
    ) as { agents: { list: Array<{ id?: unknown; name?: unknown }> } };
    expect(rendered.agents.list[0].id).toBe("octogee-ops-bender");
    expect(rendered.agents.list[0].name).toBe("Mac (bender)");
  });
});
