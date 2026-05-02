// Apply migration 005 (token_tracking) directly via DATABASE_URL.
// One-shot: runs the ALTER TABLE statements, prints final schema, exits.
import pg from "pg";
import { readFileSync } from "node:fs";

const dbUrl = process.env.DATABASE_URL;
if (!dbUrl) {
  console.error("Missing DATABASE_URL");
  process.exit(1);
}

const sql = readFileSync(
  new URL("../migrations/005_token_tracking.sql", import.meta.url),
  "utf8"
);

const client = new pg.Client({ connectionString: dbUrl });
await client.connect();
console.log("[mig-005] connected");

await client.query(sql);
console.log("[mig-005] ran ALTER TABLE statements");

const cols = await client.query(`
  SELECT column_name, data_type, column_default
  FROM information_schema.columns
  WHERE table_name = 'user_quotas'
    AND column_name IN ('prompt_tokens','completion_tokens','total_tokens')
  ORDER BY column_name;
`);
console.log("[mig-005] token columns now on user_quotas:");
console.table(cols.rows);

await client.end();
console.log("[mig-005] done");
