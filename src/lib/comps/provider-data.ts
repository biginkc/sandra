import type { CompSale } from "./types";

type Json = Record<string, unknown>;
const record = (v: unknown): v is Json => !!v && typeof v === "object" && !Array.isArray(v);
export const at = (o: unknown, path: string): unknown => path.split(".").reduce<unknown>((v, k) => record(v) ? v[k] : undefined, o);
const text = (v: unknown): string | null => typeof v === "string" && v.trim() ? v.trim() : typeof v === "number" && Number.isFinite(v) ? String(v) : null;
const number = (v: unknown): number | null => v !== null && v !== undefined && text(v) !== null && Number.isFinite(Number(v)) ? Number(v) : null;

export type ProviderFact = { label: string; value: string; format?: "currency" };
export type SourceSale = Omit<CompSale, "salePrice"> & { salePrice: number | null; details?: ProviderFact[] };
export type ProviderData = {
  facts: ProviderFact[];
  sales: SourceSale[];
  salesStatus: "ok" | "minimum_not_met" | "not_entitled" | "none" | "unmapped" | "unavailable";
  search: string | null;
};

function factsFrom(source: unknown, fields: readonly (readonly [string, string])[]): ProviderFact[] {
  return fields.flatMap(([label, path]) => {
    const value = text(at(source, path));
    return value === null ? [] : [{label, value}];
  });
}

/** Zero loan amounts are missing financing data, not evidence of a zero balance. */
function loanFacts(source: unknown): ProviderFact[] {
  const loans = at(source, "SALES_HISTORY.LOANS_ext.LOAN_ext");
  const rows = Array.isArray(loans) ? loans : record(loans) ? [loans] : [];
  return rows.flatMap((loan, i): ProviderFact[] => {
    const amount = number(at(loan, "@_Amount"));
    if (amount === null || amount <= 0) return [];
    const type = text(at(loan, "@_Type")) ?? String(i + 1);
    const document = text(at(loan, "@TrustDeedDocumentNumber"));
    return [{label: `Recorded loan (${type})`, value: String(amount), format: "currency"},
      ...(document ? [{label: `Loan document (${type})`, value: document}] : [])];
  });
}

const SALE_DETAIL_FIELDS = [
  ["Owner of record", "_OWNER.@_Name"], ["Secondary owner", "_OWNER.@_SecondaryOwnerName_ext"],
  ["Buyer", "SALES_HISTORY.@BuyerUnparsedName_ext"], ["Seller", "SALES_HISTORY.@SellerUnparsedName"],
  ["Recorded sale document", "SALES_HISTORY.@RecordedDocumentIdentifier"],
  ["ATTOM arm’s-length transaction code", "SALES_HISTORY.@ArmsLengthTransactionIndicatorExt"],
  ["ATTOM multiple-parcel indicator", "SALES_HISTORY.@MultipleApnIndicator_ext"],
  ["Property use", "@StandardUseDescription_ext"], ["Lot area (sq ft)", "SITE.@LotSquareFeetCount"],
  ["Lot depth (ft)", "SITE.@DepthFeetCount"], ["Lot width (ft)", "SITE.@WidthFeetCount"],
  ["Stories", "STRUCTURE.@StoriesCount"], ["Living units", "STRUCTURE.@LivingUnitCount"],
  ["Basement area (sq ft)", "STRUCTURE.BASEMENT.@SquareFeetCount"],
  ["Basement finished (%)", "STRUCTURE.BASEMENT.@_FinishedPercent"],
  ["Parking area (sq ft)", "STRUCTURE.CAR_STORAGE.CAR_STORAGE_LOCATION.@SquareFeetCount"],
  ["Parking spaces", "STRUCTURE.CAR_STORAGE.CAR_STORAGE_LOCATION.@_ParkingSpacesCount"],
  ["Parking type", "STRUCTURE.CAR_STORAGE.CAR_STORAGE_LOCATION.@_TypeOtherDescription"],
  ["Cooling", "STRUCTURE.COOLING.@_UnitDescription"], ["Heating", "STRUCTURE.HEATING.@_UnitDescription"],
  ["Recorded exterior material", "STRUCTURE.EXTERIOR_FEATURE.@_Description"],
  ["Assessed value", "_TAX.@_TotalAssessedValueAmount"], ["Assessor market value", "_TAX.@_AssessorMarketValue_ext"],
  ["Legal description", "_LEGAL_DESCRIPTION.@_TextDescription"],
  ["Latitude", "@LatitudeNumber"], ["Longitude", "@LongitudeNumber"],
] as const;

