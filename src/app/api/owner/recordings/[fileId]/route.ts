import { recordingApi } from '@/lib/recordings/api';
export const dynamic = 'force-dynamic';
export async function GET(request: Request, { params }: { params: Promise<{fileId: string}> }) {
  return recordingApi('owner', request, (await params).fileId, false);
}
