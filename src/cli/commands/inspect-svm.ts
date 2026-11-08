import pc from "picocolors"
import { validateManifest } from "../../lib/manifest/index.js"
import {
  assertSvmAddress,
  checkSvmToolAccess,
  computeSvmManifestHash,
  getSvmNetwork,
  parseSvmAccessExtension,
  resolveSvmRpcUrl,
  SvmRpcClient,
  SvmToolRegistryClient,
  SYSTEM_PROGRAM_ADDRESS,
} from "../../lib/svm/index.js"
import { parseToolId } from "./shared.js"

export interface SvmInspectOptions {
  toolId?: string
  network: string
  programId?: string
  checkAccess?: string
  splGate?: string
  splMinBalance?: string
  rpcUrl?: string
  metadata?: string
}

export async function runSvmInspect(options: SvmInspectOptions): Promise<void> {
  const network = getSvmNetwork(options.network)
  const rpcUrl = resolveSvmRpcUrl(options.rpcUrl, network)
  const rpc = new SvmRpcClient({ rpcUrl, network })
  const programId =
    options.programId ?? process.env.SVM_TOOL_REGISTRY_PROGRAM_ID

  console.log(pc.cyan("SVM inspect"))
  console.log(`  Network: ${network.name} (${network.caip2})`)
  console.log(`  RPC:     ${rpcUrl}`)

  if (options.toolId && programId) {
    const toolId = parseToolId(options.toolId)
    const client = new SvmToolRegistryClient({ network, rpc, programId })
    try {
      const record = await client.getToolConfig(toolId)
      console.log(pc.cyan("\nOnchain ToolRecord:"))
      console.log(`  Address:          ${record.address}`)
      console.log(`  Creator:          ${record.creator}`)
      console.log(`  Metadata URI:     ${record.metadataUri}`)
      console.log(
        `  Manifest SHA-256: 0x${Buffer.from(record.manifestHash).toString("hex")}`,
      )
      console.log(
        `  Predicate:        ${
          record.accessPredicate === SYSTEM_PROGRAM_ADDRESS
            ? "open (system program)"
            : record.accessPredicate
        }`,
      )

      if (record.metadataUri) {
        try {
          const res = await fetch(record.metadataUri)
          const body = (await res.json()) as object
          const live = computeSvmManifestHash(body)
          const onchain = Buffer.from(record.manifestHash).toString("hex")
          const liveHex = live.hex.slice(2)
          console.log(pc.cyan("\nLive manifest:"))
          console.log(`  SHA-256:  ${live.hex}`)
          console.log(
            liveHex === onchain
              ? pc.green("  Hash matches on-chain record")
              : pc.red("  Hash DOES NOT match on-chain record"),
          )
          const parsed = validateManifest(body)
          if (!parsed.success) {
            console.log(pc.red("  Manifest failed schema validation"))
          }
        } catch (err) {
          console.log(
            pc.yellow(
              `  Could not fetch live manifest: ${
                err instanceof Error ? err.message : String(err)
              }`,
            ),
          )
        }
      }
    } catch (err) {
      console.error(pc.red("Error: Failed to read ToolRecord"))
      console.error(err instanceof Error ? err.message : String(err))
      process.exit(1)
    }
  } else if (options.toolId && !programId) {
    console.log(
      pc.yellow(
        "\nNo registry program ID — skipping on-chain ToolRecord. Pass --program-id or SVM_TOOL_REGISTRY_PROGRAM_ID.",
      ),
    )
  }

  if (options.checkAccess) {
    const account = assertSvmAddress(options.checkAccess, "--check-access")
    const policy = options.splGate
      ? {
          logic: "AND" as const,
          requirements: [
            {
              kind: "spl-token-balance" as const,
              mint: assertSvmAddress(options.splGate, "--spl-gate"),
              minAmount: BigInt(options.splMinBalance ?? "1"),
            },
          ],
        }
      : undefined
    const result = await checkSvmToolAccess({ account, rpc, policy })
    console.log(pc.cyan("\nAccess check (RPC):"))
    console.log(`  Account: ${account}`)
    console.log(`  ok:      ${result.ok}`)
    console.log(`  granted: ${result.granted}`)
    for (const detail of result.details) {
      console.log(
        `  - ${detail.kind}: ${detail.granted ? "yes" : "no"}${
          detail.reason ? ` (${detail.reason})` : ""
        }`,
      )
    }
  }

  if (options.metadata) {
    const res = await fetch(options.metadata)
    const body = (await res.json()) as Record<string, unknown>
    const ext = parseSvmAccessExtension(body)
    if (ext) {
      console.log(pc.cyan("\nsolana.tool-sdk/access:"))
      console.log(`  logic: ${ext.logic}`)
      for (const req of ext.requirements) {
        console.log(`  - ${JSON.stringify(req)}`)
      }
    }
  }
}
