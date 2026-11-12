import { describe, expect, it } from "vitest";
import * as mattermost from "./mattermost.js";

describe("mattermost public barrel", () => {
  it("exports the Mattermost runtime surface used by scripts and services", () => {
    expect(mattermost).toEqual(expect.objectContaining({
      USER_PAT_DESCRIPTION: expect.any(String),
      DEFAULT_AGENT_PAT_DESCRIPTION: expect.any(String),
      userChannelMembers: expect.any(Function),
      createProjectChannel: expect.any(Function),
      destroyMmChannel: expect.any(Function),
      destroyMmUser: expect.any(Function),
      ensureAdminCredentials: expect.any(Function),
      getMmAdminToken: expect.any(Function),
      getMmUserChannels: expect.any(Function),
      mintAndPersistDefaultAgentToken: expect.any(Function),
      mmApiCall: expect.any(Function),
      mmUploadAvatar: expect.any(Function),
      provisionMattermostUser: expect.any(Function),
      revokeAndMintUserPat: expect.any(Function),
      syncDefaultAgentProfileToMattermost: expect.any(Function),
      syncProfileToMattermost: expect.any(Function),
    }));
  });
});
