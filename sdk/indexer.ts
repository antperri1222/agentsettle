import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { decodeEventLog, getAddress, type Address, type Hex, type PublicClient } from 'viem';
import { agentEscrowAbi } from './artifacts.ts';
import { explorerTx, type NetworkConfig } from './networks.ts';
import { formatUsdcUnits } from './terms.ts';
import type { JobStatus } from './client.ts';

/**
 * Event-sourced view of the escrow. Ownership and job state are derived ONLY from chain logs, never from
 * request bodies. Logs deeper than `network.confirmations` are committed; shallower logs are re-fetched on every
 * poll so a shallow reorg replaces them. Committed logs can be checkpointed to a JSON file so restarts resume
 * instead of rescanning; a proper database is the next step.
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
  arbiter: Address;
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
interface ReceiptInfo { from: Address; gasUsed: bigint; gasCostWei: bigint }

export interface IndexerOptions {
  /** Initial eth_getLogs block range. Steps down automatically (→100 →10) if the RPC refuses it. */
  blockRange?: bigint;
  /** Parallel eth_getLogs requests while catching up. */
  concurrency?: number;
  /** Max blocks scanned per poll(), so a long catch-up happens in visible, checkpointed steps. */
  maxBlocksPerPoll?: bigint;
  /** JSON file for persisting committed logs between restarts (optional). */
  checkpointFile?: string;
  /** Pace eth_getLogs to at most this many requests per second (hosted free tiers rate-limit). Unlimited if omitted. */
  requestsPerSecond?: number;
  /** Retries per request when the RPC says it is rate-limited (HTTP 429), with exponential backoff. */
  rateLimitRetries?: number;
  /** Base backoff delay in ms for rate-limit retries (doubles each attempt). */
  backoffMs?: number;
}

/** True when an RPC error means "slow down" rather than "this request is invalid". */
export function isRateLimited(e: unknown): boolean {
  for (let cur: any = e; cur; cur = cur.cause) {
    if (cur.status === 429 || cur.code === 429) return true;
    const text = `${cur.shortMessage ?? ''} ${cur.details ?? ''} ${cur.message ?? ''}`;
    if (/\b429\b|exceeded its compute units|rate limit|too many requests/i.test(text)) return true;
  }
  return false;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface SyncStatus { syncing: boolean; startBlock: string; scannedThrough: string; head: string; percent: number; blockRange: string }

const STEP_DOWN = [500n, 100n, 10n]; // Alchemy's free tier allows only 10-block eth_getLogs ranges

const toJson = (v: unknown) => JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? { $big: x.toString() } : x));
const fromJson = (s: string) => JSON.parse(s, (_k, x) => (x && typeof x === 'object' && '$big' in x ? BigInt(x.$big) : x));

export class EscrowIndexer {
  private committed: RawLog[] = [];
  private tentative: RawLog[] = [];
  private committedThrough: bigint;
  private readonly startBlock: bigint;
  private receipts = new Map<Hex, ReceiptInfo>();
  head = 0n;
  /** Number of eth_getLogs requests made (useful for tests and diagnostics). */
  logRequests = 0;
  /** Whether the most recent poll scanned all the way to the chain head (i.e. we are live, not catching up). */
  private reachedHead = false;
  private blockRange: bigint;
  private readonly concurrency: number;
  private readonly maxBlocksPerPoll: bigint;
  private readonly checkpointFile?: string;
  private readonly minIntervalMs: number;
  private readonly rateLimitRetries: number;
  private readonly backoffMs: number;
  private nextSlot = 0;
  /** Number of rate-limit (429) responses absorbed by backoff. */
  rateLimitHits = 0;
  private readonly publicClient: PublicClient;
  private readonly network: NetworkConfig;
  readonly escrow: Address;

