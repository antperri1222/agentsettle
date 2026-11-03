import { decodeEventLog, getAddress, type Address, type Hex, type PublicClient } from 'viem';
import { agentEscrowAbi } from './artifacts.ts';
import { explorerTx, type NetworkConfig } from './networks.ts';
import { formatUsdcUnits } from './terms.ts';
import type { JobStatus } from './client.ts';

/**
 * Event-sourced view of the escrow. Ownership and job state are derived ONLY from chain logs, never from
 * request bodies. Logs deeper than `network.confirmations` are committed; shallower logs are re-fetched on every
 * poll so a shallow reorg replaces them. In-memory for now; a persistent store (Postgres) is the next step.
 */

export type EventFinality = 'included' | 'confirmed';

export interface IndexedEvent {
  type: string;
  jobId: string;
  blockNumber: string;
  txHash: Hex;
  logIndex: number;
  from: Address | null;
  gasUsed: string | null;
  gasCostWei: string | null;
  finality: EventFinality;
  confirmations: number;
  explorerUrl: string | null;
  detail: Record<string, string>;
}

export interface IndexedJob {
  id: string;
  buyer: Address;
  provider: Address;
  agent: Address | null;
  amount: string;
  amountUnits: string;
  deadline: string;
  termsHash: Hex;
  clientRef: Hex;
  evidenceHash: Hex | null;
  status: JobStatus;
  /** True once the terminal (Paid/Refunded) event has reached the confirmation threshold. */
  settled: boolean;
  payout: string | null;
  fee: string | null;
  totalGasCostWei: string;
  events: IndexedEvent[];
}

interface RawLog { eventName: string; args: any; blockNumber: bigint; txHash: Hex; logIndex: number }

const CHUNK = 2_000n;

export class EscrowIndexer {
  private committed: RawLog[] = [];
  private tentative: RawLog[] = [];
  private committedThrough: bigint;
  private receipts = new Map<Hex, { from: Address; gasUsed: bigint; gasCostWei: bigint }>();
  head = 0n;
  private readonly publicClient: PublicClient;
  private readonly network: NetworkConfig;
  readonly escrow: Address;

  constructor(publicClient: PublicClient, network: NetworkConfig, escrow: Address, fromBlock: bigint) {
    this.publicClient = publicClient;
    this.network = network;
    this.escrow = escrow;
    this.committedThrough = fromBlock - 1n;
  }

  private async fetch(from: bigint, to: bigint): Promise<RawLog[]> {
    const out: RawLog[] = [];
    for (let start = from; start <= to; start += CHUNK) {
      const end = start + CHUNK - 1n > to ? to : start + CHUNK - 1n;
      const logs = await this.publicClient.getLogs({ address: this.escrow, fromBlock: start, toBlock: end });
      for (const log of logs) {
        try {
          const ev = decodeEventLog({ abi: agentEscrowAbi, data: log.data, topics: log.topics });
          out.push({ eventName: ev.eventName, args: ev.args, blockNumber: log.blockNumber!, txHash: log.transactionHash!, logIndex: log.logIndex! });
        } catch { /* unknown event: ignore */ }
      }
    }
    return out;
  }

  async poll(): Promise<void> {
    const head = await this.publicClient.getBlockNumber();
    this.head = head;
    const safe = head - BigInt(this.network.confirmations - 1); // block with exactly `confirmations` confs
    const from = this.committedThrough + 1n;
    if (from > head) { this.tentative = []; return; }
    const logs = await this.fetch(from, head);
    const nowCommitted = logs.filter((l) => l.blockNumber <= safe);
    this.tentative = logs.filter((l) => l.blockNumber > safe);
    this.committed.push(...nowCommitted);
    if (safe > this.committedThrough) this.committedThrough = safe;
    await Promise.all([...nowCommitted, ...this.tentative].map((l) => this.receipt(l.txHash)));
  }

  private async receipt(hash: Hex) {
    const cached = this.receipts.get(hash);
    if (cached) return cached;
    const r = await this.publicClient.getTransactionReceipt({ hash });
    const v = { from: getAddress(r.from), gasUsed: r.gasUsed, gasCostWei: r.gasUsed * r.effectiveGasPrice };
    this.receipts.set(hash, v);
    return v;
  }

  jobs(): IndexedJob[] {
    const map = new Map<string, IndexedJob>();
    const all = [...this.committed.map((l) => [l, true] as const), ...this.tentative.map((l) => [l, false] as const)];
    for (const [log, isCommitted] of all) {
      const id = String(log.args.id);
      const rc = this.receipts.get(log.txHash);
      const confs = Number(this.head - log.blockNumber + 1n);
      const ev: IndexedEvent = {
        type: log.eventName, jobId: id, blockNumber: String(log.blockNumber), txHash: log.txHash, logIndex: log.logIndex,
        from: rc?.from ?? null, gasUsed: rc ? String(rc.gasUsed) : null, gasCostWei: rc ? String(rc.gasCostWei) : null,
        finality: isCommitted ? 'confirmed' : 'included', confirmations: confs,
        explorerUrl: explorerTx(this.network, log.txHash), detail: {},
      };
      let job = map.get(id);
      switch (log.eventName) {
        case 'JobCreated': {
          const a = log.args;
          job = {
            id, buyer: a.buyer, provider: a.provider, agent: /^0x0+$/.test(a.agent) ? null : a.agent,
            amount: formatUsdcUnits(a.amount), amountUnits: String(a.amount), deadline: String(a.deadline),
            termsHash: a.termsHash, clientRef: a.clientRef, evidenceHash: null, status: 'Funded', settled: false,
            payout: null, fee: null, totalGasCostWei: '0', events: [],
          };
          ev.detail = { amount: formatUsdcUnits(a.amount), viaAgent: job.agent ? 'yes' : 'no' };
          map.set(id, job);
          break;
        }
        case 'EvidenceSubmitted':
          if (job) { job.status = 'Delivered'; job.evidenceHash = log.args.evidenceHash; ev.detail = { evidenceHash: log.args.evidenceHash }; }
          break;
        case 'DisputeOpened':
          if (job) { job.status = 'Disputed'; ev.detail = { by: log.args.by }; }
          break;
        case 'PaymentReleased':
          if (job) {
            job.status = 'Paid'; job.settled = isCommitted;
            job.payout = formatUsdcUnits(log.args.providerPayout); job.fee = formatUsdcUnits(log.args.protocolFee);
            ev.detail = { providerPayout: job.payout, protocolFee: job.fee };
          }
          break;
        case 'JobRefunded':
          if (job) { job.status = 'Refunded'; job.settled = isCommitted; ev.detail = { amount: formatUsdcUnits(log.args.amount) }; }
          break;
        default:
          continue; // policy events are not job events
      }
      if (job) {
        job.events.push(ev);
        if (rc) job.totalGasCostWei = String(BigInt(job.totalGasCostWei) + rc.gasCostWei);
      }
    }
    return [...map.values()].sort((a, b) => Number(BigInt(b.id) - BigInt(a.id)));
  }

  /** Cross-checks event-derived status against contract storage. Returns mismatching job ids (should be empty). */
  async reconcile(): Promise<string[]> {
    const { JOB_STATUS } = await import('./client.ts');
    const bad: string[] = [];
    for (const j of this.jobs()) {
      const onchain = await this.publicClient.readContract({ address: this.escrow, abi: agentEscrowAbi, functionName: 'getJob', args: [BigInt(j.id)] });
      if (JOB_STATUS[onchain.status] !== j.status || onchain.amount !== BigInt(j.amountUnits)) bad.push(j.id);
    }
    return bad;
  }
}
