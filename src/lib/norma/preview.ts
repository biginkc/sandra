import type { SupabaseClient } from "@supabase/supabase-js";

import type { Database } from "@/lib/supabase/types";

import { readNormaCallbackAssigneeId, readNormaGateConfig, type NormaEnv } from "./config";
import type { NormaBlockInfo } from "./block-copy";
import { evaluateNormaGate } from "./gate";
import { checkNormaEligibility, hasOpenNormaRequest } from "./rpc";
import { loadNormaWrongNumbers, selectVoicePhone, toUsVoiceE164 } from "./voice-phone";

type Client = SupabaseClient<Database>;

/**
 * Read-only preview of what `requestNormaCall` would do right now. Creates
 * nothing, pauses nothing and never calls Bland. The action re-checks
 * everything, so this is advisory (a stale preview can only be more or less
 * permissive than the truth, never bypass a check).
 */
export type NormaCallPreview =
  | { callable: true; phoneE164: string }
  | { callable: false; block: NormaBlockInfo; phoneE164?: string };

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function previewNormaCallCore(
  propertyId: string,
  deps: { getUserId: () => Promise<string | null>; sessionClient: Client; adminClient: Client; env?: NormaEnv },
): Promise<NormaCallPreview> {
  const blocked = (block: NormaBlockInfo, phoneE164?: string): NormaCallPreview => ({ callable: false, block, ...(phoneE164 ? { phoneE164 } : {}) });
  if (!UUID_PATTERN.test(propertyId)) return blocked({ code: "lead_not_found" });
  if (!(await deps.getUserId())) return blocked({ code: "unauthenticated" });

  const { data: property, error } = await deps.sessionClient
    .from("properties")
    .select("id, org_id, is_training, homeowner_contact_id")
    .eq("id", propertyId)
    .is("deleted_at", null)
    .maybeSingle();
  if (error) return blocked({ code: "error" });
  if (!property || !property.homeowner_contact_id) return blocked({ code: "lead_not_found" });
  if (property.is_training) return blocked({ code: "training_lead" });

  try {
    if (await hasOpenNormaRequest(deps.sessionClient, propertyId)) return blocked({ code: "in_flight" });

    const { data: contact, error: contactError } = await deps.sessionClient
      .from("contacts")
      .select("phone_1, phone_2, phone_3")
      .eq("id", property.homeowner_contact_id)
      .maybeSingle();
    if (contactError) return blocked({ code: "error" });
    const candidates = [contact?.phone_1, contact?.phone_2, contact?.phone_3]
      .map((value) => toUsVoiceE164(value))
      .filter((value): value is string => value !== null);
    const wrong = await loadNormaWrongNumbers(deps.adminClient, property.org_id, candidates);
    const phone = selectVoicePhone(contact, wrong)?.phoneE164 ?? null;
    if (!phone) return blocked({ code: "no_callable_number" });

    const eligibility = await checkNormaEligibility(deps.adminClient, {
      propertyId,
      contactId: property.homeowner_contact_id,
      phoneE164: phone,
    });
    if (!eligibility.eligible) return blocked({ code: "blocked", reason: eligibility.reason }, phone);

    const gate = evaluateNormaGate(phone, readNormaGateConfig(deps.env));
    if (!gate.open) return blocked({ code: "gate_off", reason: gate.reason }, phone);
    if (!readNormaCallbackAssigneeId(deps.env)) return blocked({ code: "callback_assignee_not_configured" }, phone);
    return { callable: true, phoneE164: phone };
  } catch {
    return blocked({ code: "error" });
  }
}
