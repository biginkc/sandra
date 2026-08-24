import Link from "next/link";
import { notFound } from "next/navigation";
import { ChevronLeft, ChevronRight, ExternalLink } from "lucide-react";

import { BookAppointmentPopover } from "@/components/appointments/book-appointment-popover";
import { SoftphoneLeadButton } from "@/components/softphone/softphone-lead-button";
import type { SoftphoneLead } from "@/components/softphone/softphone-provider";
import { Page } from "@/components/page";
import { PageHeader } from "@/components/page-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { loadIntegrationPrefs } from "@/lib/integrations/prefs";
import {
  computeConsentState,
  type ConsentState,
} from "@/lib/messaging/consent";
import { isSmsPhoneSuppressed } from "@/lib/messaging/opt-out-phone";
import { getMessagingProvider } from "@/lib/messaging/registry";
import { selectBestSmsPhone } from "@/lib/messaging/sms-phone";
import { canShowCallButton } from "@/lib/dialer/eligibility";
import { zillowUrl } from "@/lib/utils/zillow-url";

import {
  getPropertyNeighbors,
  markMessagesReadForProperty,
  type DetailedLead,
  type PropertyStatus,
} from "../actions";

import { listTemplates } from "../../templates/actions";
import { loadTemplateVars } from "@/lib/sequences/template-vars";
import { renderTemplate } from "@/lib/templates/render";
import { AiAttentionBanner } from "./ai-attention-banner";
import { AiResponderToggle } from "./ai-responder-toggle";
import { SkipTraceToggle } from "./skip-trace-toggle";
import { SkipTraceButton } from "./skip-trace-button";
import { CassWidget } from "./cass-widget";
import { DeleteLeadButton } from "./delete-lead-button";
import { InlineReply } from "./inline-reply";
import { LeadAssigneeWidget } from "./assignee-widget";
import { EnrollInSequenceWidget } from "./enroll-widget";
import { LeadMotivationWidget } from "./motivation-widget";
import { LeadStatusWidget } from "./status-widget";
import type { CallActivityRollupRow } from "./lead-call-summary";
import { LeadAppointmentsSection } from "./lead-appointments-section";
import { deriveLeadSmsPresentation } from "./lead-detail-state";
import { LeadIdentityActions } from "./lead-identity-actions";
import { LeadLoadFailure } from "./lead-load-failure";
import { LeadTaskWidget } from "./lead-task-widget";
import { NextActionCard, type LeadNextTask } from "./next-action-card";
import { SmsEntryPointGate } from "./sms-channel-restriction";
import { SmsComposer } from "./sms-composer";
import { TagsSection } from "./tags-section";
import type { MotivationLevel } from "../actions";
import type { TagRow } from "../tags-actions";
import type { Database } from "@/lib/supabase/types";
import { LeadMediaHero } from "./lead-media-hero";
import { resolveLeadMediaPresentation } from "./lead-media";
import { LeadActivityTimeline } from "./lead-activity";
import { AddNoteComposer } from "./notes-feed";

type MessageRow = Database["public"]["Tables"]["messages"]["Row"];
type LeadNoteRow = Database["public"]["Tables"]["lead_notes"]["Row"];

export const dynamic = "force-dynamic";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const supabase = await createClient();
  const { data } = await supabase
    .from("properties")
    .select("address, city, state")
    .eq("id", id)
    .maybeSingle();
  const title = data
    ? `${data.address}${data.city ? `, ${data.city}` : ""} · Sandra CRM`
    : "Lead · Sandra CRM";
  return { title };
}

