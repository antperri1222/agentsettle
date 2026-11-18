// Sets up this machine as an AgentSettle PROVIDER agent on an existing deployment (Base Sepolia testnet only).
// Safe to run again at any time: it then only re-checks your status.
//
//   npm run join
//
// No Foundry, faucet or USDC needed. It:
//   1. creates a provider-agent wallet: an encrypted, cast-compatible keystore at
//      ~/.foundry/keystores/agentsettle-provider-agent, unlocked by a random password saved at
//      ~/.agentsettle/agentsettle-provider-agent.password (mode 600). The key never leaves this machine.
//   2. writes .env for the deployment in deployments/base-sepolia.json and its relay
//   3. checks the relay and the chain, and whether the person hiring you has allowlisted you and sent gas
//   4. registers the MCP server with Claude Code (if installed) and prints the Codex command
//
// The key is as safe as your user account. That is fine for a testnet agent; never put real funds on it.
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import { createPublicClient, formatEther, getAddress, http, type Address, type Chain, type PublicClient } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { baseSepolia } from 'viem/chains';
import { agentEscrowAbi } from '../sdk/artifacts.ts';
import { AgentSettleClient } from '../sdk/client.ts';
import { encryptKeystoreJson, keystorePath, loadKeystoreWithPasswordFile } from '../sdk/keystore.ts';
import { localChain } from '../sdk/local.ts';
import { getNetwork } from '../sdk/networks.ts';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const deploymentFile = process.env.AGENTSETTLE_DEPLOYMENT_FILE || join(REPO, 'deployments', 'base-sepolia.json');
const envFile = process.env.AGENTSETTLE_ENV_FILE || join(REPO, '.env');
if (existsSync(envFile)) process.loadEnvFile(envFile);
const KEYSTORE = 'agentsettle-provider-agent';
const SERVER_NAME = 'agentsettle-provider';
const LOW_GAS_WEI = 20_000_000_000_000n; // 0.00002 ETH, roughly 50 deliveries at recent Base Sepolia fees

const ok = (m: string) => console.log(`  ✓ ${m}`);
const bad = (m: string) => console.log(`  ✗ ${m}`);
const die = (m: string): never => { console.error(`✗ ${m}`); process.exit(1); };

type Deployment = {
  network: string; chainId: number; escrow: string; deployBlock: number; usdc: string | null; relayUrl: string; rpcUrl?: string;
  hiringBuyer?: { label?: string; owner: string; agent: string };
};
const dep: Deployment = JSON.parse(readFileSync(deploymentFile, 'utf8'));
const network = getNetwork(dep.network);
if (network.chainId !== dep.chainId) die(`${deploymentFile} says chain ${dep.chainId}, but ${network.name} is ${network.chainId}`);
const escrow = getAddress(dep.escrow);
const hirer = dep.hiringBuyer ? { label: dep.hiringBuyer.label || 'the buyer', owner: getAddress(dep.hiringBuyer.owner), agent: getAddress(dep.hiringBuyer.agent) } : null;
const who = hirer?.label ?? 'the person hiring you';

console.log(`AgentSettle provider setup · ${network.label} · escrow ${escrow}\n`);

// ── 1. Wallet ──
console.log('1. Provider wallet');
const ksFile = keystorePath(KEYSTORE);
const pwFile = join(homedir(), '.agentsettle', `${KEYSTORE}.password`);
let address: Address;
if (existsSync(ksFile)) {
  if (!existsSync(pwFile)) die(`A keystore already exists at ${ksFile} but ${pwFile} doesn't. If you created it with cast, run: npm run mcp:setup -- provider`);
  try { address = loadKeystoreWithPasswordFile(ksFile, pwFile).address; }
  catch (e) { die(`Could not unlock ${ksFile}: ${(e as Error).message}`); }
  ok(`existing wallet ${address!}`);
} else {
  const key = generatePrivateKey();
  const password = randomBytes(32).toString('hex');
  for (const d of [dirname(ksFile), dirname(pwFile)]) { mkdirSync(d, { recursive: true, mode: 0o700 }); chmodSync(d, 0o700); }
  writeFileSync(pwFile, password, { mode: 0o600, flag: 'wx' });
  writeFileSync(ksFile, encryptKeystoreJson(key, password), { mode: 0o600, flag: 'wx' });
  address = privateKeyToAccount(key).address;
  ok(`created wallet ${address}`);
  ok(`keystore ${ksFile}`);
  ok(`password file ${pwFile} (mode 600)`);
}

