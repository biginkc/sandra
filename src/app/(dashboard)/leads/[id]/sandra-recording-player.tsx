"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { Button } from "@/components/ui/button";

type PlayerState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "ready"; signedUrl: string; expiresAt: string }
  | { status: "error"; message: string };

type RecordingUrlResponse = {
  signedUrl?: unknown;
  expiresAt?: unknown;
  error?: unknown;
  recordingSegments?: unknown;
};

type SignedRecording = {
  signedUrl: string;
  expiresAt: string;
};

type SourceResume = {
  positionSeconds: number;
  shouldPlay: boolean;
};

type LoadMode = "foreground" | "background" | "media-recovery";

const SIGNED_URL_REQUEST_TIMEOUT_MS = 10_000;

export type SandraRecordingPlayerProps = {
  callActivityId: string;
  durationSeconds?: number;
};

type RecordingSegment = { artifactId: string; durationSeconds: number | null };
class MultipleRecordingSegments extends Error {
  constructor(readonly segments: RecordingSegment[]) { super("Choose a recording segment"); }
}

export function SandraRecordingPlayer(props: SandraRecordingPlayerProps) {
  return <SegmentedRecordingPlayer key={props.callActivityId} {...props} />;
}

function SegmentedRecordingPlayer(props: SandraRecordingPlayerProps) {
  const [segments, setSegments] = useState<RecordingSegment[]>([]);
  const [selected, setSelected] = useState("");
  const selectedSegment = segments.find(segment => segment.artifactId === selected);
  return <div className="space-y-2">
    {segments.length > 0 && <label className="block text-sm">
      Recording segment
      <select aria-label="Recording segment" value={selected} onChange={event => setSelected(event.target.value)} className="ml-2 rounded border p-1">
        <option value="">Choose a segment</option>
        {segments.map((segment, index) => <option key={segment.artifactId} value={segment.artifactId}>
          Segment {index + 1}{segment.durationSeconds === null ? "" : ` (${segment.durationSeconds}s)`}
        </option>)}
      </select>
    </label>}
    {(segments.length === 0 || selected) && <SingleRecordingPlayer key={selected || "initial"} {...props}
      artifactId={selected || undefined} durationSeconds={selectedSegment ? selectedSegment.durationSeconds ?? undefined : props.durationSeconds}
      onSegments={setSegments} />}
  </div>;
}

