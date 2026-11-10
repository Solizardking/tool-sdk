import {
  addressBytes,
  bytesToAddress,
  COMPUTE_BUDGET_PROGRAM_ADDRESS,
  type SvmAddress,
} from "./address.js"

/** Compact-u16 (Solana shortvec) used by transaction messages. */
export function encodeCompactU16(value: number): Uint8Array {
  if (value < 0 || value > 0xffff) {
    throw new Error(`compact-u16 out of range: ${value}`)
  }
  const out: number[] = []
  let n = value
  while (true) {
    const byte = n & 0x7f
    n >>= 7
    if (n === 0) {
      out.push(byte)
      break
    }
    out.push(byte | 0x80)
  }
  return Uint8Array.from(out)
}

export function decodeCompactU16(
  bytes: Uint8Array,
  offset = 0,
): { value: number; size: number } {
  let value = 0
  let size = 0
  let shift = 0
  while (size < 3) {
    const byte = bytes[offset + size]
    if (byte === undefined) {
      throw new Error("compact-u16: unexpected end of buffer")
    }
    size++
    value |= (byte & 0x7f) << shift
    if ((byte & 0x80) === 0) break
    shift += 7
  }
  return { value, size }
}

export interface AccountMeta {
  address: SvmAddress
  isSigner: boolean
  isWritable: boolean
}

export interface CompiledInstruction {
  programIdIndex: number
  accountIndexes: number[]
  data: Uint8Array
}

export interface SvmInstruction {
  programId: SvmAddress
  accounts: AccountMeta[]
  data: Uint8Array
}

export interface LegacyMessage {
  accountKeys: SvmAddress[]
  header: {
    numRequiredSignatures: number
    numReadonlySignedAccounts: number
    numReadonlyUnsignedAccounts: number
  }
  recentBlockhash: string
  instructions: CompiledInstruction[]
}

function concat(parts: Uint8Array[]): Uint8Array {
  let total = 0
  for (const part of parts) total += part.length
  const out = new Uint8Array(total)
  let offset = 0
  for (const part of parts) {
    out.set(part, offset)
    offset += part.length
  }
  return out
}

/**
 * Compile a legacy (non-versioned) message. Fee payer must be the first
 * signer. Matches `solana_sdk::transaction::Transaction` layout.
 */
export function compileLegacyMessage(params: {
  feePayer: SvmAddress
  recentBlockhash: string
  instructions: SvmInstruction[]
}): LegacyMessage {
  const { feePayer, recentBlockhash, instructions } = params
  type Flags = { signer: boolean; writable: boolean }
  const flags = new Map<SvmAddress, Flags>()

  const bump = (address: SvmAddress, signer: boolean, writable: boolean) => {
    const prev = flags.get(address) ?? { signer: false, writable: false }
    flags.set(address, {
      signer: prev.signer || signer,
      writable: prev.writable || writable,
    })
  }

  bump(feePayer, true, true)
  for (const ix of instructions) {
    bump(ix.programId, false, false)
    for (const meta of ix.accounts) {
      bump(meta.address, meta.isSigner, meta.isWritable)
    }
  }

  const signedWritable: SvmAddress[] = []
  const signedReadonly: SvmAddress[] = []
  const unsignedWritable: SvmAddress[] = []
  const unsignedReadonly: SvmAddress[] = []

  for (const [address, f] of flags) {
    if (address === feePayer) continue
    if (f.signer && f.writable) signedWritable.push(address)
    else if (f.signer) signedReadonly.push(address)
    else if (f.writable) unsignedWritable.push(address)
    else unsignedReadonly.push(address)
  }

  const accountKeys = [
    feePayer,
    ...signedWritable,
    ...signedReadonly,
    ...unsignedWritable,
    ...unsignedReadonly,
  ]
  const indexOf = (address: SvmAddress): number => {
    const idx = accountKeys.indexOf(address)
    if (idx < 0) {
      throw new Error(`account ${address} missing from compiled message`)
    }
    return idx
  }

  const compiled: CompiledInstruction[] = instructions.map(ix => ({
    programIdIndex: indexOf(ix.programId),
    accountIndexes: ix.accounts.map(m => indexOf(m.address)),
    data: ix.data,
  }))

  return {
    accountKeys,
    header: {
      numRequiredSignatures: 1 + signedWritable.length + signedReadonly.length,
      numReadonlySignedAccounts: signedReadonly.length,
      numReadonlyUnsignedAccounts: unsignedReadonly.length,
    },
    recentBlockhash,
    instructions: compiled,
  }
}

export function serializeLegacyMessage(message: LegacyMessage): Uint8Array {
  const parts: Uint8Array[] = [
    Uint8Array.of(
      message.header.numRequiredSignatures,
      message.header.numReadonlySignedAccounts,
      message.header.numReadonlyUnsignedAccounts,
    ),
    encodeCompactU16(message.accountKeys.length),
  ]
  for (const key of message.accountKeys) {
    parts.push(addressBytes(key))
  }
  parts.push(addressBytes(message.recentBlockhash))
  parts.push(encodeCompactU16(message.instructions.length))
  for (const ix of message.instructions) {
    parts.push(Uint8Array.of(ix.programIdIndex))
    parts.push(encodeCompactU16(ix.accountIndexes.length))
    parts.push(Uint8Array.from(ix.accountIndexes))
    parts.push(encodeCompactU16(ix.data.length))
    parts.push(ix.data)
  }
  return concat(parts)
}

/**
 * Legacy transaction: `[compact-u16 sig_count][64-byte sigs...][message]`.
 * Unsigned slots are 64 zero bytes. The fee-payer signature is index 0.
 */
export function serializeLegacyTransaction(params: {
  message: Uint8Array
  signatures: Array<Uint8Array | null>
}): Uint8Array {
  const { message, signatures } = params
  const parts: Uint8Array[] = [encodeCompactU16(signatures.length)]
  for (const sig of signatures) {
    if (!sig) {
      parts.push(new Uint8Array(64))
    } else if (sig.length !== 64) {
      throw new Error(`signature must be 64 bytes, got ${sig.length}`)
    } else {
      parts.push(sig)
    }
  }
  parts.push(message)
  return concat(parts)
}

export function encodeBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64")
}

export function decodeBase64(value: string): Uint8Array {
  return Uint8Array.from(Buffer.from(value, "base64"))
}

export function computeBudgetLimitIx(units: number): SvmInstruction {
  const data = new Uint8Array(5)
  data[0] = 2
  const view = new DataView(data.buffer)
  view.setUint32(1, units, true)
  return {
    programId: COMPUTE_BUDGET_PROGRAM_ADDRESS,
    accounts: [],
    data,
  }
}

export function computeBudgetPriceIx(microLamports: bigint): SvmInstruction {
  const data = new Uint8Array(9)
  data[0] = 3
  let n = microLamports
  for (let i = 1; i < 9; i++) {
    data[i] = Number(n & 0xffn)
    n >>= 8n
  }
  return {
    programId: COMPUTE_BUDGET_PROGRAM_ADDRESS,
    accounts: [],
    data,
  }
}

/** Decode account keys from a serialized legacy message (tests / dry-run). */
export function peekMessageAccountKeys(message: Uint8Array): SvmAddress[] {
  const numKeys = decodeCompactU16(message, 3)
  const keys: SvmAddress[] = []
  let offset = 3 + numKeys.size
  for (let i = 0; i < numKeys.value; i++) {
    keys.push(bytesToAddress(message.slice(offset, offset + 32)))
    offset += 32
  }
  return keys
}
