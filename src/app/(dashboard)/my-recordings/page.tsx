import { RecordingLibraryPage } from '@/components/recordings/page';
import type { SearchParams } from '@/lib/recordings/filters';
export const dynamic = 'force-dynamic';
export default function Page({ searchParams }: { searchParams: Promise<SearchParams> }) { return <RecordingLibraryPage scope="mine" searchParams={searchParams} />; }
