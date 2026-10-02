// One Deepgram live (streaming) WS connection per call per track. Mirrors
// src/transcription/deepgram-provider.ts's auth convention (Token header)
// but targets the streaming `/v1/listen` endpoint instead of the
// prerecorded REST one.
//
// Codex correction (second review pass): sockets now open the moment the
// bridge is created (tap START, both tracks proactively — see
// ingest-ws-server.ts), not lazily on first media frame — a lazy connect
// was dropping every frame that arrived before the handshake completed.
// send() buffers audio (bounded) while the socket is still connecting or
// mid-reconnect, flushing it once open instead of silently discarding it.
// close() is now graceful: it sends CloseStream and waits for Deepgram's
// own close (or a bounded timeout) so in-flight transcription results
// aren't cut off mid-utterance by an immediate hard close.

import WebSocket from 'ws'
import { readCoachDeepgramOptions, type CoachDeepgramOptions } from './env.js'

const DEEPGRAM_LIVE_URL = 'wss://api.deepgram.com/v1/listen'
const RECONNECT_DELAYS_MS = [250, 500, 1_000, 2_000, 4_000]
const MAX_BUFFERED_BYTES = 320_000 // ~10s of 16kHz mono L16 (or ~40s of 8kHz mono mulaw) — generous for a reconnect, bounded against a stuck socket
const GRACEFUL_CLOSE_TIMEOUT_MS = 3_000 // fixed bound for connection-establishment waits (handshake, initial connect) — unrelated to buffered audio volume
// Conservative DEFAULT used only when a caller doesn't tell us the
// negotiated format's real bytes/sec (e.g. an older/other caller). The
// actual value used in production is derived from the Telnyx `start`
// event's media_format (see ingest-ws-server.ts's openPipeline) — mulaw is
// 1 byte/sample, L16 is 2 bytes/sample, both at whatever sample rate was
// actually negotiated. This constant must NEVER be assumed correct for a
// live call; it only exists so this module still behaves sanely if
// bytesPerSecond is omitted.
const DEFAULT_BYTES_PER_SECOND = 32_000 // 16kHz * 2 bytes/sample, mono (legacy L16/16kHz assumption)
const DEEPGRAM_REPLAY_SPEED_FACTOR = 1.25 // Deepgram processes buffered/replayed audio at up to ~1.25x realtime
const MAX_CLOSE_DEADLINE_MS = 15_000 // sane cap regardless of how much was buffered — never lets a large backlog block shutdown indefinitely

// A flat 3s post-CloseStream wait cuts the tail whenever Deepgram still has
// real work outstanding: it processes audio at up to ~1.25x realtime, so a
// 10s backlog needs ~8s of processing time alone before it can send finals
// and close, well past the old fixed 3s deadline. The close-wait deadline
// scales with OUTSTANDING (not-yet-processed) audio, plus a fixed margin
// for the CloseStream round trip and final-results delivery on top of pure
// processing, capped so a pathological backlog still can't block shutdown
// forever. bytesPerSecond MUST reflect the actually-negotiated audio
// format (mulaw vs L16, and its sample rate) — getting it wrong either
// cuts the tail short (assumed too high) or wastes shutdown time (assumed
// too low, though MAX_CLOSE_DEADLINE_MS bounds the damage either way).
function closeDeadlineMsForOutstandingBytes(bytes: number, bytesPerSecond: number): number {
  const outstandingSeconds = bytes / bytesPerSecond
  const processingMs = (outstandingSeconds / DEEPGRAM_REPLAY_SPEED_FACTOR) * 1000
  return Math.min(processingMs + GRACEFUL_CLOSE_TIMEOUT_MS, MAX_CLOSE_DEADLINE_MS)
}

export interface DeepgramLiveWord {
  readonly word: string
  readonly start: number
  readonly end: number
  readonly confidence: number
}

export interface DeepgramLiveTranscript {
  readonly isFinal: boolean
  readonly speechFinal?: boolean
  readonly fromFinalize?: boolean
  readonly text: string
  readonly words: ReadonlyArray<DeepgramLiveWord>
  readonly confidence: number
}

