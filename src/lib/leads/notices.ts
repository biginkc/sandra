export const LEAD_PHONE_UNVERIFIED_NOTICE = "phone_unverified";

export function leadNoticeMessage(
  notice: string | null | undefined,
): string | null {
  if (notice !== LEAD_PHONE_UNVERIFIED_NOTICE) return null;
  return "Phone saved. Sandra could not tell if it is a cell phone or landline. Normal calling and texting safety rules still apply.";
}
