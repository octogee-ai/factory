import { expect, it } from 'vitest';
import { validateDesktopImage, assertDesktopImageIdentity } from '../../.github/actions/release-digest-manifest/desktop-image.mjs';
const artifact = { project: 'octogee-test', name: 'octogee-computer-fixture', id: '123', sourceSha: 'a'.repeat(40), inputFingerprint: 'b'.repeat(64), acceptance: 'resize-reboot-v1' };
it.each([{ ...artifact, acceptance: undefined }, { ...artifact, sourceSha: 'main' }, { ...artifact, project: '../other' }, { ...artifact, id: 123 }])('rejects incomplete or unsafe artifact %j', (input) => {
  expect(() => validateDesktopImage(input)).toThrow();
});
it('rejects a recreated image with the same name', () => {
  expect(() => assertDesktopImageIdentity(artifact, { name: artifact.name, id: '124', status: 'READY', labels: { source: artifact.sourceSha } })).toThrow('no longer matches');
});
it('accepts only the tested immutable image identity', () => {
  expect(assertDesktopImageIdentity(artifact, { name: artifact.name, id: artifact.id, status: 'READY', labels: { source: artifact.sourceSha } })).toEqual(artifact);
});
