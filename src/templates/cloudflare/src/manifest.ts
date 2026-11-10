import { defineManifest } from "@opensea/tool-sdk"

// On Cloudflare Workers, use resolver functions to read env bindings at
// request time instead of at module-init time:
//   endpoint: env => env.TOOL_ENDPOINT!,
export const manifest = defineManifest({
  type: "https://ercs.ethereum.org/ERCS/erc-8257#tool-manifest-v1",
  name: "{{TOOL_NAME}}",
  description: "{{TOOL_DESCRIPTION}}",
  endpoint: "{{TOOL_ENDPOINT}}",
  inputs: {
    type: "object",
    properties: {
      query: { type: "string", description: "Input query" },
    },
    required: ["query"],
  },
  outputs: {
    type: "object",
    properties: {
      result: { type: "string" },
    },
  },
  // Lowercase 0x EVM address, or Solana base58 pubkey for --network solana.
  creatorAddress: "{{CREATOR_ADDRESS}}",
})
