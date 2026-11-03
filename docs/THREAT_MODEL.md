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

## Status of controls (Phase 1, 2026-11-03)
Implemented and tested (`npm run test:all`):
- **On-chain access control**: only the provider delivers; only the buyer, or the buyer's delegated agent, approves or reclaims; only the arbiter resolves. Tested for strangers, swapped roles and fuzzed callers.
- **No double settlement**: terminal states are final. This is invariant-tested: each job settles at most once, the escrow balance equals the sum of open jobs, and total value is conserved.
- **Reentrancy**: `nonReentrant` plus checks-effects-interactions. Tested with a hostile token that re-enters `approve`, `providerRefund` and `resolve`.
- **Asset mismatch**: the escrow rejects fee-on-transfer tokens. The SDK refuses to connect unless the chain ID and the escrow's `usdc()` match the verified registry, and the deploy script checks decimals and symbol on-chain.
- **Wallet-enforced spend policy**: owner → agent SpendPolicy with per-job cap, daily cap, provider allowlist, expiry and revocation, enforced in `createJobAsAgent`. Refunds do not restore daily budget. The SDK only approves exact token amounts.
- **Idempotency / replay**: a per-buyer `clientRef` blocks a second funding of the same request, and the SDK returns the existing job on retry. Transaction replay is covered by account nonces and EIP-155 chain IDs.
- **Party separation**: the arbiter cannot be buyer, provider or agent. The provider cannot be the buyer or agent.
- **Server holds no keys**: dashboard chain mode is read-only, and state comes from indexed events reconciled against storage.

## Known limitations (open)
- **Single immutable arbiter**: it can pay or refund any disputed job, and there is no rotation or appeal. A compromised arbiter can misdirect disputed funds.
- **Indefinite lock from Delivered**: if the buyer never approves and nobody disputes, funds stay locked. The provider can always dispute, so this depends on arbiter liveness.
- **USDC blocklist**: if Circle blocklists the provider, `_pay` reverts and the job is stuck in Delivered/Disputed until the arbiter refunds. If the buyer is blocklisted, refunds revert. A pull-payment design would isolate this.
- **Delegated agent can approve** jobs it created. Exposure is bounded by the policy caps, but a compromised agent could approve a colluding provider on the allowlist. Owners should keep allowlists tight and dispute from the owner key.
- **Daily cap uses UTC day buckets** (`block.timestamp / 1 days`), so up to 2× the daily cap can be spent across a midnight boundary.
- **Indexer** is in-memory and treats N confirmations as final. A reorg deeper than N would not be repaired, and there is no persistent store yet.
- **Simulation mode** remains unauthenticated by design. Its `actorId` values authorize nothing on-chain.
- `MockUSDC` can be minted by anyone and exists only for local Anvil.
- Not audited, and no formal verification or disclosure process yet.

## Before actual funds
- Require authenticated wallet custody/policy and a threat-model review by an experienced security engineer.
- Independent Solidity audit and contract test coverage, including fuzz/invariant, simulations and negative tests.
- Mainnet deployment runbook with monitors, contingency process and access-controlled deployer/arbiter keys.
- Jurisdiction-specific legal advice covering payment services, money transmission, escrow/custody, sanctions, and possible future token issuance.