export default async function LeadDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams?: Promise<{ warning?: string }>;
}) {
  const { id } = await params;
  // Degraded-save warning from the new-lead form (e.g. phone parked on
  // notes because line-type classification was unavailable).
  const warning = (await searchParams)?.warning ?? null;
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("properties")
    .select(
      `*,
       homeowner:contacts!properties_homeowner_contact_id_fkey(
         *,
         homeowner_details!homeowner_details_contact_org_fkey(*)
       ),
       agent:contacts!properties_agent_contact_id_fkey(
         *,
         agent_details!agent_details_contact_org_fkey(*)
       )`,
    )
    .eq("id", id)
    .maybeSingle();

  if (error) {
    console.error("[leads] detail fetch failed", {
      message: error.message,
      code: error.code,
    });
    return (
      <Page>
        <PageHeader
          breadcrumb={[
            { label: "Workspace" },
            { label: "Leads", href: "/leads" },
            { label: "Error" },
          ]}
          title="Lead"
        />
        <LeadLoadFailure
          title="Lead details did not load"
          detail="Sandra could not retrieve this record. This is a load failure, not an empty lead."
        />
      </Page>
    );
  }

  if (!data) {
    notFound();
  }

  const lead = data as DetailedLead;
  // One request-captured instant keeps every appointment action boundary
  // stable between server render and client hydration.
  // eslint-disable-next-line react-hooks/purity -- this async Server Component intentionally serializes one request instant to the client
  const requestNowMs = Date.now();
  if (lead.is_dnc_locked) {
    const lockedMode = lead.status === "prospect" ? "prospect" : "lead";
    const { prevId, nextId } = await getPropertyNeighbors(id, lockedMode);
    return (
      <LockedDncPropertyDetail
        lead={lead}
        prevId={prevId}
        nextId={nextId}
        mode={lockedMode}
      />
    );
  }
  const homeownerSmsChoice = selectBestSmsPhone(lead.homeowner);
  const homeownerSmsPhone = homeownerSmsChoice?.phone ?? null;
  const homeownerContactId = lead.homeowner?.id ?? null;
  const detailSoftphoneLead: SoftphoneLead = {
    id: lead.id,
    contactId: homeownerContactId,
    firstName: lead.homeowner?.first_name ?? "homeowner",
    name:
      lead.homeowner?.contact_type === "entity"
        ? (lead.homeowner.entity_name ?? "Unknown homeowner")
        : [lead.homeowner?.first_name, lead.homeowner?.last_name]
            .filter(Boolean)
            .join(" ") || "Unknown homeowner",
    address: lead.address,
    state: lead.state,
    phones: [
      lead.homeowner?.phone_1,
      lead.homeowner?.phone_2,
      lead.homeowner?.phone_3,
    ].filter((phone): phone is string => Boolean(phone)),
    dncLocked: lead.is_dnc_locked,
    contactDnc: lead.homeowner?.do_not_contact ?? false,
    callable: canShowCallButton({
      property: {
        id: lead.id,
        state: lead.state,
        is_dnc_locked: lead.is_dnc_locked,
      },
      contact: lead.homeowner
        ? {
            id: lead.homeowner.id,
            phone_1: lead.homeowner.phone_1,
            phone_2: lead.homeowner.phone_2,
            phone_3: lead.homeowner.phone_3,
            do_not_contact: lead.homeowner.do_not_contact,
            sms_opted_out: lead.homeowner.sms_opted_out,
          }
        : null,
    }),
  };

  // Consent and phone-level suppression are separate existing read models.
  // Load both so the page does not infer "OK to text" from the mere presence
  // of a phone number or conflate a channel opt-out with permanent DNC.
  const smsConsentEventsPromise = homeownerContactId
    ? supabase
        .from("consent_events")
        .select("event_type, occurred_at")
        .eq("contact_id", homeownerContactId)
        .eq("channel", "sms")
        .order("occurred_at", { ascending: false })
        .limit(20)
    : null;
  const smsPhoneSuppressionPromise = homeownerSmsPhone
    ? isSmsPhoneSuppressed(supabase, homeownerSmsPhone, lead.org_id)
        .then((value) => ({ ok: true as const, value }))
        .catch(() => ({ ok: false as const, value: null }))
    : Promise.resolve({ ok: true as const, value: false });

  // One source for both the nearest dated commitment and the Appointments
  // section. Querying only appointments made a lead with an existing callback
  // look as though it had no next action.
  const openWorkPromise = supabase
    .from("tasks")
    .select("id, title, due_at, end_at, assignee_id, type")
    .eq("related_property_id", lead.id)
    .eq("status", "open")
    .order("due_at", { ascending: true });

  const { prevId, nextId } = await getPropertyNeighbors(
    id,
    lead.status === "prospect" ? "prospect" : "lead",
  );

  // Current user — for "me" labeling in assignee + note-author displays.
  const {
    data: { user: sessionUser },
  } = await supabase.auth.getUser();

  // Viewer's own saved timezone (same user_integration_prefs.timezone
  // source TasksPanel's fetchMyTasks reads) — LeadAppointmentsSection
  // needs this to format appointment times without silently falling back
  // to the render environment's device zone (loadIntegrationPrefs already
  // falls back to "America/Chicago" when unset).
  const viewerPrefs = sessionUser
    ? await loadIntegrationPrefs(supabase, sessionUser.id)
    : null;
  const viewerTimezone = viewerPrefs?.timezone ?? "America/Chicago";

  // Opening a lead acknowledges unread inbound SMS before the bounded thread
  // snapshot is read. Awaiting prevents the client from missing a fast
  // Realtime UPDATE and indefinitely rendering an already-read row as unread.
  const markReadResult = await markMessagesReadForProperty(lead.id);
  if (!markReadResult.ok) {
    console.error("[leads] mark messages read failed", {
      code: markReadResult.error.code,
    });
  }

  // Fetch existing SMS thread — messages linked either to the property
  // directly or to the homeowner (catches inbound that lands pre-linkage).
  const orFilter = homeownerContactId
    ? `property_id.eq.${lead.id},contact_id.eq.${homeownerContactId}`
    : `property_id.eq.${lead.id}`;
  const { data: threadRaw, error: threadError } = await supabase
    .from("messages")
    .select("*")
    .or(orFilter)
    // Fetch the newest bounded window first. Ordering oldest-first before
    // LIMIT silently returns the first 200 messages ever sent and hides the
    // live end of long-running conversations.
    .order("created_at", { ascending: false })
    .limit(200);
  const initialMessages = [...((threadRaw ?? []) as MessageRow[])].reverse();
  let latestInboundSenderQuery = supabase
    .from("messages")
    .select("to_address")
    .eq("channel", "sms")
    .eq("direction", "inbound")
    .eq("property_id", lead.id)
    .not("to_address", "is", null)
    .order("created_at", { ascending: false })
    .limit(1);
  if (lead.homeowner?.id) {
    latestInboundSenderQuery = latestInboundSenderQuery.eq(
      "contact_id",
      lead.homeowner.id,
    );
  }
  const { data: latestInboundSender } =
    await latestInboundSenderQuery.maybeSingle();
  // Leads with no prior inbound message have no "sticky" sender to reply
  // from. Fall back to the configured provider's default number (e.g.
  // Sendillo's single SENDILLO_FROM_NUMBER) so the composer and inline
  // reply box have a real, sendable number instead of "—" — and so the
  // manual send doesn't fail with "No sticky sending number found" for
  // providers (like Sendillo) that participate in sender-inventory
  // validation and therefore skip the server-side default fallback for
  // manual sends without an explicit `from`. Best-effort only: a
  // misconfigured provider must not break the lead page.
  let providerDefaultFromNumber: string | null = null;
  try {
    providerDefaultFromNumber =
      getMessagingProvider()?.getDefaultFromNumber?.() ?? null;
  } catch {
    providerDefaultFromNumber = null;
  }
  const preferredFromNumber =
    latestInboundSender?.to_address ??
    [...initialMessages]
      .reverse()
      .find(
        (message) =>
          message.direction === "inbound" &&
          message.to_address &&
          (!lead.homeowner?.id || message.contact_id === lead.homeowner.id) &&
          message.property_id === lead.id,
      )?.to_address ??
    providerDefaultFromNumber ??
    null;

  // Notes — newest first for the feed component.
  const { data: notesRaw, error: notesError } = await supabase
    .from("lead_notes")
    .select("*")
    .eq("property_id", lead.id)
    .order("created_at", { ascending: false })
    .limit(200);
  const initialNotes = (notesRaw ?? []) as LeadNoteRow[];

  // listUsers() always fetches the whole team; it has no user-id filter.
  // Start it as soon as the note-derived IDs are known and consume it after
  // the other independent lead-detail work completes.
  const userIdsNeeded = new Set<string>();
  if (lead.assigned_user_id) userIdsNeeded.add(lead.assigned_user_id);
  for (const n of initialNotes) {
    if (n.author_user_id) userIdsNeeded.add(n.author_user_id);
  }
  const admin = createAdminClient();
  const usersPromise = (async () => {
    try {
      const { data } = await admin.auth.admin.listUsers({ perPage: 200 });
      return data?.users ?? [];
    } catch {
      return [];
    }
  })();

  const { data: callRollupRaw, error: callRollupError } = await supabase
    .from("call_activities")
    .select(
      "id, created_at, started_at, outcome, disposition, recording_status, transcript_status, summary_status, jitter_attempt_id, jitter_session_id, call_recordings(*), call_transcripts(*)",
    )
    .eq("property_id", lead.id)
    .order("started_at", { ascending: false, nullsFirst: false })
    .order("created_at", { ascending: false })
    .limit(20);
  const initialCallRows = (callRollupRaw ??
    []) as unknown as CallActivityRollupRow[];

  const { data: openWorkRaw, error: openWorkError } = await openWorkPromise;
  if (openWorkError) {
    console.error("[leads] open work fetch failed", {
      message: openWorkError.message,
      code: openWorkError.code,
    });
  }
  const openWork = (openWorkRaw ?? []) as Array<{
    id: string;
    title: string;
    due_at: string;
    end_at: string | null;
    assignee_id: string;
    type: string;
  }>;
  const initialAppointments = openWork.filter(
    (task) => task.type === "appointment",
  );
  // The database result is already due-date ordered. Appointments and plain
  // tasks compete in one timeline; filtering first could show a 3 PM callback
  // while hiding the real 9 AM appointment.
  const nextTask = (openWork[0] ?? null) as LeadNextTask | null;

  const smsConsentEventsResult = smsConsentEventsPromise
    ? await smsConsentEventsPromise
    : { data: [], error: null };
  const phoneSuppressionResult = await smsPhoneSuppressionPromise;
  const consentState: ConsentState | null = smsConsentEventsResult.error
    ? null
    : computeConsentState(smsConsentEventsResult.data ?? []);
  const smsPresentation = deriveLeadSmsPresentation({
    hasContact: Boolean(lead.homeowner),
    hasUsablePhone: Boolean(
      homeownerSmsChoice && homeownerSmsChoice.lineType !== "landline",
    ),
    consentState,
    contactSmsOptedOut: lead.homeowner?.sms_opted_out ?? false,
    propertySmsOptedOut: lead.outreach_dispo === "opted_out",
    phoneSuppressed: phoneSuppressionResult.ok
      ? phoneSuppressionResult.value
      : null,
    outreachDispo: lead.outreach_dispo,
    phoneLineType: homeownerSmsChoice?.lineType ?? null,
  });

  // Tags attached to this property, with the tag row joined inline.
  const { data: tagRowsRaw, error: tagRowsError } = await supabase
    .from("property_tags")
    .select(
      "tags!property_tags_tag_id_fkey(id, name, color, category, system_managed)",
    )
    .eq("property_id", lead.id);
  const initialTags: TagRow[] = [];
  for (const r of tagRowsRaw ?? []) {
    const t = (r as { tags: TagRow | null }).tags;
    if (t) initialTags.push(t);
  }

  // Fetch SMS templates and pre-render them with this property's vars so the
  // composer picker can just do a straight body injection on selection.
  const templatesResult = await listTemplates();
  let templateOptions: Array<{ id: string; name: string; body: string }> = [];
  if (templatesResult.ok && templatesResult.data.length > 0) {
    const vars = await loadTemplateVars(supabase, {
      propertyId: lead.id,
      contactId: homeownerContactId,
    });
    templateOptions = templatesResult.data.map((t) => ({
      id: t.id,
      name: t.name,
      body: renderTemplate(t.content, vars),
    }));
  }

  // Resolve author + assignee emails via the admin client (auth.users isn't
  // RLS-accessible to end-users). Batched into a single listUsers() call.
  const authorEmails: Record<string, string> = {};
  let assigneeEmail: string | null = null;
  const assigneeUsers = await usersPromise;
  for (const u of assigneeUsers) {
    if (u.email && userIdsNeeded.has(u.id)) {
      authorEmails[u.id] = u.email;
    }
  }
  if (lead.assigned_user_id) {
    assigneeEmail = authorEmails[lead.assigned_user_id] ?? null;
  }

  const zillowHref = zillowUrl({
    address: lead.address,
    city: lead.city,
    state: lead.state,
    zip: lead.zip,
  });
  const mediaPresentation = await resolveLeadMediaPresentation({
    lat: lead.lat,
    lon: lead.lon,
    address: lead.address,
    city: lead.city,
    state: lead.state,
    zip: lead.zip,
  });
  const homeownerName = lead.homeowner
    ? lead.homeowner.contact_type === "entity"
      ? lead.homeowner.entity_name
      : [lead.homeowner.first_name, lead.homeowner.last_name]
          .filter(Boolean)
          .join(" ") || null
    : null;
  const locationLine =
    [lead.city, lead.state, lead.zip].filter(Boolean).join(", ") || "—";
  const homeownerMailingAddress = (() => {
    const details = lead.homeowner?.homeowner_details;
    if (!details) return null;
    if (details.mailing_address?.includes(",")) return details.mailing_address;
    return (
      [
        details.mailing_address,
        details.mailing_city,
        details.mailing_state,
        details.mailing_zip,
      ]
        .filter(Boolean)
        .join(", ") || null
    );
  })();

  const heroActions = (
    <>
      <Link href="/leads">
        <Button variant="outline" size="sm" aria-label="Back to leads">
          <ChevronLeft className="mr-1 h-4 w-4" />
          Back
        </Button>
      </Link>
      <SoftphoneLeadButton lead={detailSoftphoneLead} />
      <SmsEntryPointGate
        restricted={smsPresentation.smsRestricted}
        placement="header"
        restrictionLabel={smsPresentation.consentLabel}
        restrictionDetail={smsPresentation.consentDetail}
      >
        <SmsComposer
          propertyId={lead.id}
          homeownerContactId={lead.homeowner?.id ?? null}
          homeownerPhone={homeownerSmsPhone}
          homeownerName={homeownerName}
          preferredFromNumber={preferredFromNumber}
          templates={templateOptions}
        />
      </SmsEntryPointGate>
      <BookAppointmentPopover
        propertyId={lead.id}
        contactId={lead.homeowner?.id ?? undefined}
        subjectLabel={lead.address}
        currentUserId={sessionUser?.id ?? null}
        triggerLabel="Book appt"
      />
      {zillowHref ? (
        <a
          href={zillowHref}
          target="_blank"
          rel="noopener noreferrer"
          aria-label="View on Zillow"
          data-testid="zillow-link-header"
        >
          <Button variant="outline" size="sm">
            Zillow
            <ExternalLink className="ml-1 h-4 w-4" />
          </Button>
        </a>
      ) : null}
      {prevId ? (
        <Link href={`/leads/${prevId}`}>
          <Button variant="outline" size="icon" aria-label="Previous">
            <ChevronLeft className="h-4 w-4" />
          </Button>
        </Link>
      ) : (
        <Button variant="outline" size="icon" disabled aria-label="No previous">
          <ChevronLeft className="h-4 w-4" />
        </Button>
      )}
      {nextId ? (
        <Link href={`/leads/${nextId}`}>
          <Button variant="outline" size="icon" aria-label="Next">
            <ChevronRight className="h-4 w-4" />
          </Button>
        </Link>
      ) : (
        <Button variant="outline" size="icon" disabled aria-label="No next">
          <ChevronRight className="h-4 w-4" />
        </Button>
      )}
    </>
  );

  return (
    <Page className="gap-0 p-0">
      <LeadMediaHero
        media={mediaPresentation}
        address={lead.address}
        locationLine={locationLine}
        homeownerName={homeownerName}
        actions={heroActions}
      />
      <DealSnapshotStrip lead={lead} />

      <LeadIdentityActions
        workingState={
          <>
            <LeadStatusWidget
              propertyId={lead.id}
              initialStatus={lead.status as PropertyStatus}
              address={lead.address}
            />
            <LeadAssigneeWidget
              propertyId={lead.id}
              address={lead.address}
              initialAssigneeId={lead.assigned_user_id}
              initialAssigneeEmail={assigneeEmail}
              currentUserId={sessionUser?.id ?? null}
            />
            <LeadMotivationWidget
              propertyId={lead.id}
              address={lead.address}
              initial={lead.motivation_level as MotivationLevel | null}
            />
          </>
        }
        nextAction={
          openWorkError ? (
            <div
              className="border-destructive/40 bg-destructive/5 text-destructive rounded-lg border px-3 py-2 text-sm font-semibold"
              role="alert"
              data-testid="lead-next-action-load-failure"
            >
              Next action did not load. Task data is unavailable. This is not
              the same as having no next action.
            </div>
          ) : (
            <NextActionCard task={nextTask} timezone={viewerTimezone} compact />
          )
        }
        recordSignals={
          <>
            {lead.market ? (
              <Badge variant="secondary">{lead.market}</Badge>
            ) : null}
            {lead.is_vacant ? (
              <Badge variant="destructive">Vacant</Badge>
            ) : null}
            {lead.absentee_flag ? (
              <Badge variant="secondary">Absentee</Badge>
            ) : null}
            <Badge
              variant={lead.cass_status === "verified" ? "default" : "outline"}
            >
              CASS {lead.cass_status}
            </Badge>
            <Badge
              variant={smsPresentation.smsRestricted ? "outline" : "secondary"}
              data-testid="lead-sms-consent-chip"
            >
              SMS: {smsPresentation.consentLabel}
            </Badge>
          </>
        }
      />

      {warning ? (
        <div
          className="mx-4 mt-4 rounded-md border border-amber-300 bg-amber-50 p-3 text-sm md:mx-6 dark:border-amber-500/40 dark:bg-amber-500/10"
          role="alert"
          data-testid="lead-save-warning"
        >
          {warning}
        </div>
      ) : null}

      <div className="mx-4 mt-4 md:mx-6">
        <AiAttentionBanner
          propertyId={lead.id}
          initialVisible={lead.needs_human_attention}
          reason={lead.last_ai_escalation_reason}
          escalatedAt={lead.last_ai_escalation_at}
          nowMs={requestNowMs}
        />
      </div>

      <section
        aria-labelledby="lead-workspace-heading"
        data-testid="lead-workspace-primary"
        className="@container/lead-workspace order-4 px-4 py-5 md:px-6 md:py-6 [&_button]:min-h-9"
      >
        <div className="mb-4">
          <h2
            id="lead-workspace-heading"
            className="text-lg font-black tracking-tight"
          >
            Activity
          </h2>
          <p className="text-muted-foreground text-sm">
            Messages, notes, and calls in one oldest-to-newest history.
          </p>
        </div>
        <div className="grid min-w-0 gap-6 xl:grid-cols-[minmax(0,1fr)_340px]">
          <div className="min-w-0">
            <div className="border-border bg-card rounded-xl border p-3 shadow-sm sm:p-4">
              <LeadActivityTimeline
                propertyId={lead.id}
                contactId={lead.homeowner?.id ?? null}
                initialMessages={initialMessages}
                initialNotes={initialNotes}
                initialCalls={initialCallRows}
                messageError={threadError?.message ?? null}
                noteError={notesError?.message ?? null}
                callError={callRollupError?.message ?? null}
                authorEmails={authorEmails}
                currentUserId={sessionUser?.id ?? null}
                currentUserEmail={sessionUser?.email ?? null}
                jitterHost={process.env.NEXT_PUBLIC_JITTER_HOST ?? ""}
              />
            </div>
            <div
              className="mt-4 grid min-w-0 gap-3 lg:grid-cols-[minmax(0,1fr)_minmax(240px,0.65fr)]"
              data-testid="lead-activity-composers"
            >
              <SmsEntryPointGate
                restricted={smsPresentation.smsRestricted}
                placement="inline"
                restrictionLabel={smsPresentation.consentLabel}
                restrictionDetail={smsPresentation.consentDetail}
              >
                <InlineReply
                  propertyId={lead.id}
                  homeownerContactId={lead.homeowner?.id ?? null}
                  homeownerPhone={homeownerSmsPhone}
                  replyToPhone={homeownerSmsPhone}
                  preferredFromNumber={preferredFromNumber}
                  persistedMessageIds={initialMessages.map(
                    (message) => message.id,
                  )}
                />
              </SmsEntryPointGate>
              <AddNoteComposer propertyId={lead.id} />
            </div>
          </div>

          <aside className="min-w-0 space-y-4" aria-label="Lead dossier">
            <Section title="Homeowner">
              {lead.homeowner ? (
                <>
                  <Row label="Name" value={homeownerName} />
                  <div className="flex min-w-0 items-center justify-between gap-3 border-b border-border/60 px-3 py-2">
                    <span className="min-w-0 break-all font-mono text-sm">
                      {lead.homeowner.phone_1 || "No phone"}
                    </span>
                    <SoftphoneLeadButton lead={detailSoftphoneLead} compact />
                  </div>
                  <Row label="Phone 2" value={lead.homeowner.phone_2} mono />
                  <Row label="Phone 3" value={lead.homeowner.phone_3} mono />
                  <Row label="Email" value={lead.homeowner.email} />
                  <Row label="Mailing" value={homeownerMailingAddress} />
                  <Row
                    label="SMS consent"
                    value={`${smsPresentation.consentLabel} — ${smsPresentation.consentDetail}`}
                    testId="lead-sms-consent-row"
                  />
                  <Row
                    label="SMS restriction"
                    value={
                      smsPresentation.smsRestricted
                        ? `SMS disabled — ${smsPresentation.consentLabel}`
                        : "No SMS opt-out recorded"
                    }
                    testId="lead-sms-restriction-row"
                  />
                  <Row
                    label="Contact DNC flag"
                    value={formatBool(lead.homeowner.do_not_contact)}
                  />
                  {!lead.homeowner.phone_1 ? (
                    <div className="p-3">
                      <SkipTraceButton propertyId={lead.id} />
                    </div>
                  ) : null}
                </>
              ) : (
                <div className="space-y-3 p-3">
                  <EmptyRow text="No homeowner linked yet" />
                  <SkipTraceButton propertyId={lead.id} />
                </div>
              )}
              {smsPresentation.readFailed ? (
                <div className="p-3">
                  <LeadLoadFailure
                    title="SMS consent status is incomplete"
                    detail="One or more consent sources failed to load. Retry before relying on this status."
                    testId="lead-sms-consent-load-failure"
                  />
                </div>
              ) : null}
            </Section>

            <Section title="Tasks & appointments" id="set-next-action">
              <div className="flex justify-end border-b border-border/60 p-3">
                <BookAppointmentPopover
                  propertyId={lead.id}
                  contactId={lead.homeowner?.id ?? undefined}
                  subjectLabel={lead.address}
                  currentUserId={sessionUser?.id ?? null}
                  triggerLabel="Book appointment"
                />
              </div>
              <div id="lead-appointments" className="border-b border-border/60">
                {openWorkError ? (
                  <div className="p-3">
                    <LeadLoadFailure
                      title="Appointments did not load"
                      detail="Appointment data is unavailable. Retry instead of treating this as an empty schedule."
                      testId="lead-appointments-load-failure"
                    />
                  </div>
                ) : (
                  <LeadAppointmentsSection
                    appointments={initialAppointments}
                    timezone={viewerTimezone}
                    nowMs={requestNowMs}
                  />
                )}
              </div>
              <LeadTaskWidget
                propertyId={lead.id}
                address={lead.address}
                currentUserId={sessionUser?.id ?? null}
                initialAssigneeId={lead.assigned_user_id}
              />
            </Section>

            <Section title="Tags">
              {tagRowsError ? (
                <div className="p-3">
                  <LeadLoadFailure
                    title="Tags did not load"
                    detail="Tag data is unavailable. Retry instead of treating this as an untagged lead."
                    testId="lead-tags-load-failure"
                  />
                </div>
              ) : (
                <TagsSection propertyId={lead.id} initial={initialTags} />
              )}
            </Section>

            <Section title="Automation & enrichment">
              <div className="flex flex-col items-stretch gap-2 p-3 [&_button]:w-full">
                <AiResponderToggle
                  propertyId={lead.id}
                  initialDisabled={lead.ai_responder_disabled}
                />
                <SkipTraceToggle
                  propertyId={lead.id}
                  initialDisabled={lead.skip_trace_disabled}
                />
                <CassWidget
                  propertyId={lead.id}
                  cassStatus={lead.cass_status}
                />
                <EnrollInSequenceWidget propertyId={lead.id} />
              </div>
            </Section>

            <details
              className="border-border bg-card rounded-lg border"
              data-testid="lead-full-record"
            >
              <summary className="cursor-pointer px-3 py-3 text-xs font-black tracking-wide uppercase">
                Full record
              </summary>
              <div className="border-t border-border">
                {zillowHref ? (
                  <a
                    href={zillowHref}
                    target="_blank"
                    rel="noopener noreferrer"
                    data-testid="zillow-link-panel"
                    className="flex min-h-9 items-center justify-between gap-2 border-b border-border/60 px-3 py-2 text-xs font-semibold hover:bg-muted"
                  >
                    View on Zillow
                    <ExternalLink className="size-3.5" aria-hidden />
                  </a>
                ) : null}
                <Row label="Beds" value={lead.beds} />
                <Row label="Baths" value={lead.baths} />
                <Row label="Square feet" value={lead.sqft} />
                <Row label="Year built" value={lead.year_built} />
                <Row
                  label="Listing price"
                  value={lead.listing_price}
                  format="currency"
                />
                <Row label="ARV" value={lead.arv} format="currency" />
                <Row
                  label="Repair estimate"
                  value={lead.repair_estimate}
                  format="currency"
                />
                <Row
                  label="Mortgage balance"
                  value={lead.mortgage_balance}
                  format="currency"
                />
                <Row
                  label="Equity (est.)"
                  value={lead.equity_estimate}
                  format="currency"
                />
                <Row label="Source" value={lead.source} />
                <Row label="CASS status" value={lead.cass_status} />
                <Row
                  label="Last verified"
                  value={formatDate(lead.cass_verified_at)}
                />
                <Row label="Vacant" value={formatBool(lead.is_vacant)} />
                <Row
                  label="Vacant since"
                  value={formatDate(lead.vacant_since)}
                />
                <Row label="Seasonal" value={formatBool(lead.is_seasonal)} />
                <Row
                  label="Residential"
                  value={formatBool(lead.is_residential)}
                />
                <Row
                  label="Owner moved"
                  value={formatDate(lead.owner_moved_at)}
                />
                <Row
                  label="NCOA verified"
                  value={formatDate(lead.ncoa_verified_at)}
                />
                <Row label="Homeowner" value={homeownerName} />
                <Row label="Phone 1" value={lead.homeowner?.phone_1} mono />
                <Row label="Phone 2" value={lead.homeowner?.phone_2} mono />
                <Row label="Phone 3" value={lead.homeowner?.phone_3} mono />
                <Row label="Homeowner email" value={lead.homeowner?.email} />
                <Row label="Mailing address" value={homeownerMailingAddress} />
                <Row
                  label="SMS consent"
                  value={`${smsPresentation.consentLabel} — ${smsPresentation.consentDetail}`}
                />
                <Row
                  label="SMS restriction"
                  value={
                    smsPresentation.smsRestricted
                      ? `SMS disabled — ${smsPresentation.consentLabel}`
                      : "No SMS opt-out recorded"
                  }
                />
                <Row
                  label="Contact DNC flag"
                  value={formatBool(lead.homeowner?.do_not_contact)}
                />
                <Row
                  label="Listing agent"
                  value={
                    lead.agent
                      ? [lead.agent.first_name, lead.agent.last_name]
                          .filter(Boolean)
                          .join(" ")
                      : "No listing agent linked"
                  }
                />
                <Row label="Agent phone" value={lead.agent?.phone_1} mono />
                <Row label="Agent email" value={lead.agent?.email} />
                <Row
                  label="Brokerage"
                  value={lead.agent?.agent_details?.brokerage}
                />
                <Row
                  label="License #"
                  value={lead.agent?.agent_details?.license_number}
                  mono
                />
                {lead.notes ? (
                  <div className="border-b border-border/60 px-3 py-3">
                    <p className="text-muted-foreground text-xs">
                      Imported notes (legacy)
                    </p>
                    <p className="mt-1 whitespace-pre-wrap break-words text-sm">
                      {lead.notes}
                    </p>
                  </div>
                ) : null}
                <Row label="APN" value={lead.apn} mono />
                <Row label="ZPID" value={lead.zpid} mono />
                <Row label="MLS #" value={lead.mls_number} mono />
                <Row label="FIPS" value={lead.fips_code} mono />
                <Row label="Regrid" value={lead.regrid_id} mono />
                <Row label="ATTOM" value={lead.attom_id} mono />
                <div className="space-y-3 p-3">
                  <p className="text-muted-foreground text-xs">
                    Destructive record actions are kept separate from daily lead
                    work.
                  </p>
                  <DeleteLeadButton
                    propertyId={lead.id}
                    address={lead.address}
                  />
                </div>
              </div>
            </details>
          </aside>
        </div>
      </section>
    </Page>
  );
}

