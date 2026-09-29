import { NextResponse } from 'next/server';

import { createSupabaseDialpadCtiDb, handleDialpadVoiceWebhook } from '@/lib/dialpad-cti/event-processing';
import { reportError } from '@/lib/errors/report';
import { createAdminClient } from '@/lib/supabase/admin';

export const maxDuration = 30;
export const dynamic = 'force-dynamic';

/**
 * Dialpad call-event subscription target for one org connection:
 * POST /api/webhooks/dialpad/voice/<dialpad_org_connections.id>
 * The body is the raw HS256 JWT signed with that connection's webhook secret.
 * Auth is the signature alone; the URL id only selects which secret to check.
 */
export async function POST(request: Request, context: { params: Promise<{ connectionId: string }> }) {
  const { connectionId } = await context.params;
  let db;
  try {
    db = createSupabaseDialpadCtiDb(createAdminClient());
  } catch (error) {
    reportError(error, { tags: { surface: 'dialpad_cti_webhook_client' } });
    return NextResponse.json({ error: 'unavailable' }, { status: 503 });
  }
  const rawBody = await request.text();
  const result = await handleDialpadVoiceWebhook({ connectionId, rawBody, db, env: process.env });
  return NextResponse.json(result.body, { status: result.status });
}
