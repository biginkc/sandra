import type { AcquisitionRoster } from '@/lib/my-leads/queries';

/**
 * An active owner is allowed without the Acquisitions designation or workflow
 * toggle, matching the owner capability used by My Leads. `isOwner` comes from
 * the authenticated viewer and is intentionally passed separately from the
 * roster RPC payload. Non-owners remain behind the organization workflow flag.
 */
export function canViewCalculators(
  roster: AcquisitionRoster,
  userId: string,
  isOwner = false,
): boolean {
  const activeOwner = isOwner && roster.members.some(
    (member) => member.id === userId && member.role === "owner" && member.active,
  );
  return activeOwner || (roster.settings.enabled && roster.members.some(
    (member) => member.id === userId && member.active && member.acquisitionsEnabled,
  ));
}
