const PROTOCOL_VERSION = 1
const HEADER_BYTES = 13
const PCM_PAYLOAD_BYTES = 320 * 2
const MIN_RECORDING_PAYLOAD_BYTES = 1
const MAX_RECORDING_PAYLOAD_BYTES = 1_048_576
const MIN_EPOCH = 1
const MAX_EPOCH = 16
const MAX_RECORDING_SEQUENCE = 99_999
const MAX_CONTROL_TEXT_CHARS = 16 * 1024
const MAX_AUTH_TOKEN_CHARS = 4 * 1024
const MAX_CAPTURE_DEGRADED_REASONS = 5
const MAX_SERVER_DEGRADED_REASONS = 32
const MAX_SERVER_REASON_CHARS = 64
const UINT32_MAX = 0xffff_ffff
const CONTROL_VERSION = 2

export const DIALPAD_BROWSER_PROTOCOL = {
  version: PROTOCOL_VERSION,
  headerBytes: HEADER_BYTES,
  pcmPayloadBytes: PCM_PAYLOAD_BYTES,
  minEpoch: MIN_EPOCH,
  maxEpoch: MAX_EPOCH,
  maxRecordingPayloadBytes: MAX_RECORDING_PAYLOAD_BYTES,
  maxRecordingSequence: MAX_RECORDING_SEQUENCE,
  maxControlTextChars: MAX_CONTROL_TEXT_CHARS,
  controlVersion: CONTROL_VERSION,
  maxCaptureDegradedReasons: MAX_CAPTURE_DEGRADED_REASONS,
  maxServerDegradedReasons: MAX_SERVER_DEGRADED_REASONS,
} as const

export type DialpadBrowserTrack = 'tab' | 'mic'
export type DialpadBrowserBinaryKind = 'pcm' | 'recording'

export interface DialpadBrowserPcmFrame {
  readonly kind: 'pcm'
  readonly track: DialpadBrowserTrack
  readonly epoch: number
  readonly sequence: number
  readonly sampleClock: number
  readonly payload: Uint8Array
}

export interface DialpadBrowserRecordingFrame {
  readonly kind: 'recording'
  readonly track: DialpadBrowserTrack
  readonly epoch: number
  readonly sequence: number
  readonly payloadLength: number
  readonly payload: Uint8Array
}

export type DialpadBrowserBinaryFrame = DialpadBrowserPcmFrame | DialpadBrowserRecordingFrame
export type DialpadBrowserBinaryInput = ArrayBuffer | Uint8Array | DataView

export type DialpadBrowserProtocolErrorCode =
  | 'auth_repeated'
  | 'auth_failed'
  | 'auth_pending'
  | 'auth_required'
  | 'binary_invalid'
  | 'format_invalid'
  | 'control_invalid'
  | 'epoch_invalid'
  | 'epoch_mismatch'
  | 'kind_invalid'
  | 'length_invalid'
  | 'sequence_invalid'
  | 'server_message_invalid'
  | 'text_invalid'
  | 'track_invalid'
  | 'version_invalid'

/** Error text is constant and never contains a token, path, capture, or org value. */
export class DialpadBrowserProtocolError extends Error {
  readonly code: DialpadBrowserProtocolErrorCode

  constructor(code: DialpadBrowserProtocolErrorCode, message: string) {
    super(message)
    this.name = 'DialpadBrowserProtocolError'
    this.code = code
  }
}

const ERROR_MESSAGES: Record<DialpadBrowserProtocolErrorCode, string> = {
  auth_failed: 'authentication failed and cannot be retried on this socket',
  auth_pending: 'authentication redemption is pending',
  auth_repeated: 'authentication is only accepted as the first text message',
  auth_required: 'authentication is required before this message',
  binary_invalid: 'binary message is invalid',
  control_invalid: 'control message is invalid',
  epoch_invalid: 'epoch is outside the allowed range',
  epoch_mismatch: 'message epoch does not match the authenticated epoch',
  format_invalid: 'track format is invalid',
  kind_invalid: 'binary kind is invalid',
  length_invalid: 'binary payload length is invalid',
  sequence_invalid: 'sequence is outside the allowed range',
  server_message_invalid: 'server message is invalid',
  text_invalid: 'text message is invalid',
  track_invalid: 'track is invalid',
  version_invalid: 'binary protocol version is invalid',
}

