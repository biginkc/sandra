export const ESIGN_TEST_API_KEY = "test-dropbox-sign-api-key-1234";
export const ESIGN_TEST_ENCRYPTION_KEY = "test-esign-encryption-key";
export const ESIGN_TEST_CLIENT_ID = "test-dropbox-sign-client-id";
export const ESIGN_TEST_CALLBACK_HASH = "a".repeat(64);
export const ESIGN_TEST_PAYLOAD_HASH = "b".repeat(64);

export function esignTemplateFixture(input: {
  orgId: string;
  userId: string;
  id?: string;
}) {
  const id = input.id ?? crypto.randomUUID();
  return {
    id,
    org_id: input.orgId,
    name: "Purchase agreement",
    document_type: "purchase_agreement",
    seller_role: "Seller",
    signer_roles: [{ name: "Seller", order: 0 }],
    merge_field_names: [
      "seller_name",
      "property_address",
      "offer_price",
      "closing_date",
      "earnest_money",
    ],
    sign_template_id: `provider-template-${id}`,
    staging_source_id: id,
    source_filename: "purchase-agreement.pdf",
    source_size_bytes: 1024,
    source_content_type: "application/pdf",
    source_sha256: "c".repeat(64),
    staging_path: `${input.orgId}/${id}.pdf`,
    finalized_at: new Date().toISOString(),
    lifecycle_state: "finalized",
    created_by: input.userId,
    updated_by: input.userId,
  };
}

export function esignRequestFixture(input: {
  orgId: string;
  propertyId: string;
  templateId: string;
  userId: string;
  id?: string;
  sendIntentId?: string;
}) {
  return {
    id: input.id ?? crypto.randomUUID(),
    org_id: input.orgId,
    property_id: input.propertyId,
    template_id: input.templateId,
    signer_snapshot: [
      { role: "Seller", name: "Test Seller", emailAddress: "seller@example.com" },
    ],
    merge_value_snapshot: {
      seller_name: "Test Seller",
      property_address: "123 Test Street",
      offer_price: "100000",
      closing_date: "2026-09-30",
      earnest_money: "1000",
    },
    send_intent_id: input.sendIntentId ?? crypto.randomUUID(),
    payload_hash: ESIGN_TEST_PAYLOAD_HASH,
    created_by: input.userId,
  };
}
