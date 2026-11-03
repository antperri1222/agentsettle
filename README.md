# AgentSettle — starter kit

**Agent-to-agent payments, escrow, and proof-of-delivery (prototype)**

AgentSettle is an experimental foundation for autonomous agents that commission work, hold funds in escrow, submit a hash of a deliverable, and release payment only after buyer approval or arbitration. A production product may add wallet-enforced spending policies, stablecoin payments, agent reputation, x402, and trusted validators.

> **SAFETY:** The dashboard is a fully local **SIMULATOR**. It does not transfer, lock, mint, or custody any actual cryptocurrency. Its agent roles are mock IDs and are NOT authenticated. The Solidity example is a **draft, unaudited** research contract. **Do not deploy to mainnet, use real funds, or market this as a finished financial system.**

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
- `contracts/test/AgentEscrow.t.sol`: draft Foundry tests.
- `docs/PRD.md`: product requirements, launch scope, acceptance criteria.
- `docs/ARCHITECTURE.md`: technical and economic architecture.
- `docs/THREAT_MODEL.md`: trust assumptions, abuse cases, and security gates.
- `docs/ROADMAP.md`: staged delivery and validation plan.
- `docs/TOKEN_STRATEGY.md`: prudent future-token approach.
- `CLAUDE.md`: copy/paste starter context for Claude Code.

## Solidity testing (requires internet and a local Foundry installation)

```bash
cd contracts
forge install OpenZeppelin/openzeppelin-contracts@v5.6.1 --no-commit
forge install foundry-rs/forge-std --no-commit
forge test -vv
```

**These Solidity tests have not been compiled or executed in the delivery environment**, because Foundry and its dependencies were not installed there. Claude Code should install dependencies, compile, fix incompatibilities, expand tests, and run security tooling before anything reaches a public testnet. Update dependencies to their current reviewed versions where necessary.

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
