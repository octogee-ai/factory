import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

const repoRoot = path.resolve(__dirname, "../..");
const preflight = path.join(
  repoRoot,
  "scripts/ops/verify-retired-west-ingress-unused.sh",
);

function executable(file: string, source: string): void {
  writeFileSync(file, source);
  chmodSync(file, 0o755);
}

function runPreflight(options: {
  authoritativeProxiedCname?: boolean;
  authoritativeRetiredRecord?: boolean;
  cloudflareFixture?:
    | "api-failure"
    | "duplicate-ids"
    | "safe"
    | "unrelated-proxied"
    | "paginated-cname"
    | "cname-resolution-failure"
    | "invalid-page-count"
    | "wrong-zone";
  missingRetired?: string;
  retiredUser?: string;
  observedConfigMode?: "600" | "644";
  wrongEdgeOwner?: boolean;
  wrongDnsHost?: string;
} = {}) {
  const temp = mkdtempSync(path.join(tmpdir(), "octogee-west-ingress-unused-"));
  executable(path.join(temp, "gcloud"), `#!/usr/bin/env bash
set -euo pipefail
name="$4"
if [[ "$name" == "$FAKE_MISSING_RETIRED" ]]; then
  printf 'NOT_FOUND: address does not exist\\n' >&2
  exit 1
fi
if [[ "$name" == "workspace-api-ip-test-west" ]]; then
  printf '%s\\n' '{"name":"workspace-api-ip-test-west","address":"34.100.0.9","addressType":"EXTERNAL","users":["https://www.googleapis.com/compute/v1/projects/octogee/global/forwardingRules/k8s2-fr-octogee-edge"]}'
elif [[ "$name" == "$FAKE_RETIRED_USER" ]]; then
  printf '{"name":"%s","address":"34.100.0.2","addressType":"EXTERNAL","users":["https://www.googleapis.com/compute/v1/projects/octogee/global/forwardingRules/stale"]}\\n' "$name"
else
  printf '{"name":"%s","address":"34.100.0.2","addressType":"EXTERNAL","users":[]}\\n' "$name"
fi
`);
  executable(path.join(temp, "kubectl"), `#!/usr/bin/env bash
set -euo pipefail
if [[ "$FAKE_WRONG_EDGE_OWNER" == "true" ]]; then
  printf '%s\\n' '{"metadata":{"name":"unrelated-ingress","namespace":"octogee-test-west"},"status":{"loadBalancer":{"ingress":[{"ip":"34.100.0.9"}]}}}'
else
  printf '%s\\n' '{"metadata":{"name":"octogee-edge-ingress","namespace":"octogee-test-west"},"status":{"loadBalancer":{"ingress":[{"ip":"34.100.0.9"}]}}}'
fi
`);
  executable(path.join(temp, "curl"), `#!/usr/bin/env bash
set -euo pipefail
url=""
page="1"
config=""
arguments=("$@")
for ((index = 0; index < \${#arguments[@]}; index += 1)); do
  arg="\${arguments[$index]}"
  case "$arg" in
    http*) url="$arg" ;;
    page=*) page="\${arg#page=}" ;;
    --config)
      index=$((index + 1))
      config="\${arguments[$index]}"
      ;;
  esac
done
if [[ "$*" == *"cloudflare-token"* || -n "\${CLOUDFLARE_API_TOKEN:-}" ]]; then
  printf 'Cloudflare token exposed to curl process\\n' >&2
  exit 2
fi
if [[ -z "$config" || ! -f "$config" ]]; then
  printf 'secure curl config is required\\n' >&2
  exit 2
fi
if [[ "$FAKE_CURL_CONFIG_MODE" != "600" ]]; then
  chmod "$FAKE_CURL_CONFIG_MODE" "$config"
fi
config_mode="$(node -e 'const { statSync } = require("node:fs"); process.stdout.write((statSync(process.argv[1]).mode & 0o777).toString(8))' "$config")"
if [[ "$config_mode" != "600" ]]; then
  printf 'secure curl config must use mode 600\\n' >&2
  exit 2
fi
if ! grep -Fq 'Authorization: Bearer cloudflare-token' "$config"; then
  printf 'secure curl config is missing authorization\\n' >&2
  exit 2
fi
if [[ "$FAKE_CLOUDFLARE_FIXTURE" == "api-failure" ]]; then
  exit 22
fi
if [[ "$url" == "https://api.cloudflare.com/client/v4/zones" ]]; then
  if [[ "$FAKE_CLOUDFLARE_FIXTURE" == "wrong-zone" ]]; then
    printf '%s\\n' '{"success":true,"errors":[],"result":[{"id":"zone-other","name":"other.example","status":"active"}],"result_info":{"page":1,"per_page":50,"count":1,"total_count":1,"total_pages":1}}'
  else
    printf '%s\\n' '{"success":true,"errors":[],"result":[{"id":"zone-octogee","name":"octogee.com","status":"active"}],"result_info":{"page":1,"per_page":50,"count":1,"total_count":1,"total_pages":1}}'
  fi
  exit 0
fi
if [[ "$url" != "https://api.cloudflare.com/client/v4/zones/zone-octogee/dns_records" ]]; then
  printf 'unexpected Cloudflare URL\\n' >&2
  exit 1
fi
if [[ "$FAKE_CLOUDFLARE_FIXTURE" == "invalid-page-count" ]]; then
  printf '%s\\n' '{"success":true,"errors":[],"result":[],"result_info":{"page":2,"per_page":100,"count":0,"total_count":0,"total_pages":1},"diagnostic":"cloudflare-token"}'
  exit 0
fi
records='[
  {"id":"record-1","type":"A","name":"api-test.octogee.com","content":"34.100.0.9","proxied":false},
  {"id":"record-2","type":"A","name":"git-test.octogee.com","content":"34.100.0.9","proxied":false},
  {"id":"record-3","type":"A","name":"mattermost-test.octogee.com","content":"34.100.0.9","proxied":false},
  {"id":"record-4","type":"A","name":"preview-test.octogee.com","content":"34.100.0.9","proxied":false}
]'
if [[ "$FAKE_AUTHORITATIVE_RETIRED_RECORD" == "true" ]]; then
  records="$(jq '. + [{"id":"record-5","type":"A","name":"stale-test.octogee.com","content":"34.100.0.2","proxied":false}]' <<<"$records")"
elif [[ "$FAKE_CLOUDFLARE_FIXTURE" == "unrelated-proxied" ]]; then
  records="$(jq '. + [{"id":"record-5","type":"A","name":"forgotten.octogee.com","content":"34.100.0.2","proxied":true}]' <<<"$records")"
elif [[ "$FAKE_CLOUDFLARE_FIXTURE" == "cname-resolution-failure" ]]; then
  records="$(jq '. + [{"id":"record-5","type":"CNAME","name":"alias.octogee.com","content":"origin.octogee.com","proxied":true}]' <<<"$records")"
elif [[ "$FAKE_CLOUDFLARE_FIXTURE" == "paginated-cname" && "$page" == "1" ]]; then
  records="$(jq '. + [{"id":"record-5","type":"CNAME","name":"alias.octogee.com","content":"origin.octogee.com","proxied":true}]' <<<"$records")"
  jq -n --argjson result "$records" \
    '{success:true, errors:[], result:$result, result_info:{page:1,per_page:100,count:5,total_count:6,total_pages:2}}'
  exit 0
elif [[ "$FAKE_CLOUDFLARE_FIXTURE" == "paginated-cname" && "$page" == "2" ]]; then
  printf '%s\\n' '{"success":true,"errors":[],"result":[{"id":"record-6","type":"A","name":"origin.octogee.com","content":"34.100.0.2","proxied":true}],"result_info":{"page":2,"per_page":100,"count":1,"total_count":6,"total_pages":2}}'
  exit 0
fi
if [[ "$FAKE_CLOUDFLARE_FIXTURE" == "duplicate-ids" ]]; then
  records="$(jq '.[1].id = "record-1"' <<<"$records")"
fi
if [[ "$FAKE_AUTHORITATIVE_PROXIED_CNAME" == "true" ]]; then
  records="$(jq '. + [{"id":"record-5","type":"CNAME","name":"alias-test.octogee.com","content":"proxied-origin.example.net","proxied":true}]' <<<"$records")"
fi
count="$(jq 'length' <<<"$records")"
jq -n --argjson result "$records" --argjson count "$count" \
  '{success:true, errors:[], result:$result, result_info:{page:1,per_page:100,count:$count,total_count:$count,total_pages:1}}'
`);
  executable(path.join(temp, "dig"), `#!/usr/bin/env bash
set -euo pipefail
host="$3"
if [[ "$host" == "$FAKE_WRONG_DNS_HOST" ]]; then
  printf '34.100.0.2\\n'
elif [[ "$host" == "proxied-origin.example.net" ]]; then
  printf '104.16.0.1\\n'
else
  printf '34.100.0.9\\n'
fi
`);

  const receipt = path.join(temp, "dns-inventory-receipt.json");
  const result = spawnSync(
    "bash",
    [
      preflight,
      "--project=octogee",
      "--shared-address=workspace-api-ip-test-west",
      "--cloudflare-zone-id=zone-octogee",
      "--cloudflare-zone-name=octogee.com",
      "--kube-context=gke_us-west1_octogee",
      "--namespace=octogee-test-west",
      "--ingress-name=octogee-edge-ingress",
      `--receipt=${receipt}`,
      "--retired-address=gitea-ip-test-west",
      "--retired-address=mattermost-ip-test-west",
      "--retired-address=preview-ip-test-west",
      "--hostname=api-test.octogee.com",
      "--hostname=git-test.octogee.com",
      "--hostname=mattermost-test.octogee.com",
      "--hostname=preview-test.octogee.com",
    ],
    {
      cwd: repoRoot,
      env: {
        ...process.env,
        PATH: `${temp}:${process.env.PATH ?? "/usr/bin:/bin"}`,
        CLOUDFLARE_API_TOKEN: "cloudflare-token",
        CLOUDFLARE_API_ROOT: "https://attacker.invalid/client/v4",
        FAKE_AUTHORITATIVE_PROXIED_CNAME: String(
          options.authoritativeProxiedCname ?? false,
        ),
        FAKE_AUTHORITATIVE_RETIRED_RECORD: String(
          options.authoritativeRetiredRecord ?? false,
        ),
        FAKE_MISSING_RETIRED: options.missingRetired ?? "",
        FAKE_RETIRED_USER: options.retiredUser ?? "",
        FAKE_WRONG_EDGE_OWNER: String(options.wrongEdgeOwner ?? false),
        FAKE_WRONG_DNS_HOST: options.wrongDnsHost ?? "",
        FAKE_CURL_CONFIG_MODE: options.observedConfigMode ?? "600",
        FAKE_CLOUDFLARE_FIXTURE: options.cloudflareFixture ?? "safe",
      },
      encoding: "utf8",
    },
  );
  return {
    ...result,
    receipt: existsSync(receipt) ? readFileSync(receipt, "utf8") : null,
  };
}

