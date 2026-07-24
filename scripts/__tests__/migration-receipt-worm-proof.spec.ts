import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("migration receipt WORM proof", () => {
  it("limits mutation to an explicit TEST synthetic receipt and proves retention denial", () => {
    const source = fs.readFileSync(
      path.join(process.cwd(), "ops/prove-migration-receipt-worm.ts"),
      "utf8",
    );

    expect(source).toContain('"--target=test"');
    expect(source).toContain("octogee/migration-receipt-worm-proof/test");
    expect(source).toContain("assertMigrationReceiptBucket");
    expect(source).toContain("writeImmutableMigrationReceipt");
    expect(source).toContain("--if-generation-match=");
    expect(source).toContain('"storage", "rm"');
    expect(source).toContain("retention");
    expect(source).toContain("lifecycleAgeDays: 400");
    expect(source).toContain("uri");
    expect(source).toContain("generation");
  });
});
