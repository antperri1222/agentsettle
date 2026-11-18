import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import type { ChildProcess } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { createPublicClient, createWalletClient, http, parseTransaction, type PublicClient } from 'viem';
import { AgentSettleClient } from '../../sdk/client.ts';
import { deployLocal, devAccount, localChain, localPublicClient, startAnvil, type LocalDeployment } from '../../sdk/local.ts';
import { NETWORKS } from '../../sdk/networks.ts';
import { hashEvidence, parseUsdcUnits } from '../../sdk/terms.ts';

/**
 * Reproduces a wallet whose previous transaction is stuck at the same nonce: the node answers
 * "replacement transaction underpriced" (-32000) until the fee is high enough. The client must re-send with higher
 * fees and the job must be created exactly once.
 */
let anvil: ChildProcess;
let proxy: Server;
let d: LocalDeployment;
let rpcUrl: string;
let proxyUrl: string;
const sent: { maxFee: bigint; rejected: boolean }[] = [];
let rejectFirst = 0;

before(async () => {
  ({ proc: anvil, rpcUrl } = await startAnvil(20_000 + Math.floor(Math.random() * 20_000)));
  d = await deployLocal(rpcUrl);
  proxy = createServer(async (req, res) => {
    let body = '';
    for await (const c of req) body += c;
    const msg = JSON.parse(body);
    if (msg.method === 'eth_sendRawTransaction') {
      const tx = parseTransaction(msg.params[0]);
      const reject = rejectFirst > 0;
      sent.push({ maxFee: tx.maxFeePerGas ?? 0n, rejected: reject });
      if (reject) {
        rejectFirst--;
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, error: { code: -32000, message: 'replacement transaction underpriced' } }));
      }
    }
    const up = await fetch(rpcUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, body });
    res.writeHead(up.status, { 'content-type': 'application/json' });
    res.end(await up.text());
  });
  await new Promise<void>((r) => proxy.listen(0, '127.0.0.1', r));
  const a = proxy.address();
  proxyUrl = `http://127.0.0.1:${typeof a === 'object' && a ? a.port : 0}`;
});

after(() => { proxy?.close(); anvil?.kill(); });

test('a send rejected as "replacement transaction underpriced" is re-sent with higher fees and succeeds once', async () => {
  const chain = localChain(proxyUrl);
  const pub = createPublicClient({ chain, transport: http(proxyUrl, { retryCount: 0 }) }) as PublicClient;
  const owner = await AgentSettleClient.connect({
    network: NETWORKS.anvil, publicClient: pub, escrowAddress: d.escrow, expectedTokenAddress: d.token,
    wallet: createWalletClient({ account: devAccount('owner'), chain, transport: http(proxyUrl, { retryCount: 0 }) }),
  });
  await owner.approveSpend(parseUsdcUnits('1'));
  sent.length = 0;
  rejectFirst = 2; // two rejections → succeeds on the 3rd send (4x fees)
  const deadline = (await localPublicClient(rpcUrl).getBlock()).timestamp + 3600n;
  const { jobId, receipt } = await owner.createJob({ provider: d.roles.providerAgent, amount: parseUsdcUnits('1'), deadline, termsHash: hashEvidence('t'), idempotencyKey: 'stuck-tx-0001' });
  assert.equal(receipt?.stage, 'confirmed');
  assert.equal(sent.length, 3);
  assert.deepEqual(sent.map((s) => s.rejected), [true, true, false]);
  assert.ok(sent[1].maxFee > sent[0].maxFee && sent[2].maxFee > sent[1].maxFee, 'fees must escalate');
  assert.equal((await owner.getJob(jobId)).status, 'Funded');
  assert.equal(await owner.tokenBalance(d.escrow), parseUsdcUnits('1'), 'funded exactly once');
});

test('re-sending gives up after three fee bumps instead of looping forever', async () => {
  const chain = localChain(proxyUrl);
  const pub = createPublicClient({ chain, transport: http(proxyUrl, { retryCount: 0 }) }) as PublicClient;
  const owner = await AgentSettleClient.connect({
    network: NETWORKS.anvil, publicClient: pub, escrowAddress: d.escrow, expectedTokenAddress: d.token,
    wallet: createWalletClient({ account: devAccount('owner'), chain, transport: http(proxyUrl, { retryCount: 0 }) }),
  });
  sent.length = 0;
  rejectFirst = 5; // more rejections than retries allowed → gives up after 4 sends
  await assert.rejects(owner.approveSpend(parseUsdcUnits('1')), /underpriced/);
  assert.equal(sent.length, 4);
  rejectFirst = 0;
});
