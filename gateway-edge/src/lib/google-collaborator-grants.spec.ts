import { describe, expect, it } from "vitest";
import {
  googleGrantAllows,
  parseGoogleGrantPermissions,
} from "./google-collaborator-grants.js";
const permission = {
  operation: "/google/drive/read",
  resourceIds: ["file-a"],
};
const grant = {
  schemaVersion: 1,
  state: "active",
  ownerUid: "owner",
  memberUid: "member",
  workspaceId: "workspace",
  connectionEpoch: "connection-1",
  membershipEpoch: "membership-1",
  permissions: [permission],
};
const request = {
  ownerUid: "owner",
  memberUid: "member",
  workspaceId: "workspace",
  connectionEpoch: "connection-1",
  membershipEpoch: "membership-1",
  operation: "/google/drive/read",
  resourceId: "file-a" as string | null,
};
describe("persistent Google collaborator grants", () => {
  it("allows repeated use of a scoped standing grant", () => {
    expect(googleGrantAllows(grant, request)).toBe(true);
    expect(googleGrantAllows(grant, request)).toBe(true);
  });
  it.each([
    { ownerUid: "other" },
    { memberUid: "other" },
    { workspaceId: "other" },
    { connectionEpoch: "reconnected" },
    { membershipEpoch: "reinvited" },
    { operation: "/google/gmail/send" },
    { resourceId: "file-b" },
  ])(
    "rejects requests outside the approved identity or resource: %j",
    (change) => {
      expect(googleGrantAllows(grant, { ...request, ...change })).toBe(false);
    },
  );
  it("denies revoked and missing grants", () => {
    expect(googleGrantAllows({ ...grant, state: "revoked" }, request)).toBe(
      false,
    );
    expect(googleGrantAllows(undefined, request)).toBe(false);
  });
  it("does not treat resource-free search as a selected-file read", () => {
    expect(googleGrantAllows(grant, { ...request, resourceId: null })).toBe(
      false,
    );
  });
  it("permits an explicitly approved entire-capability resource scope", () => {
    expect(
      googleGrantAllows(
        { ...grant, permissions: [{ ...permission, resourceIds: "all" }] },
        { ...request, resourceId: "another-file" },
      ),
    ).toBe(true);
  });
  it("rejects unknown operations and unexpected input fields", () => {
    expect(
      parseGoogleGrantPermissions([
        { ...permission, operation: "/google/raw" },
      ]),
    ).toBeNull();
    expect(
      parseGoogleGrantPermissions([{ ...permission, channelIds: [] }]),
    ).toBeNull();
    expect(
      parseGoogleGrantPermissions([{ ...permission, skipApproval: true }]),
    ).toBeNull();
  });
  it("rejects malformed stored permission data", () => {
    expect(
      googleGrantAllows(
        { ...grant, permissions: [{ ...permission, resourceIds: "*" }] },
        request,
      ),
    ).toBe(false);
  });
});
