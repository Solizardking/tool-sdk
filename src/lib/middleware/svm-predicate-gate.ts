import type { GateMiddleware, ToolContext } from "../../types.js"
import {
  checkSvmToolAccess,
  parseSiwsAuthHeader,
  parseSvmAccessExtension,
  type SvmAccessPolicy,
  type SvmAddress,
  SvmRpcClient,
  type SvmRpcTransport,
  verifySiws,
} from "../svm/index.js"

export interface SvmPredicateGateConfig {
  /** RPC URL used for SPL / native-balance checks. */
  rpcUrl?: string
  /** Injected transport for tests. */
  transport?: SvmRpcTransport
  /** Explicit policy. Overrides the manifest extension when both are set. */
  policy?: SvmAccessPolicy
  domain?: string
  audience?: string
  chainId?: string
}

/**
 * Identity (SIWS) plus SVM access policy. Recovers the caller from a SIWS
 * header, then evaluates SPL token / NFT / native SOL requirements against
 * the configured RPC. No registry program is required.
 */
export function svmPredicateGate(
  config: SvmPredicateGateConfig = {},
): GateMiddleware {
  const rpc = new SvmRpcClient({
    rpcUrl: config.rpcUrl,
    transport: config.transport,
  })

  return {
    async check(
      request: Request,
      ctx: Partial<ToolContext>,
    ): Promise<Response | null> {
      const header =
        request.headers.get("Authorization") ?? request.headers.get("X-SIWS")
      if (!header) {
        return Response.json(
          { error: "siws_required", message: "SIWS authorization required" },
          { status: 401 },
        )
      }

      let caller: SvmAddress
      try {
        const parsed = parseSiwsAuthHeader(header)
        const url = new URL(config.audience ?? request.url)
        const verified = verifySiws({
          message: parsed.message,
          signature: parsed.signature,
          expectedDomain: config.domain ?? url.host,
          expectedUri: config.audience ?? request.url,
          expectedChainId: config.chainId,
        })
        caller = verified.address
      } catch (err) {
        return Response.json(
          {
            error: "invalid_siws",
            message: err instanceof Error ? err.message : String(err),
          },
          { status: 401 },
        )
      }

      const policy =
        config.policy ??
        (ctx.manifest
          ? parseSvmAccessExtension(
              ctx.manifest as unknown as Record<string, unknown>,
            )
          : undefined)

      if (!policy) {
        ctx.callerAddress = caller
        if (ctx.gates) ctx.gates.predicate = { granted: true }
        return null
      }

      const result = await checkSvmToolAccess({
        account: caller,
        rpc,
        policy,
      })
      if (!result.ok) {
        return Response.json(
          { error: "predicate_unavailable", details: result.details },
          { status: 502 },
        )
      }
      if (!result.granted) {
        return Response.json(
          { error: "access_denied", details: result.details },
          { status: 403 },
        )
      }
      ctx.callerAddress = caller
      if (ctx.gates) ctx.gates.predicate = { granted: true }
      return null
    },
  }
}
