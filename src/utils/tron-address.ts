import bs58check from 'bs58check';

const TRON_ADDRESS_PREFIX = 0x41;
const TRON_ADDRESS_LENGTH = 34;

function asBase58(address: string): string {
  const hex = /^(?:0x)?(41[0-9a-f]{40})$/i.exec(address);
  return hex ? bs58check.encode(Buffer.from(hex[1], 'hex')) : address;
}

/** TronGrid can represent the contract in Base58 or TRON-prefixed hex. */
export function isTransferOfContract(type: unknown, contract: unknown, expected: string): boolean {
  return type === 'Transfer' && typeof contract === 'string' &&
    (contract === expected || asBase58(contract) === asBase58(expected));
}

/**
 * Format + checksum validation for a TRON base58 address (T..., 34 chars,
 * 0x41 version byte). Catches typos and truncation; it cannot tell whether
 * the address belongs to the merchant — that is what the confirm + test
 * transfer steps in the address lifecycle are for.
 */
export function isValidTronAddress(value: unknown): value is string {
  if (typeof value !== 'string' || value.length !== TRON_ADDRESS_LENGTH || !value.startsWith('T')) {
    return false;
  }
  try {
    const bytes = bs58check.decode(value);
    return bytes.length === 21 && bytes[0] === TRON_ADDRESS_PREFIX;
  } catch {
    return false;
  }
}
