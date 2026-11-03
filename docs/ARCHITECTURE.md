# Architecture and state model

## Prototype architecture
Browser -> local Node.js HTTP server -> in-memory DemoEngine (fake balance ledger, no blockchain).

## Planned testnet architecture
Buyer app / AI agent -> policy-enforcing smart wallet -> AgentSettle API -> Base Sepolia escrow contract (test USDC) -> chain event indexer -> PostgreSQL -> dashboard.
Provider agent -> API and wallet signature -> evidence hash + location -> escrow delivery function.
Buyer or designated arbiter signs finalization -> contract pays provider and treasury / refunds buyer.

Do NOT mistake backend policy checks for on-chain authorization. The real wallet must enforce limits itself, or require transactions to be independently authorized through on-chain policy contracts. The demo's `actorId` values are untrusted claims and must never authorize real transfers.

## Mainnet/testnet separation
- Local simulator: pretend USD balances, no actual blockchain.
- Public testnet: Base Sepolia (84532), official supported mock/test USDC, wallets with no real value. Verify contract addresses from Circle's current docs.
- Mainnet: prohibited pending contract audits, custody/security architecture review, and legal signoff.

## Implemented Phase 1 architecture
Owner wallet --setPolicy/approve exact amount--> AgentEscrow
Buyer agent key --createJobAsAgent (bounded by on-chain SpendPolicy)--> AgentEscrow (funds pulled from owner)
Provider agent key --deliver(evidenceHash)--> AgentEscrow
Buyer agent / owner --approve | dispute--> AgentEscrow; Arbiter --resolve--> AgentEscrow
AgentEscrow events --> EscrowIndexer (sdk/indexer.ts) --> read-only dashboard (`/api/chain/state`)

- `sdk/` is the TypeScript client (viem). It verifies the network and asset, simulates before signing, and reports simulated → broadcast → confirmed/reverted.
- The dashboard server never signs. Agents sign in their own processes (`scripts/agents-demo.ts` locally).
- `clientRef` gives on-chain idempotency per buyer, and `termsHash` commits to canonical, versioned terms (`sdk/terms.ts`, keccak256 of canonical JSON).

## Contract state machine
`None -> Funded -> Delivered -> Paid`

Alternate transitions:
- `Funded -> Refunded` only if deadline has passed without delivery (buyer), or provider volunteers refund.
- `Funded/Delivered -> Disputed -> Paid/Refunded` by arbiter.
- `Delivered -> Refunded` if provider voluntarily refunds.

**Potential indefinite-lock risk:** a buyer may fail to approve delivered work and the arbiter may become unavailable. Before production, add an explicitly agreed SLA or timeout-based escalation with proper economic protections, human override, and fail-safe recovery.

## Data handling
- Keep entire deliverables off-chain, in controlled storage. Only their integrity hashes and constrained metadata are on-chain.
- Canonicalize task terms with a versioned deterministic format before hashing; simple string hashing in demo is insufficient for interoperable clients.
- Store transaction hash, block number, chain ID, token address, agent identity ref, approval and invoice references.
- Store signed job commitments with nonce and deadlines to prevent replay.
- Do not expose private keys, bearer wallet API credentials, or production funds to an LLM prompt.

## Fee and unit model
- Token decimals: USDC generally 6; calculate in micro-USDC as integers, not JavaScript floating point.
- Fee BPS: 50 (0.50%). `fee = amount * 50 / 10000`, rounded down to the smallest unit. `quote(amount)` exposes the split on-chain.
- Provider net: `amount - fee`.
- Base L2 gas is in ETH. Custom AGNT gas requires a different architecture (dedicated chain or supported abstracted fee flow).
- Payment processing, storage, dispute handling, compliance and gas costs must fit within fee revenue.

## Future integration boundaries
- x402: best for metered API requests; integrate without conflating immediate API payment with escrow settlement.
- ERC-8004: interoperability for agent identity, feedback and validation; do not invent a competing identity standard in MVP.
- Wallet/paymaster: ERC-4337 smart accounts with enforceable policies and gas sponsorship, if supported by the selected provider.
- Validation plugin interface: deterministic checks first; subjective AI judgment advisory only, never the sole irreversible payout authority.

## Basic API shape (planned for testnet)
- `POST /v1/escrows` -> return unsigned wallet transaction / request for user-agent signature.
- `GET /v1/escrows/:id` -> chain-verified state.
- `POST /v1/escrows/:id/evidence` -> signed provider action.
- `POST /v1/escrows/:id/approve` -> signed buyer transaction.
- `POST /v1/escrows/:id/dispute` -> signed party request.
- `POST /v1/escrows/:id/resolve` -> authorized arbiter signature.
- `GET /v1/agents/:id/budget` -> policy state and chain-verified authorization tally.

Never build a production API where passing `{ actorId: "buyer" }` confers wallet permissions.
