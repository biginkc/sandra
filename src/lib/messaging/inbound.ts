import { NextResponse } from "next/server";
import {
  createClient as createSupabaseClient,
  type SupabaseClient,
} from "@supabase/supabase-js";
import { start } from "workflow/api";

import Anthropic from "@anthropic-ai/sdk";

import { listAdminUserIds } from "@/lib/auth/admins";
import { findAttributedOutboundMessageId } from "@/lib/messages/attribution";
import {
  clearAiResponderThreadState,
  recordAiResponderOutcomeForThread,
} from "@/lib/messages/ai-responder-thread-state";
import { looksLikeTestTraffic } from "@/lib/messages/list-threads";
import {
  applyKeywordEscalation,
  checkAiResponderDispatchPreGates,
  dispatchAiResponse,
  flagAndDeadLetter,
  flagConfirmDncHold,
  inboundStampOutcomeOf,
  markPropertyNeedsAttention,
  type AiDispatchInput,
  type AiDispatchOutcome,
} from "@/lib/ai-responder/dispatch";
import {
  computeReplyDelaySeconds,
  loadAiReplyDelayConfig,
} from "@/lib/ai-responder/delay";
import { reportError } from "@/lib/errors/report";
import { LEAD_EVENT_TYPES, recordLeadEvent } from "@/lib/events";
import { classifyReplyIntent } from "@/lib/leads/classify-reply-intent";
import { qualifyProperty } from "@/lib/leads/qualify";
import { resolveInboundThread } from "@/lib/messages/threading";
import { normalizePhone } from "@/lib/csv/normalize";
import { recordConsentEvent } from "@/lib/messaging/consent";
import {
  claimInboundSmsIntent,
  markInboundSmsIntentMessageInserted,
  markInboundSmsIntentSideEffectsComplete,
} from "@/lib/messaging/inbound-intents";
import {
  markInboundMessageState,
  readInboundMessageState,
} from "@/lib/messaging/inbound-state";
import {
  dispatchOwnerMessageAdded,
  dispatchOwnerMessageAddedNeedsTriage,
} from "@/lib/notifications/dispatch";
import {
  pausePropertyEnrollments,
  promotePropertyEnrollmentPauseReason,
} from "@/lib/sequences/enrollment";
import type { Database, Json } from "@/lib/supabase/types";
import {
  findRepSmsHumanTakeoverSource,
  persistRepSmsHumanTakeoverFallback,
  recordRepSmsHumanTakeover,
  REP_SMS_HUMAN_TAKEOVER_REASON,
} from "./rep-sms-human-takeover";
import {
  isRetryOutcome,
  recordRetryScheduled,
  type AiRetryOutcome,
} from "@/lib/ai-responder/retry";
import { aiReplyDelayWorkflow } from "@/workflows/ai-reply-delay";
import {
  finishRun,
  finishRunFromOutcome,
  recordStep,
  startRun,
  type PipelineRunContext,
} from "@/lib/pipeline-runs";
import { upgradeNormaHoldPauses } from "@/lib/norma";
import { HOSTILE_NEEDS_CONFIRM_REASON, OPTOUT_PHRASE_NEEDS_CONFIRM_REASON, isHostileInbound } from "@/lib/ai-responder/hostile";
import { applyPhoneLevelOptOut } from "./opt-out-phone";
import { DNC_KEYWORDS, isCarrierStopKeyword, matchesStopKeyword } from "./stop-signals";
import type { MessagingProvider } from "./types";

export { matchesStopKeyword };

const HELP_KEYWORDS = /^\s*(help|info|support)\s*$/i;
const WRONG_NUMBER_KEYWORDS =
  /wrong number|wrong person|not the owner|don'?t own|dont own|no longer own/i;
const WEBHOOK_PROCESSING_LEASE_MS = 5 * 60_000;

export function classifyWrongNumberScope(
  body: string,
): "this_property" | "all" {
  if (
    /\bwrong (?:number|person)\b/i.test(body) ||
    /\bnever (?:owned|own) (?:any )?propert(?:y|ies)\b/i.test(body) ||
    /\bnobody by that name\b/i.test(body) ||
    /\bno one by that name\b/i.test(body)
  ) {
    return "all";
  }
  return "this_property";
}

async function setInboundDisposition(
  supabase: SupabaseClient<Database>,
  input: {
    propertyId: string;
    disposition: "dnc" | "opted_out" | "wrong_number";
    sourceId: string | null;
    allowedCurrent?: ReadonlySet<string | null>;
  },
): Promise<boolean> {
  const { data: current, error: readError } = await supabase
    .from("properties")
    .select("outreach_dispo")
    .eq("id", input.propertyId)
    .maybeSingle();
  if (readError || !current) {
    throw new Error(
      `inbound disposition read: ${readError?.message ?? "property not found"}`,
    );
  }
  if (current.outreach_dispo === input.disposition) return false;
  if (
    input.allowedCurrent &&
    !input.allowedCurrent.has(current.outreach_dispo)
  ) {
    return false;
  }

  let updateQuery = supabase
    .from("properties")
    .update({ outreach_dispo: input.disposition })
    .eq("id", input.propertyId);
  updateQuery =
    current.outreach_dispo === null
      ? updateQuery.is("outreach_dispo", null)
      : updateQuery.eq("outreach_dispo", current.outreach_dispo);
  const { data: updated, error: updateError } = await updateQuery
    .select("id")
    .maybeSingle();
  if (updateError) {
    throw new Error(`inbound disposition write: ${updateError.message}`);
  }
  if (!updated) return false;

  const event = {
    propertyId: input.propertyId,
    eventType: LEAD_EVENT_TYPES.DISPO_SET,
    actorType: "system" as const,
    payload: { from: current.outreach_dispo, to: input.disposition },
  };
  if (input.sourceId) {
    await recordLeadEvent({
      ...event,
      sourceType: "webhook_events.disposition",
      sourceId: input.sourceId,
    });
  } else {
    await recordLeadEvent(event);
  }
  return true;
}

