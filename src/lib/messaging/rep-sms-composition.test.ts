import { describe, expect, it } from "vitest";

import {
  DEFAULT_REP_SMS_INTRODUCTION,
  REP_SMS_INTRODUCTIONS,
  REP_SMS_TEMPLATES,
  composeRepSms,
} from "./rep-sms-composition";

describe("rep SMS composition", () => {
  it("builds the complete body from an approved introduction and curated remainder", () => {
    const template = REP_SMS_TEMPLATES[0];
    const result = composeRepSms({
      introId: DEFAULT_REP_SMS_INTRODUCTION.id,
      introVersion: DEFAULT_REP_SMS_INTRODUCTION.version,
      templateId: template.id,
      templateVersion: template.version,
      initialRemainder: template.remainder,
      remainder: template.remainder,
    });

    expect(result.finalBody).toBe(`${DEFAULT_REP_SMS_INTRODUCTION.body}\n\n${template.remainder}`);
    expect(result.initialBody).toBe(result.finalBody);
    expect(result.templateOrigin).toBe("curated");
    expect(result.policyVersion).toBe(1);
  });

  it("keeps the selected intro stable while allowing the remainder to be edited", () => {
    const intro = REP_SMS_INTRODUCTIONS[1];
    const template = REP_SMS_TEMPLATES[1];
    const result = composeRepSms({
      introId: intro.id,
      introVersion: intro.version,
      templateId: template.id,
      templateVersion: template.version,
      initialRemainder: template.remainder,
      remainder: "Could you text Maria a couple times that work for you?",
    });

    expect(result.initialBody).toContain(template.remainder);
    expect(result.finalBody).toContain("Could you text Maria");
    expect(result.finalBody).toContain(intro.body);
    expect(result.finalBody).not.toContain(template.remainder);
  });

  it("rejects stale or unknown copy selections", () => {
    expect(() => composeRepSms({
      introId: REP_SMS_INTRODUCTIONS[0].id,
      introVersion: 99,
      remainder: "Please text Maria a time that works.",
    })).toThrow("introduction changed");
    expect(() => composeRepSms({
      introId: "untrusted-intro",
      remainder: "Please text Maria a time that works.",
    })).toThrow("approved Mel introduction");
    expect(() => composeRepSms({
      templateId: "untrusted-template",
      remainder: "Please text Maria a time that works.",
    })).toThrow("approved texting template");
  });

  it("rejects pasted duplicate introductions and empty or oversized messages", () => {
    expect(() => composeRepSms({
      remainder: `${REP_SMS_INTRODUCTIONS[0].body} Please text Maria a time.`,
    })).toThrow("duplicate");
    expect(() => composeRepSms({ remainder: "  " })).toThrow("message");
    expect(() => composeRepSms({ remainder: "x".repeat(1600) })).toThrow("1600");
  });

  it("supports an old body-only caller while still applying the required intro", () => {
    const result = composeRepSms({ body: "Please text Maria a time that works." });
    expect(result.templateOrigin).toBe("manual");
    expect(result.finalBody).toBe(`${DEFAULT_REP_SMS_INTRODUCTION.body}\n\nPlease text Maria a time that works.`);
  });

  it("does not double-prefix a legacy full body from the first composer", () => {
    const legacyBody = `${DEFAULT_REP_SMS_INTRODUCTION.body}\n\nPlease text Maria a time that works.`;
    const result = composeRepSms({ body: legacyBody });
    expect(result.finalBody).toBe(legacyBody);
    expect(result.finalBody.match(/this is Mel/gi)).toHaveLength(1);
  });
});
