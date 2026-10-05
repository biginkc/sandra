import { NextResponse } from 'next/server';

import { createSupabaseDialpadArtifactDb, sweepDialpadArtifacts } from '@/lib/dialpad-cti/artifact-fetch';
import { reportError } from '@/lib/errors/report';
import { schemaReady } from '@/lib/my-leads/schema-ready';
import { createAdminClient } from '@/lib/supabase/admin';

/**
 * Vercel cron → `/api/cron/dialpad-artifact-sweep` every minute. Fetches Dialpad call transcripts and AI
 * Recaps that are due (1, 5, 15, 60 minutes after hangup) and resolves recording-link readiness. It has its
 * own route so a slow Dialpad API cannot starve the call-event sweep (the revenue-path correctness job).
 *
 * Inert until switched on: the per-org `artifact_fetch` flag is enforced inside the claim functions (only
 * orgs with the flag on are ever returned; a missing row, column or table reads as off), and the route does
 * nothing at all until the migration's functions exist (`schemaReady`).
 */
export const maxDuration = 60;
export const dynamic = 'force-dynamic';

async function handle(request: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret) return NextResponse.json({ error: 'CRON_SECRET not configured' }, { status: 500 });
  if (request.headers.get('authorization') !== `Bearer ${secret}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  try {
    if (!(await schemaReady('artifact_fetch'))) return NextResponse.json({ ok: true, disabled: 'schema_not_ready' });
    const summary = await sweepDialpadArtifacts(createSupabaseDialpadArtifactDb(createAdminClient()));
    return NextResponse.json({ ok: true, ...summary });
  } catch (error) {
    reportError(error, { tags: { surface: 'cron_dialpad_artifact_sweep' } });
    return NextResponse.json({ error: 'sweep_failed' }, { status: 500 });
  }
}

export { handle as GET, handle as POST };
