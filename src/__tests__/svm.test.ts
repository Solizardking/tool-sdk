import { ed25519 } from "@noble/curves/ed25519"
import { describe, expect, it } from "vitest"
import { resolveCliNetwork } from "../cli/commands/get-chain.js"
import { resolveNetwork } from "../lib/client/x402-challenge.js"
import { validatePaymentRequirements } from "../lib/client/x402-payment.js"
import { ExactSvmScheme } from "../lib/client/x402-svm.js"
import { validateManifest } from "../lib/manifest/index.js"
import { siwsGate } from "../lib/middleware/siws-gate.js"
import { svmPredicateGate } from "../lib/middleware/svm-predicate-gate.js"
import {
  findAssociatedTokenAddress,
  findProgramAddress,
  isOnCurve,
  isSvmAddress,
  SYSTEM_PROGRAM_ADDRESS,
  TOKEN_PROGRAM_ADDRESS,
} from "../lib/svm/address.js"
import { decodeBase58, encodeBase58 } from "../lib/svm/base58.js"
import {
  compileLegacyMessage,
  decodeCompactU16,
  encodeCompactU16,
  serializeLegacyMessage,
} from "../lib/svm/codec.js"
import { computeSvmManifestHash } from "../lib/svm/hash.js"
import {
  getSvmNetwork,
  isSvmNetworkName,
  SVM_CAIP2,
} from "../lib/svm/networks.js"
import { evaluateSvmAccessPolicy } from "../lib/svm/predicates.js"
import { SvmToolRegistryClient } from "../lib/svm/registry.js"
import { SvmRpcClient } from "../lib/svm/rpc.js"
import {
  createSiwsAuthHeader,
  createSiwsMessage,
  parseSiwsAuthHeader,
  verifySiws,
} from "../lib/svm/siws.js"
import { createExternalSvmSigner } from "../lib/svm/wallet.js"
import { createMockSvmManifest } from "../testing/index.js"

const WSOL = "So11111111111111111111111111111111111111112"

describe("base58", () => {
  it("round-trips 32 zero bytes as the system program address", () => {
    const zeros = new Uint8Array(32)
    expect(encodeBase58(zeros)).toBe(SYSTEM_PROGRAM_ADDRESS)
    expect(decodeBase58(SYSTEM_PROGRAM_ADDRESS)).toEqual(zeros)
  })

  it("rejects invalid alphabet", () => {
    expect(() => decodeBase58("0OIl")).toThrow(/invalid character/)
  })
})

describe("addresses", () => {
  it("accepts well-known program ids", () => {
    expect(isSvmAddress(SYSTEM_PROGRAM_ADDRESS)).toBe(true)
    expect(isSvmAddress(TOKEN_PROGRAM_ADDRESS)).toBe(true)
    expect(isSvmAddress(WSOL)).toBe(true)
    expect(isSvmAddress("0xabc")).toBe(false)
    expect(isSvmAddress("not-an-address")).toBe(false)
  })

  it("derives a PDA that is off-curve", () => {
    const seed = new TextEncoder().encode("tool")
    const pda = findProgramAddress([seed], SYSTEM_PROGRAM_ADDRESS)
    expect(isSvmAddress(pda.address)).toBe(true)
    expect(pda.bump).toBeGreaterThanOrEqual(0)
    expect(pda.bump).toBeLessThanOrEqual(255)
    expect(isOnCurve(decodeBase58(pda.address))).toBe(false)
  })

  it("derives an associated token account", () => {
    const ata = findAssociatedTokenAddress(WSOL, WSOL)
    expect(isSvmAddress(ata.address)).toBe(true)
  })
})

describe("compact-u16", () => {
  it.each([
    [0, [0]],
    [127, [127]],
    [128, [128, 1]],
  ] as const)("encodes %i", (n, bytes) => {
    expect([...encodeCompactU16(n)]).toEqual([...bytes])
    expect(decodeCompactU16(Uint8Array.from(bytes)).value).toBe(n)
  })
})

describe("networks", () => {
  it("maps solana CLI names and CAIP-2 ids", () => {
    expect(getSvmNetwork("solana").caip2).toBe(SVM_CAIP2.mainnet)
    expect(getSvmNetwork(SVM_CAIP2.devnet).name).toBe("solana-devnet")
    expect(isSvmNetworkName("solana-testnet")).toBe(true)
    expect(isSvmNetworkName("base")).toBe(false)
  })

  it("does not steal the EVM `mainnet` CLI name", () => {
    expect(isSvmNetworkName("mainnet")).toBe(false)
    expect(resolveCliNetwork("mainnet").family).toBe("evm")
    expect(resolveCliNetwork("solana").family).toBe("svm")
    expect(resolveCliNetwork("mainnet-beta").family).toBe("svm")
  })

  it("accepts custom solana: CAIP-2 clusters", () => {
    const custom = getSvmNetwork("solana:MyCustomGenesisHashPrefixxxxx")
    expect(custom.cluster).toBe("custom")
    expect(custom.caip2.startsWith("solana:")).toBe(true)
  })
})

