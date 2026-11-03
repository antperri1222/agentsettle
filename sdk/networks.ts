import type { Address } from 'viem';

/**
 * Network registry. Only test networks are permitted. There is deliberately no mainnet entry, and
 * `getNetwork` refuses anything not listed here.
 *
 * Base Sepolia values verified 2026-11-03 against:
 *   - https://developers.circle.com/stablecoins/usdc-contract-addresses  (USDC on Base Sepolia)
 *   - https://docs.base.org/base-chain/quickstart/connecting-to-base       (chain id, RPC, explorer)
 * Re-verify before any deployment; the deploy script also checks decimals() and symbol() on-chain.
 */
export type NetworkName = 'anvil' | 'base-sepolia';

export interface NetworkConfig {
  name: NetworkName;
  label: string;
  chainId: number;
  /** Default RPC. The Base public RPC is rate-limited; use a provider key from env for real testing. */
  defaultRpcUrl: string;
  explorerUrl: string | null;
  /** Official token address, or null when the token is deployed per-session (Anvil MockUSDC). */
  usdcAddress: Address | null;
  usdcDecimals: 6;
  /** Confirmations before the dashboard calls an event "confirmed" rather than "included". */
  confirmations: number;
  isTestnet: true;
  /** Anvil only: allows the well-known Anvil dev keys. Never true elsewhere. */
  allowsDevKeys: boolean;
}

export const NETWORKS: Record<NetworkName, NetworkConfig> = {
  anvil: {
    name: 'anvil',
    label: 'Local Anvil (chain 31337)',
    chainId: 31337,
    defaultRpcUrl: 'http://127.0.0.1:8545',
    explorerUrl: null,
    usdcAddress: null,
    usdcDecimals: 6,
    confirmations: 1,
    isTestnet: true,
    allowsDevKeys: true,
  },
  'base-sepolia': {
    name: 'base-sepolia',
    label: 'Base Sepolia testnet (chain 84532)',
    chainId: 84532,
    defaultRpcUrl: 'https://sepolia.base.org',
    explorerUrl: 'https://sepolia.basescan.org',
    usdcAddress: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
    usdcDecimals: 6,
    confirmations: 3,
    isTestnet: true,
    allowsDevKeys: false,
  },
};

/** Chain IDs that must never be used by this codebase. Checked defensively at every connect. */
export const FORBIDDEN_CHAIN_IDS = new Set([1, 8453, 10, 42161, 137]); // Ethereum, Base, OP, Arbitrum, Polygon mainnets

export function getNetwork(name: string): NetworkConfig {
  const n = NETWORKS[name as NetworkName];
  if (!n) throw new Error(`Unknown or unsupported network "${name}". Supported: ${Object.keys(NETWORKS).join(', ')}`);
  return n;
}

export function explorerTx(network: NetworkConfig, hash: string): string | null {
  return network.explorerUrl ? `${network.explorerUrl}/tx/${hash}` : null;
}

export function explorerAddress(network: NetworkConfig, address: string): string | null {
  return network.explorerUrl ? `${network.explorerUrl}/address/${address}` : null;
}
