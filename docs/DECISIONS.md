# Decision Log

| Date | Decision | Status | Rationale | Trade-off |
|---|---|---|---|---|
| 2026-08-12 | Create a standalone public repository | Approved | Independent, attributable, and adoptable product | Requires a stable API boundary |
| 2026-08-12 | Reuse trust8004 through APIs | Approved | Preserves existing infrastructure advantage | Initial external dependency |
| 2026-08-12 | Limit MVP to BSC | Approved | Direct main-track alignment | Multichain deferred |
| 2026-08-12 | Use ERC-8183 for buyer activation | Approved | Official hiring lifecycle | Wallet and `$U` complexity |
| 2026-08-12 | Build four proprietary agents | Rejected | Marketplace is the evaluated product | Existing sellers must be verified |
| 2026-08-12 | Build a minimal Grid seller | Conditional | Only if the category remains blocked | Adds seller maintenance |
| 2026-08-12 | Enter partner tracks | Out of scope | Protect main-track execution | Additional prizes deferred |
| 2026-08-12 | Build complete UI before buyer spike | Rejected | Does not reduce critical technical risk | Visual build starts later |
| 2026-08-12 | Duplicate the full indexer | Rejected for MVP | High effort without judging value | Provider dependency remains |
| 2026-08-14 | Use trust8004 as the sole catalogue source | Approved | One read-only API boundary preserves provenance and keeps the BSC inventory simple | Coverage is explicitly partial; critical facts still require direct BSC verification |
| 2026-08-16 | Keep verification evidence separate from the trust8004 snapshot | Approved | Prevents observed MCP tools and direct BSC reads from overwriting declared catalogue data | Consumers must interpret mismatches and temporal drift explicitly |
| 2026-08-17 | Gate frontend work on reproducible evidence, not third-party seller access | Approved | Gate 1 already proves the buyer lifecycle onchain; the UI can honestly represent MCP-only and unavailable states | Replaces waiting for an external seller; no existing MVP item or gate is delayed |
| 2026-08-17 | Probe only explicitly declared seller protocols | Approved | Prevents MCP/A2A discovery from being misrepresented as ERC-8183 hireability | Undeclared compatible routes are intentionally not guessed |
| 2026-08-17 | Split discovery into curated marketplace and paginated registered views | Approved | Enables navigation of the trust8004 BSC snapshot without mass download, N+1 enrichment, or global classification | Registered agents remain `Not evaluated` until deliberately curated |
| 2026-08-17 | Deliver the read-only Frontend MVP before wallet signing | Approved | Gate 1 already proves the ERC-8183 lifecycle and the UI can now expose real evidence safely | Non-custodial wallet/ERC-8183 integration is the delayed next gate; no fake quotes or jobs are introduced |
| 2026-08-18 | Keep `@bnbagent/sdk` server-side and use viem for injected-wallet ERC-8183 writes | Approved for Gate 6A | SDK `0.5.0` accepts its Node-oriented `WalletProvider`, has no EIP-1193 adapter, and its ERC-8183 entry reaches filesystem-backed providers; a minimal viem adapter preserves browser custody | Delays production `/hire/[agentId]` integration until the Testnet spike is signed and observed at `SUBMITTED`; WalletConnect and mainnet remain out of scope |
| 2026-08-19 | Replace the unrecoverable local seller with public hosted Testnet Agent `1866` | Implemented for Gate 6A | Agent `1815`'s keystore password was never retained, so its signing key cannot be recovered; a new Testnet-only key is held as a server-side Vercel secret and public A2A routes keep the fixture usable without a tunnel | Deterministic deliverables avoid adding storage; the browser flow still requires a user-controlled injected wallet and remains Testnet-only |
| 2026-08-20 | Productize the proven wallet flow as a separate Testnet demo | Approved for Gate 6B | Mainnet catalogue Agent IDs and Testnet fixture IDs are different identity spaces, so `/demo/erc8183` and `/jobs/testnet/{jobId}` avoid presenting Agent `1866` as a marketplace candidate | Replaces the experimental route as the visible entry point; production `/hire/[agentId]` remains delayed until a real BSC Mainnet ERC-8183 seller is verified |
| 2026-08-20 | Qualify Mainnet sellers from curated and explicit IDs without global classification | Approved for Gate 6C | Bounded profile reads and declared-protocol probes let newly indexed sellers be assessed without scanning the partial trust8004 catalogue or treating descriptions as operational evidence | A verified explicit seller is reported but not promoted; `/hire` and the curated manifest remain delayed until a separate review |
| 2026-08-21 | Pin validated seller DNS and bound Gate 6C evidence collection | Approved for Gate 6C | Connection-time IP pinning, incremental 64 KiB reads, canonical request binding, quote freshness, and probe budgets prevent SSRF rebinding, replay, memory, and fan-out risks | Qualification is intentionally incomplete when limits are reached; broader coverage requires a later reviewed run, not silent relaxation |

## Scope change rule

Any new MVP feature must identify either:

- the existing feature it replaces; or
- the gate and delivery date it delays.

Unapproved suggestions remain outside the active backlog.
