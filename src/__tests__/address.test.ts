import { describe, it, expect } from 'vitest';
import BIP32Factory from 'bip32';
import * as ecc from 'tiny-secp256k1';
import * as bip39 from 'bip39';
import { keccak_256 } from '@noble/hashes/sha3.js';
import bs58check from 'bs58check';

const bip32 = BIP32Factory(ecc);

// Inline pure derivation logic (mirrors wallet.ts, no env dependency)
const BIP44_PATH = "m/44'/195'/0'/0";

function pubKeyToTronAddress(pubKey: Uint8Array): string {
  const uncompressed = ecc.pointCompress(pubKey, false);
  const hash = keccak_256(uncompressed.slice(1));
  const addrBytes = new Uint8Array(21);
  addrBytes[0] = 0x41;
  addrBytes.set(hash.slice(-20), 1);
  return bs58check.encode(Buffer.from(addrBytes));
}

function mnemonicToXpub(mnemonic: string): string {
  const seed = bip39.mnemonicToSeedSync(mnemonic);
  const root = bip32.fromSeed(seed);
  const account = root.derivePath(BIP44_PATH);
  const xpub = account.neutered().toBase58();
  seed.fill(0);
  return xpub;
}

function deriveAddress(xpub: string, index: number): string {
  const node = bip32.fromBase58(xpub);
  const child = node.derive(index);
  return pubKeyToTronAddress(child.publicKey);
}

// Well-known BIP39 test mnemonic
const TEST_MNEMONIC =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';

describe('HD address derivation', () => {
  it('validates the test mnemonic', () => {
    expect(bip39.validateMnemonic(TEST_MNEMONIC)).toBe(true);
  });

  it('derives a valid TRON address (starts with T, 34 chars)', () => {
    const xpub = mnemonicToXpub(TEST_MNEMONIC);
    const addr = deriveAddress(xpub, 0);
    expect(addr).toMatch(/^T[1-9A-HJ-NP-Za-km-z]{33}$/);
  });

  it('is deterministic — same mnemonic always yields same address', () => {
    const xpub1 = mnemonicToXpub(TEST_MNEMONIC);
    const xpub2 = mnemonicToXpub(TEST_MNEMONIC);
    expect(deriveAddress(xpub1, 0)).toBe(deriveAddress(xpub2, 0));
  });

  it('different indices produce different addresses', () => {
    const xpub = mnemonicToXpub(TEST_MNEMONIC);
    const addrs = Array.from({ length: 5 }, (_, i) => deriveAddress(xpub, i));
    const unique = new Set(addrs);
    expect(unique.size).toBe(5);
  });

  it('xpub derivation does not expose private key', () => {
    const seed = bip39.mnemonicToSeedSync(TEST_MNEMONIC);
    const root = bip32.fromSeed(seed);
    const account = root.derivePath(BIP44_PATH);
    const neutered = account.neutered();
    expect(neutered.privateKey).toBeUndefined();
  });
});
