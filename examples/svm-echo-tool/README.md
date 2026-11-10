# svm-echo-tool

Minimal SVM adaptation of a tool-sdk project. It is an HTTPS JSON tool with:

- A Solana `creatorAddress` (base58)
- Sign-In With Solana identity (`siwsGate`)
- Optional SPL token gate via the `solana.tool-sdk/access` manifest extension and `svmPredicateGate`
- Optional Solana x402 paywall (`defineSvmToolPaywall` / `svmX402Gate`) — facilitator co-signs as fee payer; the tool server never holds a hot key

This example does **not** call a DEX, send transactions, or read a local `.env`. Point `SOLANA_RPC_URL` at any Solana-compatible JSON-RPC (mainnet-beta, devnet, or a custom SVM).

## Register (dry-run)

```bash
npx @opensea/tool-sdk hash ./src/manifest.ts --algorithm sha256
npx @opensea/tool-sdk register \
  --metadata https://your-host/.well-known/ai-tool/svm-echo.json \
  --network solana \
  --dry-run
```

Live registration requires a deployed registry program (`--program-id` / `SVM_TOOL_REGISTRY_PROGRAM_ID`) and an external SVM wallet (`PRIVY_SVM_WALLET_ID`, not a secret key).
