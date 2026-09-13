import type { Database } from "../src/lib/supabase/types";

type ContactInsert = Database["public"]["Tables"]["contacts"]["Insert"];

/** Pure preflight: never infer ownership or line type from a saved test number. */
export function buildSequenceSmokeContact(env: Record<string, string | undefined>) {
  const phone = env.SEQUENCE_SMOKE_RECIPIENT_E164?.trim();
  if (!phone || !/^\+[1-9]\d{9,14}$/.test(phone)) {
    throw new Error("Set SEQUENCE_SMOKE_RECIPIENT_E164 to the explicitly authorized owned test receiver in E.164 format.");
  }
  if (env.SEQUENCE_SMOKE_RECIPIENT_OWNED !== "true") {
    throw new Error("Set SEQUENCE_SMOKE_RECIPIENT_OWNED=true only after confirming ownership and authorization for this test receiver.");
  }
  // The existing SMS sender blocks landlines. A database-valid landline
  // fixture would still be incapable of completing this delivery canary.
  if (env.SEQUENCE_SMOKE_RECIPIENT_LINE_TYPE !== "mobile") {
    throw new Error("Set SEQUENCE_SMOKE_RECIPIENT_LINE_TYPE=mobile only for a verified SMS-capable mobile test receiver; unknown and landline recipients cannot run this smoke.");
  }
  return {
    first_name: "Smoke",
    last_name: "Prod",
    phone_1: phone,
    phone_1_type: env.SEQUENCE_SMOKE_RECIPIENT_LINE_TYPE,
  } satisfies ContactInsert;
}
