import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { randomUUID } from 'node:crypto';

const SELECT = 'id,body,from_address,to_address,created_at,scheduled_for,property_id,contact_id,property:properties(id,address,city,state),contact:contacts(id,first_name,last_name,entity_name,phone_1)';
const PAGE = `/rest/v1/messages?select=${encodeURIComponent(SELECT)}&status=eq.queued&order=scheduled_for.asc.nullslast,id.asc&limit=101`;
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export function assertExactIds(actual, expected) {
  assert.deepEqual(actual.map(m => m.id).sort(), expected.map(m => m.id).sort());
}
export function assertMetrics(metrics, queued) {
  assert.equal(Number(metrics?.queued), queued);
  assert.equal(Number(metrics?.paused), 1);
}
export function assertEmbedding(message, base) {
  assert.deepEqual(Object.keys(message).sort(), ['id','body','from_address','to_address','created_at','scheduled_for','property_id','contact_id','property','contact'].sort());
  assert.deepEqual(message.property, { id: base.property.id, address: base.property.address, city: base.property.city, state: base.property.state });
  assert.deepEqual(message.contact, { id: base.contact.id, first_name: base.contact.first_name, last_name: base.contact.last_name, entity_name: base.contact.entity_name ?? null, phone_1: base.contact.phone_1 });
}

