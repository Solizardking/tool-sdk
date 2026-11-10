import { assertSvmAddress, type SvmAddress } from "./address.js"
import type { SvmRpcClient } from "./rpc.js"

export type SvmAccessKind =
  | "open"
  | "native-sol-balance"
  | "spl-token-balance"
  | "spl-nft-owner"

export interface NativeSolBalanceRequirement {
  kind: "native-sol-balance"
  /** Minimum lamports. */
  minLamports: bigint
}

export interface SplTokenBalanceRequirement {
  kind: "spl-token-balance"
  mint: SvmAddress
  /** Minimum raw token amount (base units). */
  minAmount: bigint
}

export interface SplNftOwnerRequirement {
  kind: "spl-nft-owner"
  /** Token mint that must be held (amount ≥ 1). */
  mint: SvmAddress
}

export type SvmAccessRequirement =
  | NativeSolBalanceRequirement
  | SplTokenBalanceRequirement
  | SplNftOwnerRequirement

export interface SvmAccessPolicy {
  logic: "AND" | "OR"
  requirements: SvmAccessRequirement[]
}

export interface SvmPredicateResult {
  ok: boolean
  granted: boolean
  /** Per-requirement outcomes, in policy order. */
  details: Array<{ kind: SvmAccessKind; granted: boolean; reason?: string }>
}

async function checkRequirement(
  rpc: SvmRpcClient,
  account: SvmAddress,
  req: SvmAccessRequirement,
): Promise<{ granted: boolean; reason?: string }> {
  if (req.kind === "native-sol-balance") {
    const lamports = await rpc.getBalance(account)
    if (lamports >= req.minLamports) return { granted: true }
    return {
      granted: false,
      reason: `balance ${lamports} < ${req.minLamports} lamports`,
    }
  }

  if (req.kind === "spl-token-balance") {
    const accounts = await rpc.getTokenAccountsByOwner(account, {
      mint: req.mint,
    })
    let total = 0n
    for (const token of accounts) total += BigInt(token.amount)
    if (total >= req.minAmount) return { granted: true }
    return {
      granted: false,
      reason: `token ${req.mint} balance ${total} < ${req.minAmount}`,
    }
  }

  const accounts = await rpc.getTokenAccountsByOwner(account, {
    mint: req.mint,
  })
  const held = accounts.some(token => BigInt(token.amount) >= 1n)
  if (held) return { granted: true }
  return { granted: false, reason: `does not hold mint ${req.mint}` }
}

/**
 * Evaluate an access policy against live SVM account state. No registry
 * program is required: the RPC is the source of truth for balances and
 * token holdings, the same way `getTokenAccountsByOwner` is for wallets.
 */
export async function evaluateSvmAccessPolicy(
  rpc: SvmRpcClient,
  account: SvmAddress,
  policy: SvmAccessPolicy,
): Promise<SvmPredicateResult> {
  assertSvmAddress(account, "account")
  if (policy.requirements.length === 0) {
    return { ok: true, granted: true, details: [] }
  }

  const details: SvmPredicateResult["details"] = []
  try {
    for (const req of policy.requirements) {
      const result = await checkRequirement(rpc, account, req)
      details.push({
        kind: req.kind,
        granted: result.granted,
        reason: result.reason,
      })
    }
  } catch (err) {
    return {
      ok: false,
      granted: false,
      details: [
        ...details,
        {
          kind: "open",
          granted: false,
          reason: err instanceof Error ? err.message : String(err),
        },
      ],
    }
  }

  const granted =
    policy.logic === "AND"
      ? details.every(d => d.granted)
      : details.some(d => d.granted)

  return { ok: true, granted, details }
}

export function parseSvmAccessExtension(
  manifest: Record<string, unknown>,
): SvmAccessPolicy | undefined {
  const raw = manifest["solana.tool-sdk/access"]
  if (!raw || typeof raw !== "object") return undefined
  const obj = raw as {
    logic?: string
    requirements?: Array<Record<string, unknown>>
  }
  const logic = obj.logic === "OR" ? "OR" : "AND"
  const requirements: SvmAccessRequirement[] = []
  for (const item of obj.requirements ?? []) {
    const kind = item.kind
    if (kind === "native-sol-balance") {
      requirements.push({
        kind,
        minLamports: BigInt(String(item.minLamports ?? item.minAmount ?? "0")),
      })
    } else if (kind === "spl-token-balance") {
      requirements.push({
        kind,
        mint: assertSvmAddress(String(item.mint), "mint"),
        minAmount: BigInt(String(item.minAmount ?? "0")),
      })
    } else if (kind === "spl-nft-owner") {
      requirements.push({
        kind,
        mint: assertSvmAddress(String(item.mint), "mint"),
      })
    }
  }
  if (requirements.length === 0) return undefined
  return { logic, requirements }
}
