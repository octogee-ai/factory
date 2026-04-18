/**
 * Project-ID composite-form helpers.
 *
 * Per DATA-MODEL-REVIEW v3, projects are nested at
 * `workspaces/{wid}/projects/{pid}`. Several URL surfaces (invite tokens,
 * entities routes, legacy API callers) still carry the composite form
 * `{wid}_{pid}` as a single string because the URL shape is `:id`, not
 * `:wid/:pid`. These helpers decompose and compose consistently.
 */

export interface ProjectIdParts {
  /** Workspace ID = username. */
  wid: string;
  /** Project slug (user-chosen). */
  pid: string;
}

/**
 * Decompose `{wid}_{pid}` into its parts. Returns null when the shape is
 * wrong (no underscore, leading/trailing underscore, etc.). Callers should
 * 400 on null.
 */
export function decomposeProjectId(id: string): ProjectIdParts | null {
  const idx = id.indexOf("_");
  if (idx < 1 || idx === id.length - 1) return null;
  return { wid: id.slice(0, idx), pid: id.slice(idx + 1) };
}

function composeProjectId(wid: string, pid: string): string {
  return `${wid}_${pid}`;
}
