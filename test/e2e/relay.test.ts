import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import type { ChildProcess } from 'node:child_process';
import type { Server } from 'node:http';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { keccak256, toBytes, type Hex } from 'viem';
import { AgentSettleClient } from '../../sdk/client.ts';
import { devAccount, deployLocal, devWallet, localPublicClient, startAnvil, type LocalDeployment, type LocalRole } from '../../sdk/local.ts';
import { NETWORKS } from '../../sdk/networks.ts';
import { RelayClient, RelayError, uploadMessage } from '../../sdk/relay.ts';
import { canonicalTerms, hashEvidence, hashTerms, parseUsdcUnits, type TaskTermsV1 } from '../../sdk/terms.ts';
import { createRelay } from '../../relay/server.ts';
import { createChainView } from '../../demo/chain.mjs';
import { NETWORKS as NETS, confirmationsFor } from '../../sdk/networks.ts';

let anvil: ChildProcess;
let relay: Server;
let relayUrl: string;
let d: LocalDeployment;
let tmp: string;
let jobId: bigint;
let termsText: string;
let termsHash: Hex;
const rc = (role: LocalRole) => new RelayClient({ url: relayUrl, account: devAccount(role), chainId: 31337, escrow: d.escrow });

before(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'agentsettle-relay-'));
  let rpcUrl: string;
  ({ proc: anvil, rpcUrl } = await startAnvil(20_000 + Math.floor(Math.random() * 20_000)));
  d = await deployLocal(rpcUrl);
  relay = createRelay({ network: 'anvil', rpcUrl, escrow: d.escrow, dataDir: tmp, uploadsPerMinute: 1000 });
  await new Promise<void>((r) => relay.listen(0, '127.0.0.1', r));
  const a = relay.address();
  relayUrl = `http://127.0.0.1:${typeof a === 'object' && a ? a.port : 0}`;

  const owner = await AgentSettleClient.connect({ network: NETWORKS.anvil, publicClient: localPublicClient(rpcUrl), escrowAddress: d.escrow, expectedTokenAddress: d.token, wallet: await devWallet('owner', rpcUrl) });
  await owner.approveSpend(parseUsdcUnits('1'));
  const deadline = (await localPublicClient(rpcUrl).getBlock()).timestamp + 3600n;
  const terms: TaskTermsV1 = { version: 'agentsettle.terms.v1', chainId: 31337, escrow: d.escrow, provider: d.roles.providerAgent, amountUnits: '1000000', deadline: Number(deadline), description: 'Relay test task', acceptanceCriteria: ['exists'] };
  termsText = canonicalTerms(terms);
  termsHash = hashTerms(terms);
  assert.equal(await rc('owner').put(termsText), termsHash);
  ({ jobId } = await owner.createJob({ provider: d.roles.providerAgent, amount: parseUsdcUnits('1'), deadline, termsHash, idempotencyKey: 'relay-test-0001' }));
});

after(() => { relay?.close(); anvil?.kill(); if (tmp) rmSync(tmp, { recursive: true, force: true }); });

test('parties (buyer, provider, arbiter) can read job files; strangers cannot', async () => {
  assert.equal(await rc('owner').getForJob(jobId, 'terms', termsHash), termsText);
  assert.equal(await rc('providerAgent').getForJob(jobId, 'terms', termsHash), termsText);
  assert.equal(await rc('arbiter').getForJob(jobId, 'terms', termsHash), termsText);
  await assert.rejects(rc('stranger').getForJob(jobId, 'terms', termsHash), (e: unknown) => e instanceof RelayError && e.status === 403);
  assert.equal(await rc('stranger').getForJob(999n, 'terms', termsHash), null, 'unknown job → 404 → null');
});

test('deliverable becomes readable only once its hash is recorded on-chain', async () => {
  const content = '# Delivered work';
  const hash = await rc('providerAgent').put(content);
  assert.equal(await rc('owner').getForJob(jobId, 'deliverable', hash), null, 'nothing on-chain yet → 404 → null');
  const provider = await AgentSettleClient.connect({ network: NETWORKS.anvil, publicClient: localPublicClient(JSON.parse(JSON.stringify(d)).rpcUrl), escrowAddress: d.escrow, expectedTokenAddress: d.token, wallet: await devWallet('providerAgent', d.rpcUrl) });
  await provider.deliver(jobId, hashEvidence(content));
  assert.equal(await rc('owner').getForJob(jobId, 'deliverable', hash), content);
});

