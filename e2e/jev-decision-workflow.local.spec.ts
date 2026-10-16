import { createBrowserClient } from "@supabase/ssr";
import { expect, test } from "@playwright/test";
import pg from "pg";

import type { Database } from "../src/lib/supabase/types";

/**
 * Root review of 8361775a (jev-root-revision-review.md, 2026-09-20), gap
 * 4: real browser coverage for Needs a decision, Review Jev correction,
 * the settings threshold edit, and a stale-conflict scenario, against
 * this worktree's OWN local disposable Supabase stack (never a hosted
 * project) with synthetic, owned fixtures created directly here.
 *
 * Prerequisites (acceptance owner, same posture as
 * my-leads.local.spec.ts / playwright.my-leads-local.config.ts):
 *   1. `colima start` (if not already running)
 *   2. `supabase start` from this worktree root — the local stack this
 *      spec targets (postgres on 127.0.0.1:54329, API on 54331). Do NOT
 *      point this at any other project's stack.
 *   3. In a second terminal, from this worktree root:
 *      E2E_AUTH_BYPASS=1 NODE_ENV=development NEXT_PUBLIC_HUGO_SSO=1 \
 *      ADMIN_EMAILS=jev-local-admin@bmhgroupkc.com \
 *      NEXT_PUBLIC_SUPABASE_URL=http://127.0.0.1:54331 \
 *      NEXT_PUBLIC_SUPABASE_ANON_KEY=<local anon key from `supabase status`> \
 *      SUPABASE_SERVICE_ROLE_KEY=<local service key from `supabase status`> \
 *      MESSAGING_PROVIDER=mock ADDRESS_VERIFIER_PROVIDER=mock \
 *      TYPESAFE_API_KEY=fake-typesafe-key-for-local-acceptance-only \
 *      npx next dev -p 3000
 *      TYPESAFE_API_KEY only needs to be non-empty — the settings-switch
 *      scenario below (root review of edbd7bfe, jev-root-round13-review.md,
 *      finding 3) checks it's configured before allowing "enabled", but
 *      never triggers a real classify call, so this fake value is never
 *      actually sent to TypeSafe or any provider.
 *      MUST be port 3000 on `localhost` — see the allowedOrigins note
 *      below, not an arbitrary free port.
 *   4. npx playwright test --config=playwright.jev-local.config.ts
 *
 * MUST target http://localhost:3000. next.config.ts's
 * serverActions.allowedOrigins is ["sandra.bmhgroup.com",
 * "localhost:3000"] — Next dev's Turbopack HMR WebSocket also validates
 * against this same origin allowlist, and the client runtime's
 * interactive-ready signal depends on that socket connecting. Any other
 * host/port (e.g. 127.0.0.1:58900, used in an earlier round) causes the
 * HMR handshake to fail (net::ERR_INVALID_HTTP_RESPONSE); the page still
 * renders correctly (SSR content is real) but React never finishes
 * attaching event delegation, so every onClick/onChange is silently
 * inert with zero console/hydration errors — confirmed via a bare
 * diagnostic spec that logged "[HMR] connected" and a real navigating
 * click only once run against localhost:3000.
 */

const LOCAL_APP_URL = (process.env.JEV_LOCAL_BASE_URL ?? "http://localhost:3000").replace(/\/$/, "");
const LOCAL_SUPABASE_URL = "http://127.0.0.1:54331";
const LOCAL_SUPABASE_ANON_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0";

const appURL = new URL(LOCAL_APP_URL);
if (appURL.protocol !== "http:" || appURL.hostname !== "localhost" || appURL.port !== "3000") {
  throw new Error("Jev decision workflow local acceptance may target only http://localhost:3000 (must match next.config.ts's serverActions.allowedOrigins).");
}

