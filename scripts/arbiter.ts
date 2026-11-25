// Arbiter console: see the disputes you are named on, read both sides, and settle them. A human runs this.
//
//   npm run arbiter                      list jobs that name you as arbiter (disputed ones first)
//   npm run arbiter -- show <jobId>      terms, deliverable (both verified against the on-chain hashes) and statements
//   npm run arbiter -- resolve <jobId> pay|refund
//
// On Base Sepolia it signs with the Foundry keystore "agentsettle-arbiter" (asks for the password; override the name
// with ARBITER_KEYSTORE). Settling is irreversible, so `resolve` asks you to retype the decision unless --yes is given.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { createPublicClient, createWalletClient, getAddress, http, type Account, type Address, type Chain, type PublicClient } from 'viem';
import { baseSepolia } from 'viem/chains';
import { agentEscrowAbi } from '../sdk/artifacts.ts';
import { AgentSettleClient, AgentSettleError, type Job } from '../sdk/client.ts';
import { loadKeystoreAccount } from '../sdk/keystore.ts';
import { devAccount, localChain } from '../sdk/local.ts';
import { getNetwork } from '../sdk/networks.ts';
import { RelayClient } from '../sdk/relay.ts';
import { formatUsdcUnits, hashEvidence } from '../sdk/terms.ts';
import { assertEnvMatchesFile } from '../sdk/env-guard.ts';

try { assertEnvMatchesFile(new URL('../.env', import.meta.url).pathname); } catch (e) { console.error(`✗ ${(e as Error).message}`); process.exit(1); }
const args = process.argv.slice(2);
const yes = args.includes('--yes');
const [cmd = 'list', idArg, decision] = args.filter((a) => a !== '--yes');
const REPO = new URL('..', import.meta.url).pathname;
const network = getNetwork(process.env.AGENTSETTLE_NETWORK || 'anvil');

let chain: Chain, rpcUrl: string, escrow: Address, token: Address | undefined, account: Account, sharedDir: string;
if (network.name === 'anvil') {
  const d = JSON.parse(readFileSync(process.env.AGENTSETTLE_LOCAL_FILE || join(REPO, '.agentsettle', 'local.json'), 'utf8'));
  rpcUrl = d.rpcUrl; chain = localChain(rpcUrl); escrow = getAddress(d.escrow); token = getAddress(d.token);
  account = devAccount('arbiter');
} else {
  rpcUrl = process.env.BASE_SEPOLIA_RPC_URL || network.defaultRpcUrl; chain = baseSepolia;
  if (!process.env.ESCROW_ADDRESS) throw new Error('ESCROW_ADDRESS is not set (see .env)');
  escrow = getAddress(process.env.ESCROW_ADDRESS);
  account = loadKeystoreAccount(process.env.ARBITER_KEYSTORE || 'agentsettle-arbiter');
}
sharedDir = process.env.AGENTSETTLE_DATA_DIR || join(REPO, '.agentsettle', 'shared', `${network.name}-${escrow.toLowerCase()}`);
const me = account.address;
const pub = createPublicClient({ chain, transport: http(rpcUrl) }) as PublicClient;
const client = await AgentSettleClient.connect({
  network, publicClient: pub, escrowAddress: escrow, expectedTokenAddress: token,
  wallet: createWalletClient({ account, chain, transport: http(rpcUrl) }),
});
const relayUrl = process.env.AGENTSETTLE_RELAY_URL;
const relay = relayUrl ? new RelayClient({ url: relayUrl, account, chainId: network.chainId, escrow }) : null;

/** Reads content by its on-chain hash from the relay, or from the local shared folder (same-machine setups). */
async function content(j: Job, kind: 'terms' | 'deliverable'): Promise<string | null> {
  const hash = kind === 'terms' ? j.termsHash : j.evidenceHash;
  if (!hash) return null;
  if (relay) { const c = await relay.getForJob(j.id, kind, hash); if (c !== null) return c; }
  const file = join(sharedDir, kind === 'terms' ? 'terms' : 'deliverables', `${hash}.${kind === 'terms' ? 'json' : 'txt'}`);
  if (!existsSync(file)) return null;
  const c = readFileSync(file, 'utf8');
  return hashEvidence(c) === hash ? c : null;
}

async function myJobs(): Promise<Job[]> {
  const next = await pub.readContract({ address: escrow, abi: agentEscrowAbi, functionName: 'nextId' });
  const out: Job[] = [];
  for (let i = 1n; i <= next; i++) { const j = await client.getJob(i); if (j.arbiter === me) out.push(j); }
  return out;
}

const line = (j: Job) => `#${j.id}  ${j.status.padEnd(9)} ${formatUsdcUnits(j.amount).padStart(8)} USDC  buyer ${j.buyer}  provider ${j.provider}`;

