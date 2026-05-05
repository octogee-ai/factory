import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  _resetWsOriginWarningForTests,
  isAllowedWsOrigin,
  warnIfWsOriginsMisconfigured,
} from '../ws-origin.js';

const ENV_KEY = 'OCTOGEE_ALLOWED_WS_ORIGINS';

let prev: string | undefined;
beforeEach(() => { prev = process.env[ENV_KEY]; });
afterEach(() => {
  if (prev === undefined) delete process.env[ENV_KEY];
  else process.env[ENV_KEY] = prev;
});

describe('isAllowedWsOrigin — env unset (local dev fallback)', () => {
  beforeEach(() => { delete process.env[ENV_KEY]; });

  it('rejects when origin is undefined', () => {
    expect(isAllowedWsOrigin(undefined)).toBe(false);
  });

  it('rejects when origin is empty string', () => {
    expect(isAllowedWsOrigin('')).toBe(false);
  });

  it('allows http://localhost', () => {
    expect(isAllowedWsOrigin('http://localhost')).toBe(true);
  });

  it('allows http://localhost:4322 (app dev port)', () => {
    expect(isAllowedWsOrigin('http://localhost:4322')).toBe(true);
  });

  it('allows http://localhost:5173 (Vite default)', () => {
    expect(isAllowedWsOrigin('http://localhost:5173')).toBe(true);
  });

  it('rejects http://evil.com', () => {
    expect(isAllowedWsOrigin('http://evil.com')).toBe(false);
  });

  it('rejects https://localhost.evil.com (subdomain spoof)', () => {
    expect(isAllowedWsOrigin('https://localhost.evil.com')).toBe(false);
  });
});

describe('isAllowedWsOrigin — env set', () => {
  it('allows exact match in the configured list', () => {
    process.env[ENV_KEY] = 'https://app.octogee.com';
    expect(isAllowedWsOrigin('https://app.octogee.com')).toBe(true);
  });

  it('allows any of multiple configured origins', () => {
    process.env[ENV_KEY] = 'https://app.octogee.com,https://app-octogee-test.web.app';
    expect(isAllowedWsOrigin('https://app.octogee.com')).toBe(true);
    expect(isAllowedWsOrigin('https://app-octogee-test.web.app')).toBe(true);
  });

  it('rejects origins not in the configured list', () => {
    process.env[ENV_KEY] = 'https://app.octogee.com';
    expect(isAllowedWsOrigin('https://app-octogee-test.web.app')).toBe(false);
    expect(isAllowedWsOrigin('http://localhost:4322')).toBe(false);
  });

  it('handles whitespace in the comma-separated list', () => {
    process.env[ENV_KEY] = ' https://app.octogee.com , https://app-octogee-test.web.app ';
    expect(isAllowedWsOrigin('https://app.octogee.com')).toBe(true);
    expect(isAllowedWsOrigin('https://app-octogee-test.web.app')).toBe(true);
  });

  it('does NOT fall back to localhost when env is set but localhost is not in list', () => {
    process.env[ENV_KEY] = 'https://app.octogee.com';
    expect(isAllowedWsOrigin('http://localhost:4322')).toBe(false);
  });

  it('rejects undefined even when env is set', () => {
    process.env[ENV_KEY] = 'https://app.octogee.com';
    expect(isAllowedWsOrigin(undefined)).toBe(false);
  });
});

describe('warnIfWsOriginsMisconfigured', () => {
  let prevNs: string | undefined;
  beforeEach(() => {
    prevNs = process.env.K8S_NAMESPACE;
    delete process.env[ENV_KEY];
    _resetWsOriginWarningForTests();
  });
  afterEach(() => {
    if (prevNs === undefined) delete process.env.K8S_NAMESPACE;
    else process.env.K8S_NAMESPACE = prevNs;
  });

  it('shouts loudly when running in cluster (K8S_NAMESPACE set) without origins configured', () => {
    process.env.K8S_NAMESPACE = 'octogee-test';
    const log = vi.fn();
    warnIfWsOriginsMisconfigured(log);
    expect(log).toHaveBeenCalledOnce();
    expect(log.mock.calls[0][0]).toMatch(/WARNING/);
    expect(log.mock.calls[0][0]).toMatch(/octogee-test/);
  });

  it('logs the dev-mode message when running locally without K8S_NAMESPACE', () => {
    delete process.env.K8S_NAMESPACE;
    const log = vi.fn();
    warnIfWsOriginsMisconfigured(log);
    expect(log).toHaveBeenCalledOnce();
    expect(log.mock.calls[0][0]).toMatch(/dev mode/);
    expect(log.mock.calls[0][0]).not.toMatch(/WARNING/);
  });

  it('says nothing when origins are configured', () => {
    process.env[ENV_KEY] = 'https://app.octogee.com';
    const log = vi.fn();
    warnIfWsOriginsMisconfigured(log);
    expect(log).not.toHaveBeenCalled();
  });

  it('only fires once even on repeated calls', () => {
    delete process.env.K8S_NAMESPACE;
    const log = vi.fn();
    warnIfWsOriginsMisconfigured(log);
    warnIfWsOriginsMisconfigured(log);
    warnIfWsOriginsMisconfigured(log);
    expect(log).toHaveBeenCalledOnce();
  });
});
