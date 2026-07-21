import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = resolve(import.meta.dirname, "../..");

function script(name: string): string {
  return readFileSync(resolve(repoRoot, "scripts", name), "utf8");
}

describe("environment bootstrap JSON parsing", () => {
  it.each(["setup-gitea.sh", "setup-mattermost.sh"])(
    "%s parses API responses from a private temporary file",
    (name) => {
      const source = script(name);

      expect(source).toContain("json_file=$(mktemp)");
      expect(source).toContain('chmod 600 "$json_file"');
      expect(source).toContain('rm -f "$json_file"');
      expect(source).not.toContain("json.load(sys.stdin)");
    },
  );

  it("keeps the Mattermost refresh path idempotent after a partial bootstrap", () => {
    const source = script("setup-mattermost.sh");

    expect(source).toMatch(/^mm_pat_is_valid\(\) \{/m);
    expect(source).toMatch(/^ensure_mm_team\(\) \{/m);
    expect(source.match(/^\s+ensure_mm_team$/gm)).toHaveLength(2);
  });

  it("reports Gitea org reachability from the completed bootstrap request", () => {
    const source = script("setup-gitea.sh");

    expect(source).toContain('status "Org \'octogee\' reachable" "$ORG_REACHABLE"');
    expect(source).not.toMatch(/status "Org 'octogee' reachable" "\$\(curl/);
  });
});
