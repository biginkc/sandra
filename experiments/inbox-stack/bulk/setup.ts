import { readFile } from "node:fs/promises";
import { pool, assertFixtureDatabase } from "../shared/database.js";
await assertFixtureDatabase();
await pool.query(
  await readFile(new URL("./setup.sql", import.meta.url), "utf8"),
);
await pool.end();
