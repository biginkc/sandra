import type { AcquisitionRoster } from './queries';

export function canViewMyLeads(roster: AcquisitionRoster, userId: string, isOwner: boolean): boolean {
  return isOwner || (roster.settings.enabled && roster.members.some(
    (member) => member.id === userId && member.active && member.acquisitionsEnabled,
  ));
}
