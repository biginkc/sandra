import 'server-only';
import { listDripProgress, type DripProgress } from '@/lib/sequences/drip-progress';
import type { QueueStage } from './types';
import { myLeadsViewer, MyLeadsReadError } from './queries';
import type { QueueRow } from './queries';

export type MyLeadDrip = DripProgress & { stage: QueueStage; repliedAt: string | null; queueRow: QueueRow | null };
export type MyLeadDripSnapshot = { active: MyLeadDrip[]; replied: MyLeadDrip[]; repliedCount: number; counts: Record<QueueStage, number> };
type ScopeRow = { property_id: string; stage: string; in_drip: boolean; replied_at: string | null; search_text: string; row_data?: QueueRow | null };
const stages: QueueStage[] = ['not_contacted', 'contacted', 'needs_offer', 'offer_sent', 'under_contract'];

export function groupMyLeadDrips(rows: ScopeRow[], progress: DripProgress[], search: string): MyLeadDripSnapshot {
  const byId = new Map(progress.map(row => [row.propertyId, row]));
  const counts = Object.fromEntries(stages.map(stage => [stage, 0])) as Record<QueueStage, number>;
  const active: MyLeadDrip[] = [];
  const replied: MyLeadDrip[] = [];
  let repliedCount = 0;
  const needle = search.trim().toLowerCase();
  for (const row of rows) {
    if (!stages.includes(row.stage as QueueStage)) continue;
    const drip = byId.get(row.property_id);
    if (!drip) continue;
    const entry = { ...drip, stage: row.stage as QueueStage, repliedAt: row.replied_at, queueRow: row.row_data ?? null };
    if (row.in_drip) {
      if (!needle || row.search_text.toLowerCase().includes(needle)) {
        active.push(entry);
        counts[entry.stage]++;
      }
    } else if (row.replied_at) {
      repliedCount++;
      if (!needle || row.search_text.toLowerCase().includes(needle)) replied.push(entry);
    }
  }
  replied.sort((a, b) => (b.repliedAt ?? '').localeCompare(a.repliedAt ?? ''));
  return { active, replied, repliedCount, counts };
}

export async function listMyLeadsInDrip(repId: string, search = ''): Promise<MyLeadDripSnapshot> {
  const viewer = await myLeadsViewer();
  if (!viewer.isOwner && viewer.userId !== repId) throw new MyLeadsReadError('FORBIDDEN', 'You can view only your own queue.');
  const rows: ScopeRow[] = [];
  const pageSize = 1000;
  let offset = 0;
  let expectedCount: number | null = null;
  for (;;) {
    const { data, error, count } = await viewer.client.rpc('fn_list_my_leads_drip_scope', {
      p_org_id: viewer.orgId, p_member_id: repId,
    }, { count: 'exact' }).order('property_id').range(offset, offset + pageSize - 1);
    if (error || !Array.isArray(data) || count === null || count === undefined ||
        (expectedCount !== null && count !== expectedCount) || count < rows.length + data.length)
      throw new MyLeadsReadError('READ_FAILED', 'Drip status could not load completely. Please retry.');
    expectedCount = count;
    rows.push(...data as ScopeRow[]);
    if (rows.length === count) break;
    if (data.length === 0) throw new MyLeadsReadError('READ_FAILED', 'Drip status could not load completely. Please retry.');
    offset += data.length;
  }
  const progress = await listDripProgress(viewer.client, rows.map(row => row.property_id));
  return groupMyLeadDrips(rows, progress, search);
}
