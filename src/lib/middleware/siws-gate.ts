import type { GateMiddleware, ToolContext } from "../../types.js"
import {
  parseSiwsAuthHeader,
  type SvmAddress,
  verifySiws,
} from "../svm/index.js"

export interface SiwsGateConfig {
  /** Domain bound into the SIWS message. Defaults to the request host. */
  domain?: string
  /**
   * Absolute public URL of this endpoint. Clients bind this as SIWS URI.
   * Defaults to the incoming request URL.
   */
  audience?: string
  /** Expected SIWS Chain ID (`mainnet`, `devnet`, or a CAIP-2 id). */
  chainId?: string
  /**
   * Optional replay guard keyed by `address:nonce`. Same contract as
   * x402 replay guards.
   */
  replayGuard?: {
    reserve(key: string): Promise<boolean>
  }
}

/**
 * Server-side identity gate using Sign-In With Solana. Recovers the caller
 * pubkey from an `Authorization: SIWS …` header via ed25519 verify — no RPC
 * and no private key on the server.
 */
export function siwsGate(config: SiwsGateConfig = {}): GateMiddleware {
  return {
    async check(
      request: Request,
      ctx: Partial<ToolContext>,
    ): Promise<Response | null> {
      const header =
        request.headers.get("Authorization") ?? request.headers.get("X-SIWS")
      if (!header) {
        return Response.json(
          {
            error: "siws_required",
            message:
              "Sign a SIWS message and retry with Authorization: SIWS <message>.<signature>",
          },
          { status: 401 },
        )
      }

      let parsed: { message: string; signature: string }
      try {
        parsed = parseSiwsAuthHeader(header)
      } catch (err) {
        return Response.json(
          {
            error: "invalid_siws",
            message: err instanceof Error ? err.message : String(err),
          },
          { status: 401 },
        )
      }

      const url = new URL(config.audience ?? request.url)
      try {
        const verified = verifySiws({
          message: parsed.message,
          signature: parsed.signature,
          expectedDomain: config.domain ?? url.host,
          expectedUri: config.audience ?? request.url,
          expectedChainId: config.chainId,
        })
        if (config.replayGuard) {
          const nonce = verified.message.nonce
          const reserved = await config.replayGuard.reserve(
            `${verified.address}:${nonce}`,
          )
          if (!reserved) {
            return Response.json(
              { error: "siws_replay", message: "nonce already used" },
              { status: 401 },
            )
          }
        }
        ctx.callerAddress = verified.address as SvmAddress
        return null
      } catch (err) {
        return Response.json(
          {
            error: "invalid_siws",
            message: err instanceof Error ? err.message : String(err),
          },
          { status: 401 },
        )
      }
    },
  }
}
