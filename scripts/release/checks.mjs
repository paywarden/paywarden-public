import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createGateway } from './rpc-gateway.mjs';

test('gateway preserves a broadcast and drops a selected response only after acceptance', async () => {
  const received = [];
  const server = createGateway({ forward: async (route, method, body) => {
    received.push({ route, method, body }); return Response.json({ result: true });
  } });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const base = 'http://127.0.0.1:' + server.address().port;
  const body = JSON.stringify({ txID: 'a'.repeat(64), raw_data: { contract: [{ type: 'TransferContract', parameter: { value: { amount: 20000000 } } }] } });
  try {
    await fetch(base + '/__control', { method: 'POST', body: JSON.stringify({ dropBroadcast: { contractType: 'TransferContract', amountSun: '20000000', remaining: 1 } }) });
    await assert.rejects(fetch(base + '/wallet/broadcasttransaction', { method: 'POST', body }));
    const response = await fetch(base + '/wallet/broadcasttransaction', { method: 'POST', body });
    assert.equal((await response.json()).result, true);
    assert.equal(received.length, 2); assert.equal(received[0].body, body); assert.equal(received[1].body, body);
    const events = await (await fetch(base + '/__events')).json();
    assert.deepEqual(events.map(e => e.responseDropped), [true, false]);
    assert.ok(events.every(e => e.accepted));
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});

test('gateway does not describe an upstream rejection as an accepted lost response', async () => {
  const server = createGateway({ forward: async () => Response.json({ result: false, code: 'SIGERROR' }) });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const base = 'http://127.0.0.1:' + server.address().port;
  try {
    await fetch(base + '/__control', { method: 'POST', body: JSON.stringify({ dropBroadcast: { remaining: 1 } }) });
    const response = await fetch(base + '/wallet/broadcasttransaction', { method: 'POST', body: '{"txID":"rejected"}' });
    assert.equal((await response.json()).result, false);
    assert.equal((await (await fetch(base + '/__events')).json())[0].responseDropped, false);
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});
