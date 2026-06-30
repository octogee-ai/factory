import { describe, it, expect, vi } from 'vitest';
import {
  isPublicIp,
  assertPublicHttpUrl,
  parseLinkMetadata,
  unfurl,
  UnsafeUrlError,
} from './link-unfurl.js';

describe('isPublicIp — SSRF address guard', () => {
  it('rejects loopback, private, link-local, CGNAT, and cloud-metadata IPs', () => {
    for (const ip of [
      '127.0.0.1',
      '0.0.0.0',
      '10.1.2.3',
      '172.16.5.4',
      '172.31.255.255',
      '192.168.1.1',
      '169.254.169.254', // AWS/GCP metadata
      '100.64.0.1', // CGNAT
      '::1',
      'fe80::1',
      'fd00::1',
      '::ffff:127.0.0.1', // IPv4-mapped loopback
    ]) {
      expect(isPublicIp(ip), ip).toBe(false);
    }
  });

  it('accepts public IPs', () => {
    for (const ip of ['1.1.1.1', '8.8.8.8', '93.184.216.34', '2606:2800:220:1::']) {
      expect(isPublicIp(ip), ip).toBe(true);
    }
  });

  it('catches IPv6-embedded-v4 bypasses (hex IPv4-mapped, NAT64, 6to4, doc)', () => {
    for (const ip of [
      '::ffff:7f00:1', // hex IPv4-mapped 127.0.0.1
      '::ffff:0a00:0001', // hex IPv4-mapped 10.0.0.1
      '64:ff9b::a00:1', // NAT64 of 10.0.0.1
      '64:ff9b::7f00:1', // NAT64 of 127.0.0.1
      '2002:a00:1::', // 6to4 of 10.0.0.1
      '2001:db8::1', // documentation range
    ]) {
      expect(isPublicIp(ip), ip).toBe(false);
    }
    // ...but a public address carried by those mechanisms stays public.
    expect(isPublicIp('::ffff:808:808')).toBe(true); // 8.8.8.8
    expect(isPublicIp('2002:101:101::')).toBe(true); // 6to4 of 1.1.1.1
  });

  it('rejects non-global-unicast IPv6 (multicast, benchmarking, ORCHID, discard, unspecified)', () => {
    for (const ip of [
      'ff02::1', // link-local multicast
      'ff05::1:3', // site-local multicast
      '2001:2::1', // benchmarking 2001:2::/48
      '2001:10::1', // ORCHID 2001:10::/28
      '2001:20::1', // ORCHIDv2 2001:20::/28
      '2001::1', // Teredo 2001::/32 (within 2001::/23)
      '100::1', // discard-only 100::/64
      '::', // unspecified
    ]) {
      expect(isPublicIp(ip), ip).toBe(false);
    }
  });

  it('accepts global-unicast IPv6 (2000::/3, outside the special sub-blocks)', () => {
    for (const ip of ['2606:4700:4700::1111', '2620:fe::fe', '2a00:1450:4001::1']) {
      expect(isPublicIp(ip), ip).toBe(true);
    }
  });
});

describe('assertPublicHttpUrl', () => {
  const publicResolver = async () => ['93.184.216.34'];

  it('rejects non-http(s) schemes', async () => {
    for (const url of ['file:///etc/passwd', 'ftp://x', 'gopher://x', 'data:text/html,x']) {
      await expect(assertPublicHttpUrl(url, publicResolver)).rejects.toBeInstanceOf(UnsafeUrlError);
    }
  });

  it('rejects embedded credentials', async () => {
    await expect(assertPublicHttpUrl('https://user:pw@example.com', publicResolver)).rejects.toThrow(
      /credentials/,
    );
  });

  it('rejects literal private-IP hosts without DNS', async () => {
    await expect(assertPublicHttpUrl('http://169.254.169.254/latest/meta-data')).rejects.toThrow(
      /private ip/,
    );
    await expect(assertPublicHttpUrl('http://127.0.0.1:8080')).rejects.toThrow(/private ip/);
  });

  it('rejects localhost and internal TLDs', async () => {
    await expect(assertPublicHttpUrl('http://localhost/x', publicResolver)).rejects.toThrow(/blocked/);
    await expect(assertPublicHttpUrl('http://foo.internal/x', publicResolver)).rejects.toThrow(/blocked/);
  });

  it('rejects a public-looking host that DNS-resolves to a private IP (rebinding)', async () => {
    const evil = async () => ['10.0.0.5'];
    await expect(assertPublicHttpUrl('https://evil.example.com', evil)).rejects.toThrow(/private/);
  });

  it('accepts a public https URL and returns the validated pin address', async () => {
    const { url, address } = await assertPublicHttpUrl('https://example.com/page', publicResolver);
    expect(url.hostname).toBe('example.com');
    expect(address).toBe('93.184.216.34');
  });
});

