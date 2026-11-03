import { keccak256, toBytes, type Hex } from 'viem';

/**
 * Canonical, versioned task terms. Hash = keccak256(utf8(canonicalJson(terms))).
 * canonicalJson: keys sorted recursively, no whitespace, strings NFC-normalised. Amounts are strings of
 * base units so no client ever hashes a float.
 */
export interface TaskTermsV1 {
  version: 'agentsettle.terms.v1';
  chainId: number;
  escrow: string;
  provider: string;
  amountUnits: string;
  deadline: number;
  description: string;
  acceptanceCriteria: string[];
}

function canonical(value: unknown): string {
  if (value === null || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) throw new Error('Terms may only contain safe integers; use strings for amounts');
    return JSON.stringify(value);
  }
  if (typeof value === 'string') return JSON.stringify(value.normalize('NFC'));
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
  }
  throw new Error(`Unsupported value in terms: ${typeof value}`);
}

export function canonicalTerms(terms: TaskTermsV1): string {
  if (terms.version !== 'agentsettle.terms.v1') throw new Error('Unsupported terms version');
  if (!/^\d+$/.test(terms.amountUnits)) throw new Error('amountUnits must be a base-unit integer string');
  return canonical({ ...terms, escrow: terms.escrow.toLowerCase(), provider: terms.provider.toLowerCase() });
}

export function hashTerms(terms: TaskTermsV1): Hex {
  return keccak256(toBytes(canonicalTerms(terms)));
}

/** Evidence commitment for a deliverable. Integrity only; it proves nothing about quality. */
export function hashEvidence(content: string | Uint8Array): Hex {
  return keccak256(typeof content === 'string' ? toBytes(content) : content);
}

/** Deterministic on-chain idempotency reference derived from a client idempotency key. */
export function clientRefFromKey(idempotencyKey: string): Hex {
  if (!/^[\w-]{8,100}$/.test(idempotencyKey)) throw new Error('Idempotency key must be 8-100 chars of [A-Za-z0-9_-]');
  return keccak256(toBytes(`agentsettle.clientRef.v1:${idempotencyKey}`));
}

/** Exact decimal string -> 6-decimal base units. Rejects floats and over-precision. */
export function parseUsdcUnits(amount: string): bigint {
  if (typeof amount !== 'string' || !/^(?:0|[1-9]\d{0,11})(?:\.\d{1,6})?$/.test(amount)) {
    throw new Error('Amount must be a decimal USDC string with up to six decimal places');
  }
  const [whole, frac = ''] = amount.split('.');
  const units = BigInt(whole) * 1_000_000n + BigInt(frac.padEnd(6, '0'));
  if (units <= 0n) throw new Error('Amount must be greater than zero');
  return units;
}

export function formatUsdcUnits(units: bigint): string {
  const whole = units / 1_000_000n;
  const frac = (units % 1_000_000n).toString().padStart(6, '0').replace(/0+$/, '');
  return frac ? `${whole}.${frac}` : `${whole}`;
}
