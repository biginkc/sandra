import { randomUUID } from "node:crypto";

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { Client } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { BMH_ORG_ID, getCanonicalTestOrgId } from "@tests/integration/fixtures/multi-user";
import { MOCK_SENDER_PRIMARY, seedSenderCatalog } from "@tests/integration/delivery";
import { APPROVED_REPLY_TEXTS } from "@/lib/ai-responder/approved-reply-texts";
import { dispatchAiResponse } from "@/lib/ai-responder/dispatch";
import type { AnthropicLike } from "@/lib/ai-responder/generate";
import { handleInboundWebhook } from "@/lib/messaging/inbound";
import { MockMessagingProvider, resetMockState } from "@/lib/messaging/providers/mock";
import { NINE_QUESTION_CUTOFF, NINE_QUESTION_IDS, type NineQuestionId } from "@/lib/sms-classification/nine-questions";
import type { Database } from "@/lib/supabase/types";
import { assertLocalOnlyTestEnv } from "@/lib/testing/local-only-test-env";

import { assertStressDbEnv } from "./core";

/**
 * Retained review findings against the Messages v2 candidate (PR 4 candidate 729a282b, which
 * contains PR 2 4d50e19a and PR 3 2cc9d675), as REAL regression tests on a disposable stack.
 * Each asserts the DESIRED behaviour. A product defect shows as an expected failure (`it.fails`,
 * labelled [KNOWN DEFECT]): the suite stays green while the defect exists, and turns RED the day
 * the product is fixed, so the marker must then be removed. Nothing here is a todo.
 *
 * Same fail-closed rails as the dispatch lane (core.ts assertStressDbEnv): explicit loopback
 * bindings off the dev-stack ports, MV2_STRESS_DISPOSABLE_DB=1, no provider credential, mock SMS
 * provider, stub Jev (no paid call; any non-loopback HTTP throws).
 *
 *   npm run stress:messages-v2:db   (vitest.messages-v2-stress.config.ts runs this file too)
 *
 * The pure (DB-free) finding, PR 892 homeowner badge query count, lives in retained-findings.test.ts.
 */
vi.mock("@/lib/messaging/quiet-hours", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/messaging/quiet-hours")>()),
  checkQuietHours: () => ({ ok: true, localTime: "12:00", zone: "America/Chicago" }),
}));
vi.mock("@/lib/messaging/quiet-hours-recipient", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/messaging/quiet-hours-recipient")>()),
  checkRecipientQuietHours: () => ({ ok: true, state: "MO", localTime: "12:00", florida: false }),
}));
// The delayed-reply path hands a non-keyword text to the delay workflow; never start a real one.
const workflowStarts: unknown[] = [];
vi.mock("workflow/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("workflow/api")>()),
  start: async (...args: unknown[]) => {
    workflowStarts.push(args);
    return { runId: `stress-${randomUUID()}` };
  },
}));

/**
 * Expected-failure marker. MV2_RETAINED_STRICT=1 runs the same tests as plain `it` so the real
 * assertion message of each defect is visible (the run is then red while the defect exists).
 */
const knownDefect = process.env.MV2_RETAINED_STRICT === "1" ? it : it.fails;

const NO_ANTHROPIC: AnthropicLike = {
  messages: {
    create: async () => {
      throw new Error("Claude must not be called on the nine-question path");
    },
  } as unknown as AnthropicLike["messages"],
};

const pg = new Client({ connectionString: process.env.TEST_SUPABASE_DB_URL });
const supabase = createClient<Database>(process.env.TEST_SUPABASE_URL!, process.env.TEST_SUPABASE_SERVICE_ROLE_KEY!, {
  auth: { persistSession: false, autoRefreshToken: false },
});
const realFetch = globalThis.fetch;
let orgId = "";
let phoneCounter = 0;
/** The nine answer the stub Jev pushes over the cutoff for the next call (null = nothing over it). */
let stubAnswer: NineQuestionId | null = null;

