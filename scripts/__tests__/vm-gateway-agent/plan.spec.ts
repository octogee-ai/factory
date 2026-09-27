import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { createSurgeReadinessGate } from "../../lib/surge-readiness";
import { createSurgeOpenClawProcessGate } from "../../lib/surge-openclaw-process-gate";
import { describe, expect, it } from "vitest";
import {
  envFor,
  imagesToPull,
  planBundle,
  planContainer,
  planInitSpec,
  runningInitSpec,
  runningSpec,
  runningVersion,
  specVersion,
} from "../../lib/vm-gateway-agent/plan";
import { bundleFixture } from "./fixture";

const ctx = { stateRoot: "/srv/octogee", instanceId: "4242", desktopAuth: true };

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
    expect(gateway.config.Env).toEqual(["GATEWAY_ID=b-x", "POD_UID=octogee-gateway-b-x-vm-4242", "K8S_NAMESPACE=octogee-test"]);
    expect((gateway.config.HostConfig as { Binds: string[] }).Binds).toEqual([
      "/srv/octogee/volumes/data:/home/node",
      "/srv/octogee/volumes/secret-resolver/secret-resolver.mjs:/octogee/scripts/secret-resolver.mjs:ro",
      "/srv/octogee/tokens/gateway-broker-sa-token:/var/run/secrets/octogee-gateway-broker:ro",
      "/home/octo/Documents:/home/octo/Documents",
    ]);
    expect((gateway.config.HostConfig as { ExtraHosts: string[] }).ExtraHosts).toEqual(["octogee-api.octogee-test.svc.cluster.local:10.128.9.9"]);
    expect(gateway.config.Labels).toEqual({
      "ai.octogee.bundle-version": "v1",
      "ai.octogee.container-spec": expect.stringMatching(/^[0-9a-f]{16}$/),
      "ai.octogee.init-spec": expect.stringMatching(/^[0-9a-f]{16}$/),
      "ai.octogee.gateway-id": "b-x",
      "ai.octogee.namespace": "octogee-test",
      "ai.octogee.container": "gateway",
      "ai.octogee.role": "service",
    });
    expect(gateway.config).not.toHaveProperty("Entrypoint");

    const edge = plan.services[1];
    expect(edge.config.Env).toEqual(expect.arrayContaining([
      "KUBERNETES_SERVICE_HOST=10.128.0.2",
      "KUBERNETES_SERVICE_PORT_HTTPS=443",
    ]));
    expect((edge.config.HostConfig as { Binds: string[] }).Binds).toContain("/srv/octogee/tokens/k8s-api-token:/var/run/secrets/kubernetes.io/serviceaccount:ro");
    expect((edge.config.HostConfig as { RestartPolicy: { Name: string } }).RestartPolicy).toEqual({ Name: "unless-stopped" });
  });

  it("labels dedicated Builder container logs with the configured slug", () => {
    const bundle = bundleFixture();
    bundle.containers[0].env.GATEWAY_BUILDER_SLUG = "alice";
    const plan = planBundle(bundle, ctx);
    for (const spec of [plan.init, ...plan.services]) {
      expect(spec!.config.Labels).toMatchObject({ "ai.octogee.builder-slug": "alice" });
      expect((spec!.config.HostConfig as { LogConfig: { Config: { labels: string } } }).LogConfig.Config.labels).toContain("ai.octogee.builder-slug");
    }
  });

  it("replaces sidecars when their logged Builder identity changes", () => {
    const bundle = bundleFixture();
    bundle.containers[0].env.GATEWAY_BUILDER_SLUG = "alice";
    const before = planBundle(bundle, ctx);
    bundle.containers[0].env.GATEWAY_BUILDER_SLUG = "bob";
    const after = planBundle(bundle, ctx);
    expect(specVersion(before.services[1])).not.toBe(specVersion(after.services[1]));
  });

  it("rejects conflicting Builder identities instead of mislabelling logs", () => {
    const bundle = bundleFixture();
    bundle.containers[0].env.GATEWAY_BUILDER_SLUG = "alice";
    bundle.containers[1].env.GATEWAY_BUILDER_SLUG = "bob";
    expect(() => planBundle(bundle, ctx)).toThrow(/conflicting/);
  });

  it("ships every container's logs to Cloud Logging tagged with its gateway and namespace", () => {
    const plan = planBundle(bundleFixture(), ctx);

    for (const spec of [plan.init, ...plan.services]) {
      expect((spec!.config.HostConfig as { LogConfig: unknown }).LogConfig).toEqual({
        Type: "gcplogs",
        Config: { labels: "ai.octogee.gateway-id,ai.octogee.namespace,ai.octogee.container,ai.octogee.role" },
      });
      expect((spec!.config.Labels as Record<string, string>)["ai.octogee.namespace"]).toBe("octogee-test");
    }

    expect((plan.init!.config.Labels as Record<string, string>)["ai.octogee.container"]).toBe("fix-perms");
    expect(plan.services.map((s) => (s.config.Labels as Record<string, string>)["ai.octogee.container"])).toEqual([
      "gateway",
      "gateway-edge",
    ]);
  });

  it("keeps shipping logs when an older platform renders a bundle without a namespace", () => {
    const plan = planBundle(bundleFixture({ namespace: undefined }), ctx);

    for (const spec of [plan.init, ...plan.services]) {
      expect((spec!.config.HostConfig as { LogConfig: unknown }).LogConfig).toEqual({
        Type: "gcplogs",
        Config: { labels: "ai.octogee.gateway-id,ai.octogee.container,ai.octogee.role" },
      });
      expect(spec!.config.Labels as Record<string, string>).not.toHaveProperty("ai.octogee.namespace");
    }
  });

  it("gives a reused VM a fresh process identity without changing it on a release update", () => {
    const first = bundleFixture();
    const next = { ...first, gatewayId: "b-next" };
    const env = (bundle: typeof first) => planBundle(bundle, ctx).services[0].config.Env as string[];
    expect(env(first)).toContain("POD_UID=octogee-gateway-b-x-vm-4242");
    expect(env(next)).toContain("POD_UID=octogee-gateway-b-next-vm-4242");
    expect(env({ ...next, version: "v2" })).toContain("POD_UID=octogee-gateway-b-next-vm-4242");
  });

  it("keeps a new activation held when its VM home contains an earlier gateway's readiness", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "vm-reuse-"));
    const uid = (gatewayId: string) => {
      const env = planBundle({ ...bundleFixture(), gatewayId }, ctx).services[0].config.Env as string[];
      return env.find((entry) => entry.startsWith("POD_UID="))!.slice("POD_UID=".length);
    };
    try {
      const previous = uid("previous");
      const next = uid("next");
      const gate = createSurgeOpenClawProcessGate(dir);
      await createSurgeReadinessGate(dir, previous).release({ targetPodUid: previous });
      await gate.ensure({ podUid: previous, readinessReleased: true });
      const readiness = createSurgeReadinessGate(dir, next);
      expect(await readiness.released()).toBe(false);
      await gate.ensure({ podUid: next, readinessReleased: await readiness.released() });
      await expect(gate.hydrateTarget({ podUid: next, targetPodUid: next, slug: "builder", migrationId: "new-activation" }))
        .resolves.toMatchObject({ role: "target", mode: "held" });
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
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

  it("gives only the desktop node the desktop's Wayland and XWayland sockets and the host PID namespace", () => {
    const bundle = bundleFixture();
    bundle.containers.push({
      name: "desktop-node",
      image: bundle.containers[0].image,
      env: { OPENCLAW_GATEWAY_PASSWORD: "gwtoken", XDG_RUNTIME_DIR: "/run/user/1000" },
      command: ["/usr/local/bin/octogee-desktop-node"],
      args: null,
      mounts: [{ volume: "desktop-node-state", mountPath: "/home/node/.openclaw", readOnly: false, subPath: null }],
    });
    bundle.volumes.push({ name: "desktop-node-state", kind: "emptyDir" });
    const plan = planBundle(bundle, ctx);
    const binds = (index: number) => (plan.services[index].config.HostConfig as { Binds: string[] }).Binds;
    expect(plan.services[2].name).toBe("octogee-desktop-node");
    expect(plan.services[2].config).toMatchObject({
      User: "1000:1000",
      Entrypoint: ["/usr/local/bin/octogee-desktop-node"],
      HostConfig: { NetworkMode: "host", PidMode: "host", RestartPolicy: { Name: "unless-stopped" } },
    });
    const pidMode = (index: number) => (plan.services[index].config.HostConfig as { PidMode?: string }).PidMode;
    expect(pidMode(0)).toBeUndefined();
    expect(pidMode(1)).toBeUndefined();
    expect((plan.init!.config.HostConfig as { PidMode?: string }).PidMode).toBeUndefined();
    expect(binds(2)).toEqual([
      "/srv/octogee/volumes/desktop-node-state:/home/node/.openclaw",
      "/run/user/1000:/run/user/1000",
      "/tmp/.X11-unix:/tmp/.X11-unix:ro",
    ]);
    expect(binds(0)).not.toContain("/run/user/1000:/run/user/1000");
    expect(binds(1)).not.toContain("/run/user/1000:/run/user/1000");
    expect(binds(0)).not.toContain("/tmp/.X11-unix:/tmp/.X11-unix:ro");
    expect(binds(1)).not.toContain("/tmp/.X11-unix:/tmp/.X11-unix:ro");
  });

  it("gives only the gateway service read-only access to its native desktop password", () => {
    const bundle = bundleFixture();
    const plan = planBundle(bundle, ctx);
    expect(plan.services[0].config.HostConfig).toMatchObject({
      Mounts: [{
        Type: "bind",
        Source: "/run/user/1000/octogee-openclaw-vnc",
        Target: "/run/octogee-desktop-vnc",
        ReadOnly: true,
      }],
    });
    expect(plan.services[1].config.HostConfig).not.toHaveProperty("Mounts");
    expect(plan.init!.config.HostConfig).not.toHaveProperty("Mounts");
    expect(planContainer(bundle, bundle.containers[0], ctx, "init").config.HostConfig).not.toHaveProperty("Mounts");
  });

  it("plans the gateway without the desktop password mount on a computer whose desktop publishes none", () => {
    const plan = planBundle(bundleFixture(), { ...ctx, desktopAuth: false });
    expect(plan.services[0].name).toBe("octogee-gateway");
    expect(plan.services[0].config.HostConfig).not.toHaveProperty("Mounts");
    expect(specVersion(plan.services[0])).not.toBe(specVersion(planBundle(bundleFixture(), ctx).services[0]));
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

  it("keys each container's spec on its own config, not the bundle version, and shares the init spec across services", () => {
    const first = planBundle(bundleFixture(), ctx);
    const renamedBundle = planBundle(bundleFixture({ version: "v2" }), ctx);
    const [gateway, edge] = bundleFixture().containers;
    const changedGateway = planBundle(bundleFixture({
      version: "v3",
      containers: [{ ...gateway, env: { ...gateway.env, NODE_OPTIONS: "--max-old-space-size=8192" } }, edge],
    }), ctx);
    const rolledInit = planBundle(bundleFixture({
      init: { ...bundleFixture().init!, image: "us-central1-docker.pkg.dev/octogee/octogee/gateway:main.def" },
    }), ctx);

    expect(specVersion(renamedBundle.services[0])).toBe(specVersion(first.services[0]));
    expect(specVersion(changedGateway.services[0])).not.toBe(specVersion(first.services[0]));
    expect(specVersion(changedGateway.services[1])).toBe(specVersion(first.services[1]));
    expect(runningSpec({ Config: first.services[0].config as { Labels: Record<string, string> } })).toBe(specVersion(first.services[0]));

    expect(planInitSpec(first)).toBe(runningInitSpec({ Config: first.services[1].config as { Labels: Record<string, string> } }));
    expect(planInitSpec(rolledInit)).not.toBe(planInitSpec(first));
    expect(planInitSpec(planBundle(bundleFixture({ init: null }), ctx))).toBe("none");
  });
});

describe("envFor", () => {
  it("fills the edge's computer instance id placeholder with this VM's instance id", () => {
    const bundle = bundleFixture();
    const edge = {
      ...bundle.containers[1],
      env: { ...bundle.containers[1].env, GATEWAY_COMPUTER_INSTANCE_ID: "", GATEWAY_COMPUTER_PROJECT_ID: "octogee" },
    };
    expect(envFor(bundle, edge, ctx)).toEqual(expect.arrayContaining([
      "GATEWAY_COMPUTER_INSTANCE_ID=4242",
      "GATEWAY_COMPUTER_PROJECT_ID=octogee",
    ]));
    expect(envFor(bundle, bundle.containers[1], ctx)).not.toEqual(expect.arrayContaining([expect.stringMatching(/^GATEWAY_COMPUTER_INSTANCE_ID=/)]));
  });
});