function protocolError(code: DialpadBrowserProtocolErrorCode): DialpadBrowserProtocolError {
  return new DialpadBrowserProtocolError(code, ERROR_MESSAGES[code])
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value)
  return actual.length === keys.length && keys.every((key) => Object.prototype.hasOwnProperty.call(value, key))
}

function isUint32(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= UINT32_MAX
}

function isSafeBoundedInteger(value: unknown, minimum: number, maximum: number): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= minimum && value <= maximum
}

function isEpoch(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= MIN_EPOCH && value <= MAX_EPOCH
}

function isNullableEpoch(value: unknown): value is number | null {
  return value === null || isEpoch(value)
}

function isNullableSample(value: unknown): value is number | null {
  return value === null || isSafeBoundedInteger(value, 0, 1_000_000_000_000)
}

function isServerReasons(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.length <= MAX_SERVER_DEGRADED_REASONS && new Set(value).size === value.length && value.every((reason) => typeof reason === 'string' && reason.length > 0 && reason.length <= MAX_SERVER_REASON_CHARS)
}

function isSequence(value: unknown, recording: boolean): value is number {
  return isUint32(value) && (!recording || value <= MAX_RECORDING_SEQUENCE)
}

function isPcmSampleClock(value: unknown): value is number {
  return isUint32(value) && value <= UINT32_MAX - PCM_PAYLOAD_BYTES / 2
}

function isTrack(value: unknown): value is DialpadBrowserTrack {
  return value === 'tab' || value === 'mic'
}

function isCaptureDegradedReason(value: unknown): value is DialpadBrowserCaptureDegradedReason {
  return value === 'capture_track_ended' || value === 'capture_identity_lost' || value === 'capture_overflow' || value === 'capture_sink_failed' || value === 'capture_interrupted'
}

function isInterruptedReason(value: unknown): value is DialpadBrowserCaptureDegradedReason {
  return isCaptureDegradedReason(value)
}

function isCaptureDegradedReasons(value: unknown): value is readonly DialpadBrowserCaptureDegradedReason[] {
  if (!Array.isArray(value) || value.length > MAX_CAPTURE_DEGRADED_REASONS) return false
  return value.every(isCaptureDegradedReason) && new Set(value).size === value.length
}

function isTrackFormat(value: unknown): value is DialpadBrowserTrackFormatMessage {
  return isRecord(value)
    && hasExactKeys(value, ['type', 'epoch', 'track', 'contextSampleRateHz', 'inputChannels', 'recordingMimeType', 'pcmSampleRateHz', 'pcmChannels', 'pcmEncoding'])
    && value.type === 'track_format'
    && isEpoch(value.epoch)
    && isTrack(value.track)
    && typeof value.contextSampleRateHz === 'number' && Number.isInteger(value.contextSampleRateHz) && value.contextSampleRateHz >= 8_000 && value.contextSampleRateHz <= 192_000
    && typeof value.inputChannels === 'number' && Number.isInteger(value.inputChannels) && value.inputChannels >= 1 && value.inputChannels <= 2
    && value.recordingMimeType === 'audio/webm;codecs=opus'
    && value.pcmSampleRateHz === 16_000
    && value.pcmChannels === 1
    && value.pcmEncoding === 's16le'
}

function asBytes(input: DialpadBrowserBinaryInput): Uint8Array {
  if (input instanceof Uint8Array) return input
  if (input instanceof DataView) return new Uint8Array(input.buffer, input.byteOffset, input.byteLength)
  if (input instanceof ArrayBuffer) return new Uint8Array(input)
  throw protocolError('binary_invalid')
}

