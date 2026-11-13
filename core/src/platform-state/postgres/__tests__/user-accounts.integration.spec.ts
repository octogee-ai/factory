import { describe, expect, it } from "vitest";
import { AlreadyExistsError, DuplicateRecordError, MissingRecordError } from "../../errors.js";
import { NOW, REVISION, useUserFixture } from "./fixtures/users.js";
import { dsn } from "./fixtures/harness.js";

describe.skipIf(!dsn)("PostgreSQL user accounts", () => {
  const fixture = useUserFixture();

  it("stores an account for an existing user and reads it back one, many and all", async () => {
    const { users, admitted } = fixture();
    await admitted("ada");
    await admitted("bob");
    await users.accounts.create({ uid: "ada", name: "ada", email: "ada@example.test", createdAt: NOW });
    await users.accounts.create({ uid: "bob", name: "bob", email: "bob@example.test", createdAt: { serverNow: true } });

    const ada = { uid: "ada", name: "ada", email: "ada@example.test", createdAt: NOW, revision: expect.stringMatching(REVISION) };
    expect(await users.accounts.get("ada")).toEqual(ada);
    expect(await users.accounts.get("nobody")).toBeNull();
    const many = await users.accounts.getMany(["ada", "nobody", "ada"]);
    expect([...many.keys()]).toEqual(["ada"]);
    expect(many.get("ada")).toEqual(ada);
    expect(await users.accounts.getMany([])).toEqual(new Map());
    const all = await users.accounts.listAll();
    expect(all.map((account) => account.uid)).toEqual(["ada", "bob"]);
    expect(all[1]!.createdAt).toBeGreaterThan(NOW);
  });

  it("names the field another account already holds", async () => {
    const { users, admitted } = fixture();
    await admitted("ada");
    await admitted("bob");
    await users.accounts.create({ uid: "ada", name: "ada", email: "ada@example.test", createdAt: NOW });

    await expect(users.accounts.create({ uid: "bob", name: "ada", email: "bob@example.test", createdAt: NOW }))
      .rejects.toMatchObject({ constructor: DuplicateRecordError, aggregate: "user-account", lookup: "name" });
    await expect(users.accounts.create({ uid: "bob", name: "bob", email: "ada@example.test", createdAt: NOW }))
      .rejects.toMatchObject({ constructor: DuplicateRecordError, aggregate: "user-account", lookup: "email" });
    await expect(users.accounts.create({ uid: "ada", name: "ada2", email: "ada2@example.test", createdAt: NOW }))
      .rejects.toBeInstanceOf(AlreadyExistsError);
  });

  it("refuses an account without a user record, and an email that is not lower case", async () => {
    const { users, admitted } = fixture();

    await expect(users.accounts.create({ uid: "ghost", name: "ghost", email: "ghost@example.test", createdAt: NOW }))
      .rejects.toMatchObject({ constructor: MissingRecordError, record: { aggregate: "builder", key: "ghost" } });
    await admitted("ada");
    await expect(users.accounts.create({ uid: "ada", name: "ada", email: "Ada@example.test", createdAt: NOW })).rejects.toThrow();
  });

  it("drops the account with its user record", async () => {
    const { users, records, admitted } = fixture();
    await admitted("ada");
    await users.accounts.create({ uid: "ada", name: "ada", email: "ada@example.test", createdAt: NOW });

    await records.delete("ada");

    expect(await users.accounts.get("ada")).toBeNull();
  });

  it("creates the account in the same transaction that admits the user", async () => {
    const { store, users } = fixture();
    await expect(store.transaction({ label: "add-user" }, async (tx) => {
      await tx.users.records.admit("ada", { slug: "ada", persona: null, createdAt: NOW, provisioningStartedAt: NOW });
      await tx.users.accounts.create({ uid: "ada", name: "ada", email: "ada@example.test", createdAt: NOW });
      throw new Error("abandon");
    })).rejects.toThrow("abandon");

    expect(await users.accounts.get("ada")).toBeNull();
    expect(await users.records.get("ada")).toBeNull();
  });
});
