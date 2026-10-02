import questionsFile from './jev-line-questions.json' with { type: 'json' }
import motivationDetection from './motivation-detection-questions.approved.json' with { type: 'json' }
import type { CoachWireMessage, CoachWireVersions } from '../wire-contract.js'
import type { CoachObjectionPromptConfig } from '../env.js'
import type { CoachIngestLogger } from '../ingest-types.js'
import type { DeepgramLiveWord } from '../deepgram-live.js'

export const QUESTIONS_SHA256 = '54082c78d9275d1d8cf4bbca815f91e41e70acccf4f753103e2110fe68722f7e'
const DEADLINE_MS = 1_500
const MAX_TURNS = 200
const CUTOFF = 0.80
const questions = questionsFile.questions
/** Owner-approved sub-type detection questions, keyed `motivation.<sub>`; text used exactly as in the file. */
const motivationSubQuestions = Object.entries(motivationDetection as Record<string, { question: string }>).map(([id, entry]) => ({ id, question: entry.question }))
export const MOTIVATION_SUBTYPE_IDS: ReadonlyArray<string> = motivationSubQuestions.map(({ id }) => id)
const classifierQuestions: ReadonlyArray<{ id: string; question: string }> = [...questions, ...motivationSubQuestions]
type CardKind = 'objection' | 'motivation'
/** Marks the general motivation card in per-statement state (sub-types use their own id). */
const GENERAL = ''
type QuestionId = string
type Turn = { speaker: 'persona' | 'learner'; text: string; turn: number }
type JevOutcome =
  | { kind: 'ok'; scores: ReadonlyMap<QuestionId, number>; httpStatus: number }
  | { kind: 'timeout' | 'error'; httpStatus: number | null }

export async function classifyJev(
  transcript: ReadonlyArray<Turn>, sellerTurn: number, apiKey: string,
  fetchImpl: typeof fetch, signal: AbortSignal,
): Promise<JevOutcome> {
  const controller = new AbortController()
  const onAbort = () => controller.abort()
  signal.addEventListener('abort', onAbort, { once: true })
  let httpStatus: number | null = null
  let timedOut = false
  const timer = setTimeout(() => { timedOut = true; controller.abort() }, DEADLINE_MS)
  const abortable = <T>(promise: Promise<T>): Promise<T> => new Promise<T>((resolve, reject) => {
    if (controller.signal.aborted) { reject(new Error('aborted')); return }
    const aborted = () => reject(new Error('aborted'))
    controller.signal.addEventListener('abort', aborted, { once: true })
    void promise.then(
      (value) => { controller.signal.removeEventListener('abort', aborted); resolve(value) },
      (error: unknown) => { controller.signal.removeEventListener('abort', aborted); reject(error) },
    )
  })
  try {
    const requested = Object.fromEntries(classifierQuestions.map(({ id, question }) => [id, {
      type: 'noul',
      instructions: questionsFile.template.prefix.replace('{turn}', String(sellerTurn)) + question + questionsFile.template.suffix,
    }]))
    const response = await abortable(fetchImpl(questionsFile.endpoint, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ state: { transcript }, model: questionsFile.model, questions: requested }),
      signal: controller.signal,
    }))
    httpStatus = response.status
    if (!response.ok) return { kind: 'error', httpStatus }
    const body: unknown = await abortable(response.json())
    if (!body || typeof body !== 'object') return { kind: 'error', httpStatus }
    const record = body as Record<string, unknown>
    if (record.model !== questionsFile.model || !record.answers || typeof record.answers !== 'object') return { kind: 'error', httpStatus }
    const answers = record.answers as Record<string, unknown>
    const scores = new Map<string, number>()
    for (const { id } of questions) {
      const answer = answers[id]
      if (!answer || typeof answer !== 'object') return { kind: 'error', httpStatus }
      const score = (answer as Record<string, unknown>).noul
      if (typeof score !== 'number' || !Number.isFinite(score) || score < 0 || score > 1) return { kind: 'error', httpStatus }
      scores.set(id, score)
    }
    // Sub-type answers are optional: a missing or malformed one only means no sub-type; it never blocks the objection card.
    for (const id of MOTIVATION_SUBTYPE_IDS) {
      const answer = answers[id]
      const score = answer && typeof answer === 'object' ? (answer as Record<string, unknown>).noul : undefined
      if (typeof score === 'number' && Number.isFinite(score) && score >= 0 && score <= 1) scores.set(id, score)
    }
    if (controller.signal.aborted) return { kind: timedOut ? 'timeout' : 'error', httpStatus }
    return { kind: 'ok', scores, httpStatus }
  } catch {
    return { kind: timedOut ? 'timeout' : 'error', httpStatus }
  } finally {
    clearTimeout(timer)
    signal.removeEventListener('abort', onAbort)
  }
}