  constructor(publicClient: PublicClient, network: NetworkConfig, escrow: Address, fromBlock: bigint, opts: IndexerOptions = {}) {
    this.publicClient = publicClient;
    this.network = network;
    this.escrow = escrow;
    this.startBlock = fromBlock;
    this.committedThrough = fromBlock - 1n;
    this.blockRange = opts.blockRange ?? STEP_DOWN[0];
    this.concurrency = Math.max(1, opts.concurrency ?? 4);
    this.maxBlocksPerPoll = opts.maxBlocksPerPoll ?? 5_000n;
    this.checkpointFile = opts.checkpointFile;
    this.minIntervalMs = opts.requestsPerSecond && opts.requestsPerSecond > 0 ? 1000 / opts.requestsPerSecond : 0;
    this.rateLimitRetries = opts.rateLimitRetries ?? 6;
    this.backoffMs = opts.backoffMs ?? 500;
    this.loadCheckpoint();
  }

  /** Waits for this request's turn so starts are spaced at least minIntervalMs apart across all workers. */
  private async pace() {
    if (!this.minIntervalMs) return;
    const now = Date.now();
    const slot = Math.max(now, this.nextSlot);
    this.nextSlot = slot + this.minIntervalMs;
    if (slot > now) await sleep(slot - now);
  }

  private loadCheckpoint() {
    if (!this.checkpointFile || !existsSync(this.checkpointFile)) return;
    try {
      const c = fromJson(readFileSync(this.checkpointFile, 'utf8'));
      // Only trust a checkpoint written for this exact chain + contract + start block.
      if (c.chainId !== this.network.chainId || getAddress(c.escrow) !== getAddress(this.escrow) || c.startBlock !== this.startBlock) return;
      this.committed = c.committed;
      this.committedThrough = c.committedThrough;
      this.blockRange = c.blockRange ?? this.blockRange;
      for (const [h, r] of c.receipts) this.receipts.set(h, r);
    } catch { /* corrupt checkpoint: rebuild from chain */ }
  }

  private saveCheckpoint() {
    if (!this.checkpointFile) return;
    mkdirSync(dirname(this.checkpointFile), { recursive: true });
    const tmp = `${this.checkpointFile}.tmp`;
    writeFileSync(tmp, toJson({
      version: 1, chainId: this.network.chainId, escrow: this.escrow, startBlock: this.startBlock,
      committedThrough: this.committedThrough, blockRange: this.blockRange, committed: this.committed,
      receipts: [...this.receipts].filter(([h]) => this.committed.some((l) => l.txHash === h)),
    }));
    renameSync(tmp, this.checkpointFile); // atomic replace
  }

  private async getLogsRange(start: bigint, end: bigint): Promise<RawLog[]> {
    let logs;
    for (let attempt = 0; ; attempt++) {
      await this.pace();
      this.logRequests++;
      try {
        logs = await this.publicClient.getLogs({ address: this.escrow, fromBlock: start, toBlock: end });
        break;
      } catch (e) {
        if (!isRateLimited(e) || attempt >= this.rateLimitRetries) throw e;
        this.rateLimitHits++;
        // Back off this request and push every worker's next slot out too, so the whole indexer slows down.
        const wait = this.backoffMs * 2 ** attempt;
        this.nextSlot = Math.max(this.nextSlot, Date.now() + wait);
        await sleep(wait);
      }
    }
    const out: RawLog[] = [];
    for (const log of logs) {
      try {
        const ev = decodeEventLog({ abi: agentEscrowAbi, data: log.data, topics: log.topics });
        if (!ev.args || !('id' in (ev.args as object))) continue; // policy/allowlist events are not job history
        out.push({ eventName: ev.eventName, args: ev.args, blockNumber: log.blockNumber!, txHash: log.transactionHash!, logIndex: log.logIndex! });
      } catch { /* unknown event: ignore */ }
    }
    return out;
  }

