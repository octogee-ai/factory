/**
 * Re-export of the canonical image-tag pattern. The single definition
 * lives in shared/ so app + workspace-api + scripts share ONE source
 * (see shared/types/image-tag.ts). Kept as a stable scripts/lib path so
 * artifact-registry + admin-fleet-router imports don't churn.
 */
export { IMAGE_TAG_PATTERN } from "../../shared/types/image-tag.js";
