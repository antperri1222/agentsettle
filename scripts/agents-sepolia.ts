// Base Sepolia TESTNET milestone run with real wallet signatures from Foundry keystores.
//
//   npm run agents:sepolia            → preflight only (reads balances, checks config; sends nothing)
//   npm run agents:sepolia -- --run   → executes the milestone scenario (spends testnet ETH + test USDC)
//
// Keys are decrypted from ~/.foundry/keystores by `cast` at run time and kept in memory only.
import { mkdirSync, writeFileSync } from 'node:fs';
import { createPublicClient, createWalletClient, formatEther, getAddress, http, type Address, type PublicClient } from 'viem';
import { baseSepolia } from 'viem/chains';
import { AgentSettleClient, AgentSettleError, type TxReceipt } from '../sdk/client.ts';
import { loadKeystoreAccount } from '../sdk/keystore.ts';
import { NETWORKS } from '../sdk/networks.ts';
import { formatUsdcUnits, hashEvidence, hashTerms, parseUsdcUnits } from '../sdk/terms.ts';

const RUN = process.argv.includes('--run');
const network = NETWORKS['base-sepolia'];
const env = process.env;

function need(name: string): string {
  const v = env[name];
  if (!v) { console.error(`Missing ${name} in .env (see docs/RUNBOOK.md §3)`); process.exit(1); }
  return v;
}

const rpcUrl = env.BASE_SEPOLIA_RPC_URL || network.defaultRpcUrl;
if (!env.BASE_SEPOLIA_RPC_URL) console.warn('⚠ BASE_SEPOLIA_RPC_URL not set; using the rate-limited public RPC.');
const escrow = getAddress(need('ESCROW_ADDRESS'));
const pub = createPublicClient({ chain: baseSepolia, transport: http(rpcUrl) }) as PublicClient;

// Role → keystore name. The deployer key doubles as the "unauthorized stranger" for adversarial checks.
const ROLES = {
  owner: 'agentsettle-owner',
  buyerAgent: 'agentsettle-buyer-agent',
  providerAgent: 'agentsettle-provider-agent',
  arbiter: 'agentsettle-arbiter',
  stranger: 'agentsettle-deployer',
} as const;
type Role = keyof typeof ROLES;

// Small, explicit testnet limits.
const POLICY = { perJob: parseUsdcUnits('2'), daily: parseUsdcUnits('5') };
const JOB_RELEASE = parseUsdcUnits('1');
const JOB_REFUND = parseUsdcUnits('0.5');
const MIN_ETH = 100_000_000_000_000n; // 0.0001 ETH per signer: well above Base Sepolia costs for this run

console.log(`Base Sepolia milestone · escrow ${escrow} · ${RUN ? 'EXECUTE' : 'PREFLIGHT ONLY'}`);
const c = {} as Record<Role, AgentSettleClient>;
const addr = {} as Record<Role, Address>;
for (const role of Object.keys(ROLES) as Role[]) {
  const account = loadKeystoreAccount(ROLES[role]);
  addr[role] = account.address;
  const expected = { owner: env.OWNER_ADDRESS, buyerAgent: env.BUYER_AGENT_ADDRESS, providerAgent: env.PROVIDER_AGENT_ADDRESS }[role as string];
  if (expected && getAddress(expected) !== account.address) {
    console.error(`${role} keystore address ${account.address} ≠ ${role.toUpperCase()}_ADDRESS in .env`); process.exit(1);
  }
  const wallet = createWalletClient({ account, chain: baseSepolia, transport: http(rpcUrl) });
  c[role] = await AgentSettleClient.connect({
    network, publicClient: pub, escrowAddress: escrow, wallet,
    onStage: (stage, i) => { if (stage === 'broadcast') console.log(`    [${role}] ${i.action} broadcast ${i.hash}`); },
  });
}

// ── preflight ──
console.log('\nPreflight');
let ok = true;
for (const role of ['owner', 'buyerAgent', 'providerAgent', 'arbiter'] as Role[]) {
  const eth = await pub.getBalance({ address: addr[role] });
  const good = eth >= MIN_ETH;
  ok &&= good;
  console.log(`  ${good ? '✓' : '✗'} ${role.padEnd(14)} ${addr[role]}  ${formatEther(eth)} ETH`);
}
const ownerUsdc = await c.owner.tokenBalance(addr.owner);
const usdcOk = ownerUsdc >= JOB_RELEASE + JOB_REFUND;
ok &&= usdcOk;
console.log(`  ${usdcOk ? '✓' : '✗'} owner test USDC  ${formatUsdcUnits(ownerUsdc)} (need ≥ ${formatUsdcUnits(JOB_RELEASE + JOB_REFUND)})`);
console.log(`  ✓ chain 84532, escrow settles in verified USDC ${c.owner.token}`);
if (!ok) { console.error('\nPreflight failed: fund the ✗ addresses from a faucet and retry.'); process.exit(1); }
if (!RUN) { console.log('\nPreflight passed. Nothing was sent. Re-run with `-- --run` to execute.'); process.exit(0); }

// ── execute ──
const receipts: TxReceipt[] = [];
const results: { check: string; result: string }[] = [];
const show = (r: TxReceipt) => { receipts.push(r); console.log(`    ✓ ${r.action} · block ${r.blockNumber} · gas ${r.gasUsed} · ${formatEther(r.gasCostWei)} ETH\n      ${r.explorerUrl}`); };
const runId = Date.now().toString(36);