function installStubJev() {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (url.startsWith("https://api.typesafe.ai/")) {
      const answers = Object.fromEntries(
        NINE_QUESTION_IDS.map((id) => [id, { choice: "noul", noul: id === stubAnswer ? NINE_QUESTION_CUTOFF + 0.2 : 0.02 }]),
      );
      return new Response(JSON.stringify({ answers, model: "jev-stub", usage: { input_tokens: 1, output_tokens: 1 } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    const host = new URL(url).hostname;
    if (host !== "127.0.0.1" && host !== "localhost") throw new Error(`unexpected outbound HTTP in retained findings: ${url}`);
    return realFetch(input, init);
  }) as typeof fetch;
}

/* ------------------------------------------------------------------------------------------
 * Client wrapper: inject a read error, or run a side effect just before one specific read.
 * Only the exact (table, select-columns) pair named is touched; everything else is the real client.
 * ---------------------------------------------------------------------------------------- */
/** `nth`: act on the nth matching read only (1-based; default every read for `fail`, the first for `before`). */
type Hook = { table: string; columns: string; fail?: true; before?: () => Promise<void>; nth?: number };

function injected(): unknown {
  const result = { data: null, error: { code: "XX000", message: "stress: injected read error" }, count: null, status: 500 };
  const p: unknown = new Proxy(
    {},
    {
      get(_t, k) {
        if (k === "then") return (res: (v: unknown) => unknown) => res(result);
        return () => p;
      },
    },
  );
  return p;
}

function deferred(real: () => { [k: string]: unknown }, before: () => Promise<void>): unknown {
  const calls: Array<[string, unknown[]]> = [];
  const p: unknown = new Proxy(
    {},
    {
      get(_t, k) {
        if (k === "then") {
          return async (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) => {
            try {
              await before();
              let q = real() as Record<string, (...a: unknown[]) => unknown>;
              for (const [m, a] of calls) q = q[m]!(...a) as Record<string, (...a: unknown[]) => unknown>;
              return res(await (q as unknown as PromiseLike<unknown>));
            } catch (e) {
              return rej(e);
            }
          };
        }
        return (...a: unknown[]) => {
          calls.push([String(k), a]);
          return p;
        };
      },
    },
  );
  return p;
}

function withHooks(client: SupabaseClient<Database>, hooks: Hook[]): SupabaseClient<Database> {
  const fired = new Set<Hook>();
  const seen = new Map<Hook, number>();
  return new Proxy(client, {
    get(target, key) {
      if (key === "from") {
        return (table: string) => {
          const builder = target.from(table as never) as unknown as Record<string | symbol, unknown>;
          return new Proxy(builder, {
            get(bt, bk) {
              if (bk === "select") {
                return (cols: string, opts?: unknown) => {
                  const hook = hooks.find((h) => {
                    if (h.table !== table || h.columns !== cols || (h.before && fired.has(h))) return false;
                    const n = (seen.get(h) ?? 0) + 1;
                    seen.set(h, n);
                    return h.nth === undefined || h.nth === n;
                  });
                  if (hook?.fail) return injected();
                  if (hook?.before) {
                    fired.add(hook);
                    return deferred(() => (bt.select as (c: string, o?: unknown) => { [k: string]: unknown }).call(bt, cols, opts), hook.before);
                  }
                  return (bt.select as (c: string, o?: unknown) => unknown).call(bt, cols, opts);
                };
              }
              const v = bt[bk];
              return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(bt) : v;
            },
          });
        };
      }
      const v = (target as unknown as Record<string | symbol, unknown>)[key];
      return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(target) : v;
    },
  });
}

/* ------------------------------------------------------------------------------------------
 * Seeding (throwaway database only; guarded in beforeAll).
 * ---------------------------------------------------------------------------------------- */
async function seedOrg() {
  await supabase.from("ai_responder_configs").delete().eq("org_id", orgId);
  const { error } = await supabase.from("ai_responder_configs").insert({
    org_id: orgId,
    system_prompt: "retained findings",
    business_hours_only: false,
    classifier_provider: "jev",
    classifier_mode: "automatic",
    classifier_engine: "nine_questions",
  });
  expect(error).toBeNull();
  await pg.query("delete from public.jev_outcome_thresholds where org_id = $1", [orgId]);
  for (const outcome of ["nurture", "not_interested", "wrong_number", "new_lead"]) {
    await pg.query("insert into public.jev_outcome_thresholds (org_id, outcome, min_confidence, automation_enabled) values ($1, $2, 0.9, true)", [orgId, outcome]);
  }
  for (const name of ["Maybe later", "Asked who is texting", "Not interested", "Confirmed owner"]) {
    const { data: seq, error: seqError } = await supabase.from("sequences").insert({ org_id: orgId, name, active: true }).select("id").single();
    expect(seqError).toBeNull();
    // Step bodies are placeholders on a throwaway database, never sent anywhere.
    await supabase.from("sequence_steps").insert([
      { sequence_id: seq!.id, step_index: 0, delay_after_previous_minutes: 0, action_type: "send_sms", template_body: `RETAINED ${name} step one` },
    ]);
  }
  for (const [outcome, content] of [
    ["nurture", APPROVED_REPLY_TEXTS.nurture],
    ["not_interested", APPROVED_REPLY_TEXTS.not_interested],
    ["wrong_number", APPROVED_REPLY_TEXTS.wrong_number],
  ] as const) {
    await pg.query("begin");
    await pg.query("select set_config('sandra.template_approval', 'on', true)");
    const { rows } = await pg.query(
      "insert into public.sms_templates (org_id, name, content, approved_for_auto_send, approved_content, approved_at) values ($1, $2, $3, true, $3, now()) returning id",
      [orgId, `Auto reply ${outcome}`, content],
    );
    await pg.query("insert into public.auto_reply_templates (org_id, outcome, template_id) values ($1, $2, $3)", [orgId, outcome, rows[0].id]);
    await pg.query("commit");
  }
}

async function seedOwner(): Promise<string> {
  const id = randomUUID();
  await pg.query("insert into auth.users (id, email, aud, role, instance_id) values ($1, $2, 'authenticated', 'authenticated', '00000000-0000-0000-0000-000000000000')", [id, `retained-owner-${id}@test.local`]);
  await pg.query("insert into public.memberships (user_id, org_id, role) values ($1, $2, 'owner')", [id, orgId]);
  await pg.query("insert into public.acquisition_org_settings (org_id, my_leads_enabled) values ($1, true) on conflict (org_id) do update set my_leads_enabled = true", [orgId]);
  await pg.query("begin");
  try {
    await pg.query("select set_config('my_leads.designation_update', $1, true)", [`:${orgId}:${id}`]);
    await pg.query("update public.memberships set acquisitions_enabled = true where org_id = $1 and user_id = $2", [orgId, id]);
    await pg.query("commit");
  } catch (error) {
    await pg.query("rollback");
    throw error;
  }
  return id;
}

type Lead = { propertyId: string; contactId: string; phone: string };

async function seedLead(opts: { disabled?: boolean } = {}): Promise<Lead> {
  const phone = `+1816756${String(1000 + phoneCounter++).padStart(4, "0")}`;
  const { data: contact } = await supabase.from("contacts").insert({ org_id: orgId, first_name: "Retained", last_name: "Seller", phone_1: phone, phone_1_type: "mobile" }).select("id").single();
  await supabase.from("consent_events").insert({ contact_id: contact!.id, channel: "sms", event_type: "opt_in_marketing_written", source: "mv2-retained", org_id: orgId });
  const { data: property, error } = await supabase
    .from("properties")
    .insert({ org_id: orgId, address: "RETAINED 123 Oak St", state: "MO", status: "prospect", homeowner_contact_id: contact!.id, ...(opts.disabled ? { ai_responder_disabled: true } : {}) })
    .select("id")
    .single();
  expect(error).toBeNull();
  return { propertyId: property!.id, contactId: contact!.id, phone };
}

async function seedThread(lead: Lead, ourText: string, reply: string) {
  await supabase.from("messages").insert({ org_id: orgId, channel: "sms", direction: "outbound", status: "delivered", property_id: lead.propertyId, contact_id: lead.contactId, from_address: MOCK_SENDER_PRIMARY, to_address: lead.phone, body: ourText, created_at: new Date(Date.now() - 3600_000).toISOString() });
  const { data: inbound, error } = await supabase
    .from("messages")
    .insert({ org_id: orgId, channel: "sms", direction: "inbound", status: "received", property_id: lead.propertyId, contact_id: lead.contactId, from_address: lead.phone, to_address: MOCK_SENDER_PRIMARY, body: reply })
    .select("id, conversation_id")
    .single();
  expect(error).toBeNull();
  return { id: inbound!.id, conversationId: inbound!.conversation_id as string };
}

async function dispatchWith(client: SupabaseClient<Database>, lead: Lead, ourText: string, reply: string) {
  const inbound = await seedThread(lead, ourText, reply);
  const outcome = await dispatchAiResponse(
    client,
    { propertyId: lead.propertyId, contactId: lead.contactId, conversationId: inbound.conversationId, inboundMessageId: inbound.id, inboundBody: reply, inboundFromPhone: lead.phone, inboundToPhone: MOCK_SENDER_PRIMARY },
    { anthropic: NO_ANTHROPIC },
  );
  return outcome as { outcome: string; reason?: string };
}

async function propertyRow(propertyId: string) {
  const { data } = await supabase
    .from("properties")
    .select("needs_human_attention, last_ai_escalation_reason, outreach_dispo, decision_context_revision")
    .eq("id", propertyId)
    .single();
  return data!;
}

describe("Messages v2 retained findings (real regression tests, disposable stack)", () => {
  beforeAll(async () => {
    assertStressDbEnv(process.env);
    assertLocalOnlyTestEnv(process.env.TEST_SUPABASE_DB_URL, process.env.TEST_SUPABASE_URL);
    await pg.connect();
    process.env.MESSAGING_PROVIDER = "mock";
    process.env.TYPESAFE_API_KEY = "stub-key";
    await pg.query("begin");
    await pg.query("set local session_replication_role = replica");
    await pg.query("delete from public.memberships where org_id = $1", [BMH_ORG_ID]);
    await pg.query("delete from auth.users where email like 'retained-owner-%' or email like 'stress-owner-%'");
    await pg.query("commit");
    const { error: resetError } = await supabase.rpc("reset_tenant_tables");
    expect(resetError).toBeNull();
    const { error: orgError } = await supabase.from("organizations").upsert({ id: BMH_ORG_ID, name: "BMH (messages v2 retained findings)" });
    expect(orgError).toBeNull();
    orgId = await getCanonicalTestOrgId(supabase);
    await seedSenderCatalog(supabase, orgId, [MOCK_SENDER_PRIMARY]);
    await seedOwner();
    await seedOrg();
    installStubJev();
  }, 120_000);

  beforeEach(() => {
    resetMockState();
    stubAnswer = null;
    workflowStarts.length = 0;
  });

  afterAll(async () => {
    globalThis.fetch = realFetch;
    await pg.end();
  });

  // Control for (a): with the switch READABLE the same text takes the drip path. Proves the
  // fixture reaches the confirmed-owner branch, so (a) fails for the injected error and nothing else.
  it("control (a): confirmed owner with a readable drip switch is closed onto the drip", async () => {
    stubAnswer = "confirmed_owner";
    const lead = await seedLead();
    const outcome = await dispatchWith(supabase, lead, "Hi Mary, apologies for the cold text. Still own over at 123 Oak St?", "Yes I still own it");
    expect(outcome).toEqual({ outcome: "auto_closed", reason: "nine_questions:confirmed_owner" });
  });

  knownDefect(
    "[KNOWN DEFECT] (a) PR 892: confirmed-owner drip-switch READ ERROR must hold for a person (today: silent close, no hold)",
    async () => {
      stubAnswer = "confirmed_owner";
      const lead = await seedLead();
      const client = withHooks(supabase, [{ table: "ai_responder_configs", columns: "nine_confirmed_owner_drip", fail: true }]);
      const outcome = await dispatchWith(client, lead, "Hi Mary, apologies for the cold text. Still own over at 123 Oak St?", "Yes I still own it");
      const prop = await propertyRow(lead.propertyId);
      // Desired: an unknown switch state is not "off": a person looks.
      expect(prop.needs_human_attention).toBe(true);
      expect(outcome.outcome).toBe("escalated");
    },
  );

  // Control for (c): with no concurrent change the wrong-person reply is sent and the property closed.
  it("control (c): wrong person with no concurrent change sends the approved reply and closes this property", async () => {
    stubAnswer = "wrong_person";
    const lead = await seedLead();
    const outcome = await dispatchWith(supabase, lead, "Mary, Mel here. Quick one, are you the owner of 123 Oak St?", "Wrong number, I don't own that");
    expect(outcome).toEqual({ outcome: "auto_closed", reason: "nine_questions:wrong_person" });
    expect((await propertyRow(lead.propertyId)).outreach_dispo).toBe("wrong_number");
  });

  knownDefect(
    "[KNOWN DEFECT] (c) PR 889: wrong-person close after a concurrent human takeover must not absorb the takeover's revision (today: closes anyway)",
    async () => {
      stubAnswer = "wrong_person";
      const lead = await seedLead();
      // Between our reply landing and the close, a person texts the seller from their own phone
      // (a rep SMS: the human-owned conversation). That outbound moves decision_context_revision.
      const takeover = async () => {
        await pg.query(
          "insert into public.messages (org_id, channel, direction, status, property_id, contact_id, from_address, to_address, body, metadata) values ($1, 'sms', 'outbound', 'sent', $2, $3, $4, $5, $6, $7)",
          [orgId, lead.propertyId, lead.contactId, MOCK_SENDER_PRIMARY, lead.phone, "RETAINED rep text: this is Mel, I'll take it from here", JSON.stringify({ workflow: "maria-through-mel", persona: "Mel" })],
        );
      };
      // Read 1 is the engine's evaluation revision (before Jev, nine-questions-engine.ts); read 2 is
      // dispatch's post-send re-baseline (dispatch.ts, wrong-person close). The takeover lands just
      // before read 2: after our reply was accepted, before the close.
      const client = withHooks(supabase, [{ table: "properties", columns: "decision_context_revision", before: takeover, nth: 2 }]);
      await dispatchWith(client, lead, "Mary, Mel here. Quick one, are you the owner of 123 Oak St?", "Wrong number, I don't own that");
      const { rows } = await pg.query("select count(*)::int as n from public.messages where property_id = $1 and body like 'RETAINED rep text%'", [lead.propertyId]);
      expect(rows[0].n).toBe(1); // the takeover really happened inside the window
      // Desired: the close acts on the revision it read (or stops): a person's change is not overwritten.
      expect((await propertyRow(lead.propertyId)).outreach_dispo).not.toBe("wrong_number");
    },
  );

  // Control for (d): responder off + readable engine = nothing at all (the silent_off bucket).
  it("control (d): responder-off property with a readable engine switch writes no hold", async () => {
    stubAnswer = "confirmed_owner";
    const lead = await seedLead({ disabled: true });
    await dispatchWith(supabase, lead, "Hi Mary, apologies for the cold text. Still own over at 123 Oak St?", "Yes I still own it");
    expect((await propertyRow(lead.propertyId)).needs_human_attention).toBe(false);
  });

  knownDefect(
    "[KNOWN DEFECT] (d) PR 889: unreadable engine switch on a responder-off property must write no hold (today: classifier_engine_unreadable hold)",
    async () => {
      stubAnswer = "confirmed_owner";
      const lead = await seedLead({ disabled: true });
      const client = withHooks(supabase, [{ table: "ai_responder_configs", columns: "classifier_engine", fail: true }]);
      const outcome = await dispatchWith(client, lead, "Hi Mary, apologies for the cold text. Still own over at 123 Oak St?", "Yes I still own it");
      const prop = await propertyRow(lead.propertyId);
      expect(outcome.reason).not.toBe("classifier_engine_unreadable");
      expect(prop.needs_human_attention).toBe(false);
    },
  );

  describe("(e) delayed-reply inbound path (real handleInboundWebhook, mock provider, delay configured)", () => {
    const webhook = (from: string, body: string) =>
      handleInboundWebhook(
        new Request("https://example.test/webhooks/mock", {
          method: "POST",
          headers: { "content-type": "application/json", "x-mock-signature": "valid" },
          body: JSON.stringify({ externalId: `retained-${randomUUID()}`, from, to: MOCK_SENDER_PRIMARY, body }),
        }),
        { includeFullUrl: false, provider: new MockMessagingProvider() },
      );

    beforeAll(async () => {
      await pg.query("update public.ai_responder_configs set reply_delay_min_seconds = 30, reply_delay_max_seconds = 60 where org_id = $1", [orgId]);
    });
    afterAll(async () => {
      await pg.query("update public.ai_responder_configs set reply_delay_min_seconds = 0, reply_delay_max_seconds = 0 where org_id = $1", [orgId]);
    });

    // Control for (e): the same text on a responder-ON property IS held up front (keyword:legal_contract),
    // proving the delayed path's keyword gate runs in this fixture.
    it("control (e): responder-on property + 'talk to my lawyer' is held keyword:legal_contract on the delayed path", async () => {
      const lead = await seedLead();
      const res = await webhook(lead.phone, "You can talk to my lawyer about it");
      expect(res.status).toBe(200);
      const prop = await propertyRow(lead.propertyId);
      expect(prop).toMatchObject({ needs_human_attention: true, last_ai_escalation_reason: "keyword:legal_contract" });
    });

    knownDefect(
      "[KNOWN DEFECT] (e) PR 882: delayed-reply path, responder-off property + non-hot keyword must write no hold (today: keyword hold)",
      async () => {
        const lead = await seedLead({ disabled: true });
        const res = await webhook(lead.phone, "You can talk to my lawyer about it");
        expect(res.status).toBe(200);
        const prop = await propertyRow(lead.propertyId);
        // Desired (PR 2 decided rule, dispatch.ts step 2): responder off for the property = no hold, no alert.
        expect(prop.needs_human_attention).toBe(false);
        expect(prop.last_ai_escalation_reason).toBeNull();
      },
    );
  });
});
