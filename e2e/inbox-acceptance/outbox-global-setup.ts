import fs from "node:fs";
import path from "node:path";
import sharedGlobalSetup from '../global-setup';
import { adminClient, DEFAULT_ORG_ID, E2E_MOCK_BUSINESS_NUMBER, ensureAcceptanceOrganization, ensureTestUser } from '../fixtures';
import { assertDisposableE2EDatabaseEnvironment } from '../../src/lib/supabase/e2e-target-safety';
import { cleanupOwnedRows, readOwnedRows, recordOwnedRow } from './owned-rows';
import { resetResultsFile } from './results';

export default async function setup(): Promise<() => Promise<void>> {
  assertDisposableE2EDatabaseEnvironment(process.env.TEST_SUPABASE_URL ?? '');
  if (!process.env.OUTBOX_RUN_DIR || process.env.INBOX_ACCEPTANCE_ORG_ID !== DEFAULT_ORG_ID || process.env.MESSAGING_PROVIDER !== 'mock') throw new Error('Outbox requires run record, disposable Sandra org, and mock provider');
  const sharedTeardown = await sharedGlobalSetup();
  const admin = adminClient();
  try {
    if (await ensureAcceptanceOrganization(admin)) recordOwnedRow('organizations', DEFAULT_ORG_ID);
    const userId = await ensureTestUser(admin);
    recordOwnedRow('auth.users', userId);
    const { data: membership, error: membershipError } = await admin.from('memberships').select('id').eq('org_id', DEFAULT_ORG_ID).eq('user_id', userId).single();
    if (membershipError || !membership) throw membershipError ?? new Error('membership missing');
    recordOwnedRow('memberships', membership.id);
    const { data: sender, error: senderError } = await admin.from('provider_sender_numbers').insert({ org_id: DEFAULT_ORG_ID, provider: 'mock', phone_e164: E2E_MOCK_BUSINESS_NUMBER, status: 'active', last_synced_at: new Date().toISOString() }).select('id').single();
    if (senderError || !sender) throw senderError ?? new Error('sender missing');
    recordOwnedRow('provider_sender_numbers', sender.id);
    const { data: campaign, error: campaignError } = await admin.from('provider_campaigns').insert({ org_id: DEFAULT_ORG_ID, provider: 'mock', external_id: 'mock-provider-campaign-1', name: 'Mock campaign', status: 'active', last_synced_at: new Date().toISOString() }).select('id').single();
    if (campaignError || !campaign) throw campaignError ?? new Error('campaign missing');
    recordOwnedRow('provider_campaigns', campaign.id);
    resetResultsFile();
  } catch (error) {
    await cleanupOwnedRows(admin, DEFAULT_ORG_ID, readOwnedRows()).finally(sharedTeardown);
    throw error;
  }
  return async () => {
    try {
      const properties = readOwnedRows().filter(row => row.table === 'properties');
      for (const property of properties) {
        const { data, error } = await admin.from('lead_events').select('id,property_id').eq('org_id', DEFAULT_ORG_ID).eq('property_id', property.id);
        if (error) throw error;
        for (const event of data ?? []) recordOwnedRow('lead_events', event.id, event.property_id);
      }
      const rows = readOwnedRows();
      await cleanupOwnedRows(admin, DEFAULT_ORG_ID, rows);
      const auditedProperties = new Set(rows.filter(row => row.table === 'lead_events').map(row => row.property_id));
      const retained = rows.filter(row =>
        ['organizations', 'memberships', 'auth.users', 'lead_events'].includes(row.table) ||
        (row.table === 'properties' && auditedProperties.has(row.id))
      );
      fs.writeFileSync(path.join(process.env.OUTBOX_RUN_DIR!, 'retained-rows.json'), `${JSON.stringify(retained, null, 2)}\n`);
    } finally { await sharedTeardown(); }
  };
}
