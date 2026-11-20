import { beforeEach, describe, expect, it, vi } from 'vitest';

const { rows, fetchMock } = vi.hoisted(() => ({ rows: vi.fn(), fetchMock: vi.fn() }));
vi.mock('../db/index.js', () => ({
  getDb: () => ({ select: () => ({ from: () => ({ where: rows }) }) }),
}));
vi.mock('undici', () => ({ fetch: fetchMock }));
const { checkConfirmations } = await import('../services/confirmation-checker.js');
const engine = { onPaymentConfirmed: vi.fn(), alertStuckDetected: vi.fn() };
const head = { ok: true, json: async () => ({ block_header: { raw_data: { number: 100 } } }) };
const receipt = (blockNumber: number) => ({ ok: true, json: async () => ({ blockNumber }) });

beforeEach(() => {
  rows.mockReset().mockResolvedValue([{ id: 'order', txHash: 'tx', updatedAt: new Date() }]);
  fetchMock.mockReset();
  engine.onPaymentConfirmed.mockReset().mockResolvedValue(undefined);
  engine.alertStuckDetected.mockReset().mockResolvedValue(undefined);
});

describe('payment confirmations', () => {
  it('confirms at the configured depth using the full-node head', async () => {
    fetchMock.mockResolvedValueOnce(head).mockResolvedValueOnce(receipt(81));
    await checkConfirmations(engine);
    expect(engine.onPaymentConfirmed).toHaveBeenCalledExactlyOnceWith('tx', 19, 81);
    expect(fetchMock.mock.calls[0][0]).toContain('/wallet/getnowblock');
  });

  it('keeps a payment detected when it is one confirmation short', async () => {
    fetchMock.mockResolvedValueOnce(head).mockResolvedValueOnce(receipt(82));
    await checkConfirmations(engine);
    expect(engine.onPaymentConfirmed).not.toHaveBeenCalled();
  });

  it('continues with other payments after one receipt request fails', async () => {
    rows.mockResolvedValue([
      { id: 'first', txHash: 'first', updatedAt: new Date() },
      { id: 'second', txHash: 'second', updatedAt: new Date() },
    ]);
    fetchMock
      .mockResolvedValueOnce(head)
      .mockRejectedValueOnce(new Error('timeout'))
      .mockResolvedValueOnce(receipt(81));
    await checkConfirmations(engine);
    expect(engine.onPaymentConfirmed).toHaveBeenCalledExactlyOnceWith('second', 19, 81);
  });

  it('does not let a failed stuck-payment alert block confirmation', async () => {
    rows.mockResolvedValue([{ id: 'stuck', txHash: 'tx', updatedAt: new Date(0) }]);
    engine.alertStuckDetected.mockRejectedValue(new Error('alert unavailable'));
    fetchMock.mockResolvedValueOnce(head).mockResolvedValueOnce(receipt(81));
    await checkConfirmations(engine);
    expect(engine.alertStuckDetected).toHaveBeenCalled();
    expect(engine.onPaymentConfirmed).toHaveBeenCalledExactlyOnceWith('tx', 19, 81);
  });

  it.each([0, -1, 1.5, NaN, undefined, 101])('retries instead of confirming an invalid receipt height %s', async blockNumber => {
    fetchMock.mockResolvedValueOnce(head).mockResolvedValueOnce({ ok: true, json: async () => ({ blockNumber }) });
    await checkConfirmations(engine);
    expect(engine.onPaymentConfirmed).not.toHaveBeenCalled();
  });
});
