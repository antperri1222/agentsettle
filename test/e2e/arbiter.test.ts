// v2 disputes end to end: per-job arbiter, dispute statements shared through the relay, and `npm run arbiter`.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import type { Server } from 'node:http';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { getAddress } from 'viem';
import { join } from 'node:path';
import { AgentSettleClient } from '../../sdk/client.ts';
import { devAccount, deployLocal, devWallet, localPublicClient, startAnvil, type LocalDeployment, type LocalRole } from '../../sdk/local.ts';
import { NETWORKS } from '../../sdk/networks.ts';
import { RelayClient, RelayError } from '../../sdk/relay.ts';
import { canonicalTerms, hashEvidence, hashTerms, parseUsdcUnits, type TaskTermsV1 } from '../../sdk/terms.ts';
import { createRelay } from '../../relay/server.ts';

let anvil: ChildProcess;
let relay: Server;
let relayUrl: string;
let d: LocalDeployment;
let tmp: string;
const REPO = new URL('../..', import.meta.url).pathname;
const rc = (r: LocalRole) => new RelayClient({ url: relayUrl, account: devAccount(r), chainId: 31337, escrow: d.escrow });
const connect = async (r: LocalRole) => AgentSettleClient.connect({ network: NETWORKS.anvil, publicClient: localPublicClient(d.rpcUrl), escrowAddress: d.escrow, expectedTokenAddress: d.token, wallet: await devWallet(r, d.rpcUrl) });

function arbiterCli(args: string[]): Promise<{ code: number | null; out: string }> {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [join(REPO, 'scripts/arbiter.ts'), ...args], {
      env: { PATH: process.env.PATH ?? '', HOME: tmp, AGENTSETTLE_NETWORK: 'anvil', AGENTSETTLE_LOCAL_FILE: join(tmp, 'local.json'), AGENTSETTLE_RELAY_URL: relayUrl, AGENTSETTLE_DATA_DIR: join(tmp, 'none') },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let out = '';
    p.stdout.on('data', (b) => (out += b)); p.stderr.on('data', (b) => (out += b));
    p.stdin.end();
    p.on('close', (code) => resolve({ code, out }));
  });
}

async function fundJob(arbiter: `0x${string}`, description: string, key: string) {
  const owner = await connect('owner');
  const deadline = (await localPublicClient(d.rpcUrl).getBlock()).timestamp + 3600n;
  const terms: TaskTermsV1 = { version: 'agentsettle.terms.v1', chainId: 31337, escrow: d.escrow, provider: d.roles.providerAgent, amountUnits: '1000000', deadline: Number(deadline), description, acceptanceCriteria: ['Under 50 words', 'Mentions refunds'] };
  await rc('owner').put(canonicalTerms(terms));
  return (await owner.createJob({ provider: d.roles.providerAgent, arbiter, amount: parseUsdcUnits('1'), deadline, termsHash: hashTerms(terms), idempotencyKey: key })).jobId;
}

before(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'agentsettle-arb-'));
  let rpcUrl: string;
  ({ proc: anvil, rpcUrl } = await startAnvil(20_000 + Math.floor(Math.random() * 20_000)));
  d = await deployLocal(rpcUrl);
  writeFileSync(join(tmp, 'local.json'), JSON.stringify(d));
  relay = createRelay({ network: 'anvil', rpcUrl, escrow: d.escrow, dataDir: join(tmp, 'relay'), uploadsPerMinute: 1000 });
  await new Promise<void>((r) => relay.listen(0, '127.0.0.1', r));
  const a = relay.address();
  relayUrl = `http://127.0.0.1:${typeof a === 'object' && a ? a.port : 0}`;
  await (await connect('owner')).approveSpend(parseUsdcUnits('10'));
});

after(() => { relay?.close(); anvil?.kill(); if (tmp) rmSync(tmp, { recursive: true, force: true }); });

test('dispute: both sides state their case via the relay; the named arbiter reads everything and refunds', async () => {
  const id = await fundJob(d.roles.arbiter, 'Explain escrow in under 50 words', 'arb-test-0001');
  const content = 'Escrow is great. Trust me.';
  const evidence = await rc('providerAgent').put(content);
  await (await connect('providerAgent')).deliver(id, hashEvidence(content));
  assert.equal(evidence, hashEvidence(content));

  await (await connect('owner')).dispute(id);
  await rc('owner').putStatement(id, 'Does not mention refunds, which the criteria require.');
  await rc('providerAgent').putStatement(id, 'It is under 50 words as asked.');
  await assert.rejects(rc('stranger').putStatement(id, 'I side with the provider'), (e: unknown) => e instanceof RelayError && e.status === 403);
  await assert.rejects(rc('stranger').getStatements(id), (e: unknown) => e instanceof RelayError && e.status === 403);
  assert.equal((await rc('arbiter').getStatements(id)).length, 2);

  const list = await arbiterCli([]);
  assert.equal(list.code, 0, list.out);
  assert.match(list.out, new RegExp(`Needs a decision \\(1\\)[\\s\\S]*#${id}\\s+Disputed`));

  const show = await arbiterCli(['show', String(id)]);
  assert.equal(show.code, 0, show.out);
  assert.match(show.out, /Explain escrow in under 50 words/);
  assert.match(show.out, /- Mentions refunds/);
  assert.match(show.out, /Escrow is great\. Trust me\./);
  assert.match(show.out, /buyer 0x[\s\S]*Does not mention refunds/);
  assert.match(show.out, /provider 0x[\s\S]*under 50 words as asked/);

  assert.match((await arbiterCli(['resolve', String(id), 'refund'])).out, /Not confirmed; nothing was sent/, 'needs typed confirmation');
  const done = await arbiterCli(['resolve', String(id), 'refund', '--yes']);
  assert.equal(done.code, 0, done.out);
  assert.match(done.out, /refunded buyer/);
  assert.equal((await (await connect('owner')).getJob(id)).status, 'Refunded');
});

