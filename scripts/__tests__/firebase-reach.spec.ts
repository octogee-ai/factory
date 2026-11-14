import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { firebaseReach, firebaseReachReport, runtimeSpecifiers } from "../lib/firebase-reach.js";

const cloudRoot = resolve(import.meta.dirname, "../..");

describe("Firebase reach ratchet", () => {
  const report = firebaseReachReport(cloudRoot);

  it("lets no new file reached from a platform entrypoint load Firebase", () => {
    expect(report.newFiles, "these files newly load firebase-admin or a Firebase handle from a platform entrypoint; platform code must not gain Firebase use").toEqual([]);
  });

  it("drops files that no longer load Firebase so the count only falls", () => {
    expect(report.staleFiles, "these files no longer load Firebase; remove them from scripts/lib/firebase-reach.json").toEqual([]);
  });
});

describe("runtimeSpecifiers", () => {
  it("counts value, side-effect, dynamic and re-export imports", () => {
    expect(runtimeSpecifiers([
      'import { FieldValue, type Firestore } from "firebase-admin/firestore";',
      'import "./side-effect.js";',
      'const { getStorage } = await import("firebase-admin/storage");',
      'export { db } from "./db.js";',
    ].join("\n")).sort()).toEqual(["./db.js", "./side-effect.js", "firebase-admin/firestore", "firebase-admin/storage"]);
  });

  it("skips type-only imports and re-exports, even across lines", () => {
    expect(runtimeSpecifiers([
      "import type {",
      "  Firestore,",
      '} from "firebase-admin/firestore";',
      'export type { Auth } from "firebase-admin/auth";',
      'import { exportedValue } from "./values.js";',
    ].join("\n"))).toEqual(["./values.js"]);
  });
});

describe("firebaseReach", () => {
  let root: string | undefined;

  afterEach(() => {
    if (root) rmSync(root, { recursive: true, force: true });
    root = undefined;
  });

  function tree(files: Record<string, string>): string {
    root = mkdtempSync(join(tmpdir(), "firebase-reach-"));
    for (const [file, source] of Object.entries(files)) {
      mkdirSync(dirname(join(root, file)), { recursive: true });
      writeFileSync(join(root, file), source);
    }
    return root;
  }

  it("lists reachable files that load firebase-admin or a handle module at runtime", () => {
    const fixture = tree({
      "api/src/main.ts": [
        'import "./uses-handle.js";',
        'import "./types-only.js";',
        'import "./plain.js";',
        'import "./dynamic.js";',
      ].join("\n"),
      "api/src/uses-handle.ts": 'import { db } from "../../edge/src/db.js";\nexport const users = db;',
      "api/src/types-only.ts": 'import type { Firestore } from "firebase-admin/firestore";\nexport type Db = Firestore;',
      "api/src/plain.ts": "export const plain = 1;",
      "api/src/dynamic.ts": 'export const bucket = async () => (await import("firebase-admin/storage")).getStorage();',
      "edge/src/db.ts": 'import { getFirestore } from "firebase-admin/firestore";\nexport const db = getFirestore();',
      "edge/src/unreached.ts": 'import { getAuth } from "firebase-admin/auth";',
    });

    expect(firebaseReach(fixture, ["api/src/main.ts"], ["edge/src/db.ts"])).toEqual([
      "api/src/dynamic.ts",
      "api/src/uses-handle.ts",
      "edge/src/db.ts",
    ]);
  });
});
