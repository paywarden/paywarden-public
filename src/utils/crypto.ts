import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from 'crypto';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 16;
const AUTH_TAG_LENGTH = 16;

/**
 * Encrypts plaintext using AES-256-GCM.
 * Output format: iv(32 hex) + authTag(32 hex) + ciphertext(hex)
 */
export function encrypt(plaintext: string, keyHex: string): string {
  const key = Buffer.from(keyHex, 'hex');
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv);

  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();

  return iv.toString('hex') + authTag.toString('hex') + encrypted.toString('hex');
}

/**
 * Decrypts AES-256-GCM ciphertext.
 * Input format: iv(32 hex) + authTag(32 hex) + ciphertext(hex)
 */
export function decrypt(ciphertext: string, keyHex: string): string {
  const key = Buffer.from(keyHex, 'hex');
  const iv = Buffer.from(ciphertext.slice(0, IV_LENGTH * 2), 'hex');
  const authTag = Buffer.from(ciphertext.slice(IV_LENGTH * 2, (IV_LENGTH + AUTH_TAG_LENGTH) * 2), 'hex');
  const data = Buffer.from(ciphertext.slice((IV_LENGTH + AUTH_TAG_LENGTH) * 2), 'hex');

  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);

  return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
}

/**
 * Computes HMAC-SHA256 over payload using secret.
 * Returns hex string.
 */
export function hmacSha256(payload: string, secret: string): string {
  return createHmac('sha256', secret).update(payload).digest('hex');
}

export function safeEqualString(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}
