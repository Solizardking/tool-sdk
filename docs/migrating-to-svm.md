# Migrating a tool from EVM to SVM

This is a chain-family change, not a host change. Keep `docs/migrating-existing-tool.md` for Vercel ↔ Cloudflare. Use this page when the tool's **identity, payments, and registry** should run on Solana.

## 1. Manifest

- `creatorAddress` becomes a base58 pubkey (still hashed as-served).
- Keep `type` as the ERC-8257 manifest URL if you want HTTP verifiers to accept it; the schema is the HTTPS tool description, not an EVM ABI.
- Replace `access.requirements[].kind` 4-byte selectors with the namespaced extension:

```json
{
  "solana.tool-sdk/access": {
    "logic": "AND",
    "requirements": [
      { "kind": "spl-token-balance", "mint": "<MINT>", "minAmount": "1" }
    ]
  }
}
```

- Pricing CAIP strings become `solana:<genesisPrefix>/token:<mint>` and `solana:<genesisPrefix>:<pubkey>` (`x402SvmUsdcPricing`).

## 2. Gates

| Before | After |
|---|---|
| `predicateGate({ toolId, operatorAddress })` | `siwsGate({ audience })` and/or `svmPredicateGate({ rpcUrl, policy })` |
| `payaiX402Gate({ recipient: "0x…", network: "base" })` | `svmX402Gate({ recipient: "<pubkey>", feePayer: "<facilitator>", network: "solana" })` |
| `eip3009AuthenticatedFetch` | `siwsAuthenticatedFetch` |
| `paidFetch` (EIP-3009) | `paidFetch` with an `SvmWalletAdapter` once the 402 `network` is `solana:…` |

## 3. CLI

```bash
# Hash the SVM registry uses
npx @opensea/tool-sdk hash ./src/manifest.ts --algorithm sha256

npx @opensea/tool-sdk register \
  --metadata https://your-host/.well-known/ai-tool/slug.json \
  --network solana \
  --spl-gate <MINT> \
  --dry-run

npx @opensea/tool-sdk inspect \
  --network solana \
  --check-access <PUBKEY> \
  --spl-gate <MINT>
```

Configure `SOLANA_RPC_URL` (or `SVM_RPC_URL`) rather than an Ethereum JSON-RPC. Do not set a Solana secret key; use `PRIVY_SVM_WALLET_ID` or `--wallet-provider` with an SVM adapter.

## 4. What not to migrate blindly

- `set-collections`, `configure-erc20-gate`, `configure-subscription`, and `configure-trait-gating` are EVM predicate-contract commands. They error on `--network solana`.
- `update-metadata --network solana --dry-run` prints an `update_tool_metadata` instruction plan (same program-id requirement as register).
- `smoke` still exercises EIP-3009. Use `auth` (SIWS) and `pay` (SVM x402) instead.
- OpenSea discovery (`GET /api/v2/tools`) and usage reporting remain EVM-registry-shaped.

## 5. Custom SVM endpoints

```ts
import { defineSvmNetwork, SvmRpcClient } from "@opensea/tool-sdk"

const sonic = defineSvmNetwork({
  name: "my-svm",
  rpcUrl: process.env.SOLANA_RPC_URL ?? "https://api.mainnet-beta.solana.com",
  genesisHash: process.env.SVM_GENESIS_HASH,
})
const rpc = new SvmRpcClient({ network: sonic, rpcUrl: sonic.defaultRpcUrl })
```
