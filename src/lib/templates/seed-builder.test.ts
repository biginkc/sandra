import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

import {
  parseSeedBlock,
  validateRows,
  extractVariables,
  KNOWN_VARIABLES,
} from "./seed-builder";

// Load the real markdown file so we test against the actual source of truth.
const MD_PATH = path.resolve(__dirname, "../../../docs/sms-templates.md");
const markdown = fs.readFileSync(MD_PATH, "utf-8");

describe("parseSeedBlock", () => {
  it("returns 43 rows from the real sms-templates.md", () => {
    const result = parseSeedBlock(markdown);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error);
    expect(result.rows).toHaveLength(43);
  });

  it("returns an error when the markdown has no seed block", () => {
    const result = parseSeedBlock("# No seed block here");
    expect(result.ok).toBe(false);
  });
});

describe("validateRows (against real seed data)", () => {
  it("all 43 rows pass validation — no unknown vars, all names <= 120 chars", () => {
    const result = parseSeedBlock(markdown);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error);

    const errors = validateRows(result.rows);
    expect(errors).toHaveLength(0);
  });

  it("all variable refs in content are in KNOWN_VARIABLES", () => {
    const result = parseSeedBlock(markdown);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error);

    const unknown: string[] = [];
    for (const row of result.rows) {
      for (const v of extractVariables(row.content)) {
        if (!KNOWN_VARIABLES.has(v)) {
          unknown.push(`${row.name}: {{${v}}}`);
        }
      }
    }
    expect(unknown).toHaveLength(0);
  });

  it("all names are <= 120 characters", () => {
    const result = parseSeedBlock(markdown);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error);

    const tooLong = result.rows.filter((r) => r.name.length > 120);
    expect(tooLong).toHaveLength(0);
  });
});

describe("extractVariables", () => {
  it("extracts simple {{var}} references", () => {
    expect(extractVariables("Hello {{first_name}}!")).toEqual(["first_name"]);
  });

  it("strips pipe fallback — {{first_name | there}} → first_name", () => {
    expect(extractVariables("Hi {{first_name | there}}")).toEqual(["first_name"]);
  });

  it("ignores {{#if ...}} and {{/if}} block markers", () => {
    // #if starts with # so it won't match [a-zA-Z_]\w* (# is not in that set)
    const vars = extractVariables("{{#if first_name}}Hi {{first_name}}{{/if}}");
    // Only the inner {{first_name}} should match
    expect(vars).toEqual(["first_name"]);
  });

  it("returns empty array when no variables present", () => {
    expect(extractVariables("No variables here.")).toEqual([]);
  });
});
