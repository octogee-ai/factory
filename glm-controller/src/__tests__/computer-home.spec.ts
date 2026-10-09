import { describe, expect, it, vi } from "vitest";
import {
  computerHomePrefix,
  deleteComputerHomeObjects,
  deleteBuilderComputerHome,
  type ComputerHomeBucket,
} from "../lib/customer-ops/computer-home";

function mkFile(name: string, fail?: Error) {
  return {
    name,
    delete: vi.fn(async () => {
      if (fail) throw fail;
      return undefined;
    }),
  };
}

function mkBucket(pages: Array<ReturnType<typeof mkFile>[]>): ComputerHomeBucket & { getFiles: ReturnType<typeof vi.fn> } {
  let page = 0;
  const getFiles = vi.fn(async () => {
    const files = pages[page] ?? [];
    page += 1;
    const nextQuery = page < pages.length ? { pageToken: `page-${page}` } : null;
    return [files, nextQuery] as const;
  });
  return { getFiles };
}

describe("computerHomePrefix", () => {
  it("is the octogee-api checkpoint root for the Builder slug", () => {
    expect(computerHomePrefix("alice")).toBe("customers/alice/computer-home/");
  });
});

describe("deleteComputerHomeObjects", () => {
  it("deletes every checkpoint and the current pointer across pages and counts them", async () => {
    const first = [
      mkFile("customers/alice/computer-home/checkpoints/2026-09-05T10-00-00Z.tar.gz"),
      mkFile("customers/alice/computer-home/checkpoints/2026-09-05T10-30-00Z.tar.gz"),
    ];
    const second = [mkFile("customers/alice/computer-home/current.json")];
    const bucket = mkBucket([first, second]);

    const result = await deleteComputerHomeObjects(bucket, "alice");

    expect(result).toEqual({ deleted: 3 });
    expect(bucket.getFiles.mock.calls.map(([query]) => query)).toEqual([
      { prefix: "customers/alice/computer-home/", autoPaginate: false },
      { prefix: "customers/alice/computer-home/", autoPaginate: false, pageToken: "page-1" },
    ]);
    for (const file of [...first, ...second]) {
      expect(file.delete).toHaveBeenCalledWith({ ignoreNotFound: true });
    }
  });

  it("is a clean no-op when the Builder never checkpointed a home", async () => {
    const bucket = mkBucket([[]]);
    await expect(deleteComputerHomeObjects(bucket, "alice")).resolves.toEqual({ deleted: 0 });
    expect(bucket.getFiles).toHaveBeenCalledTimes(1);
  });

  it("fails loudly when one object cannot be deleted", async () => {
    const survivor = mkFile("customers/alice/computer-home/current.json", new Error("storage 403"));
    const bucket = mkBucket([[mkFile("customers/alice/computer-home/checkpoints/a.tar.gz"), survivor]]);
    await expect(deleteComputerHomeObjects(bucket, "alice")).rejects.toThrow("storage 403");
  });

  it("refuses an empty slug rather than sweeping the customers root", async () => {
    const bucket = mkBucket([[]]);
    await expect(deleteComputerHomeObjects(bucket, "")).rejects.toThrow(/slug/);
    expect(bucket.getFiles).not.toHaveBeenCalled();
  });
});

describe("Builder computer home erasure", () => {
  it("deletes the owner PVC even after disposable gateway records are gone", async () => {
    const deleteHobbyHome = vi.fn(async () => {});
    expect(await deleteBuilderComputerHome({ bucket: mkBucket([[]]), slug: "alice", deleteHobbyHome })).toEqual({ deleted: 0 });
    expect(deleteHobbyHome).toHaveBeenCalledWith("alice");
  });

  it("reports PVC deletion failures and refuses an empty owner slug", async () => {
    const deleteHobbyHome = vi.fn(async () => { throw new Error("kubernetes 403"); });
    await expect(deleteBuilderComputerHome({ bucket: mkBucket([[]]), slug: "alice", deleteHobbyHome })).rejects.toThrow(/403/);
    deleteHobbyHome.mockClear();
    await expect(deleteBuilderComputerHome({ bucket: mkBucket([[]]), slug: "", deleteHobbyHome })).rejects.toThrow(/slug/);
    expect(deleteHobbyHome).not.toHaveBeenCalled();
  });
});
