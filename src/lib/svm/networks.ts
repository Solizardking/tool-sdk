import { assertSvmAddress, type SvmAddress } from "./address.js"

/**
 * CAIP-2 identifiers for x402 v2. These are the *protocol* identifiers, not
 * the full `getGenesisHash` RPC strings (mainnet RPC returns a 44-char hash;
 * x402 uses the 32-char prefix listed here).
 *
 * @see https://solana.com/docs/payments/agentic-payments/x402
 */
export const SVM_CAIP2 = {
  mainnet: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
  devnet: "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1",
  testnet: "solana:4uhcVJyU9pJkvQyS88uRDiswHXSCkY3z",
} as const

export const SVM_GENESIS_HASH = {
  mainnet: "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d",
  devnet: "EtWTRABZaYq6iMfeYKouRu166VU2xqa1",
  testnet: "4uhcVJyU9pJkvQyS88uRDiswHXSCkY3z",
} as const

export const USDC_MINT_MAINNET =
  "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v" as const
export const USDC_MINT_DEVNET =
  "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU" as const

export const DEFAULT_SVM_RPC = {
  mainnet: "https://api.mainnet-beta.solana.com",
  devnet: "https://api.devnet.solana.com",
  testnet: "https://api.testnet.solana.com",
} as const

export type SvmCluster = "mainnet" | "devnet" | "testnet" | "custom"

export type SvmX402Network =
  | "solana"
  | "solana-devnet"
  | "solana-testnet"
  | typeof SVM_CAIP2.mainnet
  | typeof SVM_CAIP2.devnet
  | typeof SVM_CAIP2.testnet
  | "solana:*"

export interface SvmNetwork {
  /** Short CLI name: `solana`, `solana-devnet`, `solana-testnet`, or custom. */
  name: string
  cluster: SvmCluster
  /** x402 / CAIP-2 network id. Custom clusters use `solana:<genesisPrefix>`. */
  caip2: string
  /** Full genesis hash used to sanity-check an RPC, when known. */
  genesisHash?: string
  defaultRpcUrl: string
  /** Native USDC mint on this cluster, if one is published. */
  usdcMint?: SvmAddress
  /**
   * Optional tool-registry program id. Unset until a program is deployed
   * on this cluster; callers pass `--program-id` or
   * `SVM_TOOL_REGISTRY_PROGRAM_ID`.
   */
  registryProgramId?: SvmAddress
}

export const SVM_NETWORKS: Record<
  "solana" | "solana-devnet" | "solana-testnet",
  SvmNetwork
> = {
  solana: {
    name: "solana",
    cluster: "mainnet",
    caip2: SVM_CAIP2.mainnet,
    genesisHash: SVM_GENESIS_HASH.mainnet,
    defaultRpcUrl: DEFAULT_SVM_RPC.mainnet,
    usdcMint: USDC_MINT_MAINNET,
  },
  "solana-devnet": {
    name: "solana-devnet",
    cluster: "devnet",
    caip2: SVM_CAIP2.devnet,
    genesisHash: SVM_GENESIS_HASH.devnet,
    defaultRpcUrl: DEFAULT_SVM_RPC.devnet,
    usdcMint: USDC_MINT_DEVNET,
  },
  "solana-testnet": {
    name: "solana-testnet",
    cluster: "testnet",
    caip2: SVM_CAIP2.testnet,
    genesisHash: SVM_GENESIS_HASH.testnet,
    defaultRpcUrl: DEFAULT_SVM_RPC.testnet,
  },
}

const CAIP2_TO_NAME: Record<string, keyof typeof SVM_NETWORKS> = {
  [SVM_CAIP2.mainnet]: "solana",
  [SVM_CAIP2.devnet]: "solana-devnet",
  [SVM_CAIP2.testnet]: "solana-testnet",
  solana: "solana",
  "solana-devnet": "solana-devnet",
  "solana-testnet": "solana-testnet",
  "mainnet-beta": "solana",
  // Do not map `mainnet` — that CLI name is Ethereum mainnet.
  devnet: "solana-devnet",
  testnet: "solana-testnet",
}

export function isSvmNetworkName(name: string): boolean {
  return name in CAIP2_TO_NAME || name.startsWith("solana:")
}

export function getSvmNetwork(name: string): SvmNetwork {
  const mapped = CAIP2_TO_NAME[name]
  if (mapped) return SVM_NETWORKS[mapped]
  if (name.startsWith("solana:") && name !== "solana:*") {
    const prefix = name.slice("solana:".length)
    return {
      name,
      cluster: "custom",
      caip2: name,
      genesisHash: prefix,
      defaultRpcUrl: DEFAULT_SVM_RPC.mainnet,
    }
  }
  throw new Error(`Unsupported SVM network: ${name}`)
}

/**
 * Build a network descriptor for any Solana-compatible SVM endpoint
 * (Eclipse, Sonic, a local validator, a private cluster). Identity is the
 * RPC URL plus an optional genesis hash / CAIP-2 id.
 */
export function defineSvmNetwork(params: {
  name: string
  rpcUrl: string
  genesisHash?: string
  caip2?: string
  usdcMint?: SvmAddress
  registryProgramId?: SvmAddress
}): SvmNetwork {
  if (params.usdcMint) assertSvmAddress(params.usdcMint, "usdcMint")
  if (params.registryProgramId) {
    assertSvmAddress(params.registryProgramId, "registryProgramId")
  }
  const caip2 =
    params.caip2 ??
    (params.genesisHash
      ? `solana:${params.genesisHash.slice(0, 32)}`
      : `solana:custom`)
  return {
    name: params.name,
    cluster: "custom",
    caip2,
    genesisHash: params.genesisHash,
    defaultRpcUrl: params.rpcUrl,
    usdcMint: params.usdcMint,
    registryProgramId: params.registryProgramId,
  }
}

export function svmX402Asset(network: SvmNetwork): string {
  const mint = network.usdcMint
  if (!mint) {
    throw new Error(
      `No canonical USDC mint configured for SVM network "${network.name}". Pass an explicit asset mint.`,
    )
  }
  return mint
}
