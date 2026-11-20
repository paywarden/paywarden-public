import { describe, expect, it } from 'vitest';
import {
  isCallbackUrlSafe,
  assertCallbackUrlSafe,
  UnsafeCallbackUrlError,
  isPrivateIp,
  findPrivateResolvedAddress,
} from '../utils/url-safety.js';

describe('isCallbackUrlSafe', () => {
  describe('safe URLs', () => {
    it.each([
      'https://example.com/webhook',
      'https://api.merchant.com/paywarden/cb',
      'http://203.0.113.10/webhook', // documentation IP block, not private
      'https://merchant.example/path?query=1',
      'https://[2001:db8::1]/webhook', // documentation IPv6 prefix
    ])('accepts %s', (url) => {
      expect(isCallbackUrlSafe(url)).toEqual({ ok: true });
    });
  });

  describe('private IPv4 rejection', () => {
    it.each([
      ['127.0.0.1', 'private_ipv4'],
      ['127.255.255.255', 'private_ipv4'],
      ['10.0.0.1', 'private_ipv4'],
      ['10.255.255.255', 'private_ipv4'],
      ['172.16.0.1', 'private_ipv4'],
      ['172.31.255.255', 'private_ipv4'],
      ['192.168.1.1', 'private_ipv4'],
      ['169.254.169.254', 'private_ipv4'], // AWS / GCP instance metadata
      ['0.0.0.0', 'private_ipv4'],
      ['100.64.0.1', 'private_ipv4'], // CGNAT
      ['224.0.0.1', 'private_ipv4'], // multicast
    ])('rejects http://%s/x with reason %s', (ip, reason) => {
      const result = isCallbackUrlSafe(`http://${ip}/x`);
      expect(result).toEqual({ ok: false, reason });
    });

    it('accepts public IPv4 boundaries', () => {
      // 172.15.x.x is below the 172.16-31 private range
      expect(isCallbackUrlSafe('http://172.15.0.1/x')).toEqual({ ok: true });
      // 11.x is outside 10/8
      expect(isCallbackUrlSafe('http://11.0.0.1/x')).toEqual({ ok: true });
      // 192.167.x is below 192.168
      expect(isCallbackUrlSafe('http://192.167.1.1/x')).toEqual({ ok: true });
    });
  });

  describe('private IPv6 rejection', () => {
    it.each([
      ['[::1]', 'private_ipv6'],
      ['[fc00::1]', 'private_ipv6'], // unique-local
      ['[fd12:3456::1]', 'private_ipv6'], // unique-local
      ['[fe80::1]', 'private_ipv6'], // link-local
      ['[ff02::1]', 'private_ipv6'], // multicast
      ['[::ffff:127.0.0.1]', 'private_ipv6'], // IPv4-mapped loopback
      ['[::ffff:10.0.0.1]', 'private_ipv6'], // IPv4-mapped private
    ])('rejects http://%s/x with reason %s', (host, reason) => {
      const result = isCallbackUrlSafe(`http://${host}/x`);
      expect(result).toEqual({ ok: false, reason });
    });
  });

  describe('hostname blocklist', () => {
    it.each([
      ['http://localhost/x', 'blocked_hostname'],
      ['http://LocalHost/x', 'blocked_hostname'], // case-insensitive
      ['http://localhost.localdomain/x', 'blocked_hostname'],
      ['http://service.local/x', 'blocked_hostname_suffix'],
      ['http://api.internal/x', 'blocked_hostname_suffix'],
      ['http://something.localhost/x', 'blocked_hostname_suffix'],
    ])('rejects %s', (url, reason) => {
      expect(isCallbackUrlSafe(url)).toEqual({ ok: false, reason });
    });
  });

  describe('scheme + format', () => {
    it('rejects file://', () => {
      expect(isCallbackUrlSafe('file:///etc/passwd')).toEqual({
        ok: false,
        reason: 'unsupported_scheme',
      });
    });

    it('rejects gopher:// and other exotic schemes', () => {
      expect(isCallbackUrlSafe('gopher://example.com/x')).toEqual({
        ok: false,
        reason: 'unsupported_scheme',
      });
    });

    it('rejects malformed URLs', () => {
      expect(isCallbackUrlSafe('not a url')).toEqual({
        ok: false,
        reason: 'invalid_url',
      });
    });
  });

  describe('allowPrivate escape hatch', () => {
    it('accepts loopback when allowPrivate=true', () => {
      expect(
        isCallbackUrlSafe('http://localhost:4000/webhook', { allowPrivate: true }),
      ).toEqual({ ok: true });
      expect(isCallbackUrlSafe('http://127.0.0.1/x', { allowPrivate: true })).toEqual({
        ok: true,
      });
    });

    it('still allows public URLs when allowPrivate=true', () => {
      expect(isCallbackUrlSafe('https://example.com/x', { allowPrivate: true })).toEqual({
        ok: true,
      });
    });
  });
});

describe('assertCallbackUrlSafe', () => {
  it('throws UnsafeCallbackUrlError for unsafe URL', () => {
    expect(() => assertCallbackUrlSafe('http://127.0.0.1/x')).toThrow(UnsafeCallbackUrlError);
    try {
      assertCallbackUrlSafe('http://127.0.0.1/x');
    } catch (err) {
      expect(err).toBeInstanceOf(UnsafeCallbackUrlError);
      expect((err as UnsafeCallbackUrlError).reason).toBe('private_ipv4');
      expect((err as UnsafeCallbackUrlError).code).toBe('UNSAFE_CALLBACK_URL');
    }
  });

  it('does not throw for safe URL', () => {
    expect(() => assertCallbackUrlSafe('https://example.com/x')).not.toThrow();
  });
});

describe('isPrivateIp', () => {
  it.each(['127.0.0.1', '10.1.2.3', '172.16.0.1', '192.168.1.1', '169.254.169.254', '::1', 'fc00::1', 'fe80::1'])(
    'flags %s as private',
    (ip) => {
      expect(isPrivateIp(ip)).toBe(true);
    },
  );

  it.each(['1.1.1.1', '8.8.8.8', '2606:4700:4700::1111'])('allows public %s', (ip) => {
    expect(isPrivateIp(ip)).toBe(false);
  });

  it('treats non-IP input as unsafe', () => {
    expect(isPrivateIp('not-an-ip')).toBe(true);
  });
});

describe('findPrivateResolvedAddress', () => {
  it('returns null when every record is public', () => {
    expect(
      findPrivateResolvedAddress([{ address: '1.1.1.1' }, { address: '2606:4700:4700::1111' }]),
    ).toBeNull();
  });

  it('returns the private record even when a public one comes first (round-robin smuggling)', () => {
    expect(
      findPrivateResolvedAddress([{ address: '1.1.1.1' }, { address: '10.0.0.5' }]),
    ).toBe('10.0.0.5');
  });

  it('flags cloud metadata endpoint', () => {
    expect(findPrivateResolvedAddress([{ address: '169.254.169.254' }])).toBe('169.254.169.254');
  });

  it('returns null for an empty answer (caller rejects separately)', () => {
    expect(findPrivateResolvedAddress([])).toBeNull();
  });
});
