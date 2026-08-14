import { BookAppointmentPopover } from "@/components/appointments/book-appointment-popover";

type Props = {
  currentUserId: string;
};

/**
 * "+ New" personal-block trigger for the Calendar toolbar. Reuses
 * `BookAppointmentPopover` as-is with no `propertyId`/`contactId` — that's
 * exactly its personal-block mode (org resolved from the caller's own
 * active membership per `bookAppointment`'s org-resolution rule), so the
 * full booking form (date/time/duration/assignee/note, double-book
 * warning) works unchanged here.
 */
export function NewBlockButton({ currentUserId }: Props) {
  return (
    <BookAppointmentPopover
      currentUserId={currentUserId}
      triggerLabel="+ New"
      triggerVariant="default"
      triggerSize="sm"
    />
  );
}