function SingleRecordingPlayer({
  callActivityId,
  durationSeconds,
  artifactId,
  onSegments,
}: SandraRecordingPlayerProps & { artifactId?: string; onSegments: (segments: RecordingSegment[]) => void }) {
  const [state, setState] = useState<PlayerState>({ status: "idle" });
  const requestIdRef = useRef(0);
  const requestAbortRef = useRef<AbortController | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const pendingRenewalRef = useRef<SignedRecording | null>(null);
  const hasStartedPlaybackRef = useRef(false);
  const playbackIntentRef = useRef(false);
  const sourceResumeRef = useRef<SourceResume | null>(null);

  const loadRecording = useCallback(
    async (mode: LoadMode = "foreground", resume?: SourceResume) => {
      requestAbortRef.current?.abort();
      const controller = new AbortController();
      requestAbortRef.current = controller;
      const requestId = ++requestIdRef.current;
      let timedOut = false;
      const timeout = window.setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, SIGNED_URL_REQUEST_TIMEOUT_MS);
      if (mode === "foreground") {
        pendingRenewalRef.current = null;
        sourceResumeRef.current = null;
        hasStartedPlaybackRef.current = false;
        playbackIntentRef.current = false;
        setState({ status: "loading" });
      } else if (mode === "media-recovery") {
        sourceResumeRef.current = resume ?? null;
      }
      try {
        const renewed = await requestSignedRecording(
          callActivityId,
          controller.signal,
          artifactId,
        );
        if (requestId === requestIdRef.current) {
          const audio = audioRef.current;
          if (
            shouldPreserveCurrentSource(
              mode,
              audio,
              hasStartedPlaybackRef.current,
            )
          ) {
            pendingRenewalRef.current = renewed;
          } else {
            pendingRenewalRef.current = null;
            setState({ status: "ready", ...renewed });
          }
        }
      } catch (error) {
        if (requestId === requestIdRef.current && error instanceof MultipleRecordingSegments) {
          onSegments(error.segments);
          return;
        }
        if (isAbortError(error) && !timedOut) return;
        if (requestId === requestIdRef.current) {
          if (
            shouldPreserveCurrentSource(
              mode,
              audioRef.current,
              hasStartedPlaybackRef.current,
            )
          ) {
            return;
          }
          sourceResumeRef.current = null;
          setState({
            status: "error",
            message: recordingRequestErrorMessage(error, timedOut),
          });
        }
      } finally {
        window.clearTimeout(timeout);
        if (requestAbortRef.current === controller)
          requestAbortRef.current = null;
      }
    },
    [callActivityId, artifactId, onSegments],
  );

  const applyPendingRenewal = useCallback(() => {
    const renewed = pendingRenewalRef.current;
    if (!renewed) return;
    pendingRenewalRef.current = null;
    if (Date.parse(renewed.expiresAt) - Date.now() < 2_000) {
      void loadRecording("background");
      return;
    }
    setState({ status: "ready", ...renewed });
  }, [loadRecording]);

  const recoverMediaError = useCallback(() => {
    const renewed = pendingRenewalRef.current;
    pendingRenewalRef.current = null;
    const audio = audioRef.current;
    if (
      renewed &&
      Date.parse(renewed.expiresAt) - Date.now() >= 2_000 &&
      audio
    ) {
      sourceResumeRef.current = {
        positionSeconds: audio.currentTime,
        shouldPlay: playbackIntentRef.current,
      };
      setState({ status: "ready", ...renewed });
      return;
    }

    if (renewed && audio && hasStartedPlaybackRef.current) {
      const resume = {
        positionSeconds: audio.currentTime,
        shouldPlay: playbackIntentRef.current,
      };
      pendingRenewalRef.current = null;
      void loadRecording("media-recovery", resume);
      return;
    }

    requestIdRef.current += 1;
    requestAbortRef.current?.abort();
    requestAbortRef.current = null;
    sourceResumeRef.current = null;
    setState({
      status: "error",
      message: "Recording could not be played. Reload to request a fresh link.",
    });
  }, [loadRecording]);

  const restoreSourcePosition = useCallback(() => {
    const resume = sourceResumeRef.current;
    const audio = audioRef.current;
    if (!resume || !audio) return;
    sourceResumeRef.current = null;
    try {
      audio.currentTime = resume.positionSeconds;
    } catch {
      // Browsers can reject seeking before duration metadata is available.
    }
    if (resume.shouldPlay) void audio.play().catch(() => undefined);
  }, []);

  useEffect(
    () => () => {
      requestIdRef.current += 1;
      requestAbortRef.current?.abort();
      requestAbortRef.current = null;
    },
    [],
  );

  useEffect(() => {
    if (state.status !== "ready") return;
    const refreshDelay = Math.min(
      Math.max(Date.parse(state.expiresAt) - Date.now() - 1_000, 0),
      2_147_483_647,
    );
    const timer = window.setTimeout(
      () => void loadRecording("background"),
      refreshDelay,
    );
    return () => window.clearTimeout(timer);
  }, [loadRecording, state]);

  if (state.status === "ready") {
    return (
      <div>
        <audio
          aria-label="Call recording"
          controls
          data-testid="sandra-recording-audio"
          onEnded={() => {
            hasStartedPlaybackRef.current = false;
            playbackIntentRef.current = false;
            applyPendingRenewal();
          }}
          onError={recoverMediaError}
          onLoadedMetadata={restoreSourcePosition}
          onPause={() => {
            if (!sourceResumeRef.current) playbackIntentRef.current = false;
          }}
          onPlay={() => {
            hasStartedPlaybackRef.current = true;
            playbackIntentRef.current = true;
          }}
          preload="metadata"
          ref={audioRef}
          src={state.signedUrl}
          className="w-full max-w-full"
        />
        <p className="text-muted-foreground mt-1 text-xs">
          Link expires {new Date(state.expiresAt).toLocaleTimeString()}
        </p>
      </div>
    );
  }

  if (state.status === "error") {
    return (
      <div className="space-y-2">
        <p className="text-destructive text-xs" role="alert">
          {state.message}
        </p>
        <Button
          onClick={() => void loadRecording()}
          size="sm"
          type="button"
          variant="outline"
        >
          Reload recording
        </Button>
      </div>
    );
  }

  return (
    <Button
      disabled={state.status === "loading"}
      onClick={() => void loadRecording()}
      size="sm"
      type="button"
      variant="outline"
    >
      {state.status === "loading"
        ? "Loading recording…"
        : durationSeconds === undefined
          ? "Load recording"
          : `Load recording (${durationSeconds}s)`}
    </Button>
  );
}