function DealSnapshotStrip({ lead }: { lead: DetailedLead }) {
  const propertyFacts = [
    lead.beds != null ? `${lead.beds}bd` : null,
    lead.baths != null ? `${lead.baths}ba` : null,
    lead.sqft != null ? `${Number(lead.sqft).toLocaleString()} sqft` : null,
  ]
    .filter(Boolean)
    .join(" · ");
  const stats = [
    {
      label: "Equity (est.)",
      value: formatCurrency(lead.equity_estimate),
      accent: true,
    },
    { label: "ARV", value: formatCurrency(lead.arv) },
    { label: "Repair est.", value: formatCurrency(lead.repair_estimate) },
    { label: "Mortgage bal.", value: formatCurrency(lead.mortgage_balance) },
    {
      label: "Property",
      value: propertyFacts || "—",
      detail: [lead.year_built ? `Built ${lead.year_built}` : null, lead.source]
        .filter(Boolean)
        .join(" · "),
    },
  ];
  return (
    <section
      className="border-border bg-background grid grid-cols-[repeat(auto-fit,minmax(150px,1fr))] gap-2 border-b px-4 py-3 md:px-6"
      data-testid="lead-deal-snapshot"
      aria-label="Deal snapshot"
    >
      {stats.map((stat) => (
        <div
          key={stat.label}
          className={`min-w-0 rounded-xl border px-4 py-3 ${
            stat.accent
              ? "border-emerald-600 bg-emerald-50 text-emerald-950"
              : "border-border bg-card"
          }`}
        >
          <p className="text-muted-foreground text-[10px] font-black tracking-[0.14em] uppercase">
            {stat.label}
          </p>
          <p className="mt-1 text-lg font-black break-words tabular-nums">
            {stat.value}
          </p>
          {stat.detail ? (
            <p className="text-muted-foreground mt-0.5 text-[11px] break-words">
              {stat.detail}
            </p>
          ) : null}
        </div>
      ))}
    </section>
  );
}

