// The first screen after signing in.
//
// It answers two questions in that order: is this installation actually able
// to take money, and what has it taken.
//
// The checklist comes first on purpose. The most common state of a fresh
// install is "looks finished, cannot charge anything", because the gateway
// keys are the one thing nobody can do for you, and a dashboard that opens on
// an empty revenue chart does not say so.
const express = require("express");
const db = require("../../db");
const money = require("../../lib/money");
const gatewayConfig = require("../../services/gateway-config");
const webhooksOut = require("../../services/webhooks-out");
const themes = require("../../services/themes");
const { withMerchant } = require("./_shared");

const router = express.Router();

// What has to be true before a real sale can happen here.
async function checklist(merchantId, merchant) {
  const [live, test, endpoints, theme, products] = await Promise.all([
    gatewayConfig.listConfigured({ merchantId, livemode: true }),
    gatewayConfig.listConfigured({ merchantId, livemode: false }),
    webhooksOut.listEndpoints(merchantId),
    themes.getMerchantTheme(merchantId),
    db.query(`select count(*)::int as n from products where merchant_id = $1 and active = true`, [
      merchantId,
    ]),
  ]);

  const liveActive = live.filter((row) => row.active);
  const hasTheme = Boolean(theme && theme.tokens && theme.tokens !== "{}");

  return [
    {
      id: "gateway",
      done: liveActive.length > 0,
      title: "Connect a payment gateway",
      detail: liveActive.length
        ? `${liveActive.map((row) => row.gateway).join(", ")} in live mode.`
        : "Nothing can be charged until one is connected. This is the only step nobody can do for you.",
      href: "/dashboard/settings/gateways",
    },
    {
      id: "origins",
      done: Boolean(merchant.allowed_origins),
      title: "Declare your own domains",
      detail: merchant.allowed_origins
        ? merchant.allowed_origins
        : "Until you do, any https address is accepted as a redirect target, and the embedded widget will not load.",
      href: "/dashboard/settings/account",
    },
    {
      id: "webhook",
      done: endpoints.some((row) => row.active),
      title: "Point a webhook at your app",
      detail: endpoints.some((row) => row.active)
        ? `${endpoints.filter((row) => row.active).length} active.`
        : "The redirect after payment is a convenience. The webhook is how you actually find out.",
      href: "/dashboard/settings/webhooks",
    },
    {
      id: "product",
      done: products.rows[0].n > 0,
      title: "Add something to sell",
      detail: products.rows[0].n
        ? `${products.rows[0].n} active.`
        : "A product and a price, or create sessions with ad hoc line items from your own code.",
      href: "/dashboard/products",
    },
    {
      id: "brand",
      done: hasTheme,
      title: "Make the checkout yours",
      detail: hasTheme ? "Your theme is set." : "Logo, colours and copy. It takes a minute.",
      href: "/dashboard/settings/branding",
    },
    {
      id: "testmode",
      done: test.some((row) => row.active),
      title: "Set up test mode",
      detail: test.some((row) => row.active)
        ? "You can make test charges."
        : "Optional, and worth it: a sandbox key lets you exercise the whole flow without real money.",
      href: "/dashboard/settings/gateways",
    },
  ];
}

// The numbers, over a window. Deliberately few: a dashboard that opens with
// twenty figures is one nobody reads.
async function summary(merchantId, days = 30) {
  const since = new Date(Date.now() - days * 86400000);

  const [paid, pending, refunded, currencies] = await Promise.all([
    db.query(
      `select count(*)::int as n, coalesce(sum(amount_cents), 0)::int as cents
         from orders where merchant_id = $1 and status = 'paid' and paid_at >= $2`,
      [merchantId, since]
    ),
    db.query(
      `select count(*)::int as n from orders
        where merchant_id = $1 and status = 'pending' and created_at >= $2`,
      [merchantId, since]
    ),
    db.query(
      `select count(*)::int as n, coalesce(sum(amount_cents), 0)::int as cents
         from orders where merchant_id = $1 and status in ('refunded', 'chargeback')
          and updated_at >= $2`,
      [merchantId, since]
    ),
    db.query(
      `select currency, count(*)::int as n from orders
        where merchant_id = $1 and status = 'paid' and paid_at >= $2
        group by currency order by n desc limit 1`,
      [merchantId, since]
    ),
  ]);

  // One currency, the one most sales were in. Adding up two currencies into a
  // single number is a figure that means nothing, and showing both doubles
  // every tile. The honest version is to name the one being counted.
  const currency = (currencies.rows[0] && currencies.rows[0].currency) || "BRL";

  return {
    days,
    currency,
    paidCount: paid.rows[0].n,
    paidCents: paid.rows[0].cents,
    pendingCount: pending.rows[0].n,
    refundedCount: refunded.rows[0].n,
    refundedCents: refunded.rows[0].cents,
  };
}

router.get(
  "/",
  withMerchant(async (req, res) => {
    const merchantId = req.merchantId;

    const [steps, numbers, recent, subscriptions] = await Promise.all([
      checklist(merchantId, req.merchant),
      summary(merchantId),
      db.query(
        `select o.public_id, o.status, o.amount_cents, o.currency, o.payment_method,
                o.created_at, o.kind, c.email
           from orders o
           left join customers c on c.id = o.customer_id and c.merchant_id = o.merchant_id
          where o.merchant_id = $1
          order by o.id desc limit 8`,
        [merchantId]
      ),
      db.query(
        `select count(*)::int as n from subscriptions
          where merchant_id = $1 and status in ('active', 'trialing', 'past_due')`,
        [merchantId]
      ),
    ]);

    res.render("dashboard/overview", {
      title: "Overview",
      steps,
      remaining: steps.filter((step) => !step.done).length,
      numbers,
      recent: recent.rows,
      activeSubscriptions: subscriptions.rows[0].n,
      fmt: (cents, currency) => money.formatMoney(cents, currency || numbers.currency),
    });
  })
);

module.exports = router;
