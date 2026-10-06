import 'server-only';

import { getMyLeadsFlag } from '@/lib/my-leads/flags';
import { schemaReady } from '@/lib/my-leads/schema-ready';
import { createAdminClient } from '@/lib/supabase/admin';
import { loadDialpadCallRoute, type DialpadCallRoute } from './call-route';
import { createSupabaseDialpadDispatchDb, loadDialpadCallingBootstrap } from './dispatch';

/** The viewer's Call-button route, derived on the server for the dashboard layout. Never throws. */
export function getDialpadCallRoute(orgId: string, userId: string): Promise<DialpadCallRoute> {
  return loadDialpadCallRoute(
    {
      isFlagOn: (org) => getMyLeadsFlag(org, 'click_to_dial'),
      isSchemaReady: () => schemaReady('api_dial'),
      loadBootstrap: (org, user) => loadDialpadCallingBootstrap(createSupabaseDialpadDispatchDb(createAdminClient()), { orgId: org, userId: user }),
    },
    orgId,
    userId,
  );
}
