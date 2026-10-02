import { createClient, type RealtimeChannel, type SupabaseClient } from '@supabase/supabase-js'
import type { CoachWireMessage } from './approved/wire-contract.js'
import type { CoachPublisher } from './types.js'

const EVENT = 'coach_event'
const OP_TIMEOUT_MS = 5_000

interface CallState {
  closed: boolean
  channel?: RealtimeChannel
  pending?: Promise<RealtimeChannel>
  pendingChannel?: RealtimeChannel
  rejectPending?: (reason?: unknown) => void
}

export class SupabaseCoachPublisher implements CoachPublisher {
  private readonly states = new Map<string, CallState>()

  constructor(private readonly client: SupabaseClient, private readonly operationTimeoutMs = OP_TIMEOUT_MS) {}

  async publish(callId: string, message: CoachWireMessage): Promise<void> {
    const state = this.openState(callId)
    let last: unknown
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        this.assertOpen(callId, state)
        const channel = await this.channelFor(callId, state)
        this.assertOpen(callId, state)
        const status = await withTimeout(channel.send({ type: 'broadcast', event: EVENT, payload: message }), this.operationTimeoutMs)
        this.assertOpen(callId, state)
        if (status !== 'ok') throw new Error('realtime acknowledgement failed')
        return
      } catch (error) {
        last = error
        await this.remove(callId, state)
        if (!this.isOpen(callId, state)) break
      }
    }
    throw last instanceof Error ? last : new Error('realtime publish failed')
  }

  async close(callId: string): Promise<void> {
    const state = this.states.get(callId)
    if (!state) return
    state.closed = true
    await this.remove(callId, state)
  }

  async closeAll(): Promise<void> {
    await Promise.all([...this.states.entries()].map(async ([callId, state]) => {
      state.closed = true
      await this.remove(callId, state)
    }))
  }

  private openState(callId: string): CallState {
    const existing = this.states.get(callId)
    if (existing && !existing.closed) return existing
    const state: CallState = { closed: false }
    this.states.set(callId, state)
    return state
  }

  private isOpen(callId: string, state: CallState): boolean {
    return this.states.get(callId) === state && !state.closed
  }

  private assertOpen(callId: string, state: CallState): void {
    if (!this.isOpen(callId, state)) throw new Error('realtime call closed')
  }

  private async channelFor(callId: string, state: CallState): Promise<RealtimeChannel> {
    this.assertOpen(callId, state)
    if (state.channel) return state.channel
    if (state.pending) return state.pending
    let resolvePending!: (channel: RealtimeChannel) => void
    let rejectPending!: (reason?: unknown) => void
    const subscribing = new Promise<RealtimeChannel>((resolve, reject) => {
      resolvePending = resolve
      rejectPending = reject
    })
    const channel = this.client.channel(`coach:${callId}`, { config: { private: true, broadcast: { ack: true } } })
    state.pending = subscribing
    state.pendingChannel = channel
    state.rejectPending = rejectPending
    channel.subscribe((status, error) => {
      if (status === 'SUBSCRIBED') resolvePending(channel)
      else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') rejectPending(error ?? new Error('realtime subscription failed'))
    })
    try {
      const subscribed = await withTimeout(subscribing, this.operationTimeoutMs)
      this.assertOpen(callId, state)
      if (state.pendingChannel !== channel) throw new Error('realtime channel closed during subscribe')
      state.channel = subscribed
      return subscribed
    } catch (error) {
      await this.remove(callId, state)
      throw error
    } finally {
      if (state.pending === subscribing) state.pending = undefined
      if (state.pendingChannel === channel) state.pendingChannel = undefined
      if (state.rejectPending === rejectPending) state.rejectPending = undefined
    }
  }

  private async remove(callId: string, state: CallState): Promise<void> {
    if (this.states.get(callId) !== state) return
    const channels = [state.channel, state.pendingChannel].filter((channel, index, all): channel is RealtimeChannel => Boolean(channel) && all.indexOf(channel) === index)
    state.channel = undefined
    state.pendingChannel = undefined
    state.pending = undefined
    state.rejectPending?.(new Error('realtime channel closed'))
    state.rejectPending = undefined
    await Promise.all(channels.map((channel) => withTimeout(this.client.removeChannel(channel), this.operationTimeoutMs).catch(() => undefined)))
    if (state.closed && this.states.get(callId) === state) this.states.delete(callId)
  }
}

export function createSupabaseCoachClient(env: NodeJS.ProcessEnv = process.env): SupabaseClient {
  const url = (env.SANDRA_COACH_SUPABASE_URL ?? env.NEXT_PUBLIC_SUPABASE_URL)?.trim()
  const key = (env.SANDRA_COACH_SUPABASE_SERVICE_ROLE_KEY ?? env.SUPABASE_SERVICE_ROLE_KEY)?.trim()
  if (!url || !key) throw new Error('Supabase coach publisher credentials are missing')
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } })
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([promise, new Promise<T>((_, reject) => { timer = setTimeout(() => reject(new Error('bounded operation timeout')), timeoutMs) })])
  } finally { if (timer) clearTimeout(timer) }
}
