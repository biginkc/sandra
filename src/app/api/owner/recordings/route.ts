import { recordingApi } from '@/lib/recordings/api';
export const dynamic = 'force-dynamic';
export async function GET(request: Request) { return recordingApi('owner', request); }