async function fund(amount: bigint, description: string, key: string) {
  const deadline = (await pub.getBlock()).timestamp + 24n * 3600n;
  const termsHash = hashTerms({
    version: 'agentsettle.terms.v1', chainId: network.chainId, escrow, provider: addr.providerAgent,
    amountUnits: String(amount), deadline: Number(deadline), description, acceptanceCriteria: ['Markdown report'],
  });
  const r = await c.buyerAgent.createJob({ owner: addr.owner, provider: addr.providerAgent, amount, deadline, termsHash, idempotencyKey: key });
  if (r.receipt) show(r.receipt);
  return r.jobId;
}

async function expectReject(check: string, fn: () => Promise<unknown>, code: string) {
  try { await fn(); results.push({ check, result: 'UNEXPECTED SUCCESS' }); console.log(`    ✗ ${check}: UNEXPECTED SUCCESS`); process.exitCode = 1; }
  catch (e) {
    const got = e instanceof AgentSettleError ? e.code : (e as Error).message;
    const pass = got === code;
    if (!pass) process.exitCode = 1;
    results.push({ check, result: got });
    console.log(`    ${pass ? '✓' : '✗'} ${check} → ${got}${pass ? '' : ` (expected ${code})`}`);
  }
}

const before = {
  owner: await c.owner.tokenBalance(addr.owner), provider: await c.owner.tokenBalance(addr.providerAgent),
  escrow: await c.owner.tokenBalance(escrow),
};

console.log('\n1. Owner sets on-chain budget for buyerAgent ($2/job, $5/day, providerAgent only, 7 days) + exact allowance');
const now = (await pub.getBlock()).timestamp;
show(await c.owner.setPolicy(addr.buyerAgent, POLICY.perJob, POLICY.daily, now + 7n * 86_400n));
show(await c.owner.setProviderAllowed(addr.buyerAgent, addr.providerAgent, true));
show(await c.owner.approveSpend(JOB_RELEASE + JOB_REFUND));

console.log(`\n2. Release path: $${formatUsdcUnits(JOB_RELEASE)} job → provider delivers → buyerAgent approves`);
const jobA = await fund(JOB_RELEASE, 'Testnet milestone: release path', `sepolia-${runId}-A`);
await expectReject('stranger (deployer key) tries to deliver', () => c.stranger.deliver(jobA, hashEvidence('forged')), 'Forbidden');
show(await c.providerAgent.deliver(jobA, hashEvidence(`deliverable for job ${jobA}`)));
await expectReject('providerAgent tries to approve its own work', () => c.providerAgent.approve(jobA), 'Forbidden');
show(await c.buyerAgent.approve(jobA));
await expectReject('buyerAgent approves a second time', () => c.buyerAgent.approve(jobA), 'InvalidState');
await expectReject('providerAgent refunds after payment', () => c.providerAgent.providerRefund(jobA), 'InvalidState');

console.log(`\n3. Refund path: $${formatUsdcUnits(JOB_REFUND)} job → delivered → buyerAgent disputes → arbiter refunds owner`);
const jobB = await fund(JOB_REFUND, 'Testnet milestone: dispute/refund path', `sepolia-${runId}-B`);
show(await c.providerAgent.deliver(jobB, hashEvidence(`incomplete deliverable for job ${jobB}`)));
show(await c.buyerAgent.dispute(jobB));
await expectReject('buyerAgent tries to resolve its own dispute', () => c.buyerAgent.resolve(jobB, false), 'Forbidden');
show(await c.arbiter.resolve(jobB, false));
await expectReject('arbiter resolves a second time', () => c.arbiter.resolve(jobB, true), 'InvalidState');
await expectReject('buyerAgent exceeds $2 per-job cap', () => fund(parseUsdcUnits('2.01'), 'too big', `sepolia-${runId}-C`), 'PerJobCapExceeded');

const after = {
  owner: await c.owner.tokenBalance(addr.owner), provider: await c.owner.tokenBalance(addr.providerAgent),
  escrow: await c.owner.tokenBalance(escrow),
};
const q = await c.owner.quote(JOB_RELEASE);
const conserved = before.owner - after.owner === q.providerPayout + q.protocolFee && after.provider - before.provider === q.providerPayout && after.escrow === before.escrow;
if (!conserved) process.exitCode = 1;
console.log(`\nBalances: owner −${formatUsdcUnits(before.owner - after.owner)} · provider +${formatUsdcUnits(after.provider - before.provider)} · fee ${formatUsdcUnits(q.protocolFee)} · escrow Δ ${formatUsdcUnits(after.escrow - before.escrow)}  ${conserved ? '✓ conserved' : '✗ MISMATCH'}`);

const total = receipts.reduce((n, r) => n + r.gasCostWei, 0n);
const settlement = receipts.filter((r) => ['createJobAsAgent', 'deliver', 'approve'].includes(r.action)).slice(0, 3);
console.log(`Gas: ${receipts.length} txs · ${formatEther(total)} ETH total · release-path settlement (create+deliver+approve) ${formatEther(settlement.reduce((n, r) => n + r.gasCostWei, 0n))} ETH`);

mkdirSync(new URL('../.agentsettle/sepolia-runs/', import.meta.url), { recursive: true });
const out = new URL(`../.agentsettle/sepolia-runs/${runId}.json`, import.meta.url);
writeFileSync(out, JSON.stringify({ network: network.name, escrow, jobs: { release: String(jobA), refund: String(jobB) }, addresses: addr, results, conserved,
  receipts: receipts.map((r) => ({ ...r, blockNumber: String(r.blockNumber), gasUsed: String(r.gasUsed), effectiveGasPrice: String(r.effectiveGasPrice), gasCostWei: String(r.gasCostWei) })) }, null, 2));
console.log(`Receipt log: .agentsettle/sepolia-runs/${runId}.json`);
console.log(process.exitCode ? '\n✗ Milestone checks FAILED — see above.' : '\n✓ Milestone checks passed.');
