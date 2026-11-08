import { Command } from "commander"
import pc from "picocolors"
import { validateManifest } from "../../lib/manifest/index.js"
import { computeManifestHash } from "../../lib/onchain/hash.js"
import { computeSvmManifestHash } from "../../lib/svm/hash.js"
import { loadManifest } from "./load-manifest.js"
import { warnBareExtensionKeys } from "./warn-bare-extensions.js"

export const hashCommand = new Command("hash")
  .description(
    "Compute the JCS hash of a tool manifest (keccak256 for ERC-8257, sha256 for SVM)",
  )
  .argument("[path]", "Path to manifest file", "./src/manifest.ts")
  .option(
    "--algorithm <alg>",
    "keccak256 (ERC-8257 default) or sha256 (SVM registry)",
    "keccak256",
  )
  .action(async (filePath: string, options: { algorithm: string }) => {
    const data = await loadManifest(filePath)

    const result = validateManifest(data)
    if (!result.success) {
      console.error(pc.red("Error: Manifest validation failed"))
      process.exit(1)
    }

    warnBareExtensionKeys(data)

    // Hash the manifest as served (ERC-8257 §2): the full document, not the
    // schema-stripped copy.
    if (options.algorithm === "sha256") {
      console.log(computeSvmManifestHash(data as object).hex)
      return
    }
    if (options.algorithm !== "keccak256") {
      console.error(
        pc.red('Error: --algorithm must be "keccak256" or "sha256"'),
      )
      process.exit(1)
    }
    const hash = computeManifestHash(data as object)
    console.log(hash)
  })