export interface ObjectionPromptCallOptions {
  readonly apiKey: string
  readonly maxRequests: number
  readonly maxInterimRequests?: number
  readonly turnGapMs?: number | undefined
  readonly echoDrop?: boolean
  readonly interim?: boolean
  readonly fetchImpl: typeof fetch
  readonly logger: CoachIngestLogger
  readonly publish: (message: CoachWireMessage) => Promise<unknown>
  readonly trackPublish: (promise: Promise<unknown>) => void
  readonly versions: () => CoachWireVersions
}

type MotivationAttempt = { key: string; want: string; status: 'pending' | 'delivered' | 'failed' }
/** One seller statement: its latest motivation attempt, plus whether a sub-type card is (or may be) on screen. */
type MotivationTurn = { latest?: MotivationAttempt; pendingSubTypes: Set<string>; subTypeDelivered: boolean }

export class ObjectionPromptCall {
  private turns: Turn[] = []
  // Absolute per-call id of each kept turn; survives the MAX_TURNS trim so repeat keys stay unique.
  private turnIds: number[] = []
  private nextTurnId = 0
  private requestNumber = 0
  private requests = 0
  private interimRequests = 0
  private interimCappedLogged = false
  private lastInterimWords = 0
  private lastSellerEnd: number | undefined
  private latestSellerTurnSeen: number | undefined
  private lastSellerSocket: number | undefined
  private recentSeller: Array<{ text: string; at: number }> = []
  private controller?: AbortController
  private closed = false
  private cappedLogged = false
  private readonly repeated = new Set<string>()
  private readonly inFlight = new Map<string, { seq: number }>()
  // Orders card attempts per kind (Sandra has one slot per kind): a failed publish is only re-sent if
  // nothing newer of that kind has been attempted since.
  private readonly cardSeq: Record<CardKind, number> = { objection: 0, motivation: 0 }
  // What each seller statement's motivation card has delivered, and every publish still awaiting its ack.
  private readonly motivationTurns = new Map<number, MotivationTurn>()
  private motivationOrder = 0

  constructor(private readonly options: ObjectionPromptCallOptions) {}

  onFinal(speaker: 'seller' | 'rep', text: string, transcriptReceivedMs: number,
    words: ReadonlyArray<DeepgramLiveWord> = [], socketAnchor?: number): void {
    if (this.closed || !text.trim()) return
    // Deepgram's interim text restarts after every final, on either track.
    this.lastInterimWords = 0
    const mapped = speaker === 'seller' ? 'persona' : 'learner'
    const last = this.turns.at(-1)
    if (this.options.echoDrop && mapped === 'learner' && this.recentSeller.some((seller) => transcriptReceivedMs - seller.at <= 3_000 && isEcho(text, seller.text))) return
    if (mapped === 'persona') {
      if (this.options.echoDrop && last?.speaker === 'learner' && isEcho(text, last.text)) {
        this.turns.pop(); this.turnIds.pop()
      }
      this.recentSeller.push({ text, at: transcriptReceivedMs })
      this.recentSeller = this.recentSeller.filter((seller) => transcriptReceivedMs - seller.at <= 3_000)
    }
    const prior = this.turns.at(-1)
    const splitByGap = mapped === 'persona' && this.startsNewSellerTurn(words, socketAnchor)
    if (mapped === 'persona') {
      this.lastSellerEnd = words.at(-1)?.end
      this.lastSellerSocket = socketAnchor
    }
    if (prior?.speaker === mapped && !splitByGap) prior.text += ` ${text}`
    else { this.turns.push({ speaker: mapped, text, turn: 0 }); this.turnIds.push(++this.nextTurnId) }
    if (this.turns.length > MAX_TURNS) { this.turns.shift(); this.turnIds.shift() }
    if (mapped !== 'persona') return
    this.latestSellerTurnSeen = this.turnIds[this.turnIds.length - 1]
    this.startRequest(transcriptReceivedMs, false)
  }

