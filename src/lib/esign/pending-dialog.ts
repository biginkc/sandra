export type DialogCloseEventDetails = Readonly<{
  cancel(): void;
}>;

export function cancelPendingDialogClose(
  nextOpen: boolean,
  pending: boolean,
  eventDetails: DialogCloseEventDetails,
): boolean {
  if (nextOpen || !pending) return false;
  eventDetails.cancel();
  return true;
}
