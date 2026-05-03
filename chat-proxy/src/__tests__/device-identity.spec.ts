import { describe, it, expect } from 'vitest';
import {
  generateIdentity,
  buildDeviceAuthPayloadV3,
  signConnectDevice,
  publicKeyRawBase64UrlFromPem,
} from '../openclaw/device-identity';
import * as crypto from 'node:crypto';

describe('generateIdentity', () => {
  it('returns a stable-shape identity with Ed25519 PEM keys + deviceId', () => {
    const id = generateIdentity();
    expect(id.deviceId).toMatch(/^[0-9a-f]{64}$/);
    expect(id.publicKeyPem).toMatch(/^-----BEGIN PUBLIC KEY-----/);
    expect(id.privateKeyPem).toMatch(/^-----BEGIN PRIVATE KEY-----/);
  });

  it('generates distinct identities across calls (deviceId is derived from the key)', () => {
    const a = generateIdentity();
    const b = generateIdentity();
    expect(a.deviceId).not.toBe(b.deviceId);
  });
});

describe('buildDeviceAuthPayloadV3', () => {
  it('concatenates the canonical 11-field payload with | separators', () => {
    const payload = buildDeviceAuthPayloadV3({
      deviceId: 'dev',
      clientId: 'gateway-client',
      clientMode: 'backend',
      role: 'operator',
      scopes: ['operator.admin'],
      signedAtMs: 1234,
      token: 'tok',
      nonce: 'n1',
      platform: 'linux',
      deviceFamily: null,
    });
    expect(payload).toBe(
      'v3|dev|gateway-client|backend|operator|operator.admin|1234|tok|n1|linux|',
    );
  });

  it('normalizes platform/deviceFamily to trimmed lowercase (matches server)', () => {
    const p = buildDeviceAuthPayloadV3({
      deviceId: 'd',
      clientId: 'gateway-client',
      clientMode: 'backend',
      role: 'operator',
      scopes: [],
      signedAtMs: 0,
      nonce: 'n',
      platform: '  Linux  ',
      deviceFamily: '  Pod  ',
    });
    expect(p.endsWith('|linux|pod')).toBe(true);
  });

  it('treats null/undefined metadata as empty segments', () => {
    const p = buildDeviceAuthPayloadV3({
      deviceId: 'd',
      clientId: 'c',
      clientMode: 'm',
      role: 'r',
      scopes: [],
      signedAtMs: 0,
      nonce: 'n',
    });
    expect(p).toContain('||n||');
  });
});

describe('signConnectDevice', () => {
  it('produces a verifiable Ed25519 signature over the v3 payload', () => {
    const identity = generateIdentity();
    const signed = signConnectDevice({
      identity,
      clientId: 'gateway-client',
      clientMode: 'backend',
      role: 'operator',
      scopes: ['operator.admin'],
      nonce: 'nonce-abc',
      token: 'tok',
      platform: 'linux',
      signedAtMs: 1000,
    });

    const payload = buildDeviceAuthPayloadV3({
      deviceId: identity.deviceId,
      clientId: 'gateway-client',
      clientMode: 'backend',
      role: 'operator',
      scopes: ['operator.admin'],
      signedAtMs: 1000,
      token: 'tok',
      nonce: 'nonce-abc',
      platform: 'linux',
      deviceFamily: null,
    });

    const sig = Buffer.from(
      signed.signature.replaceAll('-', '+').replaceAll('_', '/') +
        '==='.slice((signed.signature.length + 3) % 4),
      'base64',
    );
    const key = crypto.createPublicKey(identity.publicKeyPem);
    const ok = crypto.verify(null, Buffer.from(payload, 'utf8'), key, sig);
    expect(ok).toBe(true);
  });

  it('includes the provided nonce + deviceId in the returned frame', () => {
    const identity = generateIdentity();
    const signed = signConnectDevice({
      identity,
      clientId: 'c',
      clientMode: 'm',
      role: 'operator',
      scopes: [],
      nonce: 'the-nonce',
    });
    expect(signed.id).toBe(identity.deviceId);
    expect(signed.nonce).toBe('the-nonce');
    expect(signed.publicKey).toBe(publicKeyRawBase64UrlFromPem(identity.publicKeyPem));
  });
});
