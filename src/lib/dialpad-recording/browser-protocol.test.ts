import { describe, expect, it } from 'vitest'
import {
  DIALPAD_BROWSER_PROTOCOL,
  DialpadBrowserProtocolError,
  DialpadBrowserProtocolState,
  decodeDialpadBrowserBinary,
  encodeDialpadBrowserBinary,
  encodeDialpadBrowserServerMessage,
  parseDialpadBrowserClientText,
  parseDialpadBrowserServerMessage,
  toDialpadBrowserMeasurementSnapshot,
  type DialpadBrowserBinaryFrame,
} from '@/lib/dialpad-recording/browser-protocol'

describe('Dialpad browser binary protocol', () => {
  it('encodes and decodes a PCM frame with big-endian header and little-endian samples', () => {
    const payload = new Uint8Array(DIALPAD_BROWSER_PROTOCOL.pcmPayloadBytes)
    const samples = new DataView(payload.buffer)
    samples.setInt16(0, -32768, true)
    samples.setInt16(2, 16_384, true)
    const sampleClock = 0xffff_ffff - 320
    const frame: DialpadBrowserBinaryFrame = {
      kind: 'pcm', track: 'tab', epoch: 16, sequence: 0xffff_ffff, sampleClock, payload,
    }

    const encoded = encodeDialpadBrowserBinary(frame)
    expect(encoded.byteLength).toBe(653)
    expect([...encoded.subarray(0, 13)]).toEqual([1, 0, 0, 0, 16, 255, 255, 255, 255, 255, 255, 254, 191])
    const decoded = decodeDialpadBrowserBinary(encoded)
    expect(decoded).toMatchObject({ kind: 'pcm', track: 'tab', epoch: 16, sequence: 0xffff_ffff, sampleClock })
    expect(decoded.payload).toEqual(payload)
    expect(new DataView(decoded.payload.buffer, decoded.payload.byteOffset).getInt16(0, true)).toBe(-32768)
    expect(new DataView(decoded.payload.buffer, decoded.payload.byteOffset).getInt16(2, true)).toBe(16_384)
  })

  it('round-trips a retention chunk byte-for-byte at the maximum allowed sequence and payload', () => {
    const payload = new Uint8Array(1_048_576)
    for (let index = 0; index < payload.length; index += 1) payload[index] = (index * 73) & 0xff
    const frame: DialpadBrowserBinaryFrame = {
      kind: 'recording', track: 'mic', epoch: 1, sequence: 99_999, payloadLength: payload.byteLength, payload,
    }
    const encoded = encodeDialpadBrowserBinary(frame)
    const view = new DataView(encoded.buffer, encoded.byteOffset, encoded.byteLength)
    expect(view.getUint16(3, false)).toBe(1)
    expect(view.getUint32(5, false)).toBe(99_999)
    expect(view.getUint32(9, false)).toBe(payload.byteLength)
    const decoded = decodeDialpadBrowserBinary(encoded)
    expect(decoded).toMatchObject({ kind: 'recording', track: 'mic', epoch: 1, sequence: 99_999, payloadLength: 1_048_576 })
    expect(decoded.payload).toEqual(payload)
  })

  it('rejects malformed headers, overflow, truncation, wrong tracks, and bad recording bounds', () => {
    const pcm = encodeDialpadBrowserBinary({
      kind: 'pcm', track: 'tab', epoch: 1, sequence: 2, sampleClock: 3, payload: new Uint8Array(640),
    })
    expectCode(() => decodeDialpadBrowserBinary(pcm.subarray(0, 12)), 'length_invalid')
    const badVersion = pcm.slice(); badVersion[0] = 2
    expectCode(() => decodeDialpadBrowserBinary(badVersion), 'version_invalid')
    const badKind = pcm.slice(); badKind[1] = 2
    expectCode(() => decodeDialpadBrowserBinary(badKind), 'kind_invalid')
    const badTrack = pcm.slice(); badTrack[2] = 2
    expectCode(() => decodeDialpadBrowserBinary(badTrack), 'track_invalid')
    const badEpoch = pcm.slice(); new DataView(badEpoch.buffer).setUint16(3, 17, false)
    expectCode(() => decodeDialpadBrowserBinary(badEpoch), 'epoch_invalid')
    const badPcmLength = pcm.slice(0, pcm.length - 1)
    expectCode(() => decodeDialpadBrowserBinary(badPcmLength), 'length_invalid')
    expectCode(() => encodeDialpadBrowserBinary({
      kind: 'pcm', track: 'tab', epoch: 1, sequence: 2, sampleClock: 3, payload: new Uint8Array(639),
    }), 'length_invalid')
    expectCode(() => encodeDialpadBrowserBinary({
      kind: 'pcm', track: 'tab', epoch: 1, sequence: 2, sampleClock: 0xffff_ffff - 319, payload: new Uint8Array(640),
    }), 'length_invalid')
    expectCode(() => encodeDialpadBrowserBinary({
      kind: 'recording', track: 'tab', epoch: 1, sequence: 100_000, payloadLength: 1, payload: new Uint8Array(1),
    }), 'sequence_invalid')
    const recording = encodeDialpadBrowserBinary({
      kind: 'recording', track: 'tab', epoch: 1, sequence: 1, payloadLength: 1, payload: new Uint8Array([7]),
    })
    const badRecordingLength = recording.slice(); new DataView(badRecordingLength.buffer).setUint32(9, 2, false)
    expectCode(() => decodeDialpadBrowserBinary(badRecordingLength), 'length_invalid')
    expectCode(() => encodeDialpadBrowserBinary({
      kind: 'recording', track: 'tab', epoch: 1, sequence: 1, payloadLength: 1_048_577, payload: new Uint8Array(1_048_577),
    }), 'length_invalid')
  })
})

