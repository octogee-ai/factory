import { chmodSync, copyFileSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";

const repoRoot = resolve(import.meta.dirname, "../..");
const temporaryDirectories: string[] = [];

const declaredAddress = (name: string) =>
  `google_compute_global_address.west_ingress["${name}"]`;

function executable(path: string, contents: string): void {
  writeFileSync(path, contents);
  chmodSync(path, 0o755);
}

function createHarness() {
  const root = mkdtempSync(join(tmpdir(), "octogee-west-ingress-adoption-"));
  temporaryDirectories.push(root);
  const scripts = join(root, "scripts", "ops");
  const bin = join(root, "bin");
  const log = join(root, "calls.log");
  mkdirSync(scripts, { recursive: true });
  mkdirSync(bin);
  copyFileSync(
    join(repoRoot, "scripts/ops/adopt-west-ingress-addresses.sh"),
    join(scripts, "adopt-west-ingress-addresses.sh"),
  );
  executable(
    join(bin, "terraform"),
    `#!/usr/bin/env bash
set -euo pipefail
case "$1" in
  console) cat >/dev/null; printf '%s\\n' "$OCTOGEE_TEST_CONSOLE_OUTPUT" ;;
  state) printf '%s\\n' "$OCTOGEE_TEST_STATE_ADDRESSES" ;;
  import) printf 'terraform %s\\n' "$*" >>"$OCTOGEE_TEST_LOG" ;;
  *) exit 1 ;;
esac
`,
  );
  executable(
    join(bin, "gcloud"),
    `#!/usr/bin/env bash
set -euo pipefail
name="$4"
printf 'gcloud %s\\n' "$*" >>"$OCTOGEE_TEST_LOG"
if [[ ",$OCTOGEE_TEST_EXISTING_NAMES," != *",$name,"* ]]; then
  printf "ERROR: (gcloud.compute.addresses.describe) Could not fetch resource:\\n - The resource 'projects/octogee/global/addresses/%s' was not found\\n" "$name" >&2
  exit 1
fi
printf '{"name":"%s","addressType":"%s","selfLink":"https://www.googleapis.com/compute/v1/projects/%s/%s/addresses/%s"}\\n' \\
  "$name" "$OCTOGEE_TEST_ADDRESS_TYPE" "$OCTOGEE_TEST_SELF_LINK_PROJECT" "$OCTOGEE_TEST_SCOPE" "$name"
`,
  );
  return { root, script: join(scripts, "adopt-west-ingress-addresses.sh"), log };
}

function runHarness(
  harness: ReturnType<typeof createHarness>,
  values: Record<string, string>,
): string {
  return execFileSync("bash", [
    harness.script,
    "--project=octogee",
    "--terraform-bin=terraform",
    "--confirm=octogee/us-west1/octogee-gateway",
  ], {
    cwd: harness.root,
    encoding: "utf8",
    env: {
      ...process.env,
      ...values,
      OCTOGEE_TEST_LOG: harness.log,
      PATH: `${join(harness.root, "bin")}:${process.env.PATH ?? "/usr/bin:/bin"}`,
    },
  });
}

function runWithoutConfirmation(
  harness: ReturnType<typeof createHarness>,
  values: Record<string, string>,
): string {
  return execFileSync("bash", [
    harness.script,
    "--project=octogee",
    "--terraform-bin=terraform",
  ], {
    cwd: harness.root,
    encoding: "utf8",
    env: {
      ...process.env,
      ...values,
      OCTOGEE_TEST_LOG: harness.log,
      PATH: `${join(harness.root, "bin")}:${process.env.PATH ?? "/usr/bin:/bin"}`,
    },
  });
}

afterEach(() => {
  while (temporaryDirectories.length > 0) {
    rmSync(temporaryDirectories.pop()!, { recursive: true, force: true });
  }
});

describe("WEST ingress Terraform-state adoption", () => {
  const common = {
    OCTOGEE_TEST_CONSOLE_OUTPUT: '"[\\"grafana-ip\\",\\"preview-ip-west\\"]"',
    OCTOGEE_TEST_ADDRESS_TYPE: "EXTERNAL",
    OCTOGEE_TEST_SELF_LINK_PROJECT: "octogee",
    OCTOGEE_TEST_SCOPE: "global",
  };

  it("parses Terraform jsonencode output and imports every declared address missing from state", () => {
    const harness = createHarness();
    runHarness(harness, {
      ...common,
      OCTOGEE_TEST_EXISTING_NAMES: "grafana-ip,preview-ip-west",
      OCTOGEE_TEST_STATE_ADDRESSES: declaredAddress("grafana-ip"),
    });

    const calls = readFileSync(harness.log, "utf8");
    expect(calls).toContain(`terraform import -var=reserve_ingress_addresses=true ${declaredAddress("preview-ip-west")} projects/octogee/global/addresses/preview-ip-west`);
    expect(calls).not.toContain(`terraform import -var=reserve_ingress_addresses=true ${declaredAddress("grafana-ip")}`);
  });

  it("requires the bootstrap's exact confirmation before it can import Terraform state", () => {
    const unconfirmed = createHarness();
    expect(() => runWithoutConfirmation(unconfirmed, {
      ...common,
      OCTOGEE_TEST_EXISTING_NAMES: "preview-ip-west",
      OCTOGEE_TEST_STATE_ADDRESSES: "",
    })).toThrow(/--confirm/);
    expect(existsSync(unconfirmed.log)).toBe(false);

    const confirmed = createHarness();
    expect(runHarness(confirmed, {
      ...common,
      OCTOGEE_TEST_EXISTING_NAMES: "preview-ip-west",
      OCTOGEE_TEST_STATE_ADDRESSES: "",
    })).toContain("Adopted existing WEST ingress addresses into Terraform state.");
    expect(readFileSync(confirmed.log, "utf8")).toContain("terraform import");
  });

  it("leaves a fresh environment for Terraform to create", () => {
    const harness = createHarness();
    expect(runHarness(harness, {
      ...common,
      OCTOGEE_TEST_EXISTING_NAMES: "",
      OCTOGEE_TEST_STATE_ADDRESSES: "",
    })).toContain("No existing WEST ingress addresses required Terraform-state adoption.");
    expect(readFileSync(harness.log, "utf8")).not.toContain("terraform import");
  });

  it.each([
    ["an unquoted array", '["grafana-ip"]'],
    ["a decoded scalar", '"\\"grafana-ip\\""'],
    ["duplicate names", '"[\\"grafana-ip\\",\\"grafana-ip\\"]"'],
    ["an invalid address name", '"[\\"Grafana IP\\"]"'],
  ])("rejects Terraform console output containing %s", (_label, consoleOutput) => {
    const harness = createHarness();

    expect(() => runHarness(harness, {
      ...common,
      OCTOGEE_TEST_CONSOLE_OUTPUT: consoleOutput,
      OCTOGEE_TEST_EXISTING_NAMES: "",
      OCTOGEE_TEST_STATE_ADDRESSES: "",
    })).toThrow();
  });

  it.each([
    ["project", { OCTOGEE_TEST_SELF_LINK_PROJECT: "other-project" }],
    ["scope", { OCTOGEE_TEST_SCOPE: "regions/us-west1" }],
    ["address type", { OCTOGEE_TEST_ADDRESS_TYPE: "INTERNAL" }],
  ])("rejects an existing address with an unexpected %s", (_label, override) => {
    const harness = createHarness();
    expect(() => runHarness(harness, {
      ...common,
      OCTOGEE_TEST_EXISTING_NAMES: "grafana-ip",
      OCTOGEE_TEST_STATE_ADDRESSES: "",
      ...override,
    })).toThrow(/unexpected identity/);
    expect(readFileSync(harness.log, "utf8")).not.toContain("terraform import");
  });

  it("runs state adoption only in the confirmed apply branch before its plan", () => {
    const bootstrap = readFileSync(join(repoRoot, "scripts/bootstrap-west-platform.sh"), "utf8");
    const invocation = [
      '"${INGRESS_STATE_ADOPTER}" \\',
      '    "--project=${PROJECT_ID}" \\',
      '    "--terraform-bin=${TERRAFORM_BIN}" \\',
      '    "--confirm=${CONFIRMATION}"',
    ].join("\n");
    const preApplyPlan = [
      '"${TERRAFORM_BIN}" plan \\',
      '  -input=false \\',
      '  -var=foundation_rebuild=true \\',
      '  -out="${PRE_APPLY_PLAN}"',
    ].join("\n");
    const confirmedApply = [
      'if [[ "${APPLY}" == "true" ]]; then',
      '  reconcile_deleted_sql_child_state',
      '',
      '  "${INGRESS_STATE_ADOPTER}" \\',
      '    "--project=${PROJECT_ID}" \\',
      '    "--terraform-bin=${TERRAFORM_BIN}" \\',
      '    "--confirm=${CONFIRMATION}"',
      'fi',
    ].join("\n");
    const applyConfirmation = [
      'if [[ "${APPLY}" == "true" && "${CONFIRMATION}" != "${EXPECTED_CONFIRMATION}" ]]; then',
      '  echo "Apply requires --confirm=octogee/us-west1/octogee-gateway" >&2',
      '  exit 2',
      'fi',
    ].join("\n");

    expect(bootstrap).toContain(invocation);
    expect(bootstrap).toContain(confirmedApply);
    expect(bootstrap).toContain(applyConfirmation);
    expect(bootstrap).toContain(preApplyPlan);
    expect(bootstrap.match(/INGRESS_STATE_ADOPTER/g)).toHaveLength(2);
    expect(bootstrap.indexOf(applyConfirmation)).toBeLessThan(
      bootstrap.indexOf(confirmedApply),
    );
    expect(bootstrap.indexOf(confirmedApply)).toBeLessThan(
      bootstrap.indexOf(preApplyPlan),
    );
  });

  it("is executable by the bootstrap entrypoint", () => {
    const mode = statSync(join(repoRoot, "scripts/ops/adopt-west-ingress-addresses.sh")).mode;

    expect(mode & 0o111).not.toBe(0);
  });
});
