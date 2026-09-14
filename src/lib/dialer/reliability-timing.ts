/**
 * Startup timing markers for an explicitly scoped reliability call.
 *
 * A marker carries both clocks so a run can compare browser-local events while
 * keeping epoch timestamps for correlation with provider/webhook evidence.
 * `clockUncertaintyMs` describes the local monotonic/epoch sampling window;
 * it is not a claim that the browser clock is synchronized with a provider.
 */
export type ReliabilityTimingStage =
  | "ui_click"
  | "ui_handler"
  | "preparation_started"
  | "preparation_completed"
  | "microphone_preparation_started"
  | "microphone_preparation_completed"
  | "backend_accepted"
  | "rtc_registration_started"
  | "rtc_registered"
  | "operator_ringing"
  | "operator_live"
  | "playback_start"
  | "playback_ready";

export type ReliabilityTimingDetail = Readonly<
  Record<string, string | number | boolean | null>
>;

export type ReliabilityTimingMarker = {
  readonly sequence: number;
  readonly stage: ReliabilityTimingStage;
  readonly atMonotonicMs: number;
  readonly atEpochMs: number;
  readonly clockUncertaintyMs: number;
  readonly detail?: ReliabilityTimingDetail;
};

export type ReliabilityTimingClock = {
  readonly monotonicNow: () => number;
  readonly epochNow: () => number;
};

export type ReliabilityTimingSink = {
  writeTiming(marker: ReliabilityTimingMarker): Promise<void>;
};

function defaultClock(): ReliabilityTimingClock {
  return {
    monotonicNow: () => performance.now(),
    epochNow: () => Date.now(),
  };
}

/** Read both clocks as one sample and expose the sampling window as uncertainty. */
export function readReliabilityClock(
  clock: ReliabilityTimingClock = defaultClock(),
): Pick<ReliabilityTimingMarker, "atMonotonicMs" | "atEpochMs" | "clockUncertaintyMs"> {
  const before = clock.monotonicNow();
  const epoch = clock.epochNow();
  const after = clock.monotonicNow();
  const uncertainty = Math.max(1, (after - before) / 2);
  return {
    atMonotonicMs: (before + after) / 2,
    atEpochMs: epoch,
    clockUncertaintyMs: uncertainty,
  };
}

export type ReliabilityTimingSession = {
  mark(stage: ReliabilityTimingStage, detail?: ReliabilityTimingDetail): ReliabilityTimingMarker;
  bind(runId: string, callId: string): void;
  attach(sink: ReliabilityTimingSink): Promise<void>;
  detach(): void;
  setWriteErrorHandler(handler: (error: unknown) => void): void;
  markers(): readonly ReliabilityTimingMarker[];
};

/**
 * Buffers markers until the exact call id exists, then streams them to the
 * exact-call capture store. This keeps the click and preparation markers while
 * refusing to persist them for a mismatched or ordinary call.
 */
export function createReliabilityTimingSession(
  clock: ReliabilityTimingClock = defaultClock(),
): ReliabilityTimingSession {
  const values: ReliabilityTimingMarker[] = [];
  let bound = false;
  let sink: ReliabilityTimingSink | null = null;
  let flushed = 0;
  let writeChain = Promise.resolve();
  let onWriteError: ((error: unknown) => void) | null = null;

  const flush = (): void => {
    if (!bound || !sink || flushed >= values.length) return;
    const pending = values.slice(flushed);
    flushed = values.length;
    for (const marker of pending) {
      const currentSink = sink;
      writeChain = writeChain.then(() => currentSink.writeTiming(marker)).catch((error) => {
        onWriteError?.(error);
      });
    }
  };

  return {
    mark(stage, detail) {
      const marker = {
        sequence: values.length + 1,
        stage,
        ...readReliabilityClock(clock),
        ...(detail ? { detail } : {}),
      } satisfies ReliabilityTimingMarker;
      values.push(marker);
      flush();
      return marker;
    },
    bind(runId, callId) {
      bound = runId.trim().length > 0 && callId.trim().length > 0;
      flush();
    },
    async attach(nextSink) {
      sink = nextSink;
      flush();
      await writeChain;
    },
    detach() {
      sink = null;
    },
    setWriteErrorHandler(handler) {
      onWriteError = handler;
    },
    markers() {
      return values;
    },
  };
}

let pendingSession: ReliabilityTimingSession | null = null;

export function publishPendingReliabilityTiming(session: ReliabilityTimingSession): void {
  pendingSession = session;
}

export function takePendingReliabilityTiming(): ReliabilityTimingSession | null {
  const session = pendingSession;
  pendingSession = null;
  return session;
}
