import type { GateMiddleware, ToolContext } from "../../types.js"
import type { EnvResolver } from "../manifest/index.js"
import type { PricingEntry } from "../manifest/types.js"
import {
  assertSvmAddress,
  getSvmNetwork,
  SVM_CAIP2,
  type SvmAddress,
  type SvmNetwork,
  svmX402Asset,
  USDC_MINT_MAINNET,
} from "../svm/index.js"
import {
  PAYAI_X402_FACILITATOR_URL,
  withReplayGuardTimeout,
  type X402ReplayGuard,
} from "./x402-facilitators.js"

const USDC_DECIMALS = 6
const FACILITATOR_TIMEOUT_MS = 10_000

export interface SvmX402GateConfig {
  /** Merchant wallet (base58). Funds settle to its USDC ATA. */
  recipient: SvmAddress
  amountUsdc: string
  network?: string
  /** Facilitator pubkey that co-signs as fee payer. */
  feePayer: SvmAddress
  description?: string
  maxTimeoutSeconds?: number
  resource?: string
  facilitatorUrl?: string
  /** Override the USDC (or other SPL) mint. */
  asset?: SvmAddress
  replayGuard?: X402ReplayGuard
}

function toBaseUnits(amount: string, decimals: number): string {
  if (amount.includes(".")) {
    const [whole, frac = ""] = amount.split(".")
    const padded = (frac + "0".repeat(decimals)).slice(0, decimals)
    return `${whole}${padded}`.replace(/^0+(?=\d)/, "")
  }
  return amount
}

function canonicalResource(url: string): string {
  try {
    const u = new URL(url)
    return `${u.origin}${u.pathname}`
  } catch {
    return url
  }
}

interface PaymentRequirementsV1 {
  scheme: "exact"
  network: string
  maxAmountRequired: string
  resource: string
  description: string
  mimeType: string
  payTo: string
  maxTimeoutSeconds: number
  asset: string
  extra: { feePayer: string }
}

/**
 * Manifest pricing for USDC on Solana. Asset/recipient use CAIP-19/CAIP-10
 * Solana forms rather than `eip155:`.
 */
export function x402SvmUsdcPricing(config: {
  recipient: SvmAddress
  amountUsdc: string
  network?: string
  asset?: SvmAddress
}): PricingEntry[] {
  assertSvmAddress(config.recipient, "recipient")
  const network = getSvmNetwork(config.network ?? "solana")
  const mint = config.asset ?? svmX402Asset(network)
  const caip2 = network.caip2
  const chain = caip2.slice("solana:".length)
  return [
    {
      amount: toBaseUnits(config.amountUsdc, USDC_DECIMALS),
      asset: `solana:${chain}/token:${mint}`,
      recipient: `solana:${chain}:${config.recipient}`,
      protocol: "x402",
    },
  ]
}

/**
 * Hosted x402 gate for the Solana `exact` scheme. Same facilitator
 * `/verify` + `/settle` dance as the EVM gate; requirements advertise a
 * base58 `payTo`, SPL mint `asset`, CAIP-2 `network`, and `extra.feePayer`.
 *
 * Settlement is performed by the facilitator (it co-signs as fee payer and
 * broadcasts). This process never holds a hot key.
 */
