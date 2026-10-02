import { readFileSync } from "node:fs";
import path from "node:path";

import { MUTATION_NAMES, mutate } from "../tests/search-oracle/sql-mutations";

const sql = readFileSync(
  path.resolve(__dirname, "../supabase/migrations/20261002110100_search_properties.sql"),
  "utf8",
);
let bad = 0;
for (const name of MUTATION_NAMES) {
  if (mutate(sql, name) === sql) {
    console.error(`mutation ${name} is a NO-OP against the current SQL (its pattern no longer matches)`);
    bad += 1;
  } else {
    console.log(`mutation ${name} changes the SQL`);
  }
}
if (bad > 0) process.exit(1);
