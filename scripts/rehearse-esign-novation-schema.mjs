import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";

export async function rehearseNovationSchema(client, ids, legacyMetadata) {
  const sql = readFileSync("supabase/migrations/20260915001000_esign_novation_schema.sql", "utf8");
  const fields = [
    "seller_name", "buyer_name", "property_address", "agreement_date",
    "legal_description", "offer_price", "earnest_money_holder", "earnest_money",
    "property_state", "closing_date", "closing_agent_name", "due_diligence_days",
    "access_days_per_week", "access_hours_per_visit", "offer_expiration",
    "acceptance_date", "buyer_phone", "seller_phone", "buyer_email",
    "seller_email", "closing_agent_phone", "closing_agent_address",
    "attorney_in_fact", "release_date",
  ];
  const before = await client.query("select pg_get_functiondef('public.esign_merge_fields_are_valid(text[])'::regprocedure) as definition");
  await client.query("begin");
  await client.query(sql.replace(/^begin;$/m, "").replace(/^commit;$/m, ""));
  await client.query("rollback");
  const after = await client.query("select pg_get_functiondef('public.esign_merge_fields_are_valid(text[])'::regprocedure) as definition");
  assert.equal(after.rows[0].definition, before.rows[0].definition, "rollback changed previous field validation");
  await client.query(sql);
  await client.query(sql);

  const validFields = async (names) => (await client.query(
    "select public.esign_merge_fields_are_valid($1::text[]) as valid", [names],
  )).rows[0].valid;
  assert.equal(await validFields(fields), true);
  assert.equal(await validFields(fields.slice(1)), false);
  assert.equal(await validFields([...fields, "extra"]), false);

  const metadata = structuredClone(legacyMetadata);
  metadata.providerTemplateId = `novation-${randomUUID()}`;
  metadata.mergeFieldNames = fields;
  metadata.documents[0].customFields = [
    ...fields.map((name) => ({
      ...legacyMetadata.documents[0].customFields[0], name, apiId: name, required: true,
    })),
    { ...legacyMetadata.documents[0].customFields[0],
      name: "property_address", apiId: "property_address_repeat", required: true },
  ];
  const validMetadata = async (data) => (await client.query(
    "select public.esign_website_template_metadata_is_valid($1,$2,$3::jsonb) as valid",
    [data.providerTemplateId, "provider-account-1", JSON.stringify(data)],
  )).rows[0].valid;
  assert.equal(await validMetadata(metadata), true);
  assert.deepEqual((await client.query(
    "select public.esign_website_sender_field_names($1::jsonb) as names", [JSON.stringify(metadata)],
  )).rows[0].names, [...fields].sort());
  for (const mutate of [
    (data) => data.documents[0].customFields.shift(),
    (data) => data.documents[0].customFields[0].required = false,
    (data) => data.documents[0].customFields[0].apiId = "",
    (data) => data.documents[0].customFields.push({ ...data.documents[0].customFields[0], name: "extra" }),
    (data) => data.documents[0].customFields.push({ ...data.documents[0].customFields[0], name: "signer_extra", assignedTo: "signer" }),
  ]) {
    const invalid = structuredClone(metadata);
    mutate(invalid);
    assert.equal(await validMetadata(invalid), false, "invalid novation metadata accepted");
  }
  const registered = await client.query(
    "select * from public.register_dropbox_website_esign_template($1,$2,$3,$4,$5,$6,$7::jsonb)",
    [ids.org, ids.owner, metadata.providerTemplateId, "Novation packet fixture",
      "novation_agreement", "provider-account-1", JSON.stringify(metadata)],
  );
  assert.equal(registered.rows[0].outcome, "registered");
  const stored = await client.query("select merge_field_names from public.esign_templates where id = $1", [registered.rows[0].template_id]);
  assert.deepEqual(stored.rows[0].merge_field_names, [...fields].sort());

  const signers = legacyMetadata.signerRoles.map((role) => ({
    role: role.name, order: role.order, name: `${role.name} Fixture`,
    emailAddress: `${role.name.toLowerCase()}@example.com`,
  }));
  const values = Object.fromEntries(fields.map((name) => [name, "fixture value"]));
  const validPayload = async (payload) => (await client.query(
    "select public.esign_request_payload_is_valid($1::jsonb,$2::jsonb,$3::jsonb,$4::text[]) as valid",
    [JSON.stringify(signers), JSON.stringify(payload), JSON.stringify(legacyMetadata.signerRoles), fields],
  )).rows[0].valid;
  assert.equal(await validPayload(values), true);
  assert.equal(await validPayload({ ...values, attorney_in_fact: "" }), false);
  const withoutField = { ...values };
  delete withoutField.attorney_in_fact;
  assert.equal(await validPayload(withoutField), false);
  console.log("Novation contract schema: repeated field attestation, exact values, rollback and reapply passed");
}
