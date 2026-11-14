import { describe, expect, it } from "vitest";
import { parse } from "yaml";

import { findDoc, useUmbrellaChart } from "./helpers/umbrella-chart";

const chart = useUmbrellaChart("octogee-api-gateway-pod-reader-");

describe("octogee-api gateway pod reader", () => {
  it("lets octogee-api read single pods in its own namespace, and nothing more", () => {
    const rendered = chart.helmTemplate({ namespace: "octogee-test" });

    const role = parse(findDoc(rendered, "Role", "octogee-api-gateway-pod-reader") ?? "null") as {
      metadata: { namespace: string };
      rules: unknown[];
    } | null;
    expect(role, "the chart renders the pod reader Role").not.toBeNull();
    expect(role!.metadata.namespace).toBe("octogee-test");
    expect(role!.rules).toEqual([{ apiGroups: [""], resources: ["pods"], verbs: ["get"] }]);

    const binding = parse(findDoc(rendered, "RoleBinding", "octogee-api-gateway-pod-reader") ?? "null") as {
      metadata: { namespace: string };
      roleRef: unknown;
      subjects: unknown[];
    } | null;
    expect(binding, "the chart renders the pod reader RoleBinding").not.toBeNull();
    expect(binding!.metadata.namespace).toBe("octogee-test");
    expect(binding!.roleRef).toEqual({ apiGroup: "rbac.authorization.k8s.io", kind: "Role", name: "octogee-api-gateway-pod-reader" });
    expect(binding!.subjects).toEqual([{ kind: "ServiceAccount", name: "octogee-api", namespace: "octogee-test" }]);
  });
});
