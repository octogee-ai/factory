import { describe, expect, it } from "vitest";
import {
  FLEET_LOGS_FORMAT,
  SOURCE_COLORS,
  buildFleetLogsFilter,
  fleetLogsTailArgs,
  parseFleetLogsLine,
  renderFleetLogLine,
  sourceColorCode,
} from "../lib/fleet-logs";

describe("buildFleetLogsFilter", () => {
  it("spans pods and VM containers in one filter, scoped to the environment's namespace", () => {
    expect(buildFleetLogsFilter({ namespace: "octogee-test" })).toBe(
      '((resource.type="k8s_container" AND resource.labels.namespace_name="octogee-test")' +
        ' OR (resource.type="gce_instance" AND jsonPayload.container.metadata."ai.octogee.namespace"="octogee-test"))',
    );
  });

  it("matches one gateway on either runtime without excluding the other's entries", () => {
    const filter = buildFleetLogsFilter({ namespace: "octogee", gatewayId: "shared-0" });

    expect(filter).toContain(
      ' AND (resource.labels.pod_name:"shared-0"' +
        ' OR jsonPayload.container.metadata."ai.octogee.gateway-id"="shared-0")',
    );
  });

  it("matches a container by the same name on both runtimes", () => {
    expect(buildFleetLogsFilter({ namespace: "octogee", container: "gateway-edge" })).toContain(
      ' AND (resource.labels.container_name="gateway-edge"' +
        ' OR jsonPayload.container.metadata."ai.octogee.container"="gateway-edge")',
    );
  });

  it("raises the severity floor when asked", () => {
    expect(buildFleetLogsFilter({ namespace: "octogee", minSeverity: "ERROR" })).toContain(
      " AND severity>=ERROR",
    );
  });

  it("refuses values that would escape the filter expression", () => {
    expect(() => buildFleetLogsFilter({ namespace: 'octogee" OR "a"="a' })).toThrow(/namespace/);
    expect(() => buildFleetLogsFilter({ namespace: "octogee", gatewayId: "a b" })).toThrow(/gateway/);
    expect(() => buildFleetLogsFilter({ namespace: "octogee", container: "../x" })).toThrow(/container/);
    expect(() => buildFleetLogsFilter({ namespace: "octogee", minSeverity: "LOUD" })).toThrow(/severity/);
  });
});

describe("fleetLogsTailArgs", () => {
  it("tails the cluster project, where both runtimes write, ordering by arrival window", () => {
    expect(fleetLogsTailArgs({ projectId: "octogee", filter: 'resource.type="gce_instance"' })).toEqual([
      "alpha",
      "logging",
      "tail",
      'resource.type="gce_instance"',
      "--project=octogee",
      "--buffer-window=2s",
      `--format=${FLEET_LOGS_FORMAT}`,
    ]);
  });
});

describe("parseFleetLogsLine", () => {
  const fields = (...v: string[]) => v.join("\t");

  it("reads a pod entry as pod/container", () => {
    const parsed = parseFleetLogsLine(
      fields("2026-09-17T12:00:00Z", "INFO", "octogee-gw-shared-0-abc", "gateway", "", "", "boot complete", "", ""),
    );

    expect(parsed).toEqual({
      timestamp: "2026-09-17T12:00:00Z",
      severity: "INFO",
      source: "octogee-gw-shared-0-abc/gateway",
      message: "boot complete",
    });
  });

  it("reads a VM entry as instance/container, dropping Docker's leading slash", () => {
    const parsed = parseFleetLogsLine(
      fields("2026-09-17T12:00:01Z", "ERROR", "", "", "ceckert-m-5a5e", "/octogee-gateway", "", "", "probe failed"),
    );

    expect(parsed).toEqual({
      timestamp: "2026-09-17T12:00:01Z",
      severity: "ERROR",
      source: "ceckert-m-5a5e/octogee-gateway",
      message: "probe failed",
    });
  });

  it("reads the one populated text field, whichever it is, keeping tabs inside the line", () => {
    const at = (i: number, value: string) => {
      const row = ["t", "INFO", "p", "c", "", "", "", "", ""];
      row[i] = value;
      return fields(...row);
    };

    expect(parseFleetLogsLine(at(6, "pod stdout line"))?.message).toBe("pod stdout line");
    expect(parseFleetLogsLine(at(7, "Received HTTP request"))?.message).toBe("Received HTTP request");
    expect(parseFleetLogsLine(at(8, "vm driver line"))?.message).toBe("vm driver line");
    expect(parseFleetLogsLine(at(8, "a\tb"))?.message).toBe("a\tb");
  });

  it("skips gcloud's progress chatter rather than rendering it as a log line", () => {
    expect(parseFleetLogsLine("")).toBeNull();
    expect(parseFleetLogsLine("Waiting for log entries...")).toBeNull();
  });
});

describe("renderFleetLogLine", () => {
  it("leads with the clock time and the source so the two runtimes line up", () => {
    expect(
      renderFleetLogLine(
        { timestamp: "2026-09-17T12:00:01.5Z", severity: "ERROR", source: "vm-1/octogee-gateway", message: "boom" },
        { color: false },
      ),
    ).toBe("12:00:01 ERROR vm-1/octogee-gateway boom");
  });

  it("paints the source, dims the clock, and reddens an error's message", () => {
    const line = renderFleetLogLine(
      { timestamp: "2026-09-17T12:00:01.5Z", severity: "ERROR", source: "vm-1/gw", message: "boom" },
      { color: true },
    );

    expect(line).toBe(
      `\x1b[2m12:00:01\x1b[0m \x1b[1;31mERROR\x1b[0m ` +
        `\x1b[38;5;${sourceColorCode("vm-1/gw")}mvm-1/gw\x1b[0m \x1b[31mboom\x1b[0m`,
    );
  });

  it("leaves a non-error message unpainted so the source stays the eye's anchor", () => {
    const line = renderFleetLogLine(
      { timestamp: "2026-09-17T12:00:01Z", severity: "INFO", source: "pod-a/gw", message: "ready" },
      { color: true },
    );

    expect(line.endsWith(" ready")).toBe(true);
  });
});

describe("sourceColorCode", () => {
  it("gives one source the same color every run, so a stream stays trackable", () => {
    expect(sourceColorCode("octogee-gw-shared-0-abc/gateway")).toBe(
      sourceColorCode("octogee-gw-shared-0-abc/gateway"),
    );
    expect(SOURCE_COLORS).toContain(sourceColorCode("anything"));
  });

  it("spreads the fleet's real sources across the palette rather than clumping", () => {
    const sources = [
      "octogee-api-77d5fd4447-z4zqs/octogee-api",
      "mattermost-7fc4f959-v594s/mattermost",
      "octogee-gitea-7b875c8865-75gpq/gitea",
      "octogee-gw-shared-0-abc/gateway",
      "octogee-gw-shared-0-abc/gateway-edge",
      "ceckert-m-5a5e/octogee-gateway",
      "ceckert-m-5a5e/octogee-gateway-edge",
      "octogee-vm-bridge-6dfb467764-d79kt/nginx",
    ];

    expect(new Set(sources.map(sourceColorCode)).size).toBeGreaterThanOrEqual(7);
  });
});