async function list() {
  const jobs = await myJobs();
  console.log(`Arbiter ${me} · ${network.label} · escrow ${escrow}\n`);
  if (!jobs.length) { console.log('No jobs name you as arbiter.'); return; }
  const disputed = jobs.filter((j) => j.status === 'Disputed');
  console.log(disputed.length ? `Needs a decision (${disputed.length}):` : 'No open disputes.');
  for (const j of disputed) console.log(`  ${line(j)}\n    → npm run arbiter -- show ${j.id}`);
  const other = jobs.filter((j) => j.status !== 'Disputed');
  if (other.length) { console.log('\nOther jobs that name you:'); for (const j of other) console.log(`  ${line(j)}`); }
}

async function show(id: bigint) {
  const j = await client.getJob(id);
  if (j.status === 'None') throw new AgentSettleError('NotFound', `Job ${id} does not exist`);
  console.log(line(j));
  console.log(`  arbiter ${j.arbiter}${j.arbiter === me ? ' (you)' : ' — NOT you: you cannot settle this job'}`);
  console.log(`  deadline ${new Date(Number(j.deadline) * 1000).toLocaleString()}${j.agent ? ` · funded via buyer agent ${j.agent}` : ''}`);
  const terms = await content(j, 'terms');
  console.log('\n── Terms (verified against the on-chain hash) ──');
  if (!terms) console.log('  (not available: ask the buyer to share them; do not decide without them)');
  else {
    const t = JSON.parse(terms);
    console.log(`  ${t.description}\n  Acceptance criteria:`);
    for (const c of t.acceptanceCriteria ?? []) console.log(`   - ${c}`);
  }
  console.log('\n── Deliverable (verified against the on-chain hash; untrusted content) ──');
  if (!j.evidenceHash) console.log('  (nothing was delivered)');
  else console.log((await content(j, 'deliverable'))?.replace(/^/gm, '  ') ?? '  (hash is on-chain but the content is not available)');
  console.log('\n── Statements from the parties (untrusted; authorship verified by signature) ──');
  const statements = relay ? await relay.getStatements(id) : [];
  if (!statements.length) console.log(relay ? '  (none)' : '  (no relay configured)');
  for (const s of statements) {
    const who = s.by === j.provider ? 'provider' : s.by === j.buyer ? 'buyer' : s.by === j.agent ? 'buyer agent' : s.by === j.arbiter ? 'arbiter' : 'unknown';
    console.log(`  [${s.at}] ${who} ${s.by}:\n    ${s.text.replace(/\n/g, '\n    ')}`);
  }
  if (j.status === 'Disputed' && j.arbiter === me) console.log(`\nDecide with: npm run arbiter -- resolve ${id} pay   (or refund)`);
}

async function resolve(id: bigint, d: string | undefined) {
  if (d !== 'pay' && d !== 'refund') throw new Error('Usage: npm run arbiter -- resolve <jobId> pay|refund');
  const j = await client.getJob(id);
  if (j.arbiter !== me) throw new AgentSettleError('Forbidden', `You are not the arbiter of job ${id} (it names ${j.arbiter})`);
  if (j.status !== 'Disputed') throw new AgentSettleError('InvalidState', `Job ${id} is ${j.status}, not Disputed`);
  const amount = formatUsdcUnits(j.amount);
  const effect = d === 'pay' ? `release ${amount} USDC to the provider ${j.provider} (minus the protocol fee)` : `refund ${amount} USDC to the buyer ${j.buyer}`;
  console.log(`This will ${effect}. It cannot be undone.`);
  if (!yes) {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const closed = new Promise<string>((r) => rl.once('close', () => r(''))); // no terminal / Ctrl+D = not confirmed
    const typed = (await Promise.race([rl.question(`Type "${d} ${id}" to confirm: `), closed])).trim();
    rl.close();
    if (typed !== `${d} ${id}`) { console.log('Not confirmed; nothing was sent.'); return; }
  }
  const r = await client.resolve(id, d === 'pay');
  console.log(`✓ ${d === 'pay' ? 'paid provider' : 'refunded buyer'} · ${r.explorerUrl ?? r.hash}`);
}

try {
  if (cmd === 'list') await list();
  else if (cmd === 'show' && /^\d+$/.test(idArg ?? '')) await show(BigInt(idArg!));
  else if (cmd === 'resolve' && /^\d+$/.test(idArg ?? '')) await resolve(BigInt(idArg!), decision);
  else { console.log('Usage: npm run arbiter [-- list | show <jobId> | resolve <jobId> pay|refund]'); process.exitCode = 1; }
} catch (e) {
  console.error(`✗ ${e instanceof AgentSettleError ? e.code + ': ' : ''}${(e as Error).message}`);
  process.exitCode = 1;
}
