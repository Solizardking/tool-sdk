import type { SvmWalletAdapter } from "@opensea/wallet-adapters"
import {
  bytesToAddress,
  decodeU64Le,
  findProgramAddress,
  type SvmAddress,
  SYSTEM_PROGRAM_ADDRESS,
} from "./address.js"
import {
  compileLegacyMessage,
  encodeBase64,
  type SvmInstruction,
  serializeLegacyMessage,
  serializeLegacyTransaction,
} from "./codec.js"
import { computeSvmManifestHash, configSeed, toolRecordSeed } from "./hash.js"
import {
  registerToolIx,
  setAccessPredicateIx,
  TOOL_RECORD_DISCRIMINATOR,
  updateToolMetadataIx,
} from "./instructions.js"
import type { SvmNetwork } from "./networks.js"
import type { SvmRpcClient } from "./rpc.js"
import { svmWalletAddress } from "./wallet.js"

const MAX_METADATA_URI_LEN = 2048

export interface SvmToolRecord {
  bump: number
  toolId: bigint
  creator: SvmAddress
  accessPredicate: SvmAddress
  manifestHash: Uint8Array
  metadataUri: string
  address: SvmAddress
}

export interface SvmRegistryConfig {
  network: SvmNetwork
  rpc: SvmRpcClient
  /**
   * Deployed registry program id. Required for reads against chain and for
   * any non-dry-run write. There is no canonical CREATE2 equivalent on
   * Solana — configure via `--program-id` or `SVM_TOOL_REGISTRY_PROGRAM_ID`.
   */
  programId?: SvmAddress
  wallet?: SvmWalletAdapter
}

export interface SvmInstructionPlan {
  description: string
  programId: SvmAddress
  instructions: SvmInstruction[]
  accountKeys: SvmAddress[]
  /** Human-readable footprint for `--dry-run`. */
  footprint: string[]
}

export class SvmRegistryNotConfiguredError extends Error {
  constructor() {
    super(
      "No SVM tool registry program ID configured. Pass --program-id or set SVM_TOOL_REGISTRY_PROGRAM_ID. " +
        "Until a program is deployed, use --dry-run to inspect the instruction plan, and gate access with svmPredicateGate (RPC SPL checks) or siwsGate.",
    )
    this.name = "SvmRegistryNotConfiguredError"
  }
}

function requireProgramId(programId: SvmAddress | undefined): SvmAddress {
  if (!programId) throw new SvmRegistryNotConfiguredError()
  return programId
}

function validateMetadataURI(uri: string): void {
  if (!uri) throw new Error("metadataURI is required")
  const byteLength = new TextEncoder().encode(uri).length
  if (byteLength > MAX_METADATA_URI_LEN) {
    throw new Error(
      `metadataURI is ${byteLength} bytes, exceeding the ${MAX_METADATA_URI_LEN}-byte cap.`,
    )
  }
}

export function decodeToolRecord(
  data: Uint8Array,
  address: SvmAddress,
): SvmToolRecord {
  if (data.length < 8 + 1 + 8 + 32 + 32 + 32 + 4) {
    throw new Error("ToolRecord account data is truncated")
  }
  const disc = data.slice(0, 8)
  for (let i = 0; i < 8; i++) {
    if (disc[i] !== TOOL_RECORD_DISCRIMINATOR[i]) {
      throw new Error("Account is not a ToolRecord")
    }
  }
  const bump = data[8] ?? 0
  const toolId = decodeU64Le(data, 9)
  const creator = bytesToAddress(data.slice(17, 49))
  const accessPredicate = bytesToAddress(data.slice(49, 81))
  const manifestHash = data.slice(81, 113)
  const uriLen = new DataView(data.buffer, data.byteOffset + 113, 4).getUint32(
    0,
    true,
  )
  const uriBytes = data.slice(117, 117 + uriLen)
  return {
    bump,
    toolId,
    creator,
    accessPredicate,
    manifestHash,
    metadataUri: new TextDecoder().decode(uriBytes),
    address,
  }
}

/**
 * Client for the SVM tool registry program. Reads use JSON-RPC; writes are
 * compiled to a legacy transaction and signed by an injected
 * {@link SvmWalletAdapter}. This client never holds a secret key and never
 * broadcasts unless the adapter implements `sendTransaction`.
 */
export class SvmToolRegistryClient {
  readonly network: SvmNetwork
  readonly rpc: SvmRpcClient
  readonly programId?: SvmAddress
  private readonly wallet?: SvmWalletAdapter

  constructor(config: SvmRegistryConfig) {
    this.network = config.network
    this.rpc = config.rpc
    this.programId = config.programId ?? config.network.registryProgramId
    this.wallet = config.wallet
  }

  configAddress(): SvmAddress {
    const programId = requireProgramId(this.programId)
    return findProgramAddress([configSeed()], programId).address
  }

  toolRecordAddress(toolId: bigint): SvmAddress {
    const programId = requireProgramId(this.programId)
    return findProgramAddress([toolRecordSeed(toolId)], programId).address
  }

  async getToolConfig(toolId: bigint): Promise<SvmToolRecord> {
    const address = this.toolRecordAddress(toolId)
    const info = await this.rpc.getAccountInfo(address)
    if (!info) {
      throw new Error(`Tool ${toolId} not found at ${address}`)
    }
    return decodeToolRecord(info.data, address)
  }

