import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const exec = promisify(execFile);
const container = process.env.OCTOGEE_NATIVE_SYSTEMD_CONTAINER;

describe.skipIf(!container)("native retained-home service admission", () => {
  it.each(["docker.service", "user@1000.service"].flatMap(service => [{ service, post: false }, { service, post: true }]))("blocks $service when mount/native post-admission fails (post=$post)", async ({ service, post }) => {
    const id = `octogee-home-${randomUUID()}`;
    const directory = await mkdtemp(join(tmpdir(), `${id}-`));
    const remote = `/opt/${id}`;
    const unit = `${id}.service`;
    const homeUnit = `${id}-home.service`;
    const docker = async (...args: string[]) => exec("docker", ["exec", container!, ...args], { timeout: 10_000 });
    let installed = false;
    try {
      const dropIn = resolve(import.meta.dirname, `../../../infra/desktop/image/rootfs/etc/systemd/system/${service}.d/10-octogee-home.conf`);
      await writeFile(join(directory, "admission.conf"), (await readFile(dropIn, "utf8")).replaceAll("octo-home-disk.service", homeUnit));
      await writeFile(join(directory, "actor.service"), `[Service]\nType=oneshot\nRemainAfterExit=yes\nExecStart=/bin/sh -c 'printf written > ${remote}/fallback-write'\n`);
      await writeFile(join(directory, "home.service"), `[Service]\nType=oneshot\nRemainAfterExit=yes\nExecStart=${post ? "/bin/true\nExecStartPost=/bin/false" : "/bin/false"}\n`);
      await exec("docker", ["cp", directory, `${container}:${remote}`]);
      await docker("sh", "-c", `set -eu; cp '${remote}/actor.service' '/run/systemd/system/${unit}'; cp '${remote}/home.service' '/run/systemd/system/${homeUnit}'; systemctl daemon-reload`);
      installed = true;
      await docker("systemctl", "start", unit);
      expect((await docker("cat", `${remote}/fallback-write`)).stdout).toBe("written");
      await docker("systemctl", "stop", unit);
      await docker("sh", "-c", `set -eu; rm '${remote}/fallback-write'; mkdir '/run/systemd/system/${unit}.d'; cp '${remote}/admission.conf' '/run/systemd/system/${unit}.d/admission.conf'; systemctl daemon-reload`);
      await expect(docker("systemctl", "start", unit)).rejects.toMatchObject({ code: 1 });
      expect((await docker("systemctl", "show", unit, "-p", "ExecMainPID", "-p", "ActiveState")).stdout).toContain("ExecMainPID=0");
      await expect(docker("test", "-e", `${remote}/fallback-write`)).rejects.toMatchObject({ code: 1 });
      await docker("sh", "-c", `set -eu; sed -i 's|/bin/false|/bin/true|' '/run/systemd/system/${homeUnit}'; systemctl daemon-reload; systemctl reset-failed '${homeUnit}'; systemctl start '${unit}'`);
      expect((await docker("systemctl", "is-active", homeUnit)).stdout.trim()).toBe("active");
      expect((await docker("cat", `${remote}/fallback-write`)).stdout).toBe("written");
    } finally {
      try {
        if (installed) await docker("systemctl", "stop", unit, homeUnit);
        await docker("sh", "-c", `rm -rf '/run/systemd/system/${unit}' '/run/systemd/system/${unit}.d' '/run/systemd/system/${homeUnit}' '${remote}'; systemctl daemon-reload`);
      } finally { await rm(directory, { recursive: true, force: true }); }
    }
  });
});
