import { describe, expect, it } from "vitest";
import "./firebase-offline.js";
import { auth, db, FieldValue, Timestamp } from "../../../gateway-edge/src/lib/db.js";

describe("firebase offline test setup", () => {
  it("installs inert Firebase surfaces for the non-emulator unit suite", async () => {
    await expect(auth.verifyIdToken("unit-token")).resolves.toEqual({ uid: "hermetic-uid" });
    await expect(db.doc("users/alice").get()).resolves.toMatchObject({
      exists: false,
    });
    expect(FieldValue.increment(3)).toEqual({ __op: "increment", value: 3 });
    expect(Timestamp.fromDate(new Date(123)).toMillis()).toBe(123);
  });
});
