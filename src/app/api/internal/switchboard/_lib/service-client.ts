import { createClient, type SupabaseClient } from "@supabase/supabase-js";

import type { Database } from "@/lib/supabase/types";

/** Service-role client for authenticated Switchboard preference events. */
export function createSwitchboardServiceClient(): SupabaseClient<Database> {
  const isTest = process.env.NODE_ENV === "test";
  const url =
    process.env.NEXT_PUBLIC_SUPABASE_URL ??
    (isTest ? process.env.TEST_SUPABASE_URL : undefined);
  const key =
    process.env.SUPABASE_SERVICE_ROLE_KEY ??
    (isTest ? process.env.TEST_SUPABASE_SERVICE_ROLE_KEY : undefined);

  if (!url || !key) {
    throw new Error(
      "Switchboard internal API needs NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.",
    );
  }

  return createClient<Database>(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}
