import { sha256 } from "@noble/hashes/sha256"
import canonicalize from "canonicalize"
import { bytesToAddress } from "./address.js"
import { encodeBase58 } from "./base58.js"

/**
 * SHA-256 over the JCS (RFC 8785) canonicalization of a manifest.
 *
 * Solana programs store 32-byte hashes and have no keccak opcode, so the
 * SVM registry uses SHA-256 rather than ERC-8257's keccak256. The input
 * contract is the same: hash the document *as served*, including namespaced
 * extension fields, with no schema stripping.
 *
 * Returns a 64-char lowercase hex string prefixed with `0x` for display, plus
 * the raw 32 bytes (and their base58 form) for instruction data.
 */
export function computeSvmManifestHash(manifest: object): {
  hex: `0x${string}`
  bytes: Uint8Array
  base58: string
} {
  const canonical = canonicalize(manifest)
  if (!canonical) throw new Error("Failed to canonicalize manifest")
  const bytes = sha256(new TextEncoder().encode(canonical))
  let hex = "0x" as `0x${string}`
  for (const byte of bytes) {
    hex = `${hex}${byte.toString(16).padStart(2, "0")}` as `0x${string}`
  }
  return { hex, bytes, base58: encodeBase58(bytes) }
}

/** PDA seed for a tool record: `["tool", tool_id_u64_le]`. */
export function toolRecordSeed(toolId: bigint): Uint8Array {
  const label = new TextEncoder().encode("tool")
  const id = new Uint8Array(8)
  let n = toolId
  for (let i = 0; i < 8; i++) {
    id[i] = Number(n & 0xffn)
    n >>= 8n
  }
  const out = new Uint8Array(label.length + id.length)
  out.set(label, 0)
  out.set(id, label.length)
  return out
}

export function configSeed(): Uint8Array {
  return new TextEncoder().encode("config")
}

/** Hex helper used by tests asserting against `bytesToAddress` of a hash. */
export function hashBytesToAddress(bytes: Uint8Array): string {
  return bytesToAddress(bytes)
}
