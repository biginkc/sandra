import { recordingApi } from '@/lib/recordings/api';
export const dynamic = 'force-dynamic';
export async function POST(request: Request, { params }: { params: Promise<{fileId: string}> }) {
  return recordingApi('mine', request, (await params).fileId, true);
}
