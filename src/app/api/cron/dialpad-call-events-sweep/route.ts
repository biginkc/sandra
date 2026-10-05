import { NextResponse } from 'next/server';

import { createSupabaseDialpadCtiDb, failStaleDialpadIntents, redactDialpadUnmatchedEvents, sweepDialpadCallEvents } from '@/lib/dialpad-cti/event-processing';
import { reportError } from '@/lib/errors/report';
import { schemaReady } from '@/lib/my-leads/schema-ready';
import { createAdminClient } from '@/lib/supabase/admin';

/**
 * Vercel cron → `/api/cron/dialpad-call-events-sweep` every minute. Replays
 * persisted Dialpad call events whose inline projection did not complete
 * (received, or matched but not yet projected), up to the per-event attempt cap, after
 * marking authorized dials that got no provider event for 2 minutes as failed.
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
    const db = createSupabaseDialpadCtiDb(createAdminClient());
    // The intent timeout runs first and never blocks the sweep: a failure here is reported, not fatal.
    let failedIntents: number | null = null;
    try {
      // Inert until the 2.2 migration lands (deploy-before-migration): no call to a missing function.
      if (await schemaReady('intent_timeout')) failedIntents = await failStaleDialpadIntents(db);
    } catch (error) {
      reportError(error, { tags: { surface: 'cron_dialpad_intent_timeout' } });
    }
    const summary = await sweepDialpadCallEvents(db);
    // Redaction runs after the sweep so a failure here can never block replays.
    let redacted: number | null = null;
    try {
      if (await schemaReady('event_redaction')) redacted = await redactDialpadUnmatchedEvents(db);
    } catch (error) {
      reportError(error, { tags: { surface: 'cron_dialpad_event_redaction' } });
    }
    return NextResponse.json({ ok: true, ...summary, failedIntents, redacted });
  } catch (error) {
    reportError(error, { tags: { surface: 'cron_dialpad_call_events_sweep' } });
    return NextResponse.json({ error: 'sweep_failed' }, { status: 500 });
  }
}

export { handle as GET, handle as POST };
