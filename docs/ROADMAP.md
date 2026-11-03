# Phased build plan

## Phase 0 — local concept demonstration (included)
- [x] Browser dashboard with in-memory simulated escrow ledger.
- [x] Mock task creation, SHA-256 evidence record, approval, dispute, refund and 0.5% fee display.
- [x] Demo spending caps, basic allowlist, per-request idempotency.
- [x] Node built-in test suite.
- [ ] A real cryptographic signature, blockchain deployment, persistent indexer or wallet policy **is not included**.

## Phase 1 — real Base Sepolia end-to-end (next)
- [ ] Install Foundry/OpenZeppelin, compile and run Solidity tests.
- [ ] Add property-based/fuzz tests: conservation of funds, terminal-state finality, caller authorization.
- [ ] Deploy mock token and escrow to Anvil/local chain; automate happy path with two test wallets.
- [ ] Deploy to Base Sepolia with test-only funds; verify published contracts and correct token/network.
- [ ] Replace mock buyer/provider IDs with wallet signatures and robust chain-state reads.
- [ ] Add event indexer that tolerates reorgs and retries.
- [ ] Make UI show actual testnet tx confirmations and explorer links distinctly from pending state.

## Phase 2 — developer-friendly agent SDK
- [ ] TypeScript SDK to create, deliver, approve, dispute and refund jobs.
- [ ] Signed policies enforced by a smart account or wallet provider, not merely in the Node API.
- [ ] Machine-readable receipts, idempotency, terms hashing and versioning.
- [ ] Provider agent test harness, webhook callbacks, MCP adapter where useful.
- [ ] Optional x402 for metered services; clarify where escrow is necessary vs direct pay.

## Phase 3 — pilot with external teams
- [ ] Interview 15-20 developers/teams, secure 3-5 testnet pilots.
- [ ] Measure conversion, payment failures, disputes, integration time, willingness to pay.
- [ ] Select one vertical: coding agents, paid research agents, or commercial data agents.
- [ ] Propose paid plan; adjust fee model for gas costs and high-volume batching.
- [ ] Security and legal reviews as applicable.

## Phase 4 — production/commercial expansion
- [ ] Independent audit, operational safeguards, legal review and support processes.
- [ ] Production key custody, role rotation, disaster response and SLA.
- [ ] Enterprise policy engine and B2B invoicing / reconciliation.
- [ ] Third-party agent validation oracles where objective verification exists.

## Phase 5 — only if justified by demand
- [ ] Quantify external validator needs and choose security/staking mechanism.
- [ ] Design token only if removing it would demonstrably weaken the network.
- [ ] Analyze token economics, securities implications, liquidity, governance and validator incentives.
- [ ] Consider dedicated chain **only after** sustained volume and demonstrated cost/UX constraints.
