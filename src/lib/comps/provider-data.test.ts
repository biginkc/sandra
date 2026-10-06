import { describe, expect, it } from "vitest";
import { attomSourceSales, projectProviderData } from "./provider-data";
import { mapComparables } from "./providers/attom";

export const v2 = (price = "0.00") => ({RESPONSE_GROUP:{RESPONSE:{RESPONSE_DATA:{PROPERTY_INFORMATION_RESPONSE_ext:{SUBJECT_PROPERTY_ext:{PROPERTY:[
  {SALES_HISTORY:{"@PropertySalesAmount":"95625","@PropertySalesDate":"2006-11-13"},"@_StreetAddress":"SUBJECT MUST NOT BE A COMP"},
  {COMPARABLE_PROPERTY_ext:{"@_StreetAddress":"626 Sample Ave","@_City":"Kansas City","@_State":"MO","@_PostalCode":"64125","@DistanceFromSubjectPropertyMilesCount":"0.36447548464",SALES_HISTORY:{"@TransferDate_ext":"2025-10-21T00:00:00","@PropertySalesAmount":price},STRUCTURE:{"@TotalBathroomCount":"1.50","@TotalBedroomCount":"2","@GrossLivingAreaSquareFeetCount":"1200",STRUCTURE_ANALYSIS:{"@PropertyStructureBuiltYear":"1962"}},_IDENTIFICATION:{"@RTPropertyID_ext":"48310626"}}},
]}}}}}});

describe("live ATTOM V2 response shape (synthetic values)", () => {
  it("keeps undisclosed-price source sales visible without making them priced comps", () => {
    expect(attomSourceSales(v2())).toEqual([expect.objectContaining({address:"626 Sample Ave, Kansas City, MO 64125",saleDate:"2025-10-21",salePrice:null,beds:2,baths:1.5,sqft:1200,yearBuilt:1962,providerId:"48310626"})]);
    expect(mapComparables(v2())).toEqual([]);
  });
  it("maps disclosed V2 prices and never includes the subject's old sale", () => {
    expect(mapComparables(v2("123456"))).toEqual([expect.objectContaining({salePrice:123456})]);
  });
  it("identifies MinimumCompsNotMet from a live HTTP 206 shape", () => {
    const body = {RESPONSE_GROUP:{RESPONSE:{RESPONSE_DATA:{PROPERTY_INFORMATION_RESPONSE_ext:{SUBJECT_PROPERTY_ext:{PROPERTY:[{PRODUCT_INFO_ext:{STATUS:{"@_Condition":"MinimumCompsNotMet"}}}]}}}}}};
    expect(projectProviderData({comparables:body,compsStatus:"http_206"}).salesStatus).toBe("minimum_not_met");
  });
  it("projects only allowlisted fields, never secrets, echoed fields, or raw payloads", () => {
    const result = projectProviderData({avm:{property:[{address:{oneLine:"100 Sample St"},building:{rooms:{beds:5}},secret:"DO NOT EXPOSE",owner:{unlistedPrivateField:"PRIVATE MAILING"}}],echoed_fields:{preparedBy:"PRIVATE ECHO"}},apikey:"DO NOT EXPOSE",comparables:v2(),compsStatus:"ok",compsSearch:{miles:"5",saleDateRange:"24"}});
    expect(result.facts).toEqual([{label:"ATTOM address",value:"100 Sample St"},{label:"Beds",value:"5"}]);
    expect(result.search).toBe("Within 5 miles; sales in the last 24 months");
    expect(JSON.stringify(result)).not.toMatch(/PRIVATE|DO NOT EXPOSE|apikey|echoed_fields/);
  });
  it("extracts useful subject fields and source report features from existing raw data", () => {
    const body = v2();
    const subject = body.RESPONSE_GROUP.RESPONSE.RESPONSE_DATA.PROPERTY_INFORMATION_RESPONSE_ext.SUBJECT_PROPERTY_ext.PROPERTY[0];
    Object.assign(subject, {"@PropertyParcelID":"123", SITE:{"@PropertyZoningCategoryType":"Residential"}, STRUCTURE:{CAR_STORAGE:{CAR_STORAGE_LOCATION:{"@_ParkingSpacesCount":"2"}}, EXTERIOR_FEATURE:[{"@_TypeOtherDescription":"RoofMaterial","@_Description":"Recorded roof"}]}});
    const data = projectProviderData({avm:{property:[{owner:{mailingaddressoneline:"99 Sample Ave"},summary:{absenteeInd:"ABSENTEE"},lot:{depth:130,frontage:85,lotsize1:0.253},sale:{mortgage:{FirstConcurrent:{amount:76500}}},building:{interior:{bsmtsize:1036}},utilities:{walltype:"RECORDED MATERIAL"}}]},comparables:body});
    expect(data.facts).toEqual(expect.arrayContaining([
      {label:"Owner mailing address",value:"99 Sample Ave"}, {label:"Absentee-owner indicator",value:"ABSENTEE"},
      {label:"Recorded first mortgage amount",value:"76500"}, {label:"Basement area (sq ft)",value:"1036"},
      {label:"Parking spaces",value:"2"}, {label:"Recorded roof material",value:"Recorded roof"},
    ]));
  });
  it("extracts source-only sale financing and ownership without treating loans as sale prices", () => {
    const body = v2();
    const sale = body.RESPONSE_GROUP.RESPONSE.RESPONSE_DATA.PROPERTY_INFORMATION_RESPONSE_ext.SUBJECT_PROPERTY_ext.PROPERTY[1].COMPARABLE_PROPERTY_ext;
    Object.assign(sale!, {_OWNER:{"@_Name":"Sample owner"}, MAILING_ADDRESS_ext:{"@_StreetAddress":"99 Sample St","@_City":"Sample City"}});
    Object.assign(sale!.SALES_HISTORY, {"@BuyerUnparsedName_ext":"Sample buyer",LOANS_ext:{LOAN_ext:[{"@_Type":"First","@_Amount":"130950","@TrustDeedDocumentNumber":"D123"},{"@_Type":"Second","@_Amount":"0"}]}});
    const rows = attomSourceSales(body);
    expect(rows[0].details).toEqual(expect.arrayContaining([
      {label:"Recorded loan (First)",value:"130950",format:"currency"}, {label:"Loan document (First)",value:"D123"},
      {label:"Owner of record",value:"Sample owner"}, {label:"Buyer",value:"Sample buyer"},
      {label:"Owner mailing address",value:"99 Sample St, Sample City"},
    ]));
    expect(JSON.stringify(rows[0].details)).not.toContain("Second");
    expect(mapComparables(body)).toEqual([]);
    sale!.SALES_HISTORY["@PropertySalesAmount"] = "123456";
    expect(mapComparables(body)[0]).not.toHaveProperty("details");
  });
  it("does not label an unrecognized success as no sales", () => {
    expect(projectProviderData({comparables:{unexpected:true},compsStatus:"ok"}).salesStatus).toBe("unmapped");
  });
});