function createServiceRoleClient() {
  const useTestEnv =
    process.env.NODE_ENV === "test" || process.env.VITEST === "true";
  const url = useTestEnv
    ? (process.env.TEST_SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL)
    : process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = useTestEnv
    ? (process.env.TEST_SUPABASE_SERVICE_ROLE_KEY ??
      process.env.SUPABASE_SERVICE_ROLE_KEY)
    : process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error(
      "Inbound webhook needs SUPABASE_SERVICE_ROLE_KEY in .env.local to write past RLS.",
    );
  }
  return createSupabaseClient<Database>(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

async function resolveInboundOrgId(
  supabase: SupabaseClient<Database>,
  input: {
    contactId: string | null;
    propertyId: string | null;
    fromPhone: string;
  },
): Promise<string | null> {
  if (input.propertyId) {
    const { data, error } = await supabase
      .from("properties")
      .select("org_id")
      .eq("id", input.propertyId)
      .maybeSingle();
    if (error) {
      throw new Error(`resolveInboundOrgId property: ${error.message}`);
    }
    if (data?.org_id) return data.org_id;
  }

  if (input.contactId) {
    const { data, error } = await supabase
      .from("contacts")
      .select("org_id")
      .eq("id", input.contactId)
      .maybeSingle();
    if (error) {
      throw new Error(`resolveInboundOrgId contact: ${error.message}`);
    }
    if (data?.org_id) return data.org_id;
  }

  const phone = normalizePhone(input.fromPhone);
  if (!phone) return null;
  const results = await Promise.all([
    supabase.from("contacts").select("org_id").eq("phone_1", phone),
    supabase.from("contacts").select("org_id").eq("phone_2", phone),
    supabase.from("contacts").select("org_id").eq("phone_3", phone),
  ]);
  const orgIds = new Set<string>();
  for (const result of results) {
    if (result.error) {
      throw new Error(`resolveInboundOrgId phone: ${result.error.message}`);
    }
    for (const row of result.data ?? []) {
      if (row.org_id) orgIds.add(row.org_id);
    }
  }
  return orgIds.size === 1 ? Array.from(orgIds)[0] : null;
}

/**
 * True only when this org has an active `ai_responder_configs` row with
 * `classifier_provider = 'jev'`. Used solely to gate the legacy Haiku
 * auto-qualify block above away from an org where Jev's own threshold
 * decision is the sole new_lead promotion authority — never inferred
 * elsewhere, and defaults to `false` (preserve the legacy path) when
 * `orgId` is unresolved or the lookup fails, since guessing wrong here
 * either duplicates a promotion (safe, existing `qualifyProperty` is
 * idempotent) or silently skips one (not safe) — failing toward "keep
 * today's behavior" is the correct default.
 */
export type ClassifierMode = "jev" | "legacy" | "unavailable";

/**
 * Tri-state classifier config. `unavailable` means the lookup errored — the
 * caller must NOT fall back to the legacy auto-promote path (it would bypass
 * Jev's automation_enabled/threshold). `legacy` is returned only when the
 * query succeeded (legacy row, or verified absence of any active row) or
 * there is no org to look up.
 */
export async function resolveClassifierMode(
  supabase: SupabaseClient<Database>,
  orgId: string | null,
): Promise<ClassifierMode> {
  if (!orgId) return "legacy";
  try {
    const { data, error } = await supabase
      .from("ai_responder_configs")
      .select("classifier_provider")
      .eq("org_id", orgId)
      .eq("active", true)
      .maybeSingle();
    if (error) return "unavailable";
    return data?.classifier_provider === "jev" ? "jev" : "legacy";
  } catch {
    return "unavailable";
  }
}

export async function isJevClassifierOrg(
  supabase: SupabaseClient<Database>,
  orgId: string | null,
): Promise<boolean> {
  return (await resolveClassifierMode(supabase, orgId)) === "jev";
}

export async function handleInboundWebhook(
  request: Request,
  opts: { includeFullUrl: boolean; provider: MessagingProvider | null },
) {
  try {
    const { provider } = opts;
    if (!provider) {
      return NextResponse.json(
        { error: "Messaging provider not configured" },
        { status: 503 },
      );
    }

    const rawBody = await request.text();
    const fullUrl = opts.includeFullUrl
      ? new URL(
          request.url,
          `https://${request.headers.get("host") ?? "example.invalid"}`,
        ).toString()
      : undefined;

    if (!provider.verifyWebhookSignature(rawBody, request.headers, fullUrl)) {
      return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
    }

    let events;
    try {
      events = provider.parseInboundWebhook(rawBody);
    } catch (e) {
      reportError(e, {
        tags: { surface: `${provider.providerId}_webhook_parse` },
      });
      return NextResponse.json(
        { error: "Unrecognized payload" },
        { status: 400 },
      );
    }

    const supabase = createServiceRoleClient();

    for (const ev of events) {
      const resumeDecision = await reserveWebhookEvent(supabase, {
        provider: provider.providerId,
        externalId: ev.externalId,
        payload: ev.raw as Json,
      });
      if (resumeDecision.status === "skip") continue;
      if (resumeDecision.status === "error") {
        reportError(new Error(resumeDecision.message), {
          tags: { surface: `${provider.providerId}_webhook_events_insert` },
          extra: { externalId: ev.externalId },
        });
        return NextResponse.json(
          { error: "webhook event reserve failed" },
          { status: 500 },
        );
      }

      const thread = await resolveInboundThread(supabase, ev.from, ev.to);
      const contactId = thread.contactId;
      const propertyId = thread.propertyId;
      const conversationId = thread.conversationId;
      const orgId = await resolveInboundOrgId(supabase, {
        contactId,
        propertyId,
        fromPhone: ev.from,
      });
      let attributedOutboundMessageId: string | null = null;
      try {
        attributedOutboundMessageId = await findAttributedOutboundMessageId(
          supabase,
          {
            contactId,
            toPhone: ev.to,
            propertyId,
            conversationId,
          },
        );
      } catch (e) {
        reportError(e, {
          tags: {
            surface: `${provider.providerId}_inbound_attribution_lookup`,
          },
          extra: {
            externalId: ev.externalId,
            contactId,
            propertyId,
            conversationId,
          },
        });
      }
      const source = `${provider.providerId}_inbound_webhook`;
      const bodyTrimmed = ev.body.trim();
      const baseMetadata = {
        routing: thread.resolution,
        ...(ev.mediaUrls ? { mediaUrls: ev.mediaUrls } : {}),
      } as Json;
      const intentClaim = await claimInboundSmsIntent(supabase, {
        orgId,
        providerId: provider.providerId,
        externalId: ev.externalId,
        from: ev.from,
        to: ev.to,
        body: ev.body,
        receivedAt: ev.receivedAt,
        raw: ev.raw,
        mediaUrls: ev.mediaUrls ?? null,
        webhookEventId: resumeDecision.webhookEventId,
        contactId,
        propertyId,
        conversationId,
        routingResolution: thread.resolution,
      });
      if (intentClaim.duplicate && intentClaim.mode === "enforce") {
        await markWebhookEventProcessed(
          supabase,
          provider.providerId,
          ev.externalId,
        );
        // A semantic duplicate shares the canonical intent's side effects.
        // Do not mark that intent complete here: the canonical webhook may
        // still be between message insertion and takeover/sequence pause, and
        // doing so would make a later canonical retry skip the required work.
        continue;
      }

      // Jarrad (2026-10-08): "I don't want to make any auto DNC decisions. It
      // should go to hold." Only a bare carrier keyword (STOP, STOPALL,
      // UNSUBSCRIBE, CANCEL, END, QUIT as the whole message) suppresses a
      // number automatically (the STOP gate below). Every PHRASE match
      // ("stop texting me", "do not contact me", "leave me alone", "remove
      // me", a longer message containing "stop") is held for a person, who
      // can click "Confirm do-not-contact" on the hold card.
      if (
        !isCarrierStopKeyword(bodyTrimmed) &&
        (DNC_KEYWORDS.test(ev.body) ||
          matchesStopKeyword(bodyTrimmed) ||
          // ANY hostile wording is held here, ahead of every generic exit
          // (price escalation, drafting off, reply pacing) that would hold
          // it without the Confirm do-not-contact action.
          isHostileInbound(ev.body))
      ) {
        const insertOutcome = await insertInboundMessage(supabase, {
          providerId: provider.providerId,
          externalId: ev.externalId,
          from: ev.from,
          to: ev.to,
          body: ev.body,
          contactId,
          propertyId,
          conversationId,
          inboundIntentId: intentClaim.intentId,
          attributedOutboundMessageId,
          metadata: { ...jsonObject(baseMetadata), keyword: "opt_out_phrase" } as Json,
        });
        if (!insertOutcome.error && propertyId) {
          const held = await holdPhraseOptOut(supabase, {
            propertyId,
            body: ev.body,
            inboundMessageId: insertOutcome.messageId ?? null,
            surface: provider.providerId,
          });
          if (!held) {
            await markWebhookEventError(
              supabase,
              provider.providerId,
              ev.externalId,
              "opt-out hold could not be saved",
            );
            return NextResponse.json({ error: "opt-out hold failed" }, { status: 500 });
          }
        }
        if (insertOutcome.error) {
          await markWebhookEventError(
            supabase,
            provider.providerId,
            ev.externalId,
            insertOutcome.error.message,
          );
          return NextResponse.json(
            { error: "inbound message insert failed" },
            { status: 500 },
          );
        }
        if (!insertOutcome.duplicate) {
          await recordKeywordExitRun(supabase, {
            orgId,
            insertOutcome,
            body: ev.body,
            gate: "dnc_keyword",
            status: "held",
            reason: "optout_phrase_needs_confirm",
          });
        }
        await markWebhookEventProcessed(
          supabase,
          provider.providerId,
          ev.externalId,
        );
        await markInboundSmsIntentSideEffectsComplete(
          supabase,
          intentClaim.intentId,
        );
        continue;
      }

      // The ONLY automatic phone suppression driven by an inbound text: a bare
      // carrier / legal STOP keyword as the whole message (CTIA / TCPA).
      // Jarrad (2026-10-08): "I don't want to make any auto DNC decisions. It
      // should go to hold." Phrase matches are held above; model / Jev
      // opt-outs and DNCs open a human review (see ai-responder/dispatch.ts).
      if (isCarrierStopKeyword(bodyTrimmed)) {
        if (!orgId) {
          throw new Error(
            "STOP webhook could not resolve org for phone suppression",
          );
        }
        await applyPhoneLevelOptOut(supabase, {
          contactId,
          fromPhone: ev.from,
          orgId,
          source,
          sourceDetail: { externalId: ev.externalId, from: ev.from },
          occurredAt: ev.receivedAt,
          providerId: provider.providerId,
          surface: "stop",
          idempotencyKey: ev.externalId,
          ...(propertyId
            ? {
                leadEvent: {
                  propertyId,
                  actorType: "system" as const,
                  trigger: "inbound_keyword" as const,
                },
              }
            : {}),
        });
        if (propertyId) {
          await setInboundDisposition(supabase, {
            propertyId,
            disposition: "opted_out",
            sourceId: resumeDecision.webhookEventId,
            allowedCurrent: new Set([
              null,
              "not_interested",
              "wrong_number",
              "opted_out",
            ]),
          });
        }
        const insertOutcome = await insertInboundMessage(supabase, {
          providerId: provider.providerId,
          externalId: ev.externalId,
          from: ev.from,
          to: ev.to,
          body: ev.body,
          contactId,
          propertyId,
          conversationId,
          inboundIntentId: intentClaim.intentId,
          attributedOutboundMessageId,
          metadata: { ...jsonObject(baseMetadata), keyword: "stop" } as Json,
        });
        if (insertOutcome.error) {
          await markWebhookEventError(
            supabase,
            provider.providerId,
            ev.externalId,
            insertOutcome.error.message,
          );
          return NextResponse.json(
            { error: "inbound message insert failed" },
            { status: 500 },
          );
        }
        if (!insertOutcome.duplicate) {
          await recordKeywordExitRun(supabase, {
            orgId,
            insertOutcome,
            body: ev.body,
            gate: "stop_keyword",
            status: "closed",
            reason: "stop_keyword",
          });
        }
        await markWebhookEventProcessed(
          supabase,
          provider.providerId,
          ev.externalId,
        );
        await markInboundSmsIntentSideEffectsComplete(
          supabase,
          intentClaim.intentId,
        );
        continue;
      }

      if (HELP_KEYWORDS.test(bodyTrimmed)) {
        if (contactId) {
          await recordConsentEvent(supabase, {
            contactId,
            channel: "sms",
            eventType: "help_request",
            source,
            sourceDetail: { externalId: ev.externalId, from: ev.from },
            occurredAt: ev.receivedAt,
            idempotencyKey: ev.externalId,
          });
        }
        const insertOutcome = await insertInboundMessage(supabase, {
          providerId: provider.providerId,
          externalId: ev.externalId,
          from: ev.from,
          to: ev.to,
          body: ev.body,
          contactId,
          propertyId,
          conversationId,
          inboundIntentId: intentClaim.intentId,
          attributedOutboundMessageId,
          metadata: { ...jsonObject(baseMetadata), keyword: "help" } as Json,
        });
        if (insertOutcome.error) {
          await markWebhookEventError(
            supabase,
            provider.providerId,
            ev.externalId,
            insertOutcome.error.message,
          );
          return NextResponse.json(
            { error: "inbound message insert failed" },
            { status: 500 },
          );
        }
        if (!insertOutcome.duplicate) {
          await recordKeywordExitRun(supabase, {
            orgId,
            insertOutcome,
            body: ev.body,
            gate: "help_keyword",
            status: "skipped",
            reason: "help_keyword",
          });
        }
        await markWebhookEventProcessed(
          supabase,
          provider.providerId,
          ev.externalId,
        );
        await markInboundSmsIntentSideEffectsComplete(
          supabase,
          intentClaim.intentId,
        );
        continue;
      }

      if (WRONG_NUMBER_KEYWORDS.test(ev.body)) {
        const wrongScope = classifyWrongNumberScope(ev.body);
        // Hostile wording takes precedence: no wrong_number disposition is
        // applied; the conversation is held for a person instead.
        const hostileWrongNumber = isHostileInbound(ev.body);
        if (propertyId) {
          if (!hostileWrongNumber) {
            await setInboundDisposition(supabase, {
              propertyId,
              disposition: "wrong_number",
              sourceId: resumeDecision.webhookEventId,
              allowedCurrent: new Set([null, "not_interested"]),
            });
          }
          try {
            await pausePropertyEnrollments(supabase, {
              propertyId,
              reason: "inbound_reply",
            });
          } catch (e) {
            reportError(e, {
              tags: {
                surface: `${provider.providerId}_webhook_sequence_pause_wrong_number`,
              },
              extra: { propertyId, externalId: ev.externalId },
            });
          }
        }
        const insertOutcome = await insertInboundMessage(supabase, {
          providerId: provider.providerId,
          externalId: ev.externalId,
          from: ev.from,
          to: ev.to,
          body: ev.body,
          contactId,
          propertyId,
          conversationId,
          inboundIntentId: intentClaim.intentId,
          attributedOutboundMessageId,
          metadata: {
            ...jsonObject(baseMetadata),
            keyword: "wrong_number",
            wrong_scope: wrongScope,
          } as Json,
        });
        if (!insertOutcome.error && propertyId && (wrongScope === "all" || hostileWrongNumber)) {
          // "Wrong person for everything" is a phone-wide claim, and hostile
          // wording is never an automatic decision: a person decides whether
          // to block the number (no automatic suppression). Hostile wording
          // keeps the hostile reason (so the approved reply can be sent).
          const held = await holdPhraseOptOut(supabase, {
            propertyId,
            body: ev.body,
            inboundMessageId: insertOutcome.messageId ?? null,
            surface: provider.providerId,
            ...(hostileWrongNumber ? {} : { forceReason: OPTOUT_PHRASE_NEEDS_CONFIRM_REASON }),
          });
          if (!held) {
            await markWebhookEventError(
              supabase,
              provider.providerId,
              ev.externalId,
              "opt-out hold could not be saved",
            );
            return NextResponse.json({ error: "opt-out hold failed" }, { status: 500 });
          }
        }
        if (insertOutcome.error) {
          await markWebhookEventError(
            supabase,
            provider.providerId,
            ev.externalId,
            insertOutcome.error.message,
          );
          return NextResponse.json(
            { error: "inbound message insert failed" },
            { status: 500 },
          );
        }
        if (!insertOutcome.duplicate) {
          await recordKeywordExitRun(supabase, {
            orgId,
            insertOutcome,
            body: ev.body,
            gate: "wrong_number_keyword",
            status: "closed",
            reason: "wrong_number_keyword",
          });
        }
        await markWebhookEventProcessed(
          supabase,
          provider.providerId,
          ev.externalId,
        );
        await markInboundSmsIntentSideEffectsComplete(
          supabase,
          intentClaim.intentId,
        );
        continue;
      }

      const insertOutcome = await insertInboundMessage(supabase, {
        providerId: provider.providerId,
        externalId: ev.externalId,
        from: ev.from,
        to: ev.to,
        body: ev.body,
        contactId,
        propertyId,
        conversationId,
        inboundIntentId: intentClaim.intentId,
        attributedOutboundMessageId,
        metadata: baseMetadata,
      });
      if (insertOutcome.error) {
        reportError(new Error(insertOutcome.error.message), {
          tags: { surface: `${provider.providerId}_webhook_inbound_insert` },
          extra: { externalId: ev.externalId, code: insertOutcome.error.code },
        });
        await markWebhookEventError(
          supabase,
          provider.providerId,
          ev.externalId,
          insertOutcome.error.message,
        );
        return NextResponse.json(
          { error: "inbound message insert failed" },
          { status: 500 },
        );
      }
      const effectiveContactId = insertOutcome.contactId ?? contactId;
      const effectivePropertyId = insertOutcome.propertyId ?? propertyId;
      if (!insertOutcome.messageId) {
        await markWebhookEventProcessed(
          supabase,
          provider.providerId,
          ev.externalId,
        );
        await markInboundSmsIntentSideEffectsComplete(
          supabase,
          intentClaim.intentId,
        );
        continue;
      }
      const inboundState = readInboundMessageState(insertOutcome.metadata);
      // Messages v2 evidence: one run per inbound message. Observation only;
      // null (never an error) when recording is unavailable.
      const runCtx = orgId
        ? await startRun(supabase, {
            orgId,
            inboundMessageId: insertOutcome.messageId,
            propertyId: effectivePropertyId,
            contactId: effectiveContactId,
            conversationId: insertOutcome.conversationId,
            mode: "legacy",
            inboundPreview: ev.body,
          })
        : null;

      if (!effectivePropertyId) {
        await finishRun(supabase, runCtx, {
          status: "skipped",
          finalOutcome: "skipped",
          reason: "no_property",
        });
        if (effectiveContactId && !inboundState.ownerNotificationSentAt) {
          try {
            const adminUserIds = await listAdminUserIds(supabase);
            await dispatchOwnerMessageAddedNeedsTriage(supabase, {
              messageId: insertOutcome.messageId,
              contactId: effectiveContactId,
              adminUserIds,
              messageBody: ev.body,
            });
            await markInboundMessageState(supabase, insertOutcome.messageId, {
              ownerNotificationSentAt: new Date().toISOString(),
            });
          } catch (e) {
            reportError(e, {
              tags: {
                surface: `${provider.providerId}_webhook_notification_triage`,
              },
              extra: {
                contactId: effectiveContactId,
                externalId: ev.externalId,
              },
            });
          }
        }
        await markWebhookEventProcessed(
          supabase,
          provider.providerId,
          ev.externalId,
        );
        await markInboundSmsIntentSideEffectsComplete(
          supabase,
          intentClaim.intentId,
        );
        continue;
      }

      const { data: cur } = await supabase
        .from("properties")
        .select("status")
        .eq("id", effectivePropertyId)
        .maybeSingle();

      const needsClassifierMode =
        cur?.status === "prospect" &&
        Boolean(ev.body) &&
        !inboundState.autoQualifiedAt;
      const classifierMode: ClassifierMode = needsClassifierMode
        ? await resolveClassifierMode(supabase, orgId)
        : "legacy";
      if (classifierMode === "unavailable") {
        // Fail closed: skip legacy auto-promotion entirely (it ignores Jev's
        // automation_enabled/threshold). AI dispatch loads its own config.
        reportError(new Error("classifier config unavailable"), {
          tags: {
            surface: `${provider.providerId}_webhook_classifier_config_unavailable`,
          },
          extra: { propertyId: effectivePropertyId, externalId: ev.externalId },
        });
        await recordStep(supabase, runCtx, {
          kind: "gate",
          name: "classifier_config_unavailable",
          // The legacy auto-promotion branch is skipped, but the inbound still
          // proceeds to AI dispatch (which fails closed on its own config load).
          result: "pass",
          detail: { skipped: "legacy_auto_promotion" },
        });
      }

      if (
        cur?.status === "prospect" &&
        ev.body &&
        !inboundState.autoQualifiedAt &&
        // Overlap guard (Jev workflow, 2026-09-20): this legacy Haiku
        // intent-classify + auto-qualify path is independent of and runs
        // before dispatchAndStampAiResponder/Jev below. For an org whose
        // active classifier is Jev, Jev's own threshold-gated new_lead
        // decision is the sole promotion authority — this legacy path
        // must not also promote the same property, or a below-threshold
        // Jev "needs a decision" case could get silently bypassed by this
        // parallel Haiku path reaching qualifyProperty first. Only
        // queried once the cheaper checks above already narrow to a
        // prospect awaiting auto-qualify. For every other org
        // (classifier_provider='legacy', the default, or no active
        // config at all) this is unchanged from today.
        classifierMode === "legacy"
      ) {
        let shouldQualify = false;
        if (process.env.SKIP_INTENT_GATE === "1") {
          shouldQualify = true;
        } else {
          try {
            const intent = await classifyReplyIntent(ev.body, new Anthropic());
            shouldQualify = intent === "positive";
          } catch (e) {
            reportError(e, {
              tags: {
                surface: `${provider.providerId}_webhook_classify_intent`,
              },
              extra: { propertyId, externalId: ev.externalId },
            });
          }
        }

        if (shouldQualify) {
          const qOutcome = await qualifyProperty(
            supabase,
            effectivePropertyId,
            "system:inbound_reply",
          );
          if (qOutcome.status === "failed") {
            reportError(new Error(qOutcome.message), {
              tags: { surface: `${provider.providerId}_webhook_auto_qualify` },
              extra: {
                propertyId: effectivePropertyId,
                externalId: ev.externalId,
              },
            });
          } else {
            await markInboundMessageState(supabase, insertOutcome.messageId, {
              autoQualifiedAt: new Date().toISOString(),
            });
          }
        }
      }

      if (!inboundState.ownerNotificationSentAt) {
        try {
          const { data: propRow } = await supabase
            .from("properties")
            .select("assigned_user_id, address, city, state")
            .eq("id", effectivePropertyId)
            .maybeSingle();
          // Jitter test fixtures must not light the notification bell —
          // the inbox hides their threads (Hide DNC & tests), and a bell
          // deep-link would auto-mark them read anyway (Codex P2 on PR
          // #257). State still marks notification-sent so retries don't
          // re-evaluate.
          const isTestTraffic = looksLikeTestTraffic(
            null,
            propRow
              ? [propRow.address, propRow.city, propRow.state]
                  .filter(Boolean)
                  .join(", ")
              : null,
          );
          if (isTestTraffic) {
            await markInboundMessageState(supabase, insertOutcome.messageId, {
              ownerNotificationSentAt: new Date().toISOString(),
            });
          } else {
            const adminUserIds = propRow?.assigned_user_id
              ? []
              : await listAdminUserIds(supabase);
            await dispatchOwnerMessageAdded(supabase, {
              messageId: insertOutcome.messageId,
              propertyId: effectivePropertyId,
              adminUserIds,
              messageBody: ev.body,
            });
            await markInboundMessageState(supabase, insertOutcome.messageId, {
              ownerNotificationSentAt: new Date().toISOString(),
            });
          }
        } catch (e) {
          reportError(e, {
            tags: {
              surface: `${provider.providerId}_webhook_notification_dispatch`,
            },
            extra: {
              propertyId: effectivePropertyId,
              externalId: ev.externalId,
            },
          });
        }
      }

      // Pause before rep-SMS attribution so a lookup or takeover persistence
      // failure still leaves the automated sequence fail-safe paused. A
      // confirmed takeover below promotes this generic reason to the precise
      // human-handoff reason without reopening the enrollment.
      let propertyEnrollmentsPauseCompleted = Boolean(
        inboundState.propertyEnrollmentsPausedAt,
      );
      if (!propertyEnrollmentsPauseCompleted) {
        try {
          // pausePropertyEnrollments only touches active rows. While a Norma
          // call holds this lead, enrollments already paused as `norma_call`
          // or a held `call_in_progress` must also record the reply, or a
          // later Norma no-answer / softphone cleanup could resume them.
          // This runs BEFORE the pause: if a Norma no-answer completed between
          // the two steps, the release would reactivate the row and the
          // upgrade would then see no hold. In this order the pause that
          // follows catches anything the release reactivated.
          // Its own try/catch: a failed upgrade must never skip the fail-safe
          // pause below.
          try {
            await upgradeNormaHoldPauses(supabase, {
              propertyId: effectivePropertyId,
              reason: "inbound_reply",
            });
          } catch (upgradeError) {
            reportError(upgradeError, {
              tags: { surface: "inbound_norma_hold_upgrade" },
              extra: { propertyId: effectivePropertyId },
            });
          }
          await pausePropertyEnrollments(supabase, {
            propertyId: effectivePropertyId,
            reason: "inbound_reply",
          });
          propertyEnrollmentsPauseCompleted = true;
          await markInboundMessageState(supabase, insertOutcome.messageId, {
            propertyEnrollmentsPausedAt: new Date().toISOString(),
          });
        } catch (e) {
          reportError(e, {
            tags: {
              surface: `${provider.providerId}_webhook_sequence_pause_inbound`,
            },
            extra: {
              propertyId: effectivePropertyId,
              externalId: ev.externalId,
              reason: "inbound_reply",
            },
          });
        }
      }

      // A reply to a human rep SMS belongs to that lead's assigned rep. The
      // outbound metadata is the durable handoff marker; record the takeover
      // before considering any AI path so both immediate and delayed replies
      // observe the existing attention/thread suppression state.
      let repSmsHumanTakeover = false;
      let takeoverSource: Awaited<
        ReturnType<typeof findRepSmsHumanTakeoverSource>
      > = null;
      try {
        takeoverSource = await findRepSmsHumanTakeoverSource(supabase, {
          conversationId: insertOutcome.conversationId,
          propertyId: effectivePropertyId,
          contactId: effectiveContactId,
          inboundMessageId: insertOutcome.messageId,
          inboundReceivedAt: ev.receivedAt.toISOString(),
          inboundToNumber: ev.to,
        });
      } catch (e) {
        // A lookup error does not establish that this inbound belongs to a
        // rep SMS. Do not mark an ordinary inbound as a takeover. Mark the
        // webhook event as retryable and leave the intent incomplete so the
        // provider can deliver it again after the database recovers.
        reportError(e, {
          tags: {
            surface: `${provider.providerId}_webhook_rep_sms_human_takeover`,
          },
          extra: {
            propertyId: effectivePropertyId,
            externalId: ev.externalId,
            inboundMessageId: insertOutcome.messageId,
          },
        });
        await failInboundWebhookForRetry(
          supabase,
          provider.providerId,
          ev.externalId,
          e,
        );
      }

      if (takeoverSource) {
        try {
          await recordRepSmsHumanTakeover(supabase, {
            propertyId: effectivePropertyId,
            conversationId: insertOutcome.conversationId,
            inboundMessageId: insertOutcome.messageId,
            source: takeoverSource,
          });
          await markInboundMessageState(supabase, insertOutcome.messageId, {
            aiResponder: {
              outcome: "escalated",
              reason: REP_SMS_HUMAN_TAKEOVER_REASON,
              completedAt: new Date().toISOString(),
            },
          });
          // The fail-safe pause above may have already changed active rows to
          // `paused/inbound_reply`. If it failed, rows may still be active.
          // Cover both states and only then acknowledge the takeover so the
          // exact reason is durable even across retries or concurrent
          // deliveries.
          // Upgrade Norma-held pauses first (see the reply path above), then
          // pause and promote whatever remains.
          try {
            await upgradeNormaHoldPauses(supabase, {
              propertyId: effectivePropertyId,
              reason: REP_SMS_HUMAN_TAKEOVER_REASON,
            });
          } catch (upgradeError) {
            // Never let this skip the fail-safe pause below.
            reportError(upgradeError, {
              tags: { surface: "inbound_norma_hold_upgrade" },
              extra: { propertyId: effectivePropertyId },
            });
          }
          await pausePropertyEnrollments(supabase, {
            propertyId: effectivePropertyId,
            reason: REP_SMS_HUMAN_TAKEOVER_REASON,
          });
          await promotePropertyEnrollmentPauseReason(supabase, {
            propertyId: effectivePropertyId,
            fromReason: "inbound_reply",
            reason: REP_SMS_HUMAN_TAKEOVER_REASON,
          });
          if (!propertyEnrollmentsPauseCompleted) {
            await markInboundMessageState(supabase, insertOutcome.messageId, {
              propertyEnrollmentsPausedAt: new Date().toISOString(),
            });
            propertyEnrollmentsPauseCompleted = true;
          }
          repSmsHumanTakeover = true;
        } catch (e) {
          // The source is confirmed, so an incomplete durable write must not
          // be treated like an ordinary inbound. Keep the property attention
          // gate fail-closed when possible, but always retry until the full
          // takeover state has been persisted.
          reportError(e, {
            tags: {
              surface: `${provider.providerId}_webhook_rep_sms_human_takeover_persistence`,
            },
            extra: {
              propertyId: effectivePropertyId,
              externalId: ev.externalId,
              inboundMessageId: insertOutcome.messageId,
            },
          });
          try {
            await persistRepSmsHumanTakeoverFallback(
              supabase,
              effectivePropertyId,
            );
          } catch (fallbackError) {
            reportError(fallbackError, {
              tags: {
                surface: `${provider.providerId}_webhook_rep_sms_human_takeover_fallback`,
              },
              extra: {
                propertyId: effectivePropertyId,
                externalId: ev.externalId,
                inboundMessageId: insertOutcome.messageId,
              },
            });
          }
          await failInboundWebhookForRetry(
            supabase,
            provider.providerId,
            ev.externalId,
            e,
          );
        }
      }

      if (repSmsHumanTakeover) {
        await recordStep(supabase, runCtx, {
          kind: "gate",
          name: "rep_sms_human_takeover",
          result: "block",
        });
        await finishRun(supabase, runCtx, {
          status: "skipped",
          finalOutcome: "skipped",
          reason: REP_SMS_HUMAN_TAKEOVER_REASON,
        });
        await markWebhookEventProcessed(
          supabase,
          provider.providerId,
          ev.externalId,
        );
        await markInboundSmsIntentSideEffectsComplete(
          supabase,
          intentClaim.intentId,
        );
        continue;
      }

      if (effectiveContactId && !inboundState.aiResponder) {
        try {
          const dispatchInput: AiDispatchInput = {
            propertyId: effectivePropertyId,
            contactId: effectiveContactId,
            conversationId: insertOutcome.conversationId,
            inboundFromPhone: ev.from,
            inboundToPhone: ev.to,
            inboundBody: ev.body,
            inboundMessageId: insertOutcome.messageId,
            runId: runCtx?.runId ?? null,
          };
          const delayConfig = await loadAiReplyDelayConfig(
            supabase,
            effectivePropertyId,
          );
          const delaySeconds = delayConfig
            ? computeReplyDelaySeconds({
                minSeconds: delayConfig.delayMinSeconds,
                maxSeconds: delayConfig.delayMaxSeconds,
                inboundLength: ev.body.length,
                propertyState: delayConfig.propertyState,
              })
            : 0;

          // A reply is dispatched synchronously inside the webhook ONLY when the
          // org has no reply delay at all (max = 0, or no active config). With a
          // non-zero max, a computed 0 (no property state, quiet-hours clamp, low
          // random draw) still goes through the delay workflow so approved
          // template replies are never sent from the webhook request itself.
          const replyDelayConfigured = (delayConfig?.delayMaxSeconds ?? 0) > 0;
          if (delaySeconds === 0 && !replyDelayConfigured) {
            // Jarrad: replies must use the random delay. An inline dispatch has
            // none (org max = 0, or the lookup failed and returned null), so
            // approved-template replies are dropped here; the outcome still
            // applies and LLM / identity replies are unchanged.
            await dispatchAndStampAiResponder(
              supabase,
              {
                ...dispatchInput,
                replyDelayBypassed: true,
                replyDelayBypassReason: delayConfig ? "delay_not_configured" : "delay_unavailable",
              },
              runCtx,
            );
          } else {
            const preGates = await checkAiResponderDispatchPreGates(
              supabase,
              dispatchInput,
              { runContext: runCtx },
            );
            if (!preGates.ok) {
              await stampAiResponderTerminalOutcome(supabase, {
                messageId: insertOutcome.messageId,
                conversationId: insertOutcome.conversationId,
                outcome: preGates.outcome,
                runContext: runCtx,
              });
            } else {
              const keywordEscalation = await applyKeywordEscalation(supabase, {
                propertyId: effectivePropertyId,
                inboundBody: ev.body,
                escalationKeywords: delayConfig!.escalationKeywords,
                runContext: runCtx,
              });

              if (keywordEscalation.escalated) {
                await stampAiResponderTerminalOutcome(supabase, {
                  messageId: insertOutcome.messageId,
                  conversationId: insertOutcome.conversationId,
                  outcome: {
                    outcome: "escalated",
                    reason: keywordEscalation.reason,
                  },
                  runContext: runCtx,
                });
              } else {
                const scheduledAt = new Date(
                  Date.now() + delaySeconds * 1000,
                ).toISOString();
                try {
                  const run = await start(aiReplyDelayWorkflow, [
                    {
                      propertyId: effectivePropertyId,
                      contactId: effectiveContactId,
                      conversationId: insertOutcome.conversationId,
                      inboundFromPhone: ev.from,
                      inboundToPhone: ev.to,
                      inboundBody: ev.body,
                      inboundMessageId: insertOutcome.messageId,
                      delaySeconds,
                      runId: runCtx?.runId ?? null,
                    },
                  ]);
                  await recordStep(supabase, runCtx, {
                    kind: "action",
                    name: "reply_delay_scheduled",
                    result: "applied",
                    detail: { delaySeconds },
                  });

                  try {
                    await markInboundMessageState(
                      supabase,
                      insertOutcome.messageId,
                      {
                        aiResponder: {
                          outcome: "delayed",
                          delaySeconds,
                          scheduledAt,
                          workflowRunId: run.runId,
                        },
                      },
                    );
                  } catch (stampError) {
                    reportError(stampError, {
                      tags: {
                        surface: `${provider.providerId}_webhook_ai_responder_workflow_stamp`,
                      },
                      extra: {
                        propertyId: effectivePropertyId,
                        externalId: ev.externalId,
                        inboundMessageId: insertOutcome.messageId,
                        workflowRunId: run.runId,
                      },
                    });
                  }
                } catch (e) {
                  reportError(e, {
                    tags: {
                      surface: `${provider.providerId}_webhook_ai_responder_workflow_start`,
                    },
                    extra: {
                      propertyId: effectivePropertyId,
                      externalId: ev.externalId,
                      inboundMessageId: insertOutcome.messageId,
                    },
                  });
                  try {
                    await dispatchAndStampAiResponder(
                      supabase,
                      // No randomized delay on this path: template replies are
                      // dropped (the outcome still applies).
                      { ...dispatchInput, replyDelayBypassed: true },
                      runCtx,
                    );
                  } catch (fallbackError) {
                    reportError(fallbackError, {
                      tags: {
                        surface: `${provider.providerId}_webhook_ai_responder_workflow_fallback`,
                      },
                      extra: {
                        propertyId: effectivePropertyId,
                        externalId: ev.externalId,
                        inboundMessageId: insertOutcome.messageId,
                      },
                    });
                    await markPropertyNeedsAttention(
                      supabase,
                      effectivePropertyId,
                      "workflow_start_and_fallback_failed",
                    );
                    await finishRun(supabase, runCtx, {
                      status: "error",
                      finalOutcome: "error",
                      reason: "workflow_start_and_fallback_failed",
                    });
                    await markInboundMessageState(
                      supabase,
                      insertOutcome.messageId,
                      {
                        aiResponder: {
                          outcome: "error",
                          reason: "workflow_start_and_fallback_failed",
                          completedAt: new Date().toISOString(),
                        },
                      },
                    );
                  }
                }
              }
            }
          }
        } catch (e) {
          reportError(e, {
            tags: { surface: `${provider.providerId}_webhook_ai_responder` },
            extra: {
              propertyId: effectivePropertyId,
              externalId: ev.externalId,
            },
          });
          await finishRun(supabase, runCtx, {
            status: "error",
            finalOutcome: "error",
            reason: "ai_responder_exception",
          });
        }
      } else if (!effectiveContactId) {
        await finishRun(supabase, runCtx, {
          status: "skipped",
          finalOutcome: "skipped",
          reason: "no_contact",
        });
      }

      await markWebhookEventProcessed(
        supabase,
        provider.providerId,
        ev.externalId,
      );
      await markInboundSmsIntentSideEffectsComplete(
        supabase,
        intentClaim.intentId,
      );
    }

    return NextResponse.json({ ok: true });
  } catch (e) {
    reportError(e, { tags: { surface: "messaging_webhook_unexpected" } });
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "unknown" },
      { status: 500 },
    );
  }
}

