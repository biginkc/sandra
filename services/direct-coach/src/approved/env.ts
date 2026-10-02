/** Extracted fixed coach settings. Runtime env/config is intentionally not
 * imported from Jitter; the reviewed bridge only needs these immutable values. */
export interface CoachDeepgramOptions {
  readonly endpointingMs: number
  readonly smartFormat: boolean
  readonly noDelay: boolean
  readonly finalizeSilenceMs: number | undefined
}

export interface CoachObjectionPromptConfig {
  readonly enabled: boolean
  readonly apiKey: string | undefined
  readonly maxRequestsPerCall: number
  readonly turnGapMs: number | undefined
  readonly echoDrop: boolean
  readonly interim: boolean
  readonly maxInterimRequestsPerCall: number
}

export const COACH_DEEPGRAM_OPTIONS: CoachDeepgramOptions = Object.freeze({
  endpointingMs: 10,
  smartFormat: true,
  noDelay: true,
  finalizeSilenceMs: undefined,
})

export function readCoachDeepgramOptions(): CoachDeepgramOptions {
  return COACH_DEEPGRAM_OPTIONS
}