function validateFrameShape(frame: DialpadBrowserBinaryFrame): void {
  if (!isRecord(frame)) throw protocolError('binary_invalid')
  if (frame.kind !== 'pcm' && frame.kind !== 'recording') throw protocolError('kind_invalid')
  if (!isTrack(frame.track)) throw protocolError('track_invalid')
  if (!isEpoch(frame.epoch)) throw protocolError('epoch_invalid')
  if (!isSequence(frame.sequence, frame.kind === 'recording')) throw protocolError('sequence_invalid')
  if (!(frame.payload instanceof Uint8Array)) throw protocolError('binary_invalid')
  if (frame.kind === 'pcm') {
    if (!isPcmSampleClock(frame.sampleClock)) throw protocolError('length_invalid')
    if (frame.payload.byteLength !== PCM_PAYLOAD_BYTES) throw protocolError('length_invalid')
    return
  }
  if (frame.payload.byteLength < MIN_RECORDING_PAYLOAD_BYTES || frame.payload.byteLength > MAX_RECORDING_PAYLOAD_BYTES) throw protocolError('length_invalid')
  if (frame.payloadLength !== frame.payload.byteLength) throw protocolError('length_invalid')
}

/** Encode one validated binary envelope without Node Buffer or implicit coercion. */
export function encodeDialpadBrowserBinary(frame: DialpadBrowserBinaryFrame): Uint8Array {
  validateFrameShape(frame)
  const payloadLength = frame.payload.byteLength
  const output = new Uint8Array(HEADER_BYTES + payloadLength)
  const view = new DataView(output.buffer, output.byteOffset, output.byteLength)
  output[0] = PROTOCOL_VERSION
  output[1] = frame.kind === 'pcm' ? 0 : 1
  output[2] = frame.track === 'tab' ? 0 : 1
  view.setUint16(3, frame.epoch, false)
  view.setUint32(5, frame.sequence, false)
  view.setUint32(9, frame.kind === 'pcm' ? frame.sampleClock : payloadLength, false)
  output.set(frame.payload, HEADER_BYTES)
  return output
}

/** Decode a binary envelope after checking all header and length bounds. */
export function decodeDialpadBrowserBinary(input: DialpadBrowserBinaryInput): DialpadBrowserBinaryFrame {
  const bytes = asBytes(input)
  if (bytes.byteLength < HEADER_BYTES) throw protocolError('length_invalid')
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  if (bytes[0] !== PROTOCOL_VERSION) throw protocolError('version_invalid')
  const kindByte = bytes[1]
  if (kindByte !== 0 && kindByte !== 1) throw protocolError('kind_invalid')
  const trackByte = bytes[2]
  if (trackByte !== 0 && trackByte !== 1) throw protocolError('track_invalid')
  const epoch = view.getUint16(3, false)
  if (!isEpoch(epoch)) throw protocolError('epoch_invalid')
  const sequence = view.getUint32(5, false)
  const value = view.getUint32(9, false)
  const payload = bytes.subarray(HEADER_BYTES)
  const track: DialpadBrowserTrack = trackByte === 0 ? 'tab' : 'mic'
  if (kindByte === 0) {
    if (bytes.byteLength !== HEADER_BYTES + PCM_PAYLOAD_BYTES || !isPcmSampleClock(value)) throw protocolError('length_invalid')
    return { kind: 'pcm', track, epoch, sequence, sampleClock: value, payload }
  }
  if (!isSequence(sequence, true) || value !== payload.byteLength || value < MIN_RECORDING_PAYLOAD_BYTES || value > MAX_RECORDING_PAYLOAD_BYTES) {
    throw value !== payload.byteLength ? protocolError('length_invalid') : protocolError('sequence_invalid')
  }
  return { kind: 'recording', track, epoch, sequence, payloadLength: value, payload }
}