export async function insertInboundMessage(
  supabase: SupabaseClient<Database>,
  input: {
    providerId: string;
    externalId: string;
    from: string;
    to: string;
    body: string;
    contactId: string | null;
    propertyId: string | null;
    conversationId: string | null;
    inboundIntentId: string | null;
    attributedOutboundMessageId: string | null;
    metadata: Json | null;
  },
) {
  const { data: existing, error: lookupError } = await supabase
    .from("messages")
    .select("id, metadata, contact_id, property_id, conversation_id")
    .eq("channel", "sms")
    .eq("direction", "inbound")
    .eq("provider", input.providerId)
    .eq("external_id", input.externalId)
    .limit(1);
  if (lookupError) return { duplicate: false, error: lookupError };
  if ((existing ?? []).length > 0) {
    return {
      duplicate: true,
      error: null as null,
      messageId: existing?.[0]?.id ?? null,
      metadata: existing?.[0]?.metadata ?? null,
      contactId: existing?.[0]?.contact_id ?? null,
      propertyId: existing?.[0]?.property_id ?? null,
      conversationId: existing?.[0]?.conversation_id ?? null,
    };
  }

  const messageInsert = {
    channel: "sms" as const,
    direction: "inbound" as const,
    status: "received" as const,
    provider: input.providerId,
    external_id: input.externalId,
    from_address: normalizePhone(input.from) ?? input.from,
    to_address: normalizePhone(input.to) ?? input.to,
    body: input.body,
    contact_id: input.contactId,
    property_id: input.propertyId,
    conversation_id: input.conversationId,
    inbound_intent_id: input.inboundIntentId,
    attributed_outbound_message_id: input.attributedOutboundMessageId,
    metadata: input.metadata,
  };
  const insert = () =>
    supabase
      .from("messages")
      .insert(messageInsert)
      .select("id, metadata, contact_id, property_id, conversation_id")
      .maybeSingle();
  let { data: inserted, error } = await insert();
  if (error?.code === "40P01") {
    ({ data: inserted, error } = await insert());
  }
  if (!error) {
    await clearAiResponderThreadState(
      supabase,
      inserted?.conversation_id ?? null,
    );
    await markInboundSmsIntentMessageInserted(
      supabase,
      input.inboundIntentId,
      inserted?.id ?? null,
    );
    return {
      duplicate: false,
      error: null as null,
      messageId: inserted?.id ?? null,
      metadata: inserted?.metadata ?? null,
      contactId: inserted?.contact_id ?? null,
      propertyId: inserted?.property_id ?? null,
      conversationId: inserted?.conversation_id ?? null,
    };
  }
  if (error.code === "23505") {
    const { data: duplicate } = await supabase
      .from("messages")
      .select("id, metadata, contact_id, property_id, conversation_id")
      .eq("channel", "sms")
      .eq("direction", "inbound")
      .eq("provider", input.providerId)
      .eq("external_id", input.externalId)
      .limit(1)
      .maybeSingle();
    return {
      duplicate: true,
      error: null as null,
      messageId: duplicate?.id ?? null,
      metadata: duplicate?.metadata ?? null,
      contactId: duplicate?.contact_id ?? null,
      propertyId: duplicate?.property_id ?? null,
      conversationId: duplicate?.conversation_id ?? null,
    };
  }
  return {
    duplicate: false,
    error,
    messageId: null,
    metadata: null,
    contactId: null,
    propertyId: null,
    conversationId: null,
  };
}

