"use server";

import { revalidatePath } from "next/cache";

import { reportError } from "@/lib/errors/report";
import { markNormaReviewedCore, type MarkNormaReviewedResult } from "@/lib/norma/mark-reviewed";
import { previewNormaCallCore, type NormaCallPreview } from "@/lib/norma/preview";
import { requestNormaCallCore, type RequestNormaCallResult } from "@/lib/norma/request-call";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

/**
 * "Have Norma call". Session-authenticated; every other rule (membership,
 * training guard, eligibility, gate) is enforced in the core / SQL.
 */
export async function requestNormaCall(
  propertyId: string,
  repContext: string | null,
): Promise<RequestNormaCallResult> {
  try {
    const sessionClient = await createClient();
    const result = await requestNormaCallCore(propertyId, repContext, {
      getUserId: async () => {
        const {
          data: { user },
          error,
        } = await sessionClient.auth.getUser();
        return error || !user ? null : user.id;
      },
      sessionClient,
      adminClient: createAdminClient(),
    });
    if (result.ok || result.code === "in_flight") revalidatePath(`/leads/${propertyId}`);
    return result;
  } catch (error) {
    reportError(error, { tags: { surface: "norma_request_call" }, extra: { propertyId } });
    return { ok: false, code: "error" };
  }
}

/** Read-only "what would happen if I confirmed now" for the request panel. */
export async function previewNormaCall(propertyId: string): Promise<NormaCallPreview> {
  try {
    const sessionClient = await createClient();
    return await previewNormaCallCore(propertyId, {
      getUserId: async () => {
        const {
          data: { user },
          error,
        } = await sessionClient.auth.getUser();
        return error || !user ? null : user.id;
      },
      sessionClient,
      adminClient: createAdminClient(),
    });
  } catch (error) {
    reportError(error, { tags: { surface: "norma_preview_call" }, extra: { propertyId } });
    return { callable: false, block: { code: "error" } };
  }
}

/**
 * "Mark reviewed": a rep takes over a Norma call that did not end clearly.
 * Session-authenticated; membership and every state rule are enforced in SQL.
 */
export async function markNormaCallReviewed(propertyId: string, requestId: string): Promise<MarkNormaReviewedResult> {
  try {
    const sessionClient = await createClient();
    const result = await markNormaReviewedCore(propertyId, requestId, {
      getUserId: async () => {
        const {
          data: { user },
          error,
        } = await sessionClient.auth.getUser();
        return error || !user ? null : user.id;
      },
      adminClient: createAdminClient(),
    });
    // A success, or a request that is no longer waiting, changes what the page shows.
    if (result.ok || result.code === "not_waiting") revalidatePath(`/leads/${propertyId}`);
    return result;
  } catch (error) {
    reportError(error, { tags: { surface: "norma_mark_reviewed" }, extra: { propertyId, requestId } });
    return { ok: false, code: "error" };
  }
}
