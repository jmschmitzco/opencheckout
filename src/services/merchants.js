// Merchants: one row per business using this installation.
//
// A self-hosted single-merchant setup has exactly one, created on first boot.
// A hosted setup has many, and everything else in the system is scoped to one
// of them.
const db = require("../db");
const ctx = require("../db/merchant-context");
const ids = require("../lib/ids");
const v = require("../lib/validators");
const { badRequest, notFound } = require("../lib/errors");

function slugify(text) {
  return String(text || "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 50);
}

async function create({ name, slug, statementName, supportEmail, supportUrl, allowCustomCss = false }) {
  const cleanName = v.text(name, 120);
  if (!cleanName) throw badRequest("A merchant needs a name.", { name: "Required." });

  const base = slugify(slug || cleanName) || "merchant";
  const reason = "creating a merchant is what DEFINES ownership, so there is none yet";

  // Appends a suffix until the slug is free. A slug collision on signup is a
  // normal event, not an error worth showing anyone.
  let candidate = base;
  for (let attempt = 0; attempt < 20; attempt++) {
    const taken = await db.query(`select 1 from merchants where slug = $1`, [candidate], {
      withoutMerchant: reason,
    });
    if (!taken.rows.length) break;
    candidate = `${base}-${ids.randomSuffix(4)}`;
  }

  const result = await db.query(
    `insert into merchants
       (public_id, name, slug, statement_name, support_email, support_url, allow_custom_css)
     values ($1, $2, $3, $4, $5, $6, $7)
     returning *`,
    [
      ids.publicId("merchant"),
      cleanName,
      candidate,
      // What shows up on the buyer's card statement. Card networks want short
      // and uppercase, and a buyer who does not recognise the line disputes
      // the charge, so this is a revenue field.
      (v.text(statementName, 22) || cleanName).toUpperCase().slice(0, 22),
      v.email(supportEmail),
      v.httpUrl(supportUrl, { allowHttp: process.env.NODE_ENV !== "production" }),
      Boolean(allowCustomCss),
    ],
    { withoutMerchant: reason }
  );
  return result.rows[0];
}

async function findById(id) {
  const result = await db.query(`select * from merchants where id = $1`, [id], {
    withoutMerchant: "merchants is the table that defines ownership",
  });
  return result.rows[0] || null;
}

async function findByPublicId(publicId) {
  const result = await db.query(`select * from merchants where public_id = $1`, [publicId], {
    withoutMerchant: "merchants is the table that defines ownership",
  });
  return result.rows[0] || null;
}

async function findBySlug(slug) {
  const result = await db.query(`select * from merchants where slug = $1`, [slug], {
    withoutMerchant: "merchants is the table that defines ownership",
  });
  return result.rows[0] || null;
}

// The merchant of the current context, loaded. Throws when there is none,
// because every caller of this is inside a request that already resolved one.
async function current() {
  const merchant = await findById(ctx.requireMerchant());
  if (!merchant) throw notFound("Merchant not found.");
  return merchant;
}

// Hosts this merchant allows as a redirect target and as an iframe parent.
//
// Empty means "not restricted yet". The caller decides what to do about that:
// session creation accepts any https URL in that case and the dashboard nags,
// because refusing outright would block the first integration anyone attempts.
//
// A declared host covers its subdomains, so "acme.test" allows
// "app.acme.test". That is what a merchant means when they type their domain,
// and making them list every subdomain would get the list abandoned.
function allowedHosts(merchant) {
  return String((merchant && merchant.allowed_origins) || "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      try {
        return new URL(entry.includes("://") ? entry : `https://${entry}`).hostname.toLowerCase();
      } catch {
        return entry.toLowerCase();
      }
    })
    .filter(Boolean);
}

async function update(id, patch) {
  const fields = [];
  const params = [id];
  const push = (column, value) => {
    params.push(value);
    fields.push(`${column} = $${params.length}`);
  };

  if ("name" in patch) {
    const name = v.text(patch.name, 120);
    if (!name) throw badRequest("A merchant needs a name.", { name: "Required." });
    push("name", name);
  }
  if ("statementName" in patch) {
    push("statement_name", (v.text(patch.statementName, 22) || "").toUpperCase() || null);
  }
  if ("supportEmail" in patch) push("support_email", v.email(patch.supportEmail));
  if ("supportUrl" in patch) {
    push("support_url", v.httpUrl(patch.supportUrl, { allowHttp: process.env.NODE_ENV !== "production" }));
  }
  if ("allowedOrigins" in patch) {
    const origins = (
      Array.isArray(patch.allowedOrigins)
        ? patch.allowedOrigins
        : String(patch.allowedOrigins || "").split(",")
    )
      .map((entry) => String(entry).trim())
      .filter(Boolean)
      .slice(0, 50);
    push("allowed_origins", origins.join(","));
  }
  if (!fields.length) return findById(id);

  push("updated_at", new Date());
  const result = await db.query(
    `update merchants set ${fields.join(", ")} where id = $1 returning *`,
    params,
    { withoutMerchant: "merchants is the table that defines ownership" }
  );
  if (!result.rows[0]) throw notFound("Merchant not found.");
  return result.rows[0];
}

module.exports = {
  slugify,
  create,
  update,
  findById,
  findByPublicId,
  findBySlug,
  current,
  allowedHosts,
};