function jsonObject(value: Json): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

async function reserveWebhookEvent(
  supabase: SupabaseClient<Database>,
  input: { provider: string; externalId: string; payload: Json },
): Promise<
  | { status: "reserved"; webhookEventId: string | null }
  | { status: "skip" }
  | { status: "error"; message: string }
> {
  const now = new Date().toISOString();
  const { data: inserted, error } = await supabase
    .from("webhook_events")
    .insert({
      provider: input.provider,
      event_type: "sms_inbound",
      external_id: input.externalId,
      signature_verified: true,
      processing_status: "processing",
      processing_started_at: now,
      payload: input.payload,
    })
    .select("id")
    .maybeSingle();
  if (!error)
    return { status: "reserved", webhookEventId: inserted?.id ?? null };
  if (isMissingWebhookProcessingClaimSupport(error.message)) {
    return reserveWebhookEventLegacy(supabase, input);
  }
  if (error.code !== "23505")
    return { status: "error", message: error.message };

  const { data: existing, error: existingError } = await supabase
    .from("webhook_events")
    .select("processing_status, processing_started_at")
    .eq("provider", input.provider)
    .eq("event_type", "sms_inbound")
    .eq("external_id", input.externalId)
    .maybeSingle();
  if (existingError) return { status: "error", message: existingError.message };
  if (existing?.processing_status === "processed") return { status: "skip" };
  if (
    existing?.processing_status === "processing" &&
    !isWebhookProcessingLeaseExpired(existing.processing_started_at)
  ) {
    return { status: "skip" };
  }

  let claim = supabase
    .from("webhook_events")
    .update({
      processing_status: "processing",
      processing_started_at: now,
      processed_at: null,
      error_message: null,
      signature_verified: true,
      payload: input.payload,
    })
    .eq("provider", input.provider)
    .eq("event_type", "sms_inbound")
    .eq("external_id", input.externalId);

  if (existing?.processing_status) {
    claim = claim.eq("processing_status", existing.processing_status);
  }
  if (existing?.processing_started_at) {
    claim = claim.eq("processing_started_at", existing.processing_started_at);
  } else {
    claim = claim.is("processing_started_at", null);
  }

  const { data: claimed, error: claimError } = await claim
    .select("id")
    .maybeSingle();
  if (claimError) return { status: "error", message: claimError.message };
  if (!claimed) return { status: "skip" };
  return { status: "reserved", webhookEventId: claimed.id };
}

