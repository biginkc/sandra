import { describe, expect, it } from "vitest";
import { dealmachinePreset } from "./dealmachine";
import { detectVendor } from "./index";
import { autodetectMapping } from "../aliases";
import { validateRow } from "../validate";
import { parseDealMachineContact } from "../dealmachine-contact";
import { buildLocalPreflight } from "../preflight";
const raw = {
 internal_person_id: "person-1", person_full_name: "Pat Sample", property_address_full: "123 Main St, Nixa, MO, 65714", parcel_number_raw: "001-002",
 is_phone_1_dnc: "No", people_phone_1_type_id: "Wireless", phone_1: "4175550100",
 phone_2: "4175550101", people_phone_2_type_id: "Wireless", is_phone_2_dnc: "Yes",
 phone_3: "4175550102", people_phone_3_type_id: "Wireless", is_phone_3_dnc: "No",
 email_address_1: "pat@example.com", email_address_2: "pat2@example.com", email_address_3: "pat3@example.com", property_county: "Christian County", arbitrary_source_field: "keep me",
};
describe("DealMachine person export", () => {
 it("detects the exact shape, validates comma-separated addresses, retains every cell and every row", () => {
  expect(detectVendor(Object.keys(raw), [raw])?.id).toBe("dealmachine_contacts");
  const source = [raw, {...raw, internal_person_id:"person-2", person_full_name:"Another Person"}];
  const transformed = dealmachinePreset.transform(source, Object.keys(raw));
  expect(transformed.rows).toHaveLength(2);
  const mapping = autodetectMapping(transformed.headers);
  for (let i=0;i<2;i++) {
   expect(JSON.parse(transformed.rows[i]["DealMachine Source Row"])).toEqual(source[i]);
   const result = validateRow(transformed.rows[i],mapping,i);
   expect(result.errors).toEqual([]);
   expect(result.normalized.address).toBe("123 Main St");
   expect(result.normalized.apn).toBeTruthy();
  }
  expect(buildLocalPreflight(transformed.rows,mapping).preflight.ready).toBe(2);
  expect(buildLocalPreflight(transformed.rows,mapping).preflight.noUsableContact).toBe(0);
 });
 it("keeps all phones and emails and respects a DNC flag in any populated slot", () => {
  const person=parseDealMachineContact(JSON.stringify(raw))!;
  expect(person.contact.phone_3).toBe("+14175550102");
  expect(person.contact.do_not_contact).toBe(true);
  expect(person.row.email_address_3).toBe("pat3@example.com");
  expect(parseDealMachineContact(JSON.stringify({...raw,is_phone_2_dnc:"No"}))?.contact.do_not_contact).toBe(false);
 });
 it("rejects unknown DNC flags instead of treating them as eligible", () => {
  expect(() => parseDealMachineContact(JSON.stringify({...raw,is_phone_1_dnc:"uncertain"}))).toThrow(/unrecognized DNC/);
 });
 it("rejects malformed source identities and addresses before ingest",()=>{
  const transformed=dealmachinePreset.transform([{...raw,internal_person_id:"",property_address_full:"bad address"}],Object.keys(raw));
  expect(validateRow(transformed.rows[0],autodetectMapping(transformed.headers),0).ok).toBe(false);
 });
});
