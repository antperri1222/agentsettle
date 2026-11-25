// Owner (human) controls for the buyer agent's budget. These are deliberately NOT available to the AI agent.
//
//   npm run owner -- status
//   npm run owner -- approve <usdc>                      exact USDC allowance the agent can draw on
//   npm run owner -- policy <perJobUsdc> <dailyUsdc> <days>
//   npm run owner -- allow <providerAddress>             add a provider to the agent's allowlist
//   npm run owner -- disallow <providerAddress>
//   npm run owner -- allow-arbiter <arbiterAddress>      let the agent name this arbiter on its jobs (v2 contracts)
//   npm run owner -- disallow-arbiter <arbiterAddress>
//   npm run owner -- revoke                              stop the agent from funding new jobs immediately
//   npm run owner -- setup <usdc> <perJob> <daily> <days>   one unlock: allowance, policy, own provider agent, default arbiter
//   npm run owner -- onboard <providerAddress> [eth]     allowlist a new provider and top up its gas (default 0.0001 ETH)
import { readFileSync } from 'node:fs';
import { createPublicClient, createWalletClient, formatEther, getAddress, http, isAddress, parseEther, type Address, type Chain, type PublicClient } from 'viem';
import { baseSepolia } from 'viem/chains';
import { agentEscrowAbi } from '../sdk/artifacts.ts';
import { AgentSettleClient, AgentSettleError } from '../sdk/client.ts';
import { loadKeystoreAccount } from '../sdk/keystore.ts';
import { devAccount, localChain } from '../sdk/local.ts';
import { getNetwork } from '../sdk/networks.ts';
import { formatUsdcUnits, parseUsdcUnits } from '../sdk/terms.ts';
import { assertEnvMatchesFile } from '../sdk/env-guard.ts';

try { assertEnvMatchesFile(new URL('../.env', import.meta.url).pathname); } catch (e) { console.error(`✗ ${(e as Error).message}`); process.exit(1); }
const [cmd, ...args] = process.argv.slice(2);
const LOCAL_FILE = process.env.AGENTSETTLE_LOCAL_FILE || new URL('../.agentsettle/local.json', import.meta.url);
const network = getNetwork(process.env.AGENTSETTLE_NETWORK || 'anvil');
let chain: Chain, rpcUrl: string, escrow: Address, token: Address | undefined, owner: Address, agent: Address;
if (network.name === 'anvil') {
  const d = JSON.parse(readFileSync(LOCAL_FILE, 'utf8'));
  rpcUrl = d.rpcUrl; chain = localChain(rpcUrl); escrow = d.escrow; token = d.token; owner = d.roles.owner; agent = d.roles.buyerAgent;
} else {
  rpcUrl = process.env.BASE_SEPOLIA_RPC_URL || network.defaultRpcUrl; chain = baseSepolia;
  escrow = getAddress(process.env.ESCROW_ADDRESS!); owner = getAddress(process.env.OWNER_ADDRESS!); agent = getAddress(process.env.BUYER_AGENT_ADDRESS!);
}
const pub = createPublicClient({ chain, transport: http(rpcUrl) }) as PublicClient;

async function status() {
  const c = await AgentSettleClient.connect({ network, publicClient: pub, escrowAddress: escrow, expectedTokenAddress: token });
  const now = (await pub.getBlock()).timestamp;
  const [perJob, daily, expires, active] = await pub.readContract({ address: escrow, abi: agentEscrowAbi, functionName: 'policies', args: [owner, agent] });
  const spent = await pub.readContract({ address: escrow, abi: agentEscrowAbi, functionName: 'spentPerDay', args: [owner, agent, now / 86400n] });
  console.log(`${network.label} · escrow ${escrow}`);
  console.log(`owner ${owner}: ${formatUsdcUnits(await c.tokenBalance(owner))} USDC, allowance to escrow ${formatUsdcUnits(await c.allowance(owner))}`);
  console.log(`buyer agent ${agent}: policy ${active && now < expires ? 'ACTIVE' : 'INACTIVE'} · $${formatUsdcUnits(perJob)}/job · $${formatUsdcUnits(daily)}/day · spent today $${formatUsdcUnits(spent)} · expires ${expires ? new Date(Number(expires) * 1000).toLocaleString() : '—'}`);
  if (process.env.PROVIDER_AGENT_ADDRESS || network.name === 'anvil') {
    const p = network.name === 'anvil' ? JSON.parse(readFileSync(LOCAL_FILE, 'utf8')).roles.providerAgent : process.env.PROVIDER_AGENT_ADDRESS!;
    const ok = await pub.readContract({ address: escrow, abi: agentEscrowAbi, functionName: 'providerAllowed', args: [owner, agent, getAddress(p)] });
    console.log(`provider agent ${p}: ${ok ? 'allowlisted' : 'NOT allowlisted'}`);
  }
  const arb = network.name === 'anvil' ? JSON.parse(readFileSync(LOCAL_FILE, 'utf8')).roles.arbiter : (process.env.AGENTSETTLE_DEFAULT_ARBITER || process.env.ARBITER_ADDRESS);
  if (arb && isAddress(arb)) {
    const ok = await pub.readContract({ address: escrow, abi: agentEscrowAbi, functionName: 'arbiterAllowed', args: [owner, agent, getAddress(arb)] });
    console.log(`default arbiter ${getAddress(arb)}: ${ok ? 'allowlisted' : 'NOT allowlisted (run: npm run owner -- allow-arbiter ' + getAddress(arb) + ')'}`);
  }
}

