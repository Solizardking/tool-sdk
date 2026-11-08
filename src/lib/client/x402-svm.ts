import type { WalletAdapter } from "@opensea/wallet-adapters"
import type {
  PaymentPayloadContext,
  PaymentPayloadResult,
  SchemeNetworkClient,
  PaymentRequirements as X402PaymentRequirements,
} from "@x402/core/types"
import {
  compileLegacyMessage,
  computeBudgetLimitIx,
  computeBudgetPriceIx,
  getSvmNetwork,
  isSvmNetworkName,
  requireSvmAdapter,
  serializeLegacyMessage,
  serializeLegacyTransaction,
  svmWalletAddress,
  USDC_MINT_MAINNET,
  usdcTransferCheckedIx,
} from "../svm/index.js"
import { parseBaseUnitAmount } from "./x402-challenge.js"

/**
 * x402 `exact` scheme for Solana: the client builds a TransferChecked
 * instruction, signs as the token owner (fee-payer slot left empty for the
 * facilitator), and returns the partially-signed legacy transaction as
 * base64. Matches `scheme_exact_svm.md`.
 */
export class ExactSvmScheme implements SchemeNetworkClient {
  readonly scheme = "exact"

  constructor(private readonly signer: WalletAdapter) {}

  async createPaymentPayload(
    x402Version: number,
    paymentRequirements: X402PaymentRequirements,
    _context?: PaymentPayloadContext,
  ): Promise<PaymentPayloadResult> {
    const payload = await signSvmExactPayment(this.signer, paymentRequirements)
    if (x402Version === 1) {
      return {
        x402Version,
        scheme: paymentRequirements.scheme,
        network: paymentRequirements.network,
        payload,
      } as PaymentPayloadResult
    }
    return { x402Version, payload }
  }
}

export async function signSvmExactPayment(
  signer: WalletAdapter,
  reqs: {
    network: string
    payTo: string
    asset: string
    amount?: string
    maxAmountRequired?: string
    extra?: Record<string, unknown>
  },
): Promise<{ transaction: string }> {
  if (!isSvmNetworkName(reqs.network) && !reqs.network.startsWith("solana")) {
    throw new Error(`Unsupported SVM x402 network: ${reqs.network}`)
  }
  const adapter = requireSvmAdapter(signer, "x402 SVM payment")
  const owner = await svmWalletAddress(adapter)

  const amount = parseBaseUnitAmount(
    reqs.amount ?? reqs.maxAmountRequired ?? "0",
  )
  const mint = reqs.asset || USDC_MINT_MAINNET
  const extra = reqs.extra ?? {}
  const feePayer = extra.feePayer
  if (typeof feePayer !== "string" || feePayer.length === 0) {
    throw new Error(
      "x402 SVM: PaymentRequirements.extra.feePayer is required (facilitator pubkey)",
    )
  }
  const recentBlockhash = extra.recentBlockhash
  if (typeof recentBlockhash !== "string" || recentBlockhash.length === 0) {
    throw new Error(
      "x402 SVM: PaymentRequirements.extra.recentBlockhash is required so the client does not fetch a live blockhash during tests or offline signing",
    )
  }

  const transfer = usdcTransferCheckedIx({
    owner,
    payTo: reqs.payTo,
    mint,
    amount,
    decimals: 6,
  })
  const message = compileLegacyMessage({
    feePayer,
    recentBlockhash,
    instructions: [
      computeBudgetLimitIx(200_000),
      computeBudgetPriceIx(1n),
      transfer,
    ],
  })
  const messageBytes = serializeLegacyMessage(message)
  const unsigned = serializeLegacyTransaction({
    message: messageBytes,
    signatures: message.accountKeys
      .slice(0, message.header.numRequiredSignatures)
      .map(() => null),
  })

  const signed = await adapter.signTransaction({
    transaction: unsigned,
  })
  const transaction = signed.signedTransaction

  return { transaction }
}

export function svmNetworkFromX402(network: string) {
  return getSvmNetwork(network)
}
