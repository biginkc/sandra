export interface OrderedMedia {
  readonly chunk: number
  readonly track: 'inbound' | 'outbound'
  readonly payload: Buffer
  readonly receivedAtMs: number
}

export class MediaIntegrityError extends Error {}

interface Pending {
  readonly media: OrderedMedia
  readonly queuedAtMs: number
}

export interface MediaOrderOptions {
  readonly maxPending?: number
  readonly maxGapMs?: number
}

/** Telnyx chunks are global across tracks; reorder before routing to preserve both-track chronology. */
export class MediaOrderBuffer {
  private expected: number | undefined
  private readonly pending = new Map<number, Pending>()
  private readonly maxPending: number
  private readonly maxGapMs: number

  constructor(private readonly emit: (media: OrderedMedia) => void, options: MediaOrderOptions = {}) {
    this.maxPending = options.maxPending ?? 64
    this.maxGapMs = options.maxGapMs ?? 250
  }

  push(media: OrderedMedia, nowMs = media.receivedAtMs): void {
    if (!Number.isSafeInteger(media.chunk) || media.chunk < 1) throw new MediaIntegrityError('invalid media chunk')
    // Telnyx starts media.chunk at 1 for a stream. Holding an initial 2 (rather
    // than treating it as the first chunk) lets us detect a lost opening frame.
    if (this.expected === undefined) this.expected = 1
    if (media.chunk < this.expected) return // duplicate/replay already delivered
    if (this.pending.has(media.chunk)) return
    this.pending.set(media.chunk, { media, queuedAtMs: nowMs })
    this.flush(nowMs)
    const first = this.pending.values().next().value as Pending | undefined
    if (this.pending.size > this.maxPending || (first && nowMs - first.queuedAtMs > this.maxGapMs)) {
      throw new MediaIntegrityError('media chunk gap or reorder overflow')
    }
  }

  finish(): void {
    if (this.pending.size) throw new MediaIntegrityError('media stream ended with a chunk gap')
  }

  private flush(nowMs: number): void {
    while (this.expected !== undefined) {
      const pending = this.pending.get(this.expected)
      if (!pending) return
      this.pending.delete(this.expected)
      this.emit(pending.media)
      this.expected += 1
      void nowMs
    }
  }
}
