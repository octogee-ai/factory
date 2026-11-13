import { isIPv4, isIPv6, type LookupFunction } from "node:net";
import { lookup as dnsLookup } from "node:dns/promises";

export type AddressLookup = (host: string) => Promise<Array<{ address: string; family: number }>>;

export interface VettedAddress {
  address: string;
  family: 4 | 6;
}

export type EgressTarget =
  | { allowed: true; addresses: VettedAddress[] }
  | { allowed: false; reason: string };

const FORBIDDEN_HOST_SUFFIXES = [".localhost", ".local", ".internal", ".home.arpa", ".lan"];
const FORBIDDEN_HOSTS = new Set(["localhost", "localhost.", "metadata", "metadata.google.internal"]);

function ipv4Octets(address: string): number[] | null {
  if (!isIPv4(address)) return null;
  return address.split(".").map(Number);
}

function inV4Block(octets: number[], prefix: number[], bits: number): boolean {
  const value = ((octets[0]! << 24) | (octets[1]! << 16) | (octets[2]! << 8) | octets[3]!) >>> 0;
  const base = ((prefix[0]! << 24) | (prefix[1]! << 16) | (prefix[2]! << 8) | prefix[3]!) >>> 0;
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return (value & mask) === (base & mask);
}

const FORBIDDEN_V4_BLOCKS: Array<[number[], number, string]> = [
  [[0, 0, 0, 0], 8, "this network"],
  [[10, 0, 0, 0], 8, "private"],
  [[100, 64, 0, 0], 10, "carrier-grade NAT"],
  [[127, 0, 0, 0], 8, "loopback"],
  [[169, 254, 0, 0], 16, "link-local"],
  [[172, 16, 0, 0], 12, "private"],
  [[192, 0, 0, 0], 24, "IETF protocol assignments"],
  [[192, 168, 0, 0], 16, "private"],
  [[198, 18, 0, 0], 15, "benchmarking"],
  [[224, 0, 0, 0], 4, "multicast"],
  [[240, 0, 0, 0], 4, "reserved"],
];

export function forbiddenIpv4Reason(address: string): string | null {
  const octets = ipv4Octets(address);
  if (!octets) return null;
  for (const [prefix, bits, reason] of FORBIDDEN_V4_BLOCKS) if (inV4Block(octets, prefix, bits)) return reason;
  return null;
}

export function expandIpv6(address: string): number[] | null {
  if (!isIPv6(address)) return null;
  let text = address;
  const zone = text.indexOf("%");
  if (zone !== -1) text = text.slice(0, zone);
  let embeddedV4: number[] = [];
  const lastColon = text.lastIndexOf(":");
  const tail = text.slice(lastColon + 1);
  if (tail.includes(".")) {
    const octets = ipv4Octets(tail);
    if (!octets) return null;
    embeddedV4 = [(octets[0]! << 8) | octets[1]!, (octets[2]! << 8) | octets[3]!];
    const prefix = text.slice(0, lastColon + 1);
    text = prefix.endsWith("::") ? prefix : prefix.slice(0, -1);
  }
  const [head, rest] = text.split("::");
  const headGroups = head ? head.split(":").filter(Boolean).map((group) => parseInt(group, 16)) : [];
  const restGroups = rest ? rest.split(":").filter(Boolean).map((group) => parseInt(group, 16)) : [];
  const explicit = [...headGroups, ...restGroups, ...embeddedV4];
  if (text.includes("::")) {
    const missing = 8 - explicit.length;
    if (missing < 1) return null;
    return [...headGroups, ...new Array<number>(missing).fill(0), ...restGroups, ...embeddedV4];
  }
  return explicit.length === 8 ? explicit : null;
}

type Groups = readonly number[];
const embeddedIpv4 = (high: number, low: number) => `${high >> 8}.${high & 0xff}.${low >> 8}.${low & 0xff}`;
const hasPrefix = (groups: Groups, prefix: Groups) => prefix.every((group, index) => groups[index] === group);
const allZero = (groups: Groups) => groups.every((group) => group === 0);
const V4_MAPPED_PREFIX = [0, 0, 0, 0, 0, 0xffff];
const NAT64_PREFIX = [0x64, 0xff9b, 0, 0, 0, 0];
const SIX_TO_FOUR_PREFIX = 0x2002;
const FORBIDDEN_V6_RULES: Array<[(groups: Groups) => boolean, string]> = [
  [allZero, "unspecified"],
  [(groups) => hasPrefix(groups, [0x64, 0xff9b, 1]), "local-use NAT64"],
  [(groups) => hasPrefix(groups, [0, 0, 0, 0, 0, 0, 0]) && groups[7] === 1, "loopback"],
  [(groups) => hasPrefix(groups, [0, 0, 0, 0, 0, 0]), "IPv4-compatible"],
  [(groups) => (groups[0]! & 0xfe00) === 0xfc00, "unique local"],
  [(groups) => (groups[0]! & 0xffc0) === 0xfe80, "link-local"],
  [(groups) => (groups[0]! & 0xffc0) === 0xfec0, "site-local"],
  [(groups) => (groups[0]! & 0xff00) === 0xff00, "multicast"],
  [(groups) => groups[0] === 0x2001 && groups[1] === 0x0db8, "documentation"],
];

