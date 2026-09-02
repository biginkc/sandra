import { describe, expect, it, vi } from "vitest";

import {
  createEsignWebhookDatabaseAdapter,
  EsignDatabaseAdapterError,
  type EsignWebhookRpcClient,
} from "./database-adapter";
import type { VerifiedReceiptInput } from "./ports";
import type { EsignStatusDecision } from "./status";

const ORG_ID = "11111111-1111-4111-8111-111111111111";
const CONSUMER_ID = "22222222-2222-4222-8222-222222222222";
const REQUEST_ID = "33333333-3333-4333-8333-333333333333";
const PROPERTY_ID = "44444444-4444-4444-8444-444444444444";
const RECEIPT_ID = "55555555-5555-4555-8555-555555555555";
const LEASE_ID = "66666666-6666-4666-8666-666666666666";

function receiptInput(): VerifiedReceiptInput {
  return {
    orgId: ORG_ID,
    callbackConsumerId: CONSUMER_ID,
    fingerprint: "a".repeat(64),
    replay: {
      payloadHash: "b".repeat(64),
      eventTime: "1788054000",
      eventType: "signature_request_viewed",
      eventHash: "c".repeat(64),
      signRequestId: "provider-request-1",
      localRequestId: REQUEST_ID,
      relatedSignatureId: "provider-signature-1",
      reportedForAppId: "provider-app-1",
      providerSignatures: [],
    },
    receivedAt: new Date("2026-08-29T20:00:00.000Z"),
  };
}

function clientWith(
  implementation: (name: string, args: Record<string, unknown>) => unknown,
): { client: EsignWebhookRpcClient; rpc: ReturnType<typeof vi.fn> } {
  const rpc = vi.fn(async (name: string, args: Record<string, unknown>) => ({
    data: implementation(name, args),
    error: null,
  }));
  return { client: { rpc: rpc as EsignWebhookRpcClient["rpc"] }, rpc };
}

function claimRow(
  outcome: "claimed" | "already_processed" | "in_progress" = "claimed",
  leaseId: string | null = LEASE_ID,
) {
  return [{ outcome, receipt_id: RECEIPT_ID, lease_id: leaseId }];
}

const CLAIM = {
  outcome: "claimed" as const,
  receiptId: RECEIPT_ID,
  leaseId: LEASE_ID,
};

const VIEWED_DECISION: EsignStatusDecision = {
  previousStatus: "awaiting",
  nextStatus: "viewed",
  changed: true,
  artifactReady: false,
  reason: "viewed",
};

