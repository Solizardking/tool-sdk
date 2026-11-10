import { type SvmAddress, SYSTEM_PROGRAM_ADDRESS } from "./address.js"
import {
  evaluateSvmAccessPolicy,
  type SvmAccessPolicy,
  type SvmPredicateResult,
} from "./predicates.js"
import type { SvmToolRegistryClient } from "./registry.js"
import type { SvmRpcClient } from "./rpc.js"

export interface CheckSvmToolAccessOptions {
  account: SvmAddress
  /** Live RPC used for SPL / native-balance predicates. */
  rpc: SvmRpcClient
  /**
   * Off-chain policy (from the `solana.tool-sdk/access` manifest extension
   * or constructed by the operator). Evaluated when present.
   */
  policy?: SvmAccessPolicy
  /**
   * Optional on-chain registry lookup. When the record's predicate is the
   * system program, access is open. Custom predicate programs are not
   * executed here (fail closed) — use `policy` for RPC-side checks.
   */
  registry?: SvmToolRegistryClient
  toolId?: bigint
}

/**
 * Preview whether `account` may call a tool. Prefers an explicit RPC policy
 * (works today on any SVM cluster). Falls back to the registry record when
 * no policy is given.
 */
export async function checkSvmToolAccess(
  opts: CheckSvmToolAccessOptions,
): Promise<SvmPredicateResult> {
  if (opts.policy) {
    return evaluateSvmAccessPolicy(opts.rpc, opts.account, opts.policy)
  }
  if (opts.registry && opts.toolId !== undefined) {
    const record = await opts.registry.getToolConfig(opts.toolId)
    if (record.accessPredicate === SYSTEM_PROGRAM_ADDRESS) {
      return {
        ok: true,
        granted: true,
        details: [{ kind: "open", granted: true }],
      }
    }
    return opts.registry.hasAccess(record, opts.account).then(r => ({
      ok: r.ok,
      granted: r.granted,
      details: [
        {
          kind: "open" as const,
          granted: r.granted,
          reason: r.ok
            ? undefined
            : "custom on-chain predicate program is not executable from this client; configure solana.tool-sdk/access",
        },
      ],
    }))
  }
  return {
    ok: true,
    granted: true,
    details: [{ kind: "open", granted: true }],
  }
}
