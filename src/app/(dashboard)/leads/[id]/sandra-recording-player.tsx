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
};

type SignedRecording = {
  signedUrl: string;
  expiresAt: string;
};

export type SandraRecordingPlayerProps = {
  callActivityId: string;
  durationSeconds?: number;
};

export function SandraRecordingPlayer({ callActivityId, durationSeconds }: SandraRecordingPlayerProps) {
  const [state, setState] = useState<PlayerState>({ status: "idle" });
  const requestIdRef = useRef(0);
  const requestAbortRef = useRef<AbortController | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const pendingRenewalRef = useRef<SignedRecording | null>(null);

  const loadRecording = useCallback(async (background = false) => {
    requestAbortRef.current?.abort();
    const controller = new AbortController();
    requestAbortRef.current = controller;
    const requestId = ++requestIdRef.current;
    if (!background) {
      pendingRenewalRef.current = null;
      setState({ status: "loading" });
    }
    try {
      const renewed = await requestSignedRecording(callActivityId, controller.signal);
      if (requestId === requestIdRef.current) {
        const audio = audioRef.current;
        if (background && isActivePlayback(audio)) {
          pendingRenewalRef.current = renewed;
        } else {
          pendingRenewalRef.current = null;
          setState({ status: "ready", ...renewed });
        }
      }
    } catch (error) {
      if (isAbortError(error)) return;
      if (requestId === requestIdRef.current) {
        if (background && isActivePlayback(audioRef.current)) return;
        setState({
          status: "error",
          message: error instanceof Error ? error.message : "Unable to load recording",
        });
      }
    } finally {
      if (requestAbortRef.current === controller) requestAbortRef.current = null;
    }
  }, [callActivityId]);

  const applyPendingRenewal = useCallback(() => {
    const renewed = pendingRenewalRef.current;
    if (!renewed) return;
    pendingRenewalRef.current = null;
    if (Date.parse(renewed.expiresAt) - Date.now() < 2_000) {
      void loadRecording(true);
      return;
    }
    setState({ status: "ready", ...renewed });
  }, [loadRecording]);

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
    const timer = window.setTimeout(() => void loadRecording(true), refreshDelay);
    return () => window.clearTimeout(timer);
  }, [loadRecording, state]);

  if (state.status === "ready") {
    return (
      <div>
        <audio
          aria-label="Call recording"
          controls
          data-testid="sandra-recording-audio"
          onEnded={applyPendingRenewal}
          onError={() =>
            setState({
              status: "error",
              message: "Recording could not be played. Reload to request a fresh link.",
            })
          }
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
        <p className="text-destructive text-xs" role="alert">{state.message}</p>
        <Button onClick={() => void loadRecording()} size="sm" type="button" variant="outline">
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
): Promise<SignedRecording> {
  const response = await fetch(
    `/api/leads/calls/${encodeURIComponent(callActivityId)}/recording-url`,
    { cache: "no-store", signal },
  );
  const body = await safeJson(response);
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

function isActivePlayback(audio: HTMLAudioElement | null): boolean {
  return Boolean(audio && !audio.paused && !audio.ended);
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}
