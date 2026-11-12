export { getMmAdminToken, mmApiCall } from "./mattermost/client.js";

export type {
  UserChannelKind,
  UserChannelMemberIds,
} from "./mattermost/channel-members.js";
export { userChannelMembers } from "./mattermost/channel-members.js";

export { createProjectChannel } from "./mattermost/channels.js";

export type { DefaultAgentPatMintDeps } from "./mattermost/default-agent-pat.js";
export {
  DEFAULT_AGENT_PAT_DESCRIPTION,
  mintAndPersistDefaultAgentToken,
} from "./mattermost/default-agent-pat.js";

export type { UserPatRotateDeps, UserPatRotateResult } from "./mattermost/user-pat.js";
export {
  USER_PAT_DESCRIPTION,
  revokeAndMintUserPat,
} from "./mattermost/user-pat.js";

export { mmUploadAvatar } from "./mattermost/avatars.js";

export { provisionMattermostUser } from "./mattermost/provision.js";

export { ensureAdminCredentials } from "./mattermost/admin-creds.js";

export {
  syncProfileToMattermost,
  syncDefaultAgentProfileToMattermost,
} from "./mattermost/profile-sync.js";

export {
  destroyMmUser,
  destroyMmChannel,
  getMmUserChannels,
} from "./mattermost/nuke.js";