export interface DialpadBrowserAuthMessage {
  readonly type: 'auth'
  readonly token: string
  readonly epoch: number
  readonly controlVersion: number
}

export type DialpadBrowserCaptureDegradedReason =
  | 'capture_track_ended'
  | 'capture_identity_lost'
  | 'capture_overflow'
  | 'capture_sink_failed'
  | 'capture_interrupted'

export interface DialpadBrowserTrackFormatMessage {
  readonly type: 'track_format'
  readonly epoch: number
  readonly track: DialpadBrowserTrack
  readonly contextSampleRateHz: number
  readonly inputChannels: number
  readonly recordingMimeType: 'audio/webm;codecs=opus'
  readonly pcmSampleRateHz: 16000
  readonly pcmChannels: 1
  readonly pcmEncoding: 's16le'
}

export interface DialpadBrowserPcmEofMessage {
  readonly type: 'pcm_eof'
  readonly epoch: number
  readonly track: DialpadBrowserTrack
  readonly endSample: number
  readonly discardedTailSamples: number
  readonly degradedReasons: readonly DialpadBrowserCaptureDegradedReason[]
}

export interface DialpadBrowserRecordingEofMessage {
  readonly type: 'recording_eof'
  readonly epoch: number
  readonly track: DialpadBrowserTrack
  readonly lastSeq: number
}

export interface DialpadBrowserCaptureInterruptedMessage {
  readonly type: 'capture_interrupted'
  readonly epoch: number
  readonly track: DialpadBrowserTrack
  readonly reason: DialpadBrowserCaptureDegradedReason
}

export type DialpadBrowserClientMessage = DialpadBrowserAuthMessage | DialpadBrowserTrackFormatMessage | DialpadBrowserPcmEofMessage | DialpadBrowserRecordingEofMessage | DialpadBrowserCaptureInterruptedMessage

export function parseDialpadBrowserClientText(text: string): DialpadBrowserClientMessage {
  if (typeof text !== 'string' || text.length === 0 || text.length > MAX_CONTROL_TEXT_CHARS) throw protocolError('text_invalid')
  let value: unknown
  try { value = JSON.parse(text) as unknown } catch { throw protocolError('text_invalid') }
  if (!isRecord(value) || typeof value.type !== 'string') throw protocolError('control_invalid')
  if (value.type === 'auth') {
    if (!hasExactKeys(value, ['type', 'token', 'epoch', 'controlVersion']) || typeof value.token !== 'string' || value.token.length === 0 || value.token.length > MAX_AUTH_TOKEN_CHARS || !isEpoch(value.epoch) || value.controlVersion !== CONTROL_VERSION) {
      throw protocolError('control_invalid')
    }
    return { type: 'auth', token: value.token, epoch: value.epoch, controlVersion: CONTROL_VERSION }
  }
  if (value.type === 'track_format') {
    if (!isTrackFormat(value)) throw protocolError('format_invalid')
    return value
  }
  if (value.type === 'pcm_eof') {
    if (!hasExactKeys(value, ['type', 'epoch', 'track', 'endSample', 'discardedTailSamples', 'degradedReasons']) || !isEpoch(value.epoch) || !isTrack(value.track) || !isUint32(value.endSample) || !isUint32(value.discardedTailSamples) || value.discardedTailSamples > 319 || !isCaptureDegradedReasons(value.degradedReasons)) {
      throw protocolError('control_invalid')
    }
    return { type: 'pcm_eof', epoch: value.epoch, track: value.track, endSample: value.endSample, discardedTailSamples: value.discardedTailSamples, degradedReasons: [...value.degradedReasons] }
  }
  if (value.type === 'recording_eof') {
    if (!hasExactKeys(value, ['type', 'epoch', 'track', 'lastSeq']) || !isEpoch(value.epoch) || !isTrack(value.track) || !isSequence(value.lastSeq, true)) {
      throw protocolError('control_invalid')
    }
    return { type: 'recording_eof', epoch: value.epoch, track: value.track, lastSeq: value.lastSeq }
  }
  if (value.type === 'capture_interrupted') {
    if (!hasExactKeys(value, ['type', 'epoch', 'track', 'reason']) || !isEpoch(value.epoch) || !isTrack(value.track) || !isInterruptedReason(value.reason)) {
      throw protocolError('control_invalid')
    }
    return { type: 'capture_interrupted', epoch: value.epoch, track: value.track, reason: value.reason }
  }
  throw protocolError('control_invalid')
}

