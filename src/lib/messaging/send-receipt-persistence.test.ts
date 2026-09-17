import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/types";

vi.mock("@/lib/leads/training", () => ({ assertNotTrainingTarget: vi.fn().mockResolvedValue(undefined) }));
vi.mock("./registry", () => ({ getMessagingProvider: vi.fn() }));
vi.mock("./consent", () => ({ getConsentState: vi.fn().mockResolvedValue("can_send_marketing") }));
vi.mock("./opt-out-phone", () => ({ isSmsPhoneSuppressed: vi.fn().mockResolvedValue(false) }));
vi.mock("./quiet-hours", () => ({ checkQuietHours: vi.fn().mockReturnValue({ ok: true }) }));
vi.mock("@/lib/messages/threading", () => ({ ensureConversationIdForThread: vi.fn().mockResolvedValue("conversation-1") }));
vi.mock("./status-events", () => ({
  reconcileStoredStatusEvents: vi.fn().mockResolvedValue({
    candidates: 0,
    processed: 0,
    failed: 0,
    failures: [],
  }),
}));

import { getMessagingProvider } from "./registry";
import { reconcileStoredStatusEvents } from "./status-events";
import { releaseQueuedMessage, sendSmsToContact } from "./send";

const MESSAGE_ID = "11111111-1111-4111-8111-111111111111";
const CONTACT_ID = "22222222-2222-4222-8222-222222222222";
const PROPERTY_ID = "33333333-3333-4333-8333-333333333333";
const ORG_ID = "44444444-4444-4444-8444-444444444444";
const RECEIPT = { externalId: "accepted-external-id", providerStatus: "queued", raw: { accepted: true } };
const success = { data: { id: MESSAGE_ID }, error: null };
type Result = { data: unknown; error: { code?: string; message: string } | null };
type Write = { payload: Record<string, unknown>; filters: Array<[string, unknown]>; accepted: boolean };

/** Records real query construction and returns scripted receipt responses only.
 * Preflight reads and the initial pending claim succeed independently. */
function database(receipts: Array<Result | Error>, providerAccepted: () => boolean) {
  const writes: Write[] = [];
  let receiptAttempts = 0;
  const client = {
    from(table: string) {
      let write: Write | undefined;
      let inserted = false;
      const resolve = async (): Promise<Result> => {
        if (write) {
          if (write.payload.status === "sent") {
            const result = receipts[receiptAttempts++];
            if (!result) throw new Error("unexpected extra receipt attempt");
            if (result instanceof Error) throw result;
            return result;
          }
          return success;
        }
        if (inserted) return success;
        if (table === "contacts") return { data: {
          id: CONTACT_ID, phone_1: "+15005550006", phone_1_type: "mobile",
          phone_2: null, phone_2_type: null, phone_3: null, phone_3_type: null,
          do_not_contact: false, sms_opted_out: false,
        }, error: null };
        if (table === "properties") return { data: { id: PROPERTY_ID, org_id: ORG_ID, state: "MO", outreach_dispo: null }, error: null };
        if (table === "messages") return { data: {
          id: MESSAGE_ID, org_id: ORG_ID, status: "queued", provider: "receipt-test",
          contact_id: CONTACT_ID, property_id: PROPERTY_ID, campaign_id: null,
          body: "hello", from_address: "+18165551234", to_address: "+15005550006",
          scheduled_for: null, metadata: { sendOrigin: "manual", audit: "preserve" },
        }, error: null };
        throw new Error(`unexpected table ${table}`);
      };
      const builder = {
        select: () => builder,
        eq: (key: string, value: unknown) => { write?.filters.push([key, value]); return builder; },
        insert: () => { inserted = true; return builder; },
        update: (payload: Record<string, unknown>) => {
          write = { payload: structuredClone(payload), filters: [], accepted: providerAccepted() };
          writes.push(write);
          return builder;
        },
        single: resolve,
        maybeSingle: resolve,
        then: (fulfilled: (value: Result) => unknown, rejected?: (error: unknown) => unknown) => resolve().then(fulfilled, rejected),
      };
      return builder;
    },
  } as unknown as SupabaseClient<Database>;
  return { client, writes, receiptCount: () => receiptAttempts };
}

