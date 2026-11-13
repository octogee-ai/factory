import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  auditDependencyCoverage,
  dependencyReferenceId,
  inventoryRepository,
  matchesExactReference,
  validateExceptionFile,
} from "../../scripts/lib/dependency-inventory.js";
import {
  auditDependabotCoverage,
  parseDependabotConfig,
} from "../../scripts/lib/dependabot-coverage.js";
import {
  RENOVATE_IMAGE,
  buildRenovateExtractInvocation,
  parseRenovateExtractOutput,
} from "../../scripts/lib/renovate-extract.js";

const repoRoot = path.resolve(import.meta.dirname, "../..");
const fixtures = path.join(repoRoot, "tests/fixtures/dependency-inventory");
const read = (relativePath: string) => readFileSync(path.join(repoRoot, relativePath), "utf8");

describe("dependency inventory", () => {
  it("excludes local Docker build stages from external dependency policy", () => {
    const root = mkdtempSync(path.join(tmpdir(), "octogee-docker-stage-inventory-"));
    try {
      writeFileSync(path.join(root, "Dockerfile"), [
        "FROM node:24-bookworm-slim AS core",
        "FROM core AS installer",
        "FROM ghcr.io/example/runtime:1.2.3 AS runtime",
        "",
      ].join("\n"));

      const inventory = inventoryRepository(root);
      expect(inventory.references).toEqual([
        {
          referenceKind: "dockerfile",
          path: "Dockerfile",
          key: "from:0",
          packageName: "node",
          currentValue: "24-bookworm-slim",
        },
        {
          referenceKind: "dockerfile",
          path: "Dockerfile",
          key: "from:2",
          packageName: "ghcr.io/example/runtime",
          currentValue: "1.2.3",
        },
      ]);
      expect(inventory.exclusions).toContainEqual({
        referenceKind: "dockerfile",
        path: "Dockerfile",
        key: "from:1",
        rawValue: "core",
        reason: "local-reference",
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("does not inventory the annotation syntax inside Renovate configuration", () => {
    const root = mkdtempSync(path.join(tmpdir(), "octogee-renovate-annotation-"));
    try {
      const configDirectory = path.join(root, ".github");
      const futureAnnotation = [
        "octogee:dependency", "kind=annotated", "key=tool",
        "packageName=example/tool", "currentValue=future",
      ].join(" ");
      const currentAnnotation = futureAnnotation.replace("future", "1.0.0");
      mkdirSync(configDirectory, { recursive: true });
      writeFileSync(
        path.join(configDirectory, "renovate.json5"),
        `matcher='${futureAnnotation}'`,
      );
      writeFileSync(
        path.join(root, "pins.txt"),
        `tool=1.0.0 # ${currentAnnotation}`,
      );

      expect(inventoryRepository(root).references).toEqual([{
        referenceKind: "annotated",
        path: "pins.txt",
        key: "tool",
        packageName: "example/tool",
        currentValue: "1.0.0",
      }]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("ignores local agent worktrees outside the checked-out repository", () => {
    const root = mkdtempSync(path.join(tmpdir(), "octogee-dependency-inventory-"));
    try {
      writeFileSync(path.join(root, "package.json"), JSON.stringify({ dependencies: { alpha: "1.0.0" } }));
      writeFileSync(path.join(root, "package-lock.json"), "{}");
      const worktree = path.join(root, ".claude", "worktrees", "stale");
      mkdirSync(worktree, { recursive: true });
      writeFileSync(path.join(worktree, "package.json"), JSON.stringify({ dependencies: { beta: "2.0.0" } }));
      writeFileSync(path.join(worktree, "package-lock.json"), "{}");

      expect(inventoryRepository(root).references
        .filter(({ referenceKind }) => referenceKind === "npm")
        .map(({ packageName }) => packageName)).toEqual(["alpha"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("ignores the generated platform and product overlay", () => {
    const root = mkdtempSync(path.join(tmpdir(), "octogee-dependency-inventory-overlay-"));
    try {
      writeFileSync(path.join(root, "package.json"), JSON.stringify({ dependencies: { alpha: "1.0.0" } }));
      writeFileSync(path.join(root, "package-lock.json"), "{}");
      const overlay = path.join(root, ".overlay", "glm-controller");
      mkdirSync(overlay, { recursive: true });
      writeFileSync(path.join(overlay, "package.json"), JSON.stringify({ dependencies: { beta: "2.0.0" } }));
      writeFileSync(path.join(overlay, "package-lock.json"), "{}");

      expect(inventoryRepository(root).references
        .filter(({ referenceKind }) => referenceKind === "npm")
        .map(({ packageName }) => packageName)).toEqual(["alpha"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("normalizes every supported external reference and records explicit exclusions", () => {
    const inventory = inventoryRepository(path.join(fixtures, "managed"));

    expect(new Set(inventory.references.map(({ referenceKind }) => referenceKind))).toEqual(
      new Set([
        "annotated",
        "container-image",
        "dockerfile",
        "github-action",
        "helm-chart",
        "npm",
        "npm-lockfile",
        "terraform-provider",
      ]),
    );
    expect(inventory.references).toEqual(
      [...inventory.references].sort((left, right) =>
        dependencyReferenceId(left).localeCompare(dependencyReferenceId(right)),
      ),
    );
    expect(inventory.exclusions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ reason: "internal-artifact-registry" }),
        expect.objectContaining({
          referenceKind: "dockerfile",
          path: "Dockerfile",
          rawValue: "internal",
          reason: "local-reference",
        }),
      ]),
    );
  });

  it("binds exceptions to the complete identity including currentValue", () => {
    const [reference] = inventoryRepository(path.join(fixtures, "unmanaged")).references;
    const changed = { ...reference, currentValue: `${reference.currentValue}-changed` };

    expect(matchesExactReference(reference, reference)).toBe(true);
    expect(matchesExactReference(reference, changed)).toBe(false);
    expect(dependencyReferenceId(reference)).not.toBe(dependencyReferenceId(changed));
  });

  it("encodes exact identities without delimiter collisions", () => {
    const left = {
      referenceKind: "kind",
      path: "path:segment",
      key: "key",
      packageName: "package",
      currentValue: "value",
    };
    const right = {
      referenceKind: "kind:path",
      path: "segment",
      key: "key",
      packageName: "package",
      currentValue: "value",
    };

    expect(dependencyReferenceId(left)).not.toBe(dependencyReferenceId(right));
    expect(matchesExactReference(left, right)).toBe(false);
  });
});

describe("manager extraction", () => {
  it("parses real Dependabot updates, schedule, and ignore declarations", () => {
    const config = parseDependabotConfig(read("tests/fixtures/dependency-inventory/dependabot.yml"));

    expect(config).toEqual([
      expect.objectContaining({
        ecosystem: "npm",
        directory: "/",
        interval: "daily",
        ignores: [{ dependencyName: "typescript", updateTypes: ["version-update:semver-major"] }],
      }),
    ]);
  });

  it("fails a lock root without an exact manager entry or coverage exception", () => {
    const inventory = inventoryRepository(path.join(fixtures, "unmanaged"));
    const result = auditDependabotCoverage({
      inventory,
      updates: [],
      exceptions: [],
      now: new Date("2026-07-11T00:00:00Z"),
    });

    expect(result.errors).toContainEqual(expect.stringContaining("npm-lockfile"));
  });

  it("records Dockerfile references from configured Docker update directories", () => {
    const inventory = inventoryRepository(path.join(fixtures, "renovate-identity"));
    const updates = parseDependabotConfig(`version: 2
updates:
  - package-ecosystem: "docker"
    directory: "/"
    schedule:
      interval: "weekly"`);

    const result = auditDependabotCoverage({
      inventory,
      updates,
      exceptions: [],
      now: new Date("2026-07-11T00:00:00Z"),
    });

    expect(result.managedReferences).toEqual([{
      referenceKind: "dockerfile",
      path: "Dockerfile",
      key: "from:0",
      packageName: "node",
      currentValue: "22-slim",
    }, {
      referenceKind: "dockerfile",
      path: "Dockerfile",
      key: "from:1",
      packageName: "alpine",
      currentValue: "3.20",
    }]);
  });

  it.each([
    { name: "absent", directories: [] },
    { name: "a different directory", directories: ["/other"] },
    { name: "duplicated", directories: ["/", "/"] },
  ])("does not claim GitHub Action coverage when its root update is $name", ({ directories }) => {
    const reference = {
      referenceKind: "github-action",
      path: ".github/workflows/ship-test.yml",
      key: "uses:0",
      packageName: "actions/checkout",
      currentValue: "3d3c42e5aac5ba805825da76410c181273ba90b1",
    };
    const result = auditDependabotCoverage({
      inventory: { references: [reference], exclusions: [] },
      updates: directories.map((directory) => ({ ecosystem: "github-actions", directory, ignores: [] })),
      exceptions: [],
    });

    expect(result.managedReferences).toEqual([]);
    if (directories.length > 1) {
      expect(result.errors).toContainEqual(expect.stringContaining("duplicate Dependabot GitHub Actions entries"));
    }
  });

  it("tracks a configured composite action without claiming neighboring manifests", () => {
    const references = [
      ".github/actions/setup-ci/action.yml",
      ".github/actions/other/action.yml",
      ".github/actions/setup-ci/nested/action.yml",
    ].map(manifestPath => ({
      referenceKind: "github-action", path: manifestPath, key: "uses:0",
      packageName: "actions/setup-node", currentValue: "949feb2413d6458794dcd2491c4babbbce0c15c1",
    }));
    const result = auditDependabotCoverage({
      inventory: { references, exclusions: [] },
      updates: [{ ecosystem: "github-actions", directory: "/.github/actions/setup-ci", ignores: [] }],
      exceptions: [],
    });
    expect(result.errors).toEqual([]);
    expect(result.managedReferences).toEqual([references[0]]);
  });

  it("does not claim coverage for ignored GitHub Actions", () => {
    const reference = {
      referenceKind: "github-action",
      path: ".github/workflows/ship-test.yml",
      key: "uses:0",
      packageName: "actions/checkout",
      currentValue: "3d3c42e5aac5ba805825da76410c181273ba90b1",
    };
    const updates = parseDependabotConfig(`version: 2
updates:
  - package-ecosystem: "github-actions"
    directory: "/"
    ignore:
      - dependency-name: "actions/*"`);

    expect(auditDependabotCoverage({
      inventory: { references: [reference], exclusions: [] },
      updates,
      exceptions: [],
    }).managedReferences).toEqual([]);
  });

  it("requires every Dependabot ignore to bind to a typed exact compatibility exception", () => {
    const inventory = inventoryRepository(path.join(fixtures, "managed"));
    const updates = parseDependabotConfig(read("tests/fixtures/dependency-inventory/dependabot.yml"));
    updates[0].ignores = [{ dependencyName: "left-pad", updateTypes: ["version-update:semver-major"] }];

    expect(auditDependabotCoverage({
      inventory,
      updates,
      exceptions: [],
      now: new Date("2026-07-11T00:00:00Z"),
    }).errors).toContainEqual(expect.stringContaining("compatibility exception"));
  });

  it("parses pinned Renovate local dry-run output into normalized identities", () => {
    const parsed = parseRenovateExtractOutput(
      read("tests/fixtures/dependency-inventory/renovate-extract.jsonl"),
    );

    expect(parsed).toEqual([
      {
        referenceKind: "dockerfile",
        path: "Dockerfile",
        key: "from:0",
        packageName: "node",
        currentValue: "22-slim",
      },
    ]);
    expect(RENOVATE_IMAGE).toBe(
      "renovate/renovate:43.259.0@sha256:f9a2ea77df854f3ceb94833b7345715a024bed4f33995d7c957db2707e9275c5",
    );
    expect(buildRenovateExtractInvocation("/repo", 501)).toEqual({
      command: "docker",
      args: [
        "run", "--rm", "--pull=never", "--user", "501:0",
        "-e", "LOG_LEVEL=debug", "-e", "LOG_FORMAT=json",
        "-e", "RENOVATE_CONFIG_FILE=/repo/.github/renovate.json5",
        "-v", "/repo:/repo", "-w", "/repo", RENOVATE_IMAGE,
        "--platform=local", "--dry-run=extract",
      ],
    });
  });

  it("joins Renovate output to inventory identities across every supported external manager", () => {
    const root = path.join(fixtures, "renovate-identity");
    const inventory = inventoryRepository(root);
    const extracted = parseRenovateExtractOutput(
      read("tests/fixtures/dependency-inventory/renovate-identity.jsonl"),
    );

    expect(extracted).toEqual(inventory.references);
  });

  it("normalizes custom regex managers as annotated dependency identities", () => {
    const parsed = parseRenovateExtractOutput(JSON.stringify({
      packageFiles: {
        regex: [{
          packageFile: ".github/workflows/trivy-iac.yml",
          deps: [{
            depName: "aquasecurity/trivy",
            currentValue: "0.72.0",
            depType: "trivy",
          }],
        }],
      },
    }));

    expect(parsed).toEqual([{
      referenceKind: "annotated",
      path: ".github/workflows/trivy-iac.yml",
      key: "trivy",
      packageName: "aquasecurity/trivy",
      currentValue: "0.72.0",
    }]);
  });

  it("ignores empty dependency records emitted by Renovate", () => {
    const parsed = parseRenovateExtractOutput(JSON.stringify({
      packageFiles: {
        "helm-values": [{
          packageFile: "values.yaml",
          deps: [{ depName: "", currentValue: "" }],
        }],
      },
    }));

    expect(parsed).toEqual([]);
  });
});

describe("repository dependency policy", () => {
  it("rejects overlap, malformed evidence, expiry, and broad exception inheritance", () => {
    const inventory = inventoryRepository(path.join(fixtures, "managed"));
    const reference = inventory.references[0];
    const invalid = {
      schemaVersion: 1,
      exceptions: [
        {
          id: "coverage/invalid",
          kind: "coverage",
          owner: "test",
          reason: "fixture",
          openedAt: "2026-07-01",
          reviewAfter: "2026-07-02",
          expiresAt: "2026-07-10",
          removalWorkstream: "R2",
          removalTest: "fixture",
          manager: "dependabot",
          references: [reference, reference],
          evidence: [],
        },
      ],
    };

    const result = validateExceptionFile(invalid, new Date("2026-07-11T00:00:00Z"));
    expect(result.errors).toEqual(expect.arrayContaining([
      expect.stringContaining("expired"),
      expect.stringContaining("evidence"),
      expect.stringContaining("duplicate"),
    ]));
  });

  it("fails the unmanaged fixture and accepts the fully managed fixture", () => {
    const ownership = [
      { referenceKind: "*", manager: "renovate" as const, pathPatterns: ["**"] },
    ];
    const managed = inventoryRepository(path.join(fixtures, "managed"));
    const unmanaged = inventoryRepository(path.join(fixtures, "unmanaged"));

    expect(auditDependencyCoverage({
      inventory: managed,
      ownership,
      dependabotReferences: [],
      renovateReferences: managed.references,
      exceptions: [],
      now: new Date("2026-07-11T00:00:00Z"),
    }).errors).toEqual([]);
    expect(auditDependencyCoverage({
      inventory: unmanaged,
      ownership,
      dependabotReferences: [],
      renovateReferences: [],
      exceptions: [],
      now: new Date("2026-07-11T00:00:00Z"),
    }).errors).not.toEqual([]);
  });

  it("rejects a reference extracted by both managers", () => {
    const managed = inventoryRepository(path.join(fixtures, "managed"));
    expect(auditDependencyCoverage({
      inventory: managed,
      ownership: [{ referenceKind: "*", manager: "renovate", pathPatterns: ["**"] }],
      dependabotReferences: managed.references,
      renovateReferences: managed.references,
      exceptions: [],
      now: new Date("2026-07-11T00:00:00Z"),
    }).errors).toContainEqual(expect.stringContaining("overlapping bot ownership"));
  });

  it("rejects wrong-manager extraction even when an exact exception exists", () => {
    const managed = inventoryRepository(path.join(fixtures, "managed"));
    const reference = managed.references.find(({ referenceKind }) => referenceKind === "npm");
    if (!reference) throw new Error("managed fixture has no npm reference");
    const exception = {
      id: "coverage/wrong-manager",
      kind: "coverage",
      expiresAt: "2026-07-25",
      references: [reference],
    };

    expect(auditDependencyCoverage({
      inventory: { references: [reference], exclusions: [] },
      ownership: [{ referenceKind: "npm", manager: "dependabot", pathPatterns: ["**"] }],
      dependabotReferences: [],
      renovateReferences: [reference],
      exceptions: [exception],
      now: new Date("2026-07-11T00:00:00Z"),
    }).errors).toContainEqual(expect.stringContaining("wrong manager renovate"));
  });

  it("accepts a singular exact coverage reference during the audit", () => {
    const [reference] = inventoryRepository(path.join(fixtures, "unmanaged")).references;
    const exception = {
      id: "coverage/singular-reference",
      kind: "coverage",
      expiresAt: "2026-07-25",
      reference,
    };

    expect(auditDependencyCoverage({
      inventory: { references: [reference], exclusions: [] },
      ownership: [{ referenceKind: reference.referenceKind, manager: "renovate", pathPatterns: ["**"] }],
      dependabotReferences: [],
      renovateReferences: [],
      exceptions: [exception],
      now: new Date("2026-07-11T00:00:00Z"),
    }).errors).toEqual([]);
  });
});