  onInterim(text: string, transcriptReceivedMs: number,
    words: ReadonlyArray<DeepgramLiveWord> = [], socketAnchor?: number): void {
    if (!this.options.interim || this.closed || !text.trim()) return
    // Same turn rules as finals (echo removal, then gap), so an interim and its final share one turn id.
    // The echo is only skipped in the snapshot; stored turns are changed by finals alone.
    const last = this.turns.at(-1)
    const skipEcho = this.options.echoDrop && last?.speaker === 'learner' && isEcho(text, last.text)
    const base = skipEcho ? this.turns.at(-2) : last
    const newTurn = base?.speaker !== 'persona' || this.startsNewSellerTurn(words, socketAnchor)
    // Every seller interim, even one too short to classify, moves "the seller's latest turn" forward,
    // so a late re-send for an older turn is recognised as stale while the seller is still mid-sentence.
    this.latestSellerTurnSeen = newTurn ? this.nextTurnId + 1 : this.turnIds[this.turnIds.length - (skipEcho ? 2 : 1)]
    const count = text.trim().split(/\s+/).length
    if (count < 6 || count - this.lastInterimWords < 3) return
    this.lastInterimWords = count
    this.startRequest(transcriptReceivedMs, true, text, newTurn, skipEcho)
  }

  /** Gap rule (off unless turnGapMs is set): a new socket generation, or an audio-time gap above the threshold. */
  private startsNewSellerTurn(words: ReadonlyArray<DeepgramLiveWord>, socketAnchor: number | undefined): boolean {
    if (this.options.turnGapMs === undefined) return false
    const firstStart = words[0]?.start
    return (socketAnchor !== undefined && this.lastSellerSocket !== undefined && socketAnchor !== this.lastSellerSocket) ||
      (firstStart !== undefined && this.lastSellerEnd !== undefined && socketAnchor === this.lastSellerSocket && (firstStart - this.lastSellerEnd) * 1000 > this.options.turnGapMs)
  }

  private startRequest(transcriptReceivedMs: number, interim: boolean, interimText = '', interimNewTurn = false, interimSkipEcho = false): void {
    // Finals keep the original order: a new seller final always supersedes older work.
    // Interims only supersede older work once they will really be sent, so a capped or
    // unbound interim can never abort or stale-drop an in-flight final.
    let number = interim ? 0 : this.supersede()
    const versions = this.options.versions()
    if (versions.scriptVersion === null || versions.scriptDigest === null) {
      this.log(transcriptReceivedMs, null, 'unbound', null, null, interim)
      return
    }
    if (interim ? this.interimRequests >= (this.options.maxInterimRequests ?? 300) : this.requests >= this.options.maxRequests) {
      if (interim ? !this.interimCappedLogged : !this.cappedLogged) {
        if (interim) this.interimCappedLogged = true
        else this.cappedLogged = true
        this.log(transcriptReceivedMs, null, 'capped', null, null, interim)
      }
      return
    }
    if (interim) number = this.supersede()
    const controller = new AbortController()
    this.controller = controller
    if (interim) this.interimRequests += 1
    else this.requests += 1
    const kept = interim && interimSkipEcho ? this.turns.slice(0, -1) : this.turns
    const keptIds = interim && interimSkipEcho ? this.turnIds.slice(0, -1) : this.turnIds
    const snapshot = kept.map((turn, index) => ({ ...turn, turn: index + 1 }))
    if (interim) {
      if (!interimNewTurn) snapshot[snapshot.length - 1]!.text += ` ${interimText}`
      else snapshot.push({ speaker: 'persona', text: interimText, turn: snapshot.length + 1 })
    }
    const sellerTurn = snapshot.length
    const sellerTurnId = interim && interimNewTurn ? this.nextTurnId + 1 : keptIds[keptIds.length - 1]!
    void this.run(snapshot, sellerTurn, sellerTurnId, number, controller, transcriptReceivedMs, versions, interim).catch(() => {
      this.log(transcriptReceivedMs, null, 'error', null, null, interim)
    })
  }

  private supersede(): number {
    this.controller?.abort()
    return ++this.requestNumber
  }

  close(): void {
    this.closed = true
    this.controller?.abort()
  }

