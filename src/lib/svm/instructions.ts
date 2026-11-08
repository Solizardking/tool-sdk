import { sha256 } from "@noble/hashes/sha256"
import {
  addressBytes,
  encodeU64Le,
  findAssociatedTokenAddress,
  type SvmAddress,
  TOKEN_PROGRAM_ADDRESS,
} from "./address.js"
import type { SvmInstruction } from "./codec.js"

const SPL_TRANSFER_CHECKED = 12

export function ixDiscriminator(name: string): Uint8Array {
  return sha256(new TextEncoder().encode(`global:${name}`)).slice(0, 8)
}

export function accountDiscriminator(name: string): Uint8Array {
  return sha256(new TextEncoder().encode(`account:${name}`)).slice(0, 8)
}

export const TOOL_RECORD_DISCRIMINATOR = accountDiscriminator("ToolRecord")
export const CONFIG_DISCRIMINATOR = accountDiscriminator("Config")
export const REGISTER_TOOL_DISCRIMINATOR = ixDiscriminator("register_tool")
export const UPDATE_METADATA_DISCRIMINATOR = ixDiscriminator(
  "update_tool_metadata",
)
export const SET_PREDICATE_DISCRIMINATOR = ixDiscriminator(
  "set_access_predicate",
)

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

function encodeString(value: string): Uint8Array {
  const utf8 = new TextEncoder().encode(value)
  const len = new Uint8Array(4)
  const view = new DataView(len.buffer)
  view.setUint32(0, utf8.length, true)
  return concat([len, utf8])
}

/**
 * SPL Token / Token-2022 `TransferChecked`. Amount is in native token units.
 */
export function transferCheckedIx(params: {
  source: SvmAddress
  mint: SvmAddress
  destination: SvmAddress
  owner: SvmAddress
  amount: bigint
  decimals: number
  tokenProgram?: SvmAddress
}): SvmInstruction {
  const tokenProgram = params.tokenProgram ?? TOKEN_PROGRAM_ADDRESS
  const data = concat([
    Uint8Array.of(SPL_TRANSFER_CHECKED),
    encodeU64Le(params.amount),
    Uint8Array.of(params.decimals),
  ])
  return {
    programId: tokenProgram,
    accounts: [
      { address: params.source, isSigner: false, isWritable: true },
      { address: params.mint, isSigner: false, isWritable: false },
      { address: params.destination, isSigner: false, isWritable: true },
      { address: params.owner, isSigner: true, isWritable: false },
    ],
    data,
  }
}

export function registerToolIx(params: {
  programId: SvmAddress
  creator: SvmAddress
  config: SvmAddress
  toolRecord: SvmAddress
  systemProgram: SvmAddress
  metadataUri: string
  manifestHash: Uint8Array
  accessPredicate: SvmAddress
}): SvmInstruction {
  if (params.manifestHash.length !== 32) {
    throw new Error("manifest hash must be 32 bytes")
  }
  return {
    programId: params.programId,
    accounts: [
      { address: params.creator, isSigner: true, isWritable: true },
      { address: params.config, isSigner: false, isWritable: true },
      { address: params.toolRecord, isSigner: false, isWritable: true },
      { address: params.systemProgram, isSigner: false, isWritable: false },
    ],
    data: concat([
      REGISTER_TOOL_DISCRIMINATOR,
      encodeString(params.metadataUri),
      params.manifestHash,
      addressBytes(params.accessPredicate),
    ]),
  }
}

export function updateToolMetadataIx(params: {
  programId: SvmAddress
  creator: SvmAddress
  toolRecord: SvmAddress
  toolId: bigint
  metadataUri: string
  manifestHash: Uint8Array
}): SvmInstruction {
  if (params.manifestHash.length !== 32) {
    throw new Error("manifest hash must be 32 bytes")
  }
  return {
    programId: params.programId,
    accounts: [
      { address: params.creator, isSigner: true, isWritable: false },
      { address: params.toolRecord, isSigner: false, isWritable: true },
    ],
    data: concat([
      UPDATE_METADATA_DISCRIMINATOR,
      encodeU64Le(params.toolId),
      encodeString(params.metadataUri),
      params.manifestHash,
    ]),
  }
}

export function setAccessPredicateIx(params: {
  programId: SvmAddress
  creator: SvmAddress
  toolRecord: SvmAddress
  toolId: bigint
  accessPredicate: SvmAddress
}): SvmInstruction {
  return {
    programId: params.programId,
    accounts: [
      { address: params.creator, isSigner: true, isWritable: false },
      { address: params.toolRecord, isSigner: false, isWritable: true },
    ],
    data: concat([
      SET_PREDICATE_DISCRIMINATOR,
      encodeU64Le(params.toolId),
      addressBytes(params.accessPredicate),
    ]),
  }
}

/** Convenience: TransferChecked between the owner and payTo ATAs. */
export function usdcTransferCheckedIx(params: {
  owner: SvmAddress
  payTo: SvmAddress
  mint: SvmAddress
  amount: bigint
  decimals?: number
  tokenProgram?: SvmAddress
}): SvmInstruction {
  const tokenProgram = params.tokenProgram ?? TOKEN_PROGRAM_ADDRESS
  const source = findAssociatedTokenAddress(
    params.owner,
    params.mint,
    tokenProgram,
  ).address
  const destination = findAssociatedTokenAddress(
    params.payTo,
    params.mint,
    tokenProgram,
  ).address
  return transferCheckedIx({
    source,
    mint: params.mint,
    destination,
    owner: params.owner,
    amount: params.amount,
    decimals: params.decimals ?? 6,
    tokenProgram,
  })
}
