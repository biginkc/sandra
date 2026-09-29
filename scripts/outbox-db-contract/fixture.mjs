import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { createClient } from '@supabase/supabase-js';

const BUSINESS = '+18162804181';
const expect = (condition, text) => { if (!condition) throw new Error(text); };

export async function createFixture({ apiUrl, serviceKey, anonKey, rest, runDir }) {
  const admin = createClient(apiUrl, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
  const auth = createClient(apiUrl, anonKey, { auth: { persistSession: false, autoRefreshToken: false } });
  const slug = randomUUID().slice(0, 8);
  const rows = [];
  const ids = { O1: randomUUID(), O2: randomUUID(), messages: {} };
  const save = () => writeFileSync(path.join(runDir, 'fixture-rows.json'), `${JSON.stringify(rows, null, 2)}\n`);
  async function record(table, id, send) {
    const row = { table, id, state: 'intended' }; rows.push(row); save();
    try { const result = await send(); row.state = 'confirmed'; row.returned = result; save(); return result; }
    catch (error) { row.state = 'ambiguous'; save(); throw error; }
  }
  async function insert(table, value) {
    const id = value.id ?? randomUUID();
    return record(table, id, async () => {
      const { data, error } = await admin.from(table).insert({ ...value, id }).select('*').single();
      if (error || !data) throw new Error(`${table} fixture insert: ${error?.message}`);
      return data;
    });
  }
  await insert('organizations', { id: ids.O1, name: `Outbox contract ${slug}` });
  await insert('organizations', { id: ids.O2, name: `Outbox contract other-tenant ${slug}` });
  const users = {};
  for (const name of ['member', 'other', 'revoked']) {
    const email = `e2e-contract+${slug}-${name}@bmhgroupkc.com`;
    const password = `${randomUUID()}${randomUUID()}`;
    const userId = randomUUID();
    const user = await record('auth.users', userId, async () => {
      const { data, error } = await admin.auth.admin.createUser({ id: userId, email, password, email_confirm: true });
      if (error || !data.user) throw new Error(`create ${name}: ${error?.message}`);
      return { id: data.user.id, email };
    });
    const orgId = name === 'other' ? ids.O2 : ids.O1;
    const membership = await insert('memberships', { user_id: user.id, org_id: orgId, role: name === 'revoked' ? 'member' : 'owner' });
    const { data, error } = await auth.auth.signInWithPassword({ email, password });
    if (error || !data.session?.access_token) throw new Error(`sign in ${name}: ${error?.message}`);
    users[name] = { id: user.id, membership: membership.id, token: data.session.access_token };
    rest.setToken(name, data.session.access_token);
  }
  const sender = await insert('provider_sender_numbers', { org_id: ids.O1, provider: 'mock', phone_e164: BUSINESS, status: 'active', last_synced_at: new Date().toISOString() });
  await insert('provider_campaigns', { org_id: ids.O1, provider: 'mock', external_id: `contract-${slug}-campaign`, name: `Contract ${slug}`, status: 'active', last_synced_at: new Date().toISOString() });
  const makeBase = async (orgId, tag) => {
    const contact = await insert('contacts', { org_id: orgId, first_name: 'Contract', last_name: `${slug}-${tag}`, phone_1: `+1816${String(5000000 + rows.length).padStart(7, '0')}`, phone_1_type: 'mobile' });
    const property = await insert('properties', { org_id: orgId, address: `${rows.length} Contract Lane`, city: 'Kansas City', state: 'MO', zip: '64105', homeowner_contact_id: contact.id, status: 'new_lead' });
    const thread = await insert('message_threads', { org_id: orgId, contact_id: contact.id, property_id: property.id, channel: 'sms' });
    return { contact, property, thread };
  };
  const base = await makeBase(ids.O1, 'main');
  const otherBase = await makeBase(ids.O2, 'other');
  const now = Date.now();
  const message = (name, baseRow = base, orgId = ids.O1, override = {}) => ({
    // Keep the foreign null-tail row after every owned id so RLS leak probes
    // cannot pass or fail based on random UUID ordering.
    id: orgId === ids.O2 ? `ffffffff-ffff-4fff-8fff-${randomUUID().slice(-12)}` : `0${randomUUID().slice(1)}`,
    org_id: orgId, channel: 'sms', direction: 'outbound', status: 'queued', provider: 'mock',
    property_id: baseRow.property.id, contact_id: baseRow.contact.id, conversation_id: baseRow.thread.conversation_id,
    from_address: BUSINESS, to_address: baseRow.contact.phone_1, body: `contract-${slug}-${name}`,
    scheduled_for: new Date(now + 6 * 3600000).toISOString(), ...override,
  });
  const specs = {};
  for (let n = 1; n <= 10; n++) specs[`m${n}`] = message(`m${n}`, base, ids.O1, { scheduled_for: n === 4 || n === 5 ? null : new Date(now + (6 + (n === 3 ? 1 : 0)) * 3600000).toISOString(), status: n === 9 ? 'paused' : n === 10 ? 'sent' : 'queued' });
  for (let n = 1; n <= 5; n++) specs[`m6${String.fromCharCode(96 + n)}`] = message(`m6${n}`);
  specs.m11 = message('m11', base, ids.O1, { direction: 'inbound', status: 'received', from_address: base.contact.phone_1, to_address: BUSINESS, scheduled_for: null });
  for (let n = 0; n < 101; n++) specs[`p${n}`] = message(`p${n}`, base, ids.O1, { scheduled_for: new Date(now + (8 * 60 + n) * 60000).toISOString() });
  specs.other = message('other', otherBase, ids.O2, { scheduled_for: null });
  for (const [name, value] of Object.entries(specs)) {
    const actor = name === 'other' ? 'other' : 'member';
    const returned = await record('messages', value.id, async () => {
      const response = await rest.request(actor, 'POST', '/rest/v1/messages', value, { headers: { Prefer: 'return=representation' } });
      expect(response.status === 201 && Array.isArray(response.data) && response.data.length === 1, `C00 insert ${name}: ${JSON.stringify(response)}`);
      return response.data[0];
    });
    ids.messages[name] = { ...value, returned };
  }
  return { ids, users, rows, sender, base, otherBase, slug, BUSINESS, rest };
}
