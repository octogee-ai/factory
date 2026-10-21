import { describe, expect, it } from "vitest";
import { awaitDiskRoom } from "../ci/disk-room.mjs";

const clock = () => {
  let time = 0;
  return { now: () => time, sleep: async (ms: number) => { time += ms; } };
};

describe("awaitDiskRoom", () => {
  it("returns immediately when the runner frees no disk in the background", async () => {
    await expect(awaitDiskRoom(undefined)).resolves.toBeNull();
  });

  it("waits for the background cleanup and returns its disk report", async () => {
    const files = new Map<string, string>();
    const { now, sleep } = clock();
    let polls = 0;
    const exists = (path: string) => {
      if (++polls === 3) files.set("/tmp/room", "0\n").set("/tmp/room.log", "/dev/root 72G 33G 39G\n");
      return files.has(path);
    };
    await expect(awaitDiskRoom("/tmp/room", { exists, read: path => files.get(path) ?? "", now, sleep }))
      .resolves.toBe("/dev/root 72G 33G 39G\n");
    expect(polls).toBeGreaterThanOrEqual(3);
  });

  it("fails loudly when the cleanup exits non-zero", async () => {
    const files = new Map([["/tmp/room", "1\n"], ["/tmp/room.log", "rm: cannot remove\n"]]);
    await expect(awaitDiskRoom("/tmp/room", { exists: path => files.has(path), read: path => files.get(path) ?? "" }))
      .rejects.toThrow(/Disk cleanup failed with status 1[\s\S]*rm: cannot remove/);
  });

  it("fails loudly when the cleanup never finishes", async () => {
    const { now, sleep } = clock();
    await expect(awaitDiskRoom("/tmp/room", { exists: () => false, read: () => "", now, sleep, timeoutMs: 10_000 }))
      .rejects.toThrow(/did not finish within 10s/);
  });
});
