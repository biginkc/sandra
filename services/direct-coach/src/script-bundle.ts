import { createHash } from 'node:crypto'

/** Minimal standalone shape used by the service; the approved classifier is still the only consumer. */
export interface ScriptBundle {
  readonly schema_version: number
  readonly script: { readonly version: string; readonly [key: string]: unknown }
  readonly sections: unknown
  readonly [key: string]: unknown
}

export function assertValidScriptBundle(value: unknown): asserts value is ScriptBundle {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid script bundle')
  const record = value as Record<string, unknown>
  const script = record.script
  if (typeof record.schema_version !== 'number' || !Number.isSafeInteger(record.schema_version) || !script || typeof script !== 'object' || Array.isArray(script) || typeof (script as Record<string, unknown>).version !== 'string' || !(record.sections && typeof record.sections === 'object')) throw new Error('invalid script bundle')
}

/** Mirrors @biginkc/coach's canonical digest: recursively sort object keys, preserve array order. */
export function computeScriptDigest(bundle: ScriptBundle): string {
  const canonical = JSON.stringify(sort(bundle))
  return createHash('sha256').update(new TextEncoder().encode(canonical)).digest('hex')
}

function sort(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sort)
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value as Record<string, unknown>).sort().map((key) => [key, sort((value as Record<string, unknown>)[key])]))
  return value
}
