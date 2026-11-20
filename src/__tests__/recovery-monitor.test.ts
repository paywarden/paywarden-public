import { afterEach, expect, it, vi } from 'vitest';
const { dispatch } = vi.hoisted(() => ({ dispatch: vi.fn() }));
vi.mock('../services/webhook-outbox.js', () => ({ dispatchWebhookOutbox: dispatch }));
const { startRecoveryMonitor } = await import('../services/recovery-monitor.js');
afterEach(() => { vi.useRealTimers(); dispatch.mockReset(); });

it('does not overlap recovery cycles and drains work before shutdown', async () => {
  vi.useFakeTimers();
  let finish!: () => void;
  dispatch.mockReturnValue(new Promise<void>((resolve) => { finish = resolve; }));
  const sweeper = { recoverPending: vi.fn().mockResolvedValue(undefined) };
  const stop = startRecoveryMonitor({ enqueueDelivery: vi.fn() } as never, sweeper as never);
  await vi.advanceTimersByTimeAsync(15_000);
  expect(dispatch).toHaveBeenCalledTimes(1);
  expect(sweeper.recoverPending).toHaveBeenCalledTimes(1);
  let stopped = false;
  const shutdown = stop().then(() => { stopped = true; });
  await Promise.resolve(); expect(stopped).toBe(false);
  finish(); await shutdown;
  await vi.advanceTimersByTimeAsync(15_000);
  expect(dispatch).toHaveBeenCalledTimes(1);
});
