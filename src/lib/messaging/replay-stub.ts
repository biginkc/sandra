import { ConfigurationError, ProviderError } from "@/lib/errors/classes";

/**
 * Messages v2 production-replay safety switch (docs/messages-v2-replay.md).
 *
 * SMS_PROVIDER_STUB=1 makes every real seller-SMS provider client refuse the
 * network: the real `sendSms` / catalog methods throw {@link ReplayStubError}
 * BEFORE any fetch, the registry hands out a recording stub instead of a real
 * Sendillo client, and Twilio/Dialpad cannot be selected at all. Exactly "1"
 * turns it on; anything else (including unset) is the normal production path.
 */
/** Thrown (never swallowed) when SMS_PROVIDER_STUB=1 is set in an environment that could be real. */
export class ReplayStubConfigurationError extends ConfigurationError {}

function isLoopbackHost(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]" || hostname === "::1";
}

/**
 * Fail closed: the flag is only honoured on a local replay stack. Hosted
 * Vercel, NODE_ENV=production, or a non-loopback Supabase URL (unless its ref is
 * explicitly allowed via REPLAY_ALLOW_PROJECT_REF) makes this THROW.
 */
export function isReplayStubEnabled(): boolean {
  if (process.env.SMS_PROVIDER_STUB !== "1") return false;
  const refuse = (why: string): never => {
    throw new ReplayStubConfigurationError(`SMS_PROVIDER_STUB=1 refused: ${why}`);
  };
  if (process.env.VERCEL_ENV !== undefined) refuse("VERCEL_ENV is set");
  if (process.env.NODE_ENV === "production") refuse("NODE_ENV is production");
  let host: string;
  try {
    host = new URL(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "").hostname;
  } catch {
    return refuse("NEXT_PUBLIC_SUPABASE_URL is missing or invalid");
  }
  if (!isLoopbackHost(host)) {
    const allowed = process.env.REPLAY_ALLOW_PROJECT_REF?.trim();
    if (!allowed || host !== `${allowed}.supabase.co`) {
      refuse("Supabase host is not loopback and not the explicitly allowed project ref");
    }
  }
  return true;
}

export class ReplayStubError extends ProviderError {
  constructor(provider: string, operation: string) {
    super(
      `SMS_PROVIDER_STUB=1: refusing ${operation} on the real ${provider} client`,
      provider,
      { notSent: true, definitiveRejection: true, replayStub: true },
    );
    this.name = "ReplayStubError";
  }
}

/** Call first in every method that would reach a real SMS provider over the network. */
export function assertRealProviderAllowed(provider: string, operation: string): void {
  if (isReplayStubEnabled()) throw new ReplayStubError(provider, operation);
}

export type ReplayOutboundRow = {
  provider: string;
  from: string | null;
  to: string;
  body: string;
  externalId: string;
  batchId: string | null;
};

type Recorder = (row: ReplayOutboundRow) => Promise<void>;
let recorderOverride: Recorder | null = null;

/** Test seam. */
export function setReplayOutboundRecorder(recorder: Recorder | null): void {
  recorderOverride = recorder;
}

async function defaultRecorder(row: ReplayOutboundRow): Promise<void> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("replay_outbound_log: Supabase env missing");
  const { createClient } = await import("@supabase/supabase-js");
  const { error } = await createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  })
    .from("replay_outbound_log" as never)
    .insert({
      batch_id: row.batchId,
      provider: row.provider,
      from_address: row.from,
      to_address: row.to,
      body: row.body,
      external_id: row.externalId,
    } as never);
  if (error) throw new Error(`replay_outbound_log insert failed: ${error.message}`);
}

/** Record what the pipeline WOULD have sent. Throws if the log write fails: no log, no "accepted". Never sends. */
export async function recordReplayOutbound(row: ReplayOutboundRow): Promise<void> {
  try {
    await (recorderOverride ?? defaultRecorder)(row);
  } catch (error) {
    const { reportError } = await import("@/lib/errors/report");
    reportError(error, { tags: { surface: "replay_outbound_log" } });
    throw new ProviderError(
      "replay stub could not record the outbound message; not reporting it as sent",
      "sendillo",
      { notSent: true, definitiveRejection: true, replayStub: true },
    );
  }
}

export type ReplayHandshake = {
  replayStub: true;
  sendilloApiKeyPresent: boolean;
  llmAutosend: string | null;
  supabaseHost: string | null;
};

/** What the server proves to the replay runner about itself; null when the stub is off. */
export function getReplayHandshake(): ReplayHandshake | null {
  if (!isReplayStubEnabled()) return null;
  let supabaseHost: string | null = null;
  try {
    supabaseHost = new URL(process.env.NEXT_PUBLIC_SUPABASE_URL ?? "").host || null;
  } catch {
    supabaseHost = null;
  }
  return {
    replayStub: true,
    sendilloApiKeyPresent: (process.env.SENDILLO_API_KEY ?? "").trim() !== "",
    llmAutosend: process.env.AI_RESPONDER_LLM_AUTOSEND ?? null,
    supabaseHost,
  };
}
