const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"

const ALPHABET_MAP: Record<string, number> = Object.fromEntries(
  [...ALPHABET].map((ch, i) => [ch, i]),
)

/**
 * Encode bytes as Bitcoin/Solana base58 (no `0`, `O`, `I`, or `l`).
 */
export function encodeBase58(bytes: Uint8Array): string {
  if (bytes.length === 0) return ""

  let zeros = 0
  while (zeros < bytes.length && bytes[zeros] === 0) zeros++

  const size = (((bytes.length - zeros) * 138) / 100 + 1) | 0
  const b58 = new Uint8Array(size)
  let length = 0

  for (let i = zeros; i < bytes.length; i++) {
    const byte = bytes[i]
    if (byte === undefined) continue
    let carry = byte
    let j = 0
    for (let k = size - 1; (carry !== 0 || j < length) && k >= 0; k--, j++) {
      const prev = b58[k] ?? 0
      carry += 256 * prev
      b58[k] = carry % 58
      carry = (carry / 58) | 0
    }
    length = j
  }

  let it = size - length
  while (it < size && b58[it] === 0) it++

  let str = "1".repeat(zeros)
  for (; it < size; it++) {
    const idx = b58[it]
    if (idx === undefined) continue
    const ch = ALPHABET[idx]
    if (ch !== undefined) str += ch
  }
  return str
}

/**
 * Decode a Solana base58 string. Throws if the alphabet is violated or the
 * payload is empty.
 */
export function decodeBase58(str: string): Uint8Array {
  if (str.length === 0) {
    throw new Error("base58: empty string")
  }

  let zeros = 0
  while (zeros < str.length && str[zeros] === "1") zeros++

  const size = (((str.length - zeros) * 733) / 1000 + 1) | 0
  const b256 = new Uint8Array(size)
  let length = 0

  for (let i = zeros; i < str.length; i++) {
    const ch = str[i]
    if (ch === undefined) continue
    const val = ALPHABET_MAP[ch]
    if (val === undefined) {
      throw new Error(`base58: invalid character ${JSON.stringify(ch)}`)
    }
    let carry = val
    let j = 0
    for (let k = size - 1; (carry !== 0 || j < length) && k >= 0; k--, j++) {
      const prev = b256[k] ?? 0
      carry += 58 * prev
      b256[k] = carry % 256
      carry = (carry / 256) | 0
    }
    length = j
  }

  let it = size - length
  while (it < size && b256[it] === 0) it++

  const out = new Uint8Array(zeros + (size - it))
  let dest = zeros
  for (; it < size; it++, dest++) {
    const byte = b256[it]
    if (byte !== undefined) out[dest] = byte
  }
  return out
}
