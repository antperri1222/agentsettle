import {
  BaseError,
  WaitForTransactionReceiptTimeoutError,
  ContractFunctionRevertedError,
  decodeEventLog,
  getAddress,
  zeroAddress,
  type Account,
  type Address,
  type Chain,
  type Hex,
  type PublicClient,
  type Transport,
  type WalletClient,
} from 'viem';
import { agentEscrowAbi, mockUsdcAbi } from './artifacts.ts';
import { FORBIDDEN_CHAIN_IDS, explorerTx, type NetworkConfig } from './networks.ts';
import { clientRefFromKey } from './terms.ts';

export const JOB_STATUS = ['None', 'Funded', 'Delivered', 'Disputed', 'Paid', 'Refunded'] as const;
export type JobStatus = (typeof JOB_STATUS)[number];

/**
 * Distinct lifecycle stages a write passes through. The dashboard must never collapse these:
 *   simulated  – eth_call succeeded; nothing broadcast
 *   broadcast  – signed tx accepted by the RPC; NOT yet on-chain
 *   confirmed  – mined with >= network.confirmations blocks on top
 *   reverted   – mined but failed (gas still spent)
 * "Settled" is a property of the job (status Paid/Refunded), not of a transaction.
 */
export type TxStage = 'simulated' | 'broadcast' | 'confirmed' | 'reverted';

export interface TxReceipt {
  action: string;
  hash: Hex;
  from: Address;
  stage: 'confirmed' | 'reverted';
  blockNumber: bigint;
  gasUsed: bigint;
  effectiveGasPrice: bigint;
  gasCostWei: bigint;
  explorerUrl: string | null;
}

export interface Job {
  id: bigint;
  buyer: Address;
  provider: Address;
  agent: Address | null;
  amount: bigint;
  deadline: bigint;
  status: JobStatus;
  termsHash: Hex;
  evidenceHash: Hex | null;
  clientRef: Hex;
}

export class AgentSettleError extends Error {
  code: string;
  constructor(code: string, message?: string) {
    super(message ?? code);
    this.code = code;
    this.name = 'AgentSettleError';
  }
}

type Wallet = WalletClient<Transport, Chain | undefined, Account>;

export interface ConnectOptions {
  network: NetworkConfig;
  publicClient: PublicClient;
  escrowAddress: Address;
  /** Optional signer. Read-only when omitted. */
  wallet?: Wallet;
  /** Anvil only: token address deployed this session (Base Sepolia uses the verified registry address). */
  expectedTokenAddress?: Address;
  onStage?: (stage: TxStage, info: { action: string; hash?: Hex }) => void;
  /** How long to wait for confirmation before reporting the transaction as pending (default 120 s). */
  confirmTimeoutMs?: number;
}

/** A transaction was broadcast but not confirmed in time. It may still confirm: never re-send blindly. */
export class TxPendingError extends AgentSettleError {
  hash: Hex;
  action: string;
  constructor(action: string, hash: Hex) {
    super('TxPending', `${action} was broadcast (${hash}) but is not confirmed yet. It may still confirm; check its status instead of retrying.`);
    this.hash = hash;
    this.action = action;
  }
}

export type TxStatus =
  | { status: 'confirmed' | 'reverted'; hash: Hex; blockNumber: bigint; confirmations: number; jobId: bigint | null; explorerUrl: string | null }
  | { status: 'pending' | 'not_found'; hash: Hex; explorerUrl: string | null };

/** Node rejected a transaction because another one from the same wallet already holds that nonce. */
export function isReplaceable(e: unknown): boolean {
  for (let cur: any = e; cur; cur = cur.cause) {
    const text = `${cur.details ?? ''} ${cur.shortMessage ?? ''}`;
    if (/replacement transaction underpriced|transaction underpriced|already known/i.test(text)) return true;
  }
  return false;
}

function decodeRevert(err: unknown): never {
  if (err instanceof BaseError) {
    const revert = err.walk((e) => e instanceof ContractFunctionRevertedError);
    if (revert instanceof ContractFunctionRevertedError) {
      const name = revert.data?.errorName ?? revert.reason ?? 'Reverted';
      throw new AgentSettleError(name, `Contract rejected the call: ${name}`);
    }
  }
  throw err;
}