function formatCurrency(value: number | null | undefined): string {
  return value == null
    ? "—"
    : new Intl.NumberFormat("en-US", {
        style: "currency",
        currency: "USD",
        maximumFractionDigits: 0,
      }).format(value);
}

function LockedDncPropertyDetail({
  lead,
  prevId,
  nextId,
  mode,
}: {
  lead: DetailedLead;
  prevId: string | null;
  nextId: string | null;
  mode: "prospect" | "lead";
}) {
  const collectionHref = mode === "prospect" ? "/properties" : "/leads";
  const collectionLabel = mode === "prospect" ? "Prospects" : "Leads";
  const recordLabel = mode === "prospect" ? "prospect" : "lead";
  const zillowHref = zillowUrl({
    address: lead.address,
    city: lead.city,
    state: lead.state,
    zip: lead.zip,
  });
  return (
    <Page>
      <PageHeader
        breadcrumb={[
          { label: "Workspace" },
          { label: collectionLabel, href: collectionHref },
          { label: lead.address },
        ]}
        title={lead.address}
        description={
          [lead.city, lead.state, lead.zip].filter(Boolean).join(", ") || "—"
        }
        actions={
          <div className="grid w-full grid-cols-2 gap-2 [&_button]:min-h-11 sm:flex sm:w-auto sm:items-center">
            <Link href={collectionHref}>
              <Button
                variant="outline"
                size="sm"
                aria-label={`Back to ${collectionLabel.toLowerCase()}`}
              >
                <ChevronLeft className="mr-1 h-4 w-4" />
                Back to {collectionLabel.toLowerCase()}
              </Button>
            </Link>
            {zillowHref ? (
              <a
                href={zillowHref}
                target="_blank"
                rel="noopener noreferrer"
                aria-label="View on Zillow"
              >
                <Button variant="outline" size="sm">
                  <ExternalLink className="mr-1 h-4 w-4" />
                  Zillow
                </Button>
              </a>
            ) : null}
            {prevId ? (
              <Link href={`/leads/${prevId}`}>
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label={`Previous ${recordLabel}`}
                  className="min-w-11"
                >
                  <ChevronLeft className="h-4 w-4" />
                </Button>
              </Link>
            ) : null}
            {nextId ? (
              <Link href={`/leads/${nextId}`}>
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label={`Next ${recordLabel}`}
                  className="min-w-11"
                >
                  <ChevronRight className="h-4 w-4" />
                </Button>
              </Link>
            ) : null}
          </div>
        }
      />

      <div
        className="border-foreground bg-muted rounded-md border-2 p-4"
        role="status"
        data-testid="permanent-dnc-lock"
      >
        <div className="font-mono text-sm font-bold tracking-wide">
          ⊘ PERMANENT DO NOT CONTACT
        </div>
        <p className="text-muted-foreground mt-1 text-sm">
          This record is permanently locked and read-only. Its historical
          pipeline stage is preserved for audit history.
        </p>
      </div>

      <div className="flex flex-wrap gap-2">
        <Badge variant="outline">
          Historical stage: {lead.status.replaceAll("_", " ")}
        </Badge>
        {lead.market ? <Badge variant="secondary">{lead.market}</Badge> : null}
        {lead.outreach_dispo ? (
          <Badge variant="outline">
            Disposition: {lead.outreach_dispo.replaceAll("_", " ")}
          </Badge>
        ) : null}
      </div>

      <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
        <Section title="Property">
          <Row label="Beds" value={lead.beds} />
          <Row label="Baths" value={lead.baths} />
          <Row label="Square feet" value={lead.sqft} />
          <Row label="Year built" value={lead.year_built} />
          <Row label="Source" value={lead.source} />
          <Row label="Created" value={formatDate(lead.created_at)} />
        </Section>

        <Section title="Homeowner">
          {lead.homeowner ? (
            <>
              <Row
                label="Name"
                value={
                  lead.homeowner.contact_type === "entity"
                    ? lead.homeowner.entity_name
                    : [lead.homeowner.first_name, lead.homeowner.last_name]
                        .filter(Boolean)
                        .join(" ")
                }
              />
              <Row label="Phone 1" value={lead.homeowner.phone_1} mono />
              <Row label="Phone 2" value={lead.homeowner.phone_2} mono />
              <Row label="Phone 3" value={lead.homeowner.phone_3} mono />
              <Row label="Email" value={lead.homeowner.email} />
              <Row label="Do not contact" value="Yes — permanent" />
            </>
          ) : (
            <EmptyRow text="No homeowner linked" />
          )}
        </Section>

        <Section title="Identifiers">
          <Row label="APN" value={lead.apn} mono />
          <Row label="ZPID" value={lead.zpid} mono />
          <Row label="MLS #" value={lead.mls_number} mono />
          <Row label="FIPS" value={lead.fips_code} mono />
        </Section>
      </div>
    </Page>
  );
}