async function reserveWebhookEventLegacy(
  supabase: SupabaseClient<Database>,
  input: { provider: string; externalId: string; payload: Json },
): Promise<
  | { status: "reserved"; webhookEventId: string | null }
  | { status: "skip" }
  | { status: "error"; message: string }
> {
  const { data: inserted, error } = await supabase
    .from("webhook_events")
    .insert({
      provider: input.provider,
      event_type: "sms_inbound",
      external_id: input.externalId,
      signature_verified: true,
      processing_status: "pending",
      payload: input.payload,
    })
    .select("id")
    .maybeSingle();
  if (!error)
    return { status: "reserved", webhookEventId: inserted?.id ?? null };
  if (error.code !== "23505")
    return { status: "error", message: error.message };

  const { data: existing, error: existingError } = await supabase
    .from("webhook_events")
    .select("processing_status")
    .eq("provider", input.provider)
    .eq("event_type", "sms_inbound")
    .eq("external_id", input.externalId)
    .maybeSingle();
  if (existingError) return { status: "error", message: existingError.message };
  if (existing?.processing_status === "processed") return { status: "skip" };
  return {
    status: "error",
    message:
      "legacy webhook replay cannot be safely claimed without processing_started_at support",
  };
}

async function markWebhookEventProcessed(
  supabase: SupabaseClient<Database>,
  providerId: string,
  externalId: string,
) {
  const { data, error } = await supabase
    .from("webhook_events")
    .update({
      processing_status: "processed",
      processed_at: new Date().toISOString(),
    })
    .eq("provider", providerId)
    .eq("event_type", "sms_inbound")
    .eq("external_id", externalId)
    .select("id");
  if (error) {
    throw new Error(`markWebhookEventProcessed: ${error.message}`);
  }
  if ((data ?? []).length !== 1) {
    throw new Error(
      `markWebhookEventProcessed: expected one webhook event for ${providerId}/${externalId}`,
    );
  }
}