export interface DeepgramLiveBridgeOptions {
  readonly apiKey: string
  readonly liveOptions?: CoachDeepgramOptions
  readonly sellerTrack?: boolean
  readonly sampleRate?: number
  /** Deepgram's `encoding` query param. Defaults to 'linear16' (the legacy L16 behavior) for backward compatibility — real callers should pass the value derived from the actually-negotiated Telnyx media_format. */
  readonly encoding?: 'linear16' | 'mulaw'
  /**
   * Bytes/sec of the audio this bridge will be fed, used to derive
   * closeDeadlineMsForOutstandingBytes' pacing. MUST reflect the actually
   * negotiated format (mulaw = 1 byte/sample, linear16 = 2 bytes/sample,
   * times sample rate times channels) — never a hardcoded assumption.
   * Defaults to the legacy L16/16kHz-mono value (32,000) as a safe
   * conservative fallback when the real negotiated format isn't known yet
   * or a caller doesn't pass it, rather than crashing.
   */
  readonly bytesPerSecond?: number
  readonly onTranscript: (transcript: DeepgramLiveTranscript) => void
  readonly onError?: (error: unknown) => void
  /**
   * Fires every time the socket successfully opens — the FIRST connect and
   * every reconnect. Deepgram's word timings restart at zero on each new
   * socket, so a caller anchoring wall-clock timestamps to "stream start"
   * needs to rebase that anchor here, not just once.
   *
   * The argument is the CAPTURE time of the first still-buffered sample
   * this socket is about to flush, not "now" — a reconnect can leave a
   * backlog queued for anywhere up to MAX_BUFFERED_BYTES worth of audio
   * (or however long the reconnect backoff took) before the socket
   * finishes reopening, so "now" would misdate every word timing computed
   * against this anchor until the NEXT reconnect. undefined means there
   * was nothing buffered (e.g. the very first connect) — the caller should
   * fall back to its own "now" in that case, since there's no earlier
   * capture time to prefer.
   */
  readonly onOpen?: (firstBufferedCaptureAtMs: number | undefined) => void
  readonly createSocket?: (url: string, apiKey: string) => WebSocket
}

export interface DeepgramLiveBridge {
  /** capturedAtMs defaults to Date.now() if omitted — pass the real capture time (e.g. ReorderChunk.receivedAtMs) so a reconnect's onOpen anchor reflects when the audio was actually received, not when the socket happened to finish reopening. */
  send(pcmLittleEndian: Buffer, capturedAtMs?: number): void
  /** Sends CloseStream and waits for Deepgram to finish and close gracefully, up to a bounded timeout. Flushes buffered audio first — including audio buffered while the socket is still mid-handshake (CONNECTING), not just already-OPEN. */
  close(): Promise<void>
}

interface BufferedChunk {
  readonly payload: Buffer
  readonly capturedAtMs: number
}