async function safeJson(response: Response): Promise<RecordingUrlResponse> {
  try {
    return (await response.json()) as RecordingUrlResponse;
  } catch {
    return {};
  }
}

async function requestSignedRecording(
  callActivityId: string,
  signal: AbortSignal,
  artifactId?: string,
): Promise<SignedRecording> {
  const response = await fetch(
    `/api/leads/calls/${encodeURIComponent(callActivityId)}/recording-url${artifactId ? `?artifactId=${encodeURIComponent(artifactId)}` : ""}`,
    { cache: "no-store", signal },
  );
  const body = await safeJson(response);
  if (response.status === 409 && body.error === "recording_multiple_segments" && Array.isArray(body.recordingSegments)) {
    const segments: RecordingSegment[] = [];
    for (const entry of body.recordingSegments) {
      if (!entry || typeof entry !== "object" || typeof entry.artifactId !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(entry.artifactId)
        || (entry.durationSeconds != null && (typeof entry.durationSeconds !== "number" || !Number.isFinite(entry.durationSeconds) || entry.durationSeconds < 0))) {
        throw new Error("Invalid recording segment list");
      }
      segments.push({ artifactId: entry.artifactId, durationSeconds: entry.durationSeconds ?? null });
    }
    if (segments.length < 2 || new Set(segments.map(segment => segment.artifactId)).size !== segments.length) throw new Error("Invalid recording segment list");
    throw new MultipleRecordingSegments(segments);
  }
  if (
    !response.ok ||
    typeof body.signedUrl !== "string" ||
    !body.signedUrl ||
    typeof body.expiresAt !== "string" ||
    !body.expiresAt
  ) {
    throw new Error(
      typeof body.error === "string" ? body.error : "Unable to load recording",
    );
  }
  const expiresAtMs = Date.parse(body.expiresAt);
  if (!Number.isFinite(expiresAtMs) || expiresAtMs - Date.now() < 2_000) {
    throw new Error("Recording link expired before it could be loaded");
  }
  return { signedUrl: body.signedUrl, expiresAt: body.expiresAt };
}

function isActiveMediaSession(
  audio: HTMLAudioElement | null,
  hasStartedPlayback: boolean,
): boolean {
  return Boolean(audio && hasStartedPlayback && !audio.ended);
}

function shouldPreserveCurrentSource(
  mode: LoadMode,
  audio: HTMLAudioElement | null,
  hasStartedPlayback: boolean,
): boolean {
  return (
    mode === "background" && isActiveMediaSession(audio, hasStartedPlayback)
  );
}

function recordingRequestErrorMessage(
  error: unknown,
  timedOut: boolean,
): string {
  if (timedOut) return "Recording link request timed out";
  return error instanceof Error ? error.message : "Unable to load recording";
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}
