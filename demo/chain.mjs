// Read-only on-chain view for the dashboard. Holds NO private keys and accepts NO actor claims:
// every value comes from chain state or indexed events. Loaded lazily so simulation mode never needs a chain.
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const LOCAL_FILE = fileURLToPath(new URL('../.agentsettle/local.json', import.meta.url));
const POLL_MS = process.env.AGENTSETTLE_NETWORK === 'base-sepolia' ? 4000 : 1500; // be gentle with hosted RPC quotas

function resolveConfig(env = process.env) {
  const name = env.AGENTSETTLE_NETWORK || (existsSync(LOCAL_FILE) ? 'anvil' : '');
  if (!name) return { enabled: false, reason: 'No chain configured. Run `npm run chain:up` (local Anvil) or set AGENTSETTLE_NETWORK.' };
  if (name === 'anvil') {
    if (!existsSync(LOCAL_FILE)) return { enabled: false, reason: 'Anvil selected but .agentsettle/local.json is missing. Run `npm run chain:up`.' };
    const d = JSON.parse(readFileSync(LOCAL_FILE, 'utf8'));
    return { enabled: true, name, rpcUrl: d.rpcUrl, escrow: d.escrow, token: d.token, deployBlock: BigInt(d.deployBlock), roles: d.roles };
  }
  if (name === 'base-sepolia') {
    if (!env.ESCROW_ADDRESS || !env.ESCROW_DEPLOY_BLOCK) {
      return { enabled: false, reason: 'Base Sepolia selected but ESCROW_ADDRESS / ESCROW_DEPLOY_BLOCK are not set. No contract is deployed yet.' };
    }
    const roles = {};
    for (const [k, v] of Object.entries({ owner: env.OWNER_ADDRESS, buyerAgent: env.BUYER_AGENT_ADDRESS, providerAgent: env.PROVIDER_AGENT_ADDRESS })) if (v) roles[k] = v;
    return { enabled: true, name, rpcUrl: env.BASE_SEPOLIA_RPC_URL || null, escrow: env.ESCROW_ADDRESS, token: null, deployBlock: BigInt(env.ESCROW_DEPLOY_BLOCK), roles };
  }
  return { enabled: false, reason: `Unsupported network "${name}". Only anvil and base-sepolia are allowed.` };
}

