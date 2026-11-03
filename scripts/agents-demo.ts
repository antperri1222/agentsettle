// Agent-to-agent demo with real signatures on local Anvil.
// Distinct keys: owner (human budget holder), buyerAgent, providerAgent, arbiter. No keys are read from prompts.
//
// Base Sepolia is intentionally NOT wired here yet: it requires a reviewed deployment and explicit authorization.
// See docs/RUNBOOK.md.
import { readFileSync } from 'node:fs';
import { AgentSettleClient, AgentSettleError, type TxReceipt } from '../sdk/client.ts';
import { devWallet, localPublicClient, type LocalDeployment, type LocalRole } from '../sdk/local.ts';
import { NETWORKS } from '../sdk/networks.ts';
import { formatUsdcUnits, hashEvidence, hashTerms, parseUsdcUnits } from '../sdk/terms.ts';

if ((process.env.AGENTSETTLE_NETWORK ?? 'anvil') !== 'anvil') {
  console.error('agents:demo only runs on local Anvil. Base Sepolia requires the runbook in docs/RUNBOOK.md.');
  process.exit(1);
}

let d: LocalDeployment;
try { d = JSON.parse(readFileSync(new URL('../.agentsettle/local.json', import.meta.url), 'utf8')); }
catch { console.error('Missing .agentsettle/local.json — run `npm run chain:up` first.'); process.exit(1); }

const pub = localPublicClient(d.rpcUrl);
const c = {} as Record<LocalRole, AgentSettleClient>;
for (const role of ['owner', 'buyerAgent', 'providerAgent', 'arbiter', 'stranger'] as const) {
  c[role] = await AgentSettleClient.connect({
    network: NETWORKS.anvil, publicClient: pub, escrowAddress: d.escrow, expectedTokenAddress: d.token,
    wallet: await devWallet(role, d.rpcUrl),
    onStage: (stage, info) => console.log(`    [${role}] ${info.action}: ${stage}${info.hash ? ' ' + info.hash : ''}`),
  });
}

const show = (r: TxReceipt) => console.log(`    ✓ ${r.action} confirmed in block ${r.blockNumber} · gas ${r.gasUsed} · ${Number(r.gasCostWei) / 1e18} ETH`);
const run = Date.now().toString(36);

console.log('\n1. Owner grants buyerAgent an on-chain budget: $10/job, $25/day, providerAgent allowlisted, 7 days');
const now = (await pub.getBlock()).timestamp;
show(await c.owner.setPolicy(d.roles.buyerAgent, parseUsdcUnits('10'), parseUsdcUnits('25'), now + 7n * 86_400n));
show(await c.owner.setProviderAllowed(d.roles.buyerAgent, d.roles.providerAgent, true));
show(await c.owner.approveSpend(parseUsdcUnits('25'))); // exact allowance, never unlimited

async function fund(amountStr: string, description: string, key: string) {
  const amount = parseUsdcUnits(amountStr);
  const deadline = (await pub.getBlock()).timestamp + 3600n;
  const termsHash = hashTerms({
    version: 'agentsettle.terms.v1', chainId: 31337, escrow: d.escrow, provider: d.roles.providerAgent,
    amountUnits: String(amount), deadline: Number(deadline), description, acceptanceCriteria: ['Structured markdown', 'Source links'],
  });
  const res = await c.buyerAgent.createJob({ owner: d.roles.owner, provider: d.roles.providerAgent, amount, deadline, termsHash, idempotencyKey: key });
  if (res.receipt) show(res.receipt);
  return res.jobId;
}

console.log('\n2. Happy path: buyerAgent funds $5 → providerAgent delivers → buyerAgent approves');
const j1 = await fund('5', 'Research three competitors in agent payments', `demo-${run}-1`);
show(await c.providerAgent.deliver(j1, hashEvidence(`report for job ${j1}: pricing, identity, settlement`)));
show(await c.buyerAgent.approve(j1));
const q = await c.owner.quote(parseUsdcUnits('5'));
console.log(`    provider net ${formatUsdcUnits(q.providerPayout)} · protocol fee ${formatUsdcUnits(q.protocolFee)}`);

console.log('\n3. Dispute path: $2 job, buyerAgent disputes delivery, arbiter refunds owner');
const j2 = await fund('2', 'Pull pricing data for 20 SaaS vendors', `demo-${run}-2`);
show(await c.providerAgent.deliver(j2, hashEvidence('only 4 of 20 vendors')));
show(await c.buyerAgent.dispute(j2));
show(await c.arbiter.resolve(j2, false));

console.log('\n4. Adversarial checks (rejected in simulation, never broadcast)');
const j3 = await fund('1', 'Open job for authorization probes', `demo-${run}-3`);
for (const [label, p] of [
  ['stranger tries to deliver', () => c.stranger.deliver(j3, hashEvidence('forged'))],
  ['providerAgent tries to approve its own work', () => c.providerAgent.approve(j3)],
  ['buyerAgent exceeds $10 per-job cap', () => fund('10.01', 'too big', `demo-${run}-4`)],
  ['buyerAgent retries job 1 with same key but new amount', () => fund('6', 'Research three competitors in agent payments', `demo-${run}-1`)],
] as const) {
  try { await p(); console.log(`    ✗ UNEXPECTED SUCCESS: ${label}`); process.exitCode = 1; }
  catch (e) { console.log(`    ✓ ${label} → ${e instanceof AgentSettleError ? e.code : (e as Error).message}`); }
}

console.log('\nFinal balances (mUSDC):');
for (const [k, a] of [['owner', d.roles.owner], ['providerAgent', d.roles.providerAgent], ['treasury', d.treasury], ['escrow', d.escrow], ['buyerAgent', d.roles.buyerAgent]] as const) {
  console.log(`    ${k.padEnd(14)} ${formatUsdcUnits(await c.owner.tokenBalance(a))}`);
}
console.log('\nOpen http://127.0.0.1:3000 → "On-chain" to see the indexed events.');
