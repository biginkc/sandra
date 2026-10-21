import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { resolveProofLink } from "@/lib/voicemail-drop/proof-link";

export const dynamic = "force-dynamic";

const NO_STORE = { "cache-control": "no-store", "referrer-policy": "no-referrer" };

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...NO_STORE, "content-type": "application/json; charset=utf-8" },
  });
}

/**
 * Proof of delivery for one voicemail drop. The drop is read with the
 * caller's session, so RLS (active org membership) is the org check; a drop
 * in another org is a plain 404. Redirects to a 60-second signed URL for
 * Sandra's stored copy, or to Drop Cowboy's link while it is within 7 days.
 */
export async function GET(_request: Request, { params }: { params: Promise<{ dropRowId: string }> }) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return json({ error: "Not signed in" }, 401);

  const { dropRowId } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(dropRowId)) return json({ error: "Not found" }, 404);

  const { data, error } = await supabase
    .from("voicemail_drops")
    .select("id, org_id, proof_url, proof_url_at, completed_at, proof_storage_path")
    .eq("id", dropRowId)
    .maybeSingle();
  if (error) return json({ error: "Could not load proof" }, 500);
  if (!data) return json({ error: "Not found" }, 404);

  const link = await resolveProofLink(data, async (path, seconds) => {
    const { data: signed, error: signError } = await createAdminClient()
      .storage.from("voicemail-drop-proofs")
      .createSignedUrl(path, seconds);
    return signError || !signed?.signedUrl ? null : signed.signedUrl;
  });
  if (!link) return json({ error: "Proof of delivery is no longer available" }, 404);
  return new Response(null, { status: 302, headers: { ...NO_STORE, location: link } });
}
