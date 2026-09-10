import { randomUUID } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';
import { adminClient, ensureTestUser, TEST_USER_EMAIL, TEST_USER_PASSWORD, DEFAULT_ORG_ID } from '../../e2e/fixtures';

// Called only by the reviewed repair runner while its database lease is held.
export async function verifyAuthenticated() {
  if (process.env.TEST_SUPABASE_URL !== 'https://bnkipfoqggwyttbykjfn.supabase.co') throw new Error('VERIFY_TARGET');
  const admin = adminClient();
  const userId = await ensureTestUser(admin);
  const client = createClient(process.env.TEST_SUPABASE_URL, process.env.TEST_SUPABASE_ANON_KEY!, { auth: { persistSession: false, autoRefreshToken: false } });
  const { data: session, error: loginError } = await client.auth.signInWithPassword({ email: TEST_USER_EMAIL, password: TEST_USER_PASSWORD });
  if (loginError || session.user?.id !== userId) throw new Error('VERIFY_LOGIN');
  const id = randomUUID();
  const address = `Repair514${randomUUID().replaceAll('-', '')}`;
  let inserted = false;
  try {
    inserted = true; // Also clean up an insert whose response is lost.
    const { error } = await admin.from('properties').insert({ id, org_id: DEFAULT_ORG_ID, address, state: 'MO', status: 'prospect', city: 'Kansas City', zip: '64151' });
    if (error) throw new Error('VERIFY_FIXTURE');
    let positive = false;
    for (let attempt = 0; attempt < 10; attempt++) {
      const { data, error } = await client.rpc('search_global', { q: address, per_type: 5 });
      if (!error && Array.isArray(data) && data.some(row => row.entity_type === 'property' && row.entity_id === id)) { positive = true; break; }
      if (error && error.code !== 'PGRST202') throw new Error('VERIFY_RPC');
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
    if (!positive) throw new Error('VERIFY_POSITIVE');
    // Only this job's membership is removed; native lifecycle cleans up its user.
    const { error: removeError } = await admin.from('memberships').delete().eq('user_id', userId).eq('org_id', DEFAULT_ORG_ID);
    if (removeError) throw new Error('VERIFY_MEMBERSHIP');
    const { data: denied, error: deniedError } = await client.rpc('search_global', { q: address, per_type: 5 });
    if (deniedError || !Array.isArray(denied) || denied.length !== 0) throw new Error('VERIFY_NO_MEMBERSHIP');
    const anon = createClient(process.env.TEST_SUPABASE_URL, process.env.TEST_SUPABASE_ANON_KEY!, { auth: { persistSession: false, autoRefreshToken: false } });
    const { error: anonError } = await anon.rpc('search_global', { q: address, per_type: 5 });
    if (anonError?.code !== '42501') throw new Error('VERIFY_ANON');
    console.log('Authenticated search, absent membership, and anonymous denial verified.');
  } finally {
    if (inserted) {
      const { data, error } = await admin.from('properties').delete().eq('id', id).eq('address', address).select('id');
      if (error || !Array.isArray(data) || data.length > 1) throw new Error('VERIFY_FIXTURE_CLEANUP');
    }
    await client.auth.signOut();
  }
}
