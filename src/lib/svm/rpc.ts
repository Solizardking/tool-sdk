import type { SvmAddress } from "./address.js"
import { assertSvmAddress } from "./address.js"
import type { SvmNetwork } from "./networks.js"

export interface SvmRpcRequest {
  method: string
  params?: unknown[]
}

export interface SvmAccountInfo {
  lamports: number
  owner: SvmAddress
  executable: boolean
  rentEpoch: number
  data: Uint8Array
}

export interface ParsedTokenAmount {
  amount: string
  decimals: number
  uiAmount: number | null
  uiAmountString: string
}

export interface ParsedTokenAccount {
  pubkey: SvmAddress
  mint: SvmAddress
  owner: SvmAddress
  amount: string
  decimals: number
  tokenProgram: SvmAddress
}

export interface LatestBlockhash {
  blockhash: string
  lastValidBlockHeight: number
}

export type SvmRpcTransport = (
  method: string,
  params: unknown[],
) => Promise<unknown>

export interface SvmRpcClientConfig {
  /** JSON-RPC HTTP endpoint. Ignored when `transport` is supplied. */
  rpcUrl?: string
  /** Network, used only for default RPC URL and genesis-hash checks. */
  network?: SvmNetwork
  /**
   * Injected JSON-RPC transport. Tests pass a fake; production uses
   * `fetch` against `rpcUrl`.
   */
  transport?: SvmRpcTransport
  /** Optional fetch implementation (defaults to global fetch). */
  fetchImpl?: typeof fetch
  /**
   * When set, `getGenesisHash()` is compared to this value the first time
   * it is fetched. A mismatch means the RPC is on a different cluster.
   */
  expectedGenesisHash?: string
}

interface JsonRpcResponse {
  jsonrpc: "2.0"
  id: number
  result?: unknown
  error?: { code: number; message: string }
}

/**
 * Minimal Solana JSON-RPC client. Read-only by construction: there is no
 * `sendTransaction`. Writes go through a {@link SvmWalletAdapter} so a
 * server never holds a hot key.
 */
export class SvmRpcClient {
  readonly rpcUrl: string
  private readonly transport: SvmRpcTransport
  private readonly expectedGenesisHash?: string
  private genesisChecked = false

  constructor(config: SvmRpcClientConfig = {}) {
    this.rpcUrl =
      config.rpcUrl ??
      config.network?.defaultRpcUrl ??
      "https://api.mainnet-beta.solana.com"
    this.expectedGenesisHash =
      config.expectedGenesisHash ?? config.network?.genesisHash
    this.transport =
      config.transport ??
      (async (method, params) => {
        const fetchImpl = config.fetchImpl ?? globalThis.fetch
        const res = await fetchImpl(this.rpcUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method,
            params,
          }),
        })
        if (!res.ok) {
          throw new Error(`SVM RPC ${this.rpcUrl} returned HTTP ${res.status}`)
        }
        const body = (await res.json()) as JsonRpcResponse
        if (body.error) {
          throw new Error(
            `SVM RPC ${method} failed (${body.error.code}): ${body.error.message}`,
          )
        }
        return body.result
      })
  }

  async call<T>(method: string, params: unknown[] = []): Promise<T> {
    return (await this.transport(method, params)) as T
  }

  async getGenesisHash(): Promise<string> {
    const hash = await this.call<string>("getGenesisHash")
    if (
      this.expectedGenesisHash &&
      !this.genesisChecked &&
      hash !== this.expectedGenesisHash &&
      !hash.startsWith(this.expectedGenesisHash)
    ) {
      throw new Error(
        `SVM RPC genesis hash ${hash} does not match expected ${this.expectedGenesisHash}. Check SOLANA_RPC_URL / --rpc-url.`,
      )
    }
    this.genesisChecked = true
    return hash
  }

  async getBalance(address: SvmAddress): Promise<bigint> {
    assertSvmAddress(address, "address")
    const result = await this.call<{ value: number } | number>("getBalance", [
      address,
    ])
    if (typeof result === "number") return BigInt(result)
    return BigInt(result.value)
  }

  async getLatestBlockhash(): Promise<LatestBlockhash> {
    const result = await this.call<{
      value: { blockhash: string; lastValidBlockHeight: number }
    }>("getLatestBlockhash", [{ commitment: "confirmed" }])
    return result.value
  }

  async getAccountInfo(address: SvmAddress): Promise<SvmAccountInfo | null> {
    assertSvmAddress(address, "address")
    const result = await this.call<{
      value: {
        lamports: number
        owner: string
        executable: boolean
        rentEpoch: number
        data: [string, string]
      } | null
    }>("getAccountInfo", [address, { encoding: "base64" }])
    if (!result.value) return null
    const raw = result.value.data[0] ?? ""
    return {
      lamports: result.value.lamports,
      owner: result.value.owner,
      executable: result.value.executable,
      rentEpoch: result.value.rentEpoch,
      data: Uint8Array.from(Buffer.from(raw, "base64")),
    }
  }

  async getTokenAccountsByOwner(
    owner: SvmAddress,
    filter: { mint: SvmAddress } | { programId: SvmAddress },
  ): Promise<ParsedTokenAccount[]> {
    assertSvmAddress(owner, "owner")
    const result = await this.call<{
      value: Array<{
        pubkey: string
        account: {
          owner: string
          data: {
            parsed?: {
              info?: {
                mint?: string
                owner?: string
                tokenAmount?: ParsedTokenAmount
              }
            }
          }
        }
      }>
    }>("getTokenAccountsByOwner", [owner, filter, { encoding: "jsonParsed" }])

    const accounts: ParsedTokenAccount[] = []
    for (const entry of result.value ?? []) {
      const info = entry.account.data.parsed?.info
      const amount = info?.tokenAmount?.amount
      const mint = info?.mint
      const tokenOwner = info?.owner
      if (!amount || !mint || !tokenOwner) continue
      accounts.push({
        pubkey: entry.pubkey,
        mint,
        owner: tokenOwner,
        amount,
        decimals: info.tokenAmount?.decimals ?? 0,
        tokenProgram: entry.account.owner,
      })
    }
    return accounts
  }

  async getProgramAccounts(
    programId: SvmAddress,
    filters: unknown[] = [],
  ): Promise<Array<{ pubkey: SvmAddress; data: Uint8Array }>> {
    assertSvmAddress(programId, "programId")
    const result = await this.call<
      Array<{ pubkey: string; account: { data: [string, string] } }>
    >("getProgramAccounts", [programId, { encoding: "base64", filters }])
    return (result ?? []).map(entry => ({
      pubkey: entry.pubkey,
      data: Uint8Array.from(Buffer.from(entry.account.data[0] ?? "", "base64")),
    }))
  }
}

/** Resolve RPC URL: flag > env (`SOLANA_RPC_URL` then `SVM_RPC_URL` then `RPC_URL`) > network default. */
export function resolveSvmRpcUrl(
  cliRpcUrl: string | undefined,
  network: SvmNetwork,
): string {
  return (
    cliRpcUrl ??
    process.env.SOLANA_RPC_URL ??
    process.env.SVM_RPC_URL ??
    process.env.RPC_URL ??
    network.defaultRpcUrl
  )
}
