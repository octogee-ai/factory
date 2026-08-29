import { describe, expect, it, vi } from "vitest";

import {
  createGcsManifestStore,
  GENERATION_ABSENT,
  ManifestCorruptError,
  ManifestGenerationConflict,
  manifestObjectPath,
  type Manifest,
  type ManifestStore,
  mutateManifest,
  parseManifest,
  putManifestEntries,
  readManifest,
  removeManifestEntries,
} from "./workspace-manifest.js";

function entry(gcsPath: string, size = 10): Manifest[string] {
  return {
    type: "blob",
    gcsPath,
    size,
    mimeType: "image/png",
    uploadedAt: "2026-08-29T12:10:19.248Z",
  };
}

/** A conditional store with a real generation counter — the precondition is the point. */
function fakeStore(initial?: { contents: string; generation: string }) {
  const state = { current: initial ?? null as { contents: string; generation: string } | null };
  const writes: Array<{ contents: string; ifGenerationMatch: string }> = [];
  const store: ManifestStore = {
    read: async () => (state.current ? { ...state.current } : null),
    write: async (objectPath, contents, ifGenerationMatch) => {
      writes.push({ contents, ifGenerationMatch });
      const expected = state.current ? state.current.generation : GENERATION_ABSENT;
      if (ifGenerationMatch !== expected) throw new ManifestGenerationConflict(objectPath);
      state.current = { contents, generation: String(Number(expected) + 1) };
    },
  };
  return { store, state, writes };
}

describe("manifestObjectPath", () => {
  it("places the manifest beside the blobs it indexes", () => {
    expect(manifestObjectPath("customers/aug29")).toBe("customers/aug29/.files/manifest.json");
    expect(manifestObjectPath("customers/aug29/projects/blog")).toBe(
      "customers/aug29/projects/blog/.files/manifest.json",
    );
  });

  it("tolerates a trailing slash on the prefix", () => {
    expect(manifestObjectPath("customers/aug29/")).toBe("customers/aug29/.files/manifest.json");
  });
});

describe("parseManifest", () => {
  it("rejects malformed entries rather than handing back junk", () => {
    expect(() => parseManifest("p", '{"a.png":{"type":"blob"}}')).toThrow(ManifestCorruptError);
    expect(() => parseManifest("p", '{"a.png":{"type":"blob","gcsPath":"g","size":-1,"mimeType":"m","uploadedAt":"t"}}'))
      .toThrow(ManifestCorruptError);
    expect(() => parseManifest("p", "not json")).toThrow(ManifestCorruptError);
    expect(() => parseManifest("p", "[]")).toThrow(ManifestCorruptError);
  });

  it("accepts a well-formed manifest", () => {
    const parsed = parseManifest("p", JSON.stringify({ "a.png": entry("customers/x/a.png") }));
    expect(parsed["a.png"]).toMatchObject({ type: "blob", gcsPath: "customers/x/a.png" });
  });
});

describe("readManifest", () => {
  it("treats a missing object as an empty manifest", async () => {
    const { store } = fakeStore();
    await expect(readManifest(store, "customers/aug29")).resolves.toEqual({});
  });
});

describe("mutateManifest", () => {
  it("creates the object only if absent", async () => {
    const { store, writes } = fakeStore();
    await putManifestEntries(store, "customers/aug29", { "a.png": entry("customers/aug29/a.png") });
    expect(writes[0].ifGenerationMatch).toBe(GENERATION_ABSENT);
  });

  it("writes against the generation it read", async () => {
    const { store, writes } = fakeStore({ contents: "{}", generation: "7" });
    await putManifestEntries(store, "customers/aug29", { "a.png": entry("customers/aug29/a.png") });
    expect(writes[0].ifGenerationMatch).toBe("7");
  });

  it("skips the write entirely when nothing changed", async () => {
    const { store, writes } = fakeStore({ contents: "{}", generation: "7" });
    await removeManifestEntries(store, "customers/aug29", "absent.png");
    expect(writes).toHaveLength(0);
  });

  it("retries against fresh state on conflict and preserves the other writer's entry", async () => {
    const { store, state } = fakeStore({ contents: "{}", generation: "1" });
    const read = store.read.bind(store);
    let raced = false;
    store.read = async (objectPath) => {
      const result = await read(objectPath);
      if (!raced) {
        // The other writer lands between our read and our write.
        raced = true;
        state.current = {
          contents: JSON.stringify({ "theirs.png": entry("customers/aug29/theirs.png") }),
          generation: "2",
        };
      }
      return result;
    };

    await putManifestEntries(store, "customers/aug29", { "ours.png": entry("customers/aug29/ours.png") });

    const final = JSON.parse(state.current!.contents) as Manifest;
    expect(Object.keys(final).sort()).toEqual(["ours.png", "theirs.png"]);
  });

  it("gives up after exhausting attempts rather than forcing the write", async () => {
    const { store } = fakeStore({ contents: "{}", generation: "1" });
    store.write = async (objectPath) => {
      throw new ManifestGenerationConflict(objectPath);
    };
    await expect(
      mutateManifest(store, "customers/aug29", () => true, 2),
    ).rejects.toBeInstanceOf(ManifestGenerationConflict);
  });
});

describe("createGcsManifestStore", () => {
  it("reads a missing object as null and surfaces other errors", async () => {
    const notFound = Object.assign(new Error("no such object"), { code: 404 });
    const store = createGcsManifestStore({
      file: () => ({
        download: vi.fn().mockRejectedValue(notFound),
        getMetadata: vi.fn().mockRejectedValue(notFound),
        save: vi.fn(),
      }),
    });
    await expect(store.read("p")).resolves.toBeNull();
  });

  it("translates a precondition failure into a generation conflict", async () => {
    const preconditionFailed = Object.assign(new Error("precondition"), { code: 412 });
    const store = createGcsManifestStore({
      file: () => ({
        download: vi.fn(),
        getMetadata: vi.fn(),
        save: vi.fn().mockRejectedValue(preconditionFailed),
      }),
    });
    await expect(store.write("p", "{}", "3")).rejects.toBeInstanceOf(ManifestGenerationConflict);
  });
});
