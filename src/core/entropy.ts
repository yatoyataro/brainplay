/** Zero-dependency browser & Worker CSPRNG utilities via crypto.getRandomValues. */

const UINT32_RANGE = 0x100000000;

/** Returns a uniform random integer in [0, max) using rejection sampling. */
export function cryptoRandomInt(max: number): number {
  if (!Number.isInteger(max) || max <= 0 || max > UINT32_RANGE) {
    throw new RangeError(`max must be an integer in [1, ${UINT32_RANGE}], got ${max}`);
  }
  const limit = Math.floor(UINT32_RANGE / max) * max;
  const buf = new Uint32Array(1);
  let val = 0;
  do {
    crypto.getRandomValues(buf);
    val = buf[0]!;
  } while (val >= limit);
  return val % max;
}

/** Returns a uniform random float in [0, 1) with 28-bit CSPRNG resolution. */
export function cryptoRandomFloat(): number {
  return cryptoRandomInt(0x10000000) / 0x10000000;
}

/** Returns a CSPRNG Fisher-Yates shuffled index array [0 .. length - 1]. */
export function cryptoShuffleIndices(length: number): number[] {
  if (!Number.isInteger(length) || length < 0) {
    throw new RangeError(`length must be a non-negative integer, got ${length}`);
  }
  const indices = Array.from({ length }, (_, i) => i);
  for (let i = length - 1; i > 0; i--) {
    const j = cryptoRandomInt(i + 1);
    const tmp = indices[i]!;
    indices[i] = indices[j]!;
    indices[j] = tmp;
  }
  return indices;
}

/** Returns a new shallow-copied array shuffled via CSPRNG Fisher-Yates. */
export function cryptoShuffleArray<T>(items: readonly T[]): T[] {
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = cryptoRandomInt(i + 1);
    const tmp = copy[i]!;
    copy[i] = copy[j]!;
    copy[j] = tmp;
  }
  return copy;
}

/** Generates a 16-byte CSPRNG nonce formatted as 32 lowercase hex characters. */
export function createSessionNonce(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}
