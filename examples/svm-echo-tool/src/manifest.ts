import {
  defineManifest,
  type EnvResolver,
  type PricingEntry,
} from "@opensea/tool-sdk"

const DESCRIPTION =
  "Echoes a query after verifying a Sign-In With Solana identity. Optional SPL token gate via solana.tool-sdk/access."

export interface BuildSvmManifestOptions {
  /** Base58 creator pubkey. Must match the wallet that registers the tool. */
  creator: string
  endpoint: string
  pricing?: EnvResolver<PricingEntry[]>
  /** SPL mint required to call the tool. Omit for open (identity-only) access. */
  splMint?: string
  splMinAmount?: string
}

export function buildSvmEchoManifest(opts: BuildSvmManifestOptions) {
  return defineManifest({
    type: "https://ercs.ethereum.org/ERCS/erc-8257#tool-manifest-v1",
    name: "svm-echo",
    description: DESCRIPTION,
    endpoint: opts.endpoint,
    inputs: {
      type: "object",
      properties: {
        query: { type: "string", description: "Text to echo" },
      },
      required: ["query"],
    },
    outputs: {
      type: "object",
      properties: {
        echo: { type: "string" },
        caller: { type: "string" },
      },
    },
    creatorAddress: opts.creator,
    pricing: opts.pricing ?? [],
    tags: ["svm", "solana", "echo"],
    ...(opts.splMint
      ? {
          "solana.tool-sdk/access": {
            logic: "AND",
            requirements: [
              {
                kind: "spl-token-balance",
                mint: opts.splMint,
                minAmount: opts.splMinAmount ?? "1",
              },
            ],
          },
        }
      : {}),
  })
}
