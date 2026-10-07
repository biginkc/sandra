import { ProviderError } from "@/lib/errors/classes";

/**
 * Messages v2 production-replay safety switch (docs/messages-v2-replay.md).
 *
 * SMS_PROVIDER_STUB=1 makes every real seller-SMS provider client refuse the
 * network: the real `sendSms` / catalog methods throw {@link ReplayStubError}
 * BEFORE any fetch, the registry hands out a recording stub instead of a real
 * Sendillo client, and Twilio/Dialpad cannot be selected at all. Exactly "1"
 * turns it on; anything else (including unset) is the normal production path.
 */
export function isReplayStubEnabled(): boolean {
  return process.env.SMS_PROVIDER_STUB === "1";
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

/** Record what the pipeline WOULD have sent. Never throws; never sends. */
export async function recordReplayOutbound(row: ReplayOutboundRow): Promise<void> {
  try {
    await (recorderOverride ?? defaultRecorder)(row);
  } catch (error) {
    const { reportError } = await import("@/lib/errors/report");
    reportError(error, { tags: { surface: "replay_outbound_log" } });
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
