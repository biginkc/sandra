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
import { ESIGN_RESIDENTIAL_FIELD_NAMES } from "../../src/lib/esign/contracts";
import { ESIGN_TEST_API_KEY, ESIGN_TEST_CALLBACK_HASH, ESIGN_TEST_CLIENT_ID, ESIGN_TEST_ENCRYPTION_KEY, ESIGN_TEST_PROVIDER_ACCOUNT_ID } from "../../tests/integration/fixtures/esign";
import { asService, type Db } from "./db";

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
  // Only the reserved fictional block 555-0100..0199 (0199 is the harness's unmatched-number probe), so a stray real send could never reach a real subscriber.
  if (!Number.isInteger(i) || i < 0 || i > 98) throw new Error("lead index out of range (0..98)");
  return `+1816555${String(100 + i).padStart(4, "0")}`;
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
  await seedEsignIntegration(db, cfg.orgId);
  // The contract card takes the legal description only from a complete, high-confidence, recent comp whose provider is 'attom'. This is
  // inert fixture data in the throwaway DB (no ATTOM call is ever made: the comps flags stay off), so the card can reach Send.
  await db.query(
    `insert into public.lead_comps(org_id, property_id, provider, confidence, verify_first, legal_description, legal_description_complete, owner_of_record)
     select $1, p.id, 'attom', 'high', false, 'LOT 1 STRESS FIXTURE SUBDIVISION', true, c.first_name || ' Seller'
     from public.properties p join public.contacts c on c.id = p.homeowner_contact_id where p.org_id = $1 and c.first_name = $2`,
    [cfg.orgId, cfg.runTag],
  );
  // The contract card needs the seller's e-mail for the signer. Throwaway address in a reserved TLD: the provider is a stub, nothing is ever sent.
  await db.query("update public.contacts set email = 'seller-' || id::text || '@example.invalid' where org_id = $1 and first_name = $2", [cfg.orgId, cfg.runTag]);
  return { orgId: cfg.orgId, repUserId, repEmail, repPassword, connectionId, bindingId, templateId, leads, runTag: cfg.runTag };
}

/** A finalized e-sign template (residential-v1 field set: the card's novation-v1 set needs a seller phone the card never supplies), so contract scenarios have something to send. Inert test data. */
async function seedEsignTemplate(db: Db, orgId: string, userId: string): Promise<string> {
  const id = randomUUID();
  await db.query(
    `insert into public.esign_template_staging_sources (id,org_id,storage_path,source_filename,source_size_bytes,content_type,source_sha256,created_by)
     values ($1,$2,$3,'purchase-agreement.pdf',1024,'application/pdf',$4,$5)`,
    [id, orgId, `${orgId}/${id}.pdf`, "c".repeat(64), userId],
  );
  await db.query(
    `insert into public.esign_templates (id,org_id,name,document_type,seller_role,signer_roles,merge_field_names,sign_template_id,provider_account_id,staging_source_id,source_filename,source_size_bytes,source_content_type,source_sha256,staging_path,finalized_at,lifecycle_state,created_by,updated_by)
     values ($1,$2,'Purchase agreement','purchase_agreement','Seller',$3::jsonb,$4,$5,$9,$1,'purchase-agreement.pdf',1024,'application/pdf',$6,$7,now(),'finalized',$8,$8)`,
    [id, orgId, JSON.stringify([{ name: "Seller", order: 0 }, { name: "Buyer", order: 1 }]), [...ESIGN_RESIDENTIAL_FIELD_NAMES], `provider-template-${id}`, "c".repeat(64), `${orgId}/${id}.pdf`, userId, ESIGN_TEST_PROVIDER_ACCOUNT_ID],
  );
  return id;
}

/**
 * Dropbox Sign connection for the disposable org, TEST MODE, so the My Leads contract card enables and its send reaches the
 * stub (DROPBOX_SIGN_API_BASE_URL, seam S3). The credentials are the repo's own integration-test constants; the app under
 * test must run with ESIGN_CREDENTIAL_ENCRYPTION_KEY=ESIGN_TEST_ENCRYPTION_KEY and DROPBOX_SIGN_CLIENT_ID=ESIGN_TEST_CLIENT_ID.
 * Nothing real: this DB is throwaway and the API base is loopback.
 */
async function seedEsignIntegration(db: Db, orgId: string): Promise<void> {
  const owner = await db.query<{ user_id: string }>("select user_id from public.memberships where org_id=$1 and role='owner' order by created_at limit 1", [orgId]);
  const actor = owner.rows[0]?.user_id;
  if (!actor) throw new Error("no owner membership on the stack: provision it with e2e/stress/provision-stack.mjs");
  await asService(db, async (q) => {
    await q.query("select public.upsert_org_esign_integration($1,$2,$3,$4,$5,$6,$7,$8)", [orgId, ESIGN_TEST_API_KEY, ESIGN_TEST_API_KEY.slice(-4), ESIGN_TEST_CLIENT_ID, ESIGN_TEST_PROVIDER_ACCOUNT_ID, ESIGN_TEST_CALLBACK_HASH, actor, ESIGN_TEST_ENCRYPTION_KEY]);
    // Real enablement requires a verified provider callback; on this disposable DB the verification is recorded directly.
    await q.query("update public.org_esign_integrations set callback_verified_at = now() where org_id=$1 and provider='dropbox_sign'", [orgId]);
    await q.query("select public.set_org_esign_sending_enabled($1,$2,true)", [orgId, actor]);
  });
}

/** Everything the harness switched on goes back to defaults (flags row deleted, connection disabled, bindings revoked). Leads are retired by the caller. */
export async function teardownWorld(db: Db, world: World): Promise<void> {
  await resetCloseWorld(db, { orgId: world.orgId, repUserId: world.repUserId });
}

export { CI_DIALPAD_USER_ID };
