import type { SvmWalletAdapter } from "@opensea/wallet-adapters"
import {
  createSiwsAuthHeader,
  createSiwsMessage,
  generateSiwsNonce,
  requireSvmAdapter,
  svmWalletAddress,
} from "../svm/index.js"
import type { WalletAdapter } from "../wallet/index.js"

export interface SiwsAuthenticatedFetchOptions extends RequestInit {
  /** SVM wallet that will sign the SIWS message. */
  signer: WalletAdapter | SvmWalletAdapter
  /** Public URL of the tool; bound into the SIWS URI. */
  uri?: string
  /** Domain bound into the SIWS header (defaults to the request host). */
  domain?: string
  /** Cluster / CAIP-2 id written as Chain ID. Defaults to `mainnet`. */
  chainId?: string
  statement?: string
  expirationMinutes?: number
}

/**
 * Call a SIWS-gated tool: sign a Sign-In With Solana message with the
 * injected SVM wallet and replay the request with
 * `Authorization: SIWS …`. Never asks for a private key.
 */
export async function siwsAuthenticatedFetch(
  url: string,
  options: SiwsAuthenticatedFetchOptions,
): Promise<Response> {
  const {
    signer,
    uri,
    domain,
    chainId = "mainnet",
    statement,
    expirationMinutes = 5,
    ...fetchOptions
  } = options

  if (expirationMinutes > 60) {
    throw new Error(
      "expirationMinutes must be ≤ 60 to limit SIWS replay exposure",
    )
  }

  const adapter = requireSvmAdapter(signer as WalletAdapter, "SIWS auth")
  const address = await svmWalletAddress(adapter)
  if (!adapter.signMessage) {
    throw new Error(
      `Wallet "${adapter.name}" does not support signMessage (required for SIWS)`,
    )
  }

  const parsedUrl = new URL(url)
  const now = new Date()
  const expirationTime = new Date(now.getTime() + expirationMinutes * 60_000)
  const message = createSiwsMessage({
    domain: domain ?? parsedUrl.host,
    address,
    uri: uri ?? url,
    statement,
    chainId,
    nonce: generateSiwsNonce(),
    issuedAt: now.toISOString(),
    expirationTime: expirationTime.toISOString(),
  })

  const signature = await adapter.signMessage({
    message: new TextEncoder().encode(message),
  })

  const headers = new Headers(fetchOptions.headers)
  headers.set("Authorization", createSiwsAuthHeader(message, signature))

  return fetch(url, { ...fetchOptions, headers })
}
