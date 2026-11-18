// AgentSettle relay: content-addressed storage for job terms and deliverables, readable only by a job's parties.
//
//   npm run relay        (reads .env; listens on RELAY_PORT, default 8787)
//
// Trust model: the relay cannot tamper (clients verify keccak256 against the chain) but it CAN see content and
// withhold it. Reads require a fresh wallet signature; the signer must be the job's buyer, buyer agent, provider or
// arbiter ON-CHAIN. Request bodies never establish identity. No keys are held here.
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPublicClient, getAddress, http, isHex, keccak256, zeroAddress, type Address, type Chain, type Hex, type PublicClient } from 'viem';
import { baseSepolia } from 'viem/chains';
import { agentEscrowAbi } from '../sdk/artifacts.ts';
import { localChain } from '../sdk/local.ts';
import { getNetwork } from '../sdk/networks.ts';
import { MAX_BLOB_BYTES, SIGNATURE_WINDOW_SECONDS, readMessage, recoverSigner, uploadMessage, type BlobKind } from '../sdk/relay.ts';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const log = (...a: unknown[]) => console.error('[relay]', ...a);

export interface RelayOptions {
  network: string;
  rpcUrl: string;
  escrow: Address;
  dataDir: string;
  /** Uploads allowed per signer per minute. */
  uploadsPerMinute?: number;
}

export function createRelay(opts: RelayOptions) {
  const network = getNetwork(opts.network);
  const chain: Chain = network.name === 'anvil' ? localChain(opts.rpcUrl) : baseSepolia;
  const pub = createPublicClient({ chain, transport: http(opts.rpcUrl) }) as PublicClient;
  const escrow = getAddress(opts.escrow);
  const blobs = join(opts.dataDir, 'blobs');
  mkdirSync(blobs, { recursive: true });
  const perMinute = opts.uploadsPerMinute ?? 30;
  const uploads = new Map<string, number[]>();
  let arbiter: Address | null = null;

  const send = (res: ServerResponse, status: number, body: unknown, type = 'application/json') => {
    res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
    res.end(type === 'application/json' ? JSON.stringify(body) : (body as Buffer));
  };

  async function readBody(req: IncomingMessage): Promise<Buffer> {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const c of req) {
      size += c.length;
      if (size > MAX_BLOB_BYTES) throw Object.assign(new Error(`Body exceeds ${MAX_BLOB_BYTES} bytes`), { status: 413 });
      chunks.push(c);
    }
    return Buffer.concat(chunks);
  }

  async function authenticate(req: IncomingMessage, message: (ts: number) => string): Promise<Address> {
    const ts = Number(req.headers['x-agentsettle-timestamp']);
    const sig = req.headers['x-agentsettle-signature'];
    if (!Number.isInteger(ts) || typeof sig !== 'string' || !isHex(sig)) throw Object.assign(new Error('Missing or malformed signature headers'), { status: 401 });
    if (Math.abs(Date.now() / 1000 - ts) > SIGNATURE_WINDOW_SECONDS) throw Object.assign(new Error('Signature timestamp outside the allowed window'), { status: 401 });
    try { return await recoverSigner(message(ts), sig as Hex); } catch { throw Object.assign(new Error('Invalid signature'), { status: 401 }); }
  }

  function rateLimit(signer: Address) {
    const now = Date.now();
    const recent = (uploads.get(signer) ?? []).filter((t) => now - t < 60_000);
    if (recent.length >= perMinute) throw Object.assign(new Error('Too many uploads; slow down'), { status: 429 });
    recent.push(now);
    uploads.set(signer, recent);
  }

  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://relay');
      if (req.method === 'GET' && url.pathname === '/health') {
        return send(res, 200, { ok: true, network: network.name, chainId: network.chainId, escrow });
      }

      const put = url.pathname.match(/^\/v1\/blobs\/(0x[0-9a-fA-F]{64})$/);
      if (req.method === 'PUT' && put) {
        const hash = put[1].toLowerCase() as Hex;
        const signer = await authenticate(req, (ts) => uploadMessage(network.chainId, escrow, hash, ts));
        rateLimit(signer);
        const body = await readBody(req);
        if (keccak256(body).toLowerCase() !== hash) return send(res, 400, { error: 'Body does not match hash' });
        const file = join(blobs, hash);
        if (!existsSync(file)) {
          writeFileSync(`${file}.tmp`, body);
          renameSync(`${file}.tmp`, file);
          log(`stored ${hash} (${body.length} bytes) from ${signer}`);
        }
        return send(res, 200, { hash, bytes: body.length });
      }

      const get = url.pathname.match(/^\/v1\/jobs\/(\d{1,20})\/(terms|deliverable)$/);
      if (req.method === 'GET' && get) {
        const jobId = BigInt(get[1]);
        const kind = get[2] as BlobKind;
        const signer = await authenticate(req, (ts) => readMessage(network.chainId, escrow, jobId, kind, ts));
        const job = await pub.readContract({ address: escrow, abi: agentEscrowAbi, functionName: 'getJob', args: [jobId] });
        if (job.status === 0) return send(res, 404, { error: 'No such job' });
        arbiter ??= getAddress(await pub.readContract({ address: escrow, abi: agentEscrowAbi, functionName: 'arbiter' }));
        const parties = [job.buyer, job.provider, job.agent, arbiter].filter((a) => a !== zeroAddress).map((a) => getAddress(a));
        if (!parties.includes(signer)) return send(res, 403, { error: 'Signer is not a party to this job' });
        const hash = (kind === 'terms' ? job.termsHash : job.evidenceHash).toLowerCase();
        if (/^0x0+$/.test(hash)) return send(res, 404, { error: 'Nothing recorded on-chain yet' });
        const file = join(blobs, hash);
        if (!existsSync(file)) return send(res, 404, { error: 'Content not uploaded to this relay' });
        return send(res, 200, readFileSync(file), 'application/octet-stream');
      }

      return send(res, 404, { error: 'Not found' });
    } catch (e) {
      const status = (e as { status?: number }).status ?? 500;
      if (status === 500) log('error', e);
      return send(res, status, { error: status === 500 ? 'Internal error' : (e as Error).message });
    }
  });
  return server;
}

