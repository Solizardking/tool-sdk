# SVM adaptation

This package is an HTTPS tool SDK: manifest validation, well-known discovery, host adapters, access gates, x402 pay-per-call, and an on-chain registry client. The SVM port maps those jobs onto Solana semantics. It is **not** a trading, swap, or NFT-marketplace SDK.

## What maps

| SDK job | EVM | SVM |
|---|---|---|
| Manifest JSON + `.well-known` | ERC-8257 schema | Same HTTP contract; `creatorAddress` may be a base58 pubkey; access policy as `solana.tool-sdk/access` |
| Manifest hash | keccak256(JCS) | SHA-256(JCS) for the SVM registry (`hash --algorithm sha256`); keccak256 kept for ERC-8257 |
| Addresses | `0x` + 20 bytes | base58 32-byte pubkeys (case-sensitive) |
| Networks | EVM chain id | Cluster + genesis hash + CAIP-2 (`solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp`). Custom SVM RPCs via `defineSvmNetwork` / `SOLANA_RPC_URL` |
| Registry | `ToolRegistry` contract (CREATE2) | `SvmToolRegistryClient` — PDA accounts, instruction plans. **No canonical program is deployed**; pass `--program-id` |
| Identity | EIP-3009 / SIWE | Sign-In With Solana (`siwsGate`, `siwsAuthenticatedFetch`) |
| Token / NFT gates | ERC-20 / ERC-721 predicates | RPC `getTokenAccountsByOwner` / `getBalance` (`svmPredicateGate`) |
| Pay-per-call | x402 `exact` + EIP-3009 | x402 `exact` SVM: partially signed `TransferChecked`; facilitator is fee payer (`svmX402Gate`) |
| Wallet | viem / EVM adapters | `SvmWalletAdapter` + `createExternalSvmSigner`. No Solana secret key in the SDK |

Generic pieces are unchanged: `defineManifest`, `createToolHandler`, Vercel / Cloudflare / Express adapters, `validate` / `export` / `verify` / `deploy`, well-known handlers.

## Signing

Writes and identity proofs go through an injected `SvmWalletAdapter` (Privy SVM, Phantom Connect, or `createExternalSvmSigner`). The server never holds a Solana private key. x402 settlement is facilitator-side: the client signs as token owner; the facilitator co-signs as `extra.feePayer` and broadcasts.

## Registry status

Instruction layouts (`register_tool`, `update_tool_metadata`, `set_access_predicate`) and PDAs (`["config"]`, `["tool", tool_id_u64_le]`) are implemented so a program can land later. Until then:

- `register --network solana --dry-run` prints the full footprint (works without a wallet or program id; uses a placeholder program for PDA derivation)
- `update-metadata --network solana --dry-run` prints an `update_tool_metadata` plan
- Live register/update refuse to send without `--program-id`
- Access control that works today: `siwsGate`, `svmPredicateGate`, `svmX402Gate`

## Remaining EVM surface

EVM registry clients, EIP-3009 gates, and Base x402 helpers remain for tools that still target those chains. CLI `--network base` is unchanged. OpenSea usage reporting still expects EVM addresses and `0x` tx hashes; SVM settlements are not reported there.
