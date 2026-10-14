import { expect, it, vi } from 'vitest';
import { deployRelease, releaseOptions } from '../ci/release-plan.mjs';

const options = releaseOptions(['--environment=test', `--sha=${'a'.repeat(40)}`, '--actor=operator:test']);
function dependencies() {
  return { manifest: vi.fn(async () => ({ sourceSha: options.sha })), lock: vi.fn(async (run: () => Promise<void>) => run()), platform: vi.fn(async () => undefined), site: vi.fn(async () => undefined), desktop: vi.fn(async () => undefined), fleet: vi.fn(async () => undefined) };
}
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
it('runs complete fleet journaling/convergence only for explicit Ship TEST', async () => {
  const deps = dependencies();
  await deployRelease({ ...options, shipTest: true }, deps);
  expect(deps.fleet).toHaveBeenCalledOnce();
  expect(deps.fleet.mock.invocationCallOrder[0]).toBeGreaterThan(deps.desktop.mock.invocationCallOrder[0]);
});
it.each(['platform', 'site', 'desktop'] as const)('does not advance the fleet after a failed %s deployment', async stage => {
  const deps = dependencies();
  deps[stage].mockRejectedValue(new Error('failed'));
  await expect(deployRelease({ ...options, shipTest: true }, deps)).rejects.toThrow('failed');
  expect(deps.fleet).not.toHaveBeenCalled();
});
it('rejects a request to fan out the PROD fleet', () => {
  expect(() => releaseOptions(['--environment=prod', `--sha=${'a'.repeat(40)}`, '--actor=operator:test', '--ship-test'])).toThrow();
});
