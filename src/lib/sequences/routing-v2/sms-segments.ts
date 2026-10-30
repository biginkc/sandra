/**
 * SMS segment math for routing v2 drip copy checks (GSM 03.38 vs UCS-2).
 * GSM-7: 160 chars in one segment, 153 per segment when concatenated; extension-table
 * characters cost 2. Anything outside GSM-7 forces UCS-2: 70 UTF-16 units in one segment,
 * 67 per segment when concatenated.
 */
const GSM7_BASIC =
  "@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !\"#¤%&'()*+,-./0123456789:;<=>?" +
  "¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà";
const GSM7_EXTENSION = "^{}\\[~]|€\f";

export type SmsEncoding = "GSM-7" | "UCS-2";
export type SegmentReport = { encoding: SmsEncoding; units: number; segments: number };

export function smsSegments(text: string): SegmentReport {
  let units = 0;
  for (const ch of text) {
    if (GSM7_BASIC.includes(ch)) units += 1;
    else if (GSM7_EXTENSION.includes(ch)) units += 2;
    else {
      const u = text.length; // UTF-16 code units
      return { encoding: "UCS-2", units: u, segments: u <= 70 ? 1 : Math.ceil(u / 67) };
    }
  }
  return { encoding: "GSM-7", units, segments: units <= 160 ? 1 : Math.ceil(units / 153) };
}
