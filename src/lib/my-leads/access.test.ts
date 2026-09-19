import { describe, expect, it } from 'vitest';
import { canViewMyLeads } from './access';
import type { AcquisitionRoster } from './queries';

const roster: AcquisitionRoster = {
  isOwner: true,
  settings: { enabled: true, recipientId: null, revision: 1 },
  members: [
    { id: 'acquisitions', label: 'Acquisitions', role: 'member', active: true, acquisitionsEnabled: true, hasHistory: false },
    { id: 'other', label: 'Other', role: 'member', active: true, acquisitionsEnabled: false, hasHistory: false },
    { id: 'former', label: 'Former', role: 'member', active: false, acquisitionsEnabled: true, hasHistory: true },
    { id: 'owner', label: 'Owner', role: 'owner', active: true, acquisitionsEnabled: false, hasHistory: false },
  ],
};

describe('My Leads page access', () => {
  it('allows active acquisitions members but not other members', () => {
    expect(canViewMyLeads(roster, 'acquisitions', false)).toBe(true);
    expect(canViewMyLeads(roster, 'other', false)).toBe(false);
    expect(canViewMyLeads(roster, 'former', false)).toBe(false);
    expect(canViewMyLeads(roster, 'missing', false)).toBe(false);
  });

  it('allows owners even without an acquisitions designation', () => {
    expect(canViewMyLeads(roster, 'owner', true)).toBe(true);
    expect(canViewMyLeads({ ...roster, settings: { ...roster.settings, enabled: false } }, 'owner', true)).toBe(true);
  });

  it('hides the page when My Leads is disabled', () => {
    expect(canViewMyLeads({ ...roster, settings: { ...roster.settings, enabled: false } }, 'acquisitions', false)).toBe(false);
  });
});
