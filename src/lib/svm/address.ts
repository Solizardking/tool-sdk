import { ed25519 } from "@noble/curves/ed25519"
import { sha256 } from "@noble/hashes/sha256"
import { decodeBase58, encodeBase58 } from "./base58.js"

/** 32-byte Solana public key, encoded as base58. */
export type SvmAddress = string

export const PUBKEY_BYTES = 32

export const SYSTEM_PROGRAM_ADDRESS =
  "11111111111111111111111111111111" as const

export const TOKEN_PROGRAM_ADDRESS =
  "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA" as const

export const TOKEN_2022_PROGRAM_ADDRESS =
  "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb" as const

export const ASSOCIATED_TOKEN_PROGRAM_ADDRESS =
  "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL" as const

export const COMPUTE_BUDGET_PROGRAM_ADDRESS =
  "ComputeBudget111111111111111111111111111111" as const

const PDA_MARKER = new TextEncoder().encode("ProgramDerivedAddress")

export function addressBytes(address: SvmAddress): Uint8Array {
  const bytes = decodeBase58(address)
  if (bytes.length !== PUBKEY_BYTES) {
    throw new Error(
      `SVM address ${address} decoded to ${bytes.length} bytes, expected ${PUBKEY_BYTES}`,
    )
  }
  return bytes
}

export function bytesToAddress(bytes: Uint8Array): SvmAddress {
  if (bytes.length !== PUBKEY_BYTES) {
    throw new Error(
      `SVM address bytes must be ${PUBKEY_BYTES} long, got ${bytes.length}`,
    )
  }
  return encodeBase58(bytes)
}

/**
 * True when `value` is a 32-byte Solana public key in base58. Unlike EVM
 * addresses, encoding is case-sensitive — never lowercase a pubkey.
 */
export function isSvmAddress(value: string): boolean {
  try {
    return decodeBase58(value).length === PUBKEY_BYTES
  } catch {
    return false
  }
}

export function assertSvmAddress(value: string, label = "address"): SvmAddress {
  if (!isSvmAddress(value)) {
    throw new Error(`${label} "${value}" is not a valid Solana public key`)
  }
  return value
}

/**
 * Whether 32 bytes decode as an ed25519 curve point. Solana PDAs must be
 * *off* the curve so they cannot hold a private key.
 */
export function isOnCurve(bytes: Uint8Array): boolean {
  if (bytes.length !== PUBKEY_BYTES) return false
  try {
    ed25519.ExtendedPoint.fromHex(bytes)
    return true
  } catch {
    return false
  }
}

export interface ProgramAddress {
  address: SvmAddress
  bump: number
}

/**
 * Derive a program address (PDA) from seeds, matching the Solana runtime:
 * try bump 255..0 until the SHA-256 preimage is off-curve.
 */
export function findProgramAddress(
  seeds: readonly Uint8Array[],
  programId: SvmAddress,
): ProgramAddress {
  const programBytes = addressBytes(programId)
  for (let bump = 255; bump >= 0; bump--) {
    const parts = [...seeds, Uint8Array.of(bump), programBytes, PDA_MARKER]
    let total = 0
    for (const part of parts) total += part.length
    if (total > 255 + PUBKEY_BYTES + PDA_MARKER.length) {
      throw new Error("SVM PDA seeds exceed the runtime max of 255 bytes")
    }
    const preimage = new Uint8Array(total)
    let offset = 0
    for (const part of parts) {
      preimage.set(part, offset)
      offset += part.length
    }
    const hash = sha256(preimage)
    if (!isOnCurve(hash)) {
      return { address: bytesToAddress(hash), bump }
    }
  }
  throw new Error("Unable to find a valid SVM program address")
}

export function encodeU64Le(value: bigint): Uint8Array {
  if (value < 0n || value > 0xffff_ffff_ffff_ffffn) {
    throw new Error(`u64 out of range: ${value}`)
  }
  const out = new Uint8Array(8)
  let n = value
  for (let i = 0; i < 8; i++) {
    out[i] = Number(n & 0xffn)
    n >>= 8n
  }
  return out
}

export function decodeU64Le(bytes: Uint8Array, offset = 0): bigint {
  if (offset + 8 > bytes.length) {
    throw new Error("u64 decode: buffer too short")
  }
  let n = 0n
  for (let i = 7; i >= 0; i--) {
    n = (n << 8n) | BigInt(bytes[offset + i] ?? 0)
  }
  return n
}

/**
 * Associated Token Account for `(owner, mint)` under `tokenProgram`.
 * Defaults to the original SPL Token program, not Token-2022.
 */
export function findAssociatedTokenAddress(
  owner: SvmAddress,
  mint: SvmAddress,
  tokenProgram: SvmAddress = TOKEN_PROGRAM_ADDRESS,
): ProgramAddress {
  return findProgramAddress(
    [addressBytes(owner), addressBytes(tokenProgram), addressBytes(mint)],
    ASSOCIATED_TOKEN_PROGRAM_ADDRESS,
  )
}
