import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const script = readFileSync(
  resolve(import.meta.dirname, "../lib/publish-full-sha-image-tag.sh"),
  "utf8",
);

describe("full-SHA image provenance tag", () => {
  it("creates the full tag only from the resolved short-tag digest and rejects a different existing target", () => {
    expect(script).toContain('[[ "$source_sha" =~ ^[a-f0-9]{40}$ ]]');
    expect(script).toContain('source_ref="${repository}/${image}:${source_sha:0:7}"');
    expect(script).toContain('target_ref="${repository}/${image}:${source_sha}"');
    expect(script).toContain('source_digest="$(resolve_digest "$source_ref")"');
    expect(script).toContain('if [ "$target_digest" != "$source_digest" ]');
    expect(script).toContain('gcloud artifacts tags create "$source_sha"');
    expect(script).toContain('--version="$source_digest"');
    expect(script).toContain('target_digest="$(resolve_digest "$target_ref")"');
  });
});