export function createDeepgramLiveBridge(options: DeepgramLiveBridgeOptions): DeepgramLiveBridge {
  const liveOptions = options.liveOptions ?? readCoachDeepgramOptions()
  const sampleRate = options.sampleRate ?? 16_000
  const encoding = options.encoding ?? 'linear16'
  const bytesPerSecond = options.bytesPerSecond ?? DEFAULT_BYTES_PER_SECOND
  const url = buildDeepgramLiveUrl(sampleRate, encoding, liveOptions)
  const openSocket = options.createSocket ?? defaultCreateSocket

  let socket: WebSocket | undefined
  let open = false
  let stopped = false
  let reconnectAttempt = 0
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined
  const bufferedChunks: BufferedChunk[] = []
  let bufferedBytes = 0
  // How much audio has been SENT to Deepgram (over the wire) but Deepgram
  // hasn't had time to process yet, as a decaying leaky-bucket counter: it
  // grows on every socket.send() and drains continuously at
  // DEEPGRAM_REPLAY_SPEED_FACTOR x realtime. This is the correct basis for
  // the close-wait deadline — NOT bufferedBytes, which only reflects what's
  // still queued LOCALLY. A reconnect's own auto-flush (connect()'s open
  // handler) sends a backlog straight to Deepgram and drains bufferedBytes
  // to 0 immediately; if close() is called shortly after, bufferedBytes
  // alone would wrongly compute just the 3s floor even though Deepgram is
  // still working through what was just handed to it.
  let outstandingAudioBytes = 0
  let outstandingSettledAtMs = Date.now()
  let speechMs = 0
  let silenceMs = 0
  let speaking = false
  let fired = false

  function resetVad(): void { speechMs = 0; silenceMs = 0; speaking = false; fired = false }
  function checkSilence(audio: Buffer): void {
    if (!options.sellerTrack || liveOptions.finalizeSilenceMs === undefined) return
    // 20 ms windows; mu-law is decoded to linear PCM before measuring RMS.
    const bytesPerSample = encoding === 'mulaw' ? 1 : 2
    const windowBytes = Math.max(bytesPerSample, Math.round(sampleRate / 50) * bytesPerSample)
    for (let offset = 0; offset < audio.length; offset += windowBytes) {
      const end = Math.min(audio.length, offset + windowBytes)
      let energy = 0
      const samples = Math.floor((end - offset) / bytesPerSample)
      if (samples === 0) continue
      for (let i = offset; i + bytesPerSample <= end; i += bytesPerSample) {
        let pcm: number
        if (encoding === 'mulaw') {
          const value = (~audio[i]!) & 0xff
          const magnitude = ((value & 15) << 3) + 132
          pcm = ((magnitude << ((value >> 4) & 7)) - 132) * ((value & 128) ? -1 : 1)
        } else pcm = audio.readInt16LE(i)
        energy += pcm * pcm
      }
      const rms = Math.sqrt(energy / samples)
      const duration = (samples / sampleRate) * 1000
      if (rms >= (speaking ? 400 : 700)) {
        speaking = true; speechMs += duration; silenceMs = 0; fired = false
      } else if (speaking) {
        if (speechMs < 200) { speaking = false; speechMs = 0; continue }
        silenceMs += duration
        if (!fired && speechMs >= 200 && silenceMs >= liveOptions.finalizeSilenceMs && socket?.readyState === WebSocket.OPEN) {
          socket.send(JSON.stringify({ type: 'Finalize' }))
          fired = true
          // Re-arm only after a fresh >= 200 ms of speech above the on-threshold.
          speaking = false; speechMs = 0; silenceMs = 0
        }
      }
    }
  }

  function settleOutstandingAudio(nowMs: number = Date.now()): void {
    const elapsedMs = Math.max(0, nowMs - outstandingSettledAtMs)
    const processedBytes = (elapsedMs / 1000) * DEEPGRAM_REPLAY_SPEED_FACTOR * bytesPerSecond
    outstandingAudioBytes = Math.max(0, outstandingAudioBytes - processedBytes)
    outstandingSettledAtMs = nowMs
  }

  function trackSentToDeepgram(byteCount: number): void {
    settleOutstandingAudio()
    outstandingAudioBytes += byteCount
  }

  function bufferForFlushLater(chunk: Buffer, capturedAtMs: number): void {
    bufferedChunks.push({ payload: chunk, capturedAtMs })
    bufferedBytes += chunk.length
    while (bufferedBytes > MAX_BUFFERED_BYTES && bufferedChunks.length > 0) {
      const dropped = bufferedChunks.shift()
      if (dropped) bufferedBytes -= dropped.payload.length
    }
  }

  function clearBuffered(): void {
    bufferedChunks.length = 0
    bufferedBytes = 0
  }

  function flushBuffered(): void {
    if (!socket || socket.readyState !== WebSocket.OPEN) return
    while (bufferedChunks.length > 0) {
      const chunk = bufferedChunks.shift()
      if (!chunk) continue
      bufferedBytes -= chunk.payload.length
      socket.send(chunk.payload)
      trackSentToDeepgram(chunk.payload.length)
      // Buffered speech counts toward the finalize VAD exactly like live audio.
      checkSilence(chunk.payload)
    }
  }

  function connect(): void {
    if (stopped) return
    const ws = openSocket(url, options.apiKey)
    socket = ws
    ws.on('open', () => {
      resetVad()
      open = true
      reconnectAttempt = 0
      // Read BEFORE flushBuffered() empties the queue.
      const firstBufferedCaptureAtMs = bufferedChunks[0]?.capturedAtMs
      options.onOpen?.(firstBufferedCaptureAtMs)
      flushBuffered()
    })
    ws.on('message', (data: WebSocket.RawData) => {
      const transcript = parseDeepgramLiveMessage(data)
      if (transcript) options.onTranscript(transcript)
    })
    ws.on('error', (error: unknown) => {
      options.onError?.(error)
    })
    ws.on('close', () => {
      open = false
      if (stopped) return
      const delay = RECONNECT_DELAYS_MS[Math.min(reconnectAttempt, RECONNECT_DELAYS_MS.length - 1)] ?? 4_000
      reconnectAttempt += 1
      reconnectTimer = setTimeout(connect, delay)
    })
  }

  connect()

  // Sends CloseStream and waits for Deepgram's own close (or a bounded
  // timeout). Assumes buffered audio has ALREADY been flushed (or there
  // was none) — callers pick the right moment to flush before calling this.
  // deadlineMs should reflect how much was JUST flushed (see
  // closeDeadlineMsForBufferedBytes) — Deepgram needs real time to process
  // a large backlog before it can send finals and close.
  function sendCloseStreamAndWait(ws: WebSocket, deadlineMs: number = GRACEFUL_CLOSE_TIMEOUT_MS): Promise<void> {
    if (ws.readyState === WebSocket.CLOSED) return Promise.resolve()
    return new Promise<void>((resolve) => {
      let settled = false
      const finish = (): void => {
        if (settled) return
        settled = true
        clearTimeout(timeout)
        resolve()
      }
      const timeout = setTimeout(() => {
        try { ws.terminate() } catch { /* best-effort */ }
        finish()
      }, deadlineMs)
      ws.once('close', finish)
      try {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'CloseStream' }))
        } else {
          ws.terminate()
        }
      } catch {
        finish()
      }
    })
  }

  // close() may land between sockets (reconnect backoff) or after the old
  // socket has entered CLOSING. Buffered tail audio still has value in both
  // states, so establish one final bounded connection solely to flush that
  // backlog and request Deepgram's final results.
  function waitForSocketToRetire(ws: WebSocket): Promise<void> {
    if (ws.readyState === WebSocket.CLOSED) return Promise.resolve()
    return new Promise<void>((resolve) => {
      let settled = false
      const finish = (): void => {
        if (settled) return
        settled = true
        clearTimeout(timeout)
        resolve()
      }
      const timeout = setTimeout(() => {
        try { ws.terminate() } catch { /* best-effort */ }
        finish()
      }, GRACEFUL_CLOSE_TIMEOUT_MS)
      ws.once('close', finish)
    })
  }

  async function flushBufferedThroughFinalSocket(previousSocket: WebSocket | undefined): Promise<void> {
    // Do not let two Deepgram generations overlap. A late final from the old
    // socket must retain its old timestamp anchor before onOpen rebases the
    // pipeline for the final flush socket.
    if (previousSocket && previousSocket.readyState !== WebSocket.CLOSED) {
      await waitForSocketToRetire(previousSocket)
    }

    const ws = openSocket(url, options.apiKey)
    socket = ws
    return new Promise<void>((resolve) => {
      let settled = false
      let connectTimeout: ReturnType<typeof setTimeout> | undefined
      const finish = (): void => {
        if (settled) return
        settled = true
        if (connectTimeout) clearTimeout(connectTimeout)
        clearBuffered()
        resolve()
      }
      connectTimeout = setTimeout(() => {
        try { ws.terminate() } catch { /* best-effort */ }
        finish()
      }, GRACEFUL_CLOSE_TIMEOUT_MS)
      ws.on('message', (data: WebSocket.RawData) => {
        const transcript = parseDeepgramLiveMessage(data)
        if (transcript) options.onTranscript(transcript)
      })
      ws.on('error', (error: unknown) => options.onError?.(error))
      ws.once('close', finish)
      ws.once('open', () => {
        resetVad()
        if (connectTimeout) clearTimeout(connectTimeout)
        connectTimeout = undefined
        open = true
        const firstBufferedCaptureAtMs = bufferedChunks[0]?.capturedAtMs
        options.onOpen?.(firstBufferedCaptureAtMs)
        flushBuffered()
        // Computed AFTER the flush above (which just sent this backlog to
        // Deepgram and is tracked via trackSentToDeepgram) so the deadline
        // reflects everything actually outstanding, not what happened to
        // still be in the local buffer before this call.
        settleOutstandingAudio()
        const closeDeadlineMs = closeDeadlineMsForOutstandingBytes(outstandingAudioBytes, bytesPerSecond)
        // sendCloseStreamAndWait owns a fresh full finalization window; a
        // slow-but-successful handshake does not consume it.
        void sendCloseStreamAndWait(ws, closeDeadlineMs).finally(finish)
      })
    })
  }

  return {
    send(pcmLittleEndian: Buffer, capturedAtMs: number = Date.now()): void {
      if (stopped) return
      if (!open || !socket || socket.readyState !== WebSocket.OPEN) {
        bufferForFlushLater(pcmLittleEndian, capturedAtMs)
        return
      }
      socket.send(pcmLittleEndian)
      trackSentToDeepgram(pcmLittleEndian.length)
      checkSilence(pcmLittleEndian)
    },
    close(): Promise<void> {
      stopped = true
      if (reconnectTimer) {
        clearTimeout(reconnectTimer)
        reconnectTimer = undefined
      }
      const ws = socket

      if (ws && ws.readyState === WebSocket.OPEN) {
        // Flush whatever's still buffered BEFORE CloseStream — Deepgram
        // needs every queued sample to produce its final results for the
        // tail of the call; discarding the buffer here would silently
        // drop the last few seconds of audio from the last segment.
        flushBuffered()
        clearBuffered()
        // Computed AFTER the flush (tracked via trackSentToDeepgram) so
        // the deadline reflects everything outstanding, including audio
        // that was flushed moments earlier by a reconnect's own open
        // handler — NOT just what's still queued locally right now, which
        // can already be 0 by the time close() runs.
        settleOutstandingAudio()
        return sendCloseStreamAndWait(ws, closeDeadlineMsForOutstandingBytes(outstandingAudioBytes, bytesPerSecond))
      }

      if (ws && ws.readyState === WebSocket.CONNECTING) {
        // Mid-handshake — the buffer isn't lost just because the socket
        // hasn't finished opening yet. Wait (bounded, fixed — this is just
        // the handshake, not audio processing) for the natural 'open'
        // (connect()'s own handler above already flushes on open), then
        // CloseStream with a deadline computed AFTER that flush. `stopped
        // = true` above means connect() will NOT schedule a further
        // reconnect if this handshake instead fails, so the timeout below
        // is what actually bails out in that case — never an unbounded wait.
        return new Promise<void>((resolve) => {
          let settled = false
          const finishAll = (): void => {
            if (settled) return
            settled = true
            clearTimeout(timeout)
            clearBuffered()
            resolve()
          }
          const timeout = setTimeout(() => {
            try { ws.terminate() } catch { /* best-effort */ }
            finishAll()
          }, GRACEFUL_CLOSE_TIMEOUT_MS)
          ws.once('open', () => {
            // Retire the connection-phase deadline; CloseStream owns a
            // fresh finalization deadline from this point, computed after
            // connect()'s own open handler has already flushed.
            clearTimeout(timeout)
            settleOutstandingAudio()
            void sendCloseStreamAndWait(ws, closeDeadlineMsForOutstandingBytes(outstandingAudioBytes, bytesPerSecond)).finally(finishAll)
          })
          ws.once('close', finishAll)
        })
      }

      // No live OPEN/CONNECTING socket to flush anything outstanding
      // through. If the PREVIOUS socket already fully closed before we saw
      // its finals, that audio's results are gone regardless of what we do
      // next — a fresh Deepgram connection starts a new session and can't
      // recover them, so there is nothing to gain by opening one just for
      // that. Only still-LOCALLY-buffered audio (never sent to any socket
      // yet) is worth flushing through a fresh one.
      if (bufferedChunks.length > 0) {
        return flushBufferedThroughFinalSocket(ws)
      }

      return Promise.resolve()
    },
  }
}

