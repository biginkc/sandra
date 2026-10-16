// H2: queue rows skip the precall SMS by default (build default; open question for Jarrad).
// Button rows keep today's behaviour: attempt 1 texts when the feature is enabled.
export function shouldSendNormaPrecallSms(input: {
  queueEntryId: string | null | undefined;
  attempt: number;
  precallEnabled: boolean;
}): boolean {
  if (input.queueEntryId) return false;
  return input.precallEnabled && input.attempt === 1;
}
