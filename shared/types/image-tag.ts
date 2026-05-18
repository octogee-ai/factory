/**
 * Canonical gateway image-tag shape — the ONE source of truth shared by
 * every validation/filter site: the rollout validator + recent-builds
 * list (workspace-api / scripts admin-fleet-router + artifact-registry)
 * and the Cowboy build-picker guard (app BuildPicker). They must accept
 * identical tags or the picker, the manual-entry field, and the server
 * disagree (this regex has been duplicated and drifted three times).
 *
 * Operator-trusted: a lowercase hex git SHA, optionally `-oc<freeform>` —
 * e.g. `a9f521f`, `a9f521f-oc2026.5.12`, `a9f521f-oc2026.5.12-diag`,
 * `a9f521f-oc2026.5.16-beta.6`. Still rejects non-hex / uppercase SHAs.
 */
export const IMAGE_TAG_PATTERN = /^[a-f0-9]{7,40}(-oc[a-z0-9][a-z0-9.-]*)?$/;
