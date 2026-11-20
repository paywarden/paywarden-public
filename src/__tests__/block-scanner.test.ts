import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TronWeb } from 'tronweb';
import type { OrderEngine } from '../services/order-engine.js';

const { fetchMock, watchedAddresses } = vi.hoisted(() => ({
  fetchMock: vi.fn(),
  watchedAddresses: vi.fn(),
}));
vi.mock('undici', () => ({ fetch: fetchMock }));
vi.mock('../db/index.js', () => ({
  getDb: () => ({
    selectDistinct: () => ({ from: () => ({ where: watchedAddresses }) }),
  }),
}));

const { scanConfirmedBlock, getConfirmedChainHead } = await import('../services/block-scanner.js');
const { env } = await import('../config/env.js');
const ADDR = 'TACBmCJj8xFqUjVqYx9TFhX5acU7zD5Win';
const ADDR2 = 'TXYZopYRdj2D9XRtbG411XZZ3kM5VkAeBf';

function transfer(hash: string, address: string) {
  const hex = (base58: string) => '0x' + TronWeb.address.toHex(base58).slice(2);
  return {
    event_name: 'Transfer',
    contract_address: env.USDT_CONTRACT,
    block_number: 42,
    block_timestamp: 1_800_000_000_000,
    transaction_id: hash,
    result: { from: hex(ADDR), to: hex(address), value: '1000001' },
  };
}

function page(data: unknown[], fingerprint?: string) {
  return {
    ok: true,
    json: async () => ({ success: true, data, meta: { fingerprint } }),
  };
}

describe('confirmed block scanner', () => {
  const onPaymentDetected = vi.fn();
  const engine: Pick<OrderEngine, 'onPaymentDetected'> = { onPaymentDetected };

  beforeEach(() => {
    fetchMock.mockReset();
    watchedAddresses.mockReset().mockResolvedValue([{ address: ADDR }, { address: ADDR2 }]);
    onPaymentDetected.mockReset().mockResolvedValue(undefined);
  });

  it('reads the last solidified height', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ block_header: { raw_data: { number: 42 } } }),
    });
    expect(await getConfirmedChainHead()).toBe(42);
    expect(fetchMock.mock.calls[0]?.[0]).toContain('/walletsolidity/getnowblock');
  });

  it('leaves the whole block unprocessed when a later event page fails', async () => {
    fetchMock.mockResolvedValueOnce(page([transfer('tx-a', ADDR)], 'next'));
    fetchMock.mockResolvedValueOnce({ ok: false, status: 429 });
    await expect(scanConfirmedBlock(42, engine)).rejects.toThrow('429');
    expect(onPaymentDetected).not.toHaveBeenCalled();
  });

  it('matches multiple payments after all confirmed event pages are read', async () => {
    fetchMock.mockResolvedValueOnce(page([transfer('tx-a', ADDR)], 'next'));
    fetchMock.mockResolvedValueOnce(page([transfer('tx-b', ADDR2)]));
    await scanConfirmedBlock(42, engine);
    expect(fetchMock.mock.calls[0]?.[0]).toContain('only_confirmed=true');
    expect(fetchMock.mock.calls[1]?.[0]).toContain('fingerprint=next');
    expect(onPaymentDetected).toHaveBeenCalledTimes(2);
    expect(onPaymentDetected).toHaveBeenCalledWith(
      'tx-b', ADDR2, '1.000001', ADDR, 42, 1_800_000_000_000,
    );
  });

  it('rejects an unsuccessful response with a 200 HTTP status', async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ success: false, data: [] }) });
    await expect(scanConfirmedBlock(42, engine)).rejects.toThrow();
  });

  it('checks each event name and contract before matching its recipient', async () => {
    const tx = transfer('ignored', ADDR);
    fetchMock.mockResolvedValue(page([
      { ...tx, event_name: 'Approval' },
      { ...tx, event_name: undefined },
      { ...tx, event_name: 'Unknown' },
      { ...tx, contract_address: ADDR },
      { ...tx, contract_address: undefined },
      { ...transfer('valid', ADDR2), contract_address: TronWeb.address.toHex(env.USDT_CONTRACT) },
    ]));
    await scanConfirmedBlock(42, engine);
    expect(onPaymentDetected).toHaveBeenCalledExactlyOnceWith(
      'valid', ADDR2, '1.000001', ADDR, 42, 1_800_000_000_000,
    );
  });

  it('rejects a repeated cursor without processing the partial block', async () => {
    fetchMock.mockResolvedValue(page([transfer('tx-a', ADDR)], 'next'));
    await expect(scanConfirmedBlock(42, engine)).rejects.toThrow('pagination');
    expect(onPaymentDetected).not.toHaveBeenCalled();
  });
});
