import type { AcquisitionRoster } from '@/lib/my-leads/queries';
/** Calculator access requires Acquisitions membership, including for owners. */
export function canViewCalculators(roster:AcquisitionRoster,userId:string):boolean {
  return roster.settings.enabled && roster.members.some(m=>m.id===userId && m.active && m.acquisitionsEnabled);
}
