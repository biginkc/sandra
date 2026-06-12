import { asLineType, type PhoneLineType } from "@/lib/messaging/line-type";

import { validateRow, type Mapping, type RowData } from "./validate";

/**
 * Pre-ingest line-type classification helpers, shared by the CSV-import
 * workflow (the Telnyx classification step) and the wizard (the
 * "N phone numbers have no line type" interstitial), so the count the
 * user approves is exactly the set the workflow looks up.
 *
 * Hard rule context (migration 080): a phone with no line type is never
 * saved. Classification is the operator's chance to label those numbers
 * before ingest drops them.
 */

const PHONE_SLOTS = [1, 2, 3] as const;

/** Synthetic CSV headers for type values discovered by classification
 *  when the source file had no line-type column mapped for that slot.
 *  `applyLineTypes` writes cells under these headers and extends the
 *  mapping so `validateRow` picks them up at ingest time. */
const SYNTHETIC_TYPE_HEADERS: Record<(typeof PHONE_SLOTS)[number], string> = {
  1: "__phone_1_line_type",
  2: "__phone_2_line_type",
  3: "__phone_3_line_type",
};

const AGENT_SYNTHETIC_TYPE_HEADER = "__agent_phone_line_type";

function slotPhoneAndType(
  normalized: Readonly<Record<string, unknown>>,
  slot: (typeof PHONE_SLOTS)[number],
): { phone: string | null; type: PhoneLineType } {
  const phone = (normalized[`homeowner_phone_${slot}`] as string | null) ?? null;
  const type = asLineType(
    normalized[`homeowner_phone_${slot}_type`] as string | null,
  );
  return { phone, type };
}

function agentPhoneAndType(
  normalized: Readonly<Record<string, unknown>>,
): { phone: string | null; type: PhoneLineType } {
  const phone = (normalized.agent_phone as string | null) ?? null;
  const type = asLineType(normalized.agent_phone_type as string | null);
  return { phone, type };
}

/**
 * Collect the distinct E.164 phone numbers that would ingest with type
 * 'unknown' — i.e. the numbers the hard rule would drop. Only rows that
 * pass validation count (invalid rows never reach ingest, so their
 * phones don't deserve a paid lookup).
 */
export function collectUnlabeledPhones(
  rows: readonly RowData[],
  mapping: Mapping,
): string[] {
  const numbers = new Set<string>();
  for (let i = 0; i < rows.length; i++) {
    const validated = validateRow(rows[i], mapping, i);
    if (!validated.ok) continue;
    for (const slot of PHONE_SLOTS) {
      const { phone, type } = slotPhoneAndType(validated.normalized, slot);
      if (phone && type === "unknown") numbers.add(phone);
    }
    const agent = agentPhoneAndType(validated.normalized);
    if (agent.phone && agent.type === "unknown") numbers.add(agent.phone);
  }
  return [...numbers];
}

export type ApplyLineTypesResult = {
  rows: RowData[];
  mapping: Mapping;
  /** Slots (phone occurrences, not distinct numbers) that received a
   *  type from classification. */
  labeledSlots: number;
};

/**
 * Write classified types back into the rows so ingest sees them. For
 * each unlabeled phone slot whose number classified as mobile/landline,
 * the type lands in the row — under the already-mapped type column when
 * one exists, otherwise under a synthetic header that gets added to the
 * mapping. Slots whose number stayed 'unknown' are left untouched (the
 * ingest hard rule drops + counts them).
 *
 * Pure: returns fresh rows/mapping, never mutates the inputs.
 */
export function applyLineTypes(
  rows: readonly RowData[],
  mapping: Mapping,
  classified: ReadonlyMap<string, PhoneLineType>,
): ApplyLineTypesResult {
  const outMapping: Record<string, string | null> = { ...mapping };
  let labeledSlots = 0;

  const outRows = rows.map((row, i) => {
    const validated = validateRow(row, mapping, i);
    if (!validated.ok) return row;

    let patched: Record<string, string | null | undefined> | null = null;
    for (const slot of PHONE_SLOTS) {
      const { phone, type } = slotPhoneAndType(validated.normalized, slot);
      if (!phone || type !== "unknown") continue;
      const found = classified.get(phone);
      if (found !== "mobile" && found !== "landline") continue;

      const header =
        outMapping[`homeowner_phone_${slot}_type`] ??
        SYNTHETIC_TYPE_HEADERS[slot];
      outMapping[`homeowner_phone_${slot}_type`] = header;
      patched = patched ?? { ...row };
      patched[header] = found;
      labeledSlots++;
    }
    const agent = agentPhoneAndType(validated.normalized);
    if (agent.phone && agent.type === "unknown") {
      const found = classified.get(agent.phone);
      if (found === "mobile" || found === "landline") {
        const header =
          outMapping.agent_phone_type ?? AGENT_SYNTHETIC_TYPE_HEADER;
        outMapping.agent_phone_type = header;
        patched = patched ?? { ...row };
        patched[header] = found;
        labeledSlots++;
      }
    }
    return patched ?? row;
  });

  return { rows: outRows, mapping: outMapping, labeledSlots };
}

export type ClassificationCounts = {
  classifiedMobile: number;
  classifiedLandline: number;
  stillUnknown: number;
  estimatedCostUsd: number;
};

/** Summarize a classification run for the job's result summary. */
export function summarizeClassification(
  classified: ReadonlyMap<string, PhoneLineType>,
  costPerLookupUsd: number,
): ClassificationCounts {
  let classifiedMobile = 0;
  let classifiedLandline = 0;
  let stillUnknown = 0;
  for (const type of classified.values()) {
    if (type === "mobile") classifiedMobile++;
    else if (type === "landline") classifiedLandline++;
    else stillUnknown++;
  }
  return {
    classifiedMobile,
    classifiedLandline,
    stillUnknown,
    // Round to whole cents — float noise like 0.009000000000000001
    // shouldn't land in the job record.
    estimatedCostUsd:
      Math.round(classified.size * costPerLookupUsd * 100) / 100,
  };
}