export class AgentSettleClient {
  readonly network: NetworkConfig;
  readonly publicClient: PublicClient;
  readonly escrow: Address;
  readonly token: Address;
  readonly wallet?: Wallet;
  private onStage?: ConnectOptions['onStage'];
  private readonly confirmTimeoutMs: number;

  private constructor(o: ConnectOptions, token: Address) {
    this.network = o.network;
    this.publicClient = o.publicClient;
    this.escrow = getAddress(o.escrowAddress);
    this.token = token;
    this.wallet = o.wallet;
    this.onStage = o.onStage;
    this.confirmTimeoutMs = o.confirmTimeoutMs ?? 120_000;
  }

  /**
   * Connects only after verifying: RPC chain id == configured network, chain is not a forbidden mainnet,
   * the escrow has code, escrow.usdc() equals the verified/expected token, and the token has 6 decimals.
   */
  static async connect(o: ConnectOptions): Promise<AgentSettleClient> {
    const chainId = await o.publicClient.getChainId();
    if (FORBIDDEN_CHAIN_IDS.has(chainId)) throw new AgentSettleError('MainnetForbidden', `Chain ${chainId} is a mainnet; refusing to connect`);
    if (chainId !== o.network.chainId) {
      throw new AgentSettleError('WrongNetwork', `RPC reports chain ${chainId}, expected ${o.network.chainId} (${o.network.label})`);
    }
    if (o.wallet) {
      const walletChain = await o.wallet.getChainId();
      if (walletChain !== chainId) throw new AgentSettleError('WrongNetwork', `Wallet is on chain ${walletChain}, expected ${chainId}`);
    }
    const code = await o.publicClient.getCode({ address: o.escrowAddress });
    if (!code || code === '0x') throw new AgentSettleError('NoContract', `No contract at ${o.escrowAddress}`);
    const token = getAddress(
      await o.publicClient.readContract({ address: o.escrowAddress, abi: agentEscrowAbi, functionName: 'usdc' }),
    );
    const expected = o.network.usdcAddress ?? o.expectedTokenAddress;
    if (!expected) throw new AgentSettleError('NoTokenConfigured', 'No expected token address for this network');
    if (token !== getAddress(expected)) {
      throw new AgentSettleError('AssetMismatch', `Escrow settles in ${token}, expected ${expected}`);
    }
    const decimals = await o.publicClient.readContract({ address: token, abi: mockUsdcAbi, functionName: 'decimals' });
    if (decimals !== 6) throw new AgentSettleError('AssetMismatch', `Token has ${decimals} decimals, expected 6`);
    return new AgentSettleClient(o, token);
  }

  get account(): Address {
    if (!this.wallet) throw new AgentSettleError('NoSigner', 'This client is read-only');
    return this.wallet.account.address;
  }

  // ───────────── reads ─────────────

  async getJob(id: bigint): Promise<Job> {
    const j = await this.publicClient.readContract({ address: this.escrow, abi: agentEscrowAbi, functionName: 'getJob', args: [id] });
    return {
      id,
      buyer: j.buyer,
      provider: j.provider,
      agent: j.agent === zeroAddress ? null : j.agent,
      amount: j.amount,
      deadline: j.deadline,
      status: JOB_STATUS[j.status],
      termsHash: j.termsHash,
      evidenceHash: /^0x0+$/.test(j.evidenceHash) ? null : j.evidenceHash,
      clientRef: j.clientRef,
    };
  }

  async quote(amount: bigint): Promise<{ providerPayout: bigint; protocolFee: bigint }> {
    const [providerPayout, protocolFee] = await this.publicClient.readContract({
      address: this.escrow, abi: agentEscrowAbi, functionName: 'quote', args: [amount],
    });
    return { providerPayout, protocolFee };
  }

  async tokenBalance(who: Address): Promise<bigint> {
    return this.publicClient.readContract({ address: this.token, abi: mockUsdcAbi, functionName: 'balanceOf', args: [who] });
  }

  async allowance(owner: Address): Promise<bigint> {
    return this.publicClient.readContract({ address: this.token, abi: mockUsdcAbi, functionName: 'allowance', args: [owner, this.escrow] });
  }

