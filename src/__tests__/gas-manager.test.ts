import { afterEach, describe, expect, it, vi } from 'vitest';

const { fetchMock } = vi.hoisted(() => ({ fetchMock: vi.fn() }));
vi.mock('undici', () => ({ fetch: fetchMock }));
const { GasManager } = await import('../services/gas-manager.js');
const { getChainOutcome } = await import('../services/chain-transactions.js');
const { TronWeb } = await import('tronweb');
afterEach(() => { vi.useRealTimers(); fetchMock.mockReset(); });

describe('solidified execution receipts', () => {
  const hash = 'b'.repeat(64);
  const expected = { from: 'TACBmCJj8xFqUjVqYx9TFhX5acU7zD5Win', to: 'TQ1zZmDXbX6qeQfambjkyqbHzDZLQqnWcA',
    contract: 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t', amountSun: '1000000' };
  const addressHex = (value: string) => TronWeb.address.toHex(value).slice(-40).toLowerCase();
  const transfer = () => ({ address: addressHex(expected.contract), topics: [
    'ddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef',
    addressHex(expected.from).padStart(64, '0'), addressHex(expected.to).padStart(64, '0'),
  ], data: BigInt(expected.amountSun).toString(16).padStart(64, '0') });
  const receipt = (log: unknown[], extra = {}) => fetchMock.mockResolvedValue({ ok: true,
    json: async () => ({ id: hash, blockNumber: 42, receipt: { result: 'SUCCESS' }, log, ...extra }) });

  it('accepts only solidified success with the expected token transfer', async () => {
    receipt([transfer()]);
    expect(await getChainOutcome(hash, 'trc20', expected)).toEqual({ status: 'success' });
  });
  it.each(['recipient', 'sender', 'contract', 'amount', 'missing'])('keeps %s mismatch unknown without authorizing replacement', async (field) => {
    const event = transfer();
    if (field === 'recipient') event.topics[2] = '0'.repeat(64);
    if (field === 'sender') event.topics[1] = '0'.repeat(64);
    if (field === 'contract') event.address = '0'.repeat(40);
    if (field === 'amount') event.data = '0'.repeat(64);
    receipt(field === 'missing' ? [] : [event]);
    expect(await getChainOutcome(hash, 'trc20', expected)).toEqual({ status: 'pending' });
  });
  it('rejects top-level failure even when the nested receipt claims success', async () => {
    receipt([transfer()], { result: 'FAILED' });
    expect(await getChainOutcome(hash, 'trc20', expected)).toMatchObject({ status: 'failed' });
  });
  it('does not accept a receipt for another transaction', async () => {
    receipt([transfer()], { id: 'c'.repeat(64) });
    expect(await getChainOutcome(hash, 'trc20', expected)).toEqual({ status: 'pending' });
  });
  it.each(['SUCCESS', 'REVERT'])('checks native TRX finality separately (%s)', async (contractRet) => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ txID: hash, ret: [{ contractRet }] }) });
    expect((await getChainOutcome(hash, 'trx')).status).toBe(contractRet === 'SUCCESS' ? 'success' : 'failed');
    expect(String(fetchMock.mock.calls[0][0])).toContain('/walletsolidity/gettransactionbyid');
  });
  it.each(['matching', 'recipient', 'sender', 'amount'])('verifies the native TransferContract effect (%s)', async (field) => {
    const value = { owner_address: TronWeb.address.toHex(expected.from), to_address: TronWeb.address.toHex(expected.to), amount: 1000000 };
    if (field === 'recipient') value.to_address = TronWeb.address.toHex(expected.from);
    if (field === 'sender') value.owner_address = TronWeb.address.toHex(expected.to);
    if (field === 'amount') value.amount = 1;
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ txID: hash, ret: [{ contractRet: 'SUCCESS' }],
      raw_data: { contract: [{ type: 'TransferContract', parameter: { value } }] } }) });
    expect((await getChainOutcome(hash, 'trx', expected)).status).toBe(field === 'matching' ? 'success' : 'pending');
  });
  it.each(['REVERT', 'OUT_OF_ENERGY'])('rejects a mined but failed %s execution', async (result) => {
    vi.useFakeTimers();
    const hash = 'a'.repeat(64);
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ id: hash, blockNumber: 42, receipt: { result } }) });
    const manager = new GasManager({} as never);
    const outcome = manager.waitForConfirmation(hash, 6000).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(6500);
    expect(await outcome).toBeInstanceOf(Error);
    expect(String(await outcome)).toContain(result);
    expect(String(fetchMock.mock.calls[0][0])).toContain('/walletsolidity/');
  });
});
