/**
 * SMS template seed builder — parse + validate logic.
 *
 * Extracted from scripts/build-sms-template-seed.ts so it can be unit-tested
 * under the src/ vitest include pattern (src/**\/**.test.ts).
 *
 * Re-run the script to regenerate the migration:
 *   npx tsx scripts/build-sms-template-seed.ts
 */

export const KNOWN_VARIABLES = new Set([
  "first_name",
  "last_name",
  "property_address",
  "city",
  "state",
  "property_zip",
  "market",
  "my_first_name",
  "company_name",
]);

export type SeedRow = {
  name: string;
  category: string;
  content: string;
};

export type ParseResult =
  | { ok: true; rows: SeedRow[] }
  | { ok: false; error: string };

/**
 * Extract all {{var}} names from a template content string.
 * Handles pipe-fallback syntax: {{var | fallback}} → "var"
 * Handles conditional syntax: {{#if var}}...{{/if}} → skips #if, /if tokens
 */
export function extractVariables(content: string): string[] {
  const re = /\{\{([a-zA-Z_]\w*)(?:\s*\|[^}]*)?\}\}/g;
  const vars: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(content)) !== null) {
    vars.push(m[1]);
  }
  return vars;
}

/**
 * Parse the pipe-delimited seed block from the sms-templates.md markdown file.
 *
 * Expects a fenced code block starting with:
 *   ```
 *   NAME | CATEGORY | CONTENT
 *   ...rows...
 *   ```
 *
 * Returns ParseResult with rows or an error string.
 */
export function parseSeedBlock(markdown: string): ParseResult {
  // Find the fenced block containing the header "NAME | CATEGORY | CONTENT"
  const fenceRe = /```[^\n]*\n([\s\S]*?)```/g;
  let seedBlock: string | null = null;
  let m: RegExpExecArray | null;
  while ((m = fenceRe.exec(markdown)) !== null) {
    const body = m[1];
    if (body.trimStart().startsWith("NAME | CATEGORY | CONTENT")) {
      seedBlock = body;
      break;
    }
  }

  if (!seedBlock) {
    return { ok: false, error: "Could not find NAME | CATEGORY | CONTENT seed block in markdown" };
  }

  const lines = seedBlock
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);

  // First line is the header — skip it
  const dataLines = lines.slice(1);

  if (dataLines.length === 0) {
    return { ok: false, error: "Seed block has no data rows" };
  }

  const rows: SeedRow[] = [];
  for (let i = 0; i < dataLines.length; i++) {
    const line = dataLines[i];
    // Split on " | " (with spaces) to preserve pipe chars inside content
    const parts = line.split(" | ");
    if (parts.length < 3) {
      return {
        ok: false,
        error: `Row ${i + 1} has fewer than 3 pipe-delimited columns: "${line}"`,
      };
    }
    const name = parts[0].trim();
    const category = parts[1].trim();
    // Content may itself contain " | " — rejoin everything after the second pipe
    const content = parts.slice(2).join(" | ").trim();

    rows.push({ name, category, content });
  }

  return { ok: true, rows };
}

export type ValidationError = {
  row: number;
  name: string;
  issues: string[];
};

/**
 * Validate all parsed rows. Returns an array of validation errors (empty = clean).
 */
export function validateRows(rows: SeedRow[]): ValidationError[] {
  const errors: ValidationError[] = [];

  for (let i = 0; i < rows.length; i++) {
    const { name, content } = rows[i];
    const issues: string[] = [];

    if (name.length > 120) {
      issues.push(`Name is ${name.length} chars (max 120)`);
    }
    if (name.trim().length === 0) {
      issues.push("Name is empty");
    }
    if (content.trim().length === 0) {
      issues.push("Content is empty");
    }

    const vars = extractVariables(content);
    for (const v of vars) {
      if (!KNOWN_VARIABLES.has(v)) {
        issues.push(`Unknown variable: {{${v}}}`);
      }
    }

    if (issues.length > 0) {
      errors.push({ row: i + 1, name, issues });
    }
  }

  return errors;
}