describe('Dialpad browser text controls and auth state', () => {
  it('accepts only exact auth, PCM EOF, and recording EOF shapes with bounded values', () => {
    expect(parseDialpadBrowserClientText('{"type":"auth","token":"grant-123","epoch":1,"controlVersion":2}')).toEqual({ type: 'auth', token: 'grant-123', epoch: 1, controlVersion: 2 })
    expect(parseDialpadBrowserClientText('{"type":"pcm_eof","epoch":16,"track":"tab","endSample":4294967295,"discardedTailSamples":319,"degradedReasons":["capture_overflow"]}')).toEqual({ type: 'pcm_eof', epoch: 16, track: 'tab', endSample: 4294967295, discardedTailSamples: 319, degradedReasons: ['capture_overflow'] })
    expect(parseDialpadBrowserClientText('{"type":"recording_eof","epoch":1,"track":"mic","lastSeq":99999}')).toEqual({ type: 'recording_eof', epoch: 1, track: 'mic', lastSeq: 99999 })
    expectCode(() => parseDialpadBrowserClientText('{"type":"auth","token":"grant","epoch":1,"controlVersion":2,"capture":"forged"}'), 'control_invalid')
    expectCode(() => parseDialpadBrowserClientText('{"type":"pcm_eof","epoch":1,"track":"tab","endSample":1,"path":"forged"}'), 'control_invalid')
    expectCode(() => parseDialpadBrowserClientText('{"type":"recording_eof","epoch":1,"track":"tab","lastSeq":100000}'), 'control_invalid')
    expectCode(() => parseDialpadBrowserClientText('{"type":"auth","token":"grant","epoch":0,"controlVersion":2}'), 'control_invalid')
    expectCode(() => parseDialpadBrowserClientText('{"type":"auth","token":"grant","epoch":1,"controlVersion":1}'), 'control_invalid')
    expectCode(() => parseDialpadBrowserClientText('{"type":"unknown_control"}'), 'control_invalid')
    expectCode(() => parseDialpadBrowserClientText('{malformed'), 'text_invalid')
    expectCode(() => parseDialpadBrowserClientText('{"type":"auth","token":"","epoch":1,"controlVersion":2}'), 'control_invalid')
    expect(parseDialpadBrowserClientText('{"type":"capture_interrupted","epoch":1,"track":"mic","reason":"capture_identity_lost"}')).toEqual({ type: 'capture_interrupted', epoch: 1, track: 'mic', reason: 'capture_identity_lost' })
    expectCode(() => parseDialpadBrowserClientText('{"type":"pcm_eof","epoch":1,"track":"tab","endSample":1,"discardedTailSamples":320,"degradedReasons":[]}'), 'control_invalid')
    expectCode(() => parseDialpadBrowserClientText('{"type":"pcm_eof","epoch":1,"track":"tab","endSample":1,"discardedTailSamples":0,"degradedReasons":["capture_overflow","capture_overflow"]}'), 'control_invalid')
    expect(parseDialpadBrowserClientText('{"type":"capture_interrupted","epoch":1,"track":"mic","reason":"capture_track_ended"}')).toEqual({ type: 'capture_interrupted', epoch: 1, track: 'mic', reason: 'capture_track_ended' })
    expectCode(() => parseDialpadBrowserClientText('{"type":"track_format","epoch":1,"track":"tab","contextSampleRateHz":48000,"inputChannels":3,"recordingMimeType":"audio/webm;codecs=opus","pcmSampleRateHz":16000,"pcmChannels":1,"pcmEncoding":"s16le"}'), 'format_invalid')
  })

  it('never includes a supplied token in sanitized parser errors', () => {
    const secret = 'super-secret-grant-value'
    try {
      parseDialpadBrowserClientText(JSON.stringify({ type: 'auth', token: secret, epoch: 1, controlVersion: 2, org: 'forged' }))
      throw new Error('expected parser failure')
    } catch (error) {
      expect(error).toBeInstanceOf(DialpadBrowserProtocolError)
      expect((error as Error).message).not.toContain(secret)
      expect((error as Error).message).not.toContain('forged')
    }
  })

  it('requires server-confirmed auth, rejects binary-before-auth and repeated auth, and binds epoch/track', () => {
    const state = new DialpadBrowserProtocolState({ expectedEpoch: 3, allowedTracks: ['tab'] })
    const pcm = encodeDialpadBrowserBinary({ kind: 'pcm', track: 'tab', epoch: 3, sequence: 0, sampleClock: 0, payload: new Uint8Array(640) })
    expectCode(() => state.acceptBinary(pcm), 'auth_required')
    expectCode(() => state.acceptText('{"type":"pcm_eof","epoch":3,"track":"tab","endSample":320,"discardedTailSamples":0,"degradedReasons":[]}'), 'auth_required')
    expectCode(() => state.acceptText('{"type":"auth","token":"grant","epoch":2,"controlVersion":2}'), 'epoch_mismatch')
    expect(state.authenticated).toBe(false)
    expect(state.authenticationPending).toBe(false)
    expectCode(() => state.acceptText('{"type":"auth","token":"grant","epoch":3,"controlVersion":2}'), 'auth_failed')

    const pending = new DialpadBrowserProtocolState({ expectedEpoch: 3, allowedTracks: ['tab'] })
    expect(pending.acceptText('{"type":"auth","token":"grant","epoch":3,"controlVersion":2}')).toEqual({ type: 'auth', token: 'grant', epoch: 3, controlVersion: 2 })
    expect(pending.authenticated).toBe(false)
    expect(pending.authenticationPending).toBe(true)
    expect(pending.epoch).toBeUndefined()
    expectCode(() => pending.acceptBinary(pcm), 'auth_pending')
    expectCode(() => pending.acceptText('{"type":"pcm_eof","epoch":3,"track":"tab","endSample":320,"discardedTailSamples":0,"degradedReasons":[]}'), 'auth_pending')
    expectCode(() => pending.acceptText('{"type":"auth","token":"second-secret","epoch":3,"controlVersion":2}'), 'auth_repeated')
    pending.confirmAuthentication({ epoch: 3, tracks: ['tab'] })
    expect(pending.authenticated).toBe(true)
    expect(pending.authenticationPending).toBe(false)
    expect(pending.epoch).toBe(3)
    expectCode(() => state.acceptText('{"type":"auth","token":"second-secret","epoch":3,"controlVersion":2}'), 'auth_failed')
    expectCode(() => pending.acceptBinary(encodeDialpadBrowserBinary({ kind: 'pcm', track: 'mic', epoch: 3, sequence: 0, sampleClock: 0, payload: new Uint8Array(640) })), 'track_invalid')
    expectCode(() => pending.acceptBinary(encodeDialpadBrowserBinary({ kind: 'pcm', track: 'tab', epoch: 2, sequence: 0, sampleClock: 0, payload: new Uint8Array(640) })), 'epoch_mismatch')
    const format = JSON.stringify({ type: 'track_format', epoch: 3, track: 'tab', contextSampleRateHz: 48_000, inputChannels: 1, recordingMimeType: 'audio/webm;codecs=opus', pcmSampleRateHz: 16_000, pcmChannels: 1, pcmEncoding: 's16le' })
    expect(pending.acceptText(format)).toMatchObject({ type: 'track_format', track: 'tab' })
    expect(pending.acceptBinary(pcm)).toMatchObject({ kind: 'pcm', track: 'tab', epoch: 3 })
    expect(pending.acceptText('{"type":"pcm_eof","epoch":3,"track":"tab","endSample":320,"discardedTailSamples":0,"degradedReasons":[]}')).toEqual({ type: 'pcm_eof', epoch: 3, track: 'tab', endSample: 320, discardedTailSamples: 0, degradedReasons: [] })

    const replay = new DialpadBrowserProtocolState({ expectedEpoch: 3, allowedTracks: ['tab'] })
    replay.acceptText('{"type":"auth","token":"grant","epoch":3,"controlVersion":2}')
    replay.confirmAuthentication({ epoch: 3, tracks: ['tab'] })
    expectCode(() => replay.acceptBinary(pcm), 'format_invalid')
    replay.acceptText(format)
    replay.acceptText(format)
    expectCode(() => replay.acceptText('{"type":"track_format","epoch":3,"track":"tab","contextSampleRateHz":44100,"inputChannels":1,"recordingMimeType":"audio/webm;codecs=opus","pcmSampleRateHz":16000,"pcmChannels":1,"pcmEncoding":"s16le"}'), 'format_invalid')
    replay.acceptBinary(pcm)
    expectCode(() => replay.acceptText('{"type":"pcm_eof","epoch":3,"track":"tab","endSample":319,"discardedTailSamples":0,"degradedReasons":[]}'), 'control_invalid')
    expect(replay.acceptText('{"type":"pcm_eof","epoch":3,"track":"tab","endSample":320,"discardedTailSamples":319,"degradedReasons":["capture_overflow"]}')).toMatchObject({ type: 'pcm_eof', endSample: 320 })
    expect(replay.acceptText('{"type":"pcm_eof","epoch":3,"track":"tab","endSample":320,"discardedTailSamples":319,"degradedReasons":["capture_overflow"]}')).toMatchObject({ type: 'pcm_eof' })
    expectCode(() => replay.acceptText('{"type":"pcm_eof","epoch":3,"track":"tab","endSample":320,"discardedTailSamples":0,"degradedReasons":[]}'), 'control_invalid')

    const eofFence = new DialpadBrowserProtocolState({ expectedEpoch: 3, allowedTracks: ['tab', 'mic'] })
    eofFence.acceptText('{"type":"auth","token":"grant","epoch":3,"controlVersion":2}')
    eofFence.confirmAuthentication({ epoch: 3, tracks: ['tab', 'mic'] })
    const micFormat = format.replace('"track":"tab"', '"track":"mic"')
    eofFence.acceptText(format)
    eofFence.acceptText(micFormat)
    eofFence.acceptBinary(pcm)
    eofFence.acceptText('{"type":"pcm_eof","epoch":3,"track":"tab","endSample":320,"discardedTailSamples":0,"degradedReasons":[]}')
    expectCode(() => eofFence.acceptBinary(pcm), 'control_invalid')
    expect(eofFence.acceptBinary(encodeDialpadBrowserBinary({ kind: 'pcm', track: 'mic', epoch: 3, sequence: 0, sampleClock: 0, payload: new Uint8Array(640) }))).toMatchObject({ track: 'mic' })

    const interrupted = new DialpadBrowserProtocolState({ expectedEpoch: 3, allowedTracks: ['tab', 'mic'] })
    interrupted.acceptText('{"type":"auth","token":"grant","epoch":3,"controlVersion":2}')
    interrupted.confirmAuthentication({ epoch: 3, tracks: ['tab', 'mic'] })
    interrupted.acceptText(format)
    interrupted.acceptText(micFormat)
    interrupted.acceptText('{"type":"capture_interrupted","epoch":3,"track":"tab","reason":"capture_interrupted"}')
    expectCode(() => interrupted.acceptBinary(pcm), 'control_invalid')
    interrupted.acceptText('{"type":"capture_interrupted","epoch":3,"track":"tab","reason":"capture_interrupted"}')
    expectCode(() => interrupted.acceptText('{"type":"capture_interrupted","epoch":3,"track":"tab","reason":"capture_sink_failed"}'), 'control_invalid')
    expect(interrupted.acceptBinary(encodeDialpadBrowserBinary({ kind: 'pcm', track: 'mic', epoch: 3, sequence: 0, sampleClock: 0, payload: new Uint8Array(640) }))).toMatchObject({ track: 'mic' })

    const redemptionMismatch = new DialpadBrowserProtocolState({ expectedEpoch: 3 })
    redemptionMismatch.acceptText('{"type":"auth","token":"grant","epoch":3,"controlVersion":2}')
    expectCode(() => redemptionMismatch.confirmAuthentication({ epoch: 2, tracks: ['tab'] }), 'epoch_mismatch')
    expectCode(() => redemptionMismatch.acceptText('{"type":"auth","token":"retry","epoch":3,"controlVersion":2}'), 'auth_failed')

    const trackMismatch = new DialpadBrowserProtocolState({ expectedEpoch: 3, allowedTracks: ['tab'] })
    trackMismatch.acceptText('{"type":"auth","token":"grant","epoch":3,"controlVersion":2}')
    expectCode(() => trackMismatch.confirmAuthentication({ epoch: 3, tracks: ['mic'] }), 'track_invalid')
    expectCode(() => trackMismatch.acceptText('{"type":"auth","token":"retry","epoch":3,"controlVersion":2}'), 'auth_failed')

    const duplicateTracks = new DialpadBrowserProtocolState({ expectedEpoch: 3 })
    duplicateTracks.acceptText('{"type":"auth","token":"grant","epoch":3,"controlVersion":2}')
    expectCode(() => duplicateTracks.confirmAuthentication({ epoch: 3, tracks: ['tab', 'tab'] }), 'track_invalid')

    const rejected = new DialpadBrowserProtocolState({ expectedEpoch: 3 })
    rejected.acceptText('{"type":"auth","token":"grant","epoch":3,"controlVersion":2}')
    rejected.rejectAuthentication()
    expectCode(() => rejected.confirmAuthentication({ epoch: 3, tracks: ['tab'] }), 'auth_failed')
    expectCode(() => rejected.acceptBinary(pcm), 'auth_failed')

    const threeHours = new DialpadBrowserProtocolState({ expectedEpoch: 3 })
    threeHours.acceptText('{"type":"auth","token":"grant","epoch":3,"controlVersion":2}')
    threeHours.confirmAuthentication({ epoch: 3, tracks: ['tab'] })
    threeHours.acceptText('{"type":"track_format","epoch":3,"track":"tab","contextSampleRateHz":48000,"inputChannels":1,"recordingMimeType":"audio/webm;codecs=opus","pcmSampleRateHz":16000,"pcmChannels":1,"pcmEncoding":"s16le"}')
    expect(threeHours.acceptBinary(encodeDialpadBrowserBinary({
      kind: 'pcm', track: 'tab', epoch: 3, sequence: 1, sampleClock: 172_800_000, payload: new Uint8Array(640),
    }))).toMatchObject({ kind: 'pcm', sampleClock: 172_800_000 })
  })
})

