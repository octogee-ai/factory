import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import {
  BUSINESS_TYPE_TEMPLATES,
  MIME_TYPES,
  applyTemplatePlaceholders,
  copyDirSync,
  getTemplateForBusinessType,
  slugify,
} from "./helpers.js";

describe("helpers", () => {
  describe("slugify", () => {
    it("normalizes names into short lowercase url slugs", () => {
      expect(slugify(" Bob's Cafe & Bar! ")).toBe("bob-s-cafe-bar");
      expect(slugify("--hello--")).toBe("hello");
      expect(slugify("a".repeat(50))).toBe("a".repeat(30));
      expect(slugify("!!!")).toBe("");
    });
  });

  describe("getTemplateForBusinessType", () => {
    it("maps every declared business alias and falls back to general", () => {
      for (const [input, expected] of Object.entries(BUSINESS_TYPE_TEMPLATES)) {
        expect(getTemplateForBusinessType(input)).toBe(expected);
      }

      expect(getTemplateForBusinessType("pet grooming")).toBe("pet-services");
      expect(getTemplateForBusinessType("spaceship repair")).toBe("general");
      expect(getTemplateForBusinessType("")).toBe("general");
    });
  });

  describe("applyTemplatePlaceholders", () => {
    it("replaces literal placeholder keys without treating them as patterns", () => {
      expect(
        applyTemplatePlaceholders("{{name}} owns {{name}}. {{a.b}} {{axb}}", {
          name: "Octogee",
          "a.b": "literal",
        }),
      ).toBe("Octogee owns Octogee. literal {{axb}}");
    });
  });

  describe("copyDirSync", () => {
    let tmpDir: string;

    beforeEach(() => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "octogee-copydir-"));
    });

    afterEach(() => {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it("copies nested files while excluding runtime dependency and git metadata", () => {
      const src = path.join(tmpDir, "src");
      const dest = path.join(tmpDir, "dest");
      fs.mkdirSync(path.join(src, "nested"), { recursive: true });
      fs.mkdirSync(path.join(src, "node_modules", "pkg"), { recursive: true });
      fs.mkdirSync(path.join(src, ".git"), { recursive: true });
      fs.writeFileSync(path.join(src, "root.txt"), "root", "utf-8");
      fs.writeFileSync(path.join(src, "nested", "file.txt"), "nested", "utf-8");
      fs.writeFileSync(path.join(src, "node_modules", "pkg", "index.js"), "module", "utf-8");
      fs.writeFileSync(path.join(src, ".git", "HEAD"), "ref", "utf-8");

      copyDirSync(src, dest);

      expect(fs.readFileSync(path.join(dest, "root.txt"), "utf-8")).toBe("root");
      expect(fs.readFileSync(path.join(dest, "nested", "file.txt"), "utf-8")).toBe("nested");
      expect(fs.existsSync(path.join(dest, "node_modules"))).toBe(false);
      expect(fs.existsSync(path.join(dest, ".git"))).toBe(false);
    });
  });

  describe("MIME_TYPES", () => {
    it("keeps the upload and preview extensions mapped to their served content types", () => {
      expect(MIME_TYPES).toMatchObject({
        ".png": "image/png",
        ".jpg": "image/jpeg",
        ".svg": "image/svg+xml",
        ".pdf": "application/pdf",
        ".mp4": "video/mp4",
        ".zip": "application/zip",
      });
    });
  });
});
