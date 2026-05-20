/**
 * Probe the installed OpenClaw CLI for its version string. Surfaced in
 * the fleet-controller boot log + heartbeat so operators can confirm what
 * gateway pod is running which OC build without exec'ing in.
 *
 * Returns "unknown" on any failure — missing binary, non-zero exit,
 * spawn permission denied. The string makes it into the
 * `gateways/{id}.openclawVersion` heartbeat field; "unknown" is a fine
 * sentinel for ops since it's clearly distinguishable from real version
 * strings.
 *
 * The execFile dep is injectable for test; production wires the absolute
 * binary path explicitly (sonarjs/no-os-command-from-path) — a poisoned
 * PATH could otherwise shadow the binary.
 */

export type ExecFile = (
  file: string,
  args: ReadonlyArray<string>,
  options: { stdio: ["ignore", "pipe", "ignore"] },
) => Buffer;

export interface ProbeOpenClawVersionDeps {
  execFile: ExecFile;
  /** Absolute binary path — production passes /usr/local/bin/openclaw. */
  binaryPath: string;
}

export function probeOpenClawVersion(deps: ProbeOpenClawVersionDeps): string {
  try {
    return deps
      .execFile(deps.binaryPath, ["--version"], {
        stdio: ["ignore", "pipe", "ignore"],
      })
      .toString()
      .trim();
  } catch {
    return "unknown";
  }
}