describe('Dialpad browser server acknowledgements', () => {
  it('round-trips only minimal ready, retention ack/EOF ack, and PCM drained metadata', () => {
    const projected = toDialpadBrowserMeasurementSnapshot({
      epoch: 1, revision: 1, totalSamples: 0, measurementStatus: 'provisional',
      threshold: { crossed: false, crossingEpoch: null, crossingSample: null }, degradedReasons: [],
    })
    expect(projected).toEqual({
      type: 'measurement_snapshot', epoch: 1, revision: 1, totalSamples: 0, measurementStatus: 'provisional',
      threshold: { crossed: false, crossingEpoch: null, crossingSample: null }, degradedReasons: [],
    })
    const messages = [
      { type: 'ready', epoch: 1, controlVersion: 2 } as const,
      { type: 'measurement_snapshot', epoch: 1, revision: 4, totalSamples: 4_800_001, measurementStatus: 'provisional', threshold: { crossed: true, crossingEpoch: 1, crossingSample: 4_800_001 }, degradedReasons: ['capture_overflow'] } as const,
      { type: 'capture_state', epoch: 1, latestConsumedEpoch: 1, state: 'closing', drainDeadlineAt: '2026-09-29T12:01:00.000Z' } as const,
      { type: 'recording_chunk_ack', track: 'tab', epoch: 1, seq: 7, status: 'recorded' } as const,
      { type: 'pcm_frame_ack', epoch: 1, track: 'mic', seq: 7 } as const,
      { type: 'recording_eof_ack', track: 'mic', epoch: 1, lastSeq: 9_999 } as const,
      { type: 'pcm_eof_drained', track: 'tab', epoch: 1, endSample: 123_456 } as const,
    ]
    for (const message of messages) expect(parseDialpadBrowserServerMessage(encodeDialpadBrowserServerMessage(message))).toEqual(message)
    expectCode(() => parseDialpadBrowserServerMessage('{"type":"ready","epoch":1,"sellerSpeechSecondsMeasured":301}'), 'server_message_invalid')
    expectCode(() => parseDialpadBrowserServerMessage('{"type":"recording_chunk_ack","track":"tab","epoch":1,"seq":7,"status":"recorded","path":"forged"}'), 'server_message_invalid')
    expectCode(() => parseDialpadBrowserServerMessage('{"type":"pcm_frame_ack","epoch":1,"track":"mic","seq":7,"status":"processed"}'), 'server_message_invalid')
    expectCode(() => parseDialpadBrowserServerMessage('{"type":"measurement_snapshot","epoch":1,"revision":1,"totalSamples":1,"measurementStatus":"finalized","threshold":{"crossed":false,"crossingEpoch":null,"crossingSample":null},"degradedReasons":[]}'), 'server_message_invalid')
    expectCode(() => parseDialpadBrowserServerMessage('{"type":"measurement_snapshot","epoch":1,"revision":1,"totalSamples":1,"measurementStatus":"partial","threshold":{"crossed":false,"crossingEpoch":1,"crossingSample":null},"degradedReasons":[]}'), 'server_message_invalid')
    expectCode(() => parseDialpadBrowserServerMessage('{"type":"measurement_snapshot","epoch":1,"revision":1,"totalSamples":1,"measurementStatus":"partial","threshold":{"crossed":true,"crossingEpoch":null,"crossingSample":1},"degradedReasons":[]}'), 'server_message_invalid')
    expectCode(() => parseDialpadBrowserServerMessage('{"type":"capture_state","epoch":1,"state":"closing","drainDeadlineAt":null}'), 'server_message_invalid')
  })
})

function expectCode(action: () => unknown, code: string): void {
  try {
    action()
    throw new Error(`expected ${code}`)
  } catch (error) {
    expect(error).toMatchObject({ code })
  }
}
