const CONTROL_URL = "http://127.0.0.1:4567/__inbox-fault/arm-o10";

/** Arm exactly one server-side initial queued-message read failure for O10. */
export async function armOutboxInitialReadFailure(): Promise<void> {
  const response = await fetch(process.env.INBOX_ACCEPTANCE_FAULT_PROXY_CONTROL_URL ?? CONTROL_URL, {
    method: "POST",
    headers: { "x-inbox-fault-token": process.env.INBOX_ACCEPTANCE_FAULT_PROXY_TOKEN ?? "" },
  });
  if (!response.ok) throw new Error(`Could not arm O10 fault proxy (${response.status}).`);
}