export interface DialpadBrowserProtocolStateOptions {
  readonly expectedEpoch?: number
  readonly allowedTracks?: readonly DialpadBrowserTrack[]
}

export interface DialpadBrowserRedeemedAuthentication {
  /** Values returned by the authoritative grant redemption, never by browser text. */
  readonly epoch: number
  readonly tracks: readonly DialpadBrowserTrack[]
}

/** Enforces first-message auth, server-confirmed redemption, and bound epoch/tracks. */
export class DialpadBrowserProtocolState {
  private phase: 'awaiting_auth' | 'pending_auth' | 'authenticated' | 'failed' = 'awaiting_auth'
  private authenticatedEpoch: number | undefined
  private pendingEpoch: number | undefined
  private readonly expectedEpoch: number | undefined
  private readonly configuredTracks: ReadonlySet<DialpadBrowserTrack> | undefined
  private confirmedTracks: ReadonlySet<DialpadBrowserTrack> | undefined
  private readonly trackFormats = new Map<DialpadBrowserTrack, DialpadBrowserTrackFormatMessage>()
  private readonly observedPcmEnds = new Map<DialpadBrowserTrack, number>()
  private readonly pcmEofs = new Map<DialpadBrowserTrack, DialpadBrowserPcmEofMessage>()
  private readonly interruptedTracks = new Map<DialpadBrowserTrack, DialpadBrowserCaptureDegradedReason>()

  constructor(options: DialpadBrowserProtocolStateOptions = {}) {
    if (options.expectedEpoch !== undefined && !isEpoch(options.expectedEpoch)) throw protocolError('epoch_invalid')
    if (options.allowedTracks !== undefined) {
      if (options.allowedTracks.length === 0 || options.allowedTracks.some((track) => !isTrack(track))) throw protocolError('track_invalid')
      this.configuredTracks = new Set(options.allowedTracks)
    }
    this.expectedEpoch = options.expectedEpoch
  }

  get authenticated(): boolean { return this.phase === 'authenticated' }
  get authenticationPending(): boolean { return this.phase === 'pending_auth' }
  get epoch(): number | undefined { return this.authenticatedEpoch }

  acceptText(text: string): DialpadBrowserClientMessage {
    const message = parseDialpadBrowserClientText(text)
    if (this.phase === 'failed') throw protocolError('auth_failed')
    if (this.phase === 'pending_auth') {
      if (message.type === 'auth') throw protocolError('auth_repeated')
      throw protocolError('auth_pending')
    }
    if (this.phase === 'awaiting_auth') {
      if (message.type !== 'auth') throw protocolError('auth_required')
      if (this.expectedEpoch !== undefined && message.epoch !== this.expectedEpoch) {
        this.phase = 'failed'
        throw protocolError('epoch_mismatch')
      }
      this.pendingEpoch = message.epoch
      this.phase = 'pending_auth'
      return message
    }
    if (message.type === 'auth') throw protocolError('auth_repeated')
    this.assertMessageBinding(message.epoch, message.track)
    if (message.type === 'track_format') {
      const previous = this.trackFormats.get(message.track)
      if (previous !== undefined && !sameTrackFormat(previous, message)) throw protocolError('format_invalid')
      this.trackFormats.set(message.track, message)
      return message
    }
    if (message.type === 'capture_interrupted') {
      const previous = this.interruptedTracks.get(message.track)
      if (previous !== undefined && previous !== message.reason) throw protocolError('control_invalid')
      this.interruptedTracks.set(message.track, message.reason)
      return message
    }
    if (message.type === 'pcm_eof') {
      this.assertTrackFormat(message.track)
      const observedEnd = this.observedPcmEnds.get(message.track) ?? 0
      if (message.endSample !== observedEnd) throw protocolError('control_invalid')
      const previous = this.pcmEofs.get(message.track)
      if (previous !== undefined && !samePcmEof(previous, message)) throw protocolError('control_invalid')
      this.pcmEofs.set(message.track, message)
      return message
    }
    return message
  }

