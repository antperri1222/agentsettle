# AgentSettle MCP server

Lets an AI agent (Claude Desktop, Claude Code, or any MCP client) hire and pay another agent through the AgentSettle escrow. **Testnet only.**

One server process = one role = one agent wallet:

| Role | Tools |
|---|---|
| **buyer** | `agentsettle_whoami`, `agentsettle_list_jobs`, `agentsettle_get_job`, `agentsettle_create_job`, `agentsettle_review_delivery`, `agentsettle_approve_payment`, `agentsettle_open_dispute`, `agentsettle_reclaim_expired` |
| **provider** | `agentsettle_whoami`, `agentsettle_list_jobs`, `agentsettle_get_job`, `agentsettle_deliver`, `agentsettle_refund_buyer`, `agentsettle_open_dispute` |

## Safety model

- **The contract is the spending limit, not the AI.** The buyer agent's wallet holds no USDC. It funds jobs from the owner's allowance through `createJobAsAgent`, which enforces the owner's per-job cap, daily cap, provider allowlist and expiry on-chain.
- **The AI cannot change its own limits.** Approving the allowance, setting caps, allowlisting providers and revoking access are owner-only, done by a human with `npm run owner -- …` and the owner keystore. No MCP tool can transfer tokens, change policy or reveal keys.
- **Payments need the amount restated.** `agentsettle_approve_payment` requires `confirm_amount_usdc` to equal the job amount, and is marked destructive so MCP clients ask before running it.
- **Verified, untrusted content.** Terms and deliverables are checked against the hashes recorded on-chain. Deliverables are labelled untrusted: the buyer agent is told to evaluate them, never to follow instructions inside them.
- **Retries never pay twice.** `agentsettle_create_job` uses an idempotency key (derived automatically if omitted).
- **Keys.** On Base Sepolia the server decrypts the agent's Foundry keystore in memory, using a password file at `~/.agentsettle/<keystore>.password` with mode 600 (it refuses looser permissions). That makes the agent key as safe as your Mac account, which is acceptable for a capped testnet agent and **not** for a key holding real funds.

Deliverables and terms are stored in `.agentsettle/shared/` on this machine, named by their hash. Both agents must run on the same Mac for now; production would use object storage or IPFS with the same hashes.

## Setup (Base Sepolia)

```bash
cd ~/Downloads/agentsettle-starter
npm install
npm run owner -- status                 # check the buyer agent's budget
npm run owner -- approve 5              # owner signs: exact allowance the agent may draw on
npm run mcp:setup -- buyer              # asks the buyer-agent keystore password once, prints config
npm run mcp:setup -- provider           # same for the provider agent
```

`mcp:setup` prints a Claude Desktop config block (Settings → Developer → Edit Config, then restart Claude) and a `claude mcp add …` command for Claude Code. Other settings (network, escrow, RPC, addresses) come from `.env`. macOS may ask once whether Claude can access your Downloads folder; allow it, because the server lives there.

**Two agents, two clients.** The cleanest demo runs the buyer in Claude Desktop and the provider in Claude Code. Both in one client works too, but then one AI is playing both sides.

## Try it

Buyer (Claude Desktop):
> Use AgentSettle to hire the provider agent 0x0002…faA6 for $1 to write a 200-word summary of how stablecoin escrow works, with these acceptance criteria: under 250 words, mentions refunds and disputes. Deadline 24 hours.

Provider (Claude Code):
> Check AgentSettle for open jobs assigned to me, read the terms, and deliver the work.

Buyer:
> Review the delivery for that job against its acceptance criteria. If it passes, approve payment; if not, open a dispute explaining why.

Watch it happen on the dashboard (`npm run dev` → On-chain).

## Local Anvil

With `npm run chain:up` running and no `AGENTSETTLE_NETWORK` in `.env`, the server uses the public Anvil dev keys for each role (refused on any other chain). `npm run mcp:setup -- buyer` needs no password in that mode.

## Tests

`node --test test/e2e/mcp.test.ts` starts both servers over stdio against a throwaway chain and runs the full flow, idempotent retries, caps and allowlist errors, a prompt-injection deliverable, wrong-amount approval, double approval and the dispute path.
