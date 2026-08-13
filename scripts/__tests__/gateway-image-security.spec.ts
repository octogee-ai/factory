import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";

const dockerfile = fs.readFileSync(path.join(__dirname, "../../infra/gateway/Dockerfile"), "utf8");

describe("gateway image secret resolver permissions", () => {
  it("prevents the runtime user from replacing or modifying the resolver", () => {
    expect(dockerfile).toContain(
      "COPY --chown=root:root scripts/secret-resolver.mjs /octogee/scripts/",
    );
    expect(dockerfile).toContain(
      "/octogee/scripts/node_modules/.bin/esbuild /octogee/scripts/secret-resolver.mjs",
    );
    expect(dockerfile).toContain("--bundle --platform=node --format=esm");
    expect(dockerfile).toContain("chown root:root /octogee/scripts");
    expect(dockerfile).toContain("chmod 755 /octogee/scripts");
    expect(dockerfile).toContain("chmod 555 /octogee/scripts/secret-resolver.mjs");
  });
});
