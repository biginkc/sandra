import { InvalidRecordingFilter, parseRecordingFilters, type RecordingScope } from './filters';
import { listRecordings, recordingDetails, recordingPlayback, requireRecordingViewer, RecordingAccessError } from './data';
const headers = { 'cache-control': 'private, no-store, max-age=0', vary: 'Cookie' };
export async function recordingApi(scope: RecordingScope, request: Request, fileId?: string, playback = false) {
  try {
    await requireRecordingViewer(scope);
    if (fileId) return Response.json(await (playback ? recordingPlayback(scope, fileId) : recordingDetails(scope, fileId)), { headers });
    const params = new URL(request.url).searchParams;
    const values = Object.fromEntries([...new Set(params.keys())].map(k => [k, params.getAll(k).length > 1 ? params.getAll(k) : params.get(k) ?? '']));
    return Response.json(await listRecordings(scope, parseRecordingFilters(values, scope)), { headers });
  } catch (error) {
    const status = error instanceof RecordingAccessError ? error.status : error instanceof InvalidRecordingFilter ? 400 : 500;
    return Response.json({ error: status === 500 ? 'Unable to load recordings' : (error as Error).message }, { status, headers });
  }
}