function Section({
  title,
  children,
  id,
}: {
  title: string;
  children: React.ReactNode;
  id?: string;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-2" id={id}>
      <div className="text-muted-foreground text-xs font-semibold tracking-wide uppercase">
        {title}
      </div>
      <div className="border-border flex min-w-0 flex-col rounded-md border">
        {children}
      </div>
    </div>
  );
}

function Row({
  label,
  value,
  format,
  mono,
  testId,
}: {
  label: string;
  value: string | number | null | undefined;
  format?: "currency";
  mono?: boolean;
  testId?: string;
}) {
  const display =
    value == null || value === ""
      ? "—"
      : format === "currency" && typeof value === "number"
        ? `$${value.toLocaleString()}`
        : String(value);
  return (
    <div
      className="border-border/60 flex flex-col gap-1 border-b px-3 py-2 text-sm last:border-b-0 sm:flex-row sm:justify-between sm:gap-3"
      data-testid={testId}
    >
      <span className="text-muted-foreground min-w-0">{label}</span>
      <span
        className={
          mono
            ? "min-w-0 break-all font-mono sm:text-right"
            : "min-w-0 break-words sm:text-right"
        }
        title={display}
      >
        {display}
      </span>
    </div>
  );
}

function EmptyRow({ text }: { text: string }) {
  return <div className="text-muted-foreground px-3 py-2 text-sm">{text}</div>;
}

function formatDate(iso: string | null | undefined): string | null {
  if (!iso) return null;
  return new Date(iso).toLocaleDateString();
}

function formatBool(v: boolean | null | undefined): string | null {
  if (v == null) return null;
  return v ? "Yes" : "No";
}
