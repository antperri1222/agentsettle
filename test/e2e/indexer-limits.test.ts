import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import type { ChildProcess } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPublicClient, http, type PublicClient } from 'viem';
import { AgentSettleClient } from '../../sdk/client.ts';
import { EscrowIndexer } from '../../sdk/indexer.ts';
import { deployLocal, devWallet, localChain, localPublicClient, startAnvil, type LocalDeployment } from '../../sdk/local.ts';
import { NETWORKS } from '../../sdk/networks.ts';
import { hashEvidence, parseUsdcUnits } from '../../sdk/terms.ts';

/**
 * Reproduces Alchemy's free-tier behaviour (eth_getLogs limited to 10-block ranges, reported by viem as
 * "JSON is not a valid request object") with a proxy in front of Anvil, and checks that the indexer steps its
 * range down, catches up in windows, and resumes from its checkpoint instead of rescanning.
 */
let anvil: ChildProcess;
let proxy: Server;
let d: LocalDeployment;
let rpcUrl: string;
let proxyUrl: string;
let tmp: string;
const counts = { getLogs: 0, refused: 0, rateLimited: 0 };
let inject429 = false;

before(async () => {
  ({ proc: anvil, rpcUrl } = await startAnvil(20_000 + Math.floor(Math.random() * 20_000)));
  d = await deployLocal(rpcUrl);
  const owner = await AgentSettleClient.connect({ network: NETWORKS.anvil, publicClient: localPublicClient(rpcUrl), escrowAddress: d.escrow, expectedTokenAddress: d.token, wallet: await devWallet('owner', rpcUrl) });
  const provider = await AgentSettleClient.connect({ network: NETWORKS.anvil, publicClient: localPublicClient(rpcUrl), escrowAddress: d.escrow, expectedTokenAddress: d.token, wallet: await devWallet('providerAgent', rpcUrl) });
  const pub = localPublicClient(rpcUrl);
  const mine = (n: number) => pub.request({ method: 'anvil_mine' as any, params: [`0x${n.toString(16)}`] as any });
  await owner.approveSpend(parseUsdcUnits('3'));
  for (let i = 0; i < 3; i++) {
    await mine(40); // spread the jobs across many blocks
    const dl = (await pub.getBlock()).timestamp + 3600n;
    const { jobId } = await owner.createJob({ provider: d.roles.providerAgent, amount: parseUsdcUnits('1'), deadline: dl, termsHash: hashEvidence(`terms ${i}`), idempotencyKey: `limits-test-${i}-${Date.now()}` });
    await mine(25);
    await provider.deliver(jobId, hashEvidence(`work ${i}`));
    if (i !== 1) await owner.approve(jobId);
  }
  await mine(30);

  // Proxy that behaves like Alchemy free tier for eth_getLogs ranges wider than 10 blocks.
  proxy = createServer(async (req, res) => {
    let body = '';
    for await (const c of req) body += c;
    const msg = JSON.parse(body);
    if (msg.method === 'eth_getLogs') {
      counts.getLogs++;
      if (inject429 && counts.getLogs % 3 === 0) {
        counts.rateLimited++;
        res.writeHead(429, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, error: { code: 429, message: 'Your app has exceeded its compute units per second capacity.' } }));
      }
      const { fromBlock, toBlock } = msg.params[0];
      if (BigInt(toBlock) - BigInt(fromBlock) + 1n > 10n) {
        counts.refused++;
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, error: { code: -32600, message: 'JSON is not a valid request object' } }));
      }
    }
    const upstream = await fetch(rpcUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, body });
    res.writeHead(upstream.status, { 'content-type': 'application/json' });
    res.end(await upstream.text());
  });
  await new Promise<void>((r) => proxy.listen(0, '127.0.0.1', r));
  const addr = proxy.address();
  proxyUrl = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
  tmp = mkdtempSync(join(tmpdir(), 'agentsettle-idx-'));
});

after(() => { anvil?.kill(); proxy?.close(); if (tmp) rmSync(tmp, { recursive: true, force: true }); });

