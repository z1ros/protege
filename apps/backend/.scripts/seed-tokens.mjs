// Seed today's user_quotas row with some token usage so the Profile
// "Tokens used" row reflects a non-zero number on the next snapshot
// fetch. Defaults to a small bump (~10k) but accepts --tokens=N.
import pg from "pg";

const dbUrl = process.env.DATABASE_URL;
if (!dbUrl) {
  console.error("Missing DATABASE_URL");
  process.exit(1);
}

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, "").split("=");
    return [k, v];
  })
);
const totalTokens = Number(args.tokens ?? 10_400);
const promptTokens = Math.round(totalTokens * 0.99);
const completionTokens = totalTokens - promptTokens;

const client = new pg.Client({ connectionString: dbUrl });
await client.connect();

// Find the most-recent user (or fall back to the dev user if there's
// only one row for today).
const recent = await client.query(`
  SELECT user_id, day, total_tokens, total_usd_estimate
  FROM user_quotas
  ORDER BY day DESC, total_tokens DESC
  LIMIT 5;
`);
console.log("[seed] recent rows:");
console.table(recent.rows);

if (recent.rows.length === 0) {
  console.log("[seed] no users yet — seeding with a placeholder dev user");
  await client.query(
    `INSERT INTO user_quotas (user_id, day, prompt_tokens, completion_tokens, total_tokens)
     VALUES ('dev-seed', CURRENT_DATE AT TIME ZONE 'UTC', $1, $2, $3)
     ON CONFLICT (user_id, day) DO UPDATE
       SET prompt_tokens = user_quotas.prompt_tokens + EXCLUDED.prompt_tokens,
           completion_tokens = user_quotas.completion_tokens + EXCLUDED.completion_tokens,
           total_tokens = user_quotas.total_tokens + EXCLUDED.total_tokens;`,
    [promptTokens, completionTokens, totalTokens]
  );
} else {
  const userId = recent.rows[0].user_id;
  console.log(`[seed] bumping user=${userId} by ${totalTokens} tokens`);
  await client.query(
    `UPDATE user_quotas
     SET prompt_tokens = prompt_tokens + $1,
         completion_tokens = completion_tokens + $2,
         total_tokens = total_tokens + $3
     WHERE user_id = $4 AND day = (CURRENT_DATE AT TIME ZONE 'UTC')::date;`,
    [promptTokens, completionTokens, totalTokens, userId]
  );
}

const after = await client.query(`
  SELECT user_id, day, prompt_tokens, completion_tokens, total_tokens, total_usd_estimate
  FROM user_quotas
  WHERE day = (CURRENT_DATE AT TIME ZONE 'UTC')::date
  ORDER BY total_tokens DESC
  LIMIT 5;
`);
console.log("[seed] today's rows after bump:");
console.table(after.rows);

await client.end();
