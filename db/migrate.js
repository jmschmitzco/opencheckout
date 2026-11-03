// Applies db/schema.sql to the database in DATABASE_URL.
//
//   npm run db:migrate
//
// The schema is idempotent, so this is also how an upgrade is applied: every
// statement is "create ... if not exists".
const fs = require("fs");
const path = require("path");
const { config } = require("../src/config");
const db = require("../src/db");

async function main() {
  if (!config.databaseUrl) {
    console.error("DATABASE_URL is not set. Copy .env.example to .env and fill it in.");
    process.exit(1);
  }

  const schema = fs.readFileSync(path.join(__dirname, "schema.sql"), "utf8");
  console.log(`Applying the schema to ${maskUrl(config.databaseUrl)}`);

  await db.query(schema, [], {
    withoutMerchant: "a migration necessarily runs before any merchant exists",
  });

  const version = await db.query(
    `select version, applied_at from schema_versions order by applied_at desc limit 1`,
    [],
    { withoutMerchant: "schema_versions is installation metadata" }
  );
  console.log(`Done. Schema version ${version.rows[0] ? version.rows[0].version : "unknown"}.`);
  await db.close();
}

// The connection string holds a password, and this line ends up in deployment
// logs.
function maskUrl(url) {
  try {
    const parsed = new URL(url);
    if (parsed.password) parsed.password = "****";
    return parsed.toString();
  } catch {
    return "the configured database";
  }
}

main().catch((err) => {
  console.error("The migration failed:", err.message);
  process.exit(1);
});
