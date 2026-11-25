import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  createPublicClient, createWalletClient, http, type Address, type Chain, type PublicClient,
} from 'viem';
import { mnemonicToAccount } from 'viem/accounts';
import { foundry } from 'viem/chains';
import { agentEscrowAbi, agentEscrowBytecode, mockUsdcAbi, mockUsdcBytecode } from './artifacts.ts';
import { NETWORKS } from './networks.ts';

/**
 * LOCAL ANVIL ONLY. Anvil's default mnemonic is public knowledge; these keys hold nothing of value and are
 * refused on any chain other than 31337.
 */
const ANVIL_MNEMONIC = 'test test test test test test test test test test test junk';

/** Fixed role → Anvil account index. Each role is a distinct signer. */
export const LOCAL_ROLES = {
  deployer: 0,
  owner: 1, // human who funds and sets the agent's spend policy
  buyerAgent: 2, // agent key: spends within policy, approves/disputes
  providerAgent: 3, // agent key: delivers evidence
  arbiter: 4,
  treasury: 5,
  stranger: 6, // used by adversarial tests
} as const;
export type LocalRole = keyof typeof LOCAL_ROLES;

export function devAccount(role: LocalRole) {
  return mnemonicToAccount(ANVIL_MNEMONIC, { addressIndex: LOCAL_ROLES[role] });
}

export function localChain(rpcUrl: string): Chain {
  return { ...foundry, rpcUrls: { default: { http: [rpcUrl] } } };
}

export async function devWallet(role: LocalRole, rpcUrl: string) {
  const chain = localChain(rpcUrl);
  const wallet = createWalletClient({ account: devAccount(role), chain, transport: http(rpcUrl) });
  const id = await wallet.getChainId();
  if (id !== NETWORKS.anvil.chainId) throw new Error(`Refusing to use Anvil dev keys on chain ${id}`);
  return wallet;
}

export function localPublicClient(rpcUrl: string): PublicClient {
  return createPublicClient({ chain: localChain(rpcUrl), transport: http(rpcUrl), pollingInterval: 50 }) as PublicClient;
}

export function findAnvil(): string {
  const candidates = [process.env.ANVIL_BIN, join(homedir(), '.foundry', 'bin', 'anvil')].filter(Boolean) as string[];
  for (const c of candidates) if (existsSync(c)) return c;
  return 'anvil'; // fall back to PATH
}

export async function startAnvil(port: number, opts: { quiet?: boolean } = {}): Promise<{ proc: ChildProcess; rpcUrl: string }> {
  const proc = spawn(findAnvil(), ['--port', String(port), '--host', '127.0.0.1', '--chain-id', '31337', '--silent'], {
    stdio: opts.quiet === false ? 'inherit' : 'ignore',
  });
  const rpcUrl = `http://127.0.0.1:${port}`;
  const client = localPublicClient(rpcUrl);
  for (let i = 0; i < 100; i++) {
    if (proc.exitCode !== null) throw new Error(`anvil exited with code ${proc.exitCode}. Is Foundry installed?`);
    try { await client.getChainId(); return { proc, rpcUrl }; } catch { await new Promise((r) => setTimeout(r, 100)); }
  }
  proc.kill();
  throw new Error('anvil did not start within 10s');
}

export interface LocalDeployment {
  network: 'anvil';
  rpcUrl: string;
  chainId: 31337;
  token: Address;
  escrow: Address;
  treasury: Address;
  arbiter: Address;
  feeBps: number;
  deployBlock: string;
  roles: Record<LocalRole, Address>;
}

/** Deploys MockUSDC (TEST ONLY) and AgentEscrow to Anvil and mints test tokens to the owner. */
export async function deployLocal(rpcUrl: string, opts: { feeBps?: number; mintToOwner?: bigint } = {}): Promise<LocalDeployment> {
  const pub = localPublicClient(rpcUrl);
  const deployer = await devWallet('deployer', rpcUrl);
  const roles = Object.fromEntries(Object.keys(LOCAL_ROLES).map((r) => [r, devAccount(r as LocalRole).address])) as Record<LocalRole, Address>;
  const feeBps = opts.feeBps ?? 50;

  const tokenHash = await deployer.deployContract({ abi: mockUsdcAbi, bytecode: mockUsdcBytecode });
  const tokenR = await pub.waitForTransactionReceipt({ hash: tokenHash });
  const token = tokenR.contractAddress!;
  const escrowHash = await deployer.deployContract({
    abi: agentEscrowAbi, bytecode: agentEscrowBytecode, args: [token, roles.treasury, feeBps],
  });
  const escrowR = await pub.waitForTransactionReceipt({ hash: escrowHash });
  const escrow = escrowR.contractAddress!;
  const mint = opts.mintToOwner ?? 100_000_000n; // 100 mUSDC
  const mintHash = await deployer.writeContract({ address: token, abi: mockUsdcAbi, functionName: 'mint', args: [roles.owner, mint] });
  await pub.waitForTransactionReceipt({ hash: mintHash });
  return {
    network: 'anvil', rpcUrl, chainId: 31337, token, escrow, treasury: roles.treasury, arbiter: roles.arbiter,
    feeBps, deployBlock: String(escrowR.blockNumber), roles,
  };
}
