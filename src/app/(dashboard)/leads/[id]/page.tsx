import Link from "next/link";
import { notFound } from "next/navigation";

import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

import {
  markMessagesReadForProperty,
  type DetailedLead,
  type PropertyStatus,
} from "../actions";

import { CassWidget } from "./cass-widget";
import { InlineReply } from "./inline-reply";
import { LeadAssigneeWidget } from "./assignee-widget";
import { LeadMotivationWidget } from "./motivation-widget";
import { LeadStatusWidget } from "./status-widget";
import { MessagesThread } from "./messages-thread";
import { NotesFeed } from "./notes-feed";
import { SmsComposer } from "./sms-composer";
import { TagsSection } from "./tags-section";
import type { MotivationLevel } from "../actions";
import type { TagRow } from "../tags-actions";
import type { Database } from "@/lib/supabase/types";

type MessageRow = Database["public"]["Tables"]["messages"]["Row"];
type LeadNoteRow = Database["public"]["Tables"]["lead_notes"]["Row"];

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
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("properties")
    .select(
      `*,
       homeowner:contacts!properties_homeowner_contact_id_fkey(
         *,
         homeowner_details(*)
       ),
       agent:contacts!properties_agent_contact_id_fkey(
         *,
         agent_details(*)
       )`,
    )
    .eq("id", id)
    .maybeSingle();

  if (error) {
    return (
      <div className="p-6">
        <Link
          href="/leads"
          className={buttonVariants({ variant: "ghost", size: "sm" })}
        >
          ← Back to leads
        </Link>
        <div className="text-destructive mt-4 text-sm">
          Failed to load lead: {error.message}
        </div>
      </div>
    );
  }

  if (!data) {
    notFound();
  }

  const lead = data as DetailedLead;

  // Current user — for "me" labeling in assignee + note-author displays.
  const {
    data: { user: sessionUser },
  } = await supabase.auth.getUser();

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

  // Resolve author + assignee emails via the admin client (auth.users isn't
  // RLS-accessible to end-users). Batched into a single listUsers() call.
  const userIdsNeeded = new Set<string>();
  if (lead.assigned_user_id) userIdsNeeded.add(lead.assigned_user_id);
  for (const n of initialNotes) {
    if (n.author_user_id) userIdsNeeded.add(n.author_user_id);
  }
  const authorEmails: Record<string, string> = {};
  let assigneeEmail: string | null = null;
  if (userIdsNeeded.size > 0) {
    try {
      const admin = createAdminClient();
      const { data: usersPage } = await admin.auth.admin.listUsers({
        perPage: 200,
      });
      for (const u of usersPage?.users ?? []) {
        if (u.email && userIdsNeeded.has(u.id)) {
          authorEmails[u.id] = u.email;
        }
      }
      if (lead.assigned_user_id) {
        assigneeEmail = authorEmails[lead.assigned_user_id] ?? null;
      }
    } catch {
      // Non-fatal — emails just won't display pretty. The IDs stay intact.
    }
  }

  return (
    <div className="flex flex-col gap-5 p-6">
      <div>
        <Link
          href="/leads"
          className={buttonVariants({ variant: "ghost", size: "sm" })}
        >
          ← Back to leads
        </Link>
      </div>

      <header className="border-border flex flex-col gap-2 border-b pb-4">
        <h1 className="text-2xl font-semibold">{lead.address}</h1>
        <div className="text-muted-foreground text-sm">
          {[lead.city, lead.state, lead.zip].filter(Boolean).join(", ") || "—"}
        </div>
        <div className="mt-1 flex flex-wrap items-center gap-1.5">
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
            homeownerPhone={lead.homeowner?.phone_1 ?? null}
            homeownerName={
              lead.homeowner?.contact_type === "entity"
                ? lead.homeowner.entity_name
                : lead.homeowner
                  ? [lead.homeowner.first_name, lead.homeowner.last_name]
                      .filter(Boolean)
                      .join(" ") || null
                  : null
            }
          />
        </div>
      </header>

      <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
        <Section title="Property">
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

        <Section title="Identifiers">
          <Row label="APN" value={lead.apn} mono />
          <Row label="ZPID" value={lead.zpid} mono />
          <Row label="MLS #" value={lead.mls_number} mono />
          <Row label="FIPS" value={lead.fips_code} mono />
          <Row label="Regrid" value={lead.regrid_id} mono />
          <Row label="ATTOM" value={lead.attom_id} mono />
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
                value={[
                  lead.homeowner.homeowner_details?.mailing_address,
                  lead.homeowner.homeowner_details?.mailing_city,
                  lead.homeowner.homeowner_details?.mailing_state,
                  lead.homeowner.homeowner_details?.mailing_zip,
                ]
                  .filter(Boolean)
                  .join(", ") || null}
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
        <div className="border-border rounded-md border p-3">
          <NotesFeed
            propertyId={lead.id}
            initial={initialNotes}
            authorEmails={authorEmails}
            currentUserId={sessionUser?.id ?? null}
            currentUserEmail={sessionUser?.email ?? null}
          />
        </div>
      </div>

      <div>
        <div className="text-muted-foreground mb-2 text-xs font-semibold tracking-wide uppercase">
          SMS thread
        </div>
        <div className="border-border rounded-md border p-3">
          <MessagesThread
            initial={initialMessages}
            contactId={lead.homeowner?.id ?? null}
            propertyId={lead.id}
          />
          <InlineReply
            propertyId={lead.id}
            homeownerContactId={lead.homeowner?.id ?? null}
            homeownerPhone={lead.homeowner?.phone_1 ?? null}
          />
        </div>
      </div>
    </div>
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
