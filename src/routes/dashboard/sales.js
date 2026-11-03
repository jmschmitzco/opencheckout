// Orders and subscriptions: the screens somebody opens every day.
const express = require("express");
const db = require("../../db");
const orders = require("../../services/orders");
const customers = require("../../services/customers");
const subscriptions = require("../../services/subscriptions");
const money = require("../../lib/money");
const v = require("../../lib/validators");
const { withMerchant, formPost, formatDate, paging } = require("./_shared");

const router = express.Router();

const ORDER_STATUSES = ["paid", "pending", "refused", "refunded", "chargeback", "expired", "canceled"];

// ---------------------------------------------------------------------------
// Orders
// ---------------------------------------------------------------------------

router.get(
  "/orders",
  withMerchant(async (req, res) => {
    const { page, size, offset } = paging(req);
    const status = v.oneOf(req.query.status, ORDER_STATUSES);
    const search = v.text(req.query.q, 120);

    const params = [req.merchantId];
    const where = ["o.merchant_id = $1"];
    if (status) {
      params.push(status);
      where.push(`o.status = $${params.length}`);
    }
    if (search) {
      // Email or order id. Two things people actually have in hand when they
      // come looking: the address the buyer wrote from, or the code on the
      // receipt they were sent.
      params.push(`%${search.toLowerCase()}%`);
      params.push(search);
      where.push(`(lower(c.email) like $${params.length - 1} or o.public_id = $${params.length})`);
    }

    const sql = `from orders o
       left join customers c on c.id = o.customer_id and c.merchant_id = o.merchant_id
      where ${where.join(" and ")}`;

    const [rows, total] = await Promise.all([
      db.query(
        `select o.public_id, o.status, o.kind, o.amount_cents, o.currency, o.payment_method,
                o.installments, o.card_brand, o.card_last4, o.coupon_code, o.created_at,
                o.paid_at, o.livemode, c.email, c.name
         ${sql} order by o.id desc limit ${size} offset ${offset}`,
        params
      ),
      db.query(`select count(*)::int as n ${sql}`, params),
    ]);

    res.render("dashboard/orders", {
      title: "Orders",
      rows: rows.rows,
      total: total.rows[0].n,
      page,
      size,
      pages: Math.max(1, Math.ceil(total.rows[0].n / size)),
      status,
      search,
      statuses: ORDER_STATUSES,
      fmt: (cents, currency) => money.formatMoney(cents, currency),
      formatDate,
    });
  })
);

router.get(
  "/orders/:id",
  withMerchant(async (req, res) => {
    const order = await orders.findByPublicId(req.merchantId, req.params.id);
    if (!order) {
      return res.status(404).render("dashboard/message", {
        title: "Order not found",
        message: "There is no order with that id here.",
        backTo: "/dashboard/orders",
      });
    }

    const refunds = require("../../services/refunds");
    const disputes = require("../../services/disputes");

    const [items, customer, charges, children, parent, refundRows, disputeRows, refundable] =
      await Promise.all([
      orders.itemsOf(req.merchantId, order.id),
      order.customer_id ? customers.findById(req.merchantId, order.customer_id) : null,
      db.query(
        `select gateway, gateway_charge_id, status, amount_cents, currency, detail, created_at
           from charges where merchant_id = $1 and order_id = $2 order by id`,
        [req.merchantId, order.id]
      ),
      db.query(
        `select public_id, kind, status, amount_cents, currency, created_at
           from orders where merchant_id = $1 and parent_order_id = $2 order by id`,
        [req.merchantId, order.id]
      ),
      order.parent_order_id ? orders.findById(req.merchantId, order.parent_order_id) : null,
      refunds.listForOrder(req.merchantId, order.id),
      disputes.listForOrder(req.merchantId, order.id),
      refunds.refundableCents(req.merchantId, order),
    ]);

    res.render("dashboard/order", {
      title: `Order ${order.public_id}`,
      order,
      items,
      customer,
      charges: charges.rows,
      children: children.rows,
      parent,
      refunds: refundRows,
      disputes: disputeRows,
      refundable,
      fmt: (cents, currency) => money.formatMoney(cents, currency || order.currency),
      formatDate,
    });
  })
);

// Asks the gateway what it says right now.
//
// This is the button for "the buyer swears they paid". It reconciles server to
// server, which is one of the only two things in this system allowed to mark a
// sale paid.
router.post(
  "/orders/:id/reconcile",
  formPost(async (req, res) => {
    const order = await orders.findByPublicId(req.merchantId, req.params.id);
    if (!order) throw require("../../lib/errors").notFound("Order not found.");

    const result = await orders.reconcile(req.merchantId, order);
    if (result.unreachable) {
      res.flash("error", "The gateway could not be reached. Nothing was changed.");
    } else if (result.amountMismatch) {
      res.flash(
        "error",
        "The gateway reports a different amount than this order. Nothing was changed, and this is worth looking at."
      );
    } else if (result.changed) {
      res.flash("ok", `The gateway says this order is ${result.status}.`);
    } else {
      res.flash("ok", `No change. The gateway still says ${result.status}.`);
    }
    res.redirect(`/dashboard/orders/${req.params.id}`);
  })
);

