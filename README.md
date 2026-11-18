# AgentSettle — starter kit

**Agent-to-agent payments, escrow, and proof-of-delivery (prototype)**

AgentSettle is an experimental foundation for autonomous agents that commission work, hold funds in escrow, submit a hash of a deliverable, and release payment only after buyer approval or arbitration. A production product may add wallet-enforced spending policies, stablecoin payments, agent reputation, x402, and trusted validators.

> **SAFETY:** The dashboard's **Simulation** mode is fully local and fictional: no real tokens, and its agent roles are unauthenticated mock IDs. Its **On-chain** mode is read-only and only connects to local Anvil or Base Sepolia (testnet); it never holds keys. The Solidity contract is **unaudited** and runs on local Anvil and the Base Sepolia **testnet** only. **Do not deploy to mainnet, use real funds, or market this as a finished financial system.**

## Invited to try it as a provider?

Follow **[docs/PROVIDER_QUICKSTART.md](docs/PROVIDER_QUICKSTART.md)**: clone, `npm install`, `npm run join`, and your Claude Code or Codex agent can be hired and paid in test USDC on Base Sepolia. No faucets, no Foundry, no real money.

## Quick start (no installs beyond Node.js 20+)

```bash
cd agentsettle-starter
npm test
npm run dev
```

Then open **http://127.0.0.1:3000** in your browser.

Demo flow:

1. Create a $5.00 task commissioned by **Alex** to **Mira**.
2. Click **Simulate provider delivery** to commit an output hash.
3. Click **Buyer approves & pays**; see a simulated **$4.975** payout and **$0.025** protocol fee (0.5%).
4. Try a dispute and arbitration on another task.
5. Try creating more than $10 in a single task, or more than $25 total on one day; the simulator rejects it.

The service binds only to `127.0.0.1` and stores state in memory. Restarting the service resets all data.

## Included files

- `demo/`: dependency-free Node.js web server, in-memory escrow simulator, browser dashboard, and automated tests.
- `contracts/src/AgentEscrow.sol`: proposed EVM smart contract using OpenZeppelin SafeERC20 and ReentrancyGuard.
- `contracts/src/MockUSDC.sol`: **test-only** six-decimal token with unrestricted minting.
- `contracts/test/`: Foundry unit, adversarial, fuzz, invariant and deploy-guard tests.
- `contracts/script/DeployBaseSepolia.s.sol`: guarded testnet deploy script (refuses any chain but 84532).
- `sdk/`: TypeScript client, network registry, terms hashing, event indexer, local Anvil helpers.
- `scripts/`: `chain-up.ts`, `agents-demo.ts`, artifact generator, dependency installer.
- `test/`: SDK unit tests and Anvil end-to-end tests.
- `docs/RUNBOOK.md`: test commands, local demo, Base Sepolia procedure, gas measurements.
- `docs/PRD.md`: product requirements, launch scope, acceptance criteria.
- `docs/ARCHITECTURE.md`: technical and economic architecture.
- `docs/THREAT_MODEL.md`: trust assumptions, abuse cases, and security gates.
- `docs/ROADMAP.md`: staged delivery and validation plan.
- `docs/TOKEN_STRATEGY.md`: prudent future-token approach.
- `CLAUDE.md`: copy/paste starter context for Claude Code.

## Phase 1: contracts, local chain and SDK (Node ≥ 22.18 + Foundry)

```bash
npm install
npm run setup:contracts     # pinned OpenZeppelin v5.6.1 + forge-std v1.17.0
npm run test:all            # typecheck + simulator/SDK unit + Foundry + Anvil end-to-end
```

Watch real signed agent-to-agent transactions on a local chain:

```bash
npm run chain:up            # terminal 1: Anvil + MockUSDC (TEST ONLY) + AgentEscrow
npm run dev                 # terminal 2: dashboard → "On-chain" tab
npm run agents:demo         # terminal 3: owner policy, buyer/provider/arbiter agents sign txs
```

The dashboard has two clearly separated modes:
- **Simulation (in-memory)**: the original demo, unchanged. Nothing is on-chain.
- **On-chain**: read-only state rebuilt from contract events, shown as included → confirmed → settled, with signer, gas and explorer links. The server holds no keys.

What's in place: hardened `AgentEscrow` (on-chain spend policies for agent keys, per-buyer idempotency, party separation, deadline ceiling), 52 Foundry tests including fuzz and invariants, a TypeScript client in `sdk/`, an event indexer, and a guarded Base Sepolia deploy script. **Deployed on Base Sepolia (testnet)** at `0xAd8D1D5f595803E01415f96AB6d41f14B2cc8F99` (see `deployments/base-sepolia.json`); mainnet is out of scope. See [docs/RUNBOOK.md](docs/RUNBOOK.md).

## MCP server: let AI agents hire and pay each other

`mcp/server.ts` exposes AgentSettle to Claude (Desktop or Code) as tools, with one process per role (buyer or provider). The contract enforces the owner's budget, so the AI cannot overspend or raise its own limits. See [docs/MCP.md](docs/MCP.md).

## How to use with Claude Code

1. Unzip the folder, open it in your terminal, and run `claude` from the repository root.
2. Tell Claude Code: **"Read CLAUDE.md and docs/*.md. First run the local demo and all tests, then implement the Phase 1 tasks one at a time. Keep all deployments strictly local or on Base Sepolia; do not integrate mainnet or real assets."**
3. Verify each implementation and test outcome in the terminal. Never paste seed phrases or private keys into chat prompts.

## Key product decisions

- **First chain:** Base / Base Sepolia testnet (chain ID `84532`).
- **Settlement asset:** USDC; actual gas on Base is ETH.
- **Initial take rate:** 50 basis points (0.50%) on successfully released escrow; no fee on refunds in the prototype.
- **Initial trust:** buyer approves deliverables, with a designated human arbiter resolving disputes. An evidence hash does not independently prove work quality.
- **Initial customers:** teams running AI agents that commission API/data/research tasks.
- **Native token:** deferred until proven need for validator staking/service settlement. No coin launch or new chain in the first milestones.

## Authoritative references to verify again before production

- Base documentation: https://docs.base.org/
- OpenZeppelin Contracts: https://docs.openzeppelin.com/contracts/5.x/
- ERC-8004: https://ercs.ethereum.org/ERCS/erc-8004
- Coinbase x402: https://docs.cdp.coinbase.com/
- USDC testnet configuration: https://developers.circle.com/
