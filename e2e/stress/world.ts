import { randomUUID } from "node:crypto";

import { createClient } from "@supabase/supabase-js";

import {
  CI_DIALPAD_USER_ID,
  createSyntheticLead,
  designateRep,
  resetCloseWorld,
  seedDialpadForRep,
  seedFeatureFlags,
  seedSellerReminderSettings,
  type SyntheticLead,
} from "../support/my-leads-close-fixture";
import { enableDialpadDialing } from "../support/my-leads-p2-fixture";
import { MOCK_PROVIDER_CAMPAIGN_ID, MOCK_SENDER_PRIMARY, MOCK_SENDER_SECONDARY, seedProviderCampaignCatalog, seedSenderCatalog } from "../../tests/integration/delivery";
import type { StressConfig } from "./config";
import type { Db } from "./db";

/**
 * One org, one rep, ~70 synthetic non-training leads (`+1816555xxxx`, tagged with the run tag).
 * Flags only via `seedFeatureFlags`; no migration flips anything. Nothing is deleted at the end:
 * leads are retired (soft) by the fixture's own retire path, evidence is retained.
 */

/** Surfaces on for the chaos day. artifact_fetch, facts_job and comp_queue stay OFF: they reach third-party providers. */
export const FLAGS_ON = [
  "call_next_strip",
  "post_call_prompt",
  "click_to_dial",
  "native_matcher",
  "auto_prompt",
  "callback_alert",
  "call_screen",
  "contract_card",
  "seller_reminders",
  "offer_projection",
] as const;

export type WorldLead = SyntheticLead & { slot: number };
export type World = {
  orgId: string;
  repUserId: string;
  repEmail: string;
  repPassword: string;
  connectionId: string;
  bindingId: string;
  templateId: string;
  leads: WorldLead[];
  runTag: string;
};

export function leadPhone(i: number): string {
  if (!Number.isInteger(i) || i < 0 || i > 8999) throw new Error("lead index out of range");
  return `+1816555${String(1000 + i)}`;
}

export async function setupWorld(db: Db, cfg: StressConfig, env: Readonly<Record<string, string | undefined>> = process.env): Promise<World> {
  const admin = createClient(cfg.supabaseUrl, process.env.TEST_SUPABASE_SERVICE_ROLE_KEY ?? "", { auth: { persistSession: false, autoRefreshToken: false } });
  // The app's middleware admits only @bmhgroupkc.com addresses. This account exists only on the disposable local stack (no mail is ever sent).
  // The rep is created by provision-stack.mjs (the repo's e2e identity contract allows auth-user creation only there).
  const repEmail = env.STRESS_REP_EMAIL ?? "";
  const repPassword = env.STRESS_REP_PASSWORD ?? "";
  if (!repEmail || !repPassword) throw new Error("STRESS_REP_EMAIL and STRESS_REP_PASSWORD (printed by provision-stack.mjs, stress-env.json) are required");
  const found = await db.query<{ id: string }>("select id from auth.users where email=$1", [repEmail]);
  if (found.rowCount !== 1) throw new Error(`the rep ${repEmail} does not exist on this stack: provision it with e2e/stress/provision-stack.mjs`);
  const repUserId = found.rows[0]!.id;
  // The mock messaging provider needs the same sender/campaign catalog the e2e reset seeds.
  await seedSenderCatalog(admin as never, cfg.orgId, [MOCK_SENDER_PRIMARY, MOCK_SENDER_SECONDARY]);
  await seedProviderCampaignCatalog(admin as never, cfg.orgId, [MOCK_PROVIDER_CAMPAIGN_ID]);
  await db.query("insert into public.memberships(user_id,org_id,role) values ($1,$2,'member') on conflict (user_id,org_id) do nothing", [repUserId, cfg.orgId]);
  await designateRep(db, { orgId: cfg.orgId, repUserId });
  await seedFeatureFlags(db, cfg.orgId, FLAGS_ON);
  await seedSellerReminderSettings(db, cfg.orgId, true);
  const { connectionId, bindingId } = await seedDialpadForRep(db, { orgId: cfg.orgId, repUserId });
  await enableDialpadDialing(db, cfg.orgId);

  const leads: WorldLead[] = [];
  for (let i = 0; i < cfg.leadCount; i += 1) {
    const lead = await createSyntheticLead(db, { orgId: cfg.orgId, repUserId, runTag: cfg.runTag, phoneE164: leadPhone(i), lastTouchDaysAgo: 5 + (i % 40) });
    leads.push({ ...lead, slot: i });
  }
  const templateId = await seedEsignTemplate(db, cfg.orgId, repUserId);
  return { orgId: cfg.orgId, repUserId, repEmail, repPassword, connectionId, bindingId, templateId, leads, runTag: cfg.runTag };
}

/** A finalized e-sign template, so contract scenarios have something to send. Inert test data. */
async function seedEsignTemplate(db: Db, orgId: string, userId: string): Promise<string> {
  const id = randomUUID();
  await db.query(
    `insert into public.esign_template_staging_sources (id,org_id,storage_path,source_filename,source_size_bytes,content_type,source_sha256,created_by)
     values ($1,$2,$3,'purchase-agreement.pdf',1024,'application/pdf',$4,$5)`,
    [id, orgId, `${orgId}/${id}.pdf`, "c".repeat(64), userId],
  );
  await db.query(
    `insert into public.esign_templates (id,org_id,name,document_type,seller_role,signer_roles,merge_field_names,sign_template_id,provider_account_id,staging_source_id,source_filename,source_size_bytes,source_content_type,source_sha256,staging_path,finalized_at,lifecycle_state,created_by,updated_by)
     values ($1,$2,'Purchase agreement','purchase_agreement','Seller',$3::jsonb,$4,$5,'acct',$1,'purchase-agreement.pdf',1024,'application/pdf',$6,$7,now(),'finalized',$8,$8)`,
    [id, orgId, JSON.stringify([{ name: "Seller", order: 0 }]), ["seller_name", "property_address", "offer_price", "closing_date", "earnest_money"], `provider-template-${id}`, "c".repeat(64), `${orgId}/${id}.pdf`, userId],
  );
  return id;
}

/** Everything the harness switched on goes back to defaults (flags row deleted, connection disabled, bindings revoked). Leads are retired by the caller. */
export async function teardownWorld(db: Db, world: World): Promise<void> {
  await resetCloseWorld(db, { orgId: world.orgId, repUserId: world.repUserId });
}

export { CI_DIALPAD_USER_ID };
