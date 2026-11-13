import { describe, expect, it, vi } from "vitest";
import {
  vmHomePrefix,
  deleteVmHomeObjects,
  type VmHomeBucket,
} from "../lib/user-ops/vm-home";

function mkFile(name: string, fail?: Error) {
  return {
    name,
    delete: vi.fn(async () => {
      if (fail) throw fail;
      return undefined;
    }),
  };
}

function mkBucket(pages: Array<ReturnType<typeof mkFile>[]>): VmHomeBucket & { getFiles: ReturnType<typeof vi.fn> } {
  let page = 0;
  const getFiles = vi.fn(async () => {
    const files = pages[page] ?? [];
    page += 1;
    const nextQuery = page < pages.length ? { pageToken: `page-${page}` } : null;
    return [files, nextQuery] as const;
  });
  return { getFiles };
}

describe("vmHomePrefix", () => {
  it("is the octogee-api checkpoint root for the user slug", () => {
    expect(vmHomePrefix("alice")).toBe("customers/alice/computer-home/");
  });
});

describe("deleteVmHomeObjects", () => {
  it("deletes every checkpoint and the current pointer across pages and counts them", async () => {
    const first = [
      mkFile("customers/alice/computer-home/checkpoints/2026-09-05T10-00-00Z.tar.gz"),
      mkFile("customers/alice/computer-home/checkpoints/2026-09-05T10-30-00Z.tar.gz"),
    ];
    const second = [mkFile("customers/alice/computer-home/current.json")];
    const bucket = mkBucket([first, second]);

    const result = await deleteVmHomeObjects(bucket, "alice");

    expect(result).toEqual({ deleted: 3 });
    expect(bucket.getFiles.mock.calls.map(([query]) => query)).toEqual([
      { prefix: "customers/alice/computer-home/", autoPaginate: false },
      { prefix: "customers/alice/computer-home/", autoPaginate: false, pageToken: "page-1" },
    ]);
    for (const file of [...first, ...second]) {
      expect(file.delete).toHaveBeenCalledWith({ ignoreNotFound: true });
    }
  });

  it("is a clean no-op when the user never checkpointed a home", async () => {
    const bucket = mkBucket([[]]);
    await expect(deleteVmHomeObjects(bucket, "alice")).resolves.toEqual({ deleted: 0 });
    expect(bucket.getFiles).toHaveBeenCalledTimes(1);
  });

  it("fails loudly when one object cannot be deleted", async () => {
    const survivor = mkFile("customers/alice/computer-home/current.json", new Error("storage 403"));
    const bucket = mkBucket([[mkFile("customers/alice/computer-home/checkpoints/a.tar.gz"), survivor]]);
    await expect(deleteVmHomeObjects(bucket, "alice")).rejects.toThrow("storage 403");
  });

  it("refuses an empty slug rather than sweeping the users root", async () => {
    const bucket = mkBucket([[]]);
    await expect(deleteVmHomeObjects(bucket, "")).rejects.toThrow(/slug/);
    expect(bucket.getFiles).not.toHaveBeenCalled();
  });
});