async function signerParts() {
  const account = network.name === 'anvil' ? devAccount('owner') : loadKeystoreAccount('agentsettle-owner');
  if (account.address !== owner) throw new Error(`Owner keystore is ${account.address}, but OWNER_ADDRESS is ${owner}`);
  const wallet = createWalletClient({ account, chain, transport: http(rpcUrl) });
  const client = await AgentSettleClient.connect({ network, publicClient: pub, escrowAddress: escrow, expectedTokenAddress: token, wallet });
  return { client, wallet };
}
async function signer() { return (await signerParts()).client; }

/** Lets a new provider (e.g. a developer who ran `npm run join`) be hired by the buyer agent, and gives it gas money. */
async function onboard(provider: Address, ethTarget: string) {
  const target = parseEther(ethTarget);
  if (target > parseEther('0.01')) throw new Error('Refusing to send more than 0.01 ETH; testnet fees are tiny.');
  if (provider === owner || provider === agent) throw new Error('That is the owner or buyer agent, not a provider.');
  const { client, wallet } = await signerParts();
  const allowed = await pub.readContract({ address: escrow, abi: agentEscrowAbi, functionName: 'providerAllowed', args: [owner, agent, provider] });
  if (allowed) console.log(`✓ ${provider} is already allowlisted`);
  else { show(await client.setProviderAllowed(agent, provider, true)); console.log(`✓ allowlisted ${provider} for buyer agent ${agent}`); }
  const bal = await pub.getBalance({ address: provider });
  if (bal >= target) { console.log(`✓ provider already has ${formatEther(bal)} ETH for fees`); return; }
  const value = target - bal;
  const mine = await pub.getBalance({ address: owner });
  if (mine < value * 2n) throw new Error(`Owner has only ${formatEther(mine)} ETH; get more from the Coinbase faucet first.`);
  const hash = await wallet.sendTransaction({ to: provider, value, chain, account: wallet.account! });
  const r = await pub.waitForTransactionReceipt({ hash, confirmations: network.confirmations });
  if (r.status !== 'success') throw new Error(`ETH transfer reverted: ${hash}`);
  console.log(`✓ sent ${formatEther(value)} ETH for fees (now ${formatEther(target)}) ${network.explorerUrl ? `${network.explorerUrl}/tx/${hash}` : hash}`);
}

const addr = (s: string | undefined) => { if (!s || !isAddress(s)) throw new Error('Expected a 0x address'); return getAddress(s); };
const show = (r: { hash: string; explorerUrl: string | null }) => console.log(`✓ confirmed ${r.explorerUrl ?? r.hash}`);

try {
  switch (cmd) {
    case 'status': await status(); break;
    case 'approve': show(await (await signer()).approveSpend(parseUsdcUnits(args[0]))); await status(); break;
    case 'policy': {
      const [perJob, daily, days] = args;
      if (!perJob || !daily || !days || !/^\d+$/.test(days)) throw new Error('Usage: policy <perJobUsdc> <dailyUsdc> <days>');
      const now = (await pub.getBlock()).timestamp;
      show(await (await signer()).setPolicy(agent, parseUsdcUnits(perJob), parseUsdcUnits(daily), now + BigInt(days) * 86_400n));
      await status(); break;
    }
    case 'allow': show(await (await signer()).setProviderAllowed(agent, addr(args[0]), true)); await status(); break;
    case 'disallow': show(await (await signer()).setProviderAllowed(agent, addr(args[0]), false)); await status(); break;
    case 'revoke': show(await (await signer()).revokePolicy(agent)); await status(); break;
    case 'allow-arbiter': show(await (await signer()).setArbiterAllowed(agent, addr(args[0]), true)); await status(); break;
    case 'disallow-arbiter': show(await (await signer()).setArbiterAllowed(agent, addr(args[0]), false)); await status(); break;
    case 'setup': {
      // Everything a fresh escrow deployment needs from the owner, signed after a single keystore unlock.
      const [usdc, perJob, daily, days] = args;
      if (!usdc || !perJob || !daily || !days || !/^\d+$/.test(days)) throw new Error('Usage: setup <usdcAllowance> <perJobUsdc> <dailyUsdc> <days>');
      const c = await signer();
      show(await c.approveSpend(parseUsdcUnits(usdc))); console.log(`✓ allowance ${usdc} USDC`);
      const now = (await pub.getBlock()).timestamp;
      show(await c.setPolicy(agent, parseUsdcUnits(perJob), parseUsdcUnits(daily), now + BigInt(days) * 86_400n)); console.log(`✓ policy $${perJob}/job, $${daily}/day, ${days} days`);
      const p = process.env.PROVIDER_AGENT_ADDRESS;
      if (p && isAddress(p)) { show(await c.setProviderAllowed(agent, getAddress(p), true)); console.log(`✓ allowlisted provider ${getAddress(p)}`); }
      const a = process.env.AGENTSETTLE_DEFAULT_ARBITER || process.env.ARBITER_ADDRESS;
      if (a && isAddress(a)) { show(await c.setArbiterAllowed(agent, getAddress(a), true)); console.log(`✓ allowlisted arbiter ${getAddress(a)}`); }
      await status(); break;
    }
    case 'onboard': await onboard(addr(args[0]), args[1] ?? '0.0001'); break;
    default:
      console.log('Usage: npm run owner -- status | approve <usdc> | policy <perJob> <daily> <days> | allow <addr> | disallow <addr> | allow-arbiter <addr> | disallow-arbiter <addr> | revoke | setup <usdc> <perJob> <daily> <days> | onboard <addr> [eth]');
      process.exitCode = cmd ? 1 : 0;
  }
} catch (e) {
  console.error(`✗ ${e instanceof AgentSettleError ? e.code + ': ' : ''}${(e as Error).message}`);
  process.exitCode = 1;
}
