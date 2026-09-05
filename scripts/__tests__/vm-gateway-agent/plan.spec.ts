import { describe, expect, it } from "vitest";
import { imagesToPull, planBundle, planContainer, runningVersion } from "../../lib/vm-gateway-agent/plan";
import { bundleFixture } from "./fixture";

const ctx = { stateRoot: "/srv/octogee", instanceId: "4242" };

describe("planBundle", () => {
  it("maps the pod contract onto host-network containers with bound volumes, tokens, and aliases", () => {
    const plan = planBundle(bundleFixture(), ctx);

    expect(plan.init?.name).toBe("octogee-fix-perms");
    expect(plan.init?.config).toMatchObject({
      Entrypoint: ["sh", "-c", "cp -rn /etc/skel/. /home/node/"],
      User: "1000:1000",
      HostConfig: { RestartPolicy: { Name: "no" }, NetworkMode: "host" },
    });

    const gateway = plan.services[0];
    expect(gateway.name).toBe("octogee-gateway");
    expect(gateway.config.Image).toBe("us-central1-docker.pkg.dev/octogee/octogee/gateway:main.abc");
    expect(gateway.config.Env).toEqual(["GATEWAY_ID=b-x", "POD_UID=4242", "K8S_NAMESPACE=octogee-test"]);
    expect((gateway.config.HostConfig as { Binds: string[] }).Binds).toEqual([
      "/srv/octogee/volumes/data:/home/node",
      "/srv/octogee/volumes/secret-resolver/secret-resolver.mjs:/octogee/scripts/secret-resolver.mjs:ro",
      "/srv/octogee/tokens/gateway-broker-sa-token:/var/run/secrets/octogee-gateway-broker:ro",
      "/home/octo/Documents:/home/octo/Documents",
    ]);
    expect((gateway.config.HostConfig as { ExtraHosts: string[] }).ExtraHosts).toEqual(["octogee-api.octogee-test.svc.cluster.local:10.128.9.9"]);
    expect(gateway.config.Labels).toEqual({ "ai.octogee.bundle-version": "v1", "ai.octogee.gateway-id": "b-x", "ai.octogee.role": "service" });
    expect(gateway.config).not.toHaveProperty("Entrypoint");

    const edge = plan.services[1];
    expect(edge.config.Env).toEqual(expect.arrayContaining([
      "KUBERNETES_SERVICE_HOST=10.128.0.2",
      "KUBERNETES_SERVICE_PORT_HTTPS=443",
    ]));
    expect((edge.config.HostConfig as { Binds: string[] }).Binds).toContain("/srv/octogee/tokens/k8s-api-token:/var/run/secrets/kubernetes.io/serviceaccount:ro");
    expect((edge.config.HostConfig as { RestartPolicy: { Name: string } }).RestartPolicy).toEqual({ Name: "unless-stopped" });
  });

  it("shares only desktop Documents with the VM gateway service, excluding edge, init, and browser credentials", () => {
    const bundle = bundleFixture();
    const plan = planBundle(bundle, ctx);
    const desktopBinds = (config: Record<string, unknown>) =>
      (config.HostConfig as { Binds: string[] }).Binds.filter((bind) => bind.includes("/home/octo"));
    expect(desktopBinds(plan.services[0].config)).toEqual(["/home/octo/Documents:/home/octo/Documents"]);
    expect(desktopBinds(plan.services[1].config)).toEqual([]);
    expect(desktopBinds(plan.init!.config)).toEqual([]);
    expect(desktopBinds(planContainer(bundle, bundle.containers[0], ctx, "init").config)).toEqual([]);
  });

  it("refuses a mount onto an unknown volume and lists each image once", () => {
    const bundle = bundleFixture();
    bundle.containers[0].mounts.push({ volume: "ghost", mountPath: "/x", readOnly: true, subPath: null });
    expect(() => planBundle(bundle, ctx)).toThrow(/unknown volume ghost/);
    expect(imagesToPull(bundleFixture())).toEqual([
      "us-central1-docker.pkg.dev/octogee/octogee/gateway:main.abc",
      "us-central1-docker.pkg.dev/octogee/octogee/gateway-edge:main.abc",
    ]);
  });

  it("reads the applied version off a container's labels", () => {
    expect(runningVersion({ Config: { Labels: { "ai.octogee.bundle-version": "v7" } } })).toBe("v7");
    expect(runningVersion({ Config: {} })).toBeNull();
    expect(runningVersion(null)).toBeNull();
  });
});
