import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { DialpadMemberAssignment } from './dialpad-member-assignment';
const mocks = vi.hoisted(() => ({ load: vi.fn(), save: vi.fn() }));
vi.mock('@/lib/dialpad-voice/configuration', () => ({
  loadDialpadMemberCallerOptions: mocks.load,
  saveDialpadMemberCallerAssignment: mocks.save,
}));
const personal = { identity_type: 'user', provider_identity_id: '101', number_e164: '+12025550101' };
const office = { identity_type: 'office', provider_identity_id: '202', number_e164: '+12025550101' };
const options = { ok: true, connectionVersion: 4, bindingRevision: 7, providerUserId: '101', callers: [personal, office], selectedCallers: [office] };
beforeEach(() => { vi.resetAllMocks(); mocks.load.mockResolvedValue(options); mocks.save.mockResolvedValue({ ok: true, bindingRevision: 8 }); });
afterEach(cleanup);
async function load() {
  render(<DialpadMemberAssignment memberId="member-1" memberLabel="Maria" />);
  fireEvent.click(screen.getByRole('button', { name: 'Load numbers' }));
  await screen.findByRole('checkbox', { name: /Office/ });
}
it('loads server-derived identities and preserves the exact existing group selection despite identical numbers', async () => {
  await load();
  expect(mocks.load).toHaveBeenCalledWith({ memberId: 'member-1' });
  expect(screen.getByRole('checkbox', { name: /Office/ })).toBeChecked();
  expect(screen.getByRole('checkbox', { name: /Personal/ })).not.toBeChecked();
  fireEvent.click(screen.getByRole('button', { name: 'Save Dialpad numbers' }));
  await screen.findByText('Dialpad numbers assigned.');
  expect(mocks.save).toHaveBeenCalledWith(expect.objectContaining({ memberId: 'member-1', providerUserId: '101', connectionVersion: 4, expectedBindingRevision: 7, selectedCallers: [office], requestId: expect.any(String) }));
  expect(screen.queryByText(/ready to call|calling is ready|desktop connected/i)).not.toBeInTheDocument();
});
it.each(['rejected', 'exception'])('freezes an unconfirmed %s save and retries the exact same command', async (kind) => {
  if (kind === 'exception') mocks.save.mockRejectedValueOnce(new Error('network'));
  else mocks.save.mockResolvedValueOnce({ ok: false });
  await load();
  fireEvent.click(screen.getByRole('checkbox', { name: /Personal/ }));
  fireEvent.click(screen.getByRole('button', { name: 'Save Dialpad numbers' }));
  await screen.findByText(/save was not confirmed/);
  for (const checkbox of screen.getAllByRole('checkbox')) expect(checkbox).toBeDisabled();
  const command = mocks.save.mock.calls[0][0];
  expect(command.selectedCallers).toEqual([personal, office]);
  fireEvent.click(screen.getByRole('button', { name: 'Retry saving' }));
  await screen.findByText('Dialpad numbers assigned.');
  expect(mocks.save.mock.calls[1][0]).toEqual(command);
  for (const checkbox of screen.getAllByRole('checkbox')) expect(checkbox).toBeEnabled();
});
it('reloads authoritative state to clear uncertainty and uses its revision for a new save', async () => {
  mocks.save.mockResolvedValueOnce({ ok: false });
  await load();
  fireEvent.click(screen.getByRole('button', { name: 'Save Dialpad numbers' }));
  await screen.findByText(/save was not confirmed/);
  const oldRequest = mocks.save.mock.calls[0][0].requestId;
  mocks.load.mockResolvedValueOnce({ ...options, bindingRevision: 9, selectedCallers: [personal] });
  fireEvent.click(screen.getByRole('button', { name: 'Reload assignments' }));
  await waitFor(() => expect(screen.getByRole('checkbox', { name: /Personal/ })).toBeEnabled());
  expect(screen.getByRole('checkbox', { name: /Personal/ })).toBeChecked();
  expect(screen.getByRole('checkbox', { name: /Office/ })).not.toBeChecked();
  fireEvent.click(screen.getByRole('button', { name: 'Save Dialpad numbers' }));
  await screen.findByText('Dialpad numbers assigned.');
  expect(mocks.save.mock.calls[1][0]).toMatchObject({ expectedBindingRevision: 9, selectedCallers: [personal] });
  expect(mocks.save.mock.calls[1][0].requestId).not.toBe(oldRequest);
});
