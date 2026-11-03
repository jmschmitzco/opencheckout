// PostgreSQL access. One pool, created on first use.
//
// Every query in the project goes through here, which makes it the one place
// where a rule can be enforced without depending on anybody remembering it.
const { Pool } = require("pg");
const { config } = require("../config");
const { tablesIn } = require("./owned-tables");

let pool = null;

function getPool() {
  if (!pool) {
    if (!config.databaseUrl) {
      throw new Error("DATABASE_URL is not set. Copy .env.example to .env and fill it in.");
    }
    // Most managed Postgres providers require TLS.
    const needsSsl = /supabase|sslmode=require|render\.com|neon\.tech|amazonaws/i.test(config.databaseUrl);
    pool = new Pool({
      connectionString: config.databaseUrl,
      ssl: needsSsl ? { rejectUnauthorized: false } : undefined,
      max: 10,
    });
  }
  return pool;
}

// node-postgres accepts query("sql", values) and query({ text, values }). The
// second form is used when a caller needs rowMode, and without normalising
// here it would slip past the guard with no SQL to inspect.
function sqlOf(text) {
  if (typeof text === "string") return text;
  if (text && typeof text.text === "string") return text.text;
  return "";
}

// THE MULTI-MERCHANT GUARD.
//
// If a statement touches a table that has an owner and never mentions the
// merchant, it does not reach the database: it throws immediately, with the
// SQL attached.
//
// The way out is the third argument:
//
//   db.query(sql, params, { withoutMerchant: "maintenance runs for everyone" })
//
// It is an argument rather than a comment inside the SQL on purpose: a comment
// is invisible to a test, and an argument can be swept by one.
function assertMerchantScoped(text, options) {
  const sql = sqlOf(text);
  const tables = tablesIn(sql);
  if (!tables.length) return;

  const reason = options && typeof options.withoutMerchant === "string" ? options.withoutMerchant.trim() : "";
  if (reason) return;
  if (/merchant_id/i.test(sql)) return;

  const error = new Error(
    `Query on owned table "${tables[0]}" does not mention the merchant. ` +
      'Filter by merchant_id, or declare the exception with { withoutMerchant: "reason" } ' +
      "as the third argument."
  );
  error.code = "NO_MERCHANT_SCOPE";
  error.sql = sql.slice(0, 300);
  throw error;
}

async function query(text, params, options) {
  assertMerchantScoped(text, options);
  return getPool().query(text, params);
}

// The guard applies INSIDE a transaction too.
//
// Without this it would have a hole the size of the system, because an order
// is born inside a transaction and every statement made with the raw client
// would pass unchecked. Whoever writes the code should not have to remember
// which object they are holding.
function watchedClient(client) {
  return new Proxy(client, {
    get(target, prop) {
      if (prop === "query") {
        return (text, params, options) => {
          assertMerchantScoped(text, options);
          return target.query(text, params);
        };
      }
      const value = target[prop];
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

// Runs `fn` inside a transaction, committing on success and rolling back on
// any error. The client handed to `fn` is guarded.
async function transaction(fn) {
  const client = await getPool().connect();
  try {
    await client.query("begin");
    const result = await fn(watchedClient(client));
    await client.query("commit");
    return result;
  } catch (err) {
    try {
      await client.query("rollback");
    } catch {
      /* the original error is the one worth reporting */
    }
    throw err;
  } finally {
    client.release();
  }
}

// Used by the test helper and by the demo server to swap in the in-memory
// database. Not part of the public surface.
function _setPool(replacement) {
  pool = replacement;
}

async function close() {
  if (pool && typeof pool.end === "function") await pool.end();
  pool = null;
}

module.exports = { query, transaction, getPool, close, _setPool };