async function markWebhookEventError(
  supabase: SupabaseClient<Database>,
  providerId: string,
  externalId: string,
  message: string,
) {
  const { data, error } = await supabase
    .from("webhook_events")
    .update({
      processing_status: "error",
      processed_at: new Date().toISOString(),
      error_message: message,
    })
    .eq("provider", providerId)
    .eq("event_type", "sms_inbound")
    .eq("external_id", externalId)
    .select("id");
  if (error) {
    throw new Error(`markWebhookEventError: ${error.message}`);
  }
  if ((data ?? []).length !== 1) {
    throw new Error(
      `markWebhookEventError: expected one webhook event for ${providerId}/${externalId}`,
    );
  }
}

/**
 * Mark a reserved inbound as retryable, then fail the request. This helper is
 * intentionally used before the intent side-effects-complete marker: a
 * takeover lookup or persistence failure must never be acknowledged as done.
 */
async function failInboundWebhookForRetry(
  supabase: SupabaseClient<Database>,
  providerId: string,
  externalId: string,
  cause: unknown,
): Promise<never> {
  const message =
    cause instanceof Error
      ? cause.message
      : "rep SMS takeover processing failed";
  try {
    await markWebhookEventError(supabase, providerId, externalId, message);
  } catch (markError) {
    reportError(markError, {
      tags: { surface: `${providerId}_webhook_retry_marker` },
      extra: { externalId },
    });
  }
  throw cause instanceof Error ? cause : new Error(message);
}

