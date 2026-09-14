import { rehearseWebsiteRemoval } from "./rehearse-esign-website-removal.mjs";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";

// Called inside the existing disposable local database rehearsal after legacy checks.
export async function rehearseResidentialSchema(client, ids, legacyMetadata) {
  const sql = readFileSync("supabase/migrations/20260912190000_esign_residential_purchase_schema.sql", "utf8");
  const legacy = legacyMetadata.mergeFieldNames;
  const residential = ["seller_name", "buyer_name", "property_address", "property_city", "property_state", "property_zip", "legal_description", "offer_price", "earnest_money_holder", "earnest_money", "cash_balance", "closing_date", "additional_terms"];
  const before = await client.query("select pg_get_functiondef('public.create_esign_request(uuid,uuid,uuid,jsonb,jsonb,uuid,text,uuid,uuid)'::regprocedure) as definition");
  await client.query("begin");
  await client.query(sql.replace(/^begin;$/m, "").replace(/^commit;$/m, ""));
  await client.query("rollback");
  const after = await client.query("select pg_get_functiondef('public.create_esign_request(uuid,uuid,uuid,jsonb,jsonb,uuid,text,uuid,uuid)'::regprocedure) as definition");
  assert.equal(after.rows[0].definition, before.rows[0].definition, "rollback changed original send function");
  await client.query(sql);
  await client.query(sql);
  for (const [fields, valid] of [[legacy, true], [residential, true], [residential.slice(1), false], [[...residential, "extra"], false], [[...legacy, "seller_name"], false], [null, false], [[null, ...legacy.slice(1)], false]]) {
    const r = await client.query("select public.esign_merge_fields_are_valid($1) as valid", [fields]);
    assert.equal(r.rows[0].valid, valid);
  }
  const signers = legacyMetadata.signerRoles.map((role) => ({ role: role.name, order: role.order, name: `${role.name} Canary`, emailAddress: `${role.name.toLowerCase()}@example.com` }));
  const legacyValues = Object.fromEntries(legacy.map((name) => [name, "fixture value"]));
  const values = Object.fromEntries(residential.map((name) => [name, name === "additional_terms" ? "" : "fixture value"]));
  const validPayload = async (payload, fields, signing = signers) => (await client.query("select public.esign_request_payload_is_valid($1::jsonb,$2::jsonb,$3::jsonb,$4::text[]) as valid", [JSON.stringify(signing), JSON.stringify(payload), JSON.stringify(legacyMetadata.signerRoles), fields])).rows[0].valid;
  assert.equal(await validPayload(legacyValues, legacy), true);
  assert.equal(await validPayload(values, residential), true);
  assert.equal(await validPayload(values, legacy), false);
  assert.equal(await validPayload(legacyValues, residential), false);
  assert.equal(await validPayload({ ...values, buyer_name: " " }, residential), false);
  assert.equal(await validPayload({ ...values, buyer_name: 123 }, residential), false);
  assert.equal(await validPayload({ ...values, extra: "bad" }, residential), false);
  const { legal_description: omitted, ...missing } = values;
  assert.equal(await validPayload(missing, residential), false);
  assert.equal(await validPayload(null, residential), false);
  assert.equal(await validPayload(values, residential, [null, signers[1]]), false);
  const metadata = structuredClone(legacyMetadata);
  metadata.providerTemplateId = `residential-${randomUUID()}`;
  metadata.mergeFieldNames = residential;
  metadata.documents[0].customFields = residential.map((name) => ({ ...legacyMetadata.documents[0].customFields[0], name, apiId: name, required: name !== "additional_terms" }));
  const validMetadata = async (data) => (await client.query("select public.esign_website_template_metadata_is_valid($1,$2,$3::jsonb) as valid", [data.providerTemplateId, "provider-account-1", JSON.stringify(data)])).rows[0].valid;
  assert.equal(await validMetadata(metadata), true);
  for (const mutate of [
    (m) => m.documents[0].customFields.push(m.documents[0].customFields[0]),
    (m) => m.documents[0].customFields.push({ ...m.documents[0].customFields[0], assignedTo: "signer" }),
    (m) => m.documents[0].customFields.pop(),
    (m) => m.documents[0].customFields[0].name = null,
    (m) => m.documents[0].customFields[0].apiId = "",
    (m) => m.accounts[0].accountId = "wrong-account",
    (m) => delete m.isEmbedded,
    (m) => m.documents[0].customFields.find((f) => f.name === "additional_terms").required = true,
    (m) => m.documents[0].customFields[0].required = false,
  ]) {
    const invalid = structuredClone(metadata); mutate(invalid);
    assert.equal(await validMetadata(invalid), false, "invalid metadata accepted");
  }
  const register = async (data) => client.query("select * from public.register_dropbox_website_esign_template($1,$2,$3,$4,$5,$6,$7::jsonb)", [ids.org, ids.owner, data.providerTemplateId, "Residential internal fixture", "purchase_agreement", "provider-account-1", JSON.stringify(data)]);
  const registered = await register(metadata);
  assert.equal(registered.rows[0].outcome, "registered");
  const templateId = registered.rows[0].template_id;
  const drift = structuredClone(legacyMetadata); drift.providerTemplateId = metadata.providerTemplateId;
  await assert.rejects(register(drift), /field schema changed/);
  await client.query("update public.org_esign_integrations set test_mode = true, sending_enabled = true, disconnect_pending_at = null, disconnect_requested_by = null where org_id = $1", [ids.org]);
  await client.query("update public.webhook_consumers set enabled = true, revoked_at = null where id = $1", [ids.consumer]);
  const available = async () => (await client.query("select public.esign_template_is_available($1,$2) as available", [templateId, ids.org])).rows[0].available;
  assert.equal(await available(), true);
  await client.query("update public.esign_templates set provider_metadata = $2::jsonb where id = $1", [templateId, JSON.stringify(drift)]);
  assert.equal(await available(), false, "attestation/storage mismatch remained available");
  await client.query("update public.esign_templates set provider_metadata = $2::jsonb where id = $1", [templateId, JSON.stringify(metadata)]);
  const intent = randomUUID();
  const claim = async (payload, sendIntent = intent, hash = "e".repeat(64), retry = null) => (await client.query("select * from public.create_esign_request($1,$2,$3,$4::jsonb,$5::jsonb,$6,$7,$8,$9)", [ids.org, ids.property, templateId, JSON.stringify(signers), JSON.stringify(payload), sendIntent, hash, retry, ids.member])).rows[0];
  const sent = await claim(values);
  assert.equal(sent.outcome, "created");
  const replay = await claim(values);
  assert.equal(replay.id, sent.id);
  assert.equal((await claim(values, intent, "f".repeat(64))).outcome, "intent_conflict");
  assert.equal((await claim(legacyValues, randomUUID())).blocker_code, "SIGNER_PAYLOAD_INVALID");
  await client.query("update public.esign_requests set delivery_state = 'failed' where id = $1", [sent.id]);
  const retried = await claim(values, randomUUID(), "e".repeat(64), sent.id);
  assert.equal(retried.outcome, "created");
  assert.deepEqual(retried.merge_value_snapshot, values);
  await rehearseWebsiteRemoval(client, ids, templateId, metadata, sent.id);
  console.log("Residential contract schema: registration, drift, payload, replay, retry, rollback and reapply passed");
}
