import { describe, expect, it } from "vitest";

import { renderTemplate } from "./render";

describe("renderTemplate", () => {
  it("substitutes a known variable", () => {
    expect(renderTemplate("Hi {{first_name}}", { first_name: "Sandra" })).toBe(
      "Hi Sandra",
    );
  });

  it("renders a null value as blank in place", () => {
    expect(renderTemplate("Hi {{first_name}}", { first_name: null })).toBe(
      "Hi ",
    );
  });

  it("renders a missing variable as blank (no 'undefined' leaks into the body)", () => {
    expect(renderTemplate("Hi {{first_name}}", {})).toBe("Hi ");
    expect(renderTemplate("Hi {{first_name}}", {}).includes("undefined")).toBe(
      false,
    );
  });

  it("renders a conditional when the variable is truthy", () => {
    expect(
      renderTemplate(
        "{{#if first_name}}Hi {{first_name}}, {{/if}}hello",
        { first_name: "Sandra" },
      ),
    ).toBe("Hi Sandra, hello");
  });

  it("drops the conditional block entirely when the variable is falsy", () => {
    expect(
      renderTemplate(
        "{{#if first_name}}Hi {{first_name}}, {{/if}}hello",
        { first_name: null },
      ),
    ).toBe("hello");
    expect(
      renderTemplate(
        "{{#if first_name}}Hi {{first_name}}, {{/if}}hello",
        {},
      ),
    ).toBe("hello");
    expect(
      renderTemplate(
        "{{#if first_name}}Hi {{first_name}}, {{/if}}hello",
        { first_name: "" },
      ),
    ).toBe("hello");
  });

  it("handles multiple variables in the same body", () => {
    expect(
      renderTemplate(
        "Hi {{first_name}}, this is {{my_first_name}} with {{company_name}}. {{property_address}}?",
        {
          first_name: "Sandra",
          my_first_name: "Jarrad",
          company_name: "BMH Group",
          property_address: "123 Main St",
        },
      ),
    ).toBe("Hi Sandra, this is Jarrad with BMH Group. 123 Main St?");
  });

  it("renders an unknown variable as blank (safe fallback, no throw)", () => {
    expect(renderTemplate("a{{nope}}b", {})).toBe("ab");
  });

  it("returns the input as-is when a conditional is malformed (no closing /if)", () => {
    // `{{#if foo}}xyz` without a closing tag is a no-op; we keep the body
    // as typed rather than accidentally eating downstream content.
    const malformed = "{{#if foo}}no closing";
    expect(renderTemplate(malformed, { foo: "x" })).toBe(malformed);
  });

  it("supports nested variable reference inside a conditional", () => {
    expect(
      renderTemplate(
        "{{#if first_name}}Hi {{first_name}}, {{/if}}— {{my_first_name}}",
        { first_name: "Sandra", my_first_name: "Jarrad" },
      ),
    ).toBe("Hi Sandra, — Jarrad");
  });

  it("handles the empty-string variable as falsy for conditionals but blank for substitution", () => {
    expect(
      renderTemplate(
        "{{#if lists}}on {{lists}}{{/if}} hi",
        { lists: "" },
      ),
    ).toBe(" hi");
  });
});
