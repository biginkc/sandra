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
    const result = projectProviderData({avm:{property:[{address:{oneLine:"100 Sample St"},building:{rooms:{beds:5}},secret:"DO NOT EXPOSE",owner:{mailingaddressoneline:"PRIVATE MAILING"}}],echoed_fields:{preparedBy:"PRIVATE ECHO"}},apikey:"DO NOT EXPOSE",comparables:v2(),compsStatus:"ok",compsSearch:{miles:"5",saleDateRange:"24"}});
    expect(result.facts).toEqual([{label:"ATTOM address",value:"100 Sample St"},{label:"Beds",value:"5"}]);
    expect(result.search).toBe("Within 5 miles; sales in the last 24 months");
    expect(JSON.stringify(result)).not.toMatch(/PRIVATE|DO NOT EXPOSE|apikey|echoed_fields/);
  });
  it("does not label an unrecognized success as no sales", () => {
    expect(projectProviderData({comparables:{unexpected:true},compsStatus:"ok"}).salesStatus).toBe("unmapped");
  });
});
