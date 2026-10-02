import type { RawData, WebSocket } from 'ws'
import { createDeepgramLiveBridge, type DeepgramLiveBridge, type DeepgramLiveTranscript } from './approved/deepgram-live.js'
import { ObjectionPromptCall } from './approved/objection-prompt/index.js'
import { readCoachDeepgramOptions } from './approved/env.js'
import type { CoachWireMessage } from './approved/wire-contract.js'
import { parseMedia, parseStart, type TelnyxMedia, type TelnyxStart } from './media.js'
import { MediaIntegrityError, MediaOrderBuffer } from './order.js'
import type { CoachClaims, CoachLogger, CoachPublisher, DirectCoachBinding, DirectCoachDb } from './types.js'

const MAX_AUDIO_SECONDS = 180
const MAX_AUDIO_BYTES = 2 * 8000 * MAX_AUDIO_SECONDS
const MAX_MEDIA_MESSAGES = 24_000
const MAX_PRESTART_MEDIA_MESSAGES = 1_024
const MAX_PRESTART_MEDIA_BYTES = 256 * 1024
const ACTIVE_CHECK_MS = 5_000
const CLOSE_GRACE_MS = 15_000
const PRESTART_DEADLINE_MS = 10_000

export class SessionLimitError extends MediaIntegrityError {}

export interface CoachSessionDeps {
  readonly db: DirectCoachDb
  readonly publisher: CoachPublisher
  readonly deepgramApiKey: string
  readonly jevApiKey: string
  readonly logger: CoachLogger
  readonly now?: () => number
  readonly preStartTimeoutMs?: number
  readonly bridgeFactory?: (options: Parameters<typeof createDeepgramLiveBridge>[0]) => DeepgramLiveBridge
  readonly objectionFactory?: (options: ConstructorParameters<typeof ObjectionPromptCall>[0]) => ObjectionPromptCall
  readonly onEnd?: () => void
}

export class CoachSession {
  private readonly now: () => number
  private readonly bridgeFactory: NonNullable<CoachSessionDeps['bridgeFactory']>
  private readonly objectionFactory: NonNullable<CoachSessionDeps['objectionFactory']>
  private started = false
  private starting = false
  private inputClosed = false
  private outputClosed = false
  private binding?: DirectCoachBinding
  private start?: TelnyxStart
  private order?: MediaOrderBuffer
  private bridges?: { inbound: DeepgramLiveBridge; outbound: DeepgramLiveBridge }
  private objection?: ObjectionPromptCall
  private activeTimer?: ReturnType<typeof setInterval>
  private expiryTimer?: ReturnType<typeof setTimeout>
  private sessionTimer?: ReturnType<typeof setTimeout>
  private prestartTimer?: ReturnType<typeof setTimeout>
  private startPromise?: Promise<void>
  private closePromise?: Promise<void>
  private mediaMessages = 0
  private audioBytes = 0
  private pendingMediaBytes = 0
  private readonly inFlightPublishes = new Set<Promise<unknown>>()
  private readonly pendingMedia: TelnyxMedia[] = []
  private readonly socketAnchors: { inbound?: number; outbound?: number } = {}
  private activeCheckInFlight = false
  private publishTail: Promise<void> = Promise.resolve()
  private readonly latestFinalAt: { seller: number; rep: number } = { seller: 0, rep: 0 }

  constructor(private readonly ws: WebSocket, private readonly claims: CoachClaims, private readonly admitted: DirectCoachBinding, private readonly deps: CoachSessionDeps) {
    this.binding = admitted
    this.now = deps.now ?? Date.now
    this.bridgeFactory = deps.bridgeFactory ?? createDeepgramLiveBridge
    this.objectionFactory = deps.objectionFactory ?? ((options) => new ObjectionPromptCall(options))
    const expiryDelay = Math.max(0, this.claims.expiresAtMs - this.now())
    this.expiryTimer = setTimeout(() => { void this.finish('token_expired') }, expiryDelay)
    this.prestartTimer = setTimeout(() => { void this.finish('prestart_timeout') }, deps.preStartTimeoutMs ?? PRESTART_DEADLINE_MS)
  }

  handle(raw: RawData): void {
    if (this.inputClosed) return
    try {
      const value = JSON.parse(raw.toString()) as Record<string, unknown>
      const event = typeof value.event === 'string' ? value.event : ''
      if (!this.started && this.starting && event === 'media') {
        const media = parseMedia(value, this.now())
        if (this.pendingMedia.length >= MAX_PRESTART_MEDIA_MESSAGES || this.pendingMediaBytes + media.payload.length > MAX_PRESTART_MEDIA_BYTES) throw new SessionLimitError('pre-start media buffer limit exceeded')
        this.pendingMedia.push(media)
        this.pendingMediaBytes += media.payload.length
        return
      }
      if (!this.started && this.starting) {
        if (event === 'start') throw new Error('duplicate start frame')
        return
      }
      if (!this.started) {
        if (event !== 'start') return // Telnyx's connected preamble and future control frames are harmless.
        this.starting = true
        this.startPromise = this.startPipeline(value.start)
        return
      }
      if (event === 'media') {
        const media = parseMedia(value, this.now())
        this.order?.push(media, media.receivedAtMs)
      } else if (event === 'stop') {
        void this.finish('provider_stop')
      }
    } catch (error) {
      const sessionLimit = error instanceof SessionLimitError
      this.deps.logger.warn('direct_coach.stream_rejected', { reason: sessionLimit ? 'session_limit' : error instanceof MediaIntegrityError ? 'media_integrity' : 'invalid_frame' })
      void this.finish(sessionLimit ? 'session_limit' : 'protocol_error')
    }
  }