describe("typed eSign webhook database adapter", () => {
  it.each([59, 3_601, 60.5])(
    "rejects an out-of-contract stale lease window of %s seconds",
    (staleAfterSeconds) => {
      const { client } = clientWith(() => claimRow());
      expect(() =>
        createEsignWebhookDatabaseAdapter(client, { staleAfterSeconds }),
      ).toThrow("The eSign webhook database operation failed.");
    },
  );

  it("sends the exact PII-minimal insert-and-claim shape", async () => {
    const privateEmail = "private-seller@example.com";
    const { client, rpc } = clientWith(() => claimRow());
    const adapter = createEsignWebhookDatabaseAdapter(client, {
      createLeaseId: () => LEASE_ID,
      staleAfterSeconds: 240,
    });

    await adapter.claimVerifiedReceipt(receiptInput());

    expect(rpc).toHaveBeenCalledWith("claim_esign_webhook_receipt", {
      p_org_id: ORG_ID,
      p_callback_consumer_id: CONSUMER_ID,
      p_event_hash: "c".repeat(64),
      p_event_fingerprint: "a".repeat(64),
      p_payload_hash: "b".repeat(64),
      p_event_type: "signature_request_viewed",
      p_sign_request_id: "provider-request-1",
      p_related_signature_id: "provider-signature-1",
      p_provider_event_at: "2026-08-30T01:40:00.000Z",
      p_safe_event_data: {
        event_time: "1788054000",
        event_type: "signature_request_viewed",
        sign_request_id: "provider-request-1",
        related_signature_id: "provider-signature-1",
        reported_for_app_id: "provider-app-1",
      },
      p_received_at: "2026-08-29T20:00:00.000Z",
      p_lease_id: LEASE_ID,
      p_stale_after_seconds: 240,
    });
    const serializedArgs = JSON.stringify(rpc.mock.calls[0][1]);
    expect(serializedArgs).not.toContain(privateEmail);
    expect(serializedArgs).not.toMatch(/actor|signer_email|signer_name|raw_json/i);
  });

  it("maps duplicate and active receipt outcomes without granting a lease", async () => {
    for (const outcome of ["already_processed", "in_progress"] as const) {
      const { client } = clientWith(() => claimRow(outcome, null));
      const adapter = createEsignWebhookDatabaseAdapter(client, {
        createLeaseId: () => LEASE_ID,
      });
      await expect(adapter.claimVerifiedReceipt(receiptInput())).resolves.toEqual({
        outcome,
        receiptId: RECEIPT_ID,
      });
    }
  });

  it("supports failed receipt retry convergence with a fresh fenced lease", async () => {
    const secondLease = "77777777-7777-4777-8777-777777777777";
    const leases = [LEASE_ID, secondLease];
    const { client, rpc } = clientWith((name, args) => {
      if (name === "claim_esign_webhook_receipt") {
        return claimRow("claimed", String(args.p_lease_id));
      }
      return null;
    });
    const adapter = createEsignWebhookDatabaseAdapter(client, {
      createLeaseId: () => leases.shift()!,
    });

    const first = await adapter.claimVerifiedReceipt(receiptInput());
    if (first.outcome !== "claimed") throw new Error("expected claim");
    await adapter.markReceiptFailed(first, "PDF_DOWNLOAD_RETRYABLE");
    const reclaimed = await adapter.claimVerifiedReceipt(receiptInput());

    expect(reclaimed).toEqual({
      outcome: "claimed",
      receiptId: RECEIPT_ID,
      leaseId: secondLease,
    });
    expect(rpc).toHaveBeenCalledWith("complete_esign_webhook_receipt", {
      p_receipt_id: RECEIPT_ID,
      p_lease_id: LEASE_ID,
      p_status: "error",
      p_safe_code: "PDF_DOWNLOAD_RETRYABLE",
    });
  });

  it.each(["applied", "no_change", "terminal_ignored"] as const)(
    "maps the atomic status outcome %s and writes only the safe event DTO",
    async (outcome) => {
      const { client, rpc } = clientWith(() => [
        { outcome, status: outcome === "terminal_ignored" ? "declined" : "viewed" },
      ]);
      const adapter = createEsignWebhookDatabaseAdapter(client);
      const result = await adapter.applyStatusDecision({
        orgId: ORG_ID,
        requestId: REQUEST_ID,
        propertyId: PROPERTY_ID,
        claim: CLAIM,
        decision: VIEWED_DECISION,
        requestedStatus: "viewed",
        providerEventAt: new Date("2026-08-29T23:00:00.000Z"),
        templateTitle: "Purchase Agreement",
      });

      expect(result.outcome).toBe(outcome);
      expect(rpc).toHaveBeenCalledWith(
        "apply_esign_webhook_status_decision",
        {
          p_org_id: ORG_ID,
          p_request_id: REQUEST_ID,
          p_receipt_id: RECEIPT_ID,
          p_lease_id: LEASE_ID,
          p_expected_status: "awaiting",
          p_requested_status: "viewed",
          p_provider_event_at: "2026-08-29T23:00:00.000Z",
          p_lead_event_type: "esign_viewed",
          p_lead_event_payload: { template_title: "Purchase Agreement" },
        },
      );
      expect(JSON.stringify(rpc.mock.calls[0][1])).not.toMatch(/actor|email|path/i);
    },
  );

  it("uses the dedicated email-bounce delivery RPC without lead-event PII", async () => {
    const { client, rpc } = clientWith(() => [
      { outcome: "applied", status: "error" },
    ]);
    const adapter = createEsignWebhookDatabaseAdapter(client);

    await expect(
      adapter.applyEmailBounceDecision({
        orgId: ORG_ID,
        requestId: REQUEST_ID,
        claim: CLAIM,
        decision: {
          previousStatus: "awaiting",
          nextStatus: "error",
          changed: true,
          artifactReady: false,
          reason: "email_bounced",
        },
        providerEventAt: new Date("2026-08-29T23:00:00.000Z"),
      }),
    ).resolves.toEqual({ outcome: "applied", status: "error" });
    expect(rpc).toHaveBeenCalledWith(
      "apply_esign_email_bounce_delivery_decision",
      {
        p_org_id: ORG_ID,
        p_request_id: REQUEST_ID,
        p_receipt_id: RECEIPT_ID,
        p_lease_id: LEASE_ID,
        p_expected_status: "awaiting",
        p_provider_event_at: "2026-08-29T23:00:00.000Z",
      },
    );
    expect(JSON.stringify(rpc.mock.calls[0][1])).not.toMatch(/email|actor/i);
  });

  it.each(["42883", "PGRST202"] as const)(
    "returns null when the email-bounce RPC is missing with %s",
    async (code) => {
      const rpc = vi.fn(async () => ({ data: null, error: { code } }));
      const adapter = createEsignWebhookDatabaseAdapter({
        rpc: rpc as EsignWebhookRpcClient["rpc"],
      });

      await expect(
        adapter.applyEmailBounceDecision({
          orgId: ORG_ID,
          requestId: REQUEST_ID,
          claim: CLAIM,
          decision: VIEWED_DECISION,
          providerEventAt: new Date("2026-08-29T23:00:00.000Z"),
        }),
      ).resolves.toBeNull();
    },
  );

  it("finds an already attached request by provider request id without repair", async () => {
    const { client, rpc } = clientWith((name) => {
      if (name === "find_esign_webhook_request") {
        return [{
          id: REQUEST_ID,
          org_id: ORG_ID,
          property_id: PROPERTY_ID,
          status: "awaiting",
          signed_pdf_path: null,
          template_title: "Purchase Agreement",
        }];
      }
      return null;
    });
    const adapter = createEsignWebhookDatabaseAdapter(client);

    await expect(adapter.findRequest({
      orgId: ORG_ID,
      signRequestId: "provider-request-1",
      localRequestId: REQUEST_ID,
    })).resolves.toEqual({
      id: REQUEST_ID,
      orgId: ORG_ID,
      propertyId: PROPERTY_ID,
      status: "awaiting",
      signedPdfPath: null,
      templateTitle: "Purchase Agreement",
    });

    expect(rpc).not.toHaveBeenCalledWith(
      "attach_esign_request_provider_delivery",
      expect.anything(),
    );
  });

  it("repairs a timeout-stranded request by Sandra request id metadata", async () => {
    const findRows = [
      [],
      [{
        id: REQUEST_ID,
        org_id: ORG_ID,
        property_id: PROPERTY_ID,
        status: "awaiting",
        signed_pdf_path: null,
        template_title: "Purchase Agreement",
      }],
    ];
    const { client, rpc } = clientWith((name) => {
      if (name === "find_esign_webhook_request") return findRows.shift();
      if (name === "attach_esign_request_provider_delivery") return null;
      return null;
    });
    const adapter = createEsignWebhookDatabaseAdapter(client);

    await expect(adapter.findRequest({
      orgId: ORG_ID,
      signRequestId: "provider-after-timeout",
      localRequestId: REQUEST_ID,
    })).resolves.toMatchObject({ id: REQUEST_ID, status: "awaiting" });

    expect(rpc).toHaveBeenCalledWith("attach_esign_request_provider_delivery", {
      p_org_id: ORG_ID,
      p_request_id: REQUEST_ID,
      p_provider_request_id: "provider-after-timeout",
      p_resolution_source: "webhook",
      p_evidence: {
        localRequestId: REQUEST_ID,
        providerRequestId: "provider-after-timeout",
        source: "dropbox_metadata_sandra_request_id",
      },
    });
  });

  it("keeps existing webhook processing deploy-safe before the metadata repair migration", async () => {
    const rpc = vi.fn(async (name: string) => {
      if (name === "find_esign_webhook_request") return { data: [], error: null };
      if (name === "attach_esign_request_provider_delivery") {
        return { data: null, error: { code: "42883" } };
      }
      return { data: null, error: null };
    });
    const adapter = createEsignWebhookDatabaseAdapter({
      rpc: rpc as EsignWebhookRpcClient["rpc"],
    });

    await expect(adapter.findRequest({
      orgId: ORG_ID,
      signRequestId: "provider-after-timeout",
      localRequestId: REQUEST_ID,
    })).resolves.toBeNull();
  });

  it("links a signed artifact idempotently with system/null provenance implicit", async () => {
    const { client, rpc } = clientWith(() => [
      { outcome: "already_linked", lead_file_id: RECEIPT_ID },
    ]);
    const adapter = createEsignWebhookDatabaseAdapter(client);

    await expect(
      adapter.linkSignedArtifact({
        orgId: ORG_ID,
        requestId: REQUEST_ID,
        claim: CLAIM,
        templateTitle: "Purchase Agreement",
        artifact: {
          storageBucket: "lead-files",
          storagePath: `${ORG_ID}/${REQUEST_ID}/${RECEIPT_ID}.pdf`,
          fileName: "signed-contract.pdf",
          contentType: "application/pdf",
          sizeBytes: 8,
        },
      }),
    ).resolves.toEqual({ outcome: "already_linked", leadFileId: RECEIPT_ID });

    expect(rpc).toHaveBeenCalledWith("link_esign_signed_artifact", {
      p_org_id: ORG_ID,
      p_request_id: REQUEST_ID,
      p_receipt_id: RECEIPT_ID,
      p_lease_id: LEASE_ID,
      p_lead_file_id: RECEIPT_ID,
      p_storage_bucket: "lead-files",
      p_storage_path: `${ORG_ID}/${REQUEST_ID}/${RECEIPT_ID}.pdf`,
      p_content_type: "application/pdf",
      p_size_bytes: 8,
      p_lead_event_type: "esign_signed_pdf_ready",
      p_lead_event_payload: { template_title: "Purchase Agreement" },
    });
    expect(Object.keys(rpc.mock.calls[0][1])).not.toContain("p_actor_id");
    expect(Object.keys(rpc.mock.calls[0][1])).not.toContain("p_actor_type");
  });

  it.each([
    "applied",
    "already_reconciled",
    "stale_ignored",
    "superseded",
  ] as const)("maps the token/time-fenced reminder callback outcome %s", async (outcome) => {
    const { client, rpc } = clientWith(() => [{ outcome }]);
    const adapter = createEsignWebhookDatabaseAdapter(client);

    await expect(adapter.reconcileReminderCallback({
      orgId: ORG_ID,
      requestId: REQUEST_ID,
      claim: CLAIM,
      providerSignatureId: "provider-signature-1",
      providerEventAt: new Date("2026-08-29T23:00:00.000Z"),
    })).resolves.toBe(outcome);
    expect(rpc).toHaveBeenCalledWith("reconcile_esign_reminder_callback", {
      p_org_id: ORG_ID,
      p_request_id: REQUEST_ID,
      p_receipt_id: RECEIPT_ID,
      p_lease_id: LEASE_ID,
      p_provider_signature_id: "provider-signature-1",
      p_provider_event_at: "2026-08-29T23:00:00.000Z",
    });
  });

  it.each([
    "applied",
    "already_reconciled",
    "stale_ignored",
    "superseded",
  ] as const)("maps provider signer identity reconciliation outcome %s", async (outcome) => {
    const { client, rpc } = clientWith(() => [{ outcome }]);
    const adapter = createEsignWebhookDatabaseAdapter(client);

    await expect(adapter.reconcileProviderSigners({
      orgId: ORG_ID,
      requestId: REQUEST_ID,
      claim: CLAIM,
      providerEventAt: new Date("2026-09-02T06:46:57.000Z"),
      providerSignatures: [{
        signatureId: "bb67df41911f964aa66f488bd2878cbd",
        role: "Seller",
        name: "eSign QA A PRIMARY_E2E",
        emailAddress: "jarrad.henry@gmail.com",
        order: 0,
        statusCode: "signed",
        signedAt: 1788331417,
      }],
      signedProviderSignatureId: "bb67df41911f964aa66f488bd2878cbd",
    })).resolves.toBe(outcome);
    expect(rpc).toHaveBeenCalledWith(
      "reconcile_esign_webhook_provider_signers",
      {
        p_org_id: ORG_ID,
        p_request_id: REQUEST_ID,
        p_receipt_id: RECEIPT_ID,
        p_lease_id: LEASE_ID,
        p_provider_event_at: "2026-09-02T06:46:57.000Z",
        p_provider_signatures: [{
          signatureId: "bb67df41911f964aa66f488bd2878cbd",
          role: "Seller",
          name: "eSign QA A PRIMARY_E2E",
          emailAddress: "jarrad.henry@gmail.com",
          order: 0,
          statusCode: "signed",
          signedAt: 1788331417,
        }],
        p_signed_provider_signature_id: "bb67df41911f964aa66f488bd2878cbd",
      },
    );
  });

  it("keeps webhook processing retryable before the provider-signer reconciliation migration", async () => {
    const rpc = vi.fn(async (name: string) => {
      if (name === "reconcile_esign_webhook_provider_signers") {
        return { data: null, error: { code: "PGRST202" } };
      }
      return { data: null, error: null };
    });
    const adapter = createEsignWebhookDatabaseAdapter({
      rpc: rpc as EsignWebhookRpcClient["rpc"],
    });

    await expect(adapter.reconcileProviderSigners({
      orgId: ORG_ID,
      requestId: REQUEST_ID,
      claim: CLAIM,
      providerEventAt: new Date("2026-09-02T06:46:57.000Z"),
      providerSignatures: [],
      signedProviderSignatureId: "signature-1",
    })).resolves.toBe("unavailable");
  });

  it("allows status convergence with a blank historical title via the presentation fallback payload", async () => {
    const { client, rpc } = clientWith(() => [{ outcome: "applied", status: "viewed" }]);
    const adapter = createEsignWebhookDatabaseAdapter(client);

    await expect(adapter.applyStatusDecision({
      orgId: ORG_ID,
      requestId: REQUEST_ID,
      propertyId: PROPERTY_ID,
      claim: CLAIM,
      decision: VIEWED_DECISION,
      requestedStatus: "viewed",
      providerEventAt: new Date("2026-08-29T23:00:00.000Z"),
      templateTitle: "   ",
    })).resolves.toEqual({ outcome: "applied", status: "viewed" });

    expect(rpc).toHaveBeenCalledWith(
      "apply_esign_webhook_status_decision",
      expect.objectContaining({
        p_lead_event_type: "esign_viewed",
        p_lead_event_payload: { template_title: "   " },
      }),
    );
    expect(Object.keys(rpc.mock.calls[0][1])).not.toContain("p_actor_id");
    expect(Object.keys(rpc.mock.calls[0][1])).not.toContain("p_actor_type");
  });

  it("preserves an exact wrapped historical title for status RPC equality and fallback", async () => {
    const { client, rpc } = clientWith(() => [{ outcome: "applied", status: "viewed" }]);
    const adapter = createEsignWebhookDatabaseAdapter(client);
    const historicalTitle = ` ${"a".repeat(159)} `;

    await expect(adapter.applyStatusDecision({
      orgId: ORG_ID,
      requestId: REQUEST_ID,
      propertyId: PROPERTY_ID,
      claim: CLAIM,
      decision: VIEWED_DECISION,
      requestedStatus: "viewed",
      providerEventAt: new Date("2026-08-29T23:00:00.000Z"),
      templateTitle: historicalTitle,
    })).resolves.toEqual({ outcome: "applied", status: "viewed" });

    expect(historicalTitle.length).toBe(161);
    expect(historicalTitle.trim().length).toBe(159);
    expect(rpc).toHaveBeenCalledWith(
      "apply_esign_webhook_status_decision",
      expect.objectContaining({
        p_lead_event_type: "esign_viewed",
        p_lead_event_payload: { template_title: historicalTitle },
      }),
    );
  });

  it("allows downloadable convergence with an overlong historical title via the presentation fallback payload", async () => {
    const { client, rpc } = clientWith(() => [
      { outcome: "applied", lead_file_id: RECEIPT_ID },
    ]);
    const adapter = createEsignWebhookDatabaseAdapter(client);
    const historicalTitle = ` ${"a".repeat(159)} `;

    await expect(adapter.linkSignedArtifact({
      orgId: ORG_ID,
      requestId: REQUEST_ID,
      claim: CLAIM,
      templateTitle: historicalTitle,
      artifact: {
        storageBucket: "lead-files",
        storagePath: `${ORG_ID}/${REQUEST_ID}/${RECEIPT_ID}.pdf`,
        fileName: "signed-contract.pdf",
        contentType: "application/pdf",
        sizeBytes: 8,
      },
    })).resolves.toEqual({ outcome: "applied", leadFileId: RECEIPT_ID });

    expect(historicalTitle.length).toBe(161);
    expect(historicalTitle.trim().length).toBe(159);
    expect(rpc).toHaveBeenCalledWith(
      "link_esign_signed_artifact",
      expect.objectContaining({
        p_lead_event_type: "esign_signed_pdf_ready",
        p_lead_event_payload: { template_title: historicalTitle },
      }),
    );
    expect(Object.keys(rpc.mock.calls[0][1])).not.toContain("p_actor_id");
    expect(Object.keys(rpc.mock.calls[0][1])).not.toContain("p_actor_type");
  });

  it("preserves the incoming target so the database can classify terminal replay", async () => {
    const { client, rpc } = clientWith(() => [
      { outcome: "terminal_ignored", status: "declined" },
    ]);
    const adapter = createEsignWebhookDatabaseAdapter(client);
    await adapter.applyStatusDecision({
      orgId: ORG_ID,
      requestId: REQUEST_ID,
      propertyId: PROPERTY_ID,
      claim: CLAIM,
      decision: {
        previousStatus: "declined",
        nextStatus: "declined",
        changed: false,
        artifactReady: true,
        reason: "terminal_sticky",
      },
      requestedStatus: "signed",
      providerEventAt: new Date("2026-08-29T23:00:00.000Z"),
      templateTitle: "Purchase Agreement",
    });

    expect(rpc.mock.calls[0][1]).toMatchObject({
      p_expected_status: "declined",
      p_requested_status: "signed",
      p_lead_event_type: "esign_signed",
    });
  });

  it("rejects unsafe receipt codes before an RPC can leak them", async () => {
    const { client, rpc } = clientWith(() => null);
    const adapter = createEsignWebhookDatabaseAdapter(client);

    await expect(
      adapter.markReceiptFailed(CLAIM, "private-seller@example.com"),
    ).rejects.toMatchObject({
      code: "INVALID_SAFE_CODE",
    });
    expect(rpc).not.toHaveBeenCalled();
  });

  it("rejects a forged or stale lease returned by the claim RPC", async () => {
    const { client } = clientWith(() => claimRow("claimed", "other-lease"));
    const adapter = createEsignWebhookDatabaseAdapter(client, {
      createLeaseId: () => LEASE_ID,
    });

    await expect(adapter.claimVerifiedReceipt(receiptInput())).rejects.toMatchObject({
      code: "INVALID_RPC_RESPONSE",
    });
  });

  it("does not expose database error details or PII", async () => {
    const privateEmail = "private-seller@example.com";
    const rpc = vi.fn(async () => ({
      data: null,
      error: { code: privateEmail },
    }));
    const adapter = createEsignWebhookDatabaseAdapter({
      rpc: rpc as EsignWebhookRpcClient["rpc"],
    });

    let caught: unknown;
    try {
      await adapter.claimVerifiedReceipt(receiptInput());
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(EsignDatabaseAdapterError);
    expect((caught as Error).message).not.toContain(privateEmail);
    expect(caught).toMatchObject({ code: "RPC_FAILED" });
  });
});