test('a tampered relay is caught by the client', async () => {
  writeFileSync(join(tmp, 'blobs', termsHash.toLowerCase()), termsText.replace('Relay test task', 'Pay me double'));
  await assert.rejects(rc('owner').getForJob(jobId, 'terms', termsHash), /does not match the on-chain hash/);
  writeFileSync(join(tmp, 'blobs', termsHash.toLowerCase()), termsText);
});

test('uploads are validated: hash must match body, signature fresh and valid, size limited', async () => {
  const body = 'hello relay';
  const hash = keccak256(toBytes(body));
  const ts = Math.floor(Date.now() / 1000);
  const sig = await devAccount('stranger').signMessage({ message: uploadMessage(31337, d.escrow, hash, ts) });
  const put = (h: string, b: string, t: number, s: string) => fetch(`${relayUrl}/v1/blobs/${h}`, { method: 'PUT', headers: { 'x-agentsettle-timestamp': String(t), 'x-agentsettle-signature': s }, body: b });

  assert.equal((await put(hash, 'different body', ts, sig)).status, 400);
  assert.equal((await put(hash, body, ts - 3600, sig)).status, 401, 'stale timestamp');
  assert.equal((await put(hash, body, ts, '0x1234')).status, 401, 'garbage signature');
  assert.equal((await put(hash, body, ts, sig)).status, 200);
  await assert.rejects(rc('stranger').put('x'.repeat(256 * 1024 + 1)), (e: unknown) => e instanceof RelayError && e.status === 413);
});

test('relay serves a shared event index; the dashboard reads jobs from it instead of scanning the chain', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agentsettle-relay-idx-'));
  const idxRelay = createRelay({ network: 'anvil', rpcUrl: d.rpcUrl, escrow: d.escrow, dataDir: dir, index: { deployBlock: BigInt(d.deployBlock), pollMs: 100 } });
  await new Promise<void>((r) => idxRelay.listen(0, '127.0.0.1', r));
  const a = idxRelay.address();
  const url = `http://127.0.0.1:${typeof a === 'object' && a ? a.port : 0}`;
  try {
    let idx: any;
    for (let i = 0; i < 100; i++) {
      idx = await (await fetch(`${url}/v1/index`)).json();
      if (idx.jobs?.length && !idx.sync.syncing) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    const job = idx.jobs.find((j: any) => BigInt(j.id) === jobId);
    assert.ok(job, 'job indexed');
    assert.equal(job.status, 'Delivered'); // delivered by the earlier test
    assert.equal(idx.chainId, 31337);
    const health = await (await fetch(`${url}/health`)).json();
    assert.equal(health.indexing.syncing, false);
    assert.equal(health.indexing.percent, 100);
    // Live lag (head moved on since the last poll, newest blocks not yet confirmed) is not "catching up".
    for (let i = 0; i < 3; i++) await fetch(d.rpcUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'evm_mine', params: [] }) });
    await new Promise((r) => setTimeout(r, 300));
    assert.equal((await (await fetch(`${url}/v1/index`)).json()).sync.syncing, false, 'live lag must not show as syncing');
    // Root URL explains what the relay is instead of a bare 404.
    const root = await fetch(`${url}/`);
    assert.equal(root.status, 200);
    assert.match(await root.text(), /AgentSettle relay[\s\S]*\/v1\/index/);

    // Dashboard pointed at the relay: jobs come from the relay index, not a local scan.
    const localFile = join(dir, 'local.json');
    writeFileSync(localFile, JSON.stringify(d));
    const view = await createChainView({ AGENTSETTLE_NETWORK: 'anvil', AGENTSETTLE_LOCAL_FILE: localFile, AGENTSETTLE_RELAY_URL: url } as any);
    let st: any;
    for (let i = 0; i < 50; i++) {
      st = await view.state();
      if (st.enabled) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    assert.equal(st.enabled, true, JSON.stringify(st));
    assert.match(st.indexSource, /^relay/);
    assert.equal(st.jobs.find((j: any) => BigInt(j.id) === jobId)?.status, 'Delivered');
  } finally {
    idxRelay.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('confirmation threshold is time-based: ~5 s of 200 ms Base blocks', () => {
  assert.equal(confirmationsFor(5, 200), 25);
  assert.equal(NETS['base-sepolia'].confirmations, 25);
  assert.equal(confirmationsFor(0.1, 1000), 1);
});