export function svmX402Gate(config: SvmX402GateConfig): GateMiddleware {
  assertSvmAddress(config.recipient, "recipient")
  assertSvmAddress(config.feePayer, "feePayer")
  const network: SvmNetwork = getSvmNetwork(config.network ?? "solana")
  const asset = config.asset ?? network.usdcMint ?? USDC_MINT_MAINNET
  const facilitatorUrl = config.facilitatorUrl ?? PAYAI_X402_FACILITATOR_URL
  const maxAmountRequired = toBaseUnits(config.amountUsdc, USDC_DECIMALS)
  const description = config.description ?? "Tool invocation"
  const maxTimeoutSeconds = config.maxTimeoutSeconds ?? 60

  const stashedByCtx = new WeakMap<
    Partial<ToolContext>,
    {
      paymentPayload: unknown
      requirements: PaymentRequirementsV1
      replayKey?: string
    }
  >()

  return {
    async check(request, ctx): Promise<Response | null> {
      const resource = config.resource ?? canonicalResource(request.url)
      const requirements: PaymentRequirementsV1 = {
        scheme: "exact",
        network: network.caip2,
        maxAmountRequired,
        resource,
        description,
        mimeType: "application/json",
        payTo: config.recipient,
        maxTimeoutSeconds,
        asset,
        extra: { feePayer: config.feePayer },
      }

      const paymentHeader =
        request.headers.get("X-Payment") ??
        request.headers.get("PAYMENT-SIGNATURE")
      if (!paymentHeader) {
        return Response.json(
          {
            x402Version: 1,
            error: "X-PAYMENT header is required",
            accepts: [requirements],
          },
          { status: 402, headers: { "X-Accept-Payment": "x402" } },
        )
      }

      let paymentPayload: unknown
      try {
        paymentPayload = JSON.parse(
          Buffer.from(paymentHeader, "base64").toString("utf8"),
        )
      } catch {
        return Response.json(
          {
            x402Version: 1,
            error: "invalid_payload",
            accepts: [requirements],
          },
          { status: 402 },
        )
      }

      if (config.replayGuard) {
        const replayKey = JSON.stringify(paymentPayload)
        let reserved: boolean
        try {
          reserved = await withReplayGuardTimeout(
            config.replayGuard.reserve(replayKey),
            "reserve",
          )
        } catch {
          reserved = false
        }
        if (!reserved) {
          return Response.json(
            {
              x402Version: 1,
              error: "payment_authorization_already_used",
              accepts: [requirements],
            },
            { status: 402 },
          )
        }
        stashedByCtx.set(ctx, { paymentPayload, requirements, replayKey })
      } else {
        stashedByCtx.set(ctx, { paymentPayload, requirements })
      }

      const controller = new AbortController()
      const timeoutId = setTimeout(
        () => controller.abort(),
        FACILITATOR_TIMEOUT_MS,
      )
      try {
        const res = await fetch(`${facilitatorUrl}/verify`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            x402Version: 1,
            paymentPayload,
            paymentRequirements: requirements,
          }),
          signal: controller.signal,
        })
        if (!res.ok) {
          return Response.json(
            { error: "Payment facilitator unreachable" },
            { status: 502 },
          )
        }
        const body = (await res.json()) as {
          isValid?: boolean
          payer?: string
          invalidReason?: string
        }
        if (!body.isValid) {
          return Response.json(
            {
              x402Version: 1,
              error: body.invalidReason ?? "invalid_payment",
              accepts: [requirements],
            },
            { status: 402 },
          )
        }
        if (ctx.gates) {
          ctx.gates.x402 = { paid: true, payer: body.payer }
        }
        if (body.payer) ctx.callerAddress = body.payer
        return null
      } catch {
        return Response.json(
          { error: "Payment facilitator unreachable" },
          { status: 502 },
        )
      } finally {
        clearTimeout(timeoutId)
      }
    },
    async settle(ctx: ToolContext): Promise<void> {
      const stashed = stashedByCtx.get(ctx)
      if (!stashed) return
      const controller = new AbortController()
      const timeoutId = setTimeout(
        () => controller.abort(),
        FACILITATOR_TIMEOUT_MS,
      )
      try {
        const res = await fetch(`${facilitatorUrl}/settle`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            x402Version: 1,
            paymentPayload: stashed.paymentPayload,
            paymentRequirements: stashed.requirements,
          }),
          signal: controller.signal,
        })
        if (!res.ok) {
          const body = (await res.text().catch(() => "<no body>")).slice(0, 256)
          throw new Error(`facilitator /settle returned ${res.status}: ${body}`)
        }
        const body = (await res.json()) as {
          success?: boolean
          transaction?: string
          error?: string
        }
        if (!body.success) {
          throw new Error(
            `facilitator /settle reported failure: ${body.error ?? "<unknown>"}`,
          )
        }
        if (ctx.gates?.x402 && body.transaction) {
          ctx.gates.x402.settlementTxHash = body.transaction
        }
      } finally {
        clearTimeout(timeoutId)
      }
    },
  }
}

export function defineSvmToolPaywall(config: {
  recipient: EnvResolver<SvmAddress>
  feePayer: SvmAddress
  amountUsdc: string
  network?: string
  asset?: SvmAddress
  facilitatorUrl?: string
  replayGuard?: X402ReplayGuard
}): { pricing: EnvResolver<PricingEntry[]>; gate: GateMiddleware } {
  const resolveRecipient = (
    env?: Record<string, string | undefined>,
  ): SvmAddress => {
    if (typeof config.recipient === "function") {
      const resolved = config.recipient(
        env ??
          (globalThis.process?.env as Record<string, string | undefined>) ??
          {},
      )
      if (!resolved) {
        throw new Error(
          "defineSvmToolPaywall: recipient resolver returned a falsy value",
        )
      }
      return resolved
    }
    return config.recipient
  }

  const pricing: EnvResolver<PricingEntry[]> =
    typeof config.recipient === "function"
      ? env =>
          x402SvmUsdcPricing({
            recipient: resolveRecipient(env),
            amountUsdc: config.amountUsdc,
            network: config.network,
            asset: config.asset,
          })
      : x402SvmUsdcPricing({
          recipient: config.recipient,
          amountUsdc: config.amountUsdc,
          network: config.network,
          asset: config.asset,
        })

  let cached: { recipient: SvmAddress; gate: GateMiddleware } | undefined
  const gate: GateMiddleware = {
    async check(request, ctx) {
      const recipient = resolveRecipient()
      if (!cached || cached.recipient !== recipient) {
        cached = {
          recipient,
          gate: svmX402Gate({
            recipient,
            feePayer: config.feePayer,
            amountUsdc: config.amountUsdc,
            network: config.network,
            asset: config.asset,
            facilitatorUrl: config.facilitatorUrl,
            replayGuard: config.replayGuard,
          }),
        }
      }
      return cached.gate.check(request, ctx)
    },
    async settle(ctx) {
      if (cached?.gate.settle) await cached.gate.settle(ctx)
    },
  }

  return { pricing, gate }
}

export { SVM_CAIP2 }
