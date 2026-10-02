export type MediaTrack = 'inbound' | 'outbound'

export interface TelnyxStart {
  readonly callControlId: string
  readonly encoding: string
  readonly sampleRate: number
  readonly channels: number
}

export interface TelnyxMedia {
  readonly chunk: number
  readonly track: MediaTrack
  readonly payload: Buffer
  readonly receivedAtMs: number
}

export function parseStart(value: unknown): TelnyxStart {
  const start = asRecord(value)
  const mediaFormat = asRecord(start.media_format ?? start.mediaFormat)
  const callControlId = stringValue(start.call_control_id ?? start.callControlId)
  const encoding = stringValue(mediaFormat.encoding).toLowerCase()
  const sampleRate = numberValue(mediaFormat.sample_rate ?? mediaFormat.sampleRate)
  const channels = numberValue(mediaFormat.channels)
  if (!callControlId || !['PCMU', 'MULAW', 'G711_ULAW'].includes(encoding.toUpperCase()) || sampleRate !== 8000 || channels !== 1) throw new Error('unsupported Telnyx media format')
  return { callControlId, encoding, sampleRate, channels }
}

export function parseMedia(value: unknown, receivedAtMs = Date.now()): TelnyxMedia {
  const root = asRecord(value)
  const media = asRecord(root.media)
  const track = stringValue(media.track)
  if (track !== 'inbound' && track !== 'outbound') throw new Error('unsupported media track')
  const chunkText = media.chunk
  const chunk = typeof chunkText === 'number' ? chunkText : Number(chunkText)
  if (!Number.isSafeInteger(chunk) || chunk < 1) throw new Error('invalid media chunk')
  const encoded = stringValue(media.payload)
  if (!encoded || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) throw new Error('invalid media payload')
  const payload = Buffer.from(encoded, 'base64')
  if (!payload.length || payload.length > MAX_PAYLOAD_BYTES) throw new Error('media payload too large')
  return { chunk, track, payload, receivedAtMs }
}

export const MAX_PAYLOAD_BYTES = 64 * 1024

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid message')
  return value as Record<string, unknown>
}
function stringValue(value: unknown): string { return typeof value === 'string' ? value : '' }
function numberValue(value: unknown): number { return typeof value === 'number' ? value : Number(value) }
