import { validateManifest } from "@opensea/tool-sdk"
import { describe, expect, it } from "vitest"
import { buildSvmEchoManifest } from "../manifest.js"

const CREATOR = "11111111111111111111111111111111"
const MINT = "So11111111111111111111111111111111111111112"

describe("svm-echo manifest", () => {
  it("validates with a Solana creator", () => {
    const def = buildSvmEchoManifest({
      creator: CREATOR,
      endpoint: "https://example.com/svm-echo",
    })
    const resolved = typeof def === "function" ? def({}) : def
    const result = validateManifest(resolved)
    expect(result.success).toBe(true)
  })

  it("embeds an SPL access extension", () => {
    const def = buildSvmEchoManifest({
      creator: CREATOR,
      endpoint: "https://example.com/svm-echo",
      splMint: MINT,
      splMinAmount: "1",
    })
    const resolved = typeof def === "function" ? def({}) : def
    const ext = (resolved as Record<string, unknown>)["solana.tool-sdk/access"]
    expect(ext).toMatchObject({
      logic: "AND",
      requirements: [{ kind: "spl-token-balance", mint: MINT }],
    })
  })
})
