import { NextResponse } from 'next/server';

import { runRecordingTick, type RecordingAudioDeps } from '@/lib/dialpad-cti/recording-audio';
import { decodeMp3 } from '@/lib/dialpad-cti/recording-audio-decode';
import {
  createSupabaseAudioStorage,
  createSupabaseRecordingAudioDb,
  dialpadAudioBucketReady,
  type AudioSupabaseClient,
} from '@/lib/dialpad-cti/recording-audio-db';
import { reportError } from '@/lib/errors/report';
import { schemaReady } from '@/lib/my-leads/schema-ready';
import { createAdminClient } from '@/lib/supabase/admin';

/**
 * Vercel cron → `/api/cron/dialpad-recording-download` every minute. Stores the Dialpad admin call recording
 * (MP3) in Sandra's private `dialpad-call-audio` bucket. A strictly sequential, singleton worker: see
 * `src/lib/dialpad-cti/recording-audio.ts` for the timing contract. Its own route and its own schema key, so the
 * transcript sweep (`/api/cron/dialpad-artifact-sweep`, `schemaReady('artifact_fetch')`) is not involved.
 *
 * Inert until switched on: it answers `disabled` until the migration's tables, functions and bucket exist, then
 * `idle` while no org has `recording_download` on (the queue function checks the flag and the canary list in SQL).
 */
export const maxDuration = 60;
export const dynamic = 'force-dynamic';

async function handle(request: Request) {
  const t0 = Date.now(); // the deadline is anchored here and never reset
  const secret = process.env.CRON_SECRET;
  if (!secret) return NextResponse.json({ error: 'CRON_SECRET not configured' }, { status: 500 });
  if (request.headers.get('authorization') !== `Bearer ${secret}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  try {
    // The admin client is created on first use, so a not-ready schema never reaches Storage or an RPC beyond the probe.
    let admin: AudioSupabaseClient | null = null;
    const client = (): AudioSupabaseClient => (admin ??= createAdminClient() as unknown as AudioSupabaseClient);
    const lazy: AudioSupabaseClient = {
      rpc: (fn, args) => client().rpc(fn, args),
      storage: { getBucket: (id) => client().storage.getBucket(id), from: (bucket) => client().storage.from(bucket) },
    };
    const deps: RecordingAudioDeps = {
      db: createSupabaseRecordingAudioDb(lazy),
      storage: createSupabaseAudioStorage(lazy),
      fetchImpl: (url, init) => fetch(url, init),
      clock: { now: () => Date.now(), sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)) },
      decode: decodeMp3,
      env: process.env,
      schemaReady: () => schemaReady('dialpad_call_audio'),
      bucketReady: () => dialpadAudioBucketReady(lazy),
    };
    const summary = await runRecordingTick(deps, t0);
    return NextResponse.json({ ok: true, ...summary });
  } catch (error) {
    reportError(error, { tags: { surface: 'cron_dialpad_recording_download' } });
    return NextResponse.json({ error: 'recording_download_failed' }, { status: 500 });
  }
}

export { handle as GET, handle as POST };
