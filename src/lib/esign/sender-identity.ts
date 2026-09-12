import "server-only";

import { cache } from "react";

import { authoritativeDisplayName } from "@/lib/auth/team-member";
import { createAdminClient } from "@/lib/supabase/admin";

/** Call only with created_by from an organization-scoped request lookup. */
export const loadEsignCreatorLabel = cache(async (createdBy: string | null | undefined): Promise<string | null> => {
  if (!createdBy) return null;
  let deadline: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = await Promise.race([
      createAdminClient().auth.admin.getUserById(createdBy),
      new Promise<null>(resolve => { deadline = setTimeout(() => resolve(null), 1500); }),
    ]);
    if (!result) return null;
    const { data, error } = result;
    const user = data?.user;
    if (error || !user || user.id !== createdBy) return null;
    const label = authoritativeDisplayName(user)
      ?? (user.email_confirmed_at ? user.email : null);
    return label?.replace(/\s+/g, " ").trim().slice(0,200) || null;
  } catch {
    // An unavailable/deleted identity must not invent a name or break history.
    return null;
  } finally {
    clearTimeout(deadline);
  }
});