// ── 2. .env ──
console.log('\n2. Configuration');
const managed: Record<string, string> = {
  AGENTSETTLE_NETWORK: network.name,
  ESCROW_ADDRESS: escrow,
  ESCROW_DEPLOY_BLOCK: String(dep.deployBlock),
  AGENTSETTLE_RELAY_URL: dep.relayUrl,
  PROVIDER_AGENT_ADDRESS: address!,
};
const existing = existsSync(envFile) ? readFileSync(envFile, 'utf8') : '';
const keyOf = (line: string) => /^\s*([A-Z0-9_]+)\s*=/.exec(line)?.[1];
const existingKeys = new Set(existing.split('\n').map(keyOf).filter(Boolean));
if (existingKeys.has('OWNER_ADDRESS') || existingKeys.has('BUYER_AGENT_ADDRESS') || existingKeys.has('DEPLOYER_ADDRESS')) {
  die(`${envFile} belongs to a buyer/owner setup. Run npm run join on a separate machine or in a separate clone.`);
}
const kept = existing.split('\n').filter((l) => { const k = keyOf(l); return l.trim() && !(k && k in managed) && !l.startsWith('# AgentSettle provider'); });
const lines = [
  '# AgentSettle provider (written by npm run join; Base Sepolia testnet only — never commit this file)',
  ...Object.entries(managed).map(([k, v]) => `${k}=${v}`),
  ...kept,
];
if (!kept.some((l) => keyOf(l) === 'BASE_SEPOLIA_RPC_URL')) lines.push(`# BASE_SEPOLIA_RPC_URL=  (optional: your own RPC; defaults to ${network.defaultRpcUrl}, which is rate-limited)`);
writeFileSync(envFile, lines.join('\n') + '\n', { mode: 0o600 });
ok(`wrote ${envFile}`);

// ── 3. Checks ──
console.log('\n3. Checks');
let ready = true;
try {
  const h = await (await fetch(`${dep.relayUrl}/health`, { signal: AbortSignal.timeout(15_000) })).json();
  if (h.chainId !== network.chainId || getAddress(h.escrow) !== escrow) { bad(`relay ${dep.relayUrl} serves a different deployment`); ready = false; }
  else ok(`relay ${dep.relayUrl} is up`);
} catch (e) { bad(`relay ${dep.relayUrl} unreachable: ${(e as Error).message}`); ready = false; }

const rpcUrl = process.env.BASE_SEPOLIA_RPC_URL || dep.rpcUrl || network.defaultRpcUrl;
const chain: Chain = network.name === 'anvil' ? localChain(rpcUrl) : baseSepolia;
const pub = createPublicClient({ chain, transport: http(rpcUrl, { retryCount: 4 }) }) as PublicClient;
try {
  await AgentSettleClient.connect({ network, publicClient: pub, escrowAddress: escrow, expectedTokenAddress: dep.usdc ? getAddress(dep.usdc) : undefined });
  ok(`chain ${network.chainId} and escrow verified (token is the expected USDC)`);
  const bal = await pub.getBalance({ address: address! });
  if (bal === 0n) { bad(`no ETH for transaction fees yet (${who} sends this)`); ready = false; }
  else if (bal < LOW_GAS_WEI) ok(`ETH for fees: ${formatEther(bal)} (low; ask ${who} for a top-up)`);
  else ok(`ETH for fees: ${formatEther(bal)}`);
  if (hirer) {
    const allowed = await pub.readContract({ address: escrow, abi: agentEscrowAbi, functionName: 'providerAllowed', args: [hirer.owner, hirer.agent, address!] });
    if (allowed) ok(`${who}'s buyer agent is allowed to hire you`);
    else { bad(`${who} hasn't allowlisted you yet`); ready = false; }
  }
} catch (e) { bad(`chain check failed: ${(e as Error).message.split('\n')[0]}`); ready = false; }

// ── 4. Agent client ──
console.log('\n4. Connect your AI agent');
const node = process.execPath;
const server = join(REPO, 'mcp', 'server.ts');
const has = (bin: string) => spawnSync(bin, ['--version'], { stdio: 'ignore' }).status === 0;
const claudeCmd = ['claude', 'mcp', 'add', SERVER_NAME, '--scope', 'user', '-e', 'AGENTSETTLE_ROLE=provider', '--', node, server];
const show = (args: string[]) => args.map((a) => (/[\s"]/.test(a) || a.includes('/') ? `"${a}"` : a)).join(' ');
if (has('claude')) {
  const registered = spawnSync('claude', ['mcp', 'get', SERVER_NAME], { stdio: 'ignore' }).status === 0;
  if (registered) ok(`Claude Code: "${SERVER_NAME}" is registered`);
  else if (process.stdin.isTTY) {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const answer = (await rl.question(`  Register "${SERVER_NAME}" with Claude Code now? [Y/n] `)).trim().toLowerCase();
    rl.close();
    if (answer === '' || answer === 'y' || answer === 'yes') {
      const r = spawnSync(claudeCmd[0], claudeCmd.slice(1), { stdio: 'inherit' });
      if (r.status === 0) ok(`Claude Code: registered "${SERVER_NAME}" (restart any open Claude Code sessions)`);
      else bad('Claude Code registration failed; run the command below yourself');
    }
  }
  if (!registered) console.log(`  Claude Code: ${show(claudeCmd)}`);
} else console.log(`  Claude Code: ${show(claudeCmd)}`);
console.log(`  Codex:       ${show(['codex', 'mcp', 'add', SERVER_NAME, '--env', 'AGENTSETTLE_ROLE=provider', '--', node, server])}`);

// ── Summary ──
console.log('');
if (ready) {
  console.log(`Ready. In your agent, try: "Check AgentSettle for jobs assigned to me, read the terms, and deliver the work."`);
} else {
  console.log(`Not ready yet. Send ${who} your provider address:\n\n    ${address!}\n`);
  console.log(`${who === 'the person hiring you' ? 'They' : who} will allowlist it and send a little test ETH for fees. Then run npm run join again to check.`);
}
