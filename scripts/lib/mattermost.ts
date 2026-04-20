/**
 * Octogee Provisioner — Mattermost Integration (barrel).
 *
 * Thin re-export layer over the per-concern modules in `mattermost/`:
 *
 *   mattermost/client.ts           — getMmAdminToken + mmApiCall
 *   mattermost/channel-members.ts  — customerChannelMembers (pure, tested)
 *   mattermost/channels.ts         — createOrRestoreChannel (internal) +
 *                                    createProjectChannel
 *   mattermost/community.ts        — COMMUNITY_CHANNELS, communityChannelIds,
 *                                    ensureCommunityChannels
 *   mattermost/coach-pat.ts        — mintAndPersistCoachToken + deps type
 *   mattermost/avatars.ts          — mmUploadAvatar
 *   mattermost/provision.ts        — provisionMattermostUser (the big one)
 *   mattermost/admin-creds.ts      — ensureAdminCredentials
 *   mattermost/profile-sync.ts     — syncProfileToMattermost +
 *                                    syncCoachProfileToMattermost
 *   mattermost/nuke.ts             — destroyMmUser, destroyMmChannel,
 *                                    getMmUserChannels
 *
 * Keeping this barrel at `scripts/lib/mattermost.ts` lets every existing
 * importer (collaboration, milestones, nukeSteps, provisionSteps, the
 * coach-token + channel-members specs, local-provisioner) keep their
 * `from "./mattermost.js"` / `from "../lib/mattermost.js"` paths.
 */

export { getMmAdminToken, mmApiCall } from "./mattermost/client.js";

export type {
  CustomerChannelKind,
  CustomerChannelMemberIds,
} from "./mattermost/channel-members.js";
export { customerChannelMembers } from "./mattermost/channel-members.js";

export {
  createOrRestoreChannel,
  createProjectChannel,
} from "./mattermost/channels.js";

export {
  COMMUNITY_CHANNELS,
  communityChannelIds,
  ensureCommunityChannels,
} from "./mattermost/community.js";

export type { CoachPatMintDeps } from "./mattermost/coach-pat.js";
export {
  COACH_PAT_DESCRIPTION,
  mintAndPersistCoachToken,
} from "./mattermost/coach-pat.js";

export { mmUploadAvatar } from "./mattermost/avatars.js";

export { provisionMattermostUser } from "./mattermost/provision.js";

export { ensureAdminCredentials } from "./mattermost/admin-creds.js";

export {
  syncProfileToMattermost,
  syncCoachProfileToMattermost,
} from "./mattermost/profile-sync.js";

export {
  destroyMmUser,
  destroyMmChannel,
  getMmUserChannels,
} from "./mattermost/nuke.js";