function mailingFact(source: unknown): ProviderFact[] {
  const address = [text(at(source, "MAILING_ADDRESS_ext.@_StreetAddress")), text(at(source, "MAILING_ADDRESS_ext.@_City")),
    [text(at(source, "MAILING_ADDRESS_ext.@_State")), text(at(source, "MAILING_ADDRESS_ext.@_PostalCode"))].filter(Boolean).join(" ")].filter(Boolean).join(", ");
  return address ? [{label: "Owner mailing address", value: address}] : [];
}

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
        details: [...factsFrom(c, SALE_DETAIL_FIELDS), ...mailingFact(c), ...loanFacts(c)],
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
  ["Lot area (sq ft)", "lot.lotsize2"], ["Lot area (acres)", "lot.lotsize1"],
  ["Lot depth (ft)", "lot.depth"], ["Lot frontage (ft)", "lot.frontage"], ["County", "area.countrysecsubd"],
  ["Absentee-owner indicator", "summary.absenteeInd"], ["Owner mailing address", "owner.mailingaddressoneline"],
  ["Corporate owner indicator", "owner.corporateindicator"], ["Latitude", "location.latitude"], ["Longitude", "location.longitude"],
  ["AVM date", "avm.eventDate"], ["AVM score", "avm.amount.scr"], ["AVM uncertainty (%)", "avm.amount.fsd"],
  ["Last recorded sale date", "sale.amount.salerecdate"], ["Last recorded sale amount", "sale.amount.saleamt"],
  ["Assessed value", "assessment.assessed.assdttlvalue"], ["Assessor market value", "assessment.market.mktttlvalue"],
  ["Sale transfer date", "sale.saleTransDate"], ["Sale document type", "sale.amount.saledoctype"],
  ["Recorded sale document", "sale.amount.saledocnum"], ["Sale transaction type", "sale.amount.saletranstype"],
  ["Recorded first mortgage amount", "sale.mortgage.FirstConcurrent.amount"],
  ["Mortgage document", "sale.mortgage.FirstConcurrent.trustDeedDocumentNumber"],
  ["Basement area (sq ft)", "building.interior.bsmtsize"], ["Fireplaces", "building.interior.fplccount"],
  ["Stories", "building.summary.levels"], ["Living units", "building.summary.unitsCount"],
  ["Gross building area (sq ft)", "building.size.grosssize"], ["Parking area (sq ft)", "building.parking.prkgSize"],
  ["Heating fuel", "utilities.heatingfuel"], ["Recorded wall material", "utilities.walltype"],
  ["Cooling", "utilities.coolingtype"], ["Heating", "utilities.heatingtype"], ["Parking", "building.parking.prkgType"],
  ["Source last modified", "vintage.lastModified"],
] as const;

function subjectReportFacts(raw: unknown): ProviderFact[] {
  const properties = at(raw, "comparables.RESPONSE_GROUP.RESPONSE.RESPONSE_DATA.PROPERTY_INFORMATION_RESPONSE_ext.SUBJECT_PROPERTY_ext.PROPERTY");
  const rows = Array.isArray(properties) ? properties : record(properties) ? [properties] : [];
  const subject = rows.find((row) => text(at(row, "@PropertyParcelID")) !== null && !at(row, "COMPARABLE_PROPERTY_ext"));
  const exterior = at(subject, "STRUCTURE.EXTERIOR_FEATURE");
  const materials = Array.isArray(exterior) ? exterior : record(exterior) ? [exterior] : [];
  return [...factsFrom(subject, [
    ["Recorded zoning category", "SITE.@PropertyZoningCategoryType"],
    ["Parking spaces", "STRUCTURE.CAR_STORAGE.CAR_STORAGE_LOCATION.@_ParkingSpacesCount"],
  ]), ...materials.flatMap((material): ProviderFact[] => {
    const value = text(at(material, "@_Description"));
    const kind = text(at(material, "@_TypeOtherDescription"));
    return value ? [{label: kind === "RoofMaterial" ? "Recorded roof material" : `Recorded exterior material${kind ? ` (${kind})` : ""}`, value}] : [];
  })];
}

/** Explicit allowlist: never return raw vendor payloads, echoed fields, or credentials to clients. */
export function projectProviderData(raw: unknown): ProviderData {
  const props = at(raw, "avm.property");
  const property = Array.isArray(props) ? props[0] : null;
  const sales = attomSourceSales(at(raw, "comparables"));
  const criteria = at(raw, "compsSearch");
  const miles = number(at(criteria, "miles")), months = number(at(criteria, "saleDateRange"));
  return {
    facts: [...factsFrom(property, FIELDS), ...subjectReportFacts(raw)],
    sales,
    salesStatus: attomSalesStatus(at(raw, "comparables"), at(raw, "compsStatus"), sales.length),
    search: miles !== null && months !== null ? `Within ${miles} miles; sales in the last ${months} months` : null,
  };
}