  disconnected(): void { void this.finish('disconnect') }

  async finish(reason: string): Promise<void> {
    if (this.closePromise) return this.closePromise
    this.closePromise = this.closeInternal(reason)
    return this.closePromise
  }

  private async startPipeline(rawStart: unknown): Promise<void> {
    if (this.inputClosed || this.started) return
    try {
      const start = parseStart(rawStart)
      if (start.callControlId !== this.claims.sellerLegId) throw new Error('call control id mismatch')
      const binding = await this.deps.db.readBinding(this.claims)
      if (this.inputClosed) return
      if (!binding || binding.callId !== this.admitted.callId || binding.sellerLegId !== this.admitted.sellerLegId || binding.scriptDigest !== this.admitted.scriptDigest) throw new Error('call binding unavailable')
      this.binding = binding
      this.start = start
      this.order = new MediaOrderBuffer((media) => this.acceptOrderedMedia(media))
      const inbound = this.createBridge(true)
      if (this.inputClosed) { await inbound.close().catch(() => undefined); return }
      try {
        const outbound = this.createBridge(false)
        if (this.inputClosed) { await Promise.allSettled([inbound.close(), outbound.close()]); return }
        this.bridges = { inbound, outbound }
      } catch (error) {
        await inbound.close().catch(() => undefined)
        throw error
      }
      this.objection = this.objectionFactory({
        apiKey: this.deps.jevApiKey,
        maxRequests: 10,
        maxInterimRequests: 10,
        turnGapMs: 700,
        echoDrop: true,
        interim: true,
        fetchImpl: fetch,
        logger: this.deps.logger,
        publish: (message) => this.publish(message),
        trackPublish: (promise) => this.trackPublish(promise),
        versions: () => this.versions(),
      })
      if (this.inputClosed) return
      this.started = true
      this.starting = false
      if (this.prestartTimer) clearTimeout(this.prestartTimer)
      const pendingMedia = this.pendingMedia.splice(0)
      this.pendingMediaBytes = 0
      for (const media of pendingMedia) this.order.push(media, media.receivedAtMs)
      this.sessionTimer = setTimeout(() => void this.finish('session_limit'), MAX_AUDIO_SECONDS * 1_000)
      this.activeTimer = setInterval(() => { void this.recheckActive() }, ACTIVE_CHECK_MS)
    } catch {
      this.starting = false
      if (!this.inputClosed) void this.finish('start_rejected')
    }
  }

  private createBridge(sellerTrack: boolean): DeepgramLiveBridge {
    return this.bridgeFactory({
      apiKey: this.deps.deepgramApiKey,
      liveOptions: readCoachDeepgramOptions(),
      sellerTrack,
      sampleRate: 8_000,
      encoding: 'mulaw',
      bytesPerSecond: 8_000,
      onTranscript: (transcript) => this.onTranscript(sellerTrack, transcript),
      onOpen: (firstBufferedCaptureAtMs) => {
        this.socketAnchors[sellerTrack ? 'inbound' : 'outbound'] = firstBufferedCaptureAtMs ?? this.now()
      },
      onError: () => {
        this.deps.logger.warn('direct_coach.deepgram_error')
        void this.finish('deepgram_error')
      },
    })
  }

  private acceptOrderedMedia(media: TelnyxMedia): void {
    if (!this.bridges || this.inputClosed) return
    this.mediaMessages += 1
    this.audioBytes += media.payload.length
    if (this.mediaMessages > MAX_MEDIA_MESSAGES || this.audioBytes > MAX_AUDIO_BYTES) throw new SessionLimitError('audio stream limit exceeded')
    this.bridges[media.track].send(media.payload, media.receivedAtMs)
  }

