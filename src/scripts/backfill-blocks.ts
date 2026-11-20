import { TronWeb } from 'tronweb';
import { NETWORK } from '../config/constants.js';
import { env } from '../config/env.js';
import { closeDb } from '../db/index.js';
import { getConfirmedChainHead, scanConfirmedBlock } from '../services/block-scanner.js';
import { FundSweeper } from '../services/fund-sweeper.js';
import { GasManager } from '../services/gas-manager.js';
import { OrderEngine } from '../services/order-engine.js';
import { WalletService } from '../services/wallet.js';
import { WebhookNotifier } from '../services/webhook-notifier.js';
import { logger } from '../utils/logger.js';

async function backfill(): Promise<void> {
  const args = process.argv.slice(2);
  const [from, to] = args.map(Number);
  if (args.length !== 2 || args.some((value) => !/^\d+$/.test(value)) ||
      !Number.isSafeInteger(from) || !Number.isSafeInteger(to) || to < from) {
    throw new Error('Provide an inclusive block range: backfill-blocks <from> <to>');
  }
  if (env.ADDRESS_MODE !== 'hd') throw new Error('Historical backfill requires ADDRESS_MODE=hd');

  const head = await getConfirmedChainHead();
  if (to > head) throw new Error(`End block ${to} exceeds confirmed chain height ${head}`);

  const wallet = new WalletService();
  const gas = new GasManager(new TronWeb({ fullHost: NETWORK.trongridUrl }));
  const engine = new OrderEngine(wallet, new WebhookNotifier(), new FundSweeper(wallet, gas, env.REDIS_URL));

  for (let height = from; height <= to; height++) {
    try {
      await scanConfirmedBlock(height, engine);
    } catch (err) {
      throw new Error(`Backfill stopped at block ${height}. Resume from that height.`, { cause: err });
    }
  }
  logger.info({ from, to }, 'Confirmed block backfill complete');
}

try {
  await backfill();
} catch (err) {
  logger.error({ err }, 'Confirmed block backfill failed');
  process.exitCode = 1;
} finally {
  await closeDb();
}
