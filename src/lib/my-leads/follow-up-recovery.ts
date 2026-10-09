/** Guidance after the attempt has committed; SMS recovery is a separate action. */
export function savedFollowUpGuidance(state: { status: string; obligationId?: string | null } | null) {
  const saved = "This attempt is already recorded. Do not record another attempt.";
  if (!state?.obligationId?.trim()) {
    return `${saved} No saved follow-up was confirmed. Use Text lead to check for existing work before composing a new text.`;
  }
  if (["required", "draft", "failed_not_dispatched"].includes(state.status)) {
    return `${saved} Close this dialog and use Text lead to resume the saved follow-up.`;
  }
  return `${saved} Use Text lead to review the saved follow-up and its delivery status. Sending again is not available while its status requires review.`;
}
