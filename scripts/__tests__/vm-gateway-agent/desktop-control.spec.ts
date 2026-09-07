import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { expect, it } from "vitest";
import { createDesktopControl } from "../../lib/vm-gateway-agent/desktop-control";

it("sends only lifecycle actions through the private socket and surfaces systemd failures", async () => {
  const root = await mkdtemp(join(tmpdir(), "octogee-desktop-control-"));
  const socket = join(root, "control.sock");
  const requests: string[] = [];
  const server = createServer((req, res) => {
    requests.push(`${req.method} ${req.url}`);
    if (req.url === "/stop") res.writeHead(500).end("systemctl failed");
    else res.end("{}");
  });
  await new Promise<void>((resolve) => server.listen(socket, resolve));
  try {
    const control = createDesktopControl(socket);
    await control.run("freeze");
    await control.run("thaw");
    await expect(control.run("stop")).rejects.toThrow("systemctl failed");
    expect(requests).toEqual(["POST /freeze", "POST /thaw", "POST /stop"]);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
});

it.each([
  ["quiesces applications and recovers lifecycle failures", "test_lifecycle.py"],
  ["keeps managed desktops awake before starting the compositor", "test_idle.py"],
  ["checks fresh-image resize support before and after reboot", "test_acceptance.py"],
  ["checks screenshot and XWayland resize geometry", "test_display_resize.py"],
  ["keeps untested image candidates outside the family", "test_build.py"],
  ["validates resize requests and waits for output dimensions", "test_resize.py"],
])("%s", async (_behavior, filename) => {
  const script = resolve(__dirname, "../../../infra/desktop/image", filename);
  await expect(promisify(execFile)("python3", [script])).resolves.toMatchObject({
    stderr: expect.stringMatching(/Ran [1-9]\d* tests? in [^\n]+\n\nOK\s*$/),
  });
}, 30_000);
