type InvitationInput = {
  propertyAddress: string;
  createdByLabel?: string | null;
  testMode: boolean;
};

function invitationText(value: string): string {
  return value.replace(/\s*[—;]\s*/g, ", ").replace(/\s+/g, " ").trim();
}

export function buildEsignInvitation(input: InvitationInput): {
  subject: string;
  message: string;
} {
  const address = invitationText(input.propertyAddress);
  const preparer = invitationText(input.createdByLabel ?? "");
  const subject = `${input.testMode ? "TEST | " : ""}BMH Group | Purchase agreement${address ? ` for ${address}` : ""}`;

  return {
    subject: Array.from(subject).slice(0, 255).join(""),
    message: [
      input.testMode ? "INTERNAL TEST. This request is not legally binding." : null,
      preparer
        ? `Prepared by ${preparer} for BMH Group.`
        : "Prepared by the BMH Group acquisitions team.",
      "Please review your purchase agreement and follow the prompts to complete your signature fields.",
      "Once everyone has signed, Dropbox Sign will email you a copy of the completed agreement.",
      "If you have questions before signing, email acquisitions@bmhgroupkc.com.",
      "Thank you,\nBMH Group",
    ].filter(Boolean).join("\n\n"),
  };
}
