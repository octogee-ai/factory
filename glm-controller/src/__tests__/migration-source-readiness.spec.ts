import { describe, expect, it } from 'vitest';
import { migrationSourceReady } from '../migration-root-stability.js';

describe('migration source readiness', () => {
  const source = { gatewayClass: 'builder', desiredStatus: 'running', desiredRelease: 2, liveRelease: 1 };
  it('allows a Native forward recovery to retain its exact live source through a pending rollout', () => {
    expect(migrationSourceReady(source, 1)).toBe(true);
    expect(migrationSourceReady(source)).toBe(false);
  });
  it.each([
    { ...source, liveRelease: 2 },
    { ...source, liveRelease: null },
    { ...source, desiredStatus: 'retired' },
    { ...source, gatewayClass: 'shared' },
  ])('refuses a changed or retired recovery source', changed => {
    expect(migrationSourceReady(changed, 1)).toBe(false);
  });
});