  /** Fetches [from, to] in chunks with bounded concurrency; steps the range down if the RPC refuses it. */
  private async fetch(from: bigint, to: bigint): Promise<RawLog[]> {
    for (;;) {
      const chunks: [bigint, bigint][] = [];
      for (let s = from; s <= to; s += this.blockRange) chunks.push([s, s + this.blockRange - 1n > to ? to : s + this.blockRange - 1n]);
      const results: RawLog[][] = new Array(chunks.length);
      let next = 0;
      let failure: unknown = null;
      const worker = async () => {
        while (failure === null && next < chunks.length) {
          const i = next++;
          try { results[i] = await this.getLogsRange(chunks[i][0], chunks[i][1]); } catch (e) { failure ??= e; }
        }
      };
      await Promise.all(Array.from({ length: Math.min(this.concurrency, chunks.length) }, worker));
      if (failure === null) return results.flat().sort((a, b) => (a.blockNumber === b.blockNumber ? a.logIndex - b.logIndex : a.blockNumber < b.blockNumber ? -1 : 1));
      if (isRateLimited(failure)) throw failure; // persistent rate limiting is not a range problem
      const smaller = STEP_DOWN.find((r) => r < this.blockRange);
      if (smaller === undefined) throw failure; // already at the smallest range: a real error
      this.blockRange = smaller; // provider refused the range (e.g. Alchemy free tier): retry smaller
    }
  }

  async poll(): Promise<void> {
    const head = await this.publicClient.getBlockNumber();
    this.head = head;
    const safe = head - BigInt(this.network.confirmations - 1); // block with exactly `confirmations` confs
    const from = this.committedThrough + 1n;
    if (from > head) { this.tentative = []; this.reachedHead = true; return; }
    const windowEnd = from + this.maxBlocksPerPoll - 1n;
    const to = windowEnd < head ? windowEnd : head;
    const logs = await this.fetch(from, to);
    const commitTo = safe < to ? safe : to;
    const nowCommitted = logs.filter((l) => l.blockNumber <= commitTo);
    // Unconfirmed logs only exist near the head; while catching up there are none.
    this.tentative = to === head ? logs.filter((l) => l.blockNumber > commitTo) : [];
    await Promise.all([...nowCommitted, ...this.tentative].map((l) => this.receipt(l.txHash)));
    this.committed.push(...nowCommitted);
    if (commitTo > this.committedThrough) this.committedThrough = commitTo;
    this.reachedHead = to === head;
    this.saveCheckpoint();
  }

  /** Polls repeatedly until caught up with the head (useful for scripts and tests). */
  async sync(maxPolls = 1_000): Promise<void> {
    for (let i = 0; i < maxPolls; i++) { await this.poll(); if (!this.status().syncing) return; }
  }

  status(): SyncStatus {
    // "Syncing" means the last scan stopped short of the head (catching up on history). Being a few blocks behind
    // between polls, or holding the newest blocks back until they are confirmed, is normal live operation.
    const total = this.head - this.startBlock + 1n;
    const done = this.committedThrough - this.startBlock + 1n;
    const syncing = !this.reachedHead;
    return {
      syncing, startBlock: String(this.startBlock), scannedThrough: String(this.committedThrough), head: String(this.head),
      percent: !syncing ? 100 : total > 0n ? Math.min(99, Number((done * 100n) / total)) : 0, blockRange: String(this.blockRange),
    };
  }

  private async receipt(hash: Hex) {
    const cached = this.receipts.get(hash);
    if (cached) return cached;
    let r;
    for (let attempt = 0; ; attempt++) {
      await this.pace();
      try { r = await this.publicClient.getTransactionReceipt({ hash }); break; }
      catch (e) {
        if (!isRateLimited(e) || attempt >= this.rateLimitRetries) throw e;
        this.rateLimitHits++;
        const wait = this.backoffMs * 2 ** attempt;
        this.nextSlot = Math.max(this.nextSlot, Date.now() + wait);
        await sleep(wait);
      }
    }
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
            id, buyer: a.buyer, provider: a.provider, agent: /^0x0+$/.test(a.agent) ? null : a.agent, arbiter: a.arbiter,
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