function buildDeepgramLiveUrl(sampleRate: number, encoding: 'linear16' | 'mulaw', options: CoachDeepgramOptions): string {
  const url = new URL(DEEPGRAM_LIVE_URL)
  url.searchParams.set('model', 'nova-3')
  url.searchParams.set('encoding', encoding)
  url.searchParams.set('sample_rate', String(sampleRate))
  url.searchParams.set('channels', '1')
  url.searchParams.set('interim_results', 'true')
  url.searchParams.set('endpointing', String(options.endpointingMs))
  if (options.smartFormat) url.searchParams.set('smart_format', 'true')
  else url.searchParams.set('punctuate', 'true')
  if (options.noDelay) url.searchParams.set('no_delay', 'true')
  return url.toString()
}

function defaultCreateSocket(url: string, apiKey: string): WebSocket {
  return new WebSocket(url, {
    headers: { Authorization: `Token ${apiKey}` },
  })
}

interface DeepgramLiveWordPayload {
  readonly word?: unknown
  readonly start?: unknown
  readonly end?: unknown
  readonly confidence?: unknown
}

interface DeepgramLiveAlternative {
  readonly transcript?: unknown
  readonly confidence?: unknown
  readonly words?: unknown
}

interface DeepgramLiveResultsMessage {
  readonly type?: unknown
  readonly is_final?: unknown
  readonly speech_final?: unknown
  readonly from_finalize?: unknown
  readonly channel?: { readonly alternatives?: unknown }
}