  acceptBinary(input: DialpadBrowserBinaryInput): DialpadBrowserBinaryFrame {
    if (this.phase === 'failed') throw protocolError('auth_failed')
    if (this.phase === 'pending_auth') throw protocolError('auth_pending')
    if (!this.authenticated) throw protocolError('auth_required')
    const frame = decodeDialpadBrowserBinary(input)
    this.assertMessageBinding(frame.epoch, frame.track)
    this.assertTrackFormat(frame.track)
    if (frame.kind === 'pcm' && this.pcmEofs.has(frame.track)) throw protocolError('control_invalid')
    if (frame.kind === 'pcm' && this.interruptedTracks.has(frame.track)) throw protocolError('control_invalid')
    if (frame.kind === 'pcm') {
      const observedEnd = frame.sampleClock + PCM_PAYLOAD_BYTES / 2
      const previous = this.observedPcmEnds.get(frame.track) ?? 0
      this.observedPcmEnds.set(frame.track, Math.max(previous, observedEnd))
    }
    return frame
  }

  /** Complete the server-side atomic grant redemption before accepting data. */
  confirmAuthentication(redeemed: DialpadBrowserRedeemedAuthentication): void {
    if (this.phase === 'failed') throw protocolError('auth_failed')
    if (this.phase !== 'pending_auth' || this.pendingEpoch === undefined) throw protocolError('auth_required')
    if (!isEpoch(redeemed.epoch) || redeemed.epoch !== this.pendingEpoch || (this.expectedEpoch !== undefined && redeemed.epoch !== this.expectedEpoch)) {
      this.phase = 'failed'
      throw protocolError('epoch_mismatch')
    }
    const tracks = redeemed.tracks
    const configuredTracks = this.configuredTracks
    if (tracks.length === 0 || new Set(tracks).size !== tracks.length || tracks.some((track) => !isTrack(track)) || (configuredTracks !== undefined && tracks.some((track) => !configuredTracks.has(track)))) {
      this.phase = 'failed'
      throw protocolError('track_invalid')
    }
    this.authenticatedEpoch = redeemed.epoch
    this.confirmedTracks = new Set(tracks)
    this.phase = 'authenticated'
  }

  /** Permanently close the authentication path after grant redemption fails. */
  rejectAuthentication(): void {
    if (this.phase === 'awaiting_auth' || this.phase === 'pending_auth') this.phase = 'failed'
  }

  private assertMessageBinding(epoch: number, track: DialpadBrowserTrack): void {
    if (this.authenticatedEpoch !== epoch) throw protocolError('epoch_mismatch')
    if (this.confirmedTracks !== undefined && !this.confirmedTracks.has(track)) throw protocolError('track_invalid')
  }

  private assertTrackFormat(track: DialpadBrowserTrack): void {
    if (!this.trackFormats.has(track)) throw protocolError('format_invalid')
  }
}

function sameTrackFormat(left: DialpadBrowserTrackFormatMessage, right: DialpadBrowserTrackFormatMessage): boolean {
  return left.epoch === right.epoch && left.track === right.track && left.contextSampleRateHz === right.contextSampleRateHz && left.inputChannels === right.inputChannels && left.recordingMimeType === right.recordingMimeType && left.pcmSampleRateHz === right.pcmSampleRateHz && left.pcmChannels === right.pcmChannels && left.pcmEncoding === right.pcmEncoding
}

