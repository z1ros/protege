import { readFileSync } from "fs";

const url = process.env.SUPABASE_URL ?? "https://lfckgmlfvkwfskpsoovq.supabase.co";
const key = process.env.SUPABASE_SERVICE_KEY ?? "";

const sql = readFileSync(new URL("../supabase-seed.sql", import.meta.url), "utf-8");

// Split SQL into individual statements (Supabase SQL API executes one at a time)
const statements = sql
  .split(/;\s*$/m)
  .map((s) => s.trim())
  .filter((s) => s.length > 0 && !s.startsWith("--"));

console.log(`Running ${statements.length} SQL statements against ${url}...`);

let success = 0;
let failed = 0;

for (const stmt of statements) {
  const first = stmt.slice(0, 60).replace(/\n/g, " ");
  try {
    const res = await fetch(`${url}/rest/v1/rpc/`, {
      method: "POST",
      headers: {
        apikey: key,
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
      },
    });
    // The REST API can't run DDL. Use the Postgres HTTP API instead.
  } catch {}
}

// Supabase JS client can't run raw DDL SQL.
// Use the direct Postgres connection instead.
const pgUrl = `postgresql://postgres.lfckgmlfvkwfskpsoovq:ProtegeZero%230@aws-1-us-east-1.pooler.supabase.com:5432/postgres`;

console.log("Connecting to Postgres directly...");

// Use node's built-in or pg module
try {
  // Dynamic import pg
  const pg = await import("pg");
  const client = new pg.default.Client({ connectionString: pgUrl, ssl: { rejectUnauthorized: false } });
  await client.connect();
  console.log("✅ Connected to Postgres!");

  // Run the full seed as one statement
  await client.query(sql);
  console.log("✅ Seed SQL executed successfully!");

  // Verify tables
  const { rows } = await client.query(
    "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY table_name"
  );
  console.log("\nTables created:");
  for (const row of rows) {
    console.log(`  ✅ ${row.table_name}`);
  }

  await client.end();
  console.log("\n🟢 Supabase is ready!");
} catch (err: any) {
  if (err.code === "MODULE_NOT_FOUND" || err.message?.includes("Cannot find")) {
    console.log("pg module not installed. Installing...");
    const { execSync } = await import("child_process");
    execSync("pnpm add -D pg @types/pg", { stdio: "inherit" });
    console.log("Installed. Run this script again.");
  } else {
    console.error("❌ Failed:", err.message);
  }
}