function parseDeepgramLiveMessage(data: WebSocket.RawData): DeepgramLiveTranscript | undefined {
  let payload: unknown
  try {
    payload = JSON.parse(data.toString())
  } catch {
    return undefined
  }
  if (!isRecord(payload)) return undefined
  const message = payload as DeepgramLiveResultsMessage
  if (message.type !== 'Results' && message.type !== undefined) {
    // Deepgram also sends Metadata/UtteranceEnd/SpeechStarted frames we don't
    // act on yet — silently ignore anything that isn't a Results frame.
    if (message.type !== 'Results') return undefined
  }
  const alternatives = message.channel?.alternatives
  const first = Array.isArray(alternatives) ? alternatives.find(isRecord) as DeepgramLiveAlternative | undefined : undefined
  if (!first || typeof first.transcript !== 'string') return undefined
  const text = first.transcript.trim()
  if (!text) return undefined
  return {
    isFinal: message.is_final === true,
    speechFinal: message.speech_final === true,
    fromFinalize: message.from_finalize === true,
    text,
    confidence: typeof first.confidence === 'number' ? first.confidence : 0,
    words: Array.isArray(first.words) ? first.words.filter(isRecord).map(toWord) : [],
  }
}

function toWord(raw: DeepgramLiveWordPayload): DeepgramLiveWord {
  return {
    word: typeof raw.word === 'string' ? raw.word : '',
    start: typeof raw.start === 'number' ? raw.start : 0,
    end: typeof raw.end === 'number' ? raw.end : 0,
    confidence: typeof raw.confidence === 'number' ? raw.confidence : 0,
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}
