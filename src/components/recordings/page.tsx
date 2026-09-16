import { redirect, notFound } from 'next/navigation';
import { Page } from '@/components/page';
import { RecordingLibrary } from './library';
import { listRecordings, requireRecordingViewer, RecordingAccessError } from '@/lib/recordings/data';
import { parseRecordingFilters, InvalidRecordingFilter, type RecordingScope, type SearchParams } from '@/lib/recordings/filters';
import { PageHeader } from '@/components/page-header';
export async function RecordingLibraryPage({ scope, searchParams }: { scope: RecordingScope; searchParams: Promise<SearchParams> }) {
  const values = await searchParams;
  let result;
  try {
    await requireRecordingViewer(scope);
    result = await listRecordings(scope, parseRecordingFilters(values, scope));
  } catch (error) {
    if (error instanceof RecordingAccessError && error.status === 401) redirect('/login');
    if (error instanceof RecordingAccessError && error.status === 403) notFound();
    if (error instanceof InvalidRecordingFilter || error instanceof RecordingAccessError) return <Page><PageHeader breadcrumb={[{ label: 'Workspace' }, { label: scope === 'owner' ? 'Recordings' : 'My Recordings' }]} title={scope === 'owner' ? 'Recordings' : 'My Recordings'} /><p role="alert">{error.message}</p><a className="underline" href={scope === 'owner' ? '/owner/recordings' : '/my-recordings'}>Reset and retry</a></Page>;
    throw error;
  }
  return <Page><RecordingLibrary key={`${result.viewerId}:${scope}`} result={result} scope={scope} values={values} /></Page>;
}
