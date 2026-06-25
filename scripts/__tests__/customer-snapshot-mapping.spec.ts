import { describe, it, expect } from "vitest";
import {
  byotSystemConfigFromDoc,
  deriveSlug,
  mapUserDocToSnapshot,
  mapWorkspaceChannelDoc,
  mapProjectChannelDoc,
} from "../lib/customer-snapshot-mapping.js";

describe("deriveSlug", () => {
  it("prefers provisioning.openclaw.slug, falls back to username", () => {
    expect(deriveSlug("u", { provisioning: { openclaw: { slug: "fromOC" } }, username: "fromName" })).toBe("fromOC");
    expect(deriveSlug("u", { username: "fromName" })).toBe("fromName");
  });
  it("throws (identifiable message) when neither is set — orchestrator must not proceed", () => {
    expect(() => deriveSlug("u9", { tier: "pro" })).toThrow(
      /\[load:u9\] cannot derive slug/,
    );
  });
});

describe("mapUserDocToSnapshot — users/{uid} doc → UserSnapshot", () => {
  const ch: never[] = [];

  it("maps a fully-populated doc verbatim", () => {
    const snap = mapUserDocToSnapshot(
      "u1",
      {
        username: "acme",
        displayName: "Acme Inc",
        tier: "pro",
        mattermost: { userId: "mm-1" },
        provisioning: {
          openclaw: {
            slug: "acme",
            gatewayId: "gw-3",
            status: "complete",
            agentIds: ["octogee-acme-coach"],
            greeting: { ok: true },
          },
          git: { repoUrl: "git@x:acme.git" },
        },
      },
      ch,
    );
    expect(snap).toEqual({
      uid: "u1",
      slug: "acme",
      tier: "pro",
      gatewayId: "gw-3",
      status: "complete",
      agentIds: ["octogee-acme-coach"],
      repoUrl: "git@x:acme.git",
      mattermostUserId: "mm-1",
      greetingPosted: true,
      channels: ch,
      ownerName: "Acme Inc",
      byotActive: false,
    });
  });

  it("byotActive mirrors Boolean(data.byotActive) — the mount re-assert reads it to avoid clobbering BYOT", () => {
    expect(mapUserDocToSnapshot("u", { username: "a", byotActive: true }, ch).byotActive).toBe(true);
    expect(mapUserDocToSnapshot("u", { username: "a", byotActive: false }, ch).byotActive).toBe(false);
    expect(mapUserDocToSnapshot("u", { username: "a" }, ch).byotActive).toBe(false);
  });

  it("tier fallback chain: tier → subscription.tier → 'trial'", () => {
    expect(mapUserDocToSnapshot("u", { username: "a", tier: "pro" }, ch).tier).toBe("pro");
    expect(mapUserDocToSnapshot("u", { username: "a", subscription: { tier: "team" } }, ch).tier).toBe("team");
    expect(mapUserDocToSnapshot("u", { username: "a" }, ch).tier).toBe("trial");
  });

  it("ownerName fallback: displayName → username → slug", () => {
    expect(mapUserDocToSnapshot("u", { username: "acme", displayName: "Acme" }, ch).ownerName).toBe("Acme");
    expect(mapUserDocToSnapshot("u", { username: "acme" }, ch).ownerName).toBe("acme");
    expect(mapUserDocToSnapshot("u", { provisioning: { openclaw: { slug: "sluggy" } } }, ch).ownerName).toBe("sluggy");
  });

  it("defaults: gatewayId '', status '', agentIds [], repoUrl '', mattermostUserId null, greetingPosted false", () => {
    const s = mapUserDocToSnapshot("u", { username: "a" }, ch);
    expect(s.gatewayId).toBe("");
    expect(s.status).toBe("");
    expect(s.agentIds).toEqual([]);
    expect(s.repoUrl).toBe("");
    expect(s.mattermostUserId).toBeNull();
    expect(s.greetingPosted).toBe(false);
  });

  it("greetingPosted is Boolean(openclaw.greeting.ok) — false when ok:false or absent", () => {
    expect(mapUserDocToSnapshot("u", { username: "a", provisioning: { openclaw: { greeting: { ok: false } } } }, ch).greetingPosted).toBe(false);
    expect(mapUserDocToSnapshot("u", { username: "a", provisioning: { openclaw: { greeting: {} } } }, ch).greetingPosted).toBe(false);
  });

  it("passes channels through unchanged and throws on no-slug", () => {
    const channels = [{ scope: "workspace" as const, kind: "general", channelId: "C1" }];
    expect(mapUserDocToSnapshot("u", { username: "a" }, channels).channels).toBe(channels);
    expect(() => mapUserDocToSnapshot("u2", {}, ch)).toThrow(/cannot derive slug/);
  });
});

describe("channel-doc shaping (workspaces/{slug} producer → UserSnapshot.channels consumer)", () => {
  it("workspace channel: requires mattermost.channelId; kind defaults to 'general'", () => {
    expect(mapWorkspaceChannelDoc({ kind: "files", mattermost: { channelId: "C1" } })).toEqual({
      scope: "workspace",
      kind: "files",
      channelId: "C1",
    });
    expect(mapWorkspaceChannelDoc({ mattermost: { channelId: "C2" } })).toEqual({
      scope: "workspace",
      kind: "general",
      channelId: "C2",
    });
    expect(mapWorkspaceChannelDoc({ kind: "files" })).toBeNull(); 
  });

  it("project channel: requires mattermost.channelId; carries projectId; kind defaults to 'default'", () => {
    expect(mapProjectChannelDoc("p1", { mattermost: { channelId: "C3" } })).toEqual({
      scope: "project",
      projectId: "p1",
      kind: "default",
      channelId: "C3",
    });
    expect(mapProjectChannelDoc("p1", { kind: "x" })).toBeNull();
  });
});

describe("byotSystemConfigFromDoc — users/{uid}/system/config → snapshot.systemConfig", () => {
  it("projects the byot provider/baseUrl/model the in-pod re-assert needs", () => {
    expect(
      byotSystemConfigFromDoc({ byot: { provider: "openai", baseUrl: "https://x", model: "gpt-4o" } }),
    ).toEqual({ byot: { provider: "openai", baseUrl: "https://x", model: "gpt-4o" } });
  });

  it("drops non-string fields and keeps only what is present", () => {
    expect(byotSystemConfigFromDoc({ byot: { provider: "anthropic", model: 123 } })).toEqual({
      byot: { provider: "anthropic" },
    });
  });

  it("returns undefined when there is no usable byot config (so the snapshot stays lean)", () => {
    expect(byotSystemConfigFromDoc(undefined)).toBeUndefined();
    expect(byotSystemConfigFromDoc({})).toBeUndefined();
    expect(byotSystemConfigFromDoc({ byot: {} })).toBeUndefined();
    expect(byotSystemConfigFromDoc({ byot: null as unknown as Record<string, unknown> })).toBeUndefined();
  });
});
