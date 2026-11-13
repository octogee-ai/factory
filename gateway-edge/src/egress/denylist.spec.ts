import { describe, expect, it, vi } from "vitest";
import { createNat64Discovery, expandIpv6, forbiddenAddressReason, forbiddenHostnameReason, nat64PrefixesFrom, resolveEgressTarget } from "./denylist.js";

describe("egress destination denylist", () => {
  it.each([
    ["127.0.0.1", "loopback"],
    ["127.255.255.254", "loopback"],
    ["10.0.0.5", "private"],
    ["172.16.0.1", "private"],
    ["172.31.255.255", "private"],
    ["192.168.1.1", "private"],
    ["169.254.169.254", "link-local"],
    ["169.254.0.1", "link-local"],
    ["100.64.0.1", "carrier-grade NAT"],
    ["100.127.255.255", "carrier-grade NAT"],
    ["0.0.0.0", "this network"],
    ["224.0.0.1", "multicast"],
    ["255.255.255.255", "reserved"],
    ["::1", "loopback"],
    ["::", "unspecified"],
    ["fc00::1", "unique local"],
    ["fd12:3456::1", "unique local"],
    ["fe80::1", "link-local"],
    ["fe80::1%en0", "link-local"],
    ["fec0::1", "site-local"],
    ["ff02::1", "multicast"],
    ["::ffff:127.0.0.1", "loopback"],
    ["::ffff:169.254.169.254", "link-local"],
    ["::ffff:10.1.2.3", "private"],
    ["64:ff9b::a00:1", "private"],
    ["64:ff9b::7f00:1", "loopback"],
    ["64:ff9b::192.168.1.1", "private"],
    ["64:ff9b::127.0.0.1", "loopback"],
    ["64:ff9b::169.254.169.254", "link-local"],
    ["::127.0.0.1", "IPv4-compatible"],
    ["::8.8.8.8", "IPv4-compatible"],
    ["64:ff9b:1::808:808", "local-use NAT64"],
    ["64:ff9b:1:c0a8:1::", "local-use NAT64"],
    ["64:ff9b:1:ffff:ffff:ffff:ffff:ffff", "local-use NAT64"],
    ["2002:c0a8:101::1", "private"],
    ["2002:7f00:1::1", "loopback"],
    ["2002:a9fe:a9fe::1", "link-local"],
  ])("refuses %s as %s", (address, reason) => {
    expect(forbiddenAddressReason(address)).toBe(reason);
  });

  it.each(["8.8.8.8", "1.1.1.1", "93.184.216.34", "172.32.0.1", "100.128.0.1", "2606:4700:4700::1111", "2a00:1450:4001:80b::200e", "::ffff:8.8.8.8", "64:ff9b::808:808", "64:ff9b::8.8.8.8", "2002:808:808::1"])("allows public %s", (address) => {
    expect(forbiddenAddressReason(address)).toBeNull();
  });

  it("expands IPv6 forms it must classify, and rejects the ones it cannot", () => {
    expect(expandIpv6("::ffff:1.2.3.4")).toEqual([0, 0, 0, 0, 0, 0xffff, 0x0102, 0x0304]);
    expect(expandIpv6("2001:db8::1")).toEqual([0x2001, 0xdb8, 0, 0, 0, 0, 0, 1]);
    expect(expandIpv6("fe80::1%lo0")).toEqual([0xfe80, 0, 0, 0, 0, 0, 0, 1]);
    expect(expandIpv6("64:ff9b::192.168.1.1")).toEqual([0x64, 0xff9b, 0, 0, 0, 0, 0xc0a8, 0x0101]);
    expect(expandIpv6("::1.2.3.4")).toEqual([0, 0, 0, 0, 0, 0, 0x0102, 0x0304]);
    expect(expandIpv6("1:2:3:4:5:6:1.2.3.4")).toEqual([1, 2, 3, 4, 5, 6, 0x0102, 0x0304]);
    expect(expandIpv6("not-an-address")).toBeNull();
  });

  it("refuses local-only hostnames before resolving them", async () => {
    for (const host of ["localhost", "LOCALHOST.", "printer.local", "db.internal", "metadata.google.internal", "metadata", "router.lan", "nas.home.arpa", "foo.localhost"]) {
      expect(forbiddenHostnameReason(host), host).toBe("local name");
    }
    const lookup = vi.fn();
    expect(await resolveEgressTarget("metadata.google.internal", lookup)).toEqual({ allowed: false, reason: "local name" });
    expect(lookup).not.toHaveBeenCalled();
  });

  it("resolves first, keeps every vetted answer, and refuses any name whose answers include a forbidden address", async () => {
    const lookup = vi.fn(async (host: string) => {
      if (host === "ifconfig.me") return [{ address: "34.160.111.145", family: 4 }, { address: "2600:1901:0:b2c0::", family: 6 }];
      if (host === "rebinder.example") return [{ address: "34.160.111.145", family: 4 }, { address: "10.0.0.8", family: 4 }];
      if (host === "metadata-alias.example") return [{ address: "169.254.169.254", family: 4 }];
      if (host === "empty.example") return [];
      throw Object.assign(new Error("not found"), { code: "ENOTFOUND" });
    });
    expect(await resolveEgressTarget("ifconfig.me", lookup)).toEqual({ allowed: true, addresses: [{ address: "34.160.111.145", family: 4 }, { address: "2600:1901:0:b2c0::", family: 6 }] });
    expect(await resolveEgressTarget("rebinder.example", lookup)).toEqual({ allowed: false, reason: "resolves to a private address" });
    expect(await resolveEgressTarget("metadata-alias.example", lookup)).toEqual({ allowed: false, reason: "resolves to a link-local address" });
    expect(await resolveEgressTarget("empty.example", lookup)).toEqual({ allowed: false, reason: "unresolvable: no addresses" });
    expect(await resolveEgressTarget("missing.example", lookup)).toEqual({ allowed: false, reason: "unresolvable: ENOTFOUND" });
  });

  it("checks literal addresses without touching the resolver", async () => {
    const lookup = vi.fn();
    expect(await resolveEgressTarget("169.254.169.254", lookup)).toEqual({ allowed: false, reason: "link-local address" });
    expect(await resolveEgressTarget("[::1]", lookup)).toEqual({ allowed: false, reason: "loopback address" });
    expect(await resolveEgressTarget("1.1.1.1", lookup)).toEqual({ allowed: true, addresses: [{ address: "1.1.1.1", family: 4 }] });
    expect(await resolveEgressTarget("2606:4700:4700::1111", lookup)).toEqual({ allowed: true, addresses: [{ address: "2606:4700:4700::1111", family: 6 }] });
    expect(lookup).not.toHaveBeenCalled();
  });

  it("learns a network-specific NAT64 prefix of any RFC 6052 length from the ipv4only.arpa answers", () => {
    expect(nat64PrefixesFrom(["2600:1f00:64::c000:aa"])).toEqual([{ bytes: [0x26, 0x00, 0x1f, 0x00, 0, 0x64, 0, 0, 0, 0, 0, 0], length: 96 }]);
    expect(nat64PrefixesFrom(["2600:1f00:c000:aa::"])).toEqual([{ bytes: [0x26, 0x00, 0x1f, 0x00], length: 32 }]);
    expect(nat64PrefixesFrom(["2600:1f00:64:c000:0:aa00::"])).toEqual([{ bytes: [0x26, 0x00, 0x1f, 0x00, 0, 0x64], length: 48 }]);
    expect(nat64PrefixesFrom(["2600:1f00:64::1", "192.0.0.170"])).toEqual([]);
  });

  it("refuses a destination that a discovered NAT64 prefix would translate to a private or loopback address", async () => {
    const prefixes = nat64PrefixesFrom(["2600:1f00:64::c000:aa"]);
    const lookup = vi.fn(async (host: string) => host === "lan.example"
      ? [{ address: "2600:1f00:64::c0a8:101", family: 6 }]
      : [{ address: "2600:1f00:64::808:808", family: 6 }]);
    expect(await resolveEgressTarget("lan.example", lookup, prefixes)).toEqual({ allowed: false, reason: "resolves to a NAT64-translated private address" });
    expect(await resolveEgressTarget("[2600:1f00:64::7f00:1]", lookup, prefixes)).toEqual({ allowed: false, reason: "NAT64-translated loopback address" });
    expect(await resolveEgressTarget("2600:1f00:64::192.168.1.1", lookup, prefixes)).toEqual({ allowed: false, reason: "NAT64-translated private address" });
    expect(await resolveEgressTarget("public.example", lookup, prefixes)).toEqual({ allowed: true, addresses: [{ address: "2600:1f00:64::808:808", family: 6 }] });
    expect(await resolveEgressTarget("lan.example", lookup)).toEqual({ allowed: true, addresses: [{ address: "2600:1f00:64::c0a8:101", family: 6 }] });
  });

  it("discovers NAT64 prefixes once per refresh window, reads a network without DNS64 as having none, and reports a failed lookup as unknown", async () => {
    let now = 0;
    const lookup = vi.fn(async () => [{ address: "192.0.0.170", family: 4 }, { address: "2600:1f00:64::c000:aa", family: 6 }]);
    const discover = createNat64Discovery(lookup, { now: () => now, refreshMs: 1_000, failureRetryMs: 100 });
    expect(await discover()).toHaveLength(1);
    expect(await discover()).toHaveLength(1);
    expect(lookup).toHaveBeenCalledTimes(1);
    expect(lookup).toHaveBeenCalledWith("ipv4only.arpa");
    now = 1_001;
    lookup.mockResolvedValueOnce([{ address: "192.0.0.170", family: 4 }]);
    expect(await discover()).toEqual([]);
    now = 2_002;
    lookup.mockRejectedValueOnce(Object.assign(new Error("resolver timed out"), { code: "ETIMEOUT" }));
    expect(await discover()).toBeNull();
    now = 2_050;
    expect(await discover()).toBeNull();
    expect(lookup).toHaveBeenCalledTimes(3);
    now = 2_103;
    expect(await discover()).toHaveLength(1);
    expect(lookup).toHaveBeenCalledTimes(4);
  });

  it("refuses IPv6 destinations while NAT64 discovery is unknown, keeping a name's IPv4 answers", async () => {
    const lookup = vi.fn(async (host: string) => host === "dual.example"
      ? [{ address: "2600:1f00:64::c0a8:101", family: 6 }, { address: "93.184.216.34", family: 4 }]
      : [{ address: "2600:1f00:64::808:808", family: 6 }]);
    expect(await resolveEgressTarget("dual.example", lookup, null)).toEqual({ allowed: true, addresses: [{ address: "93.184.216.34", family: 4 }] });
    expect(await resolveEgressTarget("v6only.example", lookup, null)).toEqual({ allowed: false, reason: "resolves only to IPv6 while NAT64 discovery is unavailable" });
    expect(await resolveEgressTarget("[2600:1f00:64::808:808]", lookup, null)).toEqual({ allowed: false, reason: "IPv6 address while NAT64 discovery is unavailable" });
    expect(await resolveEgressTarget("1.1.1.1", lookup, null)).toEqual({ allowed: true, addresses: [{ address: "1.1.1.1", family: 4 }] });
  });
});