  async hasAccess(
    record: SvmToolRecord,
    _account: SvmAddress,
  ): Promise<{ ok: boolean; granted: boolean }> {
    // Open access: predicate is the system program (all-zero pubkey).
    if (record.accessPredicate === SYSTEM_PROGRAM_ADDRESS) {
      return { ok: true, granted: true }
    }
    // A custom predicate program is registered but this client cannot CPI
    // it without a deployed implementation. Surface "unknown" as not-ok
    // so gates fail closed rather than inventing a grant.
    return { ok: false, granted: false }
  }

  planRegisterTool(params: {
    creator: SvmAddress
    metadataURI: string
    manifest: object
    accessPredicate?: SvmAddress
    /** Placeholder tool id used to derive the record PDA in dry-run. */
    nextToolId?: bigint
  }): SvmInstructionPlan {
    const programId = requireProgramId(this.programId)
    validateMetadataURI(params.metadataURI)
    const hash = computeSvmManifestHash(params.manifest)
    const toolId = params.nextToolId ?? 0n
    const toolRecord = findProgramAddress(
      [toolRecordSeed(toolId)],
      programId,
    ).address
    const config = findProgramAddress([configSeed()], programId).address
    const predicate = params.accessPredicate ?? SYSTEM_PROGRAM_ADDRESS
    const ix = registerToolIx({
      programId,
      creator: params.creator,
      config,
      toolRecord,
      systemProgram: SYSTEM_PROGRAM_ADDRESS,
      metadataUri: params.metadataURI,
      manifestHash: hash.bytes,
      accessPredicate: predicate,
    })
    return {
      description: "register_tool",
      programId,
      instructions: [ix],
      accountKeys: ix.accounts.map(a => a.address),
      footprint: [
        `program: ${programId}`,
        `instruction: register_tool`,
        `creator (signer, writable): ${params.creator}`,
        `config PDA (writable): ${config}`,
        `tool record PDA (writable): ${toolRecord}  [toolId placeholder ${toolId}]`,
        `system program: ${SYSTEM_PROGRAM_ADDRESS}`,
        `metadata URI: ${params.metadataURI}`,
        `manifest SHA-256: ${hash.hex}`,
        `access predicate: ${predicate}`,
      ],
    }
  }

  planUpdateMetadata(params: {
    creator: SvmAddress
    toolId: bigint
    metadataURI: string
    manifest: object
  }): SvmInstructionPlan {
    const programId = requireProgramId(this.programId)
    validateMetadataURI(params.metadataURI)
    const hash = computeSvmManifestHash(params.manifest)
    const toolRecord = this.toolRecordAddress(params.toolId)
    const ix = updateToolMetadataIx({
      programId,
      creator: params.creator,
      toolRecord,
      toolId: params.toolId,
      metadataUri: params.metadataURI,
      manifestHash: hash.bytes,
    })
    return {
      description: "update_tool_metadata",
      programId,
      instructions: [ix],
      accountKeys: ix.accounts.map(a => a.address),
      footprint: [
        `program: ${programId}`,
        `instruction: update_tool_metadata`,
        `creator (signer): ${params.creator}`,
        `tool record: ${toolRecord}`,
        `toolId: ${params.toolId}`,
        `metadata URI: ${params.metadataURI}`,
        `manifest SHA-256: ${hash.hex}`,
      ],
    }
  }

  planSetAccessPredicate(params: {
    creator: SvmAddress
    toolId: bigint
    accessPredicate: SvmAddress
  }): SvmInstructionPlan {
    const programId = requireProgramId(this.programId)
    const toolRecord = this.toolRecordAddress(params.toolId)
    const ix = setAccessPredicateIx({
      programId,
      creator: params.creator,
      toolRecord,
      toolId: params.toolId,
      accessPredicate: params.accessPredicate,
    })
    return {
      description: "set_access_predicate",
      programId,
      instructions: [ix],
      accountKeys: ix.accounts.map(a => a.address),
      footprint: [
        `program: ${programId}`,
        `instruction: set_access_predicate`,
        `creator (signer): ${params.creator}`,
        `tool record: ${toolRecord}`,
        `new predicate: ${params.accessPredicate}`,
      ],
    }
  }

  /**
   * Compile + sign a plan. Does not broadcast. Callers that want a
   * signature on chain must use the adapter's `sendTransaction` themselves
   * after review; the CLI only does this when `--dry-run` is absent *and*
   * the adapter implements send.
   */
  async signPlan(
    plan: SvmInstructionPlan,
    recentBlockhash?: string,
  ): Promise<{ signedTransactionBase64: string; messageBase64: string }> {
    if (!this.wallet) {
      throw new Error("SVM wallet adapter required for signing")
    }
    const creator = await svmWalletAddress(this.wallet)
    const blockhash =
      recentBlockhash ?? (await this.rpc.getLatestBlockhash()).blockhash
    const message = compileLegacyMessage({
      feePayer: creator,
      recentBlockhash: blockhash,
      instructions: plan.instructions,
    })
    const messageBytes = serializeLegacyMessage(message)
    const unsigned = serializeLegacyTransaction({
      message: messageBytes,
      signatures: message.accountKeys
        .slice(0, message.header.numRequiredSignatures)
        .map(() => null),
    })
    const signed = await this.wallet.signTransaction({
      transaction: unsigned,
    })
    const signedB64 = signed.signedTransaction
    return {
      signedTransactionBase64: signedB64,
      messageBase64: encodeBase64(messageBytes),
    }
  }
}

export function formatPlan(plan: SvmInstructionPlan): string {
  return [
    `SVM ${plan.description} footprint:`,
    ...plan.footprint.map(l => `  ${l}`),
  ].join("\n")
}

/** Discriminator bytes, exported for tests that assemble account data. */
export { TOOL_RECORD_DISCRIMINATOR }
