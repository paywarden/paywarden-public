import { TronWeb } from 'tronweb';
import { Decimal } from 'decimal.js';
import { fundNative, type NativeFundingScope } from './native-funding.js';
import { env } from '../config/env.js';
import { logger } from '../utils/logger.js';
import { NETWORK } from '../config/constants.js';
import type { Notifier } from './notifier.js';
import { getChainOutcome, ChainExecutionError, type ExpectedTransfer, type ExpectedNativeTransfer } from './chain-transactions.js';

const TRX_DECIMALS = 1_000_000; // 1 TRX = 1,000,000 sun
const ACTIVATION_SUN = 100_000; // 0.1 TRX sent to address (costs sender ~1.1 TRX including account-creation fee)
const CONFIRMATION_TIMEOUT_MS = 120_000;
const CONFIRMATION_POLL_MS = 3_000;

export class GasManager {
  readonly tronWeb: TronWeb;
  private notifier: Notifier | null = null;

  constructor(tronWeb: TronWeb) {
    this.tronWeb = tronWeb;
  }

  setNotifier(notifier: Notifier): void {
    this.notifier = notifier;
  }

  /** Reconcile this cycle's original transaction before checking account state. */
  async checkAndActivate(address: string, scope: NativeFundingScope): Promise<boolean> {
    if (!env.HOT_WALLET_KEY) throw new Error('HOT_WALLET_KEY not configured');
    const hotAddress = TronWeb.address.fromPrivateKey(env.HOT_WALLET_KEY);
    if (!hotAddress) throw new Error('Invalid hot wallet key');
    return fundNative(this.tronWeb, scope, 'activation', address, hotAddress, String(ACTIVATION_SUN), env.HOT_WALLET_KEY,
      async () => {
        const account = await this.tronWeb.trx.getAccount(address);
        return !account || Object.keys(account).length === 0;
      }, (hash, expected) => this.waitForConfirmation(hash, CONFIRMATION_TIMEOUT_MS, 'trx', expected));
  }

  /** A stale balance never authorizes a second payment within the same cycle. */
  async checkAndTopup(address: string, scope: NativeFundingScope): Promise<boolean> {
    if (!env.HOT_WALLET_KEY) throw new Error('HOT_WALLET_KEY not configured');
    const hotAddress = TronWeb.address.fromPrivateKey(env.HOT_WALLET_KEY);
    if (!hotAddress) throw new Error('Invalid hot wallet key');
    const amountSun = new Decimal(env.SWEEP_GAS_TOPUP_TRX).mul(TRX_DECIMALS).toFixed(0);
    return fundNative(this.tronWeb, scope, 'gas', address, hotAddress, amountSun, env.HOT_WALLET_KEY,
      async () => new Decimal(await this.tronWeb.trx.getBalance(address)).lt(amountSun),
      (hash, expected) => this.waitForConfirmation(hash, CONFIRMATION_TIMEOUT_MS, 'trx', expected));
  }

  /** Log a warning if hot wallet TRX is below the alert threshold. Returns balance in TRX. */
  async checkHotWalletBalance(): Promise<number> {
    if (!env.HOT_WALLET_KEY) return 0;

    const hotAddress = TronWeb.address.fromPrivateKey(env.HOT_WALLET_KEY) as string;
    const balanceSun = await this.tronWeb.trx.getBalance(hotAddress);
    const balanceTrx = balanceSun / TRX_DECIMALS;

    if (balanceTrx < env.HOT_WALLET_ALERT_TRX) {
      logger.warn(
        { balanceTrx, threshold: env.HOT_WALLET_ALERT_TRX },
        'Hot wallet balance low — please top up',
      );
      this.notifier
        ?.notify({ type: 'low_balance', balanceTrx, threshold: env.HOT_WALLET_ALERT_TRX })
        .catch((err) => logger.error({ err }, 'Failed to send low balance notification'));
    }

    return balanceTrx;
  }

  getTransactionOutcome(txId: string, expected?: ExpectedTransfer) {
    return getChainOutcome(txId, 'trc20', expected);
  }

  async waitForConfirmation(
    txId: string, timeoutMs = CONFIRMATION_TIMEOUT_MS,
    kind: 'trx' | 'trc20' = 'trc20', expected?: ExpectedNativeTransfer & { contract?: string },
  ): Promise<void> {
    if (!txId) throw new Error('waitForConfirmation: txId is empty');
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, CONFIRMATION_POLL_MS));
      let outcome;
      try { outcome = await getChainOutcome(txId, kind, expected); }
      catch (err) {
        logger.warn({ err, txId }, 'Transaction state unavailable; retaining original transaction');
        continue;
      }
      if (outcome.status === 'success') return;
      if (outcome.status === 'failed') throw new ChainExecutionError(outcome.reason);
    }
    throw new Error('Transaction outcome remains unknown: ' + txId);
  }

}

/** Create a shared TronWeb instance for signing & broadcasting. */
export function createTronWeb(): TronWeb {
  return new TronWeb({
    fullHost: NETWORK.trongridUrl,
    headers: { 'TRON-PRO-API-KEY': env.TRONGRID_API_KEY },
  });
}
