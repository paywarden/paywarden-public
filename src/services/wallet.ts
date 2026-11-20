import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import * as bip39 from 'bip39';
import BIP32Factory from 'bip32';
import * as ecc from 'tiny-secp256k1';
import { keccak_256 } from '@noble/hashes/sha3.js';
import bs58check from 'bs58check';
import { env } from '../config/env.js';
import { encrypt, decrypt } from '../utils/crypto.js';
import { logger } from '../utils/logger.js';
import { BIP44_PATH } from '../config/constants.js';

const bip32 = BIP32Factory(ecc);

const VAULT_DIR = join(process.cwd(), 'vault');
const VAULT_FILE = join(VAULT_DIR, 'seed.enc');

/** Convert a secp256k1 public key Buffer to a TRON base58check address. */
function pubKeyToTronAddress(pubKey: Uint8Array): string {
  // Ensure uncompressed (65 bytes: 04 || x || y)
  const uncompressed = ecc.pointCompress(pubKey, false);
  // keccak256 of the 64-byte body (skip 04 prefix)
  const hash = keccak_256(uncompressed.slice(1));
  // Take last 20 bytes, prepend 0x41 (TRON mainnet prefix)
  const addrBytes = new Uint8Array(21);
  addrBytes[0] = 0x41;
  addrBytes.set(hash.slice(-20), 1);
  // base58check encode
  return bs58check.encode(Buffer.from(addrBytes));
}

export class WalletService {
  private xpub: string | null = null;

  /** Load vault on startup. If no vault exists, service is uninitialized. */
  async init(): Promise<void> {
    if (!existsSync(VAULT_FILE)) {
      logger.warn('Vault not found. Call POST /api/v1/wallet/init to initialize.');
      return;
    }

    const encrypted = readFileSync(VAULT_FILE, 'utf8').trim();
    const mnemonic = decrypt(encrypted, this.vaultKey());
    this.xpub = this.mnemonicToXpub(mnemonic);
    logger.info('Wallet vault loaded successfully.');
  }

  /** VAULT_KEY is optional in env (static mode has no seed); HD paths require it. */
  private vaultKey(): string {
    if (!env.VAULT_KEY) throw new Error('VAULT_KEY is required for HD wallet operations');
    return env.VAULT_KEY;
  }

  isInitialized(): boolean {
    return this.xpub !== null;
  }

  /**
   * First-time setup: generate or import mnemonic, encrypt + save vault.
   * Returns mnemonic — shown ONCE, user must back up.
   */
  async initVault(mnemonic?: string): Promise<string> {
    if (existsSync(VAULT_FILE)) {
      throw new Error('Vault already exists. Cannot reinitialize.');
    }

    const seedPhrase = mnemonic ?? bip39.generateMnemonic(256);

    if (!bip39.validateMnemonic(seedPhrase)) {
      throw new Error('Invalid mnemonic provided.');
    }

    if (!existsSync(VAULT_DIR)) {
      mkdirSync(VAULT_DIR, { recursive: true });
    }

    const encrypted = encrypt(seedPhrase, this.vaultKey());
    writeFileSync(VAULT_FILE, encrypted, { encoding: 'utf8', mode: 0o600 });

    this.xpub = this.mnemonicToXpub(seedPhrase);
    logger.info('Vault initialized successfully.');

    return seedPhrase;
  }

  /** Derive address at BIP44 index (uses xpub, no private key needed). */
  async deriveAddress(index: number): Promise<{ address: string; index: number }> {
    if (!this.xpub) {
      throw new Error('Wallet not initialized.');
    }

    const node = bip32.fromBase58(this.xpub);
    const child = node.derive(index);

    if (!child.publicKey) {
      throw new Error(`Failed to derive public key at index ${index}`);
    }

    const address = pubKeyToTronAddress(child.publicKey);
    return { address, index };
  }

  /** Batch-derive addresses. */
  async deriveAddresses(
    start: number,
    count: number,
  ): Promise<Array<{ address: string; index: number }>> {
    const results: Array<{ address: string; index: number }> = [];
    for (let i = start; i < start + count; i++) {
      results.push(await this.deriveAddress(i));
    }
    return results;
  }

  /**
   * ⚠️ Sensitive: Only for sweep/signing. Decrypt vault → derive private key.
   * Caller MUST call Buffer.fill(0) on the returned buffer after use.
   */
  async getPrivateKeyForSigning(index: number): Promise<Buffer> {
    if (!existsSync(VAULT_FILE)) {
      throw new Error('Vault not found.');
    }

    const encrypted = readFileSync(VAULT_FILE, 'utf8').trim();
    const mnemonic = decrypt(encrypted, this.vaultKey());
    const seed = await bip39.mnemonicToSeed(mnemonic);
    const root = bip32.fromSeed(seed);
    const child = root.derivePath(`${BIP44_PATH}/${index}`);

    if (!child.privateKey) {
      throw new Error(`Failed to derive private key at index ${index}`);
    }

    const privateKey = Buffer.from(child.privateKey);
    // Clear intermediate buffers
    seed.fill(0);

    return privateKey;
  }

  private mnemonicToXpub(mnemonic: string): string {
    const seed = bip39.mnemonicToSeedSync(mnemonic);
    const root = bip32.fromSeed(seed);
    const account = root.derivePath(BIP44_PATH);
    const xpub = account.neutered().toBase58();
    seed.fill(0);
    return xpub;
  }
}
