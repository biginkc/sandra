import type { CompSale } from "./types";

type Json = Record<string, unknown>;
const record = (v: unknown): v is Json => !!v && typeof v === "object" && !Array.isArray(v);
export const at = (o: unknown, path: string): unknown => path.split(".").reduce<unknown>((v, k) => record(v) ? v[k] : undefined, o);
const text = (v: unknown): string | null => typeof v === "string" && v.trim() ? v.trim() : typeof v === "number" && Number.isFinite(v) ? String(v) : null;
const number = (v: unknown): number | null => v !== null && v !== undefined && text(v) !== null && Number.isFinite(Number(v)) ? Number(v) : null;

export type SourceSale = Omit<CompSale, "salePrice"> & { salePrice: number | null };
export type ProviderData = {
  facts: { label: string; value: string }[];
  sales: SourceSale[];
  salesStatus: "ok" | "minimum_not_met" | "not_entitled" | "none" | "unmapped" | "unavailable";
  search: string | null;
};

/** Only actual comparable nodes, never the subject property's own historical sale. */
export function attomSourceSales(body: unknown): SourceSale[] {
  const properties = at(body, "RESPONSE_GROUP.RESPONSE.RESPONSE_DATA.PROPERTY_INFORMATION_RESPONSE_ext.SUBJECT_PROPERTY_ext.PROPERTY");
  const rows = Array.isArray(properties) ? properties : record(properties) ? [properties] : [];
  return rows.flatMap((row): SourceSale[] => {
    const node = at(row, "COMPARABLE_PROPERTY_ext");
    const candidates = Array.isArray(node) ? node : record(node) ? [node] : [];
    return candidates.flatMap((c): SourceSale[] => {
      const street = text(at(c, "@_StreetAddress"));
      const date = text(at(c, "SALES_HISTORY.@TransferDate_ext")) ?? text(at(c, "SALES_HISTORY.@PropertySalesDate"));
      if (!street || !date || !/^\d{4}-\d{2}-\d{2}/.test(date)) return [];
      const price = number(at(c, "SALES_HISTORY.@PropertySalesAmount"));
      return [{
        address: [street, text(at(c, "@_City")), [text(at(c, "@_State")), text(at(c, "@_PostalCode"))].filter(Boolean).join(" ")].filter(Boolean).join(", "),
        saleDate: date.slice(0, 10), salePrice: price !== null && price > 0 ? price : null,
        sqft: number(at(c, "STRUCTURE.@GrossLivingAreaSquareFeetCount")),
        beds: number(at(c, "STRUCTURE.@TotalBedroomCount")), baths: number(at(c, "STRUCTURE.@TotalBathroomCount")),
        yearBuilt: number(at(c, "STRUCTURE.STRUCTURE_ANALYSIS.@PropertyStructureBuiltYear")),
        distanceMiles: number(at(c, "@DistanceFromSubjectPropertyMilesCount")),
        providerId: text(at(c, "_IDENTIFICATION.@RTPropertyID_ext")), renovatedHint: null,
      }];
    });
  });
}

export function attomSalesStatus(body: unknown, status: unknown, saleCount: number): ProviderData["salesStatus"] {
  const properties = at(body, "RESPONSE_GROUP.RESPONSE.RESPONSE_DATA.PROPERTY_INFORMATION_RESPONSE_ext.SUBJECT_PROPERTY_ext.PROPERTY");
  const rows = Array.isArray(properties) ? properties : [properties];
  if (rows.some((r) => at(r, "PRODUCT_INFO_ext.STATUS.@_Condition") === "MinimumCompsNotMet")) return "minimum_not_met";
  if (status === "not_entitled") return "not_entitled";
  if (status === "none") return "none";
  if (status === "ok") return saleCount > 0 ? "ok" : "unmapped";
  return "unavailable";
}

const FIELDS = [
  ["ATTOM address", "address.oneLine"], ["ATTOM property ID", "identifier.attomId"], ["Parcel (APN)", "identifier.apn"],
  ["County FIPS", "identifier.fips"], ["Property type", "summary.propertyType"], ["Year built", "summary.yearbuilt"],
  ["Beds", "building.rooms.beds"], ["Baths", "building.rooms.bathstotal"], ["Living area (sq ft)", "building.size.universalsize"],
  ["Lot area (sq ft)", "lot.lotsize2"], ["Latitude", "location.latitude"], ["Longitude", "location.longitude"],
  ["AVM date", "avm.eventDate"], ["AVM score", "avm.amount.scr"], ["AVM uncertainty (%)", "avm.amount.fsd"],
  ["Last recorded sale date", "sale.amount.salerecdate"], ["Last recorded sale amount", "sale.amount.saleamt"],
  ["Assessed value", "assessment.assessed.assdttlvalue"], ["Assessor market value", "assessment.market.mktttlvalue"],
  ["Cooling", "utilities.coolingtype"], ["Heating", "utilities.heatingtype"], ["Parking", "building.parking.prkgType"],
  ["Source last modified", "vintage.lastModified"],
] as const;

/** Explicit allowlist: never return raw vendor payloads, echoed fields, or credentials to clients. */
export function projectProviderData(raw: unknown): ProviderData {
  const props = at(raw, "avm.property");
  const property = Array.isArray(props) ? props[0] : null;
  const sales = attomSourceSales(at(raw, "comparables"));
  const criteria = at(raw, "compsSearch");
  const miles = number(at(criteria, "miles")), months = number(at(criteria, "saleDateRange"));
  return {
    facts: FIELDS.flatMap(([label, path]) => { const value = text(at(property, path)); return value === null ? [] : [{label,value}]; }),
    sales,
    salesStatus: attomSalesStatus(at(raw, "comparables"), at(raw, "compsStatus"), sales.length),
    search: miles !== null && months !== null ? `Within ${miles} miles; sales in the last ${months} months` : null,
  };
}
