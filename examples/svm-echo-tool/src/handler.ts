import {
  createToolHandler,
  siwsGate,
  svmPredicateGate,
} from "@opensea/tool-sdk"
import { z } from "zod/v4"
import { buildSvmEchoManifest } from "./manifest.js"

const InputSchema = z.object({
  query: z.string(),
})

const OutputSchema = z.object({
  echo: z.string(),
  caller: z.string(),
})

/**
 * Identity-gated echo. Uses SIWS (no EIP-3009, no hot key). Pair with
 * `svmPredicateGate` when `solana.tool-sdk/access` is set, or `svmX402Gate`
 * / `defineSvmToolPaywall` for pay-per-call USDC on Solana.
 *
 * Paid settlement is performed by an x402 facilitator (fee payer). This
 * process never signs with a server secret key.
 */
export function buildSvmEchoHandler(env: {
  TOOL_ENDPOINT: string
  CREATOR_ADDRESS: string
  SOLANA_RPC_URL?: string
  SPL_GATE_MINT?: string
}) {
  const manifest = buildSvmEchoManifest({
    creator: env.CREATOR_ADDRESS,
    endpoint: env.TOOL_ENDPOINT,
    splMint: env.SPL_GATE_MINT,
  })

  const gates = env.SPL_GATE_MINT
    ? [
        svmPredicateGate({
          rpcUrl: env.SOLANA_RPC_URL,
          audience: env.TOOL_ENDPOINT,
          chainId: "mainnet",
        }),
      ]
    : [
        siwsGate({
          audience: env.TOOL_ENDPOINT,
          chainId: "mainnet",
        }),
      ]

  return createToolHandler({
    manifest,
    inputSchema: InputSchema,
    outputSchema: OutputSchema,
    gates,
    handler: async (input, ctx) => ({
      echo: input.query,
      caller: ctx.callerAddress ?? "",
    }),
  })
}
