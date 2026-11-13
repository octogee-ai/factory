import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runFleetLogsCommand } from "../lib/fleet-logs-command.js";

const { spawnMock } = vi.hoisted(() => ({ spawnMock: vi.fn() }));
vi.mock("node:child_process", () => ({ spawn: spawnMock }));
afterEach(() => { vi.restoreAllMocks(); spawnMock.mockReset(); });
const record = (message: string, timestamp: string) => ({ timestamp, severity: "INFO", resource: { type: "k8s_container", labels: { container_name: "octogee-api", pod_name: "api-1" } }, jsonPayload: { message, builderSlug: "alice", service: "api" } });
function fakeCloud(text: string, exitCode = 0) {
  const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), kill: vi.fn(() => true) });
  spawnMock.mockImplementation(() => {
    queueMicrotask(() => {
      child.stdout.end(text);
      child.stderr.end();
      setImmediate(() => child.emit("close", exitCode, null));
    });
    return child;
  });
  return child;
}
function capture() {
  let text = "";
  const stream = new Writable({ write(chunk, _encoding, callback) { text += chunk.toString(); callback(); } });
  return { stream, text: () => text };
}

describe("fleet logs command", () => {
  it("filters history and emits chronological JSON Lines without diagnostics on stdout", async () => {
    fakeCloud(JSON.stringify([record("new", "2026-09-27T12:00:02Z"), record("old", "2026-09-27T12:00:01Z")]));
    const output = capture(), diagnostics = capture();
    await runFleetLogsCommand(["--env=prod", "logs", "--no-follow", "--format=json", "--builder=alice", "--service=api"], output.stream, diagnostics.stream);
    expect(output.text().trim().split("\n").map(line => JSON.parse(line).message)).toEqual(["old", "new"]);
    expect(diagnostics.text()).toContain("Shown 2 of 2");
    expect(spawnMock.mock.calls[0][1]).toContain("--order=desc");
  });
  it("reports transport failure instead of presenting a successful empty result", async () => {
    fakeCloud("", 1);
    await expect(runFleetLogsCommand(["--env=test", "logs", "--no-follow"], capture().stream, capture().stream)).rejects.toThrow(/exited 1/);
  });
  it("rejects malformed records and terminates the transport", async () => {
    const child = fakeCloud('[{"timestamp":"2026-09-27T12:00:02Z"}, BROKEN]');
    await expect(runFleetLogsCommand(["--env=test", "logs"], capture().stream, capture().stream)).rejects.toThrow();
    expect(child.kill).toHaveBeenCalled();
  });
  it("validates options before starting gcloud", async () => {
    await expect(runFleetLogsCommand(["--env=test", "logs", "--levle=warn"], capture().stream, capture().stream)).rejects.toThrow();
    expect(spawnMock).not.toHaveBeenCalled();
  });
});

describe("fleet logs pipe behavior", () => {
  it("treats a downstream closed pipe as a clean stop", async () => {
    fakeCloud(JSON.stringify([record("event", "2026-09-27T12:00:00Z")]));
    const output = new Writable({ write(_chunk, _encoding, callback) { callback(Object.assign(new Error("closed"), { code: "EPIPE" })); } });
    await expect(runFleetLogsCommand(["--env=test", "logs", "--no-follow"], output, capture().stream)).resolves.toBeUndefined();
  });
});