test('an arbiter cannot settle a job that names someone else', async () => {
  const id = await fundJob(d.roles.stranger, 'Job with a different arbiter', 'arb-test-0002');
  await (await connect('owner')).dispute(id);
  const r = await arbiterCli(['resolve', String(id), 'pay', '--yes']);
  assert.equal(r.code, 1);
  assert.match(r.out, /Forbidden: You are not the arbiter of job/);
  assert.equal((await (await connect('owner')).getJob(id)).status, 'Disputed');
  const chainSays = (await connect('arbiter')).resolve(id, true);
  await assert.rejects(chainSays, /Forbidden/, 'the contract refuses too, not just the CLI');
});

test('deploy:record verifies the new escrow on-chain and updates .env and the deployment file', async () => {
  const bc = join(tmp, 'run-latest.json');
  writeFileSync(bc, JSON.stringify({ receipts: [{ contractAddress: d.escrow, blockNumber: '0x' + BigInt(d.deployBlock).toString(16) }] }));
  const envFile = join(tmp, 'owner.env');
  writeFileSync(envFile, `ESCROW_ADDRESS=0x000000000000000000000000000000000000dEaD\nESCROW_DEPLOY_BLOCK=5\nARBITER_ADDRESS=${d.roles.arbiter}\nTREASURY_ADDRESS=${d.roles.treasury}\nOTHER=kept\n`);
  const depFile = join(tmp, 'dep.json');
  writeFileSync(depFile, JSON.stringify({ network: 'anvil', chainId: 31337, escrow: '0x000000000000000000000000000000000000dEaD', deployBlock: 5, hiringBuyer: { label: 'Anthony' } }));
  const out = await new Promise<{ code: number | null; out: string }>((resolve) => {
    const p = spawn(process.execPath, [join(REPO, 'scripts/record-deployment.ts')], {
      env: { PATH: process.env.PATH ?? '', AGENTSETTLE_NETWORK: 'anvil', AGENTSETTLE_RPC_URL: d.rpcUrl, BROADCAST_FILE: bc, AGENTSETTLE_ENV_FILE: envFile, AGENTSETTLE_DEPLOYMENT_FILE: depFile },
    });
    let o = ''; p.stdout.on('data', (b) => (o += b)); p.stderr.on('data', (b) => (o += b));
    p.on('close', (code) => resolve({ code, out: o }));
  });
  assert.equal(out.code, 0, out.out);
  assert.match(out.out, /VERSION 2/);
  const { readFileSync } = await import('node:fs');
  const env = readFileSync(envFile, 'utf8');
  assert.match(env, new RegExp(`^ESCROW_ADDRESS=${getAddress(d.escrow)}$`, 'm'));
  assert.match(env, new RegExp(`^ESCROW_DEPLOY_BLOCK=${d.deployBlock}$`, 'm'));
  assert.match(env, /^# previous escrow \(v1, deploy block 5\): 0x0+dEaD$/m);
  assert.match(env, new RegExp(`^AGENTSETTLE_DEFAULT_ARBITER=${d.roles.arbiter}$`, 'm'));
  assert.match(env, /^OTHER=kept$/m);
  const dep = JSON.parse(readFileSync(depFile, 'utf8'));
  assert.equal(dep.escrow, getAddress(d.escrow));
  assert.equal(dep.version, 2);
  assert.equal(dep.previous[0].escrow, '0x000000000000000000000000000000000000dEaD');
  assert.equal(dep.arbiters[0].address, d.roles.arbiter);
  assert.match(dep.arbiters[0].label, /not independent of Anthony's jobs/);
});

test('owner setup: one unlock sets allowance, policy, provider and default arbiter on a fresh escrow', async () => {
  const out = await new Promise<{ code: number | null; out: string }>((resolve) => {
    const p = spawn(process.execPath, [join(REPO, 'scripts/owner.ts'), 'setup', '5', '2', '5', '30'], {
      env: { PATH: process.env.PATH ?? '', AGENTSETTLE_NETWORK: 'anvil', AGENTSETTLE_LOCAL_FILE: join(tmp, 'local.json'), PROVIDER_AGENT_ADDRESS: d.roles.providerAgent, ARBITER_ADDRESS: d.roles.arbiter },
    });
    let o = ''; p.stdout.on('data', (b) => (o += b)); p.stderr.on('data', (b) => (o += b));
    p.on('close', (code) => resolve({ code, out: o }));
  });
  assert.equal(out.code, 0, out.out);
  assert.match(out.out, /allowance 5 USDC[\s\S]*policy \$2\/job, \$5\/day, 30 days[\s\S]*allowlisted provider[\s\S]*allowlisted arbiter/);
  assert.match(out.out, /policy ACTIVE/);
  assert.match(out.out, /default arbiter 0x[0-9a-fA-F]{40}: allowlisted/);
});
