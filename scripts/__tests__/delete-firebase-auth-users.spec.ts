import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  deleteAllFirebaseAuthUsers,
  serviceAccountForProject,
} from "../ops/delete-firebase-auth-users.js";

describe("deleteAllFirebaseAuthUsers", () => {
  it("uses application default credentials when no explicit service account is supplied", () => {
    const source = readFileSync(
      path.resolve(__dirname, "../ops/delete-firebase-auth-users.ts"),
      "utf8",
    );

    expect(source).toContain("applicationDefault");
    expect(source).toContain(": applicationDefault()");
  });

  it("collects every page before deleting users in Admin SDK-sized batches", async () => {
    const listedPageTokens: Array<string | undefined> = [];
    const deletedBatches: string[][] = [];
    let listingComplete = false;
    const auth = {
      listUsers: async (_maxResults: number, pageToken?: string) => {
        listedPageTokens.push(pageToken);
        if (listingComplete) return { users: [] };
        if (!pageToken) {
          return {
            users: [{ uid: "one" }, { uid: "two" }],
            pageToken: "next-page",
          };
        }
        listingComplete = true;
        return { users: [{ uid: "three" }] };
      },
      deleteUsers: async (uids: string[]) => {
        deletedBatches.push(uids);
        return { failureCount: 0 };
      },
    };

    await expect(deleteAllFirebaseAuthUsers(auth)).resolves.toBe(3);
    expect(listedPageTokens).toEqual([undefined, "next-page", undefined]);
    expect(deletedBatches).toEqual([["one", "two", "three"]]);
  });

  it("fails rather than claiming a complete reset when any batch deletion fails", async () => {
    const auth = {
      listUsers: async () => ({ users: [{ uid: "one" }] }),
      deleteUsers: async () => ({ failureCount: 1 }),
    };

    await expect(deleteAllFirebaseAuthUsers(auth)).rejects.toThrow(
      "Firebase Auth deletion failed for 1 user(s)",
    );
  });

  it("fails rather than claiming a complete reset when a user remains after deletion", async () => {
    let listCount = 0;
    const auth = {
      listUsers: async () => {
        listCount += 1;
        return listCount === 1
          ? { users: [{ uid: "one" }] }
          : { users: [{ uid: "residual" }] };
      },
      deleteUsers: async () => ({ failureCount: 0 }),
    };

    await expect(deleteAllFirebaseAuthUsers(auth)).rejects.toThrow(
      "Firebase Auth still contains users after deletion",
    );
  });

  it("rejects a service account from another Firebase project before any Auth mutation", () => {
    expect(() => serviceAccountForProject({
      project_id: "octogee-data-prod",
      client_email: "teardown@octogee-data-prod.iam.gserviceaccount.com",
      private_key: "private-key",
    }, "octogee-data-test")).toThrow(
      "service-account project does not match octogee-data-test",
    );
  });
});