export function forbiddenIpv6Reason(address: string): string | null {
  const groups = expandIpv6(address);
  if (!groups) return isIPv6(address) ? "unparseable IPv6" : null;
  for (const prefix of [V4_MAPPED_PREFIX, NAT64_PREFIX]) {
    if (hasPrefix(groups, prefix) && !allZero(groups)) return forbiddenIpv4Reason(embeddedIpv4(groups[6]!, groups[7]!));
  }
  if (groups[0] === SIX_TO_FOUR_PREFIX) return forbiddenIpv4Reason(embeddedIpv4(groups[1]!, groups[2]!));
  for (const [matches, reason] of FORBIDDEN_V6_RULES) {
    if (matches(groups)) return reason;
  }
  return null;
}

export function forbiddenAddressReason(address: string): string | null {
  return forbiddenIpv4Reason(address) ?? forbiddenIpv6Reason(address);
}

export function forbiddenHostnameReason(host: string): string | null {
  const name = host.toLowerCase().replace(/\.$/u, "");
  if (FORBIDDEN_HOSTS.has(name)) return "local name";
  if (FORBIDDEN_HOST_SUFFIXES.some((suffix) => name.endsWith(suffix))) return "local name";
  return null;
}

export const systemLookup: AddressLookup = (host) => dnsLookup(host, { all: true, verbatim: true });

export interface Nat64Prefix {
  bytes: number[];
  length: 32 | 40 | 48 | 56 | 64 | 96;
}

const NAT64_LAYOUTS: ReadonlyArray<{ length: Nat64Prefix["length"]; ipv4Bytes: readonly number[] }> = [
  { length: 96, ipv4Bytes: [12, 13, 14, 15] },
  { length: 64, ipv4Bytes: [9, 10, 11, 12] },
  { length: 56, ipv4Bytes: [7, 9, 10, 11] },
  { length: 48, ipv4Bytes: [6, 7, 9, 10] },
  { length: 40, ipv4Bytes: [5, 6, 7, 9] },
  { length: 32, ipv4Bytes: [4, 5, 6, 7] },
];
const NAT64_DISCOVERY_NAME = "ipv4only.arpa";
// eslint-disable-next-line sonarjs/no-hardcoded-ip -- RFC 7050 fixes these as the IPv4-only addresses DNS64 embeds in ipv4only.arpa answers
const NAT64_WELL_KNOWN_IPV4 = new Set(["192.0.0.170", "192.0.0.171"]);
const NAT64_U_OCTET = 8;

function ipv6Bytes(address: string): number[] | null {
  const groups = expandIpv6(address);
  return groups ? groups.flatMap((group) => [group >> 8, group & 0xff]) : null;
}

function embeddedNat64Ipv4(bytes: readonly number[], layout: (typeof NAT64_LAYOUTS)[number]): string {
  return layout.ipv4Bytes.map((index) => bytes[index]).join(".");
}

export function nat64PrefixesFrom(addresses: readonly string[]): Nat64Prefix[] {
  const prefixes: Nat64Prefix[] = [];
  for (const address of addresses) {
    const bytes = isIPv6(address) ? ipv6Bytes(address) : null;
    if (!bytes) continue;
    const layout = NAT64_LAYOUTS.find((candidate) => (candidate.length === 96 || bytes[NAT64_U_OCTET] === 0) && NAT64_WELL_KNOWN_IPV4.has(embeddedNat64Ipv4(bytes, candidate)));
    if (!layout) continue;
    const prefix: Nat64Prefix = { bytes: bytes.slice(0, layout.length / 8), length: layout.length };
    if (!prefixes.some((known) => known.length === prefix.length && known.bytes.join() === prefix.bytes.join())) prefixes.push(prefix);
  }
  return prefixes;
}

