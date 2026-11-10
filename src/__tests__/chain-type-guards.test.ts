import type { SvmWalletAdapter } from "@opensea/wallet-adapters"
import { afterEach, describe, expect, it, vi } from "vitest"

/**
 * The CLI commands that sign EIP-712 reject a non-EVM wallet up front.
 *
 * Its own file because `vi.doMock` only affects imports that happen after it, and the other suites
 * for these commands have already pulled the wallet module into the registry.
 */

const svm: SvmWalletAdapter = {
  name: "svm-mock",
  chainType: "svm",
  capabilities: {
    signMessage: true,
    signTypedData: false,
    managedGas: false,
    managedNonce: false,
  },
  getAddress: async () => "So11111111111111111111111111111111111111112",
  signTransaction: async () => ({ signedTransaction: "" }),
}

describe("EIP-712 commands reject a Solana wallet", () => {
  afterEach(() => {
    vi.restoreAllMocks()
    vi.resetModules()
    vi.doUnmock("../lib/wallet/index.js")
    delete process.env.PRIVATE_KEY
  })

  const arrange = async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {})
    vi.spyOn(console, "log").mockImplementation(() => {})
    vi.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("process.exit")
    })
    vi.resetModules()
    vi.doMock("../lib/wallet/index.js", async () => ({
      ...(await vi.importActual<object>("../lib/wallet/index.js")),
      createWalletFromEnv: () => svm,
    }))
    // Present so the command reaches the wallet path rather than the "no wallet configured" exit.
    process.env.PRIVATE_KEY = `0x${"1".repeat(64)}`
    return errorSpy
  }

  it("auth uses SIWS for a Solana wallet instead of checksumming it as EVM", async () => {
    const errorSpy = await arrange()
    const { authCommand } = await import("../cli/commands/auth.js")

    await expect(
      authCommand.parseAsync([
        "node",
        "auth",
        "https://tool.example.com/api",
        "--body",
        "{}",
      ]),
    ).rejects.toThrow("process.exit")

    const output = errorSpy.mock.calls.map(c => c.join(" ")).join("\n")
    expect(output).not.toContain("requires an EVM wallet")
    expect(output).not.toContain("Failed to retrieve wallet address")
    expect(output).toMatch(/signMessage|Failed to reach/i)
  })

  it("smoke rejects it before checksumming the address", async () => {
    const errorSpy = await arrange()
    const { smokeCommand } = await import("../cli/commands/smoke.js")

    await expect(
      smokeCommand.parseAsync([
        "node",
        "smoke",
        "--endpoint",
        "https://tool.example.com/api",
      ]),
    ).rejects.toThrow("process.exit")

    const output = errorSpy.mock.calls.map(c => c.join(" ")).join("\n")
    expect(output).toContain("signs for svm")
    expect(output).toContain("requires an EVM wallet")
    expect(output).not.toContain("Failed to retrieve wallet address")
  })

  it("names the provider so the caller knows which wallet to change", async () => {
    const errorSpy = await arrange()
    const { smokeCommand } = await import("../cli/commands/smoke.js")

    await expect(
      smokeCommand.parseAsync([
        "node",
        "smoke",
        "--endpoint",
        "https://tool.example.com/api",
      ]),
    ).rejects.toThrow("process.exit")

    expect(errorSpy.mock.calls.map(c => c.join(" ")).join("\n")).toContain(
      '"svm-mock"',
    )
  })
})
