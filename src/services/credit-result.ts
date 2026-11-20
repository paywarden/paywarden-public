/**
 * Outcome of crediting an on-chain transfer to a pending order. Shared by
 * OrderEngine (HD + static detection) and the static-address claim flow.
 *
 *   detected     — order flipped to detected, transaction + event written
 *   not_pending  — order was no longer pending (expiry sweep won the race); nothing written
 *   tx_conflict  — transactions.tx_hash already exists (transfer already credited,
 *                  recorded as late payment, or used as a test transfer); nothing written
 */
export type CreditResult = 'detected' | 'not_pending' | 'tx_conflict';

/** Thrown inside the credit transaction to roll it back with a typed outcome. */
export class CreditAbort extends Error {
  constructor(public readonly result: Exclude<CreditResult, 'detected'>) {
    super(`credit aborted: ${result}`);
    this.name = 'CreditAbort';
  }
}
