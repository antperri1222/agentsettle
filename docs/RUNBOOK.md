# Runbook — local chain and Base Sepolia (testnet only)

Mainnet is out of scope. There is no mainnet entry in `sdk/networks.ts`, the SDK refuses known mainnet chain IDs, and the deploy script refuses any chain other than 84532.

## 0. Prerequisites

| Tool | Version used | Install |
|---|---|---|
| Node.js | ≥ 22.18 (runs `.ts` directly via built-in type stripping) | nodejs.org / nvm |
| Foundry (forge, anvil, cast) | 1.5.1-stable | `curl -L https://foundry.paradigm.xyz \| bash && foundryup` |
| solc | 0.8.24 (pinned in `contracts/foundry.toml`) | fetched by forge automatically |
| OpenZeppelin Contracts | v5.6.1 (pinned) | `npm run setup:contracts` |
| forge-std | v1.17.0 (pinned) | `npm run setup:contracts` |
| viem | 2.x | `npm install` |

OpenZeppelin v5.7.0 also exists; upgrading is a deliberate, reviewed change, not a drive-by.

## 1. Test commands

```bash
npm install
npm run setup:contracts       # OZ + forge-std into contracts/lib (gitignored)
npm test                      # simulator + SDK unit tests (no chain)
npm run test:contracts        # Foundry: unit, negative, adversarial tokens, fuzz (1000 runs), invariants (256×64)
npm run test:e2e              # spawns a throwaway Anvil and runs real signed transactions
npm run typecheck
npm run test:all              # everything above
```

After changing Solidity: `npm run build:contracts` regenerates `sdk/artifacts.ts`. Commit it.

## 2. Local chain demo

```bash
# terminal 1 — Anvil + MockUSDC (TEST ONLY) + AgentEscrow; writes .agentsettle/local.json
npm run chain:up
# terminal 2 — dashboard on http://127.0.0.1:3000 (switch to "On-chain")
npm run dev
# terminal 3 — owner sets policy; buyer/provider/arbiter agents sign real txs
npm run agents:demo
```

Anvil uses its public default mnemonic. Those keys are refused on every chain except 31337.

## 3. Base Sepolia deployment (REQUIRES EXPLICIT AUTHORIZATION — NOT YET PERFORMED)

Do not run this until the project owner has explicitly approved a testnet deployment.

### 3.1 Prepare keys (never paste keys or seed phrases into chat or prompts)
- Create **separate** keys for: deployer, arbiter, treasury, owner (human budget), buyer agent, provider agent.
- Store the deployer in a Foundry keystore: `cast wallet import agentsettle-deployer --interactive`.
- Fund only the deployer and agent keys with a small amount of Base Sepolia ETH from a faucet.
- Get test USDC from Circle's faucet (https://faucet.circle.com) for the owner key only.

### 3.2 Re-verify configuration on the day of deployment
- USDC (Base Sepolia): `0x036CbD53842c5426634e7929541eC2318f3dCF7e`, from https://developers.circle.com/stablecoins/usdc-contract-addresses (verified 2026-11-03).
- Chain ID 84532, explorer https://sepolia.basescan.org, from https://docs.base.org (verified 2026-11-03).
- The public RPC `https://sepolia.base.org` is rate-limited. Use a provider RPC URL kept in `.env`, never committed.

### 3.3 Create `.env` in the project root (never commit it; it is gitignored)
```bash
BASE_SEPOLIA_RPC_URL=https://base-sepolia.g.alchemy.com/v2/<your-key>
DEPLOYER_ADDRESS=0x...
TREASURY_ADDRESS=0x...
ARBITER_ADDRESS=0x...
OWNER_ADDRESS=0x...
BUYER_AGENT_ADDRESS=0x...
PROVIDER_AGENT_ADDRESS=0x...
# filled in after deployment:
# AGENTSETTLE_NETWORK=base-sepolia
# ESCROW_ADDRESS=0x...
# ESCROW_DEPLOY_BLOCK=...
```

### 3.4 Dry run (simulates against Base Sepolia, sends nothing)
```bash
set -a; source .env; set +a
cd contracts
CONFIRM_TESTNET_DEPLOY=base-sepolia forge script script/DeployBaseSepolia.s.sol \
  --rpc-url "$BASE_SEPOLIA_RPC_URL" --account agentsettle-deployer --sender "$DEPLOYER_ADDRESS"
```
The script refuses unless: chain = 84532; the verified USDC address has code, 6 decimals and symbol `USDC`; treasury is set and ≠ deployer; fee ≤ 10%. (v2 has no deployment-wide arbiter; each job names one.)