export async function createChainView(env = process.env) {
  const cfg = resolveConfig(env);
  if (!cfg.enabled) return { state: async () => ({ enabled: false, reason: cfg.reason }) };

  const { createPublicClient, http } = await import('viem');
  const { getNetwork, explorerAddress } = await import('../sdk/networks.ts');
  const { AgentSettleClient } = await import('../sdk/client.ts');
  const { EscrowIndexer } = await import('../sdk/indexer.ts');
  const { agentEscrowAbi } = await import('../sdk/artifacts.ts');
  const { formatUsdcUnits } = await import('../sdk/terms.ts');

  const network = getNetwork(cfg.name);
  const rpcUrl = cfg.rpcUrl || network.defaultRpcUrl;
  const publicClient = createPublicClient({ transport: http(rpcUrl) });
  let client = null;
  let indexer = null;
  let lastError = null;
  let lastPoll = 0;
  let snapshot = null;

  let inFlight = null;
  let lastLogged = null;

  async function ensure() {
    if (client) return;
    client = await AgentSettleClient.connect({ network, publicClient, escrowAddress: cfg.escrow, expectedTokenAddress: cfg.token ?? undefined });
    const checkpointFile = fileURLToPath(new URL(`../.agentsettle/index-${network.name}-${client.escrow.toLowerCase()}.json`, import.meta.url));
    // Gentle defaults for hosted free tiers (Alchemy free allows 10-block eth_getLogs ranges; the indexer adapts).
    const concurrency = Number(process.env.INDEXER_CONCURRENCY || 2);
    indexer = new EscrowIndexer(publicClient, network, client.escrow, cfg.deployBlock, { checkpointFile, concurrency, maxBlocksPerPoll: 2_000n });
  }

  async function refresh() {
    await ensure();
    await indexer.poll();
    const jobs = indexer.jobs();
    const roleLabels = Object.fromEntries(Object.entries(cfg.roles).map(([k, v]) => [v.toLowerCase(), k]));
    const balances = {};
    for (const [role, addr] of Object.entries(cfg.roles)) {
      if (['deployer', 'stranger'].includes(role)) continue;
      balances[role] = formatUsdcUnits(await client.tokenBalance(addr));
    }
    balances.escrowContract = formatUsdcUnits(await client.tokenBalance(client.escrow));
    let policy = null;
    if (cfg.roles.owner && cfg.roles.buyerAgent) {
      const [perJobCap, dailyCap, expiresAt, active] = await publicClient.readContract({
        address: client.escrow, abi: agentEscrowAbi, functionName: 'policies', args: [cfg.roles.owner, cfg.roles.buyerAgent],
      });
      const block = await publicClient.getBlock();
      const day = block.timestamp / 86400n;
      const spent = await publicClient.readContract({
        address: client.escrow, abi: agentEscrowAbi, functionName: 'spentPerDay', args: [cfg.roles.owner, cfg.roles.buyerAgent, day],
      });
      const allowed = cfg.roles.providerAgent ? await publicClient.readContract({
        address: client.escrow, abi: agentEscrowAbi, functionName: 'providerAllowed', args: [cfg.roles.owner, cfg.roles.buyerAgent, cfg.roles.providerAgent],
      }) : null;
      policy = {
        active: active && block.timestamp < expiresAt, perJobCap: formatUsdcUnits(perJobCap), dailyCap: formatUsdcUnits(dailyCap),
        spentToday: formatUsdcUnits(spent), expiresAt: String(expiresAt), providerAllowed: allowed,
      };
    }
    snapshot = {
      enabled: true,
      mode: network.name === 'anvil' ? 'LOCAL_CHAIN' : 'TESTNET',
      network: { name: network.name, label: network.label, chainId: network.chainId, confirmations: network.confirmations, explorerUrl: network.explorerUrl },
      escrow: client.escrow, escrowUrl: explorerAddress(network, client.escrow),
      token: client.token, tokenUrl: explorerAddress(network, client.token),
      head: String(indexer.head), roleLabels, balances, policy, jobs, sync: indexer.status(),
      polledAt: new Date().toISOString(),
    };
    lastError = null;
  }

  function kick() {
    // Refresh in the background so a long history catch-up never blocks the HTTP response.
    const syncing = indexer?.status().syncing;
    if (inFlight || (!syncing && Date.now() - lastPoll < POLL_MS)) return;
    lastPoll = Date.now();
    inFlight = refresh()
      .catch((e) => {
        lastError = e instanceof Error ? (e.shortMessage ?? e.message.split('\n')[0]) : String(e);
        const full = e instanceof Error ? e.message : String(e);
        // Full detail to the server terminal (RPC URLs redacted), once per distinct error.
        if (full !== lastLogged) { lastLogged = full; console.error('[chain view]', full.replace(/(\/v2\/|\/v3\/)[^\s/"]+/g, '$1<redacted>')); }
      })
      .finally(() => { inFlight = null; });
  }

  return {
    async state() {
      kick();
      if (!snapshot) {
        if (indexer) {
          const s = indexer.status();
          if (s.syncing) return { enabled: false, reason: `Indexing contract history: ${s.percent}% (block ${s.scannedThrough} of ${s.head}, ${s.blockRange}-block requests)…` };
        }
        return { enabled: false, reason: lastError ? `Chain not reachable: ${lastError}` : 'Connecting to chain…' };
      }
      return { ...snapshot, stale: Boolean(lastError), error: lastError };
    },
  };
}