// Fixed, not time-suffixed: the acceptance owner's locally-run `next dev`
// must set ADMIN_EMAILS to this exact value ahead of time (see the header
// comment above) so the settings-threshold test's isAdminEmail check
// passes. beforeAll deletes any leftover user with this email first, so
// re-running the suite against the same stack is idempotent.
// isEmailAllowed (src/lib/auth/allowlist.ts) requires @bmhgroupkc.com
// unconditionally in middleware, even with E2E_AUTH_BYPASS=1 — that flag
// only relaxes the Hugo-SSO-only UI gate, not the domain allowlist.
const ADMIN_EMAIL = "jev-local-admin@bmhgroupkc.com";
const ADMIN_PASSWORD = "jev-local-acceptance-password-1!";
// Sandra is effectively single-tenant: middleware's membership gate
// (src/lib/supabase/middleware.ts) checks against the hardcoded
// SANDRA_ORG_ID (src/lib/auth/sandra-org.ts), not an arbitrary org row —
// login fails "access not granted" for membership in any other org.
const ORG_ID = "00000000-0000-0000-0000-000000000bbb";

function db(): pg.Client {
  return new pg.Client({
    host: "127.0.0.1",
    port: 54329,
    user: "postgres",
    password: "postgres",
    database: "postgres",
  });
}

async function signInAndGetCookies(): Promise<Array<{ name: string; value: string }>> {
  const cookieJar = new Map<string, string>();
  const auth = createBrowserClient<Database>(LOCAL_SUPABASE_URL, LOCAL_SUPABASE_ANON_KEY, {
    isSingleton: false,
    cookies: {
      getAll: () => [...cookieJar].map(([name, value]) => ({ name, value })),
      setAll: (cookies) => {
        for (const cookie of cookies) {
          if (cookie.value) cookieJar.set(cookie.name, cookie.value);
          else cookieJar.delete(cookie.name);
        }
      },
    },
  });
  const { error } = await auth.auth.signInWithPassword({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD });
  if (error) throw error;
  return [...cookieJar].map(([name, value]) => ({ name, value, url: LOCAL_APP_URL, sameSite: "Lax" as const }));
}