### 3.5 Broadcast (only after explicit go-ahead)
Run the same command with `--broadcast` appended. Then, from the project root, run `npm run deploy:record`: it verifies the new contract on-chain (code, `VERSION` 2, verified USDC, treasury), updates `ESCROW_ADDRESS`/`ESCROW_DEPLOY_BLOCK` in `.env` (keeping the old values as a comment) and `deployments/base-sepolia.json`, and prints the Railway variables to change. To do it by hand instead, read the address and block from the receipt:
```bash
python3 -c "import json;d=json.load(open('broadcast/DeployBaseSepolia.s.sol/84532/run-latest.json'));r=d['receipts'][0];print('ESCROW_ADDRESS='+r['contractAddress']);print('ESCROW_DEPLOY_BLOCK='+str(int(r['blockNumber'],16)))"
```
Add both lines and `AGENTSETTLE_NETWORK=base-sepolia` to `.env`. (Source verification on BaseScan is optional: append `--verify` with an `ETHERSCAN_API_KEY`.)

### 3.6 Run the milestone and watch it
```bash
npm run agents:sepolia            # preflight: balances + config, sends nothing
npm run agents:sepolia -- --run   # executes; asks each keystore password
npm run dev                       # dashboard → On-chain shows Base Sepolia with BaseScan links
```
Each run writes a receipt log to `.agentsettle/sepolia-runs/`.

**Indexing (block speed matters).** Since Base's Denim upgrade, blocks come every 200 ms: about **430,000 blocks a day**. Alchemy's free tier only allows `eth_getLogs` over 10 blocks per request (viem reports the refusal as "JSON is not a valid request object"), which would mean ~43,000 requests per day of history. So:
- **With a relay (recommended),** the relay runs one shared, always-on indexer (`ESCROW_DEPLOY_BLOCK` set), checkpointed to its volume and served at `GET /v1/index`. Dashboards with `AGENTSETTLE_RELAY_URL` in `.env` read jobs from there and only call the RPC for balances and the spend policy. Give the relay an `INDEXER_RPC_URL` that allows wide `eth_getLogs` ranges (e.g. Base's public `https://sepolia.base.org`, paced by `INDEXER_RPS`, default 5). The indexer steps down 500 → 100 → 10 blocks automatically if a provider refuses, and `/health` shows its progress and current range.
- **Without a relay,** the dashboard scans history itself with the same step-down, pacing and checkpoint (`.agentsettle/index-*.json`), but a dashboard left off for a day has ~430k blocks to catch up.

**Confirmations are time-based.** On Base Sepolia a transaction counts as confirmed after ~5 s of blocks (25 blocks at 200 ms; `confirmationsFor()` in `sdk/networks.ts`). A fixed "3 blocks" would now be only 0.6 s.

`AgentSettleClient.connect` refuses if the RPC chain ID ≠ 84532 or the escrow's `usdc()` is not the verified address.

Rehearsed 2026-11-03 on a local chain impersonating Base Sepolia (chain 84532, stand-in USDC at the verified address, keystore signers, the real deploy script): all milestone checks passed.

### 3.7 Milestone acceptance (from CLAUDE.md)
- [ ] Two distinct agent wallets create a test-USDC escrow, deliver a hash, and release and refund.
- [ ] Unauthorized signers are rejected (Forbidden), and a second settlement is rejected (InvalidState).
- [ ] The dashboard shows included → confirmed (3 blocks) → settled, with gas per tx and explorer links.
- [ ] Gas and total cost per settlement are recorded (see §4).

## 4. Measured gas (Anvil, optimizer 200 runs)

| Action | Gas |
|---|---|
| token `approve` (exact amount) | ~46k |
| `setPolicy` / `setProviderAllowed` (one-time) | ~71k / ~47k |
| `createJobAsAgent` | ~247k (first job for a pair ~281k) |
| `createJob` (direct) | ~227k |
| `deliver` | ~53k |
| `approve` (release + fee) | ~92k |
| `dispute` / `resolve` | ~31k / ~45k |

A full happy path is about 390k gas after one-time setup. Base L2 fees depend on L1 data cost and current gas price, so measure real ETH cost on Base Sepolia before making any per-job fee assumptions (PRD validation gate).

## 5. Incident basics (testnet)
- Agent key compromised: the owner calls `revokePolicy(agent)` and sets the USDC allowance to 0. Open jobs created by that agent can still be approved by the agent, so dispute them from the owner key.
- Arbiter key compromised (v2): run `npm run owner -- disallow-arbiter <addr>` so the agent stops naming it; jobs that already name it stay with it, so dispute or settle them promptly. No redeploy needed.
- RPC outage: the dashboard shows the last known state with a stale banner. Nothing is signed server-side.
