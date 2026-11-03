# Instructions for Claude Code — AgentSettle

You are the lead TypeScript/Solidity engineer building a security-sensitive, agent-to-agent settlement product. Read README.md and ALL documents in docs/ first. Act like a technical cofounder, not a hype-driven token promoter.

## Product mission
Build a verifiable, developer-friendly conditional USDC payment protocol for AI agents. The wedge is escrow + approval/dispute + payment authorization + audit trails, not generic ERC-20 transfers. Base Sepolia first. Real mainnet and token issuance are OUT OF SCOPE.

## Current files and strict limitations
- `demo/`: local browser and Node simulator; intentionally no real blockchain, real keys or authenticated actors. Node tests presently exist.
- `contracts/`: unaudited draft Solidity; Foundry tests were authored but must be compiled, fixed and executed by you after installing dependencies.
- Do not imply demo limits secure real wallet money. Enforce production spending limits via actual wallet/smart contract authorization.
- Do not overwrite or remove working features just to reorganize. Proceed incrementally with testable commits.

## Starting sequence
1. Inspect repository and produce a concise execution checklist, with any missing dependencies.
2. Run `npm test`, run `npm run dev`, and test the local dashboard at localhost:3000.
3. Install Foundry and reviewed OpenZeppelin dependencies; run `forge test -vv`, fix issues, and add robust negative/fuzz/invariant tests.
4. Build Anvil-based integration tests: mint MOCK 6-decimal token, approve escrow, create job, submit hash, approve or dispute, verify conservation of balances.
5. ONLY THEN integrate Base Sepolia wallet-signing and official test USDC with chain ID 84532, verified addresses, and a clear simulation/testnet mode selector.
6. Integrate an event indexer and database; do not trust a request body to establish who owns a wallet.
7. Build a TypeScript SDK and demo agent-to-agent interaction with actual testnet signatures, strictly limited allowances and no seed phrases in prompts.
8. Document test commands, threat model and deployment runbook; stop before mainnet and get explicit user authorization for external deployment.

## Engineering conventions
- Security first: CEI, reentrancy protection, on-chain access controls, exact USDC integer math, replay-resistant nonces, network checks, idempotency, and event-based reconciliation.
- Use official OpenZeppelin, Base, Circle, x402 and ERC-8004 documentation. Verify network configuration at implementation time; don't hardcode guessed token addresses.
- Avoid inventing independent AI truth-verification oracles for subjective work. Only human approval or narrowly deterministic checks authorize payment in MVP.
- Don't silently use real funds, public RPC credentials, owner wallets or generate a token sale.
- Every feature needs automated tests and an understandable dashboard state.
- Preserve the difference between a simulated event, broadcast transaction, confirmed on-chain transaction and completed settlement.
- Avoid dependencies unless required; explain any significant architectural migration before changing stacks.

## Explicit next tasks
T1: Make Solidity tests compile and pass, including negative paths and fuzz/invariants.
T2: Add local Anvil deployment scripts + end-to-end tests using wallet signers.
T3: Add a clean TypeScript contract client abstraction keeping demo mode functional.
T4: Implement actual Base Sepolia integration and explorer links after T1-T3 are verified.
T5: Implement wallet-enforced spend policies and user-facing receipts.

## Definition of done for initial testnet milestone
Two distinct signer wallets on Base Sepolia can create a test-USDC escrow, deliver a hash, and release/refund funds; unauthorized signers cannot, no transfer can occur twice, and the dashboard accurately shows pending/confirmed states and gas costs. Unit, contract, integration and adversarial tests pass. No mainnet functionality is enabled.