describe("manifest", () => {
  it("accepts a Solana creatorAddress", () => {
    const result = validateManifest(createMockSvmManifest())
    expect(result.success).toBe(true)
  })

  it("preserves solana.tool-sdk/access as a namespaced extension", () => {
    const manifest = createMockSvmManifest({
      "solana.tool-sdk/access": {
        logic: "AND",
        requirements: [
          {
            kind: "spl-token-balance",
            mint: WSOL,
            minAmount: "1",
          },
        ],
      },
    } as never)
    const result = validateManifest(manifest)
    expect(result.success).toBe(true)
    if (!result.success) throw new Error("expected success")
    expect(
      (result.data as Record<string, unknown>)["solana.tool-sdk/access"],
    ).toMatchObject({ logic: "AND" })
  })

  it("hashes with SHA-256 stably", () => {
    const a = computeSvmManifestHash(createMockSvmManifest())
    const b = computeSvmManifestHash(createMockSvmManifest())
    expect(a.hex).toBe(b.hex)
    expect(a.bytes.length).toBe(32)
    expect(a.hex.startsWith("0x")).toBe(true)
  })
})

describe("SIWS", () => {
  it("round-trips a signed message", () => {
    const priv = ed25519.utils.randomPrivateKey()
    const pub = ed25519.getPublicKey(priv)
    const address = encodeBase58(pub)
    const message = createSiwsMessage({
      domain: "tools.example.com",
      address,
      uri: "https://tools.example.com/api",
      chainId: "mainnet",
      nonce: "abc",
      issuedAt: "2026-01-01T00:00:00.000Z",
      expirationTime: "2099-01-01T00:00:00.000Z",
    })
    const sig = ed25519.sign(new TextEncoder().encode(message), priv)
    const verified = verifySiws({
      message,
      signature: encodeBase58(sig),
      expectedDomain: "tools.example.com",
      expectedUri: "https://tools.example.com/api",
      expectedChainId: "mainnet",
    })
    expect(verified.address).toBe(address)

    const header = createSiwsAuthHeader(message, sig)
    const parsed = parseSiwsAuthHeader(header)
    expect(parsed.message).toBe(message)
  })
})

describe("siwsGate", () => {
  it("returns 401 without a header and passes a valid SIWS header", async () => {
    const priv = ed25519.utils.randomPrivateKey()
    const pub = ed25519.getPublicKey(priv)
    const address = encodeBase58(pub)
    const gate = siwsGate({
      domain: "tools.example.com",
      audience: "https://tools.example.com/api",
      chainId: "mainnet",
    })
    const missing = await gate.check(
      new Request("https://tools.example.com/api", { method: "POST" }),
      { gates: {} },
    )
    expect(missing?.status).toBe(401)

    const message = createSiwsMessage({
      domain: "tools.example.com",
      address,
      uri: "https://tools.example.com/api",
      chainId: "mainnet",
      nonce: "n1",
      issuedAt: new Date().toISOString(),
      expirationTime: new Date(Date.now() + 60_000).toISOString(),
    })
    const sig = ed25519.sign(new TextEncoder().encode(message), priv)
    const ctx: { callerAddress?: string; gates: Record<string, unknown> } = {
      gates: {},
    }
    const ok = await gate.check(
      new Request("https://tools.example.com/api", {
        method: "POST",
        headers: { Authorization: createSiwsAuthHeader(message, sig) },
      }),
      ctx,
    )
    expect(ok).toBeNull()
    expect(ctx.callerAddress).toBe(address)
  })
})

describe("RPC predicates", () => {
  it("grants SPL token balance when the mock RPC reports enough", async () => {
    const rpc = new SvmRpcClient({
      transport: async (method, params) => {
        if (method !== "getTokenAccountsByOwner") {
          throw new Error(method)
        }
        const owner = params[0]
        return {
          value: [
            {
              pubkey: WSOL,
              account: {
                owner: TOKEN_PROGRAM_ADDRESS,
                data: {
                  parsed: {
                    info: {
                      mint: WSOL,
                      owner,
                      tokenAmount: {
                        amount: "5",
                        decimals: 0,
                        uiAmount: 5,
                        uiAmountString: "5",
                      },
                    },
                  },
                },
              },
            },
          ],
        }
      },
    })
    const granted = await evaluateSvmAccessPolicy(rpc, WSOL, {
      logic: "AND",
      requirements: [{ kind: "spl-token-balance", mint: WSOL, minAmount: 1n }],
    })
    expect(granted).toMatchObject({ ok: true, granted: true })

    const denied = await evaluateSvmAccessPolicy(rpc, WSOL, {
      logic: "AND",
      requirements: [{ kind: "spl-token-balance", mint: WSOL, minAmount: 10n }],
    })
    expect(denied.granted).toBe(false)
  })
})

