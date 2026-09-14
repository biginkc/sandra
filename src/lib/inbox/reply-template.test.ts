import { describe, expect, it } from "vitest";
import { renderTemplate } from "@/lib/templates/render";
import { renderReviewedReply, ReplyTemplateError } from "./reply-template";

describe("reviewed bulk reply personalization", () => {
  it("matches existing supported rendering while retaining the exact reviewed whitespace", () => {
    const template = "Hi {{first_name | there}}, {{#if property_address}}about {{property_address}}: {{/if}}I'm {{my_first_name}} at {{company_name}}. ";
    const vars = { first_name: null, property_address: "12 Main", my_first_name: "Mel", company_name: "BMH" };
    expect(renderReviewedReply(template, vars)).toBe(renderTemplate(template, vars));
  });
  it("requires values only in included conditional content", () => {
    expect(renderReviewedReply("Hi{{#if property_address}} at {{city}}{{/if}}.", {})).toBe("Hi.");
    expect(() => renderReviewedReply("Hi{{#if property_address}} at {{city}}{{/if}}.", { property_address: "12 Main" })).toThrow(ReplyTemplateError);
  });
  it("does not interpret substituted seller data as another token", () => {
    expect(renderReviewedReply("Hi {{first_name}}.", { first_name: "{{company_name}}" })).toBe("Hi {{company_name}}.");
  });
  it("preserves adjacent conditionals and zero substitution semantics", () => {
    const template = "{{#if first_name}}Hi {{first_name}}{{/if}}{{#if city}} in {{city}}{{/if}} {{market | fallback}}";
    const vars = { first_name: "Ada", city: "KC", market: 0 };
    expect(renderReviewedReply(template, vars)).toBe(renderTemplate(template, vars));
    expect(renderReviewedReply("Hi{{#if market}} there{{/if}}", { market: 0 })).toBe("Hi");
  });
  it.each([NaN, Infinity, -Infinity])("rejects invalid numeric values: %s", value => {
    expect(() => renderReviewedReply("Hi {{first_name}}", { first_name: value })).toThrow("invalid_body");
  });
  it.each(["{{unknown}}", "{{constructor}}", "{{#if lists}}hidden{{/if}}"])("rejects non-whitelisted fields: %s", template => {
    expect(() => renderReviewedReply(template, {})).toThrow("unknown_variable");
  });
  it.each(["Hi {{first_name", "Hi }}", "{{/if}}", "{{#if first_name}}Hi", "{{#if first_name}}{{#if city}}Hi{{/if}}{{/if}}", "{{first_name.foo}}", "{{else}}"])("rejects malformed or unsupported syntax: %s", template => {
    expect(() => renderReviewedReply(template, {})).toThrow(ReplyTemplateError);
  });
  it("rejects empty fallback and inherited values instead of silently dropping required fields", () => {
    expect(() => renderReviewedReply("Hi {{first_name | }}", {})).toThrow("missing_variable");
    expect(() => renderReviewedReply("Hi {{first_name}}", Object.create({ first_name: "Inherited" }))).toThrow("missing_variable");
  });
  it("bounds final personalized text and rejects an empty rendered body", () => {
    expect(renderReviewedReply("{{company_name}}", { company_name: "a".repeat(1600) })).toHaveLength(1600);
    expect(() => renderReviewedReply("{{company_name}}", { company_name: "a".repeat(1601) })).toThrow("invalid_body");
    expect(() => renderReviewedReply("{{#if first_name}}Hi{{/if}}", {})).toThrow("invalid_body");
  });
});
