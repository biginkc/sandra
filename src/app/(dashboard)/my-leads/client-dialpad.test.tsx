import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  openLead: vi.fn(),
  loadMyLeads: vi.fn(),
  loadMyLeadCallReferences: vi.fn(),
  targets: vi.fn(),
  recent: vi.fn(),
}));

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock('@/components/softphone/softphone-provider', () => ({
  useOptionalSoftphone: () => ({ callingEnabled: true, openLead: mocks.openLead }),
}));
vi.mock('@/components/appointments/book-appointment-popover', () => ({ BookAppointmentPopover: () => null }));
vi.mock('./actions', () => ({
  loadMyLeads: mocks.loadMyLeads,
  loadMyLeadsStage: vi.fn(),
  loadMyLeadDetail: vi.fn(),
  loadMyLeadCallReferences: mocks.loadMyLeadCallReferences,
  submitMyLeadCommand: vi.fn(),
  changeAcquisitionDesignation: vi.fn(),
  changeAcquisitionSettings: vi.fn(),
}));
vi.mock('./dialpad-actions', () => ({
  verifyDialpadBindingAction: vi.fn(),
  listDialpadCallTargetsAction: mocks.targets,
  startDialpadCallAction: vi.fn(),
  getDialpadCallStatusAction: vi.fn(),
  cancelDialpadCallAction: vi.fn(),
  listRecentDialpadCallsAction: mocks.recent,
}));
vi.mock('./_components/attempt-dialog', () => ({
  AcquisitionAttemptDialog: ({ propertyId }: { propertyId: string }) => <div data-testid="attempt-dialog">{propertyId}</div>,
}));
vi.mock('./_components/queue', () => ({
  MyLeadsQueue: ({ onStageAction, stages }: { onStageAction: (kind: string, row: { propertyId: string }) => void; stages: { not_contacted?: { rows: Array<{ propertyId: string }> } } }) => (
    <button onClick={() => onStageAction('start-call', stages.not_contacted!.rows[0]!)}>Start call</button>
  ),
}));

import type { DialpadPanelBootstrap } from '@/lib/dialpad-cti/dispatch';
import type { AcquisitionKpis, AcquisitionRoster, QueueSnapshot } from '@/lib/my-leads/queries';
import { MyLeadsClient } from './client';

const bootstrap: DialpadPanelBootstrap = { connectionId: 'c1', allowedOrigins: ['https://dialpad.com'], binding: { status: 'verified', dialpadUserId: '5551234' }, grants: [] };
const roster = {
  isOwner: false,
  members: [{ id: 'rep-1', label: 'Maria', role: 'member', acquisitionsEnabled: true, active: true, hasHistory: true }],
  settings: { enabled: true, recipientId: null, revision: 1 },
} as unknown as AcquisitionRoster;
const kpis = { attempts: 0, reached: 0, pendingOutcomes: 0, firstCallSamples: 0, firstCallPending: 0, firstCallElapsedSeconds: 0, appointmentsDue: 0, appointmentsHeld: 0, orgAppointmentsUnattributed: 0, offersSent: 0, staleLeads: 0, contactWithoutFollowUp: 0, needsOffers: 0, appointmentsOverdue: 0, lastAttemptAt: null, asOf: '2026-09-29T14:00:00Z', missingRecordings: 0, recordingExpectationUnknown: 0, averageTalkSeconds: 0, talkTimeSamples: 0, talkTimeUnknown: 0, conversationsOverFiveMinutes: 0 } as unknown as AcquisitionKpis;
const snapshot = {
  stages: { not_contacted: { rows: [{
    propertyId: 'property-1', stage: 'not_contacted', queueVersion: 1, sharedStatus: 'new_lead', assignmentEpisodeId: 'episode-1', assignedAt: '2026-09-29T14:00:00.000Z',
    initializedAt: '2026-09-29T14:00:00.000Z', episodeKind: 'live', clockEligible: true, firstCallAt: null, stageEnteredAt: null, address: '106 Fixture Lane', city: 'Kansas City',
    state: 'MO', homeownerName: 'Fixture Homeowner', phone: '555-0100', contactId: 'contact-1', phones: ['555-0100'], contactDnc: false, temperature: null, motivationKind: null,
    motivationText: null, warningReasons: [], nextStepAt: null, nextStepType: null, offer: null, attemptsCount: 0,
  }], totalCount: 1, filteredCount: 1, cursor: null, hasMore: false } },
  snapshotAt: '2026-09-29T14:00:00.000Z', nextWarningAt: null, search: '',
} as unknown as QueueSnapshot;

function renderClient(dialpad: DialpadPanelBootstrap | null, viewer = { userId: 'rep-1', orgId: 'org-1', isOwner: false }, memberId = 'rep-1') {
  return render(<MyLeadsClient viewer={viewer} roster={roster} initialMemberId={memberId} initialSnapshot={snapshot} initialKpis={kpis} dialpad={dialpad} />);
}

beforeEach(() => {
  vi.resetAllMocks();
  mocks.loadMyLeadCallReferences.mockResolvedValue({ ok: true, options: [] });
  mocks.recent.mockResolvedValue({ ok: true, calls: [] });
  mocks.targets.mockResolvedValue({ ok: true, contactId: 'contact-1', phones: [{ slot: 1, masked: '••• ••• 0100' }], grants: [] });
});

describe('My Leads Dialpad wiring', () => {
  it('routes Start call through the Dialpad panel when a usable connection exists', async () => {
    renderClient(bootstrap);
    expect(screen.getByRole('region', { name: 'Dialpad' })).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Start call' }));
    expect(await screen.findByRole('group', { name: 'Start a Dialpad call' })).toHaveTextContent('Fixture Homeowner');
    expect(mocks.targets).toHaveBeenCalledWith({ propertyId: 'property-1', contactId: 'contact-1' });
    expect(mocks.openLead).not.toHaveBeenCalled();
  });
  it('keeps the existing softphone flow, and no panel, without a Dialpad connection', async () => {
    renderClient(null);
    expect(screen.queryByRole('region', { name: 'Dialpad' })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Start call' }));
    expect(mocks.openLead).toHaveBeenCalledTimes(1);
    expect(mocks.targets).not.toHaveBeenCalled();
  });
  it('does not dial from another rep\'s queue', async () => {
    renderClient(bootstrap, { userId: 'owner-1', orgId: 'org-1', isOwner: true }, 'rep-1');
    await userEvent.click(screen.getByRole('button', { name: 'Start call' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Open your own queue');
    expect(mocks.targets).not.toHaveBeenCalled();
    expect(mocks.openLead).not.toHaveBeenCalled();
  });
  it('opens the existing log-attempt dialog for an ended Dialpad call', async () => {
    mocks.recent.mockResolvedValue({ ok: true, calls: [{
      intentId: '66666666-6666-4666-8666-666666666666', state: 'ended', propertyId: 'property-1', expiresAt: 'x', dispatchAuthorizedAt: 'x', callActivityId: 'a', attemptId: 'b',
      startedAt: null, endedAt: 'x', durationSeconds: 30, talkDurationSeconds: 20,
    }] });
    renderClient(bootstrap);
    await userEvent.click(await screen.findByRole('button', { name: 'Log outcome' }));
    await waitFor(() => expect(screen.getByTestId('attempt-dialog')).toHaveTextContent('property-1'));
  });
});
