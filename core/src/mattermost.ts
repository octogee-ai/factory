export { getMmAdminToken, mmApiCall } from "./mattermost/client.js";

export type {
  CustomerChannelKind,
  CustomerChannelMemberIds,
} from "./mattermost/channel-members.js";
export { customerChannelMembers } from "./mattermost/channel-members.js";

export { createProjectChannel } from "./mattermost/channels.js";

export {
  COMMUNITY_CHANNELS,
  COMMUNITY_TEAM_NAME,
  joinCommunityMembership,
} from "./mattermost/community.js";

export type { CoachPatMintDeps } from "./mattermost/coach-pat.js";
export {
  COACH_PAT_DESCRIPTION,
  mintAndPersistCoachToken,
} from "./mattermost/coach-pat.js";

export type { BuilderPatRotateDeps, BuilderPatRotateResult } from "./mattermost/builder-pat.js";
export {
  BUILDER_PAT_DESCRIPTION,
  revokeAndMintBuilderPat,
} from "./mattermost/builder-pat.js";

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