function samePcmEof(left: DialpadBrowserPcmEofMessage, right: DialpadBrowserPcmEofMessage): boolean {
  return left.epoch === right.epoch && left.track === right.track && left.endSample === right.endSample && left.discardedTailSamples === right.discardedTailSamples && left.degradedReasons.length === right.degradedReasons.length && left.degradedReasons.every((reason, index) => reason === right.degradedReasons[index])
}

export interface DialpadBrowserReadyMessage {
  readonly type: 'ready'
  readonly epoch: number
  readonly controlVersion: number
}

export interface DialpadBrowserMeasurementSnapshotMessage {
  readonly type: 'measurement_snapshot'
  readonly epoch: number
  readonly revision: number
  readonly totalSamples: number
  readonly measurementStatus: 'provisional' | 'partial'
  readonly threshold: {
    readonly crossed: boolean
    readonly crossingEpoch: number | null
    readonly crossingSample: number | null
  }
  readonly degradedReasons: readonly string[]
}

export interface DialpadBrowserCaptureStateMessage {
  readonly type: 'capture_state'
  readonly epoch: number
  /** Authoritative worker lifecycle fence, after grant redemption. */
  readonly latestConsumedEpoch: number
  readonly state: 'open' | 'closing' | 'closed'
  readonly drainDeadlineAt: string | null
}

export interface DialpadBrowserRecordingChunkAck {
  readonly type: 'recording_chunk_ack'
  readonly track: DialpadBrowserTrack
  readonly epoch: number
  readonly seq: number
  readonly status: 'recorded' | 'replayed'
}

/** Receipt after the worker has processed a complete PCM inference window. */
export interface DialpadBrowserPcmFrameAck {
  readonly type: 'pcm_frame_ack'
  readonly epoch: number
  readonly track: DialpadBrowserTrack
  readonly seq: number
}

export interface DialpadBrowserRecordingEofAck {
  readonly type: 'recording_eof_ack'
  readonly track: DialpadBrowserTrack
  readonly epoch: number
  readonly lastSeq: number
}

export interface DialpadBrowserPcmEofDrained {
  readonly type: 'pcm_eof_drained'
  readonly track: DialpadBrowserTrack
  readonly epoch: number
  readonly endSample: number
}

export type DialpadBrowserServerMessage = DialpadBrowserReadyMessage | DialpadBrowserMeasurementSnapshotMessage | DialpadBrowserCaptureStateMessage | DialpadBrowserRecordingChunkAck | DialpadBrowserPcmFrameAck | DialpadBrowserRecordingEofAck | DialpadBrowserPcmEofDrained

/** Projects an already-authoritative DB snapshot into the narrow browser view. */
export function toDialpadBrowserMeasurementSnapshot(input: Omit<DialpadBrowserMeasurementSnapshotMessage, 'type'>): DialpadBrowserMeasurementSnapshotMessage {
  const message: DialpadBrowserMeasurementSnapshotMessage = { type: 'measurement_snapshot', ...input, degradedReasons: [...input.degradedReasons] }
  validateServerMessage(message)
  return message
}

export function encodeDialpadBrowserServerMessage(message: DialpadBrowserServerMessage): string {
  validateServerMessage(message)
  return JSON.stringify(message)
}

export function parseDialpadBrowserServerMessage(text: string): DialpadBrowserServerMessage {
  if (typeof text !== 'string' || text.length === 0 || text.length > MAX_CONTROL_TEXT_CHARS) throw protocolError('server_message_invalid')
  let value: unknown
  try { value = JSON.parse(text) as unknown } catch { throw protocolError('server_message_invalid') }
  if (!isRecord(value)) throw protocolError('server_message_invalid')
  try {
    validateServerMessage(value as unknown as DialpadBrowserServerMessage)
    return value as unknown as DialpadBrowserServerMessage
  } catch (error) {
    if (error instanceof DialpadBrowserProtocolError) throw error
    throw protocolError('server_message_invalid')
  }
}

