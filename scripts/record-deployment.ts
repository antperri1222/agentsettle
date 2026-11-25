// After `forge script … --broadcast`, records the new escrow everywhere it's needed, after checking it on-chain:
//
//   npm run deploy:record
//
//   1. reads the address and block from contracts/broadcast/DeployBaseSepolia.s.sol/84532/run-latest.json
//   2. verifies on-chain: contract code exists, VERSION() == 2, usdc() is the verified USDC, treasury() matches .env
//   3. updates ESCROW_ADDRESS / ESCROW_DEPLOY_BLOCK in .env (the previous values are kept as a comment)
//   4. updates deployments/base-sepolia.json (escrow, block, known arbiters), which `npm run join` and the agents read
//   5. prints what to change on Railway
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createPublicClient, getAddress, http, isAddress, type Address, type Chain, type PublicClient } from 'viem';
import { baseSepolia } from 'viem/chains';
import { agentEscrowAbi } from '../sdk/artifacts.ts';
import { localChain } from '../sdk/local.ts';
import { getNetwork } from '../sdk/networks.ts';

const REPO = new URL('..', import.meta.url).pathname;
const envFile = process.env.AGENTSETTLE_ENV_FILE || join(REPO, '.env');
if (existsSync(envFile)) process.loadEnvFile(envFile);
const network = getNetwork(process.env.AGENTSETTLE_NETWORK || 'base-sepolia');
const broadcastFile = process.env.BROADCAST_FILE || join(REPO, 'contracts', 'broadcast', 'DeployBaseSepolia.s.sol', String(network.chainId), 'run-latest.json');
const deploymentFile = process.env.AGENTSETTLE_DEPLOYMENT_FILE || join(REPO, 'deployments', `${network.name}.json`);
const die = (m: string): never => { console.error(`✗ ${m}`); process.exit(1); };

if (!existsSync(broadcastFile)) die(`No broadcast found at ${broadcastFile}. Run the forge script with --broadcast first.`);
const run = JSON.parse(readFileSync(broadcastFile, 'utf8'));
const receipt = (run.receipts ?? []).find((r: any) => r.contractAddress);
if (!receipt) die('The broadcast has no contract-creation receipt.');
const escrow = getAddress(receipt.contractAddress);
const deployBlock = Number(BigInt(receipt.blockNumber));

const rpcUrl = process.env.AGENTSETTLE_RPC_URL || process.env.BASE_SEPOLIA_RPC_URL || network.defaultRpcUrl;
const chain: Chain = network.name === 'anvil' ? localChain(rpcUrl) : baseSepolia;
const pub = createPublicClient({ chain, transport: http(rpcUrl, { retryCount: 4 }) }) as PublicClient;
if ((await pub.getChainId()) !== network.chainId) die(`RPC is not chain ${network.chainId}`);
if (!(await pub.getCode({ address: escrow }))) die(`No contract code at ${escrow}`);
const read = (functionName: any) => pub.readContract({ address: escrow, abi: agentEscrowAbi, functionName }) as Promise<any>;
const version = Number(await read('VERSION'));
if (version !== 2) die(`Escrow reports VERSION ${version}, expected 2`);
const usdc = getAddress(await read('usdc'));
if (network.usdcAddress && usdc !== getAddress(network.usdcAddress)) die(`Escrow token ${usdc} is not the verified USDC ${network.usdcAddress}`);
const treasury = getAddress(await read('treasury'));
if (process.env.TREASURY_ADDRESS && treasury !== getAddress(process.env.TREASURY_ADDRESS)) die(`Escrow treasury ${treasury} differs from TREASURY_ADDRESS`);
console.log(`✓ verified ${escrow} on ${network.label}: VERSION 2, token ${usdc}, treasury ${treasury}, deployed in block ${deployBlock}`);

// .env
const prevEscrow = process.env.ESCROW_ADDRESS;
const prevBlock = process.env.ESCROW_DEPLOY_BLOCK;
let env = existsSync(envFile) ? readFileSync(envFile, 'utf8') : '';
const setVar = (k: string, v: string) => {
  const re = new RegExp(`^${k}=.*$`, 'm');
  env = re.test(env) ? env.replace(re, `${k}=${v}`) : `${env.replace(/\n?$/, '\n')}${k}=${v}\n`;
};
if (prevEscrow && getAddress(prevEscrow) !== escrow) {
  env = env.replace(/^ESCROW_ADDRESS=.*$/m, (l) => `# previous escrow (v1, deploy block ${prevBlock ?? '?'}): ${prevEscrow}\n${l}`);
}
setVar('ESCROW_ADDRESS', escrow);
setVar('ESCROW_DEPLOY_BLOCK', String(deployBlock));
if (process.env.ARBITER_ADDRESS && !process.env.AGENTSETTLE_DEFAULT_ARBITER) setVar('AGENTSETTLE_DEFAULT_ARBITER', getAddress(process.env.ARBITER_ADDRESS));
writeFileSync(envFile, env);
console.log(`✓ updated ${envFile}`);

// deployments/<network>.json
const dep = existsSync(deploymentFile) ? JSON.parse(readFileSync(deploymentFile, 'utf8')) : { network: network.name, chainId: network.chainId };
if (dep.escrow && getAddress(dep.escrow) !== escrow) {
  dep.previous = [...(dep.previous ?? []), { escrow: dep.escrow, deployBlock: dep.deployBlock, version: dep.version ?? 1 }];
}
Object.assign(dep, { escrow, deployBlock, version: 2, usdc });
const arbiter = process.env.ARBITER_ADDRESS;
if (arbiter && isAddress(arbiter) && !(dep.arbiters ?? []).some((a: any) => getAddress(a.address) === getAddress(arbiter))) {
  const who = dep.hiringBuyer?.label ?? 'the deployer';
  dep.arbiters = [...(dep.arbiters ?? []), { address: getAddress(arbiter), label: `AgentSettle test arbiter, run by ${who} (not independent of ${who}'s jobs)` }];
}
writeFileSync(deploymentFile, `${JSON.stringify(dep, null, 2)}\n`);
console.log(`✓ updated ${deploymentFile} (commit and push it so providers pick it up)`);

console.log(`\nOn Railway (relay service → Variables), set:\n  ESCROW_ADDRESS=${escrow}\n  ESCROW_DEPLOY_BLOCK=${deployBlock}`);
console.log('Then restart Claude (Desktop: Cmd+Q and reopen) so the agents use the new escrow.');
