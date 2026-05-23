import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";
import { describe, it, expect } from "vitest";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PROVISION_SRC = path.resolve(__dirname, "../lib/mattermost/provision.ts");

describe("Builder MM user is created with least-privilege role (#766)", () => {
  function getUserCreateBody(): string {
    const src = fs.readFileSync(PROVISION_SRC, "utf-8");
    const userCreateIdx = src.indexOf('mmApiCall("POST", "/users"');
    expect(userCreateIdx).toBeGreaterThan(-1);

const bodyEnd = src.indexOf("if (!mmUser)", userCreateIdx);
    expect(bodyEnd).toBeGreaterThan(userCreateIdx);
    return src.slice(userCreateIdx, bodyEnd);
  }

  it("POST /users body declares roles: \"system_user\" explicitly", () => {
    expect(getUserCreateBody()).toMatch(/roles:\s*"system_user"/);
  });

  it("POST /users body never grants system_admin", () => {
    expect(getUserCreateBody()).not.toMatch(/system_admin/);
  });
});
