import type { SvmWalletAdapter } from "@opensea/wallet-adapters"
import pc from "picocolors"
import { validateManifest } from "../../lib/manifest/index.js"
import {
  computeSvmManifestHash,
  formatPlan,
  getSvmNetwork,
  isSvmAddress,
  resolveSvmRpcUrl,
  SvmRegistryNotConfiguredError,
  SvmRpcClient,
  SvmToolRegistryClient,
  SYSTEM_PROGRAM_ADDRESS,
} from "../../lib/svm/index.js"
import { requireSvmAdapter, svmWalletAddress } from "../../lib/svm/wallet.js"
import {
  createWalletForProvider,
  createWalletFromEnv,
  isSvmAdapter,
  type WalletProvider,
} from "../../lib/wallet/index.js"
import { parseToolId } from "./shared.js"
import { warnBareExtensionKeys } from "./warn-bare-extensions.js"

export interface SvmUpdateMetadataOptions {
  toolId: string
  metadata: string
  network: string
  programId?: string
  walletProvider?: string
  rpcUrl?: string
  dryRun?: boolean
}

export async function runSvmUpdateMetadata(
  options: SvmUpdateMetadataOptions,
): Promise<void> {
  const toolId = parseToolId(
    options.toolId,
    "Error: --tool-id must be a numeric value",
  )
  const network = getSvmNetwork(options.network)
  const configuredProgramId =
    options.programId ??
    process.env.SVM_TOOL_REGISTRY_PROGRAM_ID ??
    network.registryProgramId

  console.log(pc.cyan("Fetching manifest..."))

  let response: globalThis.Response
  try {
    response = await fetch(options.metadata, {
      redirect: "manual",
      signal: AbortSignal.timeout(10_000),
    })
  } catch {
    console.error(pc.red(`Error: Failed to fetch ${options.metadata}`))
    process.exit(1)
  }
  if (response.status !== 200) {
    console.error(pc.red(`Error: HTTP ${response.status}`))
    process.exit(1)
  }

  let data: unknown
  try {
    data = await response.json()
  } catch {
    console.error(pc.red("Error: Response is not valid JSON"))
    process.exit(1)
  }

  const result = validateManifest(data)
  if (!result.success) {
    console.error(pc.red("Error: Manifest validation failed"))
    process.exit(1)
  }
  warnBareExtensionKeys(data)

  if (!isSvmAddress(result.data.creatorAddress)) {
    console.error(
      pc.red(
        `Error: creatorAddress "${result.data.creatorAddress}" is not a Solana public key.`,
      ),
    )
    process.exit(1)
  }

  let adapter: SvmWalletAdapter | undefined
  let creator = result.data.creatorAddress
  try {
    const wallet = options.walletProvider
      ? createWalletForProvider(options.walletProvider as WalletProvider, {
          chainType: "svm",
        })
      : createWalletFromEnv({ chainType: "svm" })
    if (!isSvmAdapter(wallet)) {
      throw new Error(`wallet "${wallet.name}" is ${wallet.chainType}, not svm`)
    }
    adapter = requireSvmAdapter(wallet, "SVM update-metadata")
    creator = await svmWalletAddress(adapter)
  } catch (err) {
    if (!options.dryRun) {
      console.error(
        pc.red(`Error: ${err instanceof Error ? err.message : String(err)}`),
      )
      process.exit(1)
    }
    console.log(
      pc.dim(
        "No SVM wallet configured; dry-run uses creatorAddress from the manifest.",
      ),
    )
  }

  const hash = computeSvmManifestHash(data as object)
  const rpcUrl = resolveSvmRpcUrl(options.rpcUrl, network)
  const rpc = new SvmRpcClient({ rpcUrl, network })
  const client = new SvmToolRegistryClient({
    network,
    rpc,
    programId: configuredProgramId ?? SYSTEM_PROGRAM_ADDRESS,
    wallet: adapter,
  })

  console.log(pc.cyan("\nSVM update-metadata summary"))
  console.log(`  Network:       ${network.name} (${network.caip2})`)
  console.log(`  RPC:           ${rpcUrl}`)
  console.log(`  Tool ID:       ${toolId}`)
  console.log(`  Creator:       ${creator}`)
  console.log(`  Metadata URI:  ${options.metadata}`)
  console.log(`  Manifest SHA-256: ${hash.hex}`)

  if (!configuredProgramId) {
    console.log()
    console.log(pc.yellow(new SvmRegistryNotConfiguredError().message))
    if (!options.dryRun) {
      console.error(
        pc.red(
          "Error: refusing to send a transaction without a program ID. Re-run with --dry-run or --program-id.",
        ),
      )
      process.exit(1)
    }
  }

  const plan = client.planUpdateMetadata({
    creator,
    toolId,
    metadataURI: options.metadata,
    manifest: data as object,
  })
  console.log()
  console.log(formatPlan(plan))

  if (options.dryRun) {
    console.log(pc.dim("\nDry run — no transaction signed or sent."))
    return
  }

  const signed = await client.signPlan(plan)
  console.log(pc.green("Signed transaction (base64):"))
  console.log(signed.signedTransactionBase64)
  console.log(
    pc.dim(
      "Broadcast this payload with your wallet adapter. This CLI does not send it automatically.",
    ),
  )
}
