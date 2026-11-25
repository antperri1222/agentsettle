import { getAddress, keccak256, recoverMessageAddress, toBytes, type Account, type Address, type Hex } from 'viem';

/**
 * AgentSettle relay: stores job terms and deliverables off-chain, addressed by their keccak256 hash (the same hash
 * recorded on-chain). The relay is NOT trusted for integrity — clients always re-hash what they receive — and it only
 * serves a job's files to wallets that are parties to that job on-chain, proven by a signed request.
 */

export type BlobKind = 'terms' | 'deliverable';
export const MAX_BLOB_BYTES = 256 * 1024;
/** Dispute statements: short signed notes from a job's parties, so an arbiter on another machine sees each side. */
export const MAX_STATEMENT_BYTES = 8 * 1024;
export const MAX_STATEMENTS_PER_JOB = 20;
export interface Statement { by: Address; text: string; at: string }
export const SIGNATURE_WINDOW_SECONDS = 300;

export const uploadMessage = (chainId: number, escrow: Address, hash: Hex, ts: number) =>
  `AgentSettle relay upload\nchain:${chainId}\nescrow:${escrow.toLowerCase()}\nhash:${hash.toLowerCase()}\nts:${ts}`;

export const readMessage = (chainId: number, escrow: Address, jobId: bigint, kind: BlobKind, ts: number) =>
  `AgentSettle relay read\nchain:${chainId}\nescrow:${escrow.toLowerCase()}\njob:${jobId}\nkind:${kind}\nts:${ts}`;

export const statementMessage = (chainId: number, escrow: Address, jobId: bigint, textHash: Hex, ts: number) =>
  `AgentSettle relay statement\nchain:${chainId}\nescrow:${escrow.toLowerCase()}\njob:${jobId}\ntext:${textHash.toLowerCase()}\nts:${ts}`;

export const statementsReadMessage = (chainId: number, escrow: Address, jobId: bigint, ts: number) =>
  `AgentSettle relay read\nchain:${chainId}\nescrow:${escrow.toLowerCase()}\njob:${jobId}\nkind:statements\nts:${ts}`;

export async function recoverSigner(message: string, signature: Hex): Promise<Address> {
  return getAddress(await recoverMessageAddress({ message, signature }));
}

export class RelayError extends Error {
  status: number;
  constructor(status: number, message: string) { super(message); this.status = status; this.name = 'RelayError'; }
}

export class RelayClient {
  readonly url: string;
  private readonly account: Account;
  private readonly chainId: number;
  private readonly escrow: Address;

  constructor(opts: { url: string; account: Account; chainId: number; escrow: Address }) {
    this.url = opts.url.replace(/\/+$/, '');
    this.account = opts.account;
    this.chainId = opts.chainId;
    this.escrow = opts.escrow;
  }

  private async sign(message: string): Promise<Hex> {
    if (!this.account.signMessage) throw new Error('Relay requires an account that can sign messages');
    return this.account.signMessage({ message });
  }

  /** Uploads content and returns its keccak256 hash (which is what goes on-chain). Idempotent. */
  async put(content: string): Promise<Hex> {
    const bytes = toBytes(content);
    if (bytes.length > MAX_BLOB_BYTES) throw new RelayError(413, `Content exceeds ${MAX_BLOB_BYTES} bytes`);
    const hash = keccak256(bytes);
    const ts = Math.floor(Date.now() / 1000);
    const signature = await this.sign(uploadMessage(this.chainId, this.escrow, hash, ts));
    const res = await fetch(`${this.url}/v1/blobs/${hash}`, {
      method: 'PUT',
      headers: { 'content-type': 'text/plain; charset=utf-8', 'x-agentsettle-timestamp': String(ts), 'x-agentsettle-signature': signature },
      body: Buffer.from(bytes),
    });
    if (!res.ok) throw new RelayError(res.status, `Relay upload failed (${res.status}): ${await res.text()}`);
    return hash;
  }

  /**
   * Fetches a job's terms or deliverable. Returns null if the relay does not have it. The content is re-hashed here
   * and rejected unless it matches `expectedHash` from the chain, so a faulty or malicious relay cannot alter it.
   */
  async getForJob(jobId: bigint, kind: BlobKind, expectedHash: Hex): Promise<string | null> {
    const ts = Math.floor(Date.now() / 1000);
    const signature = await this.sign(readMessage(this.chainId, this.escrow, jobId, kind, ts));
    const res = await fetch(`${this.url}/v1/jobs/${jobId}/${kind}`, {
      headers: { 'x-agentsettle-timestamp': String(ts), 'x-agentsettle-signature': signature },
    });
    if (res.status === 404) return null;
    if (!res.ok) throw new RelayError(res.status, `Relay read failed (${res.status}): ${await res.text()}`);
    const bytes = new Uint8Array(await res.arrayBuffer());
    if (keccak256(bytes).toLowerCase() !== expectedHash.toLowerCase()) {
      throw new RelayError(502, 'Relay returned content that does not match the on-chain hash; rejected');
    }
    return new TextDecoder().decode(bytes);
  }

  /** Posts a signed statement (e.g. a dispute reason) for a job. Only the job's parties are accepted by the relay. */
  async putStatement(jobId: bigint, text: string): Promise<void> {
    const bytes = toBytes(text);
    if (bytes.length > MAX_STATEMENT_BYTES) throw new RelayError(413, `Statement exceeds ${MAX_STATEMENT_BYTES} bytes`);
    const ts = Math.floor(Date.now() / 1000);
    const signature = await this.sign(statementMessage(this.chainId, this.escrow, jobId, keccak256(bytes), ts));
    const res = await fetch(`${this.url}/v1/jobs/${jobId}/statements`, {
      method: 'POST',
      headers: { 'content-type': 'text/plain; charset=utf-8', 'x-agentsettle-timestamp': String(ts), 'x-agentsettle-signature': signature },
      body: Buffer.from(bytes),
    });
    if (!res.ok) throw new RelayError(res.status, `Relay statement failed (${res.status}): ${await res.text()}`);
  }

  /** Reads a job's statements (parties only). Authorship is the relay-verified signer; treat the text as untrusted. */
  async getStatements(jobId: bigint): Promise<Statement[]> {
    const ts = Math.floor(Date.now() / 1000);
    const signature = await this.sign(statementsReadMessage(this.chainId, this.escrow, jobId, ts));
    const res = await fetch(`${this.url}/v1/jobs/${jobId}/statements`, {
      headers: { 'x-agentsettle-timestamp': String(ts), 'x-agentsettle-signature': signature },
    });
    if (res.status === 404) return [];
    if (!res.ok) throw new RelayError(res.status, `Relay read failed (${res.status}): ${await res.text()}`);
    return (await res.json()).statements as Statement[];
  }
}
