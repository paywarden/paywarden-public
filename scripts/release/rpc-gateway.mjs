import fs from 'node:fs';
import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';
import { fetch, EnvHttpProxyAgent } from 'undici';

export function createGateway({ forward, record = () => {} }) {
  const events = [];
  let rule = null;
  return createServer(async (req, res) => {
    try {
      let body = '';
      for await (const chunk of req) {
        body += chunk;
        if (body.length > 2_000_000) throw new Error('Request too large');
      }
      if (req.url === '/__events') {
        res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify(events));
      }
      if (req.url === '/__control' && req.method === 'POST') {
        const input = JSON.parse(body);
        if (input.dropBroadcast && (!Number.isInteger(input.dropBroadcast.remaining) || input.dropBroadcast.remaining < 1)) throw new Error('Invalid drop count');
        rule = input.dropBroadcast ?? null;
        res.writeHead(200); return res.end(JSON.stringify({ configured: true }));
      }
      if (!/^\/(wallet\/|walletsolidity\/|v1\/)/.test(req.url)) { res.writeHead(404); return res.end(); }
      const upstream = await forward(req.url, req.method, body, req.headers);
      const text = await upstream.text();
      if (req.url.split('?')[0] === '/wallet/broadcasttransaction') {
        const transaction = JSON.parse(body);
        const value = transaction.raw_data?.contract?.[0];
        let response;
        try { response = JSON.parse(text); } catch { response = {}; }
        const accepted = response.result === true || ['5', 'DUP_TRANSACTION_ERROR'].includes(String(response.code));
        const dropped = Boolean(accepted && rule?.remaining > 0 &&
          (!rule.txHash || rule.txHash === transaction.txID) &&
          (!rule.contractType || rule.contractType === value?.type) &&
          (!rule.amountSun || rule.amountSun === String(value?.parameter?.value?.amount)));
        if (dropped) rule.remaining--;
        const event = { at: new Date().toISOString(), hash: transaction.txID, contractType: value?.type,
          upstreamStatus: upstream.status, accepted, responseDropped: dropped };
        events.push(event); record(event);
        if (dropped) return res.destroy();
      }
      res.writeHead(upstream.status, { 'Content-Type': upstream.headers.get('content-type') ?? 'application/json' });
      res.end(text);
    } catch {
      if (!res.destroyed) { res.writeHead(502); res.end(JSON.stringify({ error: 'Nile gateway request failed' })); }
    }
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.env.NILE_ONLY !== 'true') throw new Error('NILE_ONLY=true is required');
  const dispatcher = new EnvHttpProxyAgent();
  const server = createGateway({
    forward: (route, method, body, headers) => fetch('https://nile.trongrid.io' + route, {
      method, body: ['GET', 'HEAD'].includes(method) ? undefined : body, dispatcher,
      headers: { 'Content-Type': 'application/json', 'TRON-PRO-API-KEY': headers['tron-pro-api-key'] ?? '' },
      signal: AbortSignal.timeout(30_000),
    }),
    record: event => fs.appendFileSync('/app/events/rpc.jsonl', JSON.stringify(event) + '\n'),
  });
  server.listen(4100, '0.0.0.0');
}
