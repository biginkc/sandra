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
  markPropertyNeedsAttention,
  type AiDispatchInput,
  type AiDispatchOutcome,
} from "@/lib/ai-responder/dispatch";
import {
  computeReplyDelaySeconds,
  loadAiReplyDelayConfig,
} from "@/lib/ai-responder/delay";
import { reportError } from "@/lib/errors/report";
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
import { pausePropertyEnrollments } from "@/lib/sequences/enrollment";
import type { Database, Json } from "@/lib/supabase/types";
import { aiReplyDelayWorkflow } from "@/workflows/ai-reply-delay";
import { applyPhoneLevelOptOut } from "./opt-out-phone";
import type { MessagingProvider } from "./types";

const UNAMBIGUOUS_STOP_KEYWORDS =
  /\b(?:stopall|unsubscribe|opt(?:\s|-)?out|remove me|take me off|delete my (?:number|info)|leave me alone|quit bothering me|do not contact me|don'?t text me again|lose (?:this|my) number|never contact me)\b|\bstop\b(?!\s+by\b)/i;
const AMBIGUOUS_STOP_KEYWORDS = /^\s*(end|cancel|quit|remove)\s*$/i;
const HELP_KEYWORDS = /^\s*(help|info|support)\s*$/i;
const DNC_KEYWORDS =
  /do not (call|text|contact|reach out|message)|don'?t (call|text|contact|reach out|message)|stop (texting|calling|contacting) me|take me off|no more (texts|messages|calls)|remove me from|stop reaching out|please delete my (number|info)|delete my (number|info)|lose (this|my) number|never contact me/i;
const WRONG_NUMBER_KEYWORDS =
  /wrong number|wrong person|not the owner|don'?t own|dont own|no longer own/i;
const WEBHOOK_PROCESSING_LEASE_MS = 5 * 60_000;

export function matchesStopKeyword(body: string) {
  return (
    UNAMBIGUOUS_STOP_KEYWORDS.test(body) ||
    AMBIGUOUS_STOP_KEYWORDS.test(body)
  );
}

export function classifyWrongNumberScope(body: string): "this_property" | "all" {
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
        attributedOutboundMessageId = await findAttributedOutboundMessageId(supabase, {
          contactId,
          toPhone: ev.to,
          propertyId,
          conversationId,
        });
      } catch (e) {
        reportError(e, {
          tags: { surface: `${provider.providerId}_inbound_attribution_lookup` },
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
        await markInboundSmsIntentSideEffectsComplete(
          supabase,
          intentClaim.intentId,
        );
        continue;
      }

      if (DNC_KEYWORDS.test(ev.body)) {
        if (!orgId) {
          throw new Error("DNC webhook could not resolve org for phone suppression");
        }
        await applyPhoneLevelOptOut(supabase, {
          contactId,
          fromPhone: ev.from,
          orgId,
          source,
          sourceDetail: {
            externalId: ev.externalId,
            from: ev.from,
            keyword: "dnc",
          },
          occurredAt: ev.receivedAt,
          providerId: provider.providerId,
          surface: "dnc",
          idempotencyKey: ev.externalId,
        });
        if (propertyId) {
          await supabase
            .from("properties")
            .update({ outreach_dispo: "dnc" })
            .eq("id", propertyId);
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
          metadata: { ...jsonObject(baseMetadata), keyword: "dnc" } as Json,
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

      if (matchesStopKeyword(bodyTrimmed)) {
        if (!orgId) {
          throw new Error("STOP webhook could not resolve org for phone suppression");
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
        });
        if (propertyId) {
          await supabase
            .from("properties")
            .update({ outreach_dispo: "opted_out" })
            .eq("id", propertyId)
            .or("outreach_dispo.is.null,outreach_dispo.in.(not_interested,wrong_number,opted_out)");
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
        if (propertyId) {
          await supabase
            .from("properties")
            .update({ outreach_dispo: "wrong_number" })
            .eq("id", propertyId);
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
        if (wrongScope === "all") {
          if (!orgId) {
            throw new Error(
              "wrong-number webhook could not resolve org for phone suppression",
            );
          }
          await applyPhoneLevelOptOut(supabase, {
            contactId,
            fromPhone: ev.from,
            orgId,
            source,
            sourceDetail: {
              externalId: ev.externalId,
              from: ev.from,
              keyword: "wrong_number",
              wrong_scope: wrongScope,
            },
            occurredAt: ev.receivedAt,
            providerId: provider.providerId,
            surface: "dnc",
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
          metadata: {
            ...jsonObject(baseMetadata),
            keyword: "wrong_number",
            wrong_scope: wrongScope,
          } as Json,
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

      if (!effectivePropertyId) {
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

      if (
        cur?.status === "prospect" &&
        ev.body &&
        !inboundState.autoQualifiedAt
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

      if (!inboundState.propertyEnrollmentsPausedAt) {
        try {
          await pausePropertyEnrollments(supabase, {
            propertyId: effectivePropertyId,
            reason: "inbound_reply",
          });
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
            },
          });
        }
      }

      if (effectiveContactId && !inboundState.aiResponder) {
        try {
          const dispatchInput: AiDispatchInput = {
            propertyId: effectivePropertyId,
            contactId: effectiveContactId,
            conversationId: insertOutcome.conversationId,
            inboundFromPhone: ev.from,
            inboundBody: ev.body,
            inboundMessageId: insertOutcome.messageId,
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

          if (delaySeconds === 0) {
            await dispatchAndStampAiResponder(supabase, dispatchInput);
          } else {
            const preGates = await checkAiResponderDispatchPreGates(
              supabase,
              dispatchInput,
            );
            if (!preGates.ok) {
              await stampAiResponderTerminalOutcome(supabase, {
                messageId: insertOutcome.messageId,
                conversationId: insertOutcome.conversationId,
                outcome: preGates.outcome,
              });
            } else {
              const keywordEscalation = await applyKeywordEscalation(supabase, {
                propertyId: effectivePropertyId,
                inboundBody: ev.body,
                escalationKeywords: delayConfig!.escalationKeywords,
              });

              if (keywordEscalation.escalated) {
                await stampAiResponderTerminalOutcome(supabase, {
                  messageId: insertOutcome.messageId,
                  conversationId: insertOutcome.conversationId,
                  outcome: {
                    outcome: "escalated",
                    reason: keywordEscalation.reason,
                  },
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
                      inboundBody: ev.body,
                      inboundMessageId: insertOutcome.messageId,
                      delaySeconds,
                    },
                  ]);

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
                    await dispatchAndStampAiResponder(supabase, dispatchInput);
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

async function insertInboundMessage(
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

  const { data: inserted, error } = await supabase
    .from("messages")
    .insert({
      channel: "sms",
      direction: "inbound",
      status: "received",
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
    })
    .select("id, metadata, contact_id, property_id, conversation_id")
    .maybeSingle();
  if (!error) {
    await clearAiResponderThreadState(supabase, inserted?.conversation_id ?? null);
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
  if (!error) return { status: "reserved", webhookEventId: inserted?.id ?? null };
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
  if (!error) return { status: "reserved", webhookEventId: inserted?.id ?? null };
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

async function dispatchAndStampAiResponder(
  supabase: SupabaseClient<Database>,
  input: AiDispatchInput,
): Promise<AiDispatchOutcome> {
  const outcome = await dispatchAiResponse(supabase, input, {
    anthropic: new Anthropic(),
  });
  await stampAiResponderTerminalOutcome(supabase, {
    messageId: input.inboundMessageId!,
    conversationId: input.conversationId ?? null,
    outcome,
  });
  return outcome;
}

async function stampAiResponderTerminalOutcome(
  supabase: SupabaseClient<Database>,
  args: {
    messageId: string;
    conversationId: string | null;
    outcome: AiDispatchOutcome;
  },
): Promise<void> {
  const completedAt = new Date().toISOString();
  await recordAiResponderOutcomeForThread(supabase, {
    conversationId: args.conversationId,
    outcome: args.outcome,
    completedAt,
  });
  await markInboundMessageState(supabase, args.messageId, {
    aiResponder: {
      ...args.outcome,
      completedAt,
    },
  });
}
