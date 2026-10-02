"use server";

import { revalidatePath } from "next/cache";

import { reportError } from "@/lib/errors/report";
import { requestNormaCallCore, type RequestNormaCallResult } from "@/lib/norma/request-call";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

/**
 * "Have Norma call". Session-authenticated; every other rule (membership,
 * training guard, eligibility, gate) is enforced in the core / SQL. No UI yet.
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