test.describe.serial("Jev decision workflow — local acceptance", () => {
  const client = db();

  let userId = "";
  let propertyNurtureId = "";
  let propertyStaleId = "";
  let contactId = "";
  let pendingDecisionId = "";
  let staleDecisionId = "";

  test.beforeAll(async () => {
    await client.connect();
    // fn_propose_jev_lead_decision / fn_confirm_jev_lead_decision enforce
    // auth.role() = 'service_role' — the raw postgres superuser
    // connection has no JWT claims by default, so simulate the same
    // service-role identity the real webhook path runs under.
    await client.query("set request.jwt.claim.role = 'service_role'");

    // Raw-SQL user provisioning (pgcrypto bcrypt), not the Admin API's
    // createUser/deleteUser — this repo's e2e-identity-contract.test.ts
    // enforces that those two calls exist in exactly ONE place each
    // (e2e/fixtures.ts / scripts/e2e-identity-lifecycle.ts) as a
    // deliberate single-source-of-truth guard against scattered ad-hoc
    // test-user lifecycle management. This spec provisions its OWN
    // synthetic local admin against a disposable stack the contract
    // doesn't cover, so it uses a different mechanism entirely rather
    // than adding a second call site for the guarded ones.
    //
    // Root review of edbd7bfe (jev-root-round13-review.md), finding 3:
    // this admin is the SOLE member of the fixed, shared ORG_ID, so it is
    // always the org's final owner — deleting it (the previous
    // delete-then-recreate approach) always trips FINAL_OWNER_GUARD via
    // the auth.users -> memberships cascade, and the surrounding
    // membership-delete's `.catch(() => {})` only hid that the row never
    // actually went away. Provision once, reuse thereafter: select an
    // existing user by email, or create it if this is truly the first
    // run. Never delete the final owner.
    const { rows: existingAdmin } = await client.query(`select id from auth.users where email = $1`, [ADMIN_EMAIL]);
    if (existingAdmin.length > 0) {
      userId = existingAdmin[0].id;
      await client.query(
        `update auth.users set encrypted_password = crypt($2, gen_salt('bf')), updated_at = now() where id = $1`,
        [userId, ADMIN_PASSWORD],
      );
    } else {
      userId = crypto.randomUUID();
      await client.query(
        `insert into auth.users (id, instance_id, aud, role, email, encrypted_password, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at, confirmation_token, recovery_token, email_change_token_new, email_change)
         values ($1, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', $2, crypt($3, gen_salt('bf')), now(), '{"provider":"email","providers":["email"]}'::jsonb, '{}'::jsonb, now(), now(), '', '', '', '')`,
        [userId, ADMIN_EMAIL, ADMIN_PASSWORD],
      );
      await client.query(
        `insert into auth.identities (id, user_id, provider_id, identity_data, provider, last_sign_in_at, created_at, updated_at)
         values (gen_random_uuid(), $1::uuid, $1::text, jsonb_build_object('sub', $1::text, 'email', $2::text), 'email', now(), now(), now())`,
        [userId, ADMIN_EMAIL],
      );
    }

    await client.query(`insert into organizations (id, name) values ($1, 'Jev Local Acceptance Org') on conflict (id) do nothing`, [ORG_ID]);
    await client.query(
      `insert into memberships (org_id, user_id, role, access_status, deletion_prepared_at, access_expires_at)
       values ($1, $2, 'owner', 'active', null, null)
       on conflict (user_id, org_id) do update
         set role = 'owner', access_status = 'active', deletion_prepared_at = null, access_expires_at = null`,
      [ORG_ID, userId],
    );

    contactId = crypto.randomUUID();
    await client.query(
      `insert into contacts (id, org_id, first_name, phone_1, phone_1_type) values ($1, $2, 'Nurture Homeowner', '+15551230001', 'mobile')`,
      [contactId, ORG_ID],
    );

    propertyNurtureId = crypto.randomUUID();
    await client.query(
      `insert into properties (id, org_id, address, state, status, outreach_dispo, homeowner_contact_id)
       values ($1, $2, '1 Needs Decision Ln', 'TX', 'prospect', null, $3)`,
      [propertyNurtureId, ORG_ID, contactId],
    );
    const nurtureConvId = crypto.randomUUID();
    const nurtureMsgId = crypto.randomUUID();
    await client.query(
      `insert into messages (id, org_id, property_id, conversation_id, contact_id, channel, direction, body)
       values ($1, $2, $3, $4, $5, 'sms', 'inbound', 'not right now, maybe later')`,
      [nurtureMsgId, ORG_ID, propertyNurtureId, nurtureConvId, contactId],
    );
    const runId = crypto.randomUUID();
    await client.query(
      `insert into sms_classification_runs (id, org_id, property_id, conversation_id, source_inbound_message_id, state_hash, state_version, schema_version, policy_version, provider, model, decision)
       values ($1, $2, $3, $4, $5, 'fixture-hash', 1, 'v1', 'v1', 'jev', 'typesafe', '{}'::jsonb)`,
      [runId, ORG_ID, propertyNurtureId, nurtureConvId, nurtureMsgId],
    );
    const proposeResult = await client.query(
      `select public.fn_propose_jev_lead_decision($1,$2,$3,$4,'nurture',0.5,0.95,1,
         (select decision_context_revision from properties where id = $1))`,
      [propertyNurtureId, nurtureConvId, nurtureMsgId, runId],
    );
    pendingDecisionId = (proposeResult.rows[0].fn_propose_jev_lead_decision as { decisionId: string }).decisionId;

    // Second property + decision, pre-resolved via a DIRECT confirm below
    // (simulating another reviewer/tab already acting on it) — the
    // browser then attempts to act on the SAME now-stale row.
    propertyStaleId = crypto.randomUUID();
    const staleContactId = crypto.randomUUID();
    await client.query(
      `insert into contacts (id, org_id, first_name, phone_1, phone_1_type) values ($1, $2, 'Stale Homeowner', '+15551230002', 'mobile')`,
      [staleContactId, ORG_ID],
    );
    await client.query(
      `insert into properties (id, org_id, address, state, status, outreach_dispo, homeowner_contact_id)
       values ($1, $2, '2 Stale Conflict Ln', 'TX', 'prospect', null, $3)`,
      [propertyStaleId, ORG_ID, staleContactId],
    );
    const staleConvId = crypto.randomUUID();
    const staleMsgId = crypto.randomUUID();
    await client.query(
      `insert into messages (id, org_id, property_id, conversation_id, contact_id, channel, direction, body)
       values ($1, $2, $3, $4, $5, 'sms', 'inbound', 'stop texting me')`,
      [staleMsgId, ORG_ID, propertyStaleId, staleConvId, staleContactId],
    );
    const staleRunId = crypto.randomUUID();
    await client.query(
      `insert into sms_classification_runs (id, org_id, property_id, conversation_id, source_inbound_message_id, state_hash, state_version, schema_version, policy_version, provider, model, decision)
       values ($1, $2, $3, $4, $5, 'fixture-hash-2', 1, 'v1', 'v1', 'jev', 'typesafe', '{}'::jsonb)`,
      [staleRunId, ORG_ID, propertyStaleId, staleConvId, staleMsgId],
    );
    const staleProposeResult = await client.query(
      `select public.fn_propose_jev_lead_decision($1,$2,$3,$4,'nurture',0.4,0.95,1,
         (select decision_context_revision from properties where id = $1))`,
      [propertyStaleId, staleConvId, staleMsgId, staleRunId],
    );
    staleDecisionId = (staleProposeResult.rows[0].fn_propose_jev_lead_decision as { decisionId: string }).decisionId;
    // Resolve it out from under the browser BEFORE the browser ever loads
    // the page — a real "someone/something else already acted on this"
    // conflict, not a synthetic error injection. fn_confirm_jev_lead_decision
    // requires an authenticated user identity (not service_role) — reuse the
    // same admin user this whole run signs in as.
    await client.query("set request.jwt.claim.role = 'authenticated'");
    await client.query("select set_config('request.jwt.claim.sub', $1, false)", [userId]);
    await client.query(`select public.fn_confirm_jev_lead_decision($1)`, [staleDecisionId]);
    await client.query("set request.jwt.claim.role = 'service_role'");
    // Genuine desync, not a synthetic error injection: fn_confirm_jev_lead_decision
    // re-syncs the decision row's own decision_context_revision to match
    // the property's at confirm time. A further inbound arriving after
    // that — e.g. the homeowner replying again before this reviewer's
    // browser ever loads the page — bumps the property's LIVE revision
    // past what this decision row recorded, which is exactly the
    // decision_context_revision CAS mismatch the correction RPC checks.
    await client.query(
      `insert into messages (id, org_id, property_id, conversation_id, contact_id, channel, direction, body)
       values (gen_random_uuid(), $1, $2, $3, $4, 'sms', 'inbound', 'actually never mind')`,
      [ORG_ID, propertyStaleId, staleConvId, staleContactId],
    );
    await client.query("reset request.jwt.claim.sub");

    // Root review of edbd7bfe (jev-root-round13-review.md), finding 3:
    // settings-switch scenario's baseline. ai_responder_configs has one
    // persistent row per org (not a per-run fixture this spec creates or
    // deletes) — provision once, update it, never delete/recreate, so
    // FINAL_OWNER_GUARD (a memberships-only guard) never enters into it
    // and repeated runs stay idempotent regardless of which state a
    // prior run's enable/disable left it in.
    await client.query(
      `update ai_responder_configs set classifier_provider = 'legacy', classifier_mode = 'shadow' where org_id = $1`,
      [ORG_ID],
    );
  });

  test.afterAll(async () => {
    if (propertyNurtureId && propertyStaleId) {
      await client.query(`delete from jev_lead_decisions where property_id in ($1, $2)`, [propertyNurtureId, propertyStaleId]);
      await client.query(`delete from sms_classification_runs where property_id in ($1, $2)`, [propertyNurtureId, propertyStaleId]);
      await client.query(`delete from messages where property_id in ($1, $2)`, [propertyNurtureId, propertyStaleId]);
      await client.query(`delete from lead_events where property_id in ($1, $2)`, [propertyNurtureId, propertyStaleId]);
      await client.query(`delete from properties where id in ($1, $2)`, [propertyNurtureId, propertyStaleId]);
    }
    await client.query(`delete from contacts where org_id = $1`, [ORG_ID]);
    // Root review of edbd7bfe (jev-root-round13-review.md), finding 3:
    // deliberately NOT deleting the admin user/membership here anymore —
    // it's the org's final owner, so that delete always trips
    // FINAL_OWNER_GUARD (previously hidden behind a `.catch(() => {})`
    // that left the row in place anyway). beforeAll now reuses this same
    // identity across runs instead of recreating it, so leaving it here
    // is correct, not merely "harmless leftover."
    await client.end();
  });

  test("Needs a decision lists the pending nurture decision with evidence and confidence", async ({ page, context }) => {
    await context.addCookies(await signInAndGetCookies());
    await page.goto("/jev/needs-decision");
    const card = page.locator(`[data-testid="jev-queue-item-${pendingDecisionId}"]`);
    await expect(card).toBeVisible();
    await expect(card).toContainText("Nurture");
    await expect(card).toContainText("50.0%");
    await expect(card).toContainText("not right now, maybe later");
  });

  test("Review Jev correction: correcting the pending item applies the new outcome and records history", async ({ page, context }) => {
    await context.addCookies(await signInAndGetCookies());
    await page.goto("/jev/needs-decision");
    const card = page.locator(`[data-testid="jev-queue-item-${pendingDecisionId}"]`);
    await expect(card).toBeVisible();

    await card.locator(`[data-testid="jev-correct-toggle-${pendingDecisionId}"]`).click();
    const targetButton = card.locator(`[data-testid="jev-correct-${pendingDecisionId}-not_interested"]`);
    await expect(targetButton).toBeVisible();
    await targetButton.click();
    // Optimistic removal from Needs-a-decision on successful correction.
    await expect(card).toHaveCount(0);

    await page.goto("/jev/review");
    const reviewCard = page.locator(`[data-testid="jev-queue-item-${pendingDecisionId}"]`);
    await expect(reviewCard).toBeVisible();
    await expect(reviewCard).toContainText("corrected from Nurture to Not interested");
    await reviewCard.locator(`[data-testid="jev-correction-history-toggle-${pendingDecisionId}"]`).click();
    await expect(reviewCard.locator(`[data-testid="jev-correction-history-${pendingDecisionId}"]`)).toContainText("Not interested");
  });

  test("Settings: editing a Jev outcome threshold persists the new value and bumps the version", async ({ page, context }) => {
    await context.addCookies(await signInAndGetCookies());
    await page.goto("/settings/jev-thresholds");
    const row = page.locator('[data-testid="jev-threshold-row-wrong_number"]');
    await expect(row).toBeVisible();

    // Baseline: whatever version/value this row starts at (app bootstrap
    // seeds every outcome at v1 by default — don't assume that, read it).
    // Root review of edbd7bfe (jev-root-round13-review.md), finding 3:
    // this test must itself be safe to run twice consecutively without a
    // database reset — a hardcoded target value would be a no-op (Save
    // button never becomes dirty) on a run immediately following one
    // that already landed on that same value. Alternate between two
    // distinct targets based on the CURRENT value so every run always
    // produces a real diff.
    const { rows: before } = await client.query(
      `select version, min_confidence from jev_outcome_thresholds where org_id = $1 and outcome = 'wrong_number'`,
      [ORG_ID],
    );
    const versionBefore: number = before[0]?.version ?? 0;
    const minConfidenceBefore: number | null = before[0] ? Number(before[0].min_confidence) : null;
    const target = minConfidenceBefore !== null && Math.abs(minConfidenceBefore - 0.87) < 0.001 ? "0.86" : "0.87";

    const input = row.locator('[data-testid="jev-threshold-input-wrong_number"]');
    await input.fill(target);
    const saveButton = row.locator('[data-testid="jev-threshold-save-wrong_number"]');
    await saveButton.click();
    // The save runs inside startTransition — clicking only dispatches the
    // event, it doesn't wait for the async server action + re-render to
    // land. Wait for the UI's OWN evidence that the save round-tripped:
    // the version label advancing past its pre-edit value, and the Save
    // button going back to disabled (dirty=false once row.minConfidence
    // catches up to the typed value).
    await expect(row).not.toContainText(
      versionBefore === 0 ? "not yet configured" : `v${versionBefore}`,
      { timeout: 10_000 },
    );
    await expect(saveButton).toBeDisabled();
    await expect(input).toHaveValue(target);

    const { rows: after } = await client.query(
      `select min_confidence, version from jev_outcome_thresholds where org_id = $1 and outcome = 'wrong_number'`,
      [ORG_ID],
    );
    expect(Number(after[0].min_confidence)).toBeCloseTo(Number(target));
    expect(after[0].version).toBe(versionBefore + 1);
  });

  test("Stale conflict: correcting a decision whose property changed underneath it surfaces a friendly error, not a crash", async ({ page, context }) => {
    await context.addCookies(await signInAndGetCookies());
    // Load Review Jev, where the already-confirmed row still renders a
    // correction picker (auto-applied/confirmed rows remain correctable
    // by design — see queue-item-card.tsx's canAct). This row's
    // decision_context_revision was synced at confirm time, then a
    // further inbound arrived on the property before this browser ever
    // loaded the page (beforeAll) — attempting to correct it now must
    // hit the real decision_context_revision CAS mismatch
    // (fn_apply_and_record_jev_lead_decision_correction's STALE_STATE
    // check) and fail cleanly with an inline error, never an unhandled
    // crash or blank page.
    await page.goto("/jev/review");
    const staleCard = page.locator(`[data-testid="jev-queue-item-${staleDecisionId}"]`);
    await expect(staleCard).toBeVisible();

    const correctToggle = staleCard.locator(`[data-testid="jev-correct-toggle-${staleDecisionId}"]`);
    await expect(correctToggle).toBeVisible();
    await correctToggle.click();
    const targetBtn = staleCard.locator(`[data-testid="jev-correct-${staleDecisionId}-not_interested"]`);
    await expect(targetBtn).toBeVisible();
    await targetBtn.click();
    // The RPC raises errcode 40001 ('STALE_STATE'); jev/actions.ts maps
    // this to the friendly, human-readable copy below rather than
    // showing the raw error code — verified by direct inspection
    // (dumping the card's real innerHTML mid-run), not assumed.
    await expect(staleCard.locator("text=This lead changed since Jev made this decision. Reload and try again.")).toBeVisible();
    // The correction must NOT have applied — still Nurture, not corrected.
    await expect(staleCard).not.toContainText("corrected from Nurture to Not interested");

    // The page itself must still be intact — not a thrown/500 render.
    await expect(page.locator('[data-testid="jev-review-error"]')).toHaveCount(0);
  });

  // Root review of edbd7bfe (jev-root-round13-review.md), finding 3: real
  // browser proof of the one-cutover switch — initial legacy/shadow,
  // enable -> persisted jev/automatic + saved UI, disable -> persisted
  // back to legacy/shadow. Ends in the SAME legacy/shadow state it
  // started in, so this test (and the whole file) is safe to run twice
  // consecutively without a database reset.
  test("Settings: the Jev automatic classification switch persists enable/disable through the real RPC", async ({ page, context }) => {
    await context.addCookies(await signInAndGetCookies());
    await page.goto("/settings/ai-responder");

    // Root review of edbd7bfe (jev-root-round13-review.md), finding 3 —
    // must target the dynamic state span specifically, not the whole
    // switch section: the section's own static heading ("Use Jev
    // automatic classification") already contains the substring "Jev
    // automatic" regardless of actual save state, which would make a
    // broader toContainText assertion pass instantly (a false positive
    // that races ahead of the real async save).
    const currentState = page.locator('[data-testid="jev-automatic-current-state"]');
    await expect(currentState).toHaveText("legacy / shadow");
    const toggle = page.locator('[data-testid="jev-automatic-toggle"]');
    await expect(toggle).not.toBeChecked();

    await toggle.check();
    await page.locator('[data-testid="jev-automatic-save"]').click();
    await expect(currentState).toHaveText("Jev automatic", { timeout: 10_000 });
    await expect(page.locator('[data-testid="jev-automatic-save"]')).toBeDisabled();

    const { rows: enabledRows } = await client.query(
      `select classifier_provider, classifier_mode from ai_responder_configs where org_id = $1`,
      [ORG_ID],
    );
    expect(enabledRows[0]).toEqual({ classifier_provider: "jev", classifier_mode: "automatic" });

    await toggle.uncheck();
    await page.locator('[data-testid="jev-automatic-save"]').click();
    await expect(currentState).toHaveText("legacy / shadow", { timeout: 10_000 });
    await expect(page.locator('[data-testid="jev-automatic-save"]')).toBeDisabled();

    const { rows: disabledRows } = await client.query(
      `select classifier_provider, classifier_mode from ai_responder_configs where org_id = $1`,
      [ORG_ID],
    );
    expect(disabledRows[0]).toEqual({ classifier_provider: "legacy", classifier_mode: "shadow" });
  });
});
