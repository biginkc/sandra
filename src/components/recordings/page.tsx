import { redirect, notFound } from 'next/navigation';
import { Page } from '@/components/page';
import { RecordingLibrary } from './library';
import { listRecordings, requireRecordingViewer, RecordingAccessError } from '@/lib/recordings/data';
import { parseRecordingFilters, InvalidRecordingFilter, type RecordingScope, type SearchParams } from '@/lib/recordings/filters';
export async function RecordingLibraryPage({ scope, searchParams }: { scope: RecordingScope; searchParams: Promise<SearchParams> }) {
  const values = await searchParams;
  let result;
  try {
    await requireRecordingViewer(scope);
    result = await listRecordings(scope, parseRecordingFilters(values, scope));
  } catch (error) {
    if (error instanceof RecordingAccessError && error.status === 401) redirect('/login');
    if (error instanceof RecordingAccessError && error.status === 403) notFound();
    if (error instanceof InvalidRecordingFilter || error instanceof RecordingAccessError) return <Page><div><h1 className="text-2xl font-semibold">{scope === 'owner' ? 'Recordings' : 'My Recordings'}</h1><p role="alert" className="my-4">{error.message}</p><a className="underline" href={scope === 'owner' ? '/owner/recordings' : '/my-recordings'}>Reset and retry</a></div></Page>;
    throw error;
  }
  return <Page><RecordingLibrary key={`${result.viewerId}:${scope}`} result={result} scope={scope} values={values} /></Page>;
}
