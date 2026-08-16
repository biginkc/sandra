import Link from "next/link";
import { notFound } from "next/navigation";
import { ChevronLeft, ChevronRight, ExternalLink } from "lucide-react";

import { BookAppointmentPopover } from "@/components/appointments/book-appointment-popover";
import { Page } from "@/components/page";
import { PageHeader } from "@/components/page-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { loadIntegrationPrefs } from "@/lib/integrations/prefs";
import { getMessagingProvider } from "@/lib/messaging/registry";
import { selectBestSmsPhone } from "@/lib/messaging/sms-phone";
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
import { MessagesThread } from "./messages-thread";
import { NotesFeed } from "./notes-feed";
import {
  LeadCallSummary,
  type CallActivityRollupRow,
} from "./lead-call-summary";
import { LeadAppointmentsSection } from "./lead-appointments-section";
import { LeadTaskWidget } from "./lead-task-widget";
import { SmsComposer } from "./sms-composer";
import { TagsSection } from "./tags-section";
import type { MotivationLevel } from "../actions";
import type { TagRow } from "../tags-actions";
import type { Database } from "@/lib/supabase/types";

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
        <div className="text-destructive text-sm">
          Failed to load lead: {error.message}
        </div>
      </Page>
    );
  }

  if (!data) {
    notFound();
  }

  const lead = data as DetailedLead;
  if (lead.is_dnc_locked) {
    const { prevId, nextId } = await getPropertyNeighbors(id, "prospect");
    return (
      <LockedDncPropertyDetail
        lead={lead}
        prevId={prevId}
        nextId={nextId}
      />
    );
  }
  const homeownerSmsPhone = selectBestSmsPhone(lead.homeowner)?.phone ?? null;

  // Started early, consumed just before render (same parallel-fetch shape
  // as `usersPromise` below) — this lead's own open appointments, each
  // with its own outcome/reschedule/cancel controls (Appointments
  // section).
  const appointmentsPromise = supabase
    .from("tasks")
    .select("id, title, due_at, end_at, assignee_id")
    .eq("type", "appointment")
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

  // Fetch existing SMS thread — messages linked either to the property
  // directly or to the homeowner (catches inbound that lands pre-linkage).
  const homeownerContactId = lead.homeowner?.id ?? null;
  const orFilter = homeownerContactId
    ? `property_id.eq.${lead.id},contact_id.eq.${homeownerContactId}`
    : `property_id.eq.${lead.id}`;
  const { data: threadRaw } = await supabase
    .from("messages")
    .select("*")
    .or(orFilter)
    .order("created_at", { ascending: true })
    .limit(200);
  const initialMessages = (threadRaw ?? []) as MessageRow[];
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
  const preferredFromNumber = latestInboundSender?.to_address ??
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

  // Opening a lead acknowledges any unread inbound SMS on it. Fire-and-forget
  // so the page renders fast; the kanban card's red dot will clear on next
  // nav or Realtime UPDATE.
  void markMessagesReadForProperty(lead.id);

  // Notes — newest first for the feed component.
  const { data: notesRaw } = await supabase
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

  const { data: callRollupRaw } = await supabase
    .from("call_activities")
    .select(
      "id, started_at, outcome, disposition, recording_status, transcript_status",
    )
    .eq("property_id", lead.id)
    .order("started_at", { ascending: false, nullsFirst: false })
    .limit(20);
  const initialCallRows =
    (callRollupRaw ?? []) as unknown as CallActivityRollupRow[];

  const { data: appointmentsRaw, error: appointmentsError } =
    await appointmentsPromise;
  if (appointmentsError && appointmentsError.code !== "42703") {
    // 42703 = post-deploy pre-migration window (end_at/type='appointment'
    // don't exist yet) — degrade to an empty section rather than failing
    // the whole page; any other error still just logs.
    console.error("[leads] appointments fetch failed", {
      message: appointmentsError.message,
      code: appointmentsError.code,
    });
  }
  const initialAppointments = (appointmentsRaw ?? []) as Array<{
    id: string;
    title: string;
    due_at: string;
    end_at: string | null;
    assignee_id: string;
  }>;

  // Tags attached to this property, with the tag row joined inline.
  const { data: tagRowsRaw } = await supabase
    .from("property_tags")
    .select("tags!property_tags_tag_id_fkey(id, name, color, category, system_managed)")
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
    const vars = await loadTemplateVars(
      supabase,
      {
        propertyId: lead.id,
        contactId: homeownerContactId,
      },
    );
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

  return (
    <Page>
      <PageHeader
        breadcrumb={[
          { label: "Workspace" },
          { label: "Leads", href: "/leads" },
          { label: lead.address },
        ]}
        title={lead.address}
        description={
          [lead.city, lead.state, lead.zip].filter(Boolean).join(", ") || "—"
        }
        actions={
          <div className="flex items-center gap-1">
            <Link href="/leads">
              <Button variant="outline" size="sm" aria-label="Back to leads">
                <ChevronLeft className="mr-1 h-4 w-4" />
                Back to leads
              </Button>
            </Link>
            {zillowHref ? (
              <a
                href={zillowHref}
                target="_blank"
                rel="noopener noreferrer"
                aria-label="View on Zillow"
                data-testid="zillow-link-header"
              >
                <Button variant="outline" size="sm">
                  <ExternalLink className="mr-1 h-4 w-4" />
                  Zillow
                </Button>
              </a>
            ) : null}
            {prevId ? (
              <Link href={`/leads/${prevId}`}>
                <Button variant="ghost" size="icon" aria-label="Previous">
                  <ChevronLeft className="h-4 w-4" />
                </Button>
              </Link>
            ) : (
              <Button variant="ghost" size="icon" disabled aria-label="No previous">
                <ChevronLeft className="h-4 w-4" />
              </Button>
            )}
            {nextId ? (
              <Link href={`/leads/${nextId}`}>
                <Button variant="ghost" size="icon" aria-label="Next">
                  <ChevronRight className="h-4 w-4" />
                </Button>
              </Link>
            ) : (
              <Button variant="ghost" size="icon" disabled aria-label="No next">
                <ChevronRight className="h-4 w-4" />
              </Button>
            )}
            <DeleteLeadButton propertyId={lead.id} address={lead.address} />
          </div>
        }
      />

      {warning ? (
        <div
          className="rounded-md border border-amber-300 bg-amber-50 p-3 text-sm dark:border-amber-500/40 dark:bg-amber-500/10"
          role="alert"
          data-testid="lead-save-warning"
        >
          {warning}
        </div>
      ) : null}

      <AiAttentionBanner
        propertyId={lead.id}
        initialVisible={lead.needs_human_attention}
        reason={lead.last_ai_escalation_reason}
        escalatedAt={lead.last_ai_escalation_at}
      />

      <div className="border-border flex flex-col gap-2 border-b pb-4">
        <div className="flex flex-wrap items-center gap-1.5">
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
          <EnrollInSequenceWidget propertyId={lead.id} />
          <BookAppointmentPopover
            propertyId={lead.id}
            contactId={lead.homeowner?.id ?? undefined}
            subjectLabel={lead.address}
            currentUserId={sessionUser?.id ?? null}
            triggerLabel="Book appt"
          />
          <AiResponderToggle
            propertyId={lead.id}
            initialDisabled={lead.ai_responder_disabled}
          />
          <SkipTraceToggle
            propertyId={lead.id}
            initialDisabled={lead.skip_trace_disabled}
          />
          {!lead.homeowner?.phone_1 ? (
            <SkipTraceButton propertyId={lead.id} />
          ) : null}
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
          <CassWidget propertyId={lead.id} cassStatus={lead.cass_status} />
          <SmsComposer
            propertyId={lead.id}
            homeownerContactId={lead.homeowner?.id ?? null}
            homeownerPhone={homeownerSmsPhone}
            homeownerName={
              lead.homeowner?.contact_type === "entity"
                ? lead.homeowner.entity_name
                : lead.homeowner
                  ? [lead.homeowner.first_name, lead.homeowner.last_name]
                      .filter(Boolean)
                      .join(" ") || null
                  : null
            }
            preferredFromNumber={preferredFromNumber}
            templates={templateOptions}
          />
        </div>
      </div>

      <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
        <Section title="Property">
          {zillowHref ? (
            <a
              href={zillowHref}
              target="_blank"
              rel="noopener noreferrer"
              data-testid="zillow-link-panel"
              className="border-border flex items-center justify-between gap-2 border-b px-4 py-2 text-xs font-medium text-[#1c1917] transition-colors hover:bg-[#f5f5f4]"
            >
              <span>View on Zillow</span>
              <ExternalLink className="h-3.5 w-3.5 text-[#78716c]" aria-hidden />
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
        </Section>

        <div className="flex flex-col gap-2">
          <div className="text-muted-foreground text-xs font-semibold tracking-wide uppercase">
            SMS thread
          </div>
          <div className="border-border flex flex-col rounded-md border p-3">
            <MessagesThread
              initial={initialMessages}
              contactId={lead.homeowner?.id ?? null}
              propertyId={lead.id}
            />
            <InlineReply
              propertyId={lead.id}
              homeownerContactId={lead.homeowner?.id ?? null}
              homeownerPhone={homeownerSmsPhone}
              replyToPhone={homeownerSmsPhone}
              preferredFromNumber={preferredFromNumber}
            />
          </div>
        </div>

        <Section title="Tasks">
          <LeadTaskWidget
            propertyId={lead.id}
            address={lead.address}
            currentUserId={sessionUser?.id ?? null}
            initialAssigneeId={lead.assigned_user_id}
          />
        </Section>

        <Section title="Appointments">
          <LeadAppointmentsSection
            appointments={initialAppointments}
            timezone={viewerTimezone}
          />
        </Section>

        <Section title="Address quality (USPS)">
          <Row label="CASS status" value={lead.cass_status} />
          <Row label="Last verified" value={formatDate(lead.cass_verified_at)} />
          <Row label="Vacant" value={formatBool(lead.is_vacant)} />
          <Row label="Vacant since" value={formatDate(lead.vacant_since)} />
          <Row label="Seasonal" value={formatBool(lead.is_seasonal)} />
          <Row label="Residential" value={formatBool(lead.is_residential)} />
          <Row label="Owner moved" value={formatDate(lead.owner_moved_at)} />
          <Row
            label="NCOA verified"
            value={formatDate(lead.ncoa_verified_at)}
          />
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
              <Row
                label="Mailing address"
                value={(() => {
                  const d = lead.homeowner.homeowner_details;
                  if (!d) return null;
                  // If mailing_address already contains commas it's a full
                  // combined string (e.g. DealMachine "Primary Mailing Address").
                  // Show it alone to avoid duplicating city/state/zip.
                  if (d.mailing_address?.includes(",")) return d.mailing_address;
                  return [d.mailing_address, d.mailing_city, d.mailing_state, d.mailing_zip]
                    .filter(Boolean)
                    .join(", ") || null;
                })()}
              />
              <Row
                label="Do not contact"
                value={formatBool(lead.homeowner.do_not_contact)}
              />
            </>
          ) : (
            <EmptyRow text="No homeowner linked yet" />
          )}
        </Section>

        <Section title="Listing agent">
          {lead.agent ? (
            <>
              <Row
                label="Name"
                value={[lead.agent.first_name, lead.agent.last_name]
                  .filter(Boolean)
                  .join(" ")}
              />
              <Row label="Phone" value={lead.agent.phone_1} mono />
              <Row label="Email" value={lead.agent.email} />
              <Row
                label="Brokerage"
                value={lead.agent.agent_details?.brokerage}
              />
              <Row
                label="License #"
                value={lead.agent.agent_details?.license_number}
                mono
              />
            </>
          ) : (
            <EmptyRow text="No agent linked. Trigger agent enrichment from this page (coming soon)." />
          )}
        </Section>

        {lead.notes ? (
          <Section title="Imported notes (legacy)">
            <div className="whitespace-pre-wrap p-3 text-sm">{lead.notes}</div>
          </Section>
        ) : null}
      </div>

      <div>
        <div className="text-muted-foreground mb-2 text-xs font-semibold tracking-wide uppercase">
          Tags
        </div>
        <div className="border-border rounded-md border">
          <TagsSection propertyId={lead.id} initial={initialTags} />
        </div>
      </div>

      <div>
        <div className="text-muted-foreground mb-2 text-xs font-semibold tracking-wide uppercase">
          Notes
        </div>
        <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_320px]">
          <div className="border-border rounded-md border p-3">
            <NotesFeed
              propertyId={lead.id}
              initial={initialNotes}
              authorEmails={authorEmails}
              currentUserId={sessionUser?.id ?? null}
              currentUserEmail={sessionUser?.email ?? null}
            />
          </div>
          <LeadCallSummary
            propertyId={lead.id}
            initialRows={initialCallRows}
            jitterHost={process.env.NEXT_PUBLIC_JITTER_HOST ?? ""}
          />
        </div>
      </div>

      <div>
        <div className="text-muted-foreground mb-2 text-xs font-semibold tracking-wide uppercase">
          Identifiers
        </div>
        <div className="border-border rounded-md border">
          <Row label="APN" value={lead.apn} mono />
          <Row label="ZPID" value={lead.zpid} mono />
          <Row label="MLS #" value={lead.mls_number} mono />
          <Row label="FIPS" value={lead.fips_code} mono />
          <Row label="Regrid" value={lead.regrid_id} mono />
          <Row label="ATTOM" value={lead.attom_id} mono />
        </div>
      </div>
    </Page>
  );
}