describe("svmPredicateGate", () => {
  it("403s when the SPL policy is not met", async () => {
    const priv = ed25519.utils.randomPrivateKey()
    const pub = ed25519.getPublicKey(priv)
    const address = encodeBase58(pub)
    const message = createSiwsMessage({
      domain: "tools.example.com",
      address,
      uri: "https://tools.example.com/api",
      chainId: "mainnet",
      nonce: "n2",
      issuedAt: new Date().toISOString(),
    })
    const sig = ed25519.sign(new TextEncoder().encode(message), priv)
    const gate = svmPredicateGate({
      domain: "tools.example.com",
      audience: "https://tools.example.com/api",
      chainId: "mainnet",
      policy: {
        logic: "AND",
        requirements: [
          { kind: "spl-token-balance", mint: WSOL, minAmount: 1n },
        ],
      },
      transport: async () => ({ value: [] }),
    })
    const res = await gate.check(
      new Request("https://tools.example.com/api", {
        method: "POST",
        headers: { Authorization: createSiwsAuthHeader(message, sig) },
      }),
      { gates: {} },
    )
    expect(res?.status).toBe(403)
  })
})

describe("registry dry-run plan", () => {
  it("prints a register_tool footprint without sending", () => {
    const client = new SvmToolRegistryClient({
      network: getSvmNetwork("solana"),
      rpc: new SvmRpcClient({
        transport: async () => {
          throw new Error("no live RPC")
        },
      }),
      programId: TOKEN_PROGRAM_ADDRESS,
    })
    const plan = client.planRegisterTool({
      creator: WSOL,
      metadataURI: "https://tools.example.com/.well-known/ai-tool/x.json",
      manifest: createMockSvmManifest(),
    })
    expect(plan.description).toBe("register_tool")
    expect(plan.footprint.some(l => l.includes("register_tool"))).toBe(true)
    expect(plan.instructions).toHaveLength(1)
  })

  it("prints an update_tool_metadata footprint without sending", () => {
    const client = new SvmToolRegistryClient({
      network: getSvmNetwork("solana"),
      rpc: new SvmRpcClient({
        transport: async () => {
          throw new Error("no live RPC")
        },
      }),
      programId: TOKEN_PROGRAM_ADDRESS,
    })
    const plan = client.planUpdateMetadata({
      creator: WSOL,
      toolId: 1n,
      metadataURI: "https://tools.example.com/.well-known/ai-tool/x.json",
      manifest: createMockSvmManifest(),
    })
    expect(plan.description).toBe("update_tool_metadata")
    expect(plan.footprint.some(l => l.includes("SHA-256"))).toBe(true)
  })
})

describe("legacy message compile", () => {
  it("places the fee payer first", () => {
    const message = compileLegacyMessage({
      feePayer: WSOL,
      recentBlockhash: SYSTEM_PROGRAM_ADDRESS,
      instructions: [
        {
          programId: TOKEN_PROGRAM_ADDRESS,
          accounts: [{ address: WSOL, isSigner: true, isWritable: false }],
          data: new Uint8Array([1]),
        },
      ],
    })
    expect(message.accountKeys[0]).toBe(WSOL)
    const bytes = serializeLegacyMessage(message)
    expect(bytes.length).toBeGreaterThan(32)
  })
})

describe("x402 SVM", () => {
  it("resolves solana networks to the USDC mint", () => {
    const resolved = resolveNetwork("solana")
    expect(resolved?.family).toBe("svm")
    expect(resolved?.usdc).toBe("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v")
  })

  it("refuses the system program as payTo and keeps pubkey case", () => {
    expect(() =>
      validatePaymentRequirements(
        {
          scheme: "exact",
          network: "solana",
          maxAmountRequired: "1000",
          payTo: SYSTEM_PROGRAM_ADDRESS,
          asset: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
        },
        {},
      ),
    ).toThrow(/system program/)
  })

  it("signs a TransferChecked payload through an external SVM signer", async () => {
    const priv = ed25519.utils.randomPrivateKey()
    const pub = ed25519.getPublicKey(priv)
    const address = encodeBase58(pub)
    const signer = createExternalSvmSigner({
      address,
      signTransaction: async tx => tx,
    })
    const scheme = new ExactSvmScheme(signer)
    const result = await scheme.createPaymentPayload(1, {
      scheme: "exact",
      network: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
      asset: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
      amount: "1000",
      payTo: WSOL,
      maxTimeoutSeconds: 60,
      extra: {
        feePayer: TOKEN_PROGRAM_ADDRESS,
        recentBlockhash: SYSTEM_PROGRAM_ADDRESS,
      },
    } as never)
    const payload = (result as unknown as { payload: { transaction: string } })
      .payload
    expect(typeof payload.transaction).toBe("string")
    expect(payload.transaction.length).toBeGreaterThan(0)
  })
})
