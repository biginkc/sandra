/** Provider data only: authentication, attribution and persistence belong upstream.
 * URLs remain untrusted and must pass the recording downloader's own checks.
 */
export interface DialpadRecordingSegment {
  id: string;
  url: string | null;
  recordingType: string | null;
  durationMs: number | null;
  startTimeMs: number | null;
}

export interface DialpadCallEvent {
  callId: string;
  targetId: string | null;
  targetType: string | null;
  direction: "inbound" | "outbound" | null;
  state: string;
  terminal: boolean;
  eventTimestampMs: number;
  startedAtMs: number | null;
  connectedAtMs: number | null;
  endedAtMs: number | null;
  durationMs: number | null;
  totalDurationMs: number | null;
  /** Only a syntactically valid UUID, never trusted lead/rep attribution. */
  intentId: string | null;
  recordings: DialpadRecordingSegment[];
}

export class InvalidDialpadCallEvent extends Error {
  constructor() { super("Invalid Dialpad call event"); }
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new InvalidDialpadCallEvent();
  return value as Record<string, unknown>;
}

function identifier(value: unknown): string {
  if (typeof value === "string" && /^[1-9]\d*$/.test(value)) return value;
  if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) return String(value);
  throw new InvalidDialpadCallEvent();
}

function numeric(value: unknown, integer: boolean): number | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "number" && (typeof value !== "string" || !/^\d+(?:\.\d+)?$/.test(value))) throw new InvalidDialpadCallEvent();
  const result = Number(value);
  if (!Number.isFinite(result) || result < 0 || result > Number.MAX_SAFE_INTEGER || (integer && !Number.isSafeInteger(result))) throw new InvalidDialpadCallEvent();
  return result;
}

function text(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") throw new InvalidDialpadCallEvent();
  return value;
}

/** Does not merge events. The persistence worker must order by event timestamp,
 * preserve terminal state during late recording/transcript enrichment, and dedupe.
 * Missing data stays null; connected never implies a human was reached.
 */
export function normalizeDialpadCallEvent(payload: unknown): DialpadCallEvent {
  const raw = object(payload);
  const callId = identifier(raw.call_id);
  const state = text(raw.state);
  const eventTimestampMs = numeric(raw.event_timestamp, true);
  if (!state || eventTimestampMs === null) throw new InvalidDialpadCallEvent();
  const target = raw.target == null ? {} : object(raw.target);
  const direction = text(raw.direction);
  if (direction !== null && direction !== "inbound" && direction !== "outbound") throw new InvalidDialpadCallEvent();
  const customData = text(raw.custom_data);
  const intentId = customData && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(customData) ? customData.toLowerCase() : null;
  const details = raw.recording_details ?? [];
  if (!Array.isArray(details)) throw new InvalidDialpadCallEvent();
  const recordings = details.map((entry): DialpadRecordingSegment => {
    const segment = object(entry);
    // Recording entity IDs may be opaque strings, unlike numeric call IDs.
    const recordingId = typeof segment.id === "string" ? segment.id : identifier(segment.id);
    if (!recordingId.trim()) throw new InvalidDialpadCallEvent();
    return { id: recordingId, url: text(segment.url), recordingType: text(segment.recording_type), durationMs: numeric(segment.duration, false), startTimeMs: numeric(segment.start_time, true) };
  });
  return {
    callId, targetId: target.id == null ? null : identifier(target.id), targetType: text(target.type), direction,
    state, terminal: state === "hangup" || state === "missed",
    eventTimestampMs, startedAtMs: numeric(raw.date_started, true), connectedAtMs: numeric(raw.date_connected, true), endedAtMs: numeric(raw.date_ended, true),
    durationMs: numeric(raw.duration, false), totalDurationMs: numeric(raw.total_duration, false), intentId, recordings,
  };
}
