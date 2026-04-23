import type { SupabaseClient } from "@supabase/supabase-js";

import type { Database } from "@/lib/supabase/types";

/**
 * Starter-library definition. Migration 018 seeds this for every org
 * that exists at migration apply time; calling this helper seeds it
 * for a specific org later (e.g. when a new org is created, or after
 * integration tests truncate the sequence tables).
 *
 * Templates use `{{#if first_name}}` conditional wrappers because
 * skip-trace doesn't always capture a first name; the wrapper makes
 * the SMS render cleanly either way.
 *
 * 4 sequences ship in V1. The 5th ("Hot lead handoff") from the
 * original plan used `assign_task`, which depends on Feature 4c
 * (lead_tasks) — lands as a one-line append once that's ready.
 */

export type StarterSequence = {
  name: string;
  description: string;
  steps: ReadonlyArray<{
    delay_after_previous_minutes: number;
    action_type: "send_sms" | "change_status";
    template_body?: string;
    target_status?: string;
  }>;
};

export const STARTER_SEQUENCES: ReadonlyArray<StarterSequence> = [
  {
    name: "First touch new lead",
    description:
      "3-step nurture for newly-qualified leads, spaced over ~7 days.",
    steps: [
      {
        delay_after_previous_minutes: 0,
        action_type: "send_sms",
        template_body:
          "{{#if first_name}}Hi {{first_name}}, {{/if}}this is {{my_first_name}} with {{company_name}}. I saw your property at {{property_address}}. Would you consider a cash offer? {{opt_out}}",
      },
      {
        delay_after_previous_minutes: 60 * 24 * 2,
        action_type: "send_sms",
        template_body:
          "{{#if first_name}}Hi {{first_name}}, {{/if}}following up on {{property_address}}. Still open to a quick conversation? {{opt_out}}",
      },
      {
        delay_after_previous_minutes: 60 * 24 * 5,
        action_type: "send_sms",
        template_body:
          "{{#if first_name}}Hi {{first_name}}, {{/if}}one more try on {{property_address}} — happy to send an offer if you're interested. {{opt_out}}",
      },
    ],
  },
  {
    name: "Nurture cold lead",
    description: "Quarterly check-ins over 12 months for leads who went quiet.",
    steps: [
      {
        delay_after_previous_minutes: 0,
        action_type: "send_sms",
        template_body:
          "{{#if first_name}}Hi {{first_name}}, {{/if}}checking in on {{property_address}} — any change in plans? {{opt_out}}",
      },
      {
        delay_after_previous_minutes: 60 * 24 * 90,
        action_type: "send_sms",
        template_body:
          "{{#if first_name}}Hi {{first_name}}, {{/if}}quarterly check-in on {{property_address}}. Still in your plans? {{opt_out}}",
      },
      {
        delay_after_previous_minutes: 60 * 24 * 90,
        action_type: "send_sms",
        template_body:
          "{{#if first_name}}Hi {{first_name}}, {{/if}}another touch on {{property_address}}. Still curious if selling is on the table. {{opt_out}}",
      },
      {
        delay_after_previous_minutes: 60 * 24 * 90,
        action_type: "send_sms",
        template_body:
          "{{#if first_name}}Hope all's well, {{first_name}}. {{/if}}Any reason to chat about {{property_address}}? {{opt_out}}",
      },
    ],
  },
  {
    name: "Nurture not-interested",
    description:
      'Semi-annual revisit over 24 months for leads who said "not now".',
    steps: [
      {
        delay_after_previous_minutes: 60 * 24 * 180,
        action_type: "send_sms",
        template_body:
          "{{#if first_name}}Hi {{first_name}}, {{/if}}circling back on {{property_address}}. Circumstances change — still not a fit? {{opt_out}}",
      },
      {
        delay_after_previous_minutes: 60 * 24 * 180,
        action_type: "send_sms",
        template_body:
          "{{#if first_name}}Hi {{first_name}}, {{/if}}6-month check-in on {{property_address}}. Anything new on your end? {{opt_out}}",
      },
      {
        delay_after_previous_minutes: 60 * 24 * 180,
        action_type: "send_sms",
        template_body:
          "{{#if first_name}}Hi {{first_name}}, {{/if}}annual note on {{property_address}}. Any shift? {{opt_out}}",
      },
      {
        delay_after_previous_minutes: 60 * 24 * 180,
        action_type: "send_sms",
        template_body:
          "{{#if first_name}}Hi {{first_name}}, {{/if}}final touch on {{property_address}}. Reply anytime if you want to chat. {{opt_out}}",
      },
    ],
  },
  {
    name: "Dead lead requalify",
    description: '90-day re-touch to check if a "dead" lead is ready to revisit.',
    steps: [
      {
        delay_after_previous_minutes: 60 * 24 * 90,
        action_type: "send_sms",
        template_body:
          "{{#if first_name}}Hi {{first_name}}, {{/if}}it's been a few months since we chatted about {{property_address}}. Anything change on your end? {{opt_out}}",
      },
    ],
  },
];

/**
 * Idempotently seed the starter library for an org. Inserts missing
 * sequences (matched case-insensitively by name); skips sequences that
 * already exist (no re-seed of their steps — that would trash VAs'
 * customizations). Intended for new-org bootstrap and for test resets.
 */
export async function seedStarterLibrary(
  client: SupabaseClient<Database>,
  orgId: string,
): Promise<{ created: number; skipped: number }> {
  // Check which starter names already exist for this org.
  const { data: existing } = await client
    .from("sequences")
    .select("name")
    .eq("org_id", orgId);
  const existingLower = new Set(
    (existing ?? []).map((s) => s.name.toLowerCase()),
  );

  let created = 0;
  let skipped = 0;

  for (const starter of STARTER_SEQUENCES) {
    if (existingLower.has(starter.name.toLowerCase())) {
      skipped++;
      continue;
    }

    const { data: seq, error: seqErr } = await client
      .from("sequences")
      .insert({
        org_id: orgId,
        name: starter.name,
        description: starter.description,
      })
      .select("id")
      .single();
    if (seqErr || !seq) continue;

    for (let i = 0; i < starter.steps.length; i++) {
      const s = starter.steps[i];
      await client.from("sequence_steps").insert({
        sequence_id: seq.id,
        step_index: i,
        delay_after_previous_minutes: s.delay_after_previous_minutes,
        action_type: s.action_type,
        template_body: s.template_body ?? null,
        target_status: s.target_status ?? null,
      });
    }
    created++;
  }

  return { created, skipped };
}