function isWebhookProcessingLeaseExpired(
  processingStartedAt: string | null,
): boolean {
  if (!processingStartedAt) return true;
  const startedAt = new Date(processingStartedAt).getTime();
  if (Number.isNaN(startedAt)) return true;
  return Date.now() - startedAt > WEBHOOK_PROCESSING_LEASE_MS;
}

function isMissingWebhookProcessingClaimSupport(message: string): boolean {
  return (
    message.includes("processing_started_at") ||
    (message.includes("processing_status") &&
      message.includes("check constraint"))
  );
}

/**
 * Hold an opt-out PHRASE match for a person (no suppression). Drips are paused
 * (reversible, like any inbound reply) and the property is flagged with the
 * originating inbound message id, so "Confirm do-not-contact" acts on exactly
 * that message's contact and number. Hostile wording gets the hostile reason.
 * Never throws.
 */
async function holdPhraseOptOut(
  supabase: SupabaseClient<Database>,
  args: {
    propertyId: string;
    body: string;
    inboundMessageId: string | null;
    surface: string;
    forceReason?: string;
  },
): Promise<boolean> {
  try {
    const base = args.forceReason ?? (isHostileInbound(args.body) ? HOSTILE_NEEDS_CONFIRM_REASON : OPTOUT_PHRASE_NEEDS_CONFIRM_REASON);
    const reason = args.inboundMessageId ? `${base}:${args.inboundMessageId}` : base;
    try {
      await pausePropertyEnrollments(supabase, { propertyId: args.propertyId, reason: "inbound_reply" });
    } catch (e) {
      reportError(e, { tags: { surface: `${args.surface}_webhook_sequence_pause_opt_out_phrase` }, extra: { propertyId: args.propertyId } });
    }
    return await flagConfirmDncHold(supabase, args.propertyId, reason);
  } catch (e) {
    reportError(e, { tags: { surface: `${args.surface}_webhook_opt_out_phrase_hold` }, extra: { propertyId: args.propertyId } });
    return false;
  }
}

