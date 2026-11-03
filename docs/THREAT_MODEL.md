# Threat model (incomplete; must expand before testnet and mainnet)

## Assets and trust assumptions
- Assets: escrowed USDC, delegated agent budgets, signing rights, confidential task results, settlement proofs.
- The buyer and provider are mutually distrustful.
- The initial human arbiter is a centralized trust dependency and potential single point of failure.
- An LLM can be prompt-injected by arbitrary job content; it is not an authority for money transfers.
- Evidence hashes guarantee integrity relative to a submitted commitment, not quality, provenance, or honesty.

## Minimum protective controls
1. Enforce agent limits with smart-wallet permissions or checked transaction authorization, including chain, contract, token, destination, amount, nonce, expiry, and wallet signer.
2. Reject unsigned / replayed / modified authorizations; support idempotent retries.
3. Enforce a specific USDC token address; no arbitrary contract addresses presented as trusted collateral.
4. Require strict access checks for buyer, provider, arbiter and admin actions.
5. Prevent reentrancy and double settlement; account for fee rounding and non-standard ERC-20 behavior.
6. Index blockchain events with reorg handling and confirmation states; distinguish submission from irreversible settlement.
7. Set deadline rules; make dispute and recovery authority visible to users.
8. Throttle API calls, authenticate humans and wallets, and require human confirmation for dangerous actions.
9. Keep secrets in external signing/wallet infrastructure; never accept seed phrases or production private keys in agent prompts.
10. Protect deliverable storage access and redact client-confidential material from logs and on-chain metadata.
11. Detect anomalous purchasing loops, sybil behavior, self-trading, and artificial transaction volume.
12. Audit all smart contracts independently, fuzz and invariant test, examine upgrade/admin keys, and obtain legal/compliance review.

## Known prototype limitations
- The simulator's public HTTP calls are intentionally unauthenticated. It is local-only and fictional.
- `MockUSDC` can be minted by anyone and must NEVER be represented as real USDC.
- The Solidity contract has not been deployed, compiled, audited, or fuzzed in the delivery environment.
- Arbitrator can choose either payout or refund; compromised arbitrator could misdirect disputed funds.
- The smart contract does not enforce purchasing budgets; it assumes the buyer wallet did so BEFORE creating the escrow.
- No appeal, safe arbiter rotation, inactivity recovery from Delivered, partial settlement, gas abstraction or validator staking exists.
- No formal verification, security review, or vulnerability disclosure process.

## Before actual funds
- Require authenticated wallet custody/policy and a threat-model review by an experienced security engineer.
- Independent Solidity audit and contract test coverage, including fuzz/invariant, simulations and negative tests.
- Mainnet deployment runbook with monitors, contingency process and access-controlled deployer/arbiter keys.
- Jurisdiction-specific legal advice covering payment services, money transmission, escrow/custody, sanctions, and possible future token issuance.
