import { isIP } from 'node:net';
import { lookup as dnsLookup, type LookupAddress } from 'node:dns';

/**
 * SSRF guard for merchant-supplied callback URLs.
 *
 * Two layers:
 *
 * 1. Static checks (isCallbackUrlSafe) — literal private/loopback/
 *    link-local/reserved IPv4+IPv6 addresses (incl. IPv4-mapped IPv6 in
 *    both dotted and WHATWG-normalized hex form), well-known internal
 *    hostnames (localhost, *.local, *.internal, *.localhost, *.intranet),
 *    and non-http(s) schemes. Used at order-create time for an immediate,
 *    actionable merchant error.
 *
 * 2. Resolve-time checks (safeWebhookLookup) — a DNS lookup hook for the
 *    webhook fetcher's undici Agent that resolves the hostname and rejects
 *    the connection when ANY resolved A/AAAA record is private. This closes
 *    the public-hostname-resolving-to-10.x gap and DNS rebinding (TOCTOU
 *    between pre-validation and connect), because the check runs inside the
 *    connect path itself. Redirect chasing is separately disabled at the
 *    fetch call site (redirect: 'manual'), so a 3xx Location to a private
 *    target is never followed.
 *
 * Operators running a single-tenant deployment that legitimately needs to
 * call back to a private address (e.g. integration tests against
 * http://localhost:4000/webhook) can set ALLOW_PRIVATE_CALLBACKS=true to
 * skip both layers.
 */

const BLOCKED_HOSTNAMES = new Set([
  'localhost',
  'localhost.localdomain',
  'ip6-localhost',
  'ip6-loopback',
  'broadcasthost',
]);

const BLOCKED_HOSTNAME_SUFFIXES = ['.local', '.internal', '.localhost', '.intranet'];

function isPrivateIPv4(ip: string): boolean {
  const parts = ip.split('.').map((p) => Number(p));
  if (parts.length !== 4 || parts.some((n) => Number.isNaN(n) || n < 0 || n > 255)) {
    return true; // unparseable -> treat as unsafe
  }
  const [a, b] = parts as [number, number, number, number];
  if (a === 127) return true; // 127.0.0.0/8 loopback
  if (a === 10) return true; // 10.0.0.0/8
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
  if (a === 192 && b === 168) return true; // 192.168.0.0/16
  if (a === 169 && b === 254) return true; // 169.254.0.0/16 link-local
  if (a === 0) return true; // 0.0.0.0/8
  if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10 CGNAT
  if (a >= 224) return true; // 224.0.0.0+ multicast/reserved
  return false;
}

function isPrivateIPv6(ip: string): boolean {
  const lower = ip.toLowerCase();
  if (lower === '::1' || lower === '::') return true;
  // Loopback (::1) and unspecified (::)
  // Unique-local fc00::/7 → first byte is fc or fd
  if (/^f[cd][0-9a-f]{0,2}:/i.test(lower)) return true;
  // Link-local fe80::/10
  if (/^fe[89ab][0-9a-f]?:/i.test(lower)) return true;
  // Multicast ff00::/8
  if (lower.startsWith('ff')) return true;

  // IPv4-mapped IPv6 (::ffff:a.b.c.d) — both canonical forms must match.
  // WHATWG URL parser normalizes the dotted form into hex, e.g.
  //   ::ffff:127.0.0.1  →  ::ffff:7f00:1
  // so check both the literal dotted form and the hex form.
  const dottedMapped = lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (dottedMapped) return isPrivateIPv4(dottedMapped[1]!);

  const hexMapped = lower.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (hexMapped) {
    const high = parseInt(hexMapped[1]!, 16);
    const low = parseInt(hexMapped[2]!, 16);
    if (
      Number.isFinite(high) &&
      Number.isFinite(low) &&
      high >= 0 && high <= 0xffff &&
      low >= 0 && low <= 0xffff
    ) {
      const a = (high >> 8) & 0xff;
      const b = high & 0xff;
      const c = (low >> 8) & 0xff;
      const d = low & 0xff;
      return isPrivateIPv4(`${a}.${b}.${c}.${d}`);
    }
  }
  return false;
}

/** True when the given literal IP (v4 or v6) falls in a private/reserved range. */
export function isPrivateIp(ip: string): boolean {
  const kind = isIP(ip);
  if (kind === 4) return isPrivateIPv4(ip);
  if (kind === 6) return isPrivateIPv6(ip);
  return true; // not a parseable IP -> treat as unsafe
}