async function dispatchAndStampAiResponder(
  supabase: SupabaseClient<Database>,
  input: AiDispatchInput,
  runContext?: PipelineRunContext | null,
): Promise<AiDispatchOutcome | AiRetryOutcome> {
  const outcome = await dispatchAiResponse(supabase, input, {
    anthropic: new Anthropic(),
    ...(runContext ? { runContext } : {}),
  });
  if (isRetryOutcome(outcome)) {
    // Nothing was sent or stored. Re-dispatch the same inbound through the
    // delay workflow; the run stays `running` and the inbound is NOT stamped
    // terminal. It is stamped `delayed`, and that stamp does two real jobs:
    //  - a webhook REDELIVERY of this inbound is skipped by the
    //    `!inboundState.aiResponder` gate in the webhook handler (no second
    //    dispatch races the retry);
    //  - a LATER inbound's run treats this one as handled (see
    //    `newerInboundIsHandled` in ai-responder/dispatch), so it neither
    //    flags nor double-answers while the retry is pending.
    if (await scheduleReplyRetry(supabase, input, outcome, runContext)) {
      return outcome;
    }
    // Could not even schedule it (Q8 rule 7): the generated reply is
    // dead-lettered (its only durable copy) and a human is flagged rather than
    // dropping it. A dead letter that cannot be written changes the flag to
    // dead_letter_failed:<reason>.
    await flagAndDeadLetter(supabase, {
      runContext,
      orgId: outcome.reply?.orgId ?? "",
      conversationId: input.conversationId ?? null,
      propertyId: input.propertyId,
      inboundMessageId: input.inboundMessageId ?? null,
      body: outcome.reply?.body ?? null,
      reason: outcome.reason,
      flagReason:
        outcome.reason === "draft_persist_failed"
          ? outcome.reason
          : `reply_skipped:${outcome.reason}`,
    });
    const terminal: AiDispatchOutcome = {
      outcome: "escalated",
      reason: outcome.reason,
    };
    await stampAiResponderTerminalOutcome(supabase, {
      messageId: input.inboundMessageId!,
      conversationId: input.conversationId ?? null,
      outcome: terminal,
      runContext,
    });
    return terminal;
  }
  await stampAiResponderTerminalOutcome(supabase, {
    messageId: input.inboundMessageId!,
    conversationId: input.conversationId ?? null,
    outcome,
    runContext,
  });
  return outcome;
}

async function scheduleReplyRetry(
  supabase: SupabaseClient<Database>,
  input: AiDispatchInput,
  retry: AiRetryOutcome,
  runContext?: PipelineRunContext | null,
): Promise<boolean> {
  try {
    const run = await start(aiReplyDelayWorkflow, [
      {
        propertyId: input.propertyId,
        contactId: input.contactId,
        conversationId: input.conversationId ?? null,
        inboundFromPhone: input.inboundFromPhone ?? null,
        inboundToPhone: input.inboundToPhone ?? null,
        inboundBody: input.inboundBody,
        inboundMessageId: input.inboundMessageId!,
        delaySeconds: retry.delaySeconds,
        runId: runContext?.runId ?? input.runId ?? null,
        retryAttempt: retry.attempt,
        ...(retry.reply ? { retryReply: retry.reply } : {}),
      },
    ]);
    await recordRetryScheduled(supabase, runContext, retry);
    try {
      await markInboundMessageState(supabase, input.inboundMessageId!, {
        aiResponder: {
          outcome: "delayed",
          delaySeconds: retry.delaySeconds,
          scheduledAt: new Date(
            Date.now() + retry.delaySeconds * 1000,
          ).toISOString(),
          workflowRunId: run.runId,
          retryAttempt: retry.attempt,
          retryReason: retry.reason,
        },
      });
    } catch (stampError) {
      reportError(stampError, {
        tags: { surface: "ai_responder_retry_stamp" },
        extra: { inboundMessageId: input.inboundMessageId },
      });
    }
    return true;
  } catch (e) {
    reportError(e, {
      tags: { surface: "ai_responder_retry_schedule" },
      extra: { inboundMessageId: input.inboundMessageId, reason: retry.reason },
    });
    return false;
  }
}

/**
 * Evidence for the keyword exits that insert the inbound message before the
 * AI path: one run, one blocking gate step, terminal state. Never throws.
 */
async function recordKeywordExitRun(
  supabase: SupabaseClient<Database>,
  args: {
    orgId: string | null;
    insertOutcome: {
      messageId?: string | null;
      contactId?: string | null;
      propertyId?: string | null;
      conversationId?: string | null;
    };
    body: string;
    gate:
      "stop_keyword" | "dnc_keyword" | "help_keyword" | "wrong_number_keyword";
    status: "closed" | "skipped" | "held";
    reason: string;
  },
): Promise<void> {
  try {
    if (!args.orgId || !args.insertOutcome.messageId) return;
    const ctx = await startRun(supabase, {
      orgId: args.orgId,
      inboundMessageId: args.insertOutcome.messageId,
      propertyId: args.insertOutcome.propertyId ?? null,
      contactId: args.insertOutcome.contactId ?? null,
      conversationId: args.insertOutcome.conversationId ?? null,
      mode: "legacy",
      inboundPreview: args.body,
    });
    await recordStep(supabase, ctx, {
      kind: "gate",
      name: args.gate,
      result: "block",
    });
    await finishRun(supabase, ctx, {
      status: args.status,
      finalOutcome: args.status,
      reason: args.reason,
    });
  } catch {
    // Evidence is best-effort; never affect message handling.
  }
}

async function stampAiResponderTerminalOutcome(
  supabase: SupabaseClient<Database>,
  args: {
    messageId: string;
    conversationId: string | null;
    outcome: AiDispatchOutcome;
    runContext?: PipelineRunContext | null;
  },
): Promise<void> {
  const completedAt = new Date().toISOString();
  await finishRunFromOutcome(supabase, args.runContext, args.outcome);
  await recordAiResponderOutcomeForThread(supabase, {
    conversationId: args.conversationId,
    outcome: args.outcome,
    completedAt,
  });
  await markInboundMessageState(supabase, args.messageId, {
    aiResponder: {
      ...args.outcome,
      // `skipped:rule_<n>` for a silent exit (never the bare `skipped` the raw
      // outcome carries): rule 1 on a later inbound reads this stamp as handled,
      // and a webhook redelivery is skipped on its presence.
      outcome: inboundStampOutcomeOf(args.outcome),
      completedAt,
    } as unknown as AiDispatchOutcome & { completedAt: string },
  });
}
