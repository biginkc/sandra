import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { createTestClient } from "@tests/integration/client";
import {
  clientForUser,
  createOrgUser,
} from "@tests/integration/fixtures/multi-user";
import { resetTenantTables } from "@tests/integration/reset";

import type { SendilloSmsHealthMessageRow } from "./sendillo-health";
import { summarizeSendilloSmsHealth } from "./sendillo-health";
import { captureSendilloSmsHealthSnapshot } from "./sendillo-health-snapshot";

const supabase = createTestClient();
const createdUserIds: string[] = [];

afterAll(async () => {
  for (const userId of createdUserIds) {
    await supabase.auth.admin.deleteUser(userId);
  }
});

async function getOrgId(): Promise<string> {
  const { data } = await supabase
    .from("organizations")
    .select("id")
    .limit(1)
    .single();
  if (!data) throw new Error("no organization seeded in test project");
  return data.id;
}

async function seedProperty(args: {
  address: string;
  outreachDispo?: string | null;
  needsHumanAttention?: boolean;
}) {
  const orgId = await getOrgId();
  const { data: contact, error: contactError } = await supabase
    .from("contacts")
    .insert({ org_id: orgId, first_name: "Snapshot", phone_1_type: "unknown" })
    .select("id")
    .single();
  if (contactError || !contact) throw new Error(contactError?.message);
  const { data: property, error: propertyError } = await supabase
    .from("properties")
    .insert({
      org_id: orgId,
      address: args.address,
      state: "MO",
      homeowner_contact_id: contact.id,
      outreach_dispo: args.outreachDispo ?? null,
      needs_human_attention: args.needsHumanAttention ?? false,
    })
    .select("id")
    .single();
  if (propertyError || !property) throw new Error(propertyError?.message);
  return { orgId, contactId: contact.id, propertyId: property.id };
}

describe("Sendillo health snapshot SQL parity", () => {
  beforeEach(async () => {
    await resetTenantTables(supabase);
  });

  it("matches the existing calculation including queued-row asymmetry", async () => {
    const open = await seedProperty({
      address: "100 Snapshot St",
      needsHumanAttention: true,
    });
    const dispositioned = await seedProperty({
      address: "200 Snapshot St",
      outreachDispo: "not_interested",
    });

    const rows = [
      {
        org_id: open.orgId,
        channel: "sms",
        provider: "sendillo",
        direction: "outbound",
        status: "sent",
        contact_id: open.contactId,
        property_id: open.propertyId,
        body: "sent",
        created_at: "2026-08-10T10:00:00.000Z",
      },
      {
        org_id: open.orgId,
        channel: "sms",
        provider: "sendillo",
        direction: "inbound",
        status: "received",
        contact_id: open.contactId,
        property_id: open.propertyId,
        body: "reply",
        read_at: null,
        created_at: "2026-08-10T10:05:00.000Z",
      },
      {
        org_id: open.orgId,
        channel: "sms",
        provider: "sendillo",
        direction: "outbound",
        status: "queued",
        contact_id: open.contactId,
        property_id: open.propertyId,
        body: "queued later",
        created_at: "2026-08-10T10:10:00.000Z",
      },
      {
        org_id: dispositioned.orgId,
        channel: "sms",
        provider: "sendillo",
        direction: "inbound",
        status: "received",
        contact_id: dispositioned.contactId,
        property_id: dispositioned.propertyId,
        body: "already handled",
        read_at: "2026-08-10T10:16:00.000Z",
        created_at: "2026-08-10T10:15:00.000Z",
      },
      {
        org_id: open.orgId,
        channel: "sms",
        provider: "dialpad",
        direction: "inbound",
        status: "received",
        contact_id: open.contactId,
        property_id: open.propertyId,
        body: "excluded provider",
        created_at: "2026-08-10T10:20:00.000Z",
      },
    ];
    const { error: insertError } = await supabase.from("messages").insert(rows);
    if (insertError) throw new Error(insertError.message);

    const { data: storedRows, error: rowsError } = await supabase
      .from("messages")
      .select(
        "id, channel, provider, direction, status, contact_id, property_id, conversation_id, created_at, read_at",
      );
    if (rowsError) throw new Error(rowsError.message);
    const expected = summarizeSendilloSmsHealth(
      storedRows as SendilloSmsHealthMessageRow[],
      new Map([
        [
          open.propertyId,
          {
            id: open.propertyId,
            outreach_dispo: null,
            needs_human_attention: true,
          },
        ],
        [
          dispositioned.propertyId,
          {
            id: dispositioned.propertyId,
            outreach_dispo: "not_interested",
            needs_human_attention: false,
          },
        ],
      ]),
    );

    const actual = await captureSendilloSmsHealthSnapshot(
      supabase,
      new Date("2026-08-10T10:30:00.000Z"),
    );

    expect(actual.health).toMatchObject({
      ...expected,
      firstMessageAt: expect.any(String),
      latestMessageAt: expect.any(String),
    });
    expect(new Date(actual.health.firstMessageAt!).toISOString()).toBe(
      new Date(expected.firstMessageAt!).toISOString(),
    );
    expect(new Date(actual.health.latestMessageAt!).toISOString()).toBe(
      new Date(expected.latestMessageAt!).toISOString(),
    );
    expect(actual.health).toMatchObject({
      smsRows: 4,
      outboundMessages: 1,
      inboundMessages: 2,
      conversations: 2,
      latestInboundMissingDisposition: 1,
      unreadMissingDisposition: 1,
      humanAttentionMissingDisposition: 1,
      anyInboundMissingDisposition: 1,
    });
  });

  it("keeps the newer stored snapshot when an older capture arrives later", async () => {
    await captureSendilloSmsHealthSnapshot(
      supabase,
      new Date("2026-08-10T12:00:00.000Z"),
    );
    const older = await captureSendilloSmsHealthSnapshot(
      supabase,
      new Date("2026-08-10T11:00:00.000Z"),
    );
    expect(new Date(older.updatedAt).toISOString()).toBe(
      "2026-08-10T12:00:00.000Z",
    );
  });

  it("allows active users to read the global snapshot and blocks suspended users", async () => {
    const orgId = await getOrgId();
    await captureSendilloSmsHealthSnapshot(
      supabase,
      new Date("2026-08-10T12:00:00.000Z"),
    );
    const user = await createOrgUser(supabase, {
      orgId,
      email: `snapshot-access-${crypto.randomUUID()}@bmhgroupkc.com`,
      role: "member",
    });
    createdUserIds.push(user.userId);
    const userClient = clientForUser(user.jwt);

    const activeRead = await userClient
      .from("dashboard_snapshots")
      .select("snapshot_key")
      .eq("snapshot_key", "sendillo_sms_health");
    expect(activeRead.error).toBeNull();
    expect(activeRead.data).toEqual([{ snapshot_key: "sendillo_sms_health" }]);

    const { error: suspendError } = await supabase
      .from("memberships")
      .update({ access_status: "suspended" })
      .eq("user_id", user.userId)
      .eq("org_id", orgId);
    expect(suspendError).toBeNull();

    const suspendedRead = await userClient
      .from("dashboard_snapshots")
      .select("snapshot_key")
      .eq("snapshot_key", "sendillo_sms_health");
    expect(suspendedRead.error).toBeNull();
    expect(suspendedRead.data).toEqual([]);
  });
});
