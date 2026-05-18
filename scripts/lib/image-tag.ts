/**
 * Canonical gateway image-tag shape — the single source of truth shared by
 * the rollout validator (admin-fleet-router) and the recent-builds list
 * filter (artifact-registry). They must accept identical tags or the
 * Cowboy picker and manual SHA entry disagree. Operator-trusted: a
 * lowercase hex git SHA, optionally `-oc<freeform>` — e.g. -oc2026.5.12,
 * -oc2026.5.12-diag, -oc2026.5.16-beta.6. Still rejects non-hex/uppercase.
 */
export const IMAGE_TAG_PATTERN = /^[a-f0-9]{7,40}(-oc[a-z0-9][a-z0-9.-]*)?$/;
