import type {
  SignMessageRequest,
  SvmTransactionRequest,
  SvmWalletAdapter,
  WalletAdapter,
} from "@opensea/wallet-adapters"
import { isSvmAdapter } from "@opensea/wallet-adapters"
import { assertSvmAddress, type SvmAddress } from "./address.js"

/**
 * Pluggable SVM signer: an already-constructed {@link SvmWalletAdapter}, or
 * the pieces needed to wrap an external signing function (Phantom Connect,
 * Privy SVM, a browser wallet bridge, an HSM). The SDK never asks for a
 * Solana private key.
 */
export interface ExternalSvmSignerParams {
  address: SvmAddress
  name?: string
  signTransaction: (
    transaction: Uint8Array,
  ) => Promise<Uint8Array | { signedTransaction: string | Uint8Array }>
  signMessage?: (message: Uint8Array) => Promise<Uint8Array>
  /**
   * Optional broadcast. Prefer leaving this unset so the caller (or an
   * x402 facilitator) submits with its own commitment policy.
   */
  sendTransaction?: (transaction: Uint8Array) => Promise<{ signature: string }>
}

function asBytes(
  value: Uint8Array | { signedTransaction: string | Uint8Array },
): Uint8Array {
  if (value instanceof Uint8Array) return value
  const signed = value.signedTransaction
  if (signed instanceof Uint8Array) return signed
  return Uint8Array.from(Buffer.from(signed, "base64"))
}

function requestBytes(req: SvmTransactionRequest): Uint8Array {
  const tx =
    (req as { transaction?: Uint8Array | string; serialized?: Uint8Array })
      .transaction ?? (req as { serialized?: Uint8Array }).serialized
  if (tx instanceof Uint8Array) return tx
  if (typeof tx === "string") {
    return Uint8Array.from(Buffer.from(tx, "base64"))
  }
  throw new Error(
    "SvmTransactionRequest is missing serialized transaction bytes",
  )
}

/**
 * Wrap an external SVM signing function as a {@link SvmWalletAdapter}.
 * Use this for Phantom, Privy SVM, Turnkey, or any HTTP signer. Do not pass
 * a raw secret key.
 */
export function createExternalSvmSigner(
  params: ExternalSvmSignerParams,
): SvmWalletAdapter {
  const address = assertSvmAddress(params.address, "address")
  const adapter: SvmWalletAdapter = {
    name: params.name ?? "external-svm",
    chainType: "svm",
    capabilities: {
      signMessage: Boolean(params.signMessage),
      signTypedData: false,
      managedGas: false,
      managedNonce: false,
    },
    getAddress: async () => address,
    signTransaction: async (req: SvmTransactionRequest) => {
      const signed = await params.signTransaction(requestBytes(req))
      const bytes = asBytes(signed)
      return { signedTransaction: Buffer.from(bytes).toString("base64") }
    },
  }
  if (params.signMessage) {
    const signMessage = params.signMessage
    adapter.signMessage = async (request: SignMessageRequest) => {
      const bytes =
        typeof request.message === "string"
          ? new TextEncoder().encode(request.message)
          : request.message
      const sig = await signMessage(bytes)
      return Buffer.from(sig).toString("base64")
    }
  }
  if (params.sendTransaction) {
    const send = params.sendTransaction
    adapter.sendTransaction = async (req: SvmTransactionRequest) => {
      const result = await send(requestBytes(req))
      return { hash: result.signature }
    }
  }
  return adapter
}

export function requireSvmAdapter(
  adapter: WalletAdapter,
  purpose: string,
): SvmWalletAdapter {
  if (!isSvmAdapter(adapter)) {
    throw new Error(
      `Wallet "${adapter.name}" signs for ${adapter.chainType} but ${purpose} requires an SVM wallet`,
    )
  }
  return adapter
}

export async function svmWalletAddress(
  adapter: SvmWalletAdapter,
): Promise<SvmAddress> {
  const address = await adapter.getAddress()
  return assertSvmAddress(address, "wallet address")
}
