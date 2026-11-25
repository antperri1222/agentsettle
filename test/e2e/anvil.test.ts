import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { ChildProcess } from 'node:child_process';
import type { Address } from 'viem';
import { AgentSettleClient, AgentSettleError } from '../../sdk/client.ts';
import { EscrowIndexer } from '../../sdk/indexer.ts';
import { deployLocal, devWallet, localPublicClient, startAnvil, type LocalDeployment, type LocalRole } from '../../sdk/local.ts';
import { NETWORKS } from '../../sdk/networks.ts';
import { hashEvidence, hashTerms, parseUsdcUnits } from '../../sdk/terms.ts';

/**
 * Real signed transactions against a throwaway Anvil chain. Requires Foundry's `anvil` binary.
 * Every party is a distinct private key; nothing is authorised by request bodies or IDs.
 */
let anvil: ChildProcess;
let d: LocalDeployment;
const clients = {} as Record<LocalRole, AgentSettleClient>;
let rpcUrl: string;
let keyN = 0;

const pub = () => localPublicClient(rpcUrl);
const key = () => `e2e-job-${Date.now()}-${++keyN}`;

async function deadline(secs = 3600): Promise<bigint> {
  const b = await pub().getBlock();
  return b.timestamp + BigInt(secs);
}

function terms(provider: Address, amount: bigint, dl: bigint, description: string) {
  return hashTerms({
    version: 'agentsettle.terms.v1', chainId: 31337, escrow: d.escrow, provider, amountUnits: String(amount),
    deadline: Number(dl), description, acceptanceCriteria: ['Markdown report', '>= 3 cited sources'],
  });
}

async function balances() {
  const c = clients.owner;
  const [owner, provider, treasury, escrow, agent] = await Promise.all([
    c.tokenBalance(d.roles.owner), c.tokenBalance(d.roles.providerAgent), c.tokenBalance(d.treasury),
    c.tokenBalance(d.escrow), c.tokenBalance(d.roles.buyerAgent),
  ]);
  return { owner, provider, treasury, escrow, agent, total: owner + provider + treasury + escrow + agent };
}

async function expectCode(p: Promise<unknown>, code: string) {
  await assert.rejects(p, (e: unknown) => e instanceof AgentSettleError && e.code === code);
}

async function fundJob(amount: bigint, description: string, idem = key()) {
  const dl = await deadline();
  const termsHash = terms(d.roles.providerAgent, amount, dl, description);
  return clients.buyerAgent.createJob({
    owner: d.roles.owner, provider: d.roles.providerAgent, arbiter: d.roles.arbiter, amount, deadline: dl, termsHash, idempotencyKey: idem,
  });
}

before(async () => {
  const port = 20_000 + Math.floor(Math.random() * 20_000);
  ({ proc: anvil, rpcUrl } = await startAnvil(port));
  d = await deployLocal(rpcUrl);
  for (const role of ['owner', 'buyerAgent', 'providerAgent', 'arbiter', 'stranger'] as const) {
    clients[role] = await AgentSettleClient.connect({
      network: NETWORKS.anvil, publicClient: pub(), escrowAddress: d.escrow, expectedTokenAddress: d.token,
      wallet: await devWallet(role, rpcUrl),
    });
  }
  // Owner (human) grants the buyer agent a bounded on-chain budget and an exact token allowance.
  const now = (await pub().getBlock()).timestamp;
  await clients.owner.setPolicy(d.roles.buyerAgent, parseUsdcUnits('10'), parseUsdcUnits('25'), now + 86_400n * 7n);
  await clients.owner.setProviderAllowed(d.roles.buyerAgent, d.roles.providerAgent, true);
  await clients.owner.setArbiterAllowed(d.roles.buyerAgent, d.roles.arbiter, true);
  await clients.owner.approveSpend(parseUsdcUnits('25'));
});

after(() => anvil?.kill());

