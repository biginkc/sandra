import { createClient } from "@/lib/supabase/server";
import { errFromUnknown, ok, type Result } from "@/lib/errors/result";
import { dripStatus, pauseReasonText } from "@/lib/sequences/drip-status";
import { getSequenceWithSteps, type SequenceWithSteps } from "../actions";

export type StepStat = { step_id: string; sent: number; replied: number; waiting: number };
export type DripPerson = {
  enrollmentId: string;
  propertyId: string;
  threadId: string | null;
  address: string;
  name: string;
  status: string;
  detail: string | null;
  step: number;
  nextRunAt: string | null;
  canAct: boolean;
};
export type DripDetail = {
  sequence: SequenceWithSteps;
  stats: StepStat[];
  people: DripPerson[];
  peopleCount: number;
};

export async function getDripDetail(sequenceId: string): Promise<Result<DripDetail | null>> {
  try {
    const sequenceResult = await getSequenceWithSteps(sequenceId);
    if (!sequenceResult.ok) return sequenceResult;
    if (!sequenceResult.data) return ok(null);
    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return { ok: false, error: { code: "UNAUTHENTICATED", message: "Not signed in" } };
    const { data: sequenceOrg, error: orgError } = await supabase.from("sequences")
      .select("org_id").eq("id", sequenceId).single();
    if (orgError || !sequenceOrg) throw orgError ?? new Error("Drip organization unavailable");
    const [statResult, enrollmentsResult] = await Promise.all([
      supabase.rpc("sequence_step_stats", { p_org: sequenceOrg.org_id, p_sequence: sequenceId }),
      supabase.from("sequence_enrollments")
        .select("id, property_id, status, pause_reason, current_step_index, next_run_at, enrolled_at", { count: "exact" })
        .eq("org_id", sequenceOrg.org_id).eq("sequence_id", sequenceId)
        .order("enrolled_at", { ascending: false }).order("id", { ascending: false }).limit(200),
    ]);
    if (statResult.error) throw statResult.error;
    if (enrollmentsResult.error) throw enrollmentsResult.error;
    const enrollments = enrollmentsResult.data ?? [];
    const ids = [...new Set(enrollments.map((row) => row.property_id))];
    const properties = ids.length ? await supabase.from("properties")
      .select("id, address, homeowner_contact_id").in("id", ids).eq("org_id", sequenceOrg.org_id) : { data: [], error: null };
    if (properties.error) throw properties.error;
    const contactsIds = [...new Set((properties.data ?? []).flatMap((row) => row.homeowner_contact_id ? [row.homeowner_contact_id] : []))];
    const contacts = contactsIds.length ? await supabase.from("contacts")
      .select("id, first_name, last_name").in("id", contactsIds) : { data: [], error: null };
    if (contacts.error) throw contacts.error;
    const byProperty = new Map((properties.data ?? []).map((row) => [row.id, row]));
    const byContact = new Map((contacts.data ?? []).map((row) => [row.id, row]));
    const completed = enrollments.filter((row) => row.status === "completed");
    const completedIds = completed.map((row) => row.id);
    const completedPropertyIds = [...new Set(completed.map((row) => row.property_id))];
    const [repliesResult, canceledResult] = await Promise.all([
      completedPropertyIds.length ? supabase.from("properties")
        .select("id, inbound_messages:messages!messages_property_id_fkey(created_at)")
        .in("id", completedPropertyIds).eq("org_id", sequenceOrg.org_id)
        .eq("inbound_messages.direction", "inbound")
        .order("created_at", { referencedTable: "inbound_messages", ascending: false })
        .limit(1, { referencedTable: "inbound_messages" }) : Promise.resolve({ data: [], error: null }),
      completedPropertyIds.length ? supabase.from("lead_events")
        .select("source_id").eq("org_id", sequenceOrg.org_id).eq("event_type", "sequence_canceled")
        .in("source_id", completedIds).limit(200) : Promise.resolve({ data: [], error: null }),
    ]);
    if (repliesResult.error || canceledResult.error) throw repliesResult.error ?? canceledResult.error;
    const textRuns: Array<{ enrollment_id: string; message_id: string }> = [];
    if (completedIds.length) for (let offset = 0; ; offset += 1000) {
      const runs = await supabase.from("sequence_step_runs")
        .select("enrollment_id, message_id").in("enrollment_id", completedIds)
        .not("message_id", "is", null).order("id").range(offset, offset + 999);
      if (runs.error) throw runs.error;
      for (const run of runs.data ?? []) if (run.message_id) textRuns.push({ enrollment_id: run.enrollment_id, message_id: run.message_id });
      if (!runs.data || runs.data.length < 1000) break;
    }
    const lastSent = new Map<string, string>();
    for (let offset = 0; offset < textRuns.length; offset += 100) {
      const batch = textRuns.slice(offset, offset + 100);
      const messages = await supabase.from("messages").select("id, sent_at")
        .eq("org_id", sequenceOrg.org_id).in("id", batch.map((run) => run.message_id));
      if (messages.error) throw messages.error;
      const sentAt = new Map((messages.data ?? []).map((message) => [message.id, message.sent_at]));
      for (const run of batch) {
        const at = sentAt.get(run.message_id);
        if (at && (!lastSent.has(run.enrollment_id) || at > lastSent.get(run.enrollment_id)!)) lastSent.set(run.enrollment_id, at);
      }
    }
    const lastInbound = new Map<string, string>();
    for (const property of repliesResult.data ?? []) if (property.inbound_messages[0]) lastInbound.set(property.id, property.inbound_messages[0].created_at);
    const canceled = new Set((canceledResult.data ?? []).map((event) => event.source_id));
    const count = sequenceResult.data.steps.length;
    return ok({ sequence: sequenceResult.data, stats: statResult.data ?? [], peopleCount: enrollmentsResult.count ?? enrollments.length,
      people: enrollments.map((row) => {
        const property = byProperty.get(row.property_id);
        const contact = property?.homeowner_contact_id ? byContact.get(property.homeowner_contact_id) : null;
        const name = [contact?.first_name, contact?.last_name].filter(Boolean).join(" ");
        const repliedAfterLast = (lastInbound.get(row.property_id) ?? "") > (lastSent.get(row.id) ?? row.enrolled_at);
        const bucketStatus = dripStatus(row.status, row.pause_reason, canceled.has(row.id), repliedAfterLast);
        const status = bucketStatus ?? "Paused";
        return { enrollmentId: row.id, propertyId: row.property_id, threadId: property?.homeowner_contact_id ?? null,
          address: property?.address ?? "Address unavailable", name: name || property?.address || "Lead",
          status, detail: pauseReasonText(row.pause_reason) ?? (bucketStatus ? null : repliedAfterLast ? "Lead replied after the last drip text." : "Review this drip before continuing."), step: count ? Math.min(count, Math.max(1, row.current_step_index + 1)) : 0,
          nextRunAt: row.status === "active" ? row.next_run_at : null,
          canAct: row.status === "active" || row.status === "paused" };
      }) });
  } catch (error) {
    return errFromUnknown(error, "DRIP_DETAIL_FAILED");
  }
}
