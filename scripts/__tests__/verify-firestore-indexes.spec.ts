import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

import {
  compareCompositeIndexes,
  verifyFirestoreIndexesMain,
} from "../ops/verify-firestore-indexes.mjs";

const expected = {
  indexes: [
    {
      collectionGroup: "posts",
      queryScope: "COLLECTION",
      fields: [
        { fieldPath: "authorUid", order: "ASCENDING" },
        { fieldPath: "updatedAt", order: "DESCENDING" },
      ],
    },
  ],
};

const ready = [
  {
    name: "projects/test/databases/(default)/collectionGroups/posts/indexes/one",
    queryScope: "COLLECTION",
    fields: [
      { fieldPath: "authorUid", order: "ASCENDING" },
      { fieldPath: "updatedAt", order: "DESCENDING" },
      { fieldPath: "__name__", order: "DESCENDING" },
    ],
    state: "READY",
  },
];

describe("Firestore composite index verification", () => {
  it("matches deployed indexes while ignoring Firestore's implicit __name__ field", () => {
    expect(compareCompositeIndexes(expected, ready)).toEqual({
      missing: [],
      unready: [],
    });
  });

  it("distinguishes missing and non-ready declared indexes", () => {
    expect(compareCompositeIndexes(expected, [])).toEqual({
      missing: ["posts(authorUid ASCENDING, updatedAt DESCENDING)"],
      unready: [],
    });
    expect(compareCompositeIndexes(expected, [{ ...ready[0], state: "CREATING" }])).toEqual({
      missing: [],
      unready: ["posts(authorUid ASCENDING, updatedAt DESCENDING) [CREATING]"],
    });
  });

  it("queries the selected project and fails loud when a declared index is absent", async () => {
    const temp = mkdtempSync(path.join(tmpdir(), "firestore-index-verify-"));
    try {
      const configPath = path.join(temp, "indexes.json");
      const actualPath = path.join(temp, "actual.json");
      const callLog = path.join(temp, "calls.log");
      const gcloud = path.join(temp, "gcloud");
      writeFileSync(configPath, JSON.stringify(expected));
      writeFileSync(actualPath, "[]");
      writeFileSync(callLog, "");
      writeFileSync(
        gcloud,
        `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$*" >> "$FAKE_GCLOUD_LOG"
cat "$FAKE_INDEXES"
`,
      );
      chmodSync(gcloud, 0o755);

      await expect(
        verifyFirestoreIndexesMain(
          [
            "--project=octogee-data-test",
            `--config=${configPath}`,
          ],
          {
            ...process.env,
            PATH: `${temp}:${process.env.PATH}`,
            FAKE_GCLOUD_LOG: callLog,
            FAKE_INDEXES: actualPath,
            FIRESTORE_INDEX_VERIFY_MAX_ATTEMPTS: "1",
            FIRESTORE_INDEX_VERIFY_RETRY_SECONDS: "0",
          },
        ),
      ).rejects.toThrow(/missing posts\(authorUid ASCENDING, updatedAt DESCENDING\)/);

      const result = spawnSync("cat", [callLog], { encoding: "utf8" });
      expect(result.stdout).toContain(
        "firestore indexes composite list --project=octogee-data-test --database=(default) --format=json",
      );
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  });
});
