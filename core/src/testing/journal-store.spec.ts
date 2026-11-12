import { describe, expect, it } from "vitest";
import { createDocumentFixtureStore } from "./journal-store.js";

describe("journal fixture store user records", () => {
  it("creates a user record and keeps its fields when created again", async () => {
    const store = createDocumentFixtureStore(new Map());
    await store.users.records.create({ uid: "ada", createdAt: 1_000 });
    await store.users.records.patch("ada", { slug: "ada" });
    await store.users.records.create({ uid: "ada", createdAt: 2_000 });

    expect(await store.users.records.get("ada")).toMatchObject({ uid: "ada", createdAt: 2_000, slug: "ada" });
  });

  it("stores and clears a role through patch", async () => {
    const store = createDocumentFixtureStore(new Map());
    await store.users.records.create({ uid: "ada", createdAt: 1_000 });

    await store.users.records.patch("ada", { role: "admin" });
    expect(await store.users.records.getRole("ada")).toBe("admin");

    await store.users.records.patch("ada", { role: { clear: true } });
    expect(await store.users.records.getRole("ada")).toBeNull();
  });

  it("replaces the activated agents of a user", async () => {
    const store = createDocumentFixtureStore(new Map());
    await store.users.records.create({ uid: "ada", createdAt: 1_000 });

    await store.users.records.setActivatedAgents("ada", ["coach", "builder"]);
    await store.users.records.setActivatedAgents("ada", ["coach"]);

    expect((await store.users.records.get("ada"))?.agents.activatedAgents).toEqual(["coach"]);
  });
});
