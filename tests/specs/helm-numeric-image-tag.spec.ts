import { describe, expect, it } from "vitest";

import { useUmbrellaChart } from "./helpers/umbrella-chart";

const chart = useUmbrellaChart("octogee-numeric-image-tag-");

// A short SHA is hex, so roughly one commit in twenty-five is all digits.
// Helm's --set infers the type, so those arrive as int64 and every template
// that formats them through printf "%s" renders "%!s(int64=…)" into the image
// reference. Kubernetes then rejects the Deployment with InvalidImageName and
// the release fails its progress deadline, which is what 5796059 did to TEST.
function rendered(tag: string): string {
  return chart.helmTemplate({
    sets: {
      "octogee-api.image.tag": tag,
      "glm-controller.image.tag": tag,
      "llmBroker.image.tag": tag,
    },
  });
}

describe("platform chart renders an all-numeric image tag", () => {
  it("never emits a Go format-verb error into a rendered manifest", () => {
    expect(rendered("5796059")).not.toContain("%!s(");
  });

  it("keeps the numeric tag intact in the images whose tag it was given", () => {
    const images = rendered("5796059")
      .split("\n")
      .filter((line) => line.includes("image:"))
      .filter((line) => /\/(octogee-api|glm-controller):/.test(line));

    expect(images.length).toBeGreaterThan(0);
    for (const image of images) {
      expect(image).toContain(":5796059@sha256:");
    }
  });
});
