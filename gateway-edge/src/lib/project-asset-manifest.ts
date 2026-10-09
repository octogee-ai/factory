import type { ManifestEntry } from "@octogee/core/workspace-manifest";
export { withProjectAssetManifest } from "@octogee/core/project-asset-state";

export function projectAssetEntry(input: { gcsPath: string; sha256?: string; size: number }, mimeType: string): ManifestEntry {
  if (!input.sha256) throw new Error("project asset upload has no immutable identity");
  return { type: "blob", gcsPath: input.gcsPath, sha256: input.sha256, size: input.size, mimeType, uploadedAt: new Date().toISOString() };
}