// Gives money back.
//
// The flash deliberately does NOT say "refunded". Most processors answer
// "pending", and telling a merchant it is done when it is merely asked for is
// how somebody assures a customer of something that has not happened.
router.post(
  "/orders/:id/refund",
  formPost(async (req, res) => {
    const refunds = require("../../services/refunds");
    const merchants = require("../../services/merchants");
    const money = require("../../lib/money");

    const order = await orders.findByPublicId(req.merchantId, req.params.id);
    if (!order) throw require("../../lib/errors").notFound("Order not found.");

    const body = req.body || {};
    const whole = String(body.how || "all") === "all";
    const amountCents = whole ? null : money.parseAmountToCents(body.amount, order.currency);
    if (!whole && (!Number.isFinite(amountCents) || amountCents <= 0)) {
      throw require("../../lib/errors").badRequest("Enter an amount, like 19,90.");
    }

    const refund = await refunds.request({
      merchant: await merchants.current(),
      order,
      amountCents,
      reason: body.reason,
      source: "dashboard",
    });

    res.flash(
      "ok",
      refund.status === "succeeded"
        ? `${money.formatMoney(refund.amount_cents, refund.currency)} is on its way back.`
        : `Asked ${order.gateway} to send back ${money.formatMoney(refund.amount_cents, refund.currency)}. ` +
            "It is not done until they confirm it, which shows here as succeeded."
    );
    res.redirect(`/dashboard/orders/${order.public_id}`);
  })
);

// ---------------------------------------------------------------------------
// Disputes
// ---------------------------------------------------------------------------

router.get(
  "/disputes",
  withMerchant(async (req, res) => {
    const disputes = require("../../services/disputes");
    const money = require("../../lib/money");
    const [rows, open] = await Promise.all([
      disputes.list(req.merchantId, { status: v.oneOf(req.query.status, disputes.STATUSES) }),
      disputes.openAmount(req.merchantId),
    ]);

    res.render("dashboard/disputes", {
      title: "Disputes",
      rows,
      open,
      status: v.oneOf(req.query.status, disputes.STATUSES),
      statuses: disputes.STATUSES,
      fmt: (cents, currency) => money.formatMoney(cents, currency),
      formatDate,
    });
  })
);

// ---------------------------------------------------------------------------
// Subscriptions
// ---------------------------------------------------------------------------

router.get(
  "/subscriptions",
  withMerchant(async (req, res) => {
    const status = v.oneOf(req.query.status, subscriptions.STATUSES);
    const rows = await db.query(
      `select s.*, c.email, pr.name as product_name
         from subscriptions s
         left join customers c on c.id = s.customer_id and c.merchant_id = s.merchant_id
         left join products pr on pr.id = s.product_id and pr.merchant_id = s.merchant_id
        where s.merchant_id = $1 ${status ? "and s.status = $2" : ""}
        order by s.id desc limit 200`,
      status ? [req.merchantId, status] : [req.merchantId]
    );

    res.render("dashboard/subscriptions", {
      title: "Subscriptions",
      rows: rows.rows,
      status,
      statuses: subscriptions.STATUSES,
      entitled: subscriptions.ENTITLED_STATUSES,
      fmt: (cents, currency) => money.formatMoney(cents, currency),
      formatDate,
    });
  })
);

router.post(
  "/subscriptions/:id/cancel",
  formPost(async (req, res) => {
    const atPeriodEnd = String((req.body && req.body.when) || "period_end") !== "now";
    await subscriptions.cancel(req.merchantId, req.params.id, { atPeriodEnd });
    res.flash(
      "ok",
      atPeriodEnd
        ? "It will end when the period they paid for runs out."
        : "Cancelled immediately."
    );
    res.redirect("/dashboard/subscriptions");
  })
);

router.post(
  "/subscriptions/:id/resume",
  formPost(async (req, res) => {
    await subscriptions.resume(req.merchantId, req.params.id);
    res.flash("ok", "It will renew as normal.");
    res.redirect("/dashboard/subscriptions");
  })
);

// ---------------------------------------------------------------------------
// Customers
// ---------------------------------------------------------------------------

router.get(
  "/customers",
  withMerchant(async (req, res) => {
    const search = v.text(req.query.q, 120);
    const params = [req.merchantId];
    let filter = "";
    if (search) {
      // Email and name match as a pattern. The external id is compared WHOLE:
      // it is the integrator's own key, and a partial match on it is never
      // what anybody means.
      params.push(`%${search.toLowerCase()}%`, search);
      filter = `and (lower(c.email) like $2 or lower(coalesce(c.name, '')) like $2 or c.external_id = $3)`;
    }

    const rows = await db.query(
      `select c.public_id, c.email, c.name, c.external_id, c.created_at,
              (select count(*)::int from orders o
                where o.merchant_id = c.merchant_id and o.customer_id = c.id and o.status = 'paid')
                as paid_orders
         from customers c
        where c.merchant_id = $1 ${filter}
        order by c.id desc limit 200`,
      params
    );

    res.render("dashboard/customers", {
      title: "Customers",
      rows: rows.rows,
      search,
      formatDate,
    });
  })
);

// ---------------------------------------------------------------------------
// Events: what was sent, and what happened to it
// ---------------------------------------------------------------------------

router.get(
  "/events",
  withMerchant(async (req, res) => {
    const events = require("../../services/events");
    const webhooksOut = require("../../services/webhooks-out");
    const [list, deliveries] = await Promise.all([
      events.list(req.merchantId, { limit: 50 }),
      webhooksOut.listDeliveries(req.merchantId, { limit: 50 }),
    ]);

    res.render("dashboard/events", {
      title: "Events",
      events: list,
      deliveries,
      formatDate,
    });
  })
);

router.post(
  "/events/deliveries/:id/retry",
  formPost(async (req, res) => {
    const webhooksOut = require("../../services/webhooks-out");
    await webhooksOut.retry(req.merchantId, parseInt(req.params.id, 10));
    res.flash("ok", "Queued. It goes out on the next pass.");
    res.redirect("/dashboard/events");
  })
);

module.exports = router;
module.exports.ORDER_STATUSES = ORDER_STATUSES;