  async jobIdByRef(buyer: Address, clientRef: Hex): Promise<bigint> {
    return this.publicClient.readContract({ address: this.escrow, abi: agentEscrowAbi, functionName: 'jobIdByRef', args: [buyer, clientRef] });
  }

  // ───────────── writes ─────────────

  /** simulate -> sign+broadcast -> wait for confirmations. Reverts are decoded before anything is broadcast. */
  private async send(action: string, address: Address, abi: any, functionName: string, args: readonly unknown[]): Promise<TxReceipt> {
    const wallet = this.wallet;
    if (!wallet) throw new AgentSettleError('NoSigner', 'This client is read-only');
    let request;
    try {
      ({ request } = await this.publicClient.simulateContract({ address, abi, functionName, args, account: wallet.account } as any));
    } catch (e) {
      decodeRevert(e);
    }
    this.onStage?.('simulated', { action });
    // If an earlier transaction from this wallet is stuck at the same nonce, the node rejects ours as underpriced.
    // Re-send with escalating fees (x2, x4, x8) so the new transaction replaces the stuck one.
    // Fee headroom: cap at 2x the current estimate so a base-fee rise doesn't strand the transaction. Only the actual
    // base fee + tip is charged, so the headroom costs nothing unless it is needed.
    const est = await this.publicClient.estimateFeesPerGas();
    const tip = est.maxPriorityFeePerGas > 0n ? est.maxPriorityFeePerGas : 1_000_000n;
    let fees = { maxFeePerGas: est.maxFeePerGas * 2n + tip, maxPriorityFeePerGas: tip };
    let hash: Hex | undefined;
    for (let attempt = 0; ; attempt++) {
      try {
        hash = await wallet.writeContract({ ...(request as any), ...fees });
        break;
      } catch (e) {
        // An earlier transaction from this wallet holds the same nonce: re-send with 2x/4x/8x fees to replace it.
        if (!isReplaceable(e) || attempt >= 3) throw e;
        const mult = 2n ** BigInt(attempt + 1);
        fees = { maxFeePerGas: fees.maxFeePerGas * 2n, maxPriorityFeePerGas: fees.maxPriorityFeePerGas * 2n };
        this.onStage?.('simulated', { action: `${action} (re-sending with ${mult}x fees to replace a stuck transaction)` });
      }
    }
    this.onStage?.('broadcast', { action, hash });
    let r;
    try {
      r = await this.publicClient.waitForTransactionReceipt({ hash, confirmations: this.network.confirmations, timeout: this.confirmTimeoutMs });
    } catch (e) {
      if (e instanceof WaitForTransactionReceiptTimeoutError) throw new TxPendingError(action, hash);
      throw e;
    }
    const stage = r.status === 'success' ? 'confirmed' : 'reverted';
    this.onStage?.(stage, { action, hash });
    const receipt: TxReceipt = {
      action, hash, from: wallet.account.address, stage, blockNumber: r.blockNumber, gasUsed: r.gasUsed,
      effectiveGasPrice: r.effectiveGasPrice, gasCostWei: r.gasUsed * r.effectiveGasPrice, explorerUrl: explorerTx(this.network, hash),
    };
    if (stage === 'reverted') throw Object.assign(new AgentSettleError('TxReverted', `${action} reverted on-chain (${hash})`), { receipt });
    return receipt;
  }

  /** Where a broadcast transaction stands. For a job creation, also returns the new job id once confirmed. */
  async txStatus(hash: Hex): Promise<TxStatus> {
    const explorerUrl = explorerTx(this.network, hash);
    const r = await this.publicClient.getTransactionReceipt({ hash }).catch(() => null);
    if (r) {
      const head = await this.publicClient.getBlockNumber();
      let jobId: bigint | null = null;
      for (const log of r.logs) {
        if (getAddress(log.address) !== this.escrow) continue;
        try {
          const ev = decodeEventLog({ abi: agentEscrowAbi, data: log.data, topics: log.topics });
          if (ev.eventName === 'JobCreated') jobId = ev.args.id;
        } catch {}
      }
      return { status: r.status === 'success' ? 'confirmed' : 'reverted', hash, blockNumber: r.blockNumber, confirmations: Number(head - r.blockNumber + 1n), jobId, explorerUrl };
    }
    const tx = await this.publicClient.getTransaction({ hash }).catch(() => null);
    return { status: tx ? 'pending' : 'not_found', hash, explorerUrl };
  }