beforeEach(() => {
  vi.mocked(reconcileStoredStatusEvents).mockReset().mockResolvedValue({ candidates: 0, processed: 0, failed: 0, failures: [] });
});

for (const mode of ["immediate", "queued"] as const) {
  describe(`${mode} accepted SMS receipt persistence`, () => {
    async function exercise(responses: Array<Result | Error>, expectedStatus: "sent" | "db_error", attempts: number) {
      let accepted = false;
      const provider = {
        providerId: "receipt-test",
        sendSms: vi.fn().mockImplementation(async () => { accepted = true; return RECEIPT; }),
        verifyWebhookSignature: () => true,
        parseInboundWebhook: () => [],
      };
      vi.mocked(getMessagingProvider).mockReturnValue(provider);
      const db = database(responses, () => accepted);
      const outcome = mode === "immediate"
        ? await sendSmsToContact(db.client, {
            origin: "manual", contactId: CONTACT_ID, propertyId: PROPERTY_ID,
            body: "hello", from: "+18165551234", metadata: { audit: "preserve" },
          })
        : await releaseQueuedMessage(db.client, MESSAGE_ID);
      expect(outcome.status).toBe(expectedStatus);
      expect(provider.sendSms).toHaveBeenCalledTimes(1);
      expect(db.receiptCount()).toBe(attempts);
      const acceptedWrites = db.writes.filter((write) => write.accepted);
      expect(acceptedWrites).toHaveLength(attempts);
      for (const write of acceptedWrites) {
        expect(write.filters).toEqual([["id", MESSAGE_ID], ["status", "pending"]]);
        expect(write.payload).toEqual(acceptedWrites[0].payload);
        expect(write.payload).toMatchObject({ status: "sent", external_id: RECEIPT.externalId,
          metadata: { audit: "preserve", providerStatus: RECEIPT.providerStatus, raw: RECEIPT.raw },
        });
        expect(write.payload.sent_at).toEqual(expect.any(String));
      }
      return { outcome, db };
    }

    it.each(["40P01", "40001"])("retries a returned %s abort without sending again", async (code) => {
      await exercise([{ data: null, error: { code, message: "transaction aborted" } }, success], "sent", 2);
      expect(reconcileStoredStatusEvents).toHaveBeenCalledTimes(1);
    });

    it.each(["40P01", "40001"])("stops after three returned %s aborts", async (code) => {
      await exercise(Array.from({ length: 3 }, () => ({ data: null, error: { code, message: "transaction aborted" } })), "db_error", 3);
      expect(reconcileStoredStatusEvents).not.toHaveBeenCalled();
    });

    it.each(["23505", undefined])("does not retry code %s even if text mentions retryable SQLSTATEs", async (code) => {
      await exercise([{ data: null, error: { code, message: "40P01 deadlock detected; 40001 serialization" } }], "db_error", 1);
      expect(reconcileStoredStatusEvents).not.toHaveBeenCalled();
    });

    it("does not mark failed or requeue after an ambiguous receipt transport failure", async () => {
      await exercise([new Error("network connection reset")], "db_error", 1);
      expect(reconcileStoredStatusEvents).not.toHaveBeenCalled();
    });

    it("does not retry a thrown error merely because it carries a retryable code", async () => {
      const transportError = Object.assign(new Error("ambiguous transport failure"), { code: "40001" });
      await exercise([transportError], "db_error", 1);
      expect(reconcileStoredStatusEvents).not.toHaveBeenCalled();
    });

    it("does not claim success when the pending-status compare-and-set matches no row", async () => {
      await exercise([{ data: null, error: null }], "db_error", 1);
      expect(reconcileStoredStatusEvents).not.toHaveBeenCalled();
    });

    it("does not reinterpret reconciliation failure as provider failure", async () => {
      vi.mocked(reconcileStoredStatusEvents).mockRejectedValueOnce(new Error("status reconciliation failed"));
      await exercise([success], "db_error", 1);
      expect(reconcileStoredStatusEvents).toHaveBeenCalledExactlyOnceWith(expect.anything(), "receipt-test", RECEIPT.externalId);
    });
  });
}
