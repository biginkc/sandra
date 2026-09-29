import { NextResponse } from 'next/server';

import { createSupabaseDialpadCtiDb, sweepDialpadCallEvents } from '@/lib/dialpad-cti/event-processing';
import { reportError } from '@/lib/errors/report';
import { createAdminClient } from '@/lib/supabase/admin';

/**
 * Vercel cron → `/api/cron/dialpad-call-events-sweep` every minute. Replays
 * persisted Dialpad call events whose inline projection did not complete
 * (received, or matched but not yet projected), up to the per-event attempt cap.
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
    const summary = await sweepDialpadCallEvents(createSupabaseDialpadCtiDb(createAdminClient()));
    return NextResponse.json({ ok: true, ...summary });
  } catch (error) {
    reportError(error, { tags: { surface: 'cron_dialpad_call_events_sweep' } });
    return NextResponse.json({ error: 'sweep_failed' }, { status: 500 });
  }
}

export { handle as GET, handle as POST };
