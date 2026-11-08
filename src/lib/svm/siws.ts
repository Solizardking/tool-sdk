import { ed25519 } from "@noble/curves/ed25519"
import { addressBytes, assertSvmAddress, type SvmAddress } from "./address.js"
import { decodeBase58, encodeBase58 } from "./base58.js"

export interface SiwsMessageFields {
  domain: string
  address: SvmAddress
  statement?: string
  uri: string
  version?: string
  /** Cluster name (`mainnet`, `devnet`, `testnet`) or a CAIP-2 id. */
  chainId: string
  nonce: string
  issuedAt: string
  expirationTime?: string
  resources?: string[]
}

const SIWS_HEADER = "wants you to sign in with your Solana account:"

/**
 * Build a Sign-In With Solana message. Layout follows the Phantom SIWS
 * convention (SIWE-shaped, Solana account line, no EIP-191 prefix).
 */
export function createSiwsMessage(fields: SiwsMessageFields): string {
  assertSvmAddress(fields.address, "address")
  const version = fields.version ?? "1"
  const statement = fields.statement ?? "Authenticate to access this tool"
  const lines = [
    `${fields.domain} ${SIWS_HEADER}`,
    fields.address,
    "",
    statement,
    "",
    `URI: ${fields.uri}`,
    `Version: ${version}`,
    `Chain ID: ${fields.chainId}`,
    `Nonce: ${fields.nonce}`,
    `Issued At: ${fields.issuedAt}`,
  ]
  if (fields.expirationTime) {
    lines.push(`Expiration Time: ${fields.expirationTime}`)
  }
  if (fields.resources && fields.resources.length > 0) {
    lines.push("Resources:")
    for (const resource of fields.resources) {
      lines.push(`- ${resource}`)
    }
  }
  return lines.join("\n")
}

export function generateSiwsNonce(): string {
  const bytes = new Uint8Array(16)
  crypto.getRandomValues(bytes)
  return encodeBase58(bytes)
}

export interface ParsedSiwsMessage extends SiwsMessageFields {
  raw: string
}

export function parseSiwsMessage(raw: string): ParsedSiwsMessage {
  const lines = raw.split("\n")
  const header = lines[0]
  const address = lines[1]
  if (!header || !address || !header.includes(SIWS_HEADER)) {
    throw new Error("SIWS: malformed header")
  }
  const domain = header.slice(0, header.indexOf(` ${SIWS_HEADER}`))
  assertSvmAddress(address, "SIWS address")

  const field = (label: string): string | undefined => {
    const prefix = `${label}: `
    const line = lines.find(l => l.startsWith(prefix))
    return line ? line.slice(prefix.length) : undefined
  }

  const uri = field("URI")
  const version = field("Version")
  const chainId = field("Chain ID")
  const nonce = field("Nonce")
  const issuedAt = field("Issued At")
  if (!uri || !version || !chainId || !nonce || !issuedAt) {
    throw new Error("SIWS: missing required field")
  }

  const statementLine = lines[3] ?? ""

  return {
    raw,
    domain,
    address,
    statement: statementLine || undefined,
    uri,
    version,
    chainId,
    nonce,
    issuedAt,
    expirationTime: field("Expiration Time"),
  }
}

export function verifyEd25519(params: {
  address: SvmAddress
  message: Uint8Array
  signature: Uint8Array
}): boolean {
  if (params.signature.length !== 64) return false
  try {
    return ed25519.verify(
      params.signature,
      params.message,
      addressBytes(params.address),
    )
  } catch {
    return false
  }
}

export interface VerifiedSiws {
  address: SvmAddress
  message: ParsedSiwsMessage
}

/**
 * Verify a SIWS message + signature. `signature` may be base58 or base64
 * of the 64-byte ed25519 signature.
 */
export function verifySiws(params: {
  message: string
  signature: string
  expectedDomain?: string
  expectedUri?: string
  expectedChainId?: string
  now?: Date
}): VerifiedSiws {
  const parsed = parseSiwsMessage(params.message)
  if (params.expectedDomain && parsed.domain !== params.expectedDomain) {
    throw new Error(
      `SIWS: domain ${parsed.domain} does not match ${params.expectedDomain}`,
    )
  }
  if (params.expectedUri && parsed.uri !== params.expectedUri) {
    throw new Error(
      `SIWS: uri ${parsed.uri} does not match ${params.expectedUri}`,
    )
  }
  if (params.expectedChainId && parsed.chainId !== params.expectedChainId) {
    throw new Error(
      `SIWS: chain ${parsed.chainId} does not match ${params.expectedChainId}`,
    )
  }
  if (parsed.expirationTime) {
    const exp = Date.parse(parsed.expirationTime)
    const now = (params.now ?? new Date()).getTime()
    if (Number.isFinite(exp) && now > exp) {
      throw new Error("SIWS: message expired")
    }
  }

  const signature = decodeSignature(params.signature)
  const ok = verifyEd25519({
    address: parsed.address,
    message: new TextEncoder().encode(params.message),
    signature,
  })
  if (!ok) throw new Error("SIWS: invalid signature")
  return { address: parsed.address, message: parsed }
}

function decodeSignature(value: string): Uint8Array {
  try {
    const b58 = decodeBase58(value)
    if (b58.length === 64) return b58
  } catch {
    // fall through to base64
  }
  const b64 = Uint8Array.from(Buffer.from(value, "base64"))
  if (b64.length === 64) return b64
  throw new Error("SIWS: signature must decode to 64 bytes")
}

/**
 * `Authorization: SIWS <base64url(message)>.<base58(signature)>`
 */
export function createSiwsAuthHeader(
  message: string,
  signature: Uint8Array | string,
): string {
  const encodedMessage = Buffer.from(message, "utf8")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=/g, "")
  const sig =
    typeof signature === "string" ? signature : encodeBase58(signature)
  return `SIWS ${encodedMessage}.${sig}`
}

export function parseSiwsAuthHeader(header: string): {
  message: string
  signature: string
} {
  const trimmed = header.trim()
  const prefix = trimmed.toLowerCase().startsWith("siws ")
    ? trimmed.slice(5)
    : trimmed
  const dot = prefix.lastIndexOf(".")
  if (dot <= 0) {
    throw new Error("SIWS: malformed Authorization header")
  }
  const msgPart = prefix.slice(0, dot).replace(/-/g, "+").replace(/_/g, "/")
  const pad =
    msgPart.length % 4 === 0 ? "" : "=".repeat(4 - (msgPart.length % 4))
  const message = Buffer.from(msgPart + pad, "base64").toString("utf8")
  return { message, signature: prefix.slice(dot + 1) }
}
