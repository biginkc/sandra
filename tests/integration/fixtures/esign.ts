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
  return {
    id: input.id ?? crypto.randomUUID(),
    org_id: input.orgId,
    name: "Purchase agreement",
    document_type: "purchase_agreement",
    seller_role: "Seller",
    signer_roles: ["Seller"],
    merge_field_names: ["Property address", "Purchase price"],
    sign_template_id: "provider-template-test",
    source_filename: "purchase-agreement.pdf",
    staging_path: `${input.orgId}/${crypto.randomUUID()}.pdf`,
    finalized_at: new Date().toISOString(),
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
      "Property address": "123 Test Street",
      "Purchase price": "100000",
    },
    send_intent_id: input.sendIntentId ?? crypto.randomUUID(),
    payload_hash: ESIGN_TEST_PAYLOAD_HASH,
    created_by: input.userId,
  };
}
