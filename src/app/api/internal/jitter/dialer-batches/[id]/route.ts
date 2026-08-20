import { NextResponse } from "next/server";

import { classifyItem } from "@/lib/dialer/eligibility";
import { buildSnapshotsForProperty } from "@/lib/dialer/snapshot-identity";
import { reportError } from "@/lib/errors/report";

import { authenticateJitterWriteback } from "../../_lib/auth";

type RouteContext = { params: Promise<{ id: string }> };

type ItemRow = {
  id: string;
  batch_id: string;
  property_id: string;
  contact_id: string;
  phone_e164: string;
  phone_label: string;
  state: string;
  timezone: string;
  status: string;
  sort_order: number;
  calling_window_start_hour: number;
  calling_window_end_hour: number;
  property:
    | { id: string; state: string | null; is_dnc_locked: boolean }
    | { id: string; state: string | null; is_dnc_locked: boolean }[]
    | null;
  contact:
    | {
        id: string;
        phone_1: string | null;
        phone_2: string | null;
        phone_3: string | null;
        do_not_contact: boolean;
        sms_opted_out: boolean;
      }
    | Array<{
        id: string;
        phone_1: string | null;
        phone_2: string | null;
        phone_3: string | null;
        do_not_contact: boolean;
        sms_opted_out: boolean;
      }>
    | null;
};

function one<T>(value: T | T[] | null): T | null {
  return Array.isArray(value) ? (value[0] ?? null) : value;
}

function itemEligibility(row: ItemRow) {
  const property = one(row.property);
  const contact = one(row.contact);
  if (!property || !contact) return { status: "blocked", reason: "no_contact" };

  const snapshots = buildSnapshotsForProperty(property, contact);
  const index = snapshots.findIndex(
    (snapshot) =>
      snapshot.phone_e164 === row.phone_e164 &&
      snapshot.phone_label === row.phone_label,
  );
  const classifications = classifyItem({
    property: { id: property.id, state: property.state, is_dnc_locked: property.is_dnc_locked },
    contact,
  });
  const classification = classifications[index] ?? "missing";

  if (classification === "callable") return { status: "callable" };
  if (classification === "missing") return { status: "missing" };
  return { status: "blocked", reason: classification.blocked };
}

export async function GET(
  request: Request,
  context: RouteContext,
): Promise<NextResponse> {
  try {
    const auth = await authenticateJitterWriteback(request);
    if (!auth.ok) return auth.response;

    const { id } = await context.params;
    const includeItems =
      new URL(request.url).searchParams.get("include") === "items" ||
      new URL(request.url).searchParams.get("eligibility") === "fresh";

    const { data: batch, error: batchError } = await (auth.serviceClient as any)
      .from("dialer_batches")
      .select(
        "id, org_id, title, source_kind, source_meta, status, jitter_session_id, claim_generation, claimed_at, completed_at, created_at, updated_at",
      )
      .eq("id", id)
      .eq("org_id", auth.orgId)
      .maybeSingle();

    if (batchError) throw batchError;
    if (!batch) {
      return NextResponse.json({ error: "not_found" }, { status: 404 });
    }

    if (!includeItems) {
      return NextResponse.json({ batch });
    }

    const { data: items, error: itemError } = await (auth.serviceClient as any)
      .from("dialer_batch_items")
      .select(
        `id, batch_id, property_id, contact_id, phone_e164, phone_label, state, timezone, status, sort_order,
         calling_window_start_hour, calling_window_end_hour,
         property:properties!dialer_batch_items_property_id_fkey(id, state, is_dnc_locked),
         contact:contacts!dialer_batch_items_contact_id_fkey(id, phone_1, phone_2, phone_3, do_not_contact, sms_opted_out)`,
      )
      .eq("batch_id", id)
      .order("sort_order", { ascending: true });

    if (itemError) throw itemError;

    return NextResponse.json({
      batch,
      items: ((items ?? []) as ItemRow[]).map((item) => ({
        id: item.id,
        batch_id: item.batch_id,
        property_id: item.property_id,
        contact_id: item.contact_id,
        phone_e164: item.phone_e164,
        phone_label: item.phone_label,
        state: item.state,
        timezone: item.timezone,
        status: item.status,
        sort_order: item.sort_order,
        calling_window_start_hour: item.calling_window_start_hour,
        calling_window_end_hour: item.calling_window_end_hour,
        eligibility: itemEligibility(item),
      })),
    });
  } catch (e) {
    reportError(e, { tags: { surface: "jitter_get_dialer_batch" } });
    return NextResponse.json({ error: "internal_error" }, { status: 500 });
  }
}
