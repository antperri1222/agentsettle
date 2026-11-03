# Product Requirements Document (PRD) — AgentSettle

## One-sentence proposition
Enable software agents to purchase digital work from other agents with predictable payment authorization, conditional USDC settlement, verifiable evidence records, and a human-understandable audit trail.

## Buyer and provider persona
- **Buyer:** AI development team or enterprise procurement agent with programmable spending limits.
- **Provider:** API, research, code testing, or structured data agent that wants payment certainty.
- **Supervisor:** Human responsible for approving exceptions, managing disputes, and reconciling spending.

## The real problem
AI-to-API payment rails exist. Completing a purchased task, handling rejection, proving which task was bought, enforcing approved spending, and reconciling which agent paid which provider is a distinct problem. AgentSettle aims to be the conditional-settlement layer, not another coin or general-purpose L1.

## MVP scope
1. Register mock agents or connect testnet agent-controlled wallets.
2. Capture task terms and create canonical hash of terms with explicit acceptance criteria.
3. Enforce spending caps and recipient allowlists **at the wallet/smart-contract enforcement point**, not just in an API.
4. Use USDC denominated amounts (six decimals), exact accounting and on-chain escrow.
5. Allow provider to submit a deliverable reference and immutable evidence hash.
6. Allow buyer wallet to approve settlement, or either party to open a dispute.
7. Allow explicit arbitration; after missed deadline, buyer can reclaim a job that was never delivered.
8. Show every state transition, transaction signature and explorer link in a dashboard.
9. Produce developer-facing REST/TypeScript interface and examples for integrating agents.
10. Require manual oversight and spending policies; no unbounded transfers from prompt-triggered agents.

## Excluded from the first release
- Native crypto token, staking, custom L2, bridging, mainnet payments.
- Unsupervised AI adjudication of subjective deliverables.
- Custody of private keys on the app's web server.
- Fraud-proof guarantees from SHA-256 evidence hashes.
- Real-world identity verification or sanctions screening (separate legal/compliance workstream).

## User journeys
- Buyer sets $25/day, $10/transaction, and allows specific service agents; purchases $5 report.
- Provider receives job + deadline, submits artifact hash and storage reference.
- Buyer approves, escrow transfers $4.975 to provider and $0.025 to protocol treasury (fee accounting in 6 decimals).
- Buyer disputes incomplete work; designated arbitrator determines refund or payout.
- A provider fails to deliver before the deadline; buyer may recover funds.

## Validation gates
- Five real (non-simulated) developers try a testnet purchase without the builder guiding every action.
- At least two teams request another paid task after a first successful test.
- Document gas and total cost per settlement, including approvals, escrow, and gas sponsorship.
- No serious authentication, signature-replay, asset-mismatch, or balance-accounting findings in independent review.
- Determine whether users prefer per-job settlement or prepaid balance + batched settlements.

## Candidate business model
- Charge 0.5% on successful conditional settlement, with the percentage and minimums subject to pilot economics.
- Higher-value enterprise tier for policy configuration, audit logs, integrations, and priority support.
- Avoid fee assumptions for very low-value micropayments until all-in transaction costs are measured.
