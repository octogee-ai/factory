/**
 * Workspace file path validation.
 *
 * Prevents path traversal, null byte injection, and other shenanigans
 * before paths reach GitHub API or GCS.
 */

// Only allow: alphanumeric, hyphen, underscore, dot, forward slash, space
// No: .., //, null bytes, backslashes, control chars, leading slashes
const SAFE_PATH_RE = /^[a-zA-Z0-9\-_./\s]+$/;

/**
 * Validate a workspace file path. Returns null if valid, or an error message.
 */
export function validateFilePath(filePath: string): string | null {
  if (!filePath || typeof filePath !== "string") {
    return "Path is required";
  }

  const trimmed = filePath.trim();

  if (trimmed.length === 0) {
    return "Path is empty";
  }

  if (trimmed.length > 500) {
    return "Path too long (max 500 chars)";
  }

  // Absolute paths
  if (trimmed.startsWith("/")) {
    return "Absolute paths not allowed";
  }

  // Null bytes
  if (trimmed.includes("\0")) {
    return "Null bytes not allowed";
  }

  // Path traversal
  if (trimmed.includes("..")) {
    return "Path traversal (..) not allowed";
  }

  // Double slashes
  if (trimmed.includes("//")) {
    return "Double slashes not allowed";
  }

  // Backslashes (Windows-style paths)
  if (trimmed.includes("\\")) {
    return "Backslashes not allowed";
  }

  // Only safe characters
  if (!SAFE_PATH_RE.test(trimmed)) {
    return "Path contains invalid characters";
  }

  return null; // valid
}