describe("retired WEST ingress safety preflight", () => {
  it("accepts a mode-600 curl config with a platform-neutral mode check", () => {
    const result = runPreflight({ observedConfigMode: "600" });

    expect(result.status, result.stderr).toBe(0);
  });

  it("rejects a non-600 curl config with a platform-neutral mode check", () => {
    const result = runPreflight({ observedConfigMode: "644" });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(
      "secure curl config must use mode 600",
    );
  });

  it("accepts a live shared edge, matching DNS, and unused retired addresses", () => {
    const result = runPreflight();

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("safe to retire");
    expect(result.stdout).not.toContain("cloudflare-token");
    expect(result.stderr).not.toContain("cloudflare-token");
    expect(result.receipt).not.toBeNull();
    expect(result.receipt).not.toContain("cloudflare-token");
    expect(result.receipt).not.toContain("34.100.");
    expect(result.receipt).not.toContain("api-test.octogee.com");
    expect(result.receipt).not.toContain("record-1");
    expect(JSON.parse(result.receipt ?? "")).toMatchObject({
      schemaVersion: 1,
      authoritativeDns: {
        zoneId: "zone-octogee",
        zoneName: "octogee.com",
        pages: 1,
        recordCount: 4,
        cnameRecordsChecked: 0,
        allCnameChainsProven: true,
        completenessVerified: true,
        inventorySha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      },
      retiredAddresses: {
        names: [
          "gitea-ip-test-west",
          "mattermost-ip-test-west",
          "preview-ip-test-west",
        ],
        ipHashes: [expect.stringMatching(/^[a-f0-9]{64}$/)],
      },
      expectedHostnamesChecked: 4,
      status: "clear",
    });
  });

  it("accepts an already-absent retired address after an interrupted apply", () => {
    const result = runPreflight({ missingRetired: "gitea-ip-test-west" });

    expect(result.status, result.stderr).toBe(0);
  });

  it("rejects a retired address that still has a forwarding-rule user", () => {
    const result = runPreflight({ retiredUser: "gitea-ip-test-west" });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(
      "gitea-ip-test-west still has forwarding-rule users",
    );
  });

  it("rejects a shared address not owned by the exact TEST-WEST edge ingress", () => {
    const result = runPreflight({ wrongEdgeOwner: true });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(
      "shared address is not owned by octogee-test-west/octogee-edge-ingress",
    );
  });

  it("rejects any authoritative A record that retains a retired address", () => {
    const result = runPreflight({ authoritativeRetiredRecord: true });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(
      "Cloudflare DNS inventory references a retired WEST ingress address",
    );
  });

  it("rejects an external CNAME whose proxied origin cannot be proven", () => {
    const result = runPreflight({ authoritativeProxiedCname: true });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(
      "Cloudflare DNS inventory contains an unprovable CNAME chain",
    );
  });

  it("rejects a TEST-WEST hostname that does not resolve only to the shared edge", () => {
    const result = runPreflight({ wrongDnsHost: "git-test.octogee.com" });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(
      "git-test.octogee.com does not resolve only to shared address 34.100.0.9",
    );
  });

  it("rejects an unrelated proxied Cloudflare record that references a retired address", () => {
    const result = runPreflight({ cloudflareFixture: "unrelated-proxied" });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(
      "Cloudflare DNS inventory references a retired WEST ingress address",
    );
    expect(result.stderr).not.toContain("cloudflare-token");
  });

  it("reads every Cloudflare page and rejects a proxied CNAME chain to a retired address", () => {
    const result = runPreflight({ cloudflareFixture: "paginated-cname" });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(
      "Cloudflare DNS inventory references a retired WEST ingress address",
    );
  });

  it("fails closed when a Cloudflare CNAME target cannot be proven from the zone inventory", () => {
    const result = runPreflight({
      cloudflareFixture: "cname-resolution-failure",
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(
      "Cloudflare DNS inventory contains an unprovable CNAME chain",
    );
  });

  it("fails closed without a receipt when Cloudflare cannot be reached", () => {
    const result = runPreflight({ cloudflareFixture: "api-failure" });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(
      "Cloudflare authoritative DNS request failed",
    );
    expect(result.stdout).not.toContain("cloudflare-token");
    expect(result.stderr).not.toContain("cloudflare-token");
    expect(result.receipt).toBeNull();
  });

  it("fails closed without a receipt when Cloudflare resolves the wrong zone", () => {
    const result = runPreflight({ cloudflareFixture: "wrong-zone" });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(
      "Could not resolve the authoritative Cloudflare zone",
    );
    expect(result.receipt).toBeNull();
  });

  it("fails closed without a receipt when a Cloudflare page or count is invalid", () => {
    const result = runPreflight({ cloudflareFixture: "invalid-page-count" });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(
      "Cloudflare DNS inventory returned an invalid page",
    );
    expect(result.stdout).not.toContain("cloudflare-token");
    expect(result.stderr).not.toContain("cloudflare-token");
    expect(result.receipt).toBeNull();
  });

  it("fails closed without a receipt when Cloudflare returns duplicate record IDs", () => {
    const result = runPreflight({ cloudflareFixture: "duplicate-ids" });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(
      "Cloudflare DNS inventory did not return every authoritative record",
    );
    expect(result.receipt).toBeNull();
  });
});
