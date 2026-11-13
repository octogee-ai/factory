import { describe, expect, it } from "vitest";

import { useUmbrellaChart } from "./helpers/umbrella-chart";

const chart = useUmbrellaChart("octogee-release-image-required-");

const releaseImages = ["octogee-api", "llmBroker", "gateway-edge", "glm-controller", "mattermost"];

describe("platform chart without a release image", () => {
  it.each(releaseImages.flatMap((image) => ["tag", "digest"].map((field) => [image, field])))(
    "stops at render when %s.image.%s is empty",
    (image, field) => {
      expect(() => chart.helmTemplate({ sets: { [`${image}.image.${field}`]: "" } }))
        .toThrow(`${image}.image.${field} is required`);
    },
  );
});
