import { describe, expect, it } from "vitest"
import { defaultRpcUrl, getChain } from "../cli/commands/get-chain.js"

describe("getChain", () => {
  it.each([
    ["mainnet", 1],
    ["base", 8453],
    ["base-sepolia", 84532],
    ["shape", 360],
    ["abstract", 2741],
    ["monad", 143],
    ["robinhood", 4663],
  ])("returns the %s chain with id %i", (network, chainId) => {
    expect(getChain(network).id).toBe(chainId)
  })

  it("throws on an unsupported network", () => {
    expect(() => getChain("dogechain")).toThrow(
      "Unsupported network: dogechain",
    )
  })

  it("rejects SVM names with an EVM-only message", () => {
    expect(() => getChain("solana")).toThrow(/Solana\/SVM/)
    expect(() => getChain("solana-devnet")).toThrow(/Solana\/SVM/)
    expect(() => getChain("mainnet-beta")).toThrow(/Solana\/SVM/)
  })

  it("routes solana names through resolveCliNetwork as SVM", async () => {
    const { resolveCliNetwork } = await import("../cli/commands/get-chain.js")
    expect(resolveCliNetwork("solana").family).toBe("svm")
    expect(resolveCliNetwork("base").family).toBe("evm")
  })

  it("defines robinhood with an RPC URL, explorer, and multicall3", () => {
    const chain = getChain("robinhood")
    expect(defaultRpcUrl(chain)).toBe("https://rpc.mainnet.chain.robinhood.com")
    expect(chain.blockExplorers?.default.name).toBe("Etherscan")
    expect(chain.blockExplorers?.default.url).toBe("https://robin.etherscan.io")
    expect(chain.blockExplorers?.default).toMatchObject({
      apiUrl: "https://api.etherscan.io/v2/api?chainid=4663",
    })
    expect(chain.contracts?.multicall3?.address).toBe(
      "0xcA11bde05977b3631167028862bE2a173976CA11",
    )
  })
})