const limitedClient = () => createPublicClient({ chain: localChain(proxyUrl), transport: http(proxyUrl, { retryCount: 0 }) }) as PublicClient;

test('indexer steps down to 10-block ranges, catches up in windows, and matches an unrestricted index', async () => {
  const direct = new EscrowIndexer(localPublicClient(rpcUrl), NETWORKS.anvil, d.escrow, BigInt(d.deployBlock));
  await direct.sync();
  const expected = direct.jobs().map((j) => [j.id, j.status, j.settled, j.events.length]);
  assert.equal(expected.length, 3);

  const file = join(tmp, 'checkpoint.json');
  const limited = new EscrowIndexer(limitedClient(), NETWORKS.anvil, d.escrow, BigInt(d.deployBlock), { checkpointFile: file, maxBlocksPerPoll: 60n });
  await limited.poll();
  assert.equal(limited.status().syncing, true, 'first window should not reach the head');
  assert.ok(counts.refused >= 1, 'the proxy must have refused the wide range');
  assert.equal(limited.status().blockRange, '10');
  await limited.sync();
  assert.equal(limited.status().syncing, false);
  assert.equal(limited.status().percent, 100);
  assert.deepEqual(limited.jobs().map((j) => [j.id, j.status, j.settled, j.events.length]), expected);
  assert.deepEqual(await limited.reconcile(), []);
  assert.ok(limited.jobs().every((j) => BigInt(j.totalGasCostWei) > 0n));

  // A fresh instance resumes from the checkpoint: no rescan from the deploy block.
  const resumed = new EscrowIndexer(limitedClient(), NETWORKS.anvil, d.escrow, BigInt(d.deployBlock), { checkpointFile: file });
  await resumed.poll();
  assert.ok(resumed.logRequests <= 1, `expected at most one small catch-up request, got ${resumed.logRequests}`);
  assert.deepEqual(resumed.jobs().map((j) => [j.id, j.status, j.settled, j.events.length]), expected);

  // A checkpoint for a different contract is ignored.
  const other = new EscrowIndexer(limitedClient(), NETWORKS.anvil, d.token, BigInt(d.deployBlock), { checkpointFile: file, maxBlocksPerPoll: 1_000n });
  await other.poll();
  assert.equal(other.jobs().length, 0);
});

test('indexer absorbs rate limiting (HTTP 429) with backoff instead of failing or shrinking ranges wrongly', async () => {
  const direct = new EscrowIndexer(localPublicClient(rpcUrl), NETWORKS.anvil, d.escrow, BigInt(d.deployBlock));
  await direct.sync();
  inject429 = true;
  try {
    const idx = new EscrowIndexer(limitedClient(), NETWORKS.anvil, d.escrow, BigInt(d.deployBlock), {
      blockRange: 10n, maxBlocksPerPoll: 60n, requestsPerSecond: 200, backoffMs: 5,
    });
    await idx.sync();
    assert.ok(idx.rateLimitHits > 0, 'the proxy should have rate-limited some requests');
    assert.equal(idx.status().syncing, false);
    assert.equal(idx.status().blockRange, '10');
    assert.deepEqual(idx.jobs().map((j) => [j.id, j.status, j.events.length]), direct.jobs().map((j) => [j.id, j.status, j.events.length]));
    assert.deepEqual(await idx.reconcile(), []);
  } finally { inject429 = false; }
});

test('pacing spaces requests to the configured rate', async () => {
  const idx = new EscrowIndexer(localPublicClient(rpcUrl), NETWORKS.anvil, d.escrow, BigInt(d.deployBlock), {
    blockRange: 10n, maxBlocksPerPoll: 100n, requestsPerSecond: 50, concurrency: 4,
  });
  const t0 = Date.now();
  await idx.poll();
  const elapsed = Date.now() - t0;
  // >= (requests - 1) * 20ms regardless of concurrency
  assert.ok(elapsed >= (idx.logRequests - 1) * 20 - 5, `elapsed ${elapsed}ms for ${idx.logRequests} requests`);
});
