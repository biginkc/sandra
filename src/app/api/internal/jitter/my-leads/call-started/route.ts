import { NextResponse } from 'next/server';
import { authenticateJitterWriteback } from '../../_lib/auth';
import { callTokenDigest, parseActualSellerCallStarted } from '@/lib/my-leads/call-evidence';
import type { Json } from '@/lib/supabase/types';

type EvidenceClient = {
  rpc(name: 'fn_record_acquisition_call_start', args: { p_event: Json }): Promise<{
    data: Json | null; error: { code?: string; message?: string } | null;
  }>;
};
export async function POST(request: Request) {
  const auth = await authenticateJitterWriteback(request);
  if (!auth.ok) return auth.response;
  let payload: unknown;
  try { payload = JSON.parse(auth.rawBody); }
  catch { return NextResponse.json({ error: 'invalid_event' }, { status: 400 }); }
  const event = parseActualSellerCallStarted(payload, auth.orgId);
  if (!event) return NextResponse.json({ error: 'invalid_event' }, { status: 400 });
  const { sandraCallToken, ...facts } = event;
  const { data, error } = await (auth.serviceClient as unknown as EvidenceClient).rpc('fn_record_acquisition_call_start', {
    p_event: { ...facts, tokenHash: callTokenDigest(sandraCallToken) },
  });
  if (error) {
    const status = error.code === '42501' ? 403 : error.code === '22023' ? 400 : error.code === '40001' ? 409 : error.code === 'P0002' ? 409 : 503;
    return NextResponse.json({ error: status === 503 ? 'evidence_pending' : 'evidence_rejected' }, { status });
  }
  if (!data) return NextResponse.json({ error: 'evidence_pending' }, { status: 503 });
  return NextResponse.json(data);
}
