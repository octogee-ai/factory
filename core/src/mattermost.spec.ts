import { describe, expect, it } from "vitest";
import * as mattermost from "./mattermost.js";

describe("mattermost public barrel", () => {
  it("exports the Mattermost runtime surface used by scripts and services", () => {
    expect(mattermost).toEqual(expect.objectContaining({
      COMMUNITY_CHANNELS: expect.any(Array),
      BUILDER_PAT_DESCRIPTION: expect.any(String),
      COACH_PAT_DESCRIPTION: expect.any(String),
      customerChannelMembers: expect.any(Function),
      createOrRestoreChannel: expect.any(Function),
      createProjectChannel: expect.any(Function),
      destroyMmChannel: expect.any(Function),
      destroyMmUser: expect.any(Function),
      ensureAdminCredentials: expect.any(Function),
      ensureCommunityChannels: expect.any(Function),
      getMmAdminToken: expect.any(Function),
      getMmUserChannels: expect.any(Function),
      mintAndPersistCoachToken: expect.any(Function),
      mmApiCall: expect.any(Function),
      mmUploadAvatar: expect.any(Function),
      provisionMattermostUser: expect.any(Function),
      revokeAndMintBuilderPat: expect.any(Function),
      syncCoachProfileToMattermost: expect.any(Function),
      syncProfileToMattermost: expect.any(Function),
    }));
  });
});