  private onTranscript(sellerTrack: boolean, transcript: DeepgramLiveTranscript): void {
    if (this.outputClosed || !transcript.text.trim() || !this.binding) return
    const receivedAtMs = this.now()
    const socketAnchor = this.socketAnchors[sellerTrack ? 'inbound' : 'outbound']
    const message: CoachWireMessage = { ...this.versions(), type: 'transcript', speaker: sellerTrack ? 'seller' : 'rep', text: transcript.text, isFinal: transcript.isFinal, ts: new Date(receivedAtMs).toISOString() }
    const speaker = sellerTrack ? 'seller' : 'rep'
    if (transcript.isFinal) this.latestFinalAt[speaker] = receivedAtMs
    const publish = this.publish(message, speaker, transcript.isFinal, receivedAtMs)
    this.trackPublish(publish)
    void publish.catch(() => this.deps.logger.warn('direct_coach.publish_failed'))
    if (!this.objection) return
    if (transcript.isFinal) this.objection.onFinal(sellerTrack ? 'seller' : 'rep', transcript.text, receivedAtMs, transcript.words, socketAnchor)
    else if (sellerTrack) this.objection.onInterim(transcript.text, receivedAtMs, transcript.words, socketAnchor)
  }

  private publish(message: CoachWireMessage, transcriptSpeaker?: 'seller' | 'rep', isFinal = true, receivedAtMs = this.now()): Promise<void> {
    if (!this.binding || this.outputClosed) return Promise.resolve()
    if (transcriptSpeaker && !isFinal && receivedAtMs < this.latestFinalAt[transcriptSpeaker]) return Promise.resolve()
    const task = this.publishTail.then(async () => {
      if (!this.binding || this.outputClosed) return
      if (transcriptSpeaker && !isFinal && receivedAtMs < this.latestFinalAt[transcriptSpeaker]) return
      await this.deps.publisher.publish(this.binding.callId, message)
    })
    this.publishTail = task.catch(() => undefined)
    return task
  }

  private trackPublish(promise: Promise<unknown>): void {
    this.inFlightPublishes.add(promise)
    void promise.then(() => this.inFlightPublishes.delete(promise), () => this.inFlightPublishes.delete(promise))
  }

  private versions() {
    const version = this.binding?.bundle && typeof this.binding.bundle === 'object' && 'script' in this.binding.bundle && this.binding.bundle.script && typeof this.binding.bundle.script === 'object' && 'version' in this.binding.bundle.script && typeof this.binding.bundle.script.version === 'string'
      ? this.binding.bundle.script.version
      : `${this.binding?.scriptSlug ?? ''}@${this.binding?.scriptRevision ?? ''}`
    return { scriptVersion: version, scriptDigest: this.binding?.scriptDigest ?? null, matcherVersion: 'poc-approved-classifier' } as const
  }

  private async recheckActive(): Promise<void> {
    if (!this.binding || this.inputClosed || this.activeCheckInFlight) return
    this.activeCheckInFlight = true
    try {
      if (!await this.deps.db.isActive(this.binding)) await this.finish('call_terminal')
    } catch {
      this.deps.logger.warn('direct_coach.active_check_failed', { failClosed: true })
      await this.finish('active_check_failed')
    } finally { this.activeCheckInFlight = false }
  }

  private async closeInternal(reason: string): Promise<void> {
    const deadline = this.now() + CLOSE_GRACE_MS
    this.inputClosed = true
    this.starting = false
    if (this.activeTimer) clearInterval(this.activeTimer)
    if (this.expiryTimer) clearTimeout(this.expiryTimer)
    if (this.sessionTimer) clearTimeout(this.sessionTimer)
    if (this.prestartTimer) clearTimeout(this.prestartTimer)
    // If the DB admission was still pending, let its bounded operation settle before allocating
    // any Deepgram sockets. A disconnect cannot race this into a paid-bridge leak.
    if (this.startPromise) await bounded(this.startPromise, remaining(deadline, this.now()))
    this.pendingMedia.length = 0
    this.pendingMediaBytes = 0
    let finalReason = reason
    try { this.order?.finish() } catch {
      this.deps.logger.warn('direct_coach.media_integrity_failure')
      finalReason = 'media_integrity'
    }
    const bridges = this.bridges
    if (bridges) await bounded(Promise.allSettled([bridges.inbound.close(), bridges.outbound.close()]).then(() => undefined), remaining(deadline, this.now()))
    this.objection?.close()
    await bounded(Promise.allSettled([...this.inFlightPublishes]).then(() => undefined), remaining(deadline, this.now()))
    this.outputClosed = true
    if (this.binding) await bounded(this.deps.publisher.close(this.binding.callId).catch(() => undefined), remaining(deadline, this.now()))
    if (this.now() >= deadline) this.deps.logger.warn('direct_coach.close_incomplete')
    this.deps.logger.info('direct_coach.session_closed', { reason: finalReason })
    if (typeof this.ws.close === 'function' && this.ws.readyState === 1) this.ws.close(1000, finalReason.slice(0, 120))
    this.deps.onEnd?.()
  }
}

async function bounded<T>(promise: Promise<T>, timeoutMs: number): Promise<T | undefined> {
  if (timeoutMs <= 0) return undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([promise, new Promise<undefined>((resolve) => { timer = setTimeout(() => resolve(undefined), timeoutMs) })])
  } finally { if (timer) clearTimeout(timer) }
}

function remaining(deadline: number, now: number): number { return Math.max(0, deadline - now) }