// ── CLI entry ──
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const envFile = join(REPO, '.env');
  if (existsSync(envFile)) process.loadEnvFile(envFile);
  const name = process.env.AGENTSETTLE_NETWORK || 'anvil';
  let rpcUrl: string, escrow: string;
  if (name === 'anvil') {
    const d = JSON.parse(readFileSync(process.env.AGENTSETTLE_LOCAL_FILE || join(REPO, '.agentsettle', 'local.json'), 'utf8'));
    rpcUrl = d.rpcUrl; escrow = d.escrow;
  } else {
    rpcUrl = process.env.BASE_SEPOLIA_RPC_URL || getNetwork(name).defaultRpcUrl;
    if (!process.env.ESCROW_ADDRESS) { log('ESCROW_ADDRESS is not set'); process.exit(1); }
    escrow = process.env.ESCROW_ADDRESS;
  }
  // Hosts like Railway/Render inject PORT and need 0.0.0.0; locally default to loopback only.
  const port = Number(process.env.RELAY_PORT || process.env.PORT || 8787);
  const host = process.env.RELAY_HOST || (process.env.PORT ? '0.0.0.0' : '127.0.0.1');
  const dataDir = process.env.RELAY_DATA_DIR || join(REPO, '.agentsettle', 'relay');
  createRelay({ network: name, rpcUrl, escrow: escrow as Address, dataDir }).listen(port, host, () => {
    log(`listening on http://${host}:${port} · ${getNetwork(name).label} · escrow ${escrow} · data ${dataDir}`);
  });
}