  /** Approves EXACTLY `amount` (never unlimited). USDC approve overwrites the previous allowance. */
  approveSpend(amount: bigint): Promise<TxReceipt> {
    if (amount <= 0n) throw new AgentSettleError('InvalidAmount');
    return this.send('approveSpend', this.token, mockUsdcAbi, 'approve', [this.escrow, amount]);
  }

  /**
   * Fund a job. Idempotent: the clientRef is derived from `idempotencyKey`; if a job already exists for
   * (buyer, clientRef) it is returned instead of funding twice. The contract also rejects duplicates.
   * Pass `owner` to fund as a delegated agent under the owner's on-chain SpendPolicy.
   */
  async createJob(p: {
    provider: Address; amount: bigint; deadline: bigint; termsHash: Hex; idempotencyKey: string; owner?: Address;
  }): Promise<{ jobId: bigint; reused: boolean; receipt: TxReceipt | null }> {
    const clientRef = clientRefFromKey(p.idempotencyKey);
    const buyer = p.owner ?? this.account;
    const existing = await this.jobIdByRef(buyer, clientRef);
    if (existing !== 0n) {
      const job = await this.getJob(existing);
      const same = job.provider === getAddress(p.provider) && job.amount === p.amount && job.termsHash === p.termsHash;
      if (!same) throw new AgentSettleError('IdempotencyConflict', 'Idempotency key was already used with different parameters');
      return { jobId: existing, reused: true, receipt: null };
    }
    const receipt = p.owner
      ? await this.send('createJobAsAgent', this.escrow, agentEscrowAbi, 'createJobAsAgent', [p.owner, p.provider, p.amount, p.deadline, p.termsHash, clientRef])
      : await this.send('createJob', this.escrow, agentEscrowAbi, 'createJob', [p.provider, p.amount, p.deadline, p.termsHash, clientRef]);
    const r = await this.publicClient.getTransactionReceipt({ hash: receipt.hash });
    for (const log of r.logs) {
      if (getAddress(log.address) !== this.escrow) continue;
      try {
        const ev = decodeEventLog({ abi: agentEscrowAbi, data: log.data, topics: log.topics });
        if (ev.eventName === 'JobCreated') return { jobId: ev.args.id, reused: false, receipt };
      } catch {}
    }
    throw new AgentSettleError('MissingEvent', 'JobCreated event not found in receipt');
  }

  deliver(id: bigint, evidenceHash: Hex) { return this.send('deliver', this.escrow, agentEscrowAbi, 'deliver', [id, evidenceHash]); }
  approve(id: bigint) { return this.send('approve', this.escrow, agentEscrowAbi, 'approve', [id]); }
  dispute(id: bigint) { return this.send('dispute', this.escrow, agentEscrowAbi, 'dispute', [id]); }
  resolve(id: bigint, payProvider: boolean) { return this.send('resolve', this.escrow, agentEscrowAbi, 'resolve', [id, payProvider]); }
  refundExpired(id: bigint) { return this.send('refundExpired', this.escrow, agentEscrowAbi, 'refundExpired', [id]); }
  providerRefund(id: bigint) { return this.send('providerRefund', this.escrow, agentEscrowAbi, 'providerRefund', [id]); }

  // ───────────── delegated spend policy (owner-signed) ─────────────

  setPolicy(agent: Address, perJobCap: bigint, dailyCap: bigint, expiresAt: bigint) {
    return this.send('setPolicy', this.escrow, agentEscrowAbi, 'setPolicy', [agent, perJobCap, dailyCap, expiresAt]);
  }
  revokePolicy(agent: Address) { return this.send('revokePolicy', this.escrow, agentEscrowAbi, 'revokePolicy', [agent]); }
  setProviderAllowed(agent: Address, provider: Address, allowed: boolean) {
    return this.send('setProviderAllowed', this.escrow, agentEscrowAbi, 'setProviderAllowed', [agent, provider, allowed]);
  }
}