function nat64TranslatedReason(address: string, prefixes: readonly Nat64Prefix[]): string | null {
  const bytes = prefixes.length > 0 && isIPv6(address) ? ipv6Bytes(address) : null;
  if (!bytes) return null;
  for (const prefix of prefixes) {
    if (!prefix.bytes.every((byte, index) => bytes[index] === byte)) continue;
    const layout = NAT64_LAYOUTS.find((candidate) => candidate.length === prefix.length)!;
    const reason = forbiddenIpv4Reason(embeddedNat64Ipv4(bytes, layout));
    if (reason) return `NAT64-translated ${reason}`;
  }
  return null;
}

export type Nat64Knowledge = readonly Nat64Prefix[] | null;

export function createNat64Discovery(lookup: AddressLookup, options: { now?: () => number; refreshMs?: number; failureRetryMs?: number } = {}): () => Promise<Nat64Knowledge> {
  const now = options.now ?? Date.now;
  const refreshMs = options.refreshMs ?? 10 * 60_000;
  const failureRetryMs = options.failureRetryMs ?? 30_000;
  let cached: { at: number; failed: boolean; prefixes: Promise<Nat64Knowledge> } | null = null;
  return () => {
    const at = now();
    if (!cached || at - cached.at > (cached.failed ? failureRetryMs : refreshMs)) {
      const entry: { at: number; failed: boolean; prefixes: Promise<Nat64Knowledge> } = { at, failed: false, prefixes: Promise.resolve(null) };
      entry.prefixes = lookup(NAT64_DISCOVERY_NAME).then(
        (answers) => nat64PrefixesFrom(answers.filter((answer) => answer.family === 6).map((answer) => answer.address)),
        () => { entry.failed = true; return null; },
      );
      cached = entry;
    }
    return cached.prefixes;
  };
}

const NAT64_UNKNOWN = "while NAT64 discovery is unavailable";

function addressReason(address: string, nat64: Nat64Knowledge): string | null {
  return forbiddenAddressReason(address) ?? nat64TranslatedReason(address, nat64 ?? []);
}

function literalTarget(literal: string, nat64: Nat64Knowledge): EgressTarget {
  const reason = addressReason(literal, nat64);
  if (reason) return { allowed: false, reason: `${reason} address` };
  if (nat64 === null && isIPv6(literal)) return { allowed: false, reason: `IPv6 address ${NAT64_UNKNOWN}` };
  return { allowed: true, addresses: [{ address: literal, family: isIPv4(literal) ? 4 : 6 }] };
}

function resolvedTarget(answers: Array<{ address: string; family: number }>, nat64: Nat64Knowledge): EgressTarget {
  if (answers.length === 0) return { allowed: false, reason: "unresolvable: no addresses" };
  for (const answer of answers) {
    const reason = addressReason(answer.address, nat64);
    if (reason || !(answer.family === 4 || answer.family === 6)) return { allowed: false, reason: `resolves to a ${reason ?? "unknown"} address` };
  }
  const usable = nat64 === null ? answers.filter((answer) => answer.family === 4) : answers;
  if (usable.length === 0) return { allowed: false, reason: `resolves only to IPv6 ${NAT64_UNKNOWN}` };
  return { allowed: true, addresses: usable.map((answer) => ({ address: answer.address, family: answer.family as 4 | 6 })) };
}

export function vettedLookup(addresses: VettedAddress[]): LookupFunction {
  return (_hostname, options, callback) => {
    const family = options.family === 4 || options.family === 6 ? options.family : null;
    const matching = family ? addresses.filter((entry) => entry.family === family) : addresses;
    const first = matching[0];
    if (!first) {
      callback(Object.assign(new Error(`no vetted IPv${family} address`), { code: "ENOTFOUND" }), "", 0);
      return;
    }
    if (options.all) callback(null, matching);
    else callback(null, first.address, first.family);
  };
}

export async function resolveEgressTarget(host: string, lookup: AddressLookup = systemLookup, nat64: Nat64Knowledge = []): Promise<EgressTarget> {
  const literal = host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
  if (isIPv4(literal) || isIPv6(literal)) return literalTarget(literal, nat64);
  const nameReason = forbiddenHostnameReason(host);
  if (nameReason) return { allowed: false, reason: nameReason };
  try {
    return resolvedTarget(await lookup(host), nat64);
  } catch (error) {
    return { allowed: false, reason: `unresolvable: ${(error as { code?: string }).code ?? "lookup failed"}` };
  }
}
