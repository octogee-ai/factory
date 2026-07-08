#!/usr/bin/env node

// One-shot for the usage-ledger TTL retrofit. Run ONCE per project after the
// retrofit ships (and after configure-firestore-ttls.sh enables the policies):
//   npx tsx scripts/ops/cleanup-usage-ledgers.ts --dry-run
//   npx tsx scripts/ops/cleanup-usage-ledgers.ts --execute
//
//  - deletes every usage_sessions + usage_summary doc (retired collections)
//  - backfills expiresAt on legacy usage_models docs so the TTL policy drains them
//
// Idempotent: re-run is a no-op (nothing left to delete; models already stamped).

import { pathToFileURL } from "node:url";
import {
  RETIRED_USAGE_COLLECTIONS,
  planUsageModelExpiry,
} from "../lib/usage-ledger-cleanup.js";

export type CleanupMode = "dry-run" | "execute";

export function parseCleanupUsageLedgersMode(argv: string[]): CleanupMode | null {
  const dryRun = argv.includes("--dry-run");
  const execute = argv.includes("--execute");
  if (dryRun === execute) return null;
  return dryRun ? "dry-run" : "execute";
}

export const CLEANUP_USAGE_LEDGERS_USAGE =
  "Usage: npx tsx scripts/ops/cleanup-usage-ledgers.ts [--dry-run|--execute]";

// Firestore ref/doc/query/bulkWriter surface used here (real admin SDK at runtime).
interface DocRef {
  delete(): void;
  update(data: Record<string, unknown>): void;
}
interface DocSnap {
  ref: DocRef;
  data(): Record<string, unknown>;
}
interface Query {
  orderBy(field: string): Query;
  startAfter(doc: DocSnap): Query;
  limit(n: number): Query;
  get(): Promise<{ empty: boolean; docs: DocSnap[] }>;
}
interface BulkWriterLike {
  delete(ref: DocRef): unknown;
  update(ref: DocRef, data: Record<string, unknown>): unknown;
  close(): Promise<unknown>;
}
interface FirestoreLike {
  collectionGroup(name: string): Query;
  bulkWriter(): BulkWriterLike;
}

const PAGE_SIZE = 500;

// Page a collection group by document name (stable cursor) so the one-shot
// never pulls a whole large ledger into memory; visit each doc via the callback.
async function pageThrough(
  query: Query,
  onDoc: (doc: DocSnap) => void,
): Promise<number> {
  let cursor: DocSnap | undefined;
  let seen = 0;
  for (;;) {
    let page = query.orderBy("__name__").limit(PAGE_SIZE);
    if (cursor) page = page.startAfter(cursor);
    const snap = await page.get();
    if (snap.empty) break;
    for (const doc of snap.docs) onDoc(doc);
    seen += snap.docs.length;
    cursor = snap.docs[snap.docs.length - 1];
    if (snap.docs.length < PAGE_SIZE) break;
  }
  return seen;
}

async function run(db: FirestoreLike, mode: CleanupMode): Promise<void> {
  const dryRun = mode === "dry-run";
  const now = Date.now();
  console.log(`\n🧹 usage-ledger cleanup — ${dryRun ? "DRY RUN" : "EXECUTE"}\n`);

  // BulkWriter rate-limits + parallelizes the writes (500 ops/s auto-ramp) so a
  // large drain stays inside Firestore limits instead of thousands of serial awaits.
  const writer = dryRun ? null : db.bulkWriter();

  for (const collection of RETIRED_USAGE_COLLECTIONS) {
    const deleted = await pageThrough(db.collectionGroup(collection), (doc) => {
      writer?.delete(doc.ref);
    });
    console.log(`  ${collection}: ${deleted} docs ${dryRun ? "would be deleted" : "queued for delete"}`);
  }

  let backfilled = 0;
  const scanned = await pageThrough(db.collectionGroup("usage_models"), (doc) => {
    const expiresAt = planUsageModelExpiry(doc.data(), now);
    if (!expiresAt) return;
    backfilled += 1;
    writer?.update(doc.ref, { expiresAt });
  });
  console.log(`  usage_models: ${scanned} scanned, ${backfilled} ${dryRun ? "would be backfilled" : "queued for backfill"}`);

  if (writer) await writer.close();

  console.log(
    dryRun
      ? "\n⚠️  DRY RUN — nothing written. Re-run with --execute.\n"
      : "\n✅ Done. TTL drains the stamped docs on Firestore's ~daily schedule.\n",
  );
}

async function main(argv: string[] = process.argv.slice(2)): Promise<void> {
  const mode = parseCleanupUsageLedgersMode(argv);
  if (!mode) {
    console.error(CLEANUP_USAGE_LEDGERS_USAGE);
    process.exit(1);
  }
  const { db } = await import("../lib/firebase.js");
  await run(db as unknown as FirestoreLike, mode);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error("Failed:", err);
    process.exit(1);
  });
}
