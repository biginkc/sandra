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
import {
  selectBestSmsPhone,
  selectSmsPhoneByNumber,
} from "@/lib/messaging/sms-phone";
import { findLatestAuthoritativeSmsRoute } from "@/lib/messages/sms-parties";
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
import type { LeadEvent } from "./lead-events";
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
    ? `property_id.eq.${lead.id},and(contact_id.eq.${homeownerContactId},property_id.is.null)`
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

  // An existing thread's customer and business numbers are one route. Pick
  // both from the same newest homeowner SMS row so a lead with multiple saved
  // phones cannot accidentally reply from sender B to customer phone A.
  const latestHomeownerSmsRoute = findLatestAuthoritativeSmsRoute(
    initialMessages.filter(
      (message) =>
        message.channel === "sms" &&
        Boolean(homeownerContactId) &&
        message.contact_id === homeownerContactId &&
        message.property_id === lead.id,
    ),
  )?.parties ?? null;
  const inlineRoutePhoneChoice = latestHomeownerSmsRoute
    ? selectSmsPhoneByNumber(
        lead.homeowner,
        latestHomeownerSmsRoute.customerPhone,
      )
    : null;
  const inlineReplyPhone = latestHomeownerSmsRoute
    ? inlineRoutePhoneChoice?.lineType === "landline"
      ? null
      : (inlineRoutePhoneChoice?.phone ?? null)
    : homeownerSmsPhone;
  const inlineReplyFromNumber =
    latestHomeownerSmsRoute?.businessPhone ?? preferredFromNumber;
  const inlineReplyPhoneUnavailableMessage =
    latestHomeownerSmsRoute && inlineRoutePhoneChoice?.lineType === "landline"
      ? "This thread number is saved as a landline — use a mobile number for SMS."
      : latestHomeownerSmsRoute && !inlineReplyPhone
        ? "This thread number is not saved on the homeowner contact — save it before replying."
        : undefined;
  // Preserve the header composer's preferred-phone presentation, but verify
  // the inline thread's exact saved phone when it uses another slot.
  const inlineSmsPhoneSuppressionPromise = inlineReplyPhone
    ? inlineReplyPhone !== homeownerSmsPhone
      ? isSmsPhoneSuppressed(supabase, inlineReplyPhone, lead.org_id)
          .then((value) => ({ ok: true as const, value }))
          .catch(() => ({ ok: false as const, value: null }))
      : smsPhoneSuppressionPromise
    : Promise.resolve({ ok: true as const, value: false });

  // Notes — newest first for the feed component.
  const { data: notesRaw, error: notesError } = await supabase
    .from("lead_notes")
    .select("*")
    .eq("property_id", lead.id)
    .order("created_at", { ascending: false })
    .limit(200);
  const initialNotes = (notesRaw ?? []) as LeadNoteRow[];

  // Append-only lead activity — newest bounded window, merged client-side
  // with canonical messages, notes, and calls.
  const { data: leadEventsRaw, error: leadEventsError } = await supabase
    .from("lead_events")
    .select(
      "id, property_id, actor_type, actor_id, event_type, payload, created_at",
    )
    .eq("property_id", lead.id)
    .order("created_at", { ascending: false })
    .order("id", { ascending: false })
    .limit(200);
  const initialLeadEvents = (leadEventsRaw ?? []) as LeadEvent[];

  // auth.admin.listUsers() spans the entire Auth project, not this lead's
  // organization. Build an active-org membership allowlist first, fail closed
  // if it cannot be trusted, and only then retain matching auth identities.
  const admin = createAdminClient();
  const orgAuthorCap = 400;
  const activeMembershipAt = new Date(requestNowMs).toISOString();
  const usersPromise = (async () => {
    try {
      const membershipResult = await admin
        .from("memberships")
        .select("user_id")
        .eq("org_id", lead.org_id)
        .eq("access_status", "active")
        .is("deletion_prepared_at", null)
        .or(
          `access_expires_at.is.null,access_expires_at.gt.${activeMembershipAt}`,
        )
        .order("user_id", { ascending: true })
        .limit(orgAuthorCap + 1);
      if (
        membershipResult.error ||
        !membershipResult.data ||
        membershipResult.data.length > orgAuthorCap
      ) {
        console.error("[leads] org author identity lookup failed", {
          membershipCode: membershipResult.error?.code ?? null,
          membershipCapExceeded:
            (membershipResult.data?.length ?? 0) > orgAuthorCap,
        });
        return [];
      }
      const orgMemberIds = new Set(
        membershipResult.data.map((membership) => membership.user_id),
      );
      if (orgMemberIds.size === 0) return [];

      const authUsersById = new Map<
        string,
        { id: string; email?: string | null }
      >();
      const authUsersPerPage = 200;
      // Advance page numbers locally: auth-js can mis-parse multi-digit
      // nextPage values. Terminate on complete resolution, a short page, or
      // this hard 5,000-user project bound.
      const maxAuthUserPages = 25;
      for (let page = 1; page <= maxAuthUserPages; page += 1) {
        const authUsersResult = await admin.auth.admin.listUsers({
          page,
          perPage: authUsersPerPage,
        });
        if (authUsersResult.error) {
          console.error("[leads] org author auth lookup failed", {
            page,
          });
          return [];
        }
        const authUsers = authUsersResult.data?.users ?? [];
        for (const user of authUsers) {
          if (orgMemberIds.has(user.id)) authUsersById.set(user.id, user);
        }
        if (
          authUsersById.size >= orgMemberIds.size ||
          authUsers.length < authUsersPerPage
        ) {
          break;
        }
      }
      return [...authUsersById.values()];
    } catch {
      return [];
    }
  })();

  // PostgREST cannot order by COALESCE(started_at, created_at). Fetch the top
  // 20 from each disjoint subgroup, then deterministically merge to the
  // logical top 20. A row below rank 20 in either subgroup cannot enter the
  // combined top 20, so this remains exact without an unbounded read.
  const callSelection =
    "id, created_at, started_at, outcome, disposition, recording_status, transcript_status, summary_status, jitter_attempt_id, jitter_session_id, call_recordings(*), call_transcripts(*)";
  const [startedCallsResult, unstartedCallsResult] = await Promise.all([
    supabase
      .from("call_activities")
      .select(callSelection)
      .eq("property_id", lead.id)
      .not("started_at", "is", null)
      .order("started_at", { ascending: false })
      .order("id", { ascending: false })
      .limit(20),
    supabase
      .from("call_activities")
      .select(callSelection)
      .eq("property_id", lead.id)
      .is("started_at", null)
      .order("created_at", { ascending: false })
      .order("id", { ascending: false })
      .limit(20),
  ]);
  const callRollupError =
    startedCallsResult.error ?? unstartedCallsResult.error;
  const initialCallRows = callRollupError
    ? []
    : selectLatestCallActivityRows([
        ...((startedCallsResult.data ??
          []) as unknown as CallActivityRollupRow[]),
        ...((unstartedCallsResult.data ??
          []) as unknown as CallActivityRollupRow[]),
      ]);

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
  const inlinePhoneSuppressionResult =
    await inlineSmsPhoneSuppressionPromise;
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
  // Invalid thread routes (unsaved or landline) keep InlineReply's more
  // specific explanation. Valid routes get a full restriction decision for
  // their exact slot instead of inheriting the header phone's result.
  const inlineSmsPresentation = latestHomeownerSmsRoute
    ? deriveLeadSmsPresentation({
        hasContact: Boolean(lead.homeowner),
        // Unsaved and landline established routes are explained by
        // InlineReply. Keep this gate focused on contact/property-wide
        // restrictions and the exact route's suppression state.
        hasUsablePhone: true,
        consentState,
        contactSmsOptedOut: lead.homeowner?.sms_opted_out ?? false,
        propertySmsOptedOut: lead.outreach_dispo === "opted_out",
        phoneSuppressed: inlinePhoneSuppressionResult.ok
          ? inlinePhoneSuppressionResult.value
          : null,
        outreachDispo: lead.outreach_dispo,
        phoneLineType: inlineRoutePhoneChoice?.lineType ?? null,
      })
    : smsPresentation;

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
  // RLS-accessible to end-users). The identities are already filtered through
  // this lead's active-org membership allowlist above.
  const authorEmails: Record<string, string> = {};
  let assigneeEmail: string | null = null;
  const assigneeUsers = await usersPromise;
  for (const u of assigneeUsers) {
    if (u.email) authorEmails[u.id] = u.email;
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
  const inlineReplyUnavailable = !lead.homeowner?.id || !inlineReplyPhone;
  const cassStatusLabel = lead.cass_status
    .replace(/_/g, " ")
    .replace(/^./, (character) => character.toUpperCase());

  const heroActions = (
    <>
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
      <span className="border-border inline-flex overflow-hidden rounded-full border [&_[data-slot=button]]:rounded-none [&_[data-slot=button]]:border-0">
        {prevId ? (
          <Link href={`/leads/${prevId}`}>
            <Button
              variant="ghost"
              size="icon-sm"
              className="min-w-9"
              aria-label="Previous"
            >
              <ChevronLeft className="h-4 w-4" />
            </Button>
          </Link>
        ) : (
          <Button
            variant="ghost"
            size="icon-sm"
            className="min-w-9"
            disabled
            aria-label="No previous"
          >
            <ChevronLeft className="h-4 w-4" />
          </Button>
        )}
        <span className="bg-border w-px" aria-hidden />
        {nextId ? (
          <Link href={`/leads/${nextId}`}>
            <Button
              variant="ghost"
              size="icon-sm"
              className="min-w-9"
              aria-label="Next"
            >
              <ChevronRight className="h-4 w-4" />
            </Button>
          </Link>
        ) : (
          <Button
            variant="ghost"
            size="icon-sm"
            className="min-w-9"
            disabled
            aria-label="No next"
          >
            <ChevronRight className="h-4 w-4" />
          </Button>
        )}
      </span>
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
            <LeadMotivationWidget
              propertyId={lead.id}
              address={lead.address}
              initial={lead.motivation_level as MotivationLevel | null}
            />
            <LeadAssigneeWidget
              propertyId={lead.id}
              address={lead.address}
              initialAssigneeId={lead.assigned_user_id}
              initialAssigneeEmail={assigneeEmail}
              currentUserId={sessionUser?.id ?? null}
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
        className="@container/lead-workspace px-4 pt-3.5 pb-7 md:px-6 [&_button]:min-h-9"
      >
        <h2 id="lead-workspace-heading" className="sr-only">
          Activity
        </h2>
        <div className="grid min-w-0 items-start gap-[14px] xl:grid-cols-[minmax(0,1fr)_340px]">
          <div className="min-w-0 space-y-3">
            <LeadActivityTimeline
              key={lead.id}
              propertyId={lead.id}
              contactId={lead.homeowner?.id ?? null}
              initialMessages={initialMessages}
              initialNotes={initialNotes}
              initialCalls={initialCallRows}
              initialEvents={initialLeadEvents}
              messageError={threadError?.message ?? null}
              noteError={notesError?.message ?? null}
              callError={callRollupError?.message ?? null}
              eventError={leadEventsError?.message ?? null}
              authorEmails={authorEmails}
              currentUserId={sessionUser?.id ?? null}
              currentUserEmail={sessionUser?.email ?? null}
              jitterHost={process.env.NEXT_PUBLIC_JITTER_HOST ?? ""}
            />
            <div className="min-w-0" data-testid="lead-activity-composers">
              <SmsEntryPointGate
                restricted={inlineSmsPresentation.smsRestricted}
                placement="inline"
                restrictionLabel={inlineSmsPresentation.consentLabel}
                restrictionDetail={inlineSmsPresentation.consentDetail}
              >
                <InlineReply
                  propertyId={lead.id}
                  homeownerContactId={lead.homeowner?.id ?? null}
                  homeownerPhone={inlineReplyPhone}
                  replyToPhone={inlineReplyPhone}
                  preferredFromNumber={inlineReplyFromNumber}
                  phoneUnavailableMessage={
                    inlineReplyPhoneUnavailableMessage
                  }
                  footerAction={
                    !inlineSmsPresentation.smsRestricted &&
                    !inlineReplyUnavailable ? (
                      <AddNoteComposer propertyId={lead.id} compact />
                    ) : null
                  }
                />
              </SmsEntryPointGate>
              {inlineSmsPresentation.smsRestricted ||
              inlineReplyUnavailable ? (
                <div className="mt-2 flex justify-end">
                  <AddNoteComposer propertyId={lead.id} compact />
                </div>
              ) : null}
            </div>
          </div>

          <aside className="min-w-0 space-y-3" aria-label="Lead dossier">
            <Section title="Homeowner" compact>
              {lead.homeowner ? (
                <>
                  <Row label="Name" value={homeownerName} />
                  <div
                    className="flex min-w-0 items-center justify-between gap-3 border-b border-border/60 px-3 py-2"
                    data-slot="lead-detail-row"
                  >
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

            <Section title="Tasks & appointments" id="set-next-action" compact>
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

            <Section title="Tags" compact>
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

            <Section title="Automation & enrichment" compact>
              <div className="flex flex-col items-stretch gap-2 text-xs [&_label]:min-h-9 [&_label]:justify-between [&_label]:border-0 [&_label]:px-0 sm:[&_label]:min-h-0 [&_button]:w-auto [&_button]:self-start">
                <AiResponderToggle
                  propertyId={lead.id}
                  initialDisabled={lead.ai_responder_disabled}
                />
                <SkipTraceToggle
                  propertyId={lead.id}
                  initialDisabled={lead.skip_trace_disabled}
                />
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="text-muted-foreground">
                    Address (CASS: {cassStatusLabel})
                  </span>
                  <CassWidget
                    propertyId={lead.id}
                    cassStatus={lead.cass_status}
                  />
                </div>
                <div className="bg-border/60 h-px" />
                <EnrollInSequenceWidget propertyId={lead.id} />
              </div>
            </Section>

            <details
              className="border-border bg-card rounded-xl border"
              data-testid="lead-full-record"
            >
              <summary className="flex cursor-pointer flex-wrap items-center justify-between gap-2 px-3.5 py-3 text-xs font-bold">
                <span>Full record</span>
                <span className="text-muted-foreground text-[11px] font-normal">
                  property · USPS · contacts · identifiers · admin
                </span>
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
      className="bg-background grid grid-cols-[repeat(auto-fit,minmax(150px,1fr))] gap-2.5 px-4 pt-3 md:px-6"
      data-testid="lead-deal-snapshot"
      aria-label="Deal snapshot"
    >
      {stats.map((stat) => (
        <div
          key={stat.label}
          className={`min-w-0 rounded-[14px] border px-4 py-3 ${
            stat.accent
              ? "border-border border-l-[3px] border-l-emerald-700 bg-card text-emerald-950"
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
  compact = false,
}: {
  title: string;
  children: React.ReactNode;
  id?: string;
  compact?: boolean;
}) {
  if (compact) {
    return (
      <div
        className="border-border bg-card flex min-w-0 flex-col gap-2 rounded-[14px] border p-3.5 [&_[data-slot=lead-detail-row]]:border-0 [&_[data-slot=lead-detail-row]]:px-0 [&_[data-slot=lead-detail-row]]:py-1 [&_[data-slot=lead-tags-row]]:border-0 [&_[data-slot=lead-tags-row]]:px-0 [&_[data-slot=lead-tags-row]]:py-1"
        id={id}
        data-lead-section="compact"
      >
        <div className="text-muted-foreground font-mono text-[10px] font-bold tracking-[0.1em] uppercase">
          {title}
        </div>
        <div className="flex min-w-0 flex-col">{children}</div>
      </div>
    );
  }
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
      data-slot="lead-detail-row"
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

function selectLatestCallActivityRows(
  rows: CallActivityRollupRow[],
): CallActivityRollupRow[] {
  return [...rows]
    .sort((a, b) => {
      const aTime = a.started_at ?? a.created_at;
      const bTime = b.started_at ?? b.created_at;
      return bTime.localeCompare(aTime) || b.id.localeCompare(a.id);
    })
    .slice(0, 20);
}

function formatDate(iso: string | null | undefined): string | null {
  if (!iso) return null;
  return new Date(iso).toLocaleDateString();
}

function formatBool(v: boolean | null | undefined): string | null {
  if (v == null) return null;
  return v ? "Yes" : "No";
}
