import { describe, expect, it } from "vitest";
import { buildFleetLogsFilter, normalizeFleetLog, matchesFleetLog, renderFleetLogLine, parseFleetLogsOptions, createFleetLogsParser, fleetLogsTailArgs } from "../lib/fleet-logs.js";

const pod = (payload: Record<string, unknown> = {}) => ({
  timestamp: "2026-09-27T15:19:59.365123Z", severity: "INFO", insertId: "one",
  resource: { type: "k8s_container", labels: { namespace_name: "octogee", pod_name: "octogee-gateway-shared-abc-123-xyz", container_name: "gateway" } },
  jsonPayload: { message: "Target verified", service: "provisioner", builderSlug: "alice", gatewayId: "shared-abc", status: "succeeded", durationMs: 163, ...payload },
});

describe("fleet log records", () => {
  it("keeps structured identity and details instead of flattening them away", () => {
    const entry = normalizeFleetLog(pod());
    expect(entry).toMatchObject({ severity: "INFO", service: "provisioner", builderSlug: "alice", gatewayId: "shared-abc", instance: "octogee-gateway-shared-abc-123-xyz", message: "Target verified", details: { durationMs: 163 } });
    expect(renderFleetLogLine(entry, { color: false })).toBe("15:19:59.365Z INFO provisioner shared-abc/xyz builder=alice 🟢 Target verified durationMs=163");
  });

  it("reads gcloud live tail's protobuf field names as well as history REST names", () => {
    const { jsonPayload, ...entry } = pod();
    expect(normalizeFleetLog({ ...entry, severity: 200, json_payload: jsonPayload })).toMatchObject({ service: "provisioner", builderSlug: "alice", message: "Target verified" });
    expect(normalizeFleetLog({ ...entry, text_payload: "plain stdout" }).message).toBe("plain stdout");
  });

  it("distinguishes old and replacement pods serving the same gateway", () => {
    const old = pod();
    const next = { ...old, resource: { ...old.resource, labels: { ...old.resource.labels, pod_name: "octogee-gateway-shared-abc-456-new" } } };
    expect(renderFleetLogLine(normalizeFleetLog(old), { color: false })).not.toBe(renderFleetLogLine(normalizeFleetLog(next), { color: false }));
  });

  it("unwraps Docker gcplogs JSON and trusts emitted severity over DEFAULT", () => {
    const entry = normalizeFleetLog({ timestamp: "2026-09-27T15:19:59Z", severity: 0, resource: { type: "gce_instance" }, jsonPayload: {
      instance: { name: "octogee-pool-abcd" }, container: { name: "/octogee-gateway-edge", metadata: { "ai.octogee.gateway-id": "alice-s-123", "ai.octogee.container": "gateway-edge" } },
      message: JSON.stringify({ severity: "ERROR", service: "gateway-edge", builderSlug: "alice", message: "Request failed", err: { message: "upstream unavailable" } }),
    } });
    expect(entry).toMatchObject({ severity: "ERROR", service: "gateway-edge", builderSlug: "alice", gatewayId: "alice-s-123", instance: "octogee-pool-abcd", message: "Request failed" });
    expect(matchesFleetLog(entry, { level: "WARNING", services: ["gateway-edge"], builders: ["alice"] })).toBe(true);
  });

  it("never invents Builder identity from an instance or incidental message text", () => {
    const entry = normalizeFleetLog(pod({ builderSlug: undefined, message: "Looking up alice; slug=alice" }));
    expect(entry.builderSlug).toBeUndefined();
    expect(matchesFleetLog(entry, { builders: ["alice"] })).toBe(false);
  });

  it("distinguishes application numeric levels from Cloud Logging numeric severity", () => {
    expect(normalizeFleetLog(pod({ level: 50 })).severity).toBe("ERROR");
    expect(normalizeFleetLog({ ...pod(), jsonPayload: { message: "failure" }, severity: 500 }).severity).toBe("ERROR");
  });

  it("keeps unknown severity visible at info but excludes it from warning/error filters", () => {
    const entry = normalizeFleetLog({ ...pod(), severity: undefined, jsonPayload: { message: "plain text" } });
    expect(entry.severity).toBe("DEFAULT");
    expect(matchesFleetLog(entry, { level: "INFO" })).toBe(true);
    expect(matchesFleetLog(entry, { level: "WARNING" })).toBe(false);
  });

  it("combines filters with AND and list values with OR, matching slugs exactly", () => {
    const entry = normalizeFleetLog(pod());
    expect(matchesFleetLog(entry, { services: ["api", "provisioner"], builders: ["alice"] })).toBe(true);
    expect(matchesFleetLog(entry, { services: ["api"], builders: ["alice"] })).toBe(false);
    expect(matchesFleetLog(entry, { builders: ["ali"] })).toBe(false);
    expect(matchesFleetLog(entry, { levelExact: ["WARNING", "ERROR"] })).toBe(false);
  });

  it("removes producer ANSI and duplicate timestamps, escaping multiline text for one-line output", () => {
    const entry = normalizeFleetLog({ ...pod(), jsonPayload: undefined, textPayload: "\u001b[31m2026-09-27T15:19:59.365+00:00 [ws] connected\u001b[0m\nnext\tline" });
    const line = renderFleetLogLine(entry, { color: false, timestamps: "full" });
    expect(line).toContain("2026-09-27T15:19:59.365Z INFO gateway");
    expect(line).toContain("[ws] connected\\nnext\\tline");
    expect(line).not.toContain("\u001b");
  });

  it("preserves third-party structured context and unknown payloads", () => {
    expect(normalizeFleetLog({ ...pod(), jsonPayload: { msg: "Received HTTP request", level: "debug", request_id: "r1", url: "/api/v4/users" } })).toMatchObject({ severity: "DEBUG", details: { request_id: "r1", url: "/api/v4/users" } });
    expect(normalizeFleetLog({ ...pod(), jsonPayload: { diagnostic: "why" } }).details).toEqual({ diagnostic: "why" });
  });
});

