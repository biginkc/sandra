import "server-only";
import { createClient } from "@supabase/supabase-js";
import type { DialpadVoiceDatabase } from "./database.generated";

export function createDialpadVoiceAdminClient<Schema = DialpadVoiceDatabase>() {
  const isTest = process.env.NODE_ENV === "test" || process.env.VITEST === "true";
  const url = (isTest ? process.env.TEST_SUPABASE_URL : undefined) ?? process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = (isTest ? process.env.TEST_SUPABASE_SERVICE_ROLE_KEY : undefined) ?? process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("Voice database unavailable");
  return createClient<Schema>(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}