export async function runContracts({ fixture, db, phase, provider }) {
  const { rest, ids, users } = fixture;
  const checks = [];
  const run = async (id, fn) => {
    try { const detail = await fn(); checks.push({ id, verdict: 'PASS', detail }); }
    catch (error) { checks.push({ id, verdict: 'FAIL', error: String(error.message ?? error) }); }
  };
  const q = (actor, method, resource, body, headers) => rest.request(actor, method, resource, body, { headers });
  const row = name => ids.messages[name];
  const payload = name => { const { returned, ...value } = row(name); return value; };
  const get = async (actor, name, columns = '*') => q(actor, 'GET', `/rest/v1/messages?id=eq.${row(name).id}&select=${encodeURIComponent(columns)}`);
  const sql = async (query, params = []) => (await db.query(query, params)).rows;
  const revision = async (table, column, predicates, params) => {
    const rows = await sql(`select ${column} as value from ${table} where ${predicates}`, params);
    assert.equal(rows.length, 1, `${table} revision missing`);
    return BigInt(rows[0].value);
  };
  const effects = async name => {
    const message = row(name);
    if (phase !== 'post') return null;
    const org = ids.O1, conversation = message.conversation_id;
    const dirty = await revision('inbox_message_capture.dirty', 'generation', 'org_id=$1 and target_kind=$2 and target_id=$3', [org, 'known_conversation', conversation]);
    const content = await revision('inbox_message_capture.versions', 'revision', 'org_id=$1 and namespace=$2 and target_id=$3', [org, 'message_content', message.id]);
    const known = await revision('inbox_message_capture.versions', 'revision', 'org_id=$1 and namespace=$2 and target_id=$3', [org, 'known_reply', conversation]);
    const target = await revision('inbox_operation_domain.target_versions', 'revision', 'org_id=$1 and conversation_id=$2', [org, conversation]);
    const queue = await sql('select claim_token from inbox_maintained.queue where org_id=$1 and target_kind=$2 and target_id=$3', [org, 'known_conversation', conversation]);
    assert.equal(queue.length, 1, 'queue missing');
    return { dirty, content, known, target };
  };
  const increased = (after, before, key, amount = 1n) => assert.equal(after[key], before[key] + amount, `${key} delta`);
  await run('C00', async () => {
    assert(Object.values(ids.messages).every(m => m.returned?.id === m.id));
    const cross = await q('member', 'POST', '/rest/v1/messages', { ...payload('m1'), id: undefined, org_id: ids.O2 }, { Prefer: 'return=representation' });
    assert(cross.status >= 400, JSON.stringify(cross));
    if (phase === 'post') {
      const inbound = await get('member', 'm11', 'id,inbox_inbound_revision');
      assert.equal(inbound.data?.[0]?.inbox_inbound_revision, 1);
      assert.equal(row('m11').returned.inbox_inbound_revision, 0);
      const capture = await sql('select generation from inbox_message_capture.dirty where org_id=$1 and target_kind=$2 and target_id=$3', [ids.O1, 'known_conversation', row('m1').conversation_id]);
      assert.equal(capture.length, 1);
      const queue = await sql('select claim_token from inbox_maintained.queue where org_id=$1 and target_kind=$2 and target_id=$3', [ids.O1, 'known_conversation', row('m1').conversation_id]);
      assert.equal(queue.length, 1); assert.equal(queue[0].claim_token, null);
      const edge = await sql('select phone_e164 from inbox_message_capture.route_edges where org_id=$1 and message_id=$2', [ids.O1, row('m1').id]);
      assert.equal(edge[0]?.phone_e164, row('m1').to_address);
      const versions = await sql('select namespace,target_id,revision from inbox_message_capture.versions where org_id=$1 and ((namespace=$2 and target_id=$3) or (namespace=$4 and target_id=$5))', [ids.O1, 'message_content', row('m1').id, 'known_reply', row('m1').conversation_id]);
      assert.equal(versions.length, 2);
      const head = await sql('select revision from public.inbox_inbound_heads where org_id=$1 and conversation_id=$2', [ids.O1, row('m11').conversation_id]);
      assert.equal(head[0]?.revision, '1');
      const freshDirtyBefore = await sql('select generation from inbox_message_capture.dirty where org_id=$1 and target_kind=$2 and target_id=$3', [ids.O1, 'known_conversation', row('m11').conversation_id]);
      const freshVersionBefore = await sql('select revision from inbox_message_capture.versions where org_id=$1 and namespace=$2 and target_id=$3', [ids.O1, 'known_reply', row('m11').conversation_id]);
      const fresh = await q('member', 'POST', '/rest/v1/messages', { ...payload('m11'), id: randomUUID(), body: `contract-${fixture.slug}-fresh-inbound` }, { Prefer: 'return=representation' });
      assert.equal(fresh.status, 201, JSON.stringify(fresh));
      assert.equal(fresh.data?.[0]?.inbox_inbound_revision, 0);
      const freshRead = await q('member', 'GET', `/rest/v1/messages?id=eq.${fresh.data[0].id}&select=id,inbox_inbound_revision`);
      assert.equal(freshRead.data?.[0]?.inbox_inbound_revision, 2);
      const freshDirty = await sql('select generation from inbox_message_capture.dirty where org_id=$1 and target_kind=$2 and target_id=$3', [ids.O1, 'known_conversation', row('m11').conversation_id]);
      assert(freshDirty[0]?.generation > (freshDirtyBefore[0]?.generation ?? 0), 'fresh dirty capture missing');
      const freshQueue = await sql('select claim_token from inbox_maintained.queue where org_id=$1 and target_kind=$2 and target_id=$3', [ids.O1, 'known_conversation', row('m11').conversation_id]);
      assert.equal(freshQueue.length, 1); assert.equal(freshQueue[0].claim_token, null);
      const freshEdge = await sql('select phone_e164 from inbox_message_capture.route_edges where org_id=$1 and message_id=$2', [ids.O1, fresh.data[0].id]);
      assert.equal(freshEdge[0]?.phone_e164, row('m11').from_address);
      const freshVersions = await sql('select namespace,target_id,revision from inbox_message_capture.versions where org_id=$1 and ((namespace=$2 and target_id=$3) or (namespace=$4 and target_id=$5))', [ids.O1, 'message_content', fresh.data[0].id, 'known_reply', row('m11').conversation_id]);
      assert.equal(freshVersions.length, 2);
      assert(freshVersions.find(v => v.namespace === 'known_reply')?.revision > (freshVersionBefore[0]?.revision ?? 0));
    }
    return { inserted: Object.keys(ids.messages).length, crossTenantStatus: cross.status };
  });
  let firstPage;
  await run('C01', async () => {
    const response = await q('member', 'GET', PAGE);
    assert.equal(response.status, 200); assert.equal(response.data.length, 101);
    const owned = new Set(Object.values(ids.messages).filter(m => m.org_id === ids.O1 && m.status === 'queued').map(m => m.id));
    assert(response.data.every(m => owned.has(m.id)));
    for (const message of response.data) {
      assertEmbedding(message, fixture.base);
      const expected = ids.messages[Object.keys(ids.messages).find(name => ids.messages[name].id === message.id)];
      for (const key of ['body','from_address','to_address','property_id','contact_id']) assert.equal(message[key], expected[key], `${key} mismatch`);
    }
    for (let i = 1; i < response.data.length; i++) {
      const a = response.data[i - 1], b = response.data[i];
      assert(a.scheduled_for !== null || b.scheduled_for === null);
      if (a.scheduled_for && b.scheduled_for) assert(a.scheduled_for < b.scheduled_for || (a.scheduled_for === b.scheduled_for && a.id < b.id));
    }
    firstPage = response.data;
    return { count: response.data.length, first: response.data[0].id, last: response.data.at(-1).id };
  });
  await run('C02', async () => {
    assert(firstPage, 'C01 failed');
    const cursor = firstPage[100];
    const expr = `scheduled_for.gt."${cursor.scheduled_for}",and(scheduled_for.eq."${cursor.scheduled_for}",id.gt.${cursor.id}),scheduled_for.is.null`;
    const response = await q('member', 'GET', `${PAGE}&or=${encodeURIComponent(`(${expr})`)}`);
    assert.equal(response.status, 200);
    const all = [...firstPage, ...response.data];
    assert.equal(new Set(all.map(m => m.id)).size, all.length);
    const expected = Object.values(ids.messages).filter(m => m.org_id === ids.O1 && m.status === 'queued');
    assertExactIds(all, expected);
    return { remainder: response.data.length, fullCount: all.length };
  });
  await run('C03', async () => {
    const [lo, hi] = [row('m4').id, row('m5').id].sort();
    const response = await q('member', 'GET', `${PAGE}&scheduled_for=is.null&id=gt.${lo}`);
    assert.equal(response.status, 200); assert.deepEqual(response.data.map(r => r.id), [hi]);
    return { id: hi };
  });
  await run('C04', async () => {
    const response = await q('member', 'POST', '/rest/v1/rpc/outbound_sms_metrics', { p_org_id: ids.O1 }, { Prefer: 'return=representation' });
    assert.equal(response.status, 200, JSON.stringify(response));
    assert(Array.isArray(response.data) && response.data.length === 1, 'metrics row missing');
    assertMetrics(response.data[0], Object.values(ids.messages).filter(m => m.org_id === ids.O1 && m.status === 'queued' && m.direction === 'outbound').length);
    const denied = await q('service_role', 'POST', '/rest/v1/rpc/outbound_sms_metrics', { p_org_id: ids.O1 });
    assert(denied.status >= 400, JSON.stringify(denied));
    return { metrics: response.data, serviceRoleStatus: denied.status };
  });
  await run('C05', async () => {
    const state = await effects('m7');
    const inboundBefore = phase === 'post' ? await get('member', 'm7', 'id,inbox_inbound_revision') : null;
    const before = await sql('select revision from inbox_operation_domain.target_versions where org_id=$1 and conversation_id=$2', [ids.O1, row('m7').conversation_id]).catch(() => []);
    const response = await q('member', 'PATCH', `/rest/v1/messages?id=eq.${row('m7').id}&status=eq.queued&select=id`, { body: 'contract-edited' }, { Prefer: 'return=representation' });
    assert.equal(response.status, 200); assert.deepEqual(response.data, [{ id: row('m7').id }]);
    for (const name of ['m9', 'm10']) { const blocked = await q('member', 'PATCH', `/rest/v1/messages?id=eq.${row(name).id}&status=eq.queued&select=id`, { body: 'bad' }, { Prefer: 'return=representation' }); assert.deepEqual(blocked.data, []); }
    if (phase === 'post') {
      const after = await effects('m7');
      increased(after, state, 'content'); increased(after, state, 'known'); increased(after, state, 'dirty');
      assert.equal(after.target, state.target);
      assert.deepEqual((await get('member', 'm7', 'id,inbox_inbound_revision')).data, inboundBefore.data);
      assert.deepEqual(await sql('select revision from inbox_operation_domain.target_versions where org_id=$1 and conversation_id=$2', [ids.O1, row('m7').conversation_id]), before);
    }
    return { id: row('m7').id };
  });
  await run('C06', async () => {
    const state = await effects('m8');
    const response = await q('member', 'DELETE', `/rest/v1/messages?id=eq.${row('m8').id}&status=eq.queued&select=id,property_id`, undefined, { Prefer: 'return=representation' });
    assert.equal(response.status, 200); assert.deepEqual(response.data, [{ id: row('m8').id, property_id: row('m8').property_id }]);
    const blocked = await q('member', 'DELETE', `/rest/v1/messages?id=eq.${row('m10').id}&status=eq.queued&select=id`, undefined, { Prefer: 'return=representation' });
    assert.deepEqual(blocked.data, []);
    if (phase === 'post') {
      assert.equal((await sql('select count(*)::int as n from inbox_message_capture.route_edges where org_id=$1 and message_id=$2', [ids.O1, row('m8').id]))[0].n, 0);
      const after = await effects('m8');
      increased(after, state, 'dirty'); increased(after, state, 'content'); increased(after, state, 'known'); increased(after, state, 'target');
    }
    assert.equal((await sql('select count(*)::int as n from public.lead_events where org_id=$1', [ids.O1]))[0].n, 0);
    return { id: row('m8').id };
  });
  await run('C07', async () => {
    const rounds = [];
    for (const name of ['m6a', 'm6b', 'm6c', 'm6d', 'm6e']) {
      const state = await effects(name);
      const path = `/rest/v1/messages?id=eq.${row(name).id}&status=eq.queued&select=id,body`;
      const payload = { status: 'pending', metadata: { providerAttempt: { pendingAt: new Date().toISOString(), maxPendingMs: 900000 } } };
      const [a, b] = await Promise.all([q('member', 'PATCH', path, payload, { Prefer: 'return=representation' }), q('member', 'PATCH', path, payload, { Prefer: 'return=representation' })]);
      assert.equal(a.status, 200); assert.equal(b.status, 200);
      assert.deepEqual([a.data.length, b.data.length].sort(), [0, 1]);
      assert.deepEqual([a.data, b.data].find(data => data.length), [{ id: row(name).id, body: row(name).body }]);
      if (phase === 'post') { const after = await effects(name); increased(after, state, 'target'); increased(after, state, 'dirty'); }
      rounds.push({ id: row(name).id, winners: 1 });
    }
    return rounds;
  });
  await run('C08', async () => {
    const state = await effects('m6a');
    const path = `/rest/v1/messages?id=eq.${row('m6a').id}&status=eq.pending&select=id`;
    const payload = { status: 'sent', external_id: `contract-${fixture.slug}-sent`, sent_at: new Date().toISOString(), failed_at: null, error_message: null, metadata: { providerStatus: 'accepted' } };
    const first = await q('member', 'PATCH', path, payload, { Prefer: 'return=representation' });
    const second = await q('member', 'PATCH', path, payload, { Prefer: 'return=representation' });
    assert.deepEqual(first.data, [{ id: row('m6a').id }]); assert.deepEqual(second.data, []);
    if (phase === 'post') {
      const after = await effects('m6a');
      // 20261002130000:669-687: metadata changes both content and known_reply.
      // 20261002130200:444 and :501-502: pending and sent are both ineligible targets.
      assert.equal(after.target, state.target, 'target delta');
      for (const key of ['dirty','content','known']) increased(after, state, key);
    }
    return { first: first.status, repeat: second.status };
  });
  await run('C08b', async () => {
    const failedState = await effects('m6b');
    const fail = await q('member', 'PATCH', `/rest/v1/messages?id=eq.${row('m6b').id}&status=eq.pending&select=id`, { status: 'failed', failed_at: new Date().toISOString(), error_message: 'contract failure', metadata: { providerStatus: 'failed' } }, { Prefer: 'return=representation' });
    const failedAfter = await effects('m6b');
    const deferredState = await effects('m6c');
    const deferPath = `/rest/v1/messages?id=eq.${row('m6c').id}&status=eq.pending&select=id`;
    const retryAt = new Date(Date.now() + 6 * 3600000).toISOString();
    const deferPayload = { status: 'queued', scheduled_for: retryAt, error_message: 'contract retry', metadata: { providerStatus: 'retry', retryAt } };
    const defer = await q('member', 'PATCH', deferPath, deferPayload, { Prefer: 'return=representation' });
    const deferredAfter = await effects('m6c');
    const deferRepeat = await q('member', 'PATCH', deferPath, deferPayload, { Prefer: 'return=representation' });
    assert.deepEqual(fail.data, [{ id: row('m6b').id }]); assert.deepEqual(defer.data, [{ id: row('m6c').id }]); assert.deepEqual(deferRepeat.data, []);
    const repeat = await q('member', 'PATCH', `/rest/v1/messages?id=eq.${row('m6b').id}&status=eq.pending&select=id`, { status: 'sent' }, { Prefer: 'return=representation' });
    assert.deepEqual(repeat.data, []);
    const reordered = await q('member', 'GET', `${PAGE}&org_id=eq.${ids.O1}`);
    assert.equal(reordered.status, 200);
    assert(reordered.data.some(message => message.id === row('m6c').id), 'deferred message absent from first page');
    for (let i = 1; i < reordered.data.length; i++) {
      const previous = reordered.data[i - 1], current = reordered.data[i];
      assert(previous.scheduled_for <= current.scheduled_for || current.scheduled_for === null, 'deferred position wrong');
    }
    if (phase === 'post') {
      // 20261002130000:669-687: failed metadata changes both content and known_reply.
      // 20261002130200:444: pending and failed have the same target eligibility.
      for (const key of ['dirty','content','known']) increased(failedAfter, failedState, key);
      // 20261002130000:684-687,700-702: pending -> queued changes eligibility;
      // retry metadata changes content, and queue entry changes known_reply.
      increased(deferredAfter, deferredState, 'dirty'); increased(deferredAfter, deferredState, 'known');
      increased(deferredAfter, deferredState, 'content');
      assert.equal(failedAfter.target, failedState.target, 'failed target delta');
      increased(deferredAfter, deferredState, 'target');
    }
    return { failed: row('m6b').id, deferred: row('m6c').id };
  });
  await run('C09', async () => {
    assert.equal(provider, 'mock');
    const untouched = ['m1', 'm2', 'm3', 'm4', 'm5', 'm9', 'm10'];
    for (const name of untouched) {
      const response = await get('member', name);
      assert.equal(response.status, 200); assert.equal(response.data.length, 1);
      assert.equal(digest(response.data[0]), digest(row(name).returned));
    }
    const ledger = await sql('select count(*)::int as n from public.lead_events where org_id in ($1,$2)', [ids.O1, ids.O2]);
    assert.equal(ledger[0].n, 0);
    return { untouched: untouched.length, leadEvents: 0 };
  });
  await run('D01', async () => {
    const page = await q('anon', 'GET', PAGE); assert.equal(page.status, 200);
    if (page.data.length) {
      const own = await q('anon', 'GET', `/rest/v1/messages?id=eq.${row('m1').id}&select=id`);
      throw new Error(`ANON_ROW_EXPOSURE count=${page.data.length} fixture=${own.data?.some(r => r.id === row('m1').id)}`);
    }
    assert.deepEqual(page.data, []);
    const before = await get('member', 'm1');
    for (const method of ['PATCH', 'DELETE']) { const response = await q('anon', method, `/rest/v1/messages?id=eq.${row('m1').id}&select=id`, method === 'PATCH' ? { body: 'bad' } : undefined, { Prefer: 'return=representation' }); assert(response.status >= 400 || (Array.isArray(response.data) && response.data.length === 0)); }
    const after = await get('member', 'm1'); assert.deepEqual(after.data, before.data);
    return { page: page.data.length };
  });
  await run('D02', async () => {
    const page = await q('other', 'GET', PAGE); assert.equal(page.status, 200); assert.deepEqual(page.data.map(r => r.id), [row('other').id]);
    for (const method of ['PATCH', 'DELETE']) { const response = await q('other', method, `/rest/v1/messages?id=eq.${row('m1').id}&select=id`, method === 'PATCH' ? { body: 'bad' } : undefined, { Prefer: 'return=representation' }); assert.deepEqual(response.data, []); }
    const cross = await q('other', 'POST', '/rest/v1/messages', { ...payload('other'), id: undefined, org_id: ids.O1 }); assert(cross.status >= 400);
    return { only: row('other').id, insertStatus: cross.status };
  });
  await run('D03', async () => {
    const before = await q('revoked', 'GET', PAGE); assert(before.data.length > 0);
    const epochBefore = phase === 'post' ? await revision('inbox_bridge.access_epochs', 'revision', 'user_id=$1', [users.revoked.id]) : null;
    const deleted = await q('service_role', 'DELETE', `/rest/v1/memberships?id=eq.${users.revoked.membership}`); assert.equal(deleted.status, 204);
    if (phase === 'post') assert.equal(await revision('inbox_bridge.access_epochs', 'revision', 'user_id=$1', [users.revoked.id]), epochBefore + 1n);
    const after = await q('revoked', 'GET', PAGE); assert.deepEqual(after.data, []);
    const patch = await q('revoked', 'PATCH', `/rest/v1/messages?id=eq.${row('m1').id}&select=id`, { body: 'bad' }, { Prefer: 'return=representation' }); assert.deepEqual(patch.data, []);
    const insert = await q('revoked', 'POST', '/rest/v1/messages', { ...payload('m1'), id: undefined }); assert(insert.status >= 400);
    return { before: before.data.length, after: after.data.length };
  });
  await run('D04', async () => {
    for (const [name, method, revision] of [['m1', 'PATCH', 7], ['m11', 'PATCH', 2], ['m1', 'POST', 1]]) {
      const response = await q('member', method, method === 'POST' ? '/rest/v1/messages' : `/rest/v1/messages?id=eq.${row(name).id}`, method === 'POST' ? { ...payload(name), id: undefined, inbox_inbound_revision: revision } : { inbox_inbound_revision: revision });
      if (phase === 'post') { assert.equal(response.status, 403, JSON.stringify(response)); assert.equal(response.code, '42501'); }
      else { assert(response.status >= 400); assert.equal(response.code, 'PGRST204'); }
    }
    return { phase };
  });
  await run('D05', async () => {
    for (const actor of ['member', 'service_role']) {
      const head = await q(actor, 'GET', '/rest/v1/inbox_inbound_heads?select=*');
      assert(head.status >= 400); if (phase === 'pre') assert.equal(head.code, 'PGRST205');
      const queue = await q(actor, 'GET', '/rest/v1/queue?select=*', undefined, { 'Accept-Profile': 'inbox_maintained' });
      assert(queue.status >= 400);
    }
    return { phase };
  });
  return checks;
}