  private async run(snapshot: Turn[], sellerTurn: number, sellerTurnId: number, number: number, controller: AbortController,
    transcriptReceivedMs: number, versions: CoachWireVersions, interim: boolean): Promise<void> {
    const start = Date.now()
    const result = await classifyJev(snapshot, sellerTurn, this.options.apiKey, this.options.fetchImpl, controller.signal)
    const jevMs = Date.now() - start
    const top3 = result.kind === 'ok' ? [...result.scores].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([id, score]) => ({ id, score })) : []
    const detail = { interim, top3, turnId: sellerTurnId, words: snapshot.at(-1)?.text.trim().split(/\s+/).length ?? 0 }
    if (this.closed || number !== this.requestNumber) {
      this.log(transcriptReceivedMs, jevMs, 'stale', null, result.httpStatus, interim, detail)
      return
    }
    if (result.kind !== 'ok') {
      this.log(transcriptReceivedMs, jevMs, result.kind, null, result.httpStatus, interim, detail)
      return
    }
    this.publishMotivation(result.scores, sellerTurn, sellerTurnId, versions, transcriptReceivedMs, jevMs, interim)
    const best = questions.filter(({ id }) => id !== 'motivation').reduce<{ id: string; name: string; score: number } | undefined>((winner, question) => {
      const score = result.scores.get(question.id)!
      return !winner || score > winner.score ? { id: question.id, name: question.name, score } : winner
    }, undefined)
    if (!best || best.score < CUTOFF) {
      this.log(transcriptReceivedMs, jevMs, 'below_cutoff', null, result.httpStatus, interim, detail)
      return
    }
    const repeatKey = `${sellerTurnId}:${best.id}`
    if (best.id === 'think' || this.repeated.has(repeatKey)) {
      this.refreshReservation('objection', repeatKey)
      this.log(transcriptReceivedMs, jevMs, 'suppressed', null, result.httpStatus, interim, detail)
      return
    }
    const card = { id: best.id, name: best.name }
    this.publishReserved('objection', repeatKey, sellerTurnId, () => ({
      ...versions, type: 'objection_prompt', objectionId: card.id, label: card.name, sellerTurn,
      classifierModel: questionsFile.model, questionsSha256: QUESTIONS_SHA256, ts: new Date().toISOString(),
    }), (outcome, publishAckMs) => this.log(transcriptReceivedMs, jevMs, outcome, publishAckMs, result.httpStatus, interim, detail), 1)
  }

  /**
   * A duplicate of a card whose publish is still in flight confirms that card is still the current intent,
   * so its reservation counts as the newest of its kind again (see publishReserved's retry rule).
   */
  private refreshReservation(kind: CardKind, repeatKey: string): void {
    const pending = this.inFlight.get(repeatKey)
    if (pending) pending.seq = ++this.cardSeq[kind]
  }

  /**
   * The repeat key is a reservation: it blocks a duplicate while this publish is in flight and after it
   * succeeds. If the publish fails (rejects or throws) the reservation is released and the card is re-sent
   * ONCE, but only when it is still the newest card of its kind attempted and the seller is still on that
   * turn (finals and interims both count). Otherwise the conversation has moved on, or a newer card is on
   * its way, and a late re-send with a fresh timestamp would put a stale card on the rep's screen.
   */
  private publishReserved(kind: CardKind, repeatKey: string, sellerTurnId: number, build: () => CoachWireMessage,
    log: (outcome: 'shown' | 'error' | 'stale', publishAckMs: number | null) => void, attempt: 1 | 2,
    hooks: { onDelivered?: () => void; onReleased?: () => void } = {}): void {
    if (this.closed) return
    this.repeated.add(repeatKey)
    const reservation = { seq: ++this.cardSeq[kind] }
    this.inFlight.set(repeatKey, reservation)
    const settled = (): boolean => {
      if (this.inFlight.get(repeatKey) !== reservation) return false
      this.inFlight.delete(repeatKey)
      return true
    }
    const failed = (): void => {
      if (!settled()) return
      this.repeated.delete(repeatKey)
      log('error', null)
      if (attempt === 1 && !this.closed && sellerTurnId === this.latestSellerTurnSeen && reservation.seq === this.cardSeq[kind]) {
        this.publishReserved(kind, repeatKey, sellerTurnId, build, log, 2, hooks)
        return
      }
      hooks.onReleased?.()
      if (attempt === 1 && !this.closed) log('stale', null)
    }
    let publish: Promise<unknown>
    try {
      publish = this.options.publish(build())
    } catch {
      // Nothing to drain at teardown: the publish never started.
      failed()
      return
    }
    this.options.trackPublish(publish.catch(() => undefined))
    void publish.then(
      () => { if (settled()) { hooks.onDelivered?.(); log('shown', Date.now()) } },
      failed,
    )
  }

  /**
   * Owner-approved motivation card with owner-approved sub-type detection (see OWNER-APPROVALS.md). Owner ruling:
   * the strongest sub-type wins among those firing on the SAME seller statement; a later statement replaces the
   * card. With no sub-type at the cut-off, the general motivation card is sent. Never an objection.
   */
  private publishMotivation(scores: ReadonlyMap<string, number>, sellerTurn: number, sellerTurnId: number, versions: CoachWireVersions,
    transcriptReceivedMs: number, jevMs: number, interim: boolean): void {
    const general = scores.get('motivation') ?? 0
    let subType: string | undefined
    let subScore = 0
    for (const id of MOTIVATION_SUBTYPE_IDS) {
      const score = scores.get(id) ?? 0
      if (score >= CUTOFF && score > subScore) { subScore = score; subType = id.slice('motivation.'.length) }
    }
    if (general < CUTOFF && subType === undefined) return
    const label = questions.find(({ id }) => id === 'motivation')?.name
    if (!label) return
    const logMotivation = (outcome: 'shown' | 'suppressed' | 'error' | 'stale', publishAckMs: number | null) =>
      this.options.logger.info('coach.motivation_prompt.timing', { transcriptReceivedMs, jevMs, outcome, publishAckMs, turnId: sellerTurnId, interim, score: general, subType: subType ?? null, subScore: subType ? subScore : null })
    // Dedupe against the LATEST attempt for this seller statement, not against every card it has ever sent:
    // the latest classification of the statement wins, so a sub-type can come back after another one was
    // sent in between, even while its own older publish is still awaiting an ack.
    const state = this.motivationTurns.get(sellerTurnId) ?? { pendingSubTypes: new Set<string>(), subTypeDelivered: false }
    this.motivationTurns.set(sellerTurnId, state)
    const want = subType ?? GENERAL
    // Within one seller statement a general card never replaces a sub-type card (the strongest sub-type wins).
    // A publish still awaiting its ack counts: the card may already be on the rep's screen before the ack.
    if (want === GENERAL && (state.subTypeDelivered || state.pendingSubTypes.size > 0)) { logMotivation('suppressed', null); return }
    const latest = state.latest
    // A latest attempt that failed never suppresses: re-sending it is harmless, staying silent loses the card.
    // (No reservation refresh needed: the latest attempt of the latest statement is already the newest card.)
    if (latest && latest.want === want && latest.status !== 'failed') { logMotivation('suppressed', null); return }
    const repeatKey = `${sellerTurnId}:motivation:${want}:${++this.motivationOrder}`
    const attempt: MotivationAttempt = { key: repeatKey, want, status: 'pending' }
    state.latest = attempt
    if (want !== GENERAL) state.pendingSubTypes.add(repeatKey)
    this.publishReserved('motivation', repeatKey, sellerTurnId, () => ({
      ...versions, type: 'motivation_prompt', label, ...(subType === undefined ? {} : { subType }), sellerTurn,
      classifierModel: questionsFile.model, questionsSha256: QUESTIONS_SHA256, ts: new Date().toISOString(),
    }), logMotivation, 1, {
      // Only the attempt itself changes status, so a slower, older ack cannot overwrite a newer attempt.
      onDelivered: () => { attempt.status = 'delivered'; if (state.pendingSubTypes.delete(repeatKey)) state.subTypeDelivered = true },
      onReleased: () => { attempt.status = 'failed'; state.pendingSubTypes.delete(repeatKey) },
    })
  }

  private log(transcriptReceivedMs: number, jevMs: number | null,
    outcome: 'shown' | 'below_cutoff' | 'suppressed' | 'stale' | 'timeout' | 'error' | 'capped' | 'unbound',
    publishAckMs: number | null, httpStatus: number | null, interim = false,
    detail: Record<string, unknown> = {}): void {
    this.options.logger.info('coach.objection_prompt.timing', {
      transcriptReceivedMs, jevMs, outcome, publishAckMs, turns: this.turns.length, httpStatus, interim, ...detail,
    })
  }
}

export function createObjectionPromptCall(config: CoachObjectionPromptConfig,
  options: Omit<ObjectionPromptCallOptions, 'apiKey' | 'maxRequests'>): ObjectionPromptCall | undefined {
  if (!config.enabled || !config.apiKey) return undefined
  return new ObjectionPromptCall({ ...options, apiKey: config.apiKey, maxRequests: config.maxRequestsPerCall,
    maxInterimRequests: config.maxInterimRequestsPerCall, turnGapMs: config.turnGapMs, echoDrop: config.echoDrop, interim: config.interim })
}

function isEcho(a: string, b: string): boolean {
  const normalize = (value: string) => value.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, '').replace(/\s+/g, ' ').trim()
  const first = normalize(a)
  const second = normalize(b)
  const shorter = first.length <= second.length ? first : second
  const longer = first.length <= second.length ? second : first
  return shorter.split(' ').length >= 4 && longer.includes(shorter)
}