/**
 * Pure check over a DNS answer: returns the first private address, or null
 * when every record is public. Split out from safeWebhookLookup so the
 * decision logic is unit-testable without real DNS.
 */
export function findPrivateResolvedAddress(
  addresses: readonly Pick<LookupAddress, 'address'>[],
): string | null {
  if (addresses.length === 0) return null;
  for (const entry of addresses) {
    if (isPrivateIp(entry.address)) return entry.address;
  }
  return null;
}

type LookupCallback = (
  err: NodeJS.ErrnoException | null,
  address: string | LookupAddress[],
  family?: number,
) => void;

/**
 * DNS lookup hook for undici's Agent connect options. Resolves ALL records
 * for the hostname, rejects the connection if any of them is private, and
 * otherwise answers in the shape the caller asked for (all vs single).
 * Rejecting on "any record private" (instead of just the first) prevents
 * round-robin answers from smuggling a private target past the check.
 */
export function safeWebhookLookup(
  hostname: string,
  options: { all?: boolean; family?: number | 'IPv4' | 'IPv6' },
  callback: LookupCallback,
): void {
  const family =
    options.family === 4 || options.family === 'IPv4'
      ? 4
      : options.family === 6 || options.family === 'IPv6'
        ? 6
        : 0;
  dnsLookup(hostname, { all: true, family }, (err, addresses) => {
    if (err) {
      callback(err, []);
      return;
    }
    const list = addresses as LookupAddress[];
    const privateAddr = findPrivateResolvedAddress(list);
    if (privateAddr || list.length === 0) {
      const blocked = Object.assign(
        new Error(`callback_url hostname resolves to a private address: ${hostname}`),
        { code: 'UNSAFE_CALLBACK_URL' },
      );
      callback(blocked, []);
      return;
    }
    if (options.all) {
      callback(null, list);
    } else {
      callback(null, list[0].address, list[0].family);
    }
  });
}

export interface CallbackUrlValidationOptions {
  allowPrivate?: boolean;
}

/**
 * Returns true when the URL is safe to fetch as a webhook callback.
 * Returns false (with reason logged via the optional reasonRef) otherwise.
 */
export function isCallbackUrlSafe(
  raw: string,
  options: CallbackUrlValidationOptions = {},
): { ok: true } | { ok: false; reason: string } {
  if (options.allowPrivate) return { ok: true };

  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return { ok: false, reason: 'invalid_url' };
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { ok: false, reason: 'unsupported_scheme' };
  }

  // WHATWG URL.hostname keeps the IPv6 brackets, but node:net.isIP() does
  // not accept bracketed input. Strip them so the IP-range checks below see
  // the canonical address.
  let host = parsed.hostname.toLowerCase();
  if (host.startsWith('[') && host.endsWith(']')) {
    host = host.slice(1, -1);
  }
  if (!host) return { ok: false, reason: 'empty_hostname' };

  if (BLOCKED_HOSTNAMES.has(host)) {
    return { ok: false, reason: 'blocked_hostname' };
  }
  for (const suffix of BLOCKED_HOSTNAME_SUFFIXES) {
    if (host.endsWith(suffix)) {
      return { ok: false, reason: 'blocked_hostname_suffix' };
    }
  }

  const ipKind = isIP(host); // 0 = not IP, 4 = IPv4, 6 = IPv6
  if (ipKind === 4 && isPrivateIPv4(host)) {
    return { ok: false, reason: 'private_ipv4' };
  }
  if (ipKind === 6 && isPrivateIPv6(host)) {
    return { ok: false, reason: 'private_ipv6' };
  }

  return { ok: true };
}

/**
 * Throwing convenience wrapper for use in services and validators that
 * prefer exceptions to result objects.
 */
export class UnsafeCallbackUrlError extends Error {
  readonly code = 'UNSAFE_CALLBACK_URL';
  constructor(public readonly reason: string) {
    super(`callback_url rejected: ${reason}`);
  }
}

export function assertCallbackUrlSafe(
  raw: string,
  options: CallbackUrlValidationOptions = {},
): void {
  const result = isCallbackUrlSafe(raw, options);
  if (!result.ok) {
    throw new UnsafeCallbackUrlError(result.reason);
  }
}
