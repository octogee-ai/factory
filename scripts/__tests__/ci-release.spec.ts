import { expect, it, vi } from 'vitest';
import { deployRelease, releaseOptions } from '../ci/release-plan.mjs';

const options = releaseOptions(['--environment=test', `--sha=${'a'.repeat(40)}`, '--actor=operator:test']);
function dependencies() {
  return { manifest: vi.fn(async () => ({ sourceSha: options.sha })), lock: vi.fn(async (run: () => Promise<void>) => run()), platform: vi.fn(async () => undefined), site: vi.fn(async () => undefined), desktop: vi.fn(async () => undefined), fleet: vi.fn(async () => undefined) };
}
function deferred() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<undefined>((done, fail) => { resolve = () => done(undefined); reject = fail; });
  return { promise, resolve, reject };
}
const settle = () => new Promise(resolve => setTimeout(resolve, 0));
it('rejects an unbuilt or substituted SHA before any deployment', async () => {
  const deps = dependencies();
  deps.manifest.mockResolvedValue({ sourceSha: 'b'.repeat(40) });
  await expect(deployRelease(options, deps)).rejects.toThrow();
  expect(deps.platform).not.toHaveBeenCalled();
});
it('deploys existing platform/site artifacts and keeps Builder deployment separate', async () => {
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