describe("fleet logs CLI", () => {
  it("accepts comma lists and validates standard options", () => {
    expect(parseFleetLogsOptions(["--env=prod", "logs", "--level", "warn", "--service=api,cowboy", "--builder=alice,bob", "--no-follow", "--since=30m"])).toMatchObject({ environment: "prod", level: "WARNING", services: ["api", "cowboy"], builders: ["alice", "bob"], follow: false, since: "30m" });
  });
  it.each([["--levle=warn"], ["--service"], ["--level=loud"], ["--builder=alice,"], ["--since=forever"], ["--format=xml"], ["--level=warn", "--level-exact=error"], ["--limit=0"], ["--service=api", "--service=gateway"]])("rejects invalid options %j", (...extra) => {
    expect(() => parseFleetLogsOptions(["--env=prod", "logs", ...extra])).toThrow();
  });
  it("does not push severity or Builder filtering ahead of VM JSON normalization", () => {
    expect(buildFleetLogsFilter({ namespace: "octogee" })).toContain('jsonPayload.container.metadata."ai.octogee.namespace"="octogee"');
    expect(fleetLogsTailArgs({ projectId: "octogee", filter: "filter" })).toContain("--format=json");
  });
  it("includes revisioned gateway pods without matching a different gateway", () => {
    const filter = buildFleetLogsFilter({ namespace: "octogee", gatewayId: "shared-a" });
    const pattern = new RegExp(filter.match(/pod_name=~"([^"]+)"/)![1]);
    expect(pattern.test("octogee-gateway-shared-a-abc123-xyz12")).toBe(true);
    expect(pattern.test("octogee-gateway-shared-a-r2-abc123-xyz12")).toBe(true);
    expect(pattern.test("octogee-gateway-shared-a-r12-abc123-xyz12")).toBe(true);
    expect(pattern.test("octogee-gateway-shared-ab-r2-abc123-xyz12")).toBe(false);
  });
  it("streams complete records before the array closes and handles split UTF-8", () => {
    const seen: unknown[] = [];
    const parser = createFleetLogsParser(value => seen.push(value));
    const bytes = Buffer.from('[{"message":"🟢 ready"},');
    for (const byte of bytes) parser.write(Buffer.from([byte]));
    expect(seen).toEqual([{ message: "🟢 ready" }]);
    parser.write('{"message":"done"}]');
    if (!parser.isEnded) parser.end();
    expect(seen).toHaveLength(2);
  });
  it("fails visibly on malformed transport JSON", () => {
    const parser = createFleetLogsParser(() => {});
    expect(() => parser.write('[{"message": INVALID}]')).toThrow();
  });
});
