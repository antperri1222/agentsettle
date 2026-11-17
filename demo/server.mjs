import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { DemoEngine } from './engine.mjs';
import { createChainView } from './chain.mjs';

const engine = new DemoEngine();
let chainViewPromise = null;
const chainView = () => (chainViewPromise ??= createChainView().catch((e) => ({ state: async () => ({ enabled: false, reason: `Chain view failed to load: ${e.message}` }) })));
const htmlPath = fileURLToPath(new URL('./public/index.html', import.meta.url));
const port = Number(process.env.PORT || 3000);
const host = '127.0.0.1'; // Explicitly local-only: demo is not authenticated.

const actions = {
  '/api/jobs': (data) => engine.createJob(data),
  '/api/deliver': (data) => engine.deliver(data.id, data),
  '/api/approve': (data) => engine.approve(data.id, data),
  '/api/dispute': (data) => engine.dispute(data.id, data),
  '/api/resolve': (data) => engine.resolve(data.id, data),
  '/api/refund-expired': (data) => engine.refundExpired(data.id, data),
  '/api/provider-refund': (data) => engine.providerRefund(data.id, data),
};

function respond(res, code, data) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  res.end(JSON.stringify(data));
}

createServer(async (req, res) => {
  try {
    if (req.method === 'GET' && req.url === '/') {
      const content = await readFile(htmlPath);
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; base-uri 'none'; form-action 'self'" });
      return res.end(content);
    }
    if (req.method === 'GET' && (req.url === '/client.js' || req.url === '/chain.js')) {
      const content = await readFile(fileURLToPath(new URL(`./public${req.url}`, import.meta.url)));
      res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
      return res.end(content);
    }
    if (req.method === 'GET' && req.url === '/api/state') return respond(res, 200, engine.view());
    // Read-only. There is intentionally no POST route that signs or submits chain transactions.
    if (req.method === 'GET' && req.url === '/api/chain/state') return respond(res, 200, await (await chainView()).state());
    if (req.method !== 'POST' || !actions[req.url]) return respond(res, 404, { error: 'Not found' });
    if (!(req.headers['content-type'] || '').startsWith('application/json')) return respond(res, 415, { error: 'Expected JSON content type' });
    let raw = '';
    for await (const chunk of req) {
      raw += chunk;
      if (raw.length > 10_000) return respond(res, 413, { error: 'Request too large' });
    }
    const payload = JSON.parse(raw);
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('Expected an object');
    actions[req.url](payload);
    return respond(res, 200, engine.view());
  } catch (e) {
    return respond(res, 400, { error: e instanceof Error ? e.message : 'Bad request' });
  }
}).listen(port, host, () => {
  const chainMode = process.env.AGENTSETTLE_NETWORK ? `On-chain tab: ${process.env.AGENTSETTLE_NETWORK} (read-only, no keys)` : "On-chain tab: local Anvil if running";
  console.log(`AgentSettle dashboard at http://${host}:${port} · Simulation tab: in-memory only · ${chainMode}`);
});
