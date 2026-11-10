# tool-sdk — Agent Conventions

TypeScript SDK and CLI for building AI-callable HTTPS tools. Manifests follow the ERC-8257 JSON contract; on-chain registration and gating are dual-stack (EVM ToolRegistry + SVM program/RPC).

## Quick commands

```bash
pnpm run build
pnpm run test
pnpm run lint
pnpm run type-check
```

## Responsibilities

- Library: manifest validation, EVM registry client, SVM registry client (instruction plans + PDAs), gating middleware (EIP-3009 and SIWS / SPL RPC), x402 payment gates (EVM EIP-3009 and SVM TransferChecked), usage reporting, framework adapters, wallet re-exports.
- CLI: register, gate, inspect, pay, and smoke-test tools. `--network solana|solana-devnet|solana-testnet` selects the SVM path.
- Test helpers at the `@opensea/tool-sdk/testing` subpath (`src/testing/`); project scaffolds in `src/templates/` (cloudflare, express, vercel). Example: `examples/svm-echo-tool`.
- Skill docs in `skill/`.

## Rules

1. **ABI ↔ Solidity interface sync** (EVM). Every function/event in `packages/tool-registry/src/interfaces/*.sol` must have a matching entry in `src/lib/onchain/abis.ts`. This extracted repo may not ship the Solidity tree; do not invent ABI entries.
2. **Address & chain sync**. EVM deployed addresses in `src/lib/onchain/chains.ts` must match the tool-registry README. SVM has no canonical CREATE2 program; `SvmNetwork.registryProgramId` stays unset unless a real program id is configured via `--program-id` / `SVM_TOOL_REGISTRY_PROGRAM_ID`.
3. **SVM addresses are case-sensitive base58 pubkeys.** Never `toLowerCase()` a Solana address. Identity is SIWS (ed25519), not EIP-3009.
4. **Predicate CLI defaults (EVM)**. Commands targeting EVM predicates resolve the canonical address from `chains.ts`; `--predicate-address` is an override. SVM token gates are RPC policies (`--spl-gate`), not ERC-20 contracts.
5. **Multi-step flows**. Commands that send multiple onchain transactions must print recovery instructions if an intermediate TX fails and must show the full footprint in `--dry-run`. SVM `register --dry-run` prints the instruction plan even when no program is deployed.
6. **User-facing errors**. Error messages must not reference internal file paths (e.g. "Update chains.ts"); link to README/docs or give actionable instructions.
7. **Dead code**. When removing features, clean up related imports, constants, and references.
8. **No hot keys on SVM**. Sign through `SvmWalletAdapter` / `createExternalSvmSigner`. Do not add a Solana `PRIVATE_KEY` adapter. Do not `sendTransaction` from tests.

## Conventions

- ESM-only, `.js` import extensions.
- `as const` on all ABI definitions.
- Commander.js for CLI; wallet via `--wallet-provider` or env vars (`PRIVY_SVM_WALLET_ID` for Solana).
- `ToolRegistryClient` wraps viem clients; `SvmToolRegistryClient` wraps `SvmRpcClient` + instruction codecs.
