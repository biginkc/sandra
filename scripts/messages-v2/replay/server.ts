#!/usr/bin/env tsx
/**
 * npm run replay:server -- [--batch <id>] [--port 3101] [--supabase-url ...] [--allow-project-ref ...]
 *
 * Starts `next dev` for the replay with a SANITISED environment: the SMS stub on,
 * every seller-SMS / call vendor credential blanked, LLM autosend off, and the
 * Supabase endpoints pinned to the local stack (never whatever .env.local says).
 * Jev (TypeSafe) and Claude keys are left alone: they run for real.
 */
import { spawn } from "node:child_process";
import { parseArgs } from "node:util";

import { DEFAULT_REPLAY_WEBHOOK_SECRET, assertBatchId, fail } from "./cli";
import { applyStubEnv, type EnvLike, assertLocalBaseUrl, assertSafeSupabaseUrl, readProdRefs } from "./safety";

// Public Supabase CLI demo keys (same defaults as vitest.local-integration.config.ts).
const DEMO_ANON = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0";
const DEMO_SERVICE = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU";

export const BLANKED_ENV = [
  "SENDILLO_API_KEY", "SENDILLO_CAPTURE_ENABLED", "SENDILLO_CAPTURE_SECRET", "REP_SMS_FROM_NUMBER",
  "TWILIO_ACCOUNT_SID", "TWILIO_AUTH_TOKEN", "TWILIO_FROM_NUMBER", "TWILIO_MESSAGING_SERVICE_SID",
  "DIALPAD_API_KEY", "DIALPAD_FROM_NUMBER", "DIALPAD_WEBHOOK_SECRET", "BLAND_API_KEY",
  "JITTER_SANDRA_PLAYBACK_TOKEN", "JITTER_SOFTPHONE_SERVICE_TOKEN", "JITTER_API_BASE_URL", "JITTER_SOFTPHONE_BASE_URL",
  // Other outbound-capable / paid vendor credentials (audit: process.env.*_KEY/_TOKEN/_SECRET in src/lib + src/app).
  // Left alone on purpose: ANTHROPIC_API_KEY, TYPESAFE_API_KEY (Jev), local Supabase keys.
  "TELNYX_API_KEY", "TRACERFY_API_KEY", "SMARTY_AUTH_ID", "SMARTY_AUTH_TOKEN",
  "NORMA_BLAND_WEBHOOK_SECRET", "NORMA_BLAND_INBOUND_WEBHOOK_SECRET", "SENDILLO_CONNECTION_ID", "SENDILLO_ORG_ID",
  "SENDILLO_PROVIDER_ACCOUNT_ID", "DIALPAD_API_BASE_URL",
  "DROPBOX_SIGN_CLIENT_ID", "DROPBOX_SIGN_CALLBACK_SECRET_KEY", "DROPBOX_SIGN_API_BASE_URL",
  "SLACK_CLIENT_ID", "SLACK_CLIENT_SECRET", "SLACK_SIGNING_SECRET",
  "GOOGLE_OAUTH_CLIENT_ID", "GOOGLE_OAUTH_CLIENT_SECRET", "GOOGLE_MAPS_STATIC_KEY", "GOOGLE_STREET_VIEW_METADATA_KEY",
  "OP_SERVICE_ACCOUNT_TOKEN",
] as const;

export function buildServerEnv(base: EnvLike, o: { supabaseUrl: string; batchId: string | null; port: number; fromNumber: string }): EnvLike {
  const env: EnvLike = { ...base };
  for (const name of BLANKED_ENV) env[name] = "";
  applyStubEnv(env);
  Object.assign(env, {
    MESSAGING_PROVIDER: "sendillo",
    SENDILLO_WEBHOOK_SECRET: base.SENDILLO_WEBHOOK_SECRET || DEFAULT_REPLAY_WEBHOOK_SECRET,
    SENDILLO_FROM_NUMBER: o.fromNumber,
    PIPELINE_RUNS_ENABLED: "1",
    NEXT_PUBLIC_SUPABASE_URL: o.supabaseUrl,
    NEXT_PUBLIC_SUPABASE_ANON_KEY: base.LOCAL_SUPABASE_ANON_KEY || DEMO_ANON,
    SUPABASE_SERVICE_ROLE_KEY: base.LOCAL_SUPABASE_SERVICE_ROLE_KEY || DEMO_SERVICE,
    PORT: String(o.port),
  });
  if (o.batchId) env.REPLAY_BATCH_ID = o.batchId;
  return env;
}

async function main() {
  const { values } = parseArgs({
    options: {
      batch: { type: "string" },
      port: { type: "string", default: "3101" },
      "supabase-url": { type: "string" },
      "allow-project-ref": { type: "string" },
      "from-number": { type: "string", default: "+18165550100" },
    },
  });
  const port = Number(values.port);
  const supabaseUrl = values["supabase-url"] ?? "http://127.0.0.1:54331";
  try {
    assertLocalBaseUrl(`http://localhost:${port}`);
    assertSafeSupabaseUrl(supabaseUrl, { prodRefs: readProdRefs(process.cwd()), allowProjectRef: values["allow-project-ref"] ?? null });
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
  const env = buildServerEnv(process.env, {
    supabaseUrl,
    batchId: values.batch ? assertBatchId(values.batch) : null,
    port,
    fromNumber: values["from-number"]!,
  });
  console.log(`replay:server -> http://localhost:${port} (SMS_PROVIDER_STUB=1, Supabase ${new URL(supabaseUrl).host})`);
  const child = spawn("npx", ["next", "dev", "-p", String(port)], { env: env as NodeJS.ProcessEnv, stdio: "inherit" });
  child.on("exit", (code) => process.exit(code ?? 0));
}

if (process.argv[1] && /server\.ts$/.test(process.argv[1])) {
  main().catch((error) => fail(error instanceof Error ? error.message : String(error)));
}
