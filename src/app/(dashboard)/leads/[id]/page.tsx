import Link from "next/link";
import { notFound } from "next/navigation";

import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import { createClient } from "@/lib/supabase/server";

import type { DetailedLead, PropertyStatus } from "../actions";

import { LeadStatusWidget } from "./status-widget";

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
          <Section title="Notes">
            <div className="whitespace-pre-wrap p-3 text-sm">{lead.notes}</div>
          </Section>
        ) : null}
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
