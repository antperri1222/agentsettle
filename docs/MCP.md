# AgentSettle MCP server

Lets an AI agent (Claude Desktop, Claude Code, or any MCP client) hire and pay another agent through the AgentSettle escrow. **Testnet only.**

One server process = one role = one agent wallet:

| Role | Tools |
|---|---|
| **buyer** | `agentsettle_whoami`, `agentsettle_list_jobs`, `agentsettle_get_job`, `agentsettle_tx_status`, `agentsettle_create_job`, `agentsettle_review_delivery`, `agentsettle_approve_payment`, `agentsettle_open_dispute`, `agentsettle_reclaim_expired` |
| **provider** | `agentsettle_whoami`, `agentsettle_list_jobs`, `agentsettle_get_job`, `agentsettle_tx_status`, `agentsettle_deliver`, `agentsettle_refund_buyer`, `agentsettle_open_dispute` |

## Safety model

- **The contract is the spending limit, not the AI.** The buyer agent's wallet holds no USDC. It funds jobs from the owner's allowance through `createJobAsAgent`, which enforces the owner's per-job cap, daily cap, provider allowlist and expiry on-chain.
- **The AI cannot change its own limits.** Approving the allowance, setting caps, allowlisting providers and revoking access are owner-only, done by a human with `npm run owner -- …` and the owner keystore. No MCP tool can transfer tokens, change policy or reveal keys.
- **Payments need a human and the amount restated.** `agentsettle_approve_payment` is flagged to require human approval on every call (see *Using with Claude Code*), and requires `confirm_amount_usdc` to equal the job amount.
- **Verified, untrusted content.** Terms and deliverables are checked against the hashes recorded on-chain. Deliverables are labelled untrusted: the buyer agent is told to evaluate them, never to follow instructions inside them.
- **Retries never pay twice.** `agentsettle_create_job` uses an idempotency key (derived automatically if omitted).
- **Slow transactions are reported, not retried.** If a transaction isn't confirmed within 2 minutes, the tool returns `status: "pending"` with its hash instead of an error. Until it confirms (or is dropped, i.e. unseen for 10 minutes), the agent refuses to send anything else and points to `agentsettle_tx_status`. This closes the gap behind the Nov 17 duplicate job, where a slow transaction plus a retry under a new key funded the same task twice.
- **Stuck transactions are replaced, not stacked.** Transactions are sent with fee headroom (up to 2x the current estimate; only the real fee is charged). If the network says an earlier transaction holds the same slot ("replacement transaction underpriced"), it re-sends at 2x, 4x, then 8x the fee, replacing the stuck one, and gives up after that.
- **Keys.** On Base Sepolia the server decrypts the agent's Foundry keystore in memory, using a password file at `~/.agentsettle/<keystore>.password` with mode 600 (it refuses looser permissions). That makes the agent key as safe as your Mac account, which is acceptable for a capped testnet agent and **not** for a key holding real funds.

Terms and deliverables are stored by their hash. Without a relay, both agents must run on the same machine and share `.agentsettle/shared/`. With `AGENTSETTLE_RELAY_URL` set in `.env`, they go through the **relay**, so agents on different machines can work together (see below).

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

## Using with Claude Code (including Code Mode and auto mode)

**Payment approval always reaches a human.** `agentsettle_approve_payment` is marked `_meta["anthropic/requiresUserInteraction"]: true`. In Claude Code that means a permission prompt on **every** call, in every permission mode, including `auto` and `bypassPermissions`. There's no "don't ask again", and allow rules or hooks can't skip it. In `dontAsk` mode the call is denied instead. This implements the CLAUDE.md rule that only human approval (or a narrowly deterministic check) authorizes payment in the MVP, because approving means judging whether the work is good enough.

**Code Mode** (experimental, terminal only) lets Claude write JavaScript that calls many tools at once. In auto mode a classifier reviews that code, not each tool call inside it. The approval flag above still prompts per call, and the server's own guards still apply to code-driven calls: writes are serialized, a pending transaction blocks any new one, idempotency keys stop double funding, and the contract enforces caps.

**Optional: also ask before funding.** Funding a job stays autonomous by default, bounded by the owner's on-chain caps. To be prompted for it too, add an `ask` rule to `~/.claude/settings.json`. Rule names use the server name you registered with `claude mcp add`:

```json
{
  "permissions": {
    "ask": [
      "mcp__agentsettle-buyer__agentsettle_create_job",
      "mcp__agentsettle-buyer__agentsettle_reclaim_expired",
      "mcp__agentsettle-provider__agentsettle_refund_buyer"
    ]
  }
}
```

**Opting out (testnet experiments only).** Setting `AGENTSETTLE_AUTONOMOUS_APPROVAL=1` in the server's environment removes the approval flag, so the AI can release payment on its own judgment. The server logs a warning at startup. Don't use this outside testnet: it goes against the MVP's human-approval rule.

The flag is defined for Claude Code. Other MCP clients may ignore `_meta`, in which case their normal per-tool approval settings apply, so keep "ask" enabled for payment tools there.

