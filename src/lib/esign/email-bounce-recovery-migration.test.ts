import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const recoverySql = readFileSync(
  "supabase/migrations/20260902111000_esign_email_bounce_recovery.sql",
  "utf8",
);
const foundationSql = readFileSync(
  "supabase/migrations/20260829194500_esign_foundation.sql",
  "utf8",
);
const uploadSql = readFileSync(
  "supabase/migrations/20260830080000_esign_template_upload_reservations.sql",
  "utf8",
);

describe("email-bounce recovery migration contract", () => {
  it("keeps retry creation scoped to truly failed source requests", () => {
    expect(`${foundationSql}\n${uploadSql}`).toContain(
      "v_previous.delivery_state <> 'failed'",
    );
    expect(`${foundationSql}\n${uploadSql}`).not.toMatch(
      /v_previous\.delivery_state\s*<>\s*'email_bounced'/,
    );
    expect(recoverySql).not.toContain("p_retry_of_request_id");
    expect(recoverySql).toContain("delivery_state = 'email_bounced'");
    expect(recoverySql).toContain("delivery_state = 'sent'");
  });

  it("locks bounced email correction in contact-first order", () => {
    const claimStart = recoverySql.indexOf(
      "create or replace function public.claim_esign_bounced_signer_email_update",
    );
    const contactLock = recoverySql.indexOf(
      "from public.contacts contact",
      claimStart,
    );
    const propertyLock = recoverySql.indexOf(
      "from public.properties property",
      contactLock,
    );
    const requestLock = recoverySql.indexOf(
      "from public.esign_requests request",
      propertyLock,
    );
    const signerLock = recoverySql.indexOf(
      "from public.esign_request_signers signer",
      requestLock,
    );

    expect(contactLock).toBeGreaterThan(claimStart);
    expect(propertyLock).toBeGreaterThan(contactLock);
    expect(requestLock).toBeGreaterThan(propertyLock);
    expect(signerLock).toBeGreaterThan(requestLock);
    expect(recoverySql).toMatch(/update public\.contacts/i);
    expect(recoverySql).toContain("esign_contact_email_persist_skipped");
  });

  it("finalizes provider-confirmed corrected email with contact-first persistence", () => {
    const finalizerStart = recoverySql.indexOf(
      "create or replace function public.finalize_esign_bounced_signer_email_update",
    );
    const contactLock = recoverySql.indexOf(
      "from public.contacts contact",
      finalizerStart,
    );
    const propertyLock = recoverySql.indexOf(
      "from public.properties property",
      contactLock,
    );
    const requestLock = recoverySql.indexOf(
      "for update",
      recoverySql.indexOf("from public.esign_requests request", propertyLock),
    );
    const signerLock = recoverySql.indexOf(
      "from public.esign_request_signers signer",
      requestLock,
    );
    const contactUpdate = recoverySql.indexOf(
      "update public.contacts",
      signerLock,
    );

    expect(finalizerStart).toBeGreaterThan(-1);
    expect(contactLock).toBeGreaterThan(finalizerStart);
    expect(propertyLock).toBeGreaterThan(contactLock);
    expect(requestLock).toBeGreaterThan(propertyLock);
    expect(signerLock).toBeGreaterThan(requestLock);
    expect(contactUpdate).toBeGreaterThan(signerLock);
    expect(recoverySql).toContain("when unique_violation then");
    expect(recoverySql).toContain("'reason', 'seller_email_conflict'");
    expect(recoverySql).toContain("'esign_contact_email_persist_skipped'");
  });

  it("does not let provider signer reconciliation own the bounced-email finalizer fence", () => {
    const providerTruthfulSql = readFileSync(
      "supabase/migrations/20260902112000_esign_provider_truthful_lifecycle.sql",
      "utf8",
    );
    const reconcileStart = providerTruthfulSql.indexOf(
      "create or replace function public.reconcile_esign_webhook_provider_signers",
    );
    const artifactStart = providerTruthfulSql.indexOf(
      "create or replace function public.reconcile_esign_completed_signed_artifact",
      reconcileStart,
    );
    const reconcileBody = providerTruthfulSql.slice(reconcileStart, artifactStart);

    expect(reconcileStart).toBeGreaterThan(-1);
    expect(reconcileBody).not.toMatch(/email_update_claim_token\s*=\s*null/i);
    expect(reconcileBody).not.toMatch(/email_update_claimed_at\s*=\s*null/i);
    expect(reconcileBody).not.toMatch(/email_update_claim_email\s*=\s*null/i);
    expect(reconcileBody).not.toMatch(/email_update_claim_actor_id\s*=\s*null/i);
    expect(reconcileBody).not.toMatch(/email_update_claim_token is not null/i);
  });
});
