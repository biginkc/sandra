/** Server-owned reservation: disabling training must never turn its DID into a seller. */
export const HOMEOWNER_TRAINING_LABEL = "Internal training — AI homeowner";
export const HOMEOWNER_TRAINING_TIMEZONE = "America/Chicago";
const E164 = /^\+[1-9]\d{7,14}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function isHomeownerTrainingNumber(phone: string): boolean {
  const number = process.env.HOMEOWNER_TRAINING_NUMBER?.trim() ?? "";
  return E164.test(number) && phone === number;
}
export function canCallHomeownerTraining(phone: string, operatorId: string): boolean {
  const ids = (process.env.HOMEOWNER_TRAINING_OPERATOR_IDS ?? "").split(",").map((id) => id.trim());
  return process.env.HOMEOWNER_TRAINING_ENABLED === "true"
    && isHomeownerTrainingNumber(phone) && ids.length > 0
    && ids.every((id) => UUID.test(id)) && ids.includes(operatorId);
}