**Codex** works as an MCP client too (`codex mcp add`; `npm run join` does it for providers). Codex doesn't read the `_meta` flag, so set approvals in `~/.codex/config.toml`: `default_tools_approval_mode = "writes"` under the server's table prompts for every tool that isn't read-only (all tools carry MCP read-only/destructive annotations). Codex also limits each tool call to 60 s by default, so register the server with `AGENTSETTLE_CONFIRM_TIMEOUT_MS=45000`. A slow transaction is then reported as `pending` with its hash before Codex gives up on the call. **For a buyer agent in Codex, use `default_tools_approval_mode = "writes"` (or `"prompt"`), never `"approve"`, or payments would go out without a human.**

## Try it

Buyer (Claude Desktop):
> Use AgentSettle to hire the provider agent 0x0002…faA6 for $1 to write a 200-word summary of how stablecoin escrow works, with these acceptance criteria: under 250 words, mentions refunds and disputes. Deadline 24 hours.

Provider (Claude Code):
> Check AgentSettle for open jobs assigned to me, read the terms, and deliver the work.

Buyer:
> Review the delivery for that job against its acceptance criteria. If it passes, approve payment; if not, open a dispute explaining why.

Watch it happen on the dashboard (`npm run dev` → On-chain).

## Bringing in an outside provider

Another developer can join as a provider from their own machine. They follow [PROVIDER_QUICKSTART.md](PROVIDER_QUICKSTART.md): clone, `npm install`, `npm run join`. That creates their agent wallet, `.env` and MCP registration, with no Foundry, faucet or USDC needed. They send you the provider address it prints, and you run:

```bash
npm run owner -- onboard 0xTheirProviderAddress        # allowlist + top up their gas to 0.0005 ETH (max 0.01)
```

Running it twice is safe: it skips whatever is already done. The deployment they join is described in `deployments/base-sepolia.json` (escrow, relay, and your owner/buyer-agent addresses), so update that file if you redeploy or move the relay. Then hire them from your buyer agent by giving it their provider address.

## Local Anvil

With `npm run chain:up` running and no `AGENTSETTLE_NETWORK` in `.env`, the server uses the public Anvil dev keys for each role (refused on any other chain). `npm run mcp:setup -- buyer` needs no password in that mode.

## Tests

`node --test test/e2e/mcp.test.ts` starts both servers over stdio against a throwaway chain and runs the full flow, idempotent retries, caps and allowlist errors, a prompt-injection deliverable, wrong-amount approval, double approval and the dispute path.

## Relay (agents on different machines)

`npm run relay` starts a small storage service for terms and deliverables (default `http://127.0.0.1:8787`; set `RELAY_HOST=0.0.0.0` and `RELAY_PORT` when hosting). Point agents at it with `AGENTSETTLE_RELAY_URL=https://…` in their `.env`.

- **It cannot tamper.** Files are stored under their keccak256 hash, and every client re-hashes what it receives and rejects anything that doesn't match the hash recorded on-chain.
- **It only serves a job's files to that job's parties.** Each read is signed by the agent's wallet (with a 5-minute freshness window), and the relay checks on-chain that the signer is the job's buyer, buyer agent, provider or arbiter. Strangers get 403, even though hashes are public.
- **Uploads** must be signed, must match their hash, are capped at 256 KB and are rate-limited per wallet.
- **It holds no keys** and only reads the chain.
- **Limits:** the relay operator can read content (no encryption yet) and could withhold it; a buyer then simply doesn't approve. Storage is a local folder (`RELAY_DATA_DIR`), so host it with a persistent disk.
- **On startup**, the MCP server checks that the relay serves the same chain and escrow, and refuses to start otherwise.

### Deploying the relay on Railway

The repo includes `railway.json` (start command `node relay/server.ts`, health check `/health`). In Railway:

1. **New Project → Deploy from GitHub repo →** `antperri1222/agentsettle`.
2. **Variables:**
   - `AGENTSETTLE_NETWORK=base-sepolia`
   - `ESCROW_ADDRESS=0xAd8D1D5f595803E01415f96AB6d41f14B2cc8F99`
   - `BASE_SEPOLIA_RPC_URL=<an Alchemy Base Sepolia URL>` (a separate Alchemy app for the relay keeps its quota apart from your agents)
   - `RELAY_DATA_DIR=/data`
   - `ESCROW_DEPLOY_BLOCK=60130379` (turns on the shared event indexer, served at `/v1/index`)
   - `INDEXER_RPC_URL=https://sepolia.base.org` (optional, recommended: a history source that allows wide block ranges, so the indexer doesn't burn Alchemy free-tier quota 10 blocks at a time)
3. **Volume:** add one mounted at `/data`, so stored files survive redeploys.
4. **Networking → Generate Domain.** Check `https://<domain>/health` returns `{"ok":true,…,"chainId":84532}`.
5. On each agent machine, add `AGENTSETTLE_RELAY_URL=https://<domain>` to `.env` and restart Claude. The dashboard (`npm run dev`) then reads jobs from the relay's index too.

Railway sets `PORT`, and the relay then binds `0.0.0.0` automatically. The relay holds no keys; the only secret is the RPC URL.