describe('Anvil end-to-end (real signatures)', () => {
  test('connect guards: wrong network and wrong asset are refused', async () => {
    await expectCode(
      AgentSettleClient.connect({ network: NETWORKS['base-sepolia'], publicClient: pub(), escrowAddress: d.escrow }),
      'WrongNetwork',
    );
    await expectCode(
      AgentSettleClient.connect({ network: NETWORKS.anvil, publicClient: pub(), escrowAddress: d.escrow, expectedTokenAddress: d.roles.stranger }),
      'AssetMismatch',
    );
  });

  test('happy path: agent funds from owner budget, provider delivers, agent approves; exact fee split', async () => {
    const before = await balances();
    const amount = parseUsdcUnits('5');
    const { jobId, receipt } = await fundJob(amount, 'Competitive research brief');
    assert.ok(receipt && receipt.stage === 'confirmed' && receipt.gasUsed > 0n);
    assert.equal((await clients.owner.getJob(jobId)).status, 'Funded');
    assert.equal((await balances()).escrow - before.escrow, amount);

    const evidence = hashEvidence('# Brief\n...final deliverable bytes...');
    await clients.providerAgent.deliver(jobId, evidence);
    const job = await clients.owner.getJob(jobId);
    assert.equal(job.status, 'Delivered');
    assert.equal(job.evidenceHash, evidence);

    await clients.buyerAgent.approve(jobId);
    const afterB = await balances();
    assert.equal((await clients.owner.getJob(jobId)).status, 'Paid');
    assert.equal(afterB.provider - before.provider, 4_975_000n);
    assert.equal(afterB.treasury - before.treasury, 25_000n);
    assert.equal(afterB.agent, 0n, 'agent key never holds funds');
    assert.equal(afterB.total, before.total, 'conservation of balances');
  });

  test('no transfer can occur twice', async () => {
    const { jobId } = await fundJob(parseUsdcUnits('1'), 'Double-pay probe');
    await clients.providerAgent.deliver(jobId, hashEvidence('x'.repeat(20)));
    await clients.buyerAgent.approve(jobId);
    const b = await balances();
    await expectCode(clients.buyerAgent.approve(jobId), 'InvalidState');
    await expectCode(clients.owner.approve(jobId), 'InvalidState');
    await expectCode(clients.providerAgent.providerRefund(jobId), 'InvalidState');
    assert.deepEqual(await balances(), b);
  });

  test('unauthorized signers are rejected before broadcast', async () => {
    const { jobId } = await fundJob(parseUsdcUnits('1'), 'Authorization probe');
    await expectCode(clients.stranger.deliver(jobId, hashEvidence('forged delivery')), 'Forbidden');
    await expectCode(clients.buyerAgent.deliver(jobId, hashEvidence('buyer cannot deliver')), 'Forbidden');
    await clients.providerAgent.deliver(jobId, hashEvidence('legit delivery'));
    await expectCode(clients.providerAgent.approve(jobId), 'Forbidden');
    await expectCode(clients.stranger.approve(jobId), 'Forbidden');
    await expectCode(clients.stranger.resolve(jobId, true), 'Forbidden');
    await expectCode(clients.arbiter.resolve(jobId, true), 'InvalidState'); // not disputed
  });

  test('dispute -> arbiter refund returns full amount to owner', async () => {
    const before = await balances();
    const amount = parseUsdcUnits('2.5');
    const { jobId } = await fundJob(amount, 'Disputed data pull');
    await clients.providerAgent.deliver(jobId, hashEvidence('incomplete data'));
    await clients.buyerAgent.dispute(jobId);
    await expectCode(clients.buyerAgent.resolve(jobId, false), 'Forbidden');
    await clients.arbiter.resolve(jobId, false);
    const afterB = await balances();
    assert.equal(afterB.owner, before.owner);
    assert.equal(afterB.provider, before.provider);
    assert.equal(afterB.total, before.total);
  });

  test('missed deadline -> agent reclaims to owner', async () => {
    const before = await balances();
    const dl = await deadline(60);
    const amount = parseUsdcUnits('1');
    const { jobId } = await clients.buyerAgent.createJob({
      owner: d.roles.owner, provider: d.roles.providerAgent, arbiter: d.roles.arbiter, amount, deadline: dl,
      termsHash: terms(d.roles.providerAgent, amount, dl, 'Will expire'), idempotencyKey: key(),
    });
    await expectCode(clients.buyerAgent.refundExpired(jobId), 'DeadlineNotPassed');
    await pub().request({ method: 'evm_increaseTime' as any, params: [120] as any });
    await pub().request({ method: 'evm_mine' as any, params: [] as any });
    await expectCode(clients.providerAgent.deliver(jobId, hashEvidence('too late now')), 'DeadlinePassed');
    await clients.buyerAgent.refundExpired(jobId);
    assert.equal((await balances()).owner, before.owner);
  });

  test('idempotent retry returns the same job and funds once', async () => {
    const idem = key();
    const amount = parseUsdcUnits('0.5');
    const dl = await deadline();
    const args = { owner: d.roles.owner, provider: d.roles.providerAgent, arbiter: d.roles.arbiter, amount, deadline: dl,
      termsHash: terms(d.roles.providerAgent, amount, dl, 'Retry me'), idempotencyKey: idem };
    const first = await clients.buyerAgent.createJob(args);
    const escrowBal = (await balances()).escrow;
    const second = await clients.buyerAgent.createJob(args);
    assert.equal(second.jobId, first.jobId);
    assert.equal(second.reused, true);
    assert.equal((await balances()).escrow, escrowBal);
    await expectCode(clients.buyerAgent.createJob({ ...args, amount: amount + 1n }), 'IdempotencyConflict');
  });

  test('on-chain spend policy: per-job cap, allowlist, daily cap, revocation', async () => {
    await expectCode(fundJob(parseUsdcUnits('10.000001'), 'Over per-job cap'), 'PerJobCapExceeded');
    const dl = await deadline();
    await expectCode(
      clients.buyerAgent.createJob({ owner: d.roles.owner, provider: d.roles.stranger, arbiter: d.roles.arbiter, amount: 1n, deadline: dl,
        termsHash: terms(d.roles.stranger, 1n, dl, 'Not allowlisted'), idempotencyKey: key() }),
      'ProviderNotAllowed',
    );
    // Stranger has no policy from the owner.
    await expectCode(
      clients.stranger.createJob({ owner: d.roles.owner, provider: d.roles.providerAgent, arbiter: d.roles.arbiter, amount: 1n, deadline: dl,
        termsHash: terms(d.roles.providerAgent, 1n, dl, 'No policy'), idempotencyKey: key() }),
      'PolicyInactive',
    );
    // Daily cap 25: earlier tests spent 5+1+1+2.5+1+0.5 = 11 today. 10 more is fine, then 4.000001 exceeds.
    await clients.owner.approveSpend(parseUsdcUnits('25'));
    await fundJob(parseUsdcUnits('10'), 'Fill most of the day');
    await expectCode(fundJob(parseUsdcUnits('4.000001'), 'Over daily cap'), 'DailyCapExceeded');
    await clients.owner.revokePolicy(d.roles.buyerAgent);
    await expectCode(fundJob(1n, 'After revoke'), 'PolicyInactive');
  });

  test('indexer reconstructs state from events, matches storage, and records gas', async () => {
    const idx = new EscrowIndexer(pub(), NETWORKS.anvil, d.escrow, BigInt(d.deployBlock));
    await idx.poll();
    const jobs = idx.jobs();
    assert.equal(jobs.length, 7);
    assert.deepEqual(await idx.reconcile(), []);
    const paid = jobs.filter((j) => j.status === 'Paid');
    assert.ok(paid.length >= 2);
    for (const j of paid) {
      assert.equal(j.settled, true);
      assert.ok(BigInt(j.totalGasCostWei) > 0n);
      assert.ok(j.events.every((e) => e.finality === 'confirmed' && e.from));
    }
    assert.ok(jobs.every((j) => j.buyer === d.roles.owner && j.agent === d.roles.buyerAgent));
  });
});
