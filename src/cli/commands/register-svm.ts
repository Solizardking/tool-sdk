import type { SvmWalletAdapter } from "@opensea/wallet-adapters"
import pc from "picocolors"
import { validateManifest } from "../../lib/manifest/index.js"
import {
  assertSvmAddress,
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
import { warnBareExtensionKeys } from "./warn-bare-extensions.js"

export interface SvmRegisterOptions {
  metadata: string
  network: string
  programId?: string
  splGate?: string
  splMinBalance?: string
  nftGate?: string
  walletProvider?: string
  rpcUrl?: string
  dryRun?: boolean
  yes?: boolean
}

export async function runSvmRegister(
  options: SvmRegisterOptions,
): Promise<void> {
  const network = getSvmNetwork(options.network)
  const programId =
    options.programId ??
    process.env.SVM_TOOL_REGISTRY_PROGRAM_ID ??
    network.registryProgramId

  console.log(pc.cyan("Verifying manifest..."))

  let response: globalThis.Response
  try {
    response = await fetch(options.metadata, { redirect: "manual" })
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
  const manifest = result.data

  const manifestOrigin = new URL(options.metadata).origin
  const endpointOrigin = new URL(manifest.endpoint).origin
  if (manifestOrigin !== endpointOrigin) {
    console.error(
      pc.red(
        "Error: Origin mismatch between manifest URL and declared endpoint",
      ),
    )
    process.exit(1)
  }

  if (!isSvmAddress(manifest.creatorAddress)) {
    console.error(
      pc.red(
        `Error: creatorAddress "${manifest.creatorAddress}" is not a Solana public key. SVM registration requires a base58 pubkey.`,
      ),
    )
    process.exit(1)
  }

  let adapter: SvmWalletAdapter | undefined
  let creator = manifest.creatorAddress
  try {
    const wallet = options.walletProvider
      ? createWalletForProvider(options.walletProvider as WalletProvider, {
          chainType: "svm",
        })
      : createWalletFromEnv({ chainType: "svm" })
    if (!isSvmAdapter(wallet)) {
      throw new Error(`wallet "${wallet.name}" is ${wallet.chainType}, not svm`)
    }
    adapter = requireSvmAdapter(wallet, "SVM register")
    creator = await svmWalletAddress(adapter)
    if (creator !== manifest.creatorAddress) {
      console.error(
        pc.red(
          `Error: manifest creatorAddress ${manifest.creatorAddress} does not match your wallet ${creator}`,
        ),
      )
      process.exit(1)
    }
  } catch (err) {
    if (!options.dryRun) {
      console.error(
        pc.red(`Error: ${err instanceof Error ? err.message : String(err)}`),
      )
      console.error(
        pc.dim(
          "Configure an SVM wallet via PRIVY_SVM_WALLET_ID (and Privy credentials) or --wallet-provider. Do not pass a Solana secret key; use an external signer.",
        ),
      )
      process.exit(1)
    }
    console.log(
      pc.dim(
        "No SVM wallet configured; dry-run uses creatorAddress from the manifest.",
      ),
    )
  }

  if (options.splGate) assertSvmAddress(options.splGate, "--spl-gate")
  if (options.nftGate) assertSvmAddress(options.nftGate, "--nft-gate")

  const hash = computeSvmManifestHash(data as object)
  const rpcUrl = resolveSvmRpcUrl(options.rpcUrl, network)
  const rpc = new SvmRpcClient({ rpcUrl, network })
  const configuredProgramId = programId
  const effectiveProgramId = configuredProgramId ?? SYSTEM_PROGRAM_ADDRESS
  const client = new SvmToolRegistryClient({
    network,
    rpc,
    programId: effectiveProgramId,
    wallet: adapter,
  })

  let accessNote = "open (system program)"
  if (options.splGate) {
    accessNote = `SPL token gate mint=${options.splGate} min=${options.splMinBalance ?? "1"} (RPC policy; also set solana.tool-sdk/access on the manifest)`
  } else if (options.nftGate) {
    accessNote = `SPL NFT gate mint=${options.nftGate}`
  }

  console.log(pc.cyan("\nSVM registration summary"))
  console.log(`  Network:       ${network.name} (${network.caip2})`)
  console.log(`  RPC:           ${rpcUrl}`)
  console.log(
    `  Program ID:    ${
      configuredProgramId ??
      `${SYSTEM_PROGRAM_ADDRESS} (dry-run placeholder; pass --program-id)`
    }`,
  )
  console.log(`  Creator:       ${creator}`)
  console.log(`  Metadata URI:  ${options.metadata}`)
  console.log(`  Manifest SHA-256: ${hash.hex}`)
  console.log(`  Access:        ${accessNote}`)

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

  const plan = client.planRegisterTool({
    creator,
    metadataURI: options.metadata,
    manifest: data as object,
  })
  console.log()
  console.log(formatPlan(plan))

  if (options.dryRun) {
    console.log(pc.dim("\nDry run — no transaction signed or sent."))
    return
  }

  console.log(
    pc.yellow(
      "\nSigning with the external SVM wallet (will not broadcast unless the adapter implements sendTransaction)...",
    ),
  )
  const signed = await client.signPlan(plan)
  console.log(pc.green("Signed transaction (base64):"))
  console.log(signed.signedTransactionBase64)
  console.log(
    pc.dim(
      "Broadcast this payload with your wallet adapter or a trusted RPC. This CLI does not send it automatically unless the adapter's sendTransaction is used by the caller.",
    ),
  )
}