describe('parseLinkMetadata', () => {
  it('prefers og:title, falls back to <title>, and absolutizes favicon/image', () => {
    const html = `<html><head>
      <title>Doc Title</title>
      <meta property="og:title" content="OG &amp; Title" />
      <meta property="og:image" content="/img/card.png" />
      <link rel="icon" href="/static/fav.ico" />
    </head></html>`;
    const meta = parseLinkMetadata(html, 'https://example.com/a/b');
    expect(meta.title).toBe('OG & Title');
    expect(meta.image).toBe('https://example.com/img/card.png');
    expect(meta.favicon).toBe('https://example.com/static/fav.ico');
  });

  it('defaults favicon to /favicon.ico and title to <title> when no og', () => {
    const meta = parseLinkMetadata('<head><title>Just Title</title></head>', 'https://x.com/deep/path');
    expect(meta.title).toBe('Just Title');
    expect(meta.favicon).toBe('https://x.com/favicon.ico');
  });
});

describe('unfurl', () => {
  const resolver = async () => ['93.184.216.34'];

  it('fetches, parses, and returns a preview', async () => {
    const fetchImpl = vi.fn(async () =>
      new Response('<head><meta property="og:title" content="Hello"><title>x</title></head>', {
        status: 200,
        headers: { 'content-type': 'text/html' },
      }),
    ) as unknown as typeof fetch;
    const preview = await unfurl('https://example.com', { resolver, fetchImpl });
    expect(preview).toMatchObject({ domain: 'example.com', title: 'Hello' });
  });

  it('re-validates redirect targets through the SSRF guard', async () => {
    // First hop redirects to an internal IP — must be rejected, not followed.
    const fetchImpl = vi.fn(async () =>
      new Response(null, { status: 302, headers: { location: 'http://169.254.169.254/' } }),
    ) as unknown as typeof fetch;
    await expect(unfurl('https://example.com', { resolver, fetchImpl })).rejects.toThrow(/private ip/);
  });

  it('returns null on non-OK responses', async () => {
    const fetchImpl = vi.fn(async () => new Response('nope', { status: 500 })) as unknown as typeof fetch;
    expect(await unfurl('https://example.com', { resolver, fetchImpl })).toBeNull();
  });

  it('returns null (not a throw) when the fetch rejects with a network error', async () => {
    const fetchImpl = (async () => {
      throw new Error('ECONNREFUSED');
    }) as unknown as typeof fetch;
    expect(await unfurl('https://example.com', { resolver, fetchImpl })).toBeNull();
  });

  it('returns null when the body stalls past the timeout (timer covers body read)', async () => {
    vi.useFakeTimers();
    try {
      const fetchImpl = (async (_url: string, init: RequestInit) => {
        const signal = (init as { signal?: AbortSignal }).signal;
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            // Never enqueue — only resolve when the abort timer fires, proving the
            // timeout is still active during the body read (the P1 fix).
            signal?.addEventListener('abort', () => controller.error(new Error('aborted')));
          },
        });
        return new Response(body, { status: 200, headers: { 'content-type': 'text/html' } });
      }) as unknown as typeof fetch;
      const pending = unfurl('https://example.com', { resolver, fetchImpl });
      await vi.advanceTimersByTimeAsync(5000);
      expect(await pending).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});
