import { describe, expect, it } from "vitest";

import {
  classifySmsPhoneAvailability,
  selectBestSmsPhone,
  type SmsPhoneContact,
} from "./sms-phone";

function contact(overrides: Partial<SmsPhoneContact>): SmsPhoneContact {
  return {
    phone_1: null,
    phone_1_type: "unknown",
    phone_2: null,
    phone_2_type: "unknown",
    phone_3: null,
    phone_3_type: "unknown",
    ...overrides,
  };
}

describe("sms phone selection", () => {
  it("prefers a mobile in a later slot over an earlier landline", () => {
    const choice = selectBestSmsPhone(
      contact({
        phone_1: "+18165550001",
        phone_1_type: "landline",
        phone_2: "+18165550002",
        phone_2_type: "mobile",
      }),
    );

    expect(choice).toEqual({
      phone: "+18165550002",
      lineType: "mobile",
      slot: 2,
    });
  });

  it("classifies unknown when there is a phone but no mobile", () => {
    expect(
      classifySmsPhoneAvailability(
        contact({
          phone_1: "+18165550001",
          phone_1_type: "landline",
          phone_3: "+18165550003",
          phone_3_type: "unknown",
        }),
      ),
    ).toBe("unknown");
  });

  it("classifies none when no saved phone exists", () => {
    expect(classifySmsPhoneAvailability(contact({}))).toBe("none");
  });
});
