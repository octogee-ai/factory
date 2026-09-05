import http from "node:http";

export interface DesktopControl {
  run(action: "freeze" | "thaw" | "stop" | "start"): Promise<void>;
}

function runDesktopAction(socketPath: string, action: Parameters<DesktopControl["run"]>[0]): Promise<void> {
  return new Promise<void>((resolve, reject) => {
      const req = http.request({ socketPath, method: "POST", path: `/${action}`, timeout: 60_000 }, (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("error", reject);
        res.on("end", () => {
          if (res.statusCode === 200) resolve();
          else reject(new Error(`desktop ${action}: HTTP ${res.statusCode}: ${Buffer.concat(chunks).toString("utf8").slice(-500)}`));
        });
      });
      req.on("error", reject);
      req.on("timeout", () => req.destroy(new Error(`desktop ${action} timed out`)));
      req.end();
  });
}

export function createDesktopControl(socketPath = "/run/octogee-desktop/control.sock"): DesktopControl {
  return { run: (action) => runDesktopAction(socketPath, action) };
}