function validateServerMessage(message: DialpadBrowserServerMessage): void {
  if (!isRecord(message) || typeof message.type !== 'string') throw protocolError('server_message_invalid')
  if (message.type === 'ready') {
    if (!hasExactKeys(message, ['type', 'epoch', 'controlVersion']) || !isEpoch(message.epoch) || message.controlVersion !== CONTROL_VERSION) throw protocolError('server_message_invalid')
    return
  }
  if (message.type === 'measurement_snapshot') {
    if (!hasExactKeys(message, ['type', 'epoch', 'revision', 'totalSamples', 'measurementStatus', 'threshold', 'degradedReasons']) || !isEpoch(message.epoch) || !isSafeBoundedInteger(message.revision, 0, Number.MAX_SAFE_INTEGER) || !isSafeBoundedInteger(message.totalSamples, 0, 1_000_000_000_000) || (message.measurementStatus !== 'provisional' && message.measurementStatus !== 'partial') || !isRecord(message.threshold) || !hasExactKeys(message.threshold, ['crossed', 'crossingEpoch', 'crossingSample']) || typeof message.threshold.crossed !== 'boolean' || !isNullableEpoch(message.threshold.crossingEpoch) || !isNullableSample(message.threshold.crossingSample) || (message.threshold.crossed ? message.threshold.crossingEpoch === null || message.threshold.crossingSample === null : message.threshold.crossingEpoch !== null || message.threshold.crossingSample !== null) || !isServerReasons(message.degradedReasons)) throw protocolError('server_message_invalid')
    return
  }
  if (message.type === 'capture_state') {
    const validDeadline = message.drainDeadlineAt === null || (typeof message.drainDeadlineAt === 'string' && !Number.isNaN(Date.parse(message.drainDeadlineAt)))
    if (!hasExactKeys(message, ['type', 'epoch', 'latestConsumedEpoch', 'state', 'drainDeadlineAt']) || !isEpoch(message.epoch) || !isEpoch(message.latestConsumedEpoch) || message.latestConsumedEpoch !== message.epoch || (message.state !== 'open' && message.state !== 'closing' && message.state !== 'closed') || !validDeadline || (message.state === 'closing' && message.drainDeadlineAt === null) || (message.state !== 'closing' && message.drainDeadlineAt !== null)) throw protocolError('server_message_invalid')
    return
  }
  if (message.type === 'recording_chunk_ack') {
    if (!hasExactKeys(message, ['type', 'track', 'epoch', 'seq', 'status']) || !isTrack(message.track) || !isEpoch(message.epoch) || !isSequence(message.seq, true) || (message.status !== 'recorded' && message.status !== 'replayed')) throw protocolError('server_message_invalid')
    return
  }
  if (message.type === 'pcm_frame_ack') {
    if (!hasExactKeys(message, ['type', 'epoch', 'track', 'seq']) || !isEpoch(message.epoch) || !isTrack(message.track) || !isSequence(message.seq, false)) throw protocolError('server_message_invalid')
    return
  }
  if (message.type === 'recording_eof_ack') {
    if (!hasExactKeys(message, ['type', 'track', 'epoch', 'lastSeq']) || !isTrack(message.track) || !isEpoch(message.epoch) || !isSequence(message.lastSeq, true)) throw protocolError('server_message_invalid')
    return
  }
  if (message.type === 'pcm_eof_drained') {
    if (!hasExactKeys(message, ['type', 'track', 'epoch', 'endSample']) || !isTrack(message.track) || !isEpoch(message.epoch) || !isUint32(message.endSample)) throw protocolError('server_message_invalid')
    return
  }
  throw protocolError('server_message_invalid')
}
