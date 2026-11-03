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

### 3.3 Dry run (no broadcast)
```bash
cd contracts
export CONFIRM_TESTNET_DEPLOY=base-sepolia TREASURY_ADDRESS=0x... ARBITER_ADDRESS=0x...
forge script script/DeployBaseSepolia.s.sol --rpc-url "$BASE_SEPOLIA_RPC_URL" --account agentsettle-deployer
```
The script refuses unless: chain = 84532; the verified USDC address has code, 6 decimals and symbol `USDC`; treasury ≠ arbiter; arbiter ≠ deployer; fee ≤ 10%.

### 3.4 Broadcast and verify
```bash
forge script script/DeployBaseSepolia.s.sol --rpc-url "$BASE_SEPOLIA_RPC_URL" --account agentsettle-deployer --broadcast --verify
```
Record the escrow address and deploy block in `.env` as `ESCROW_ADDRESS` and `ESCROW_DEPLOY_BLOCK`.

### 3.5 Point the dashboard at it (read-only)
```bash
AGENTSETTLE_NETWORK=base-sepolia ESCROW_ADDRESS=0x... ESCROW_DEPLOY_BLOCK=... \
OWNER_ADDRESS=0x... BUYER_AGENT_ADDRESS=0x... PROVIDER_AGENT_ADDRESS=0x... npm run dev
```
`AgentSettleClient.connect` refuses if the RPC chain ID ≠ 84532 or the escrow's `usdc()` is not the verified address.

### 3.6 Milestone acceptance (from CLAUDE.md)
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
- Arbiter key compromised: there is no rotation (immutable). Stop creating jobs on that deployment and redeploy with a new arbiter.
- RPC outage: the dashboard shows the last known state with a stale banner. Nothing is signed server-side.
