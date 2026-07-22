import { describe, expect, it } from "vitest";

import { selectExistingProtectionTargets } from "../ops/terraform-protection-targets.mjs";

describe("Terraform emergency protection targets", () => {
  it("selects only protection-capable resources present in a synthetic partial state", () => {
    const targets = selectExistingProtectionTargets(
      [
        "google_compute_network.west",
        "google_container_cluster.west",
        "google_pubsub_topic.gke_notifications",
      ],
      [
        "google_container_cluster.west",
        "google_sql_database_instance.west",
        "google_vpc_access_connector.west",
      ],
    );

    expect(targets).toEqual(["google_container_cluster.west"]);
  });
});