function LockedDncPropertyDetail({
  lead,
  prevId,
  nextId,
}: {
  lead: DetailedLead;
  prevId: string | null;
  nextId: string | null;
}) {
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
          { label: "Prospects", href: "/properties" },
          { label: lead.address },
        ]}
        title={lead.address}
        description={
          [lead.city, lead.state, lead.zip].filter(Boolean).join(", ") || "—"
        }
        actions={
          <div className="flex items-center gap-1">
            <Link href="/properties">
              <Button variant="outline" size="sm" aria-label="Back to prospects">
                <ChevronLeft className="mr-1 h-4 w-4" />
                Back to prospects
              </Button>
            </Link>
            {zillowHref ? (
              <a href={zillowHref} target="_blank" rel="noopener noreferrer">
                <Button variant="outline" size="sm">
                  <ExternalLink className="mr-1 h-4 w-4" />
                  Zillow
                </Button>
              </a>
            ) : null}
            {prevId ? (
              <Link href={`/leads/${prevId}`}>
                <Button variant="ghost" size="icon" aria-label="Previous prospect">
                  <ChevronLeft className="h-4 w-4" />
                </Button>
              </Link>
            ) : null}
            {nextId ? (
              <Link href={`/leads/${nextId}`}>
                <Button variant="ghost" size="icon" aria-label="Next prospect">
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
          This record is permanently locked and read-only. Its historical pipeline stage is preserved for audit history.
        </p>
      </div>

      <div className="flex flex-wrap gap-2">
        <Badge variant="outline">Historical stage: {lead.status.replaceAll("_", " ")}</Badge>
        {lead.market ? <Badge variant="secondary">{lead.market}</Badge> : null}
        {lead.outreach_dispo ? (
          <Badge variant="outline">Disposition: {lead.outreach_dispo.replaceAll("_", " ")}</Badge>
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
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-2">
      <div className="text-muted-foreground text-xs font-semibold tracking-wide uppercase">
        {title}
      </div>
      <div className="border-border flex flex-col rounded-md border">
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
}: {
  label: string;
  value: string | number | null | undefined;
  format?: "currency";
  mono?: boolean;
}) {
  const display =
    value == null || value === ""
      ? "—"
      : format === "currency" && typeof value === "number"
        ? `$${value.toLocaleString()}`
        : String(value);
  return (
    <div className="border-border/60 flex justify-between gap-3 border-b px-3 py-2 text-sm last:border-b-0">
      <span className="text-muted-foreground">{label}</span>
      <span className={mono ? "font-mono" : undefined} title={display}>
        {display}
      </span>
    </div>
  );
}

function EmptyRow({ text }: { text: string }) {
  return (
    <div className="text-muted-foreground px-3 py-2 text-sm">{text}</div>
  );
}

function formatDate(iso: string | null | undefined): string | null {
  if (!iso) return null;
  return new Date(iso).toLocaleDateString();
}

function formatBool(v: boolean | null | undefined): string | null {
  if (v == null) return null;
  return v ? "Yes" : "No";
}
