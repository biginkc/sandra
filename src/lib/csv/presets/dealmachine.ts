import { parseFullAddress } from "../normalize";
import type { VendorPreset } from "./types";
const signature = ["internal_person_id", "person_full_name", "property_address_full", "parcel_number_raw", "is_phone_1_dnc", "people_phone_1_type_id"];
export const dealmachinePreset: VendorPreset = {
  id: "dealmachine_contacts", label: "DealMachine Person Contacts",
  description: "One person per property row, with all phones, emails and source metadata preserved.",
  importable: true, version: 1,
  detect(headers) {
    return signature.every((h) => headers.includes(h)) ? { id: "dealmachine_contacts", confidence: 1, reasons: ["DealMachine person ID, full name, parcel and per-phone DNC headers"] } : null;
  },
  transform(rows, headers) {
    const outputHeaders = ["Address", "City", "State", "ZIP", "County", "APN", "Latitude", "Longitude", "DealMachine Person ID", "DealMachine Source Row"];
    return {
      headers: outputHeaders,
      rows: rows.map((row) => {
        const full = (row.property_address_full ?? "").replace(/,\s*([A-Za-z]{2})\s*,\s*(\d{5}(?:-\d{4})?)\s*$/, ", $1 $2");
        const address = parseFullAddress(full);
        return {
          Address: address?.address ?? "", City: address?.city ?? "", State: address?.state ?? "", ZIP: address?.zip ?? "",
          County: row.property_county ?? "", APN: row.parcel_number_raw ?? "", Latitude: row.latitude ?? "", Longitude: row.longitude ?? "",
          "DealMachine Person ID": row.internal_person_id ?? "", "DealMachine Source Row": JSON.stringify(row),
        };
      }),
      stats: { rowsIn: rows.length, rowsOut: rows.length, rowsCollapsedDup: 0, columnsAdded: outputHeaders, columnsRemoved: [...headers],
        notes: ["All original columns are retained in DealMachine Source Row.", "Each source person is linked independently to the property; no first-contact selection or row deduplication.", "Source DNC flags are retained and exclude the contact from SMS."] },
      suggestions: { sourceSuggestion: "dealmachine" },
    };
  },
};
