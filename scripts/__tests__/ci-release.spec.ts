import { expect, it, vi } from 'vitest';
import { withFleetStore } from '../ci/fleet-store.mjs';
import { deployRelease, fleetStoreStages, installReleaseTools, releaseOptions } from '../ci/release-plan.mjs';

const options = releaseOptions(['--environment=test', `--sha=${'a'.repeat(40)}`, '--actor=operator:test']);
function dependencies() {
  return { manifest: vi.fn(async () => ({ sourceSha: options.sha })), lock: vi.fn(async (run: () => Promise<void>) => run()), platform: vi.fn(async () => undefined), site: vi.fn(async () => undefined), desktop: vi.fn(async () => undefined), fleet: vi.fn(async () => undefined), isolatedCheck: vi.fn(async () => undefined) };
}
function deferred() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<undefined>((done, fail) => { resolve = () => done(undefined); reject = fail; });
  return { promise, resolve, reject };
}
const settle = () => new Promise(resolve => setTimeout(resolve, 0));
it('packs the overlay libraries into the installed scripts package before the root install', () => {
  const run = vi.fn();
  installReleaseTools(run);
  expect(run.mock.calls).toEqual([
    ['npm', ['ci', '--prefix', 'platform/scripts', '--no-audit', '--no-fund']],
    ['node', ['platform/scripts/ops/sync-local-file-deps.mjs', '--consumer', 'platform/scripts']],
    ['npm', ['ci', '--ignore-scripts', '--no-audit', '--no-fund']],
  ]);
});
it('rejects an unbuilt or substituted SHA before any deployment', async () => {
  const deps = dependencies();
  deps.manifest.mockResolvedValue({ sourceSha: 'b'.repeat(40) });
  await expect(deployRelease(options, deps)).rejects.toThrow();
  expect(deps.platform).not.toHaveBeenCalled();
});
it('deploys existing platform/site artifacts and keeps user deployment separate', async () => {
  const deps = dependencies();
  await deployRelease(options, deps);
  expect(deps.fleet).not.toHaveBeenCalled();
  expect(deps.desktop.mock.invocationCallOrder[0]).toBeGreaterThan(deps.platform.mock.invocationCallOrder[0]);
});
it('deploys the site while the platform rollout is still running', async () => {
  const deps = dependencies();
  const platform = deferred();
  deps.platform.mockReturnValue(platform.promise);
  const release = deployRelease(options, deps);
  await settle();
  expect(deps.site).toHaveBeenCalledOnce();
  expect(deps.desktop).not.toHaveBeenCalled();
  platform.resolve();
  await release;
  expect(deps.desktop).toHaveBeenCalledOnce();
});
it('holds Firebase deployment until the cutover platform is ready', async () => {
  const deps = dependencies();
  const platform = deferred();
  deps.platform.mockReturnValue(platform.promise);
  const release = deployRelease(options, { ...deps, siteAfterPlatform: true });
  await settle();
  expect(deps.site).not.toHaveBeenCalled();
  platform.resolve();
  await release;
  expect(deps.site).toHaveBeenCalledOnce();
});
it('leaves Firebase deployment held when the cutover platform fails', async () => {
  const deps = dependencies();
  deps.platform.mockRejectedValue(new Error('cutover import missing'));
  await expect(deployRelease(options, { ...deps, siteAfterPlatform: true })).rejects.toThrow('cutover import missing');
  expect(deps.site).not.toHaveBeenCalled();
});
it('holds the deploy lock until the platform settles after the site fails', async () => {
  const deps = dependencies();
  const platform = deferred();
  deps.platform.mockReturnValue(platform.promise);
  deps.site.mockRejectedValue(new Error('site failed'));
  let finished = false;
  const release = deployRelease({ ...options, shipTest: true }, deps).finally(() => { finished = true; });
  await settle();
  expect(finished).toBe(false);
  platform.resolve();
  await expect(release).rejects.toThrow('site failed');
  expect(deps.fleet).not.toHaveBeenCalled();
});
it('reports both branch failures when platform and site fail together', async () => {
  const deps = dependencies();
  deps.platform.mockRejectedValue(new Error('helm failed'));
  deps.site.mockRejectedValue(new Error('hosting failed'));
  await expect(deployRelease(options, deps)).rejects.toThrow(/helm failed.*hosting failed/);
  expect(deps.desktop).not.toHaveBeenCalled();
});
it('runs complete fleet journaling/convergence only for explicit Ship TEST, after every other surface', async () => {
  const deps = dependencies();
  const platform = deferred();
  deps.platform.mockReturnValue(platform.promise);
  const release = deployRelease({ ...options, shipTest: true }, deps);
  await settle();
  platform.resolve();
  await release;
  expect(deps.fleet).toHaveBeenCalledOnce();
  for (const stage of [deps.desktop, deps.site]) expect(deps.fleet.mock.invocationCallOrder[0]).toBeGreaterThan(stage.mock.invocationCallOrder[0]);
});
it.each(['platform', 'site', 'desktop'] as const)('does not advance the fleet after a failed %s deployment', async stage => {
  const deps = dependencies();
  deps[stage].mockRejectedValue(new Error('failed'));
  await expect(deployRelease({ ...options, shipTest: true }, deps)).rejects.toThrow('failed');
  expect(deps.fleet).not.toHaveBeenCalled();
});
it('checks the isolated gateway only in Ship TEST, after the fleet converges', async () => {
  const deps = dependencies();
  await deployRelease({ ...options, shipTest: true }, deps);
  expect(deps.isolatedCheck).toHaveBeenCalledOnce();
  expect(deps.isolatedCheck.mock.invocationCallOrder[0]).toBeGreaterThan(deps.fleet.mock.invocationCallOrder[0]);
  const deploy = dependencies();
  await deployRelease(options, deploy);
  const prod = dependencies();
  await deployRelease(releaseOptions(['--environment=prod', `--sha=${'a'.repeat(40)}`, '--actor=operator:test', '--ship-prod']), prod);
  for (const unchecked of [deploy, prod]) expect(unchecked.isolatedCheck).not.toHaveBeenCalled();
});
it('does not check the isolated gateway when the fleet does not converge', async () => {
  const deps = dependencies();
  deps.fleet.mockRejectedValue(new Error('fleet timed-out'));
  await expect(deployRelease({ ...options, shipTest: true }, deps)).rejects.toThrow('fleet timed-out');
  expect(deps.isolatedCheck).not.toHaveBeenCalled();
});
it('runs the PROD fleet after platform, desktop and site deployment', async () => {
  const prod = releaseOptions(['--environment=prod', `--sha=${'a'.repeat(40)}`, '--actor=operator:test', '--ship-prod']);
  const deps = dependencies();
  await deployRelease(prod, deps);
  expect(deps.fleet).toHaveBeenCalledOnce();
  for (const stage of [deps.desktop, deps.site]) expect(deps.fleet.mock.invocationCallOrder[0]).toBeGreaterThan(stage.mock.invocationCallOrder[0]);
});
it('rejects a shipment targeting the wrong environment', () => {
  expect(() => releaseOptions(['--environment=prod', `--sha=${'a'.repeat(40)}`, '--actor=operator:test', '--ship-test'])).toThrow();
  expect(() => releaseOptions(['--environment=test', `--sha=${'a'.repeat(40)}`, '--actor=operator:test', '--ship-prod'])).toThrow();
});
it.each([
  ['desktop', 'desktop', ['ops/release-desktop-image.ts']],
  ['fleet', 'fleet', ['ops/deploy-fleet.ts', `--sha=${options.sha}`, '--timeout-ms=3600000']],
  ['isolatedCheck', 'isolated-check', ['ops/check-isolated-gateway.ts', `--sha=${options.sha}`, '--timeout-ms=1200000']],
] as const)('runs the %s stage against the deployed PostgreSQL store through a tunnel it closes afterwards', async (key, label, script) => {
  const close = vi.fn(async () => {});
  const inspect = vi.fn(async () => ({ host: '10.89.0.11', port: 5432, database: 'platform', user: 'runtime', password: 'runtime-password', sslmode: 'require', image: 'fleet-controller@sha256:abc' }));
  const tunnel = vi.fn(async () => ({ port: 15432, close }));
  const storeDependencies = vi.fn(() => ({ inspect, tunnel }));
  const stage = vi.fn(async () => undefined);

  await fleetStoreStages({ environment: options.environment, sha: options.sha, stage, withStore: withFleetStore, storeDependencies })[key]();

  expect(storeDependencies).toHaveBeenCalledWith('test');
  expect(stage).toHaveBeenCalledWith(label, 'node', ['--import', './node_modules/tsx/dist/loader.mjs', ...script], {
    cwd: 'platform/scripts',
    env: expect.objectContaining({ PLATFORM_DB_HOST: '127.0.0.1', PLATFORM_DB_PORT: '15432', PLATFORM_DB_NAME: 'platform', PLATFORM_DB_USER: 'runtime', PLATFORM_DB_PASSWORD: 'runtime-password', PLATFORM_DB_SSLMODE: 'require' }),
  });
  expect(close.mock.invocationCallOrder[0]).toBeGreaterThan(stage.mock.invocationCallOrder[0]);
});
it('closes the store tunnel when a store-backed stage fails', async () => {
  const close = vi.fn(async () => {});
  const failure = new Error('desktop deployment exited with 1');
  const stages = fleetStoreStages({
    environment: options.environment,
    sha: options.sha,
    stage: vi.fn(async () => { throw failure; }),
    withStore: withFleetStore,
    storeDependencies: () => ({ inspect: async () => ({ host: '10.89.0.11', port: 5432, database: 'platform', user: 'runtime', password: 'runtime-password', sslmode: 'require', image: 'fleet-controller@sha256:abc' }), tunnel: async () => ({ port: 15432, close }) }),
  });

  await expect(stages.desktop()).rejects.toBe(failure);
  expect(close).toHaveBeenCalledTimes(1);
});
