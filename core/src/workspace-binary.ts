export const WORKSPACE_BINARY_SNIFF_BYTES = 8000;

export const MAX_WORKSPACE_BINARY_BYTES = 100 * 1024 * 1024;

const NEVER_DIVERT_PREFIXES = [".blobs/", ".files/", ".git/"];

export function looksLikeWorkspaceBinary(sample: Uint8Array): boolean {
  return sample.subarray(0, WORKSPACE_BINARY_SNIFF_BYTES).includes(0);
}

export function isDivertableWorkspacePath(relativePath: string): boolean {
  if (relativePath.length === 0 || relativePath.startsWith("/")) return false;
  if (relativePath.split("/").includes("..")) return false;
  return !NEVER_DIVERT_PREFIXES.some((prefix) => relativePath.startsWith(prefix));
}
