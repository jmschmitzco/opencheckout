// Orders: the part that handles money.
//
// THREE RULES GOVERN THIS FILE. They are not style preferences; each one is
// here because the alternative loses money or leaks data.
//
//   1. THE SERVER DECIDES THE PRICE. An order is priced from the stored
//      checkout session, never from the request body. The browser sends which
//      method, how many instalments and the card; it never sends an amount.
//
//   2. A SALE IS ONLY PAID WHEN THE GATEWAY SAYS SO, through a verified
//      webhook or a server to server status query. The buyer's browser is
//      never a source of truth about payment, no matter what it claims.
//
//   3. CARD DATA IS NEVER LOGGED OR STORED. It travels from the form to the
//      adapter and stops there. What comes back is a token, a brand and the
//      last four digits.
const db = require("../db");
const ctx = require("../db/merchant-context");
const ids = require("../lib/ids");
const v = require("../lib/validators");
const money = require("../lib/money");
const { randomUrlToken } = require("../lib/crypto");
const { scrub } = require("../lib/scrub");
const { inBackground } = require("../lib/background-tasks");
const { badRequest, conflict, notFound, gatewayError } = require("../lib/errors");
const { getGateway } = require("../gateways");
const sessions = require("./checkout-sessions");
const customers = require("./customers");
const catalog = require("./catalog");
const events = require("./events");
const webhooksOut = require("./webhooks-out");
const gatewayConfig = require("./gateway-config");

const STATUSES = ["pending", "paid", "refused", "refunded", "chargeback", "expired", "canceled"];

// Which status may follow which.
//
// Written down as a table because gateways resend and reorder: a "pending"
// arriving after a "paid" is normal traffic, not an error, and applying it
// would un-pay a paid sale. A transition that is not listed is ignored, and
// that is what makes the webhook handler idempotent.
const ALLOWED_TRANSITIONS = {
  pending: ["paid", "refused", "expired", "canceled", "refunded", "chargeback"],
  paid: ["refunded", "chargeback"],
  refused: ["paid"], // a retry on the same charge can still succeed
  expired: ["paid"], // a boleto paid after its due date still clears
  canceled: [],
  refunded: ["chargeback"],
  chargeback: ["refunded"],
};

const TERMINAL_PAID = ["paid", "refunded", "chargeback"];

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

async function findById(merchantId, id) {
  const result = await db.query(`select * from orders where merchant_id = $1 and id = $2`, [
    merchantId,
    id,
  ]);
  return result.rows[0] || null;
}

async function findByPublicId(merchantId, publicId) {
  const result = await db.query(`select * from orders where merchant_id = $1 and public_id = $2`, [
    merchantId,
    publicId,
  ]);
  return result.rows[0] || null;
}

// The order behind a gateway charge id. Used by the webhook handler, which
// knows the charge and nothing else.
async function findByCharge(merchantId, gateway, gatewayChargeId) {
  if (!gatewayChargeId) return null;
  const result = await db.query(
    `select * from orders
      where merchant_id = $1 and gateway = $2 and gateway_charge_id = $3`,
    [merchantId, gateway, String(gatewayChargeId)]
  );
  return result.rows[0] || null;
}

// The order behind a gateway CAPTURE, for the gateways where the thing that
// holds the money is not the thing that was created. PayPal is the case: we
// create an order and the capture is what was paid, and a refund notification
// names only the capture.
async function findByCaptureId(merchantId, gateway, captureId) {
  if (!captureId) return null;
  const result = await db.query(
    `select * from orders
      where merchant_id = $1 and gateway = $2 and gateway_capture_id = $3`,
    [merchantId, gateway, String(captureId)]
  );
  return result.rows[0] || null;
}

// An order read with its own token, which is what the thank-you page and the
// status poller have. The token grants this one order and nothing else, so
// there is no API key in a page the buyer can see.
async function findByToken(merchantId, publicId, token) {
  const order = await findByPublicId(merchantId, publicId);
  if (!order) return null;
  const { safeEqual } = require("../lib/crypto");
  return safeEqual(order.checkout_token, token) ? order : null;
}

async function itemsOf(merchantId, orderId) {
  const result = await db.query(
    `select * from order_items where merchant_id = $1 and order_id = $2 order by id`,
    [merchantId, orderId]
  );
  return result.rows;
}

async function list(merchantId, { status = null, customerId = null, limit = 50, before = null } = {}) {
  const params = [merchantId];
  const where = ["merchant_id = $1"];
  if (status) {
    params.push(status);
    where.push(`status = $${params.length}`);
  }
  if (customerId) {
    params.push(customerId);
    where.push(`customer_id = $${params.length}`);
  }
  if (before) {
    params.push(before);
    where.push(`id < (select id from orders where merchant_id = $1 and public_id = $${params.length})`);
  }
  params.push(Math.max(1, Math.min(100, Number(limit) || 50)));
  const result = await db.query(
    `select * from orders where ${where.join(" and ")} order by id desc limit $${params.length}`,
    params
  );
  return result.rows;
}

// ---------------------------------------------------------------------------
// Creating
// ---------------------------------------------------------------------------

// Turns a checkout session into an order and charges it.
//
// Everything priced comes from the session row. `input` only carries what the
// buyer legitimately chooses: who they are, how they want to pay, how many
// instalments, and the card.
async function createFromSession({ merchant, session: loaded, input = {}, remoteIp = null, userAgent = null }) {
  const merchantId = merchant.id;

  if (sessions.effectiveStatus(loaded) !== "open") {
    throw conflict(`This checkout is ${sessions.effectiveStatus(loaded)}.`);
  }

  // CLAIM THE SESSION BEFORE ANYTHING ELSE.
  //
  // This is what stops two tabs, or a double tap on a phone, from reaching the
  // gateway twice. It also returns the row as it is NOW, so a coupon applied a
  // second ago in another tab is honoured instead of the buyer being charged
  // the old price.
  //
  // Everything from here on uses `session`, never the row the request loaded.
  const session = await sessions.claimForCharge(merchantId, loaded.id);
  if (!session) {
    const current = await sessions.findByPublicId(merchantId, loaded.public_id);
    const status = current ? sessions.effectiveStatus(current) : "expired";
    throw conflict(
      status === "open"
        ? "A payment is already being processed for this checkout."
        : `This checkout is ${status}.`
    );
  }

  // From here a failure has to release the claim, or the buyer cannot retry.
  try {
    return await chargeClaimedSession({ merchant, session, input, remoteIp, userAgent });
  } catch (err) {
    await sessions.releaseClaim(merchantId, session.id).catch(() => {
      /* releasing is best effort: the claim goes stale on its own */
    });
    throw err;
  }
}

async function chargeClaimedSession({ merchant, session, input, remoteIp, userAgent }) {
  const merchantId = merchant.id;
  const methods = String(session.payment_methods || "").split(",").filter(Boolean);
  const method = v.oneOf(input.method, methods);
  if (!method) {
    throw badRequest(`method must be one of: ${methods.join(", ")}.`, { method: "Invalid." });
  }

  // The gateway has to be able to take this method before the buyer fills
  // anything in. Finding out afterwards is the worst version of this bug.
  const available = await gatewayConfig.availableMethods({
    merchantId,
    livemode: session.livemode,
    currency: session.currency,
  });
  if (!available.includes(method)) {
    throw conflict(
      `No gateway configured for ${method}. Configure one in the dashboard, or offer another method.`
    );
  }

  const buyer = await validateBuyer({ merchantId, session, input });
  const customer = await customers.upsert(merchantId, buyer);

  const items = sessions.parseLineItems(session);
  // Priced from the offer rows, not from the session's stored figure, so the
  // charge and the page can never disagree about what a bump costs.
  const bumps = await sessions.acceptedBumpRows(merchantId, session);
  const total = Math.max(0, Number(session.total_cents) || 0);
  if (total <= 0) {
    // A free checkout is a real need, and it is NOT this code path: there is
    // nothing to charge, so there is no gateway to ask and no card to take.
    // Refusing here keeps the money path honest; a free plan is handled by the
    // integrator without a session at all.
    throw badRequest("This checkout has nothing to charge. A zero total needs no payment.");
  }

  const maxInstallments = method === "card" ? maxInstallmentsForItems(items, session.currency) : 1;
  const installments = money.normalizeInstallments(input.installments, maxInstallments, total);

  let card = null;
  if (method === "card") card = validateCard(input.card);

  const order = await db.transaction(async (client) => {
    const inserted = await client.query(
      `insert into orders
         (merchant_id, public_id, livemode, session_id, customer_id, kind, status,
          payment_method, installments, currency, amount_cents, discount_cents,
          coupon_code, external_reference, metadata, checkout_token, remote_ip, user_agent)
       values ($1, $2, $3, $4, $5, 'main', 'pending', $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
       returning *`,
      [
        merchantId,
        ids.publicId("order"),
        session.livemode,
        session.id,
        customer.id,
        method,
        installments,
        session.currency,
        total,
        session.discount_cents,
        session.coupon_code,
        session.external_reference,
        session.metadata,
        randomUrlToken(24),
        remoteIp,
        v.text(userAgent, 300),
      ]
    );
    const row = inserted.rows[0];

    for (const item of items) {
      await client.query(
        `insert into order_items
           (merchant_id, order_id, kind, product_id, price_id, description,
            quantity, unit_amount_cents, amount_cents)
         values ($1, $2, 'main', $3, $4, $5, $6, $7, $8)`,
        [
          merchantId,
          row.id,
          item.product_id,
          item.price_id,
          item.description,
          item.quantity,
          item.unit_amount_cents,
          item.amount_cents,
        ]
      );
    }

    // A bump is a line on the SAME order, marked as what it is. The receipt
    // then shows what the buyer actually agreed to, and the merchant's report
    // can tell a bump apart from the thing that sold it.
    for (const bump of bumps) {
      await client.query(
        `insert into order_items
           (merchant_id, order_id, kind, product_id, price_id, description,
            quantity, unit_amount_cents, amount_cents)
         values ($1, $2, 'bump', $3, $4, $5, 1, $6, $6)`,
        [merchantId, row.id, bump.product_id, bump.offer_price_id, bump.title, bump.unit_amount_cents]
      );
    }
    return row;
  });

  // The charge is attempted OUTSIDE the transaction. Holding a database
  // transaction open across a network call to a third party is how a slow
  // gateway turns into an exhausted connection pool and a dead site.
  const charged = await chargeOrder({ merchant, order, customer, card, method, session });

  return charged;
}

function maxInstallmentsForItems(items, currency) {
  if (currency !== "BRL") return 1;
  // The most restrictive item wins. Offering twelve instalments because one
  // line allows it, when another does not, means a charge the gateway refuses.
  return items.reduce((lowest, item) => Math.min(lowest, item.max_installments || 1), 12);
}

// Checks what the buyer typed against what this session asks for.
//
// Two fields are special. The email is always required, because it is how the
// receipt and the access reach them. The tax id and the address are required
// by Brazilian gateways for Pix and registered boleto whether or not the
// merchant asked for them on the form, which is why the session's field list
// is a minimum and not a maximum.
async function validateBuyer({ merchantId, session, input }) {
  const raw = (input && input.buyer) || {};
  const fields = String(session.buyer_fields || "").split(",").filter(Boolean);
  const errors = {};

  const email = v.email(raw.email || session.customer_email);
  if (!email) errors.email = "A valid email is required.";

  if (fields.includes("confirm_email")) {
    const confirm = v.email(raw.confirm_email);
    if (!confirm || confirm !== email) errors.confirm_email = "The two emails do not match.";
  }

  // Fills in from the record first, so a returning buyer is not asked again
  // for something already on file. This is what makes hiding a field safe, and
  // it is also the rule that goes with it: a field may only be hidden if it
  // can be filled from here.
  const known = await customers.completeFromRecord(merchantId, { ...raw, email });

  const needsTaxId =
    fields.includes("document") || (session.currency === "BRL" && ["pix", "boleto"].includes(input.method));
  const needsAddress = session.currency === "BRL" && input.method === "boleto";

  const buyer = {
    email,
    name: v.text(known.name, 120),
    document: v.taxId(known.document),
    phone: v.phoneBr(known.phone),
    postalCode: v.postalCodeBr(known.postalCode),
    addressNumber: v.text(known.addressNumber, 20),
    country: (v.text(known.country, 2) || "BR").toUpperCase(),
    // The integrator's own user id. It comes from the session when the session
    // carried one, because that is the trustworthy source: the session was
    // created by a server holding a secret key, and this form was filled in by
    // a browser.
    externalId: v.text(session.customer_external_id, 120) || v.text(raw.external_id, 120),
  };

  if (fields.includes("name") && !buyer.name) errors.name = "Required.";
  if (needsTaxId && !buyer.document) {
    errors.document = raw.document ? "This does not look like a valid CPF or CNPJ." : "Required.";
  }
  if (fields.includes("phone") && !buyer.phone) {
    errors.phone = raw.phone ? "Include the area code." : "Required.";
  }
  if ((fields.includes("address") || needsAddress) && (!buyer.postalCode || !buyer.addressNumber)) {
    if (!buyer.postalCode) errors.postal_code = "Required.";
    if (!buyer.addressNumber) errors.address_number = "Required.";
  }

  if (Object.keys(errors).length) {
    throw badRequest("Some details need fixing.", errors);
  }
  return buyer;
}

// Card validation happens here, before the gateway is called, so an obvious
// typo costs no request and the buyer is never told "your bank declined" about
// something no bank ever saw.
function validateCard(raw) {
  const card = raw && typeof raw === "object" ? raw : {};
  const errors = {};

  const number = v.digitsOnly(card.number);
  if (!v.isValidCardNumber(number)) errors.number = "Check the card number.";

  const holder = v.text(card.holder_name || card.holderName, 80);
  if (!holder || !holder.includes(" ")) errors.holder_name = "Enter the full name on the card.";

  const expiry = v.cardExpiry(card.expiry);
  if (!expiry) errors.expiry = "Check the expiry date.";

  const cvv = v.cardCvv(card.cvv);
  if (!cvv) errors.cvv = "Check the security code.";

  if (Object.keys(errors).length) {
    // The message names fields, never values. An error string must never be
    // able to carry a card number into a log.
    throw badRequest("Check the card details.", errors);
  }

  return { number, holderName: holder, expiry: card.expiry, cvv, brand: v.cardBrand(number) };
}

// Calls the gateway and records what came back.
async function chargeOrder({ merchant, order, customer, card, method, session }) {
  const gateway = await getGateway({
    merchantId: merchant.id,
    method,
    livemode: order.livemode,
    currency: order.currency,
  });

  const description = await describeOrder(merchant.id, order);
  let charge;
  try {
    const { customerId } = await gateway.ensureCustomer(customer);
    charge = await gateway.createCharge({
      order: {
        id: order.id,
        publicId: order.public_id,
        amountCents: order.amount_cents,
        currency: order.currency,
        description,
        installments: order.installments,
        method,
        remoteIp: order.remote_ip,
        statementName: merchant.statement_name,
      },
      customer,
      customerId,
      card,
    });
  } catch (err) {
    // The gateway could not be reached, or answered something unusable. The
    // order stays pending and the buyer is told to try again. It is NOT marked
    // refused: we do not know that it was.
    await recordCharge(merchant.id, order, { gateway: gateway.name, status: "error", detail: err.message });
    console.error(`[orders] Charge failed for ${order.public_id}:`, scrub(err.message));
    throw gatewayError("The payment could not be started. Please try again in a moment.");
  }

  await db.query(
    `update orders
        set gateway = $3, gateway_charge_id = $4, card_token = $5, card_brand = $6,
            card_last4 = $7, pix_qr_base64 = $8, pix_copy_paste = $9, pix_expires_at = $10,
            boleto_url = $11, boleto_barcode = $12, boleto_due_date = $13,
            refusal_reason = $14, redirect_url = $15, gateway_capture_id = $16,
            updated_at = now()
      where merchant_id = $1 and id = $2`,
    [
      merchant.id,
      order.id,
      gateway.name,
      charge.gatewayChargeId || null,
      charge.cardToken || null,
      charge.cardBrand || (card && card.brand) || null,
      charge.cardLast4 || (card ? card.number.slice(-4) : null),
      (charge.pix && charge.pix.qrCodeBase64) || null,
      (charge.pix && charge.pix.copyPaste) || null,
      (charge.pix && charge.pix.expiresAt) || null,
      (charge.boleto && charge.boleto.url) || null,
      (charge.boleto && charge.boleto.barcode) || null,
      (charge.boleto && charge.boleto.dueDate) || null,
      charge.refusalReason ? scrub(String(charge.refusalReason)).slice(0, 300) : null,
      // Where the buyer has to go to finish, for a gateway that takes over.
      (charge.redirect && charge.redirect.url) || null,
      charge.captureId || null,
    ]
  );

  await recordCharge(merchant.id, order, {
    gateway: gateway.name,
    gatewayChargeId: charge.gatewayChargeId,
    status: charge.status,
  });

  const fresh = await findById(merchant.id, order.id);

  // A card that approved immediately is paid now. Pix and boleto are pending
  // until the gateway says otherwise.
  if (charge.status === "paid") {
    await markStatus(merchant.id, order.id, "paid", `gateway:${gateway.name}:sync`);
  } else if (charge.status === "refused") {
    await markStatus(merchant.id, order.id, "refused", `gateway:${gateway.name}:sync`);
  } else {
    await emitOrderEvent(merchant.id, fresh, "order.created");
  }

  if (session) {
    if (charge.status === "refused") {
      // A DECLINE DOES NOT END THE CHECKOUT. The buyer reaches for another
      // card, and the session has to still be there when they do. Closing it
      // here meant a wrong security code was the end of the sale.
      //
      // The claim is released too, or the retry would be told that a payment
      // is already being processed.
      await sessions.releaseClaim(merchant.id, session.id);
    } else {
      await sessions.markCompleted(merchant.id, session.id, order.id);
      await emitSessionEvent(merchant.id, session, "checkout.session.completed", order);

      // The coupon is counted HERE, when an order exists, rather than when a
      // code was typed. Counting on every attempt let one buyer trying three
      // codes burn three redemptions of a limited coupon, and an abandoned
      // cart burn one forever.
      if (session.coupon_code) {
        await require("./coupons").registerRedemption(merchant.id, session.coupon_code);
      }

      // Taking this cart off the abandoned list can happen after the buyer has
      // their answer. It is accessory work, and it is registered rather than
      // dropped so a shutdown or a test can wait for it.
      inBackground(() =>
        ctx.withMerchant(merchant.id, () =>
          require("./carts").markRecovered(merchant.id, session.id)
        )
      );
    }
  }

  return findById(merchant.id, order.id);
}

// What the buyer sees on their statement and in the gateway's dashboard.
async function describeOrder(merchantId, order) {
  const items = await itemsOf(merchantId, order.id);
  if (!items.length) return `Order ${order.public_id}`;
  if (items.length === 1) return items[0].description;
  return `${items[0].description} and ${items.length - 1} more`;
}

async function recordCharge(merchantId, order, { gateway, gatewayChargeId = null, status, detail = null }) {
  await db.query(
    `insert into charges
       (merchant_id, order_id, gateway, gateway_charge_id, status, amount_cents, currency, detail)
     values ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      merchantId,
      order.id,
      gateway,
      gatewayChargeId,
      status,
      order.amount_cents,
      order.currency,
      // Scrubbed before it is stored. A gateway's error message is text we
      // did not write, and it lands on this row and in the log. If one of them
      // ever echoes back what was sent, this is the only thing between that
      // and a card number in the database.
      detail ? scrub(String(detail)).slice(0, 2000) : null,
    ]
  );
}

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------

// The one place an order's status changes.
//
// Idempotent by design: a transition that is not allowed from the current
// status is ignored and reported as unchanged. Gateways resend and reorder,
// and every one of those resends arrives here.
async function markStatus(merchantId, orderId, newStatus, source = "unknown") {
  if (!STATUSES.includes(newStatus)) throw new Error(`Unknown order status: ${newStatus}`);

  const order = await findById(merchantId, orderId);
  if (!order) throw notFound("Order not found.");
  if (order.status === newStatus) return { changed: false, order };

  const allowed = ALLOWED_TRANSITIONS[order.status] || [];
  if (!allowed.includes(newStatus)) {
    console.warn(
      `[orders] Ignored ${order.status} -> ${newStatus} on ${order.public_id} (from ${source}).`
    );
    return { changed: false, order };
  }

  const timestamps = [];
  const params = [merchantId, orderId, newStatus];
  if (newStatus === "paid") timestamps.push("paid_at = now()");
  if (newStatus === "refunded") timestamps.push("refunded_at = now()");

  const result = await db.query(
    `update orders
        set status = $3, updated_at = now()${timestamps.length ? ", " + timestamps.join(", ") : ""}
      where merchant_id = $1 and id = $2 and status = $4
      returning *`,
    [...params, order.status]
  );
  // Lost the race to another request handling the same notification. Not an
  // error: the other one did the work, and doing it twice is what we are
  // avoiding.
  if (!result.rows[0]) return { changed: false, order: await findById(merchantId, orderId) };

  const updated = result.rows[0];
  const eventType = {
    paid: "order.paid",
    refused: "order.refused",
    refunded: "order.refunded",
    chargeback: "order.chargeback",
    expired: "order.expired",
  }[newStatus];
  if (eventType) await emitOrderEvent(merchantId, updated, eventType);

  // A paid subscription-mode order becomes a recurring commitment. This runs
  // here, in the one place a status changes, rather than at the end of the
  // charge: a Pix paid two minutes later has to create the subscription too,
  // and that path never passes through the charge function again.
  if (newStatus === "paid" && updated.session_id) {
    await maybeStartSubscription(merchantId, updated);
  }

  return { changed: true, order: updated };
}

// THE ONE CLICK CHARGE, for an upsell or a downsell.
//
// It is a SEPARATE order against the credential the first sale produced, not
// an edit of the first charge. The first one is already authorized and may
// already be settled, and no gateway offers "charge that again for a different
// amount".
//
// Two things make it safe to call from a page somebody can refresh:
//   1. An offer already answered on this funnel is refused, which is why a
//      decline is recorded as a row rather than forgotten.
//   2. The child order is created before the charge, so a crash in between
//      leaves a row that the stranded-order sweep closes.
async function acceptOffer({ merchant, parentOrder, offer, remoteIp = null }) {
  const merchantId = merchant.id;
  const offers = require("./offers");

  if (!orderCanFunnel(parentOrder)) {
    throw conflict("This order cannot take a one click charge.");
  }

  const rootId = parentOrder.parent_order_id || parentOrder.id;
  const existing = await offers.alreadyTaken(merchantId, rootId, offer.id);
  if (existing) {
    // Not an error: a refreshed page, or a double tap. The answer is the order
    // that already exists.
    return findById(merchantId, existing.id);
  }

  const customer = await customers.findById(merchantId, parentOrder.customer_id);
  if (!customer) throw conflict("The customer record for this order is gone.");

  const child = await db.transaction(async (client) => {
    const inserted = await client.query(
      `insert into orders
         (merchant_id, public_id, livemode, customer_id, kind, parent_order_id, offer_id,
          status, payment_method, installments, currency, amount_cents,
          gateway, card_token, checkout_token, external_reference, metadata, remote_ip)
       values ($1, $2, $3, $4, $5, $6, $7, 'pending', 'card', 1, $8, $9, $10, $11, $12, $13, $14, $15)
       returning *`,
      [
        merchantId,
        ids.publicId("order"),
        parentOrder.livemode,
        parentOrder.customer_id,
        offer.kind,
        rootId,
        offer.id,
        offer.currency,
        offer.unit_amount_cents,
        parentOrder.gateway,
        parentOrder.card_token,
        randomUrlToken(24),
        parentOrder.external_reference,
        parentOrder.metadata,
        remoteIp,
      ]
    );
    const row = inserted.rows[0];

    await client.query(
      `insert into order_items
         (merchant_id, order_id, kind, product_id, price_id, description,
          quantity, unit_amount_cents, amount_cents)
       values ($1, $2, $3, $4, $5, $6, 1, $7, $7)`,
      [
        merchantId,
        row.id,
        offer.kind,
        offer.product_id,
        offer.offer_price_id,
        offer.title,
        offer.unit_amount_cents,
      ]
    );
    return row;
  });

  let charge;
  try {
    const gateway = await getGateway({
      merchantId,
      gateway: parentOrder.gateway,
      livemode: parentOrder.livemode,
      currency: offer.currency,
    });
    const { customerId } = await gateway.ensureCustomer(customer);
    charge = await gateway.chargeWithToken({
      order: {
        id: child.id,
        publicId: child.public_id,
        amountCents: child.amount_cents,
        currency: child.currency,
        description: offer.title,
        installments: 1,
        method: "card",
        remoteIp,
      },
      customer,
      customerId,
      cardToken: parentOrder.card_token,
    });
  } catch (err) {
    console.error(`[orders] One click charge failed for ${child.public_id}:`, scrub(err.message));
    await recordCharge(merchantId, child, {
      gateway: parentOrder.gateway,
      status: "error",
      detail: err.message,
    });
    // Closed rather than left pending: nothing is coming for a charge that
    // never reached the gateway, and a pending row would show the merchant a
    // sale that looks like it is still on its way.
    await db.query(
      `update orders set status = 'canceled', refusal_reason = $3, updated_at = now()
        where merchant_id = $1 and id = $2 and status = 'pending'`,
      [merchantId, child.id, "The payment could not be started."]
    );
    throw gatewayError("The payment could not be completed. Nothing extra was charged.");
  }

  await db.query(
    `update orders
        set gateway_charge_id = $3, refusal_reason = $4, card_brand = $5, card_last4 = $6,
            updated_at = now()
      where merchant_id = $1 and id = $2`,
    [
      merchantId,
      child.id,
      charge.gatewayChargeId || null,
      charge.refusalReason ? scrub(String(charge.refusalReason)).slice(0, 300) : null,
      parentOrder.card_brand || null,
      parentOrder.card_last4 || null,
    ]
  );
  await recordCharge(merchantId, child, {
    gateway: parentOrder.gateway,
    gatewayChargeId: charge.gatewayChargeId,
    status: charge.status,
  });

  if (charge.status === "paid") {
    await markStatus(merchantId, child.id, "paid", "funnel:one-click");
  } else if (charge.status === "refused") {
    await markStatus(merchantId, child.id, "refused", "funnel:one-click");
  } else {
    await emitOrderEvent(merchantId, await findById(merchantId, child.id), "order.created");
  }

  return findById(merchantId, child.id);
}

// Records that an offer was declined, so it is not offered again on a refresh.
//
// Nothing is charged, so there is no money here. The decline lives as a zero
// amount canceled row, which makes "already answered" one question with one
// answer instead of two.
async function declineOffer({ merchant, parentOrder, offer }) {
  const merchantId = merchant.id;
  const rootId = parentOrder.parent_order_id || parentOrder.id;

  const existing = await require("./offers").alreadyTaken(merchantId, rootId, offer.id);
  if (existing) return findById(merchantId, existing.id);

  const result = await db.query(
    `insert into orders
       (merchant_id, public_id, livemode, customer_id, kind, parent_order_id, offer_id,
        status, currency, amount_cents, checkout_token, refusal_reason)
     values ($1, $2, $3, $4, $5, $6, $7, 'canceled', $8, 0, $9, 'Declined by the buyer.')
     returning *`,
    [
      merchantId,
      ids.publicId("order"),
      parentOrder.livemode,
      parentOrder.customer_id,
      offer.kind,
      rootId,
      offer.id,
      offer.currency,
      randomUrlToken(24),
    ]
  );
  return result.rows[0];
}

// Can this order carry a one click charge? It needs a saved credential and a
// gateway that will honour it.
function orderCanFunnel(order) {
  if (!order || !order.card_token || !order.gateway) return false;
  if (!TERMINAL_PAID.includes(order.status)) return false;
  const { isDemo } = require("../config");
  if (isDemo()) return true;
  const { capabilitiesOf } = require("../gateways");
  return capabilitiesOf(order.gateway).supportsRecurring;
}

// Starts the subscription behind a paid subscription-mode order, if there is
// one. Never throws: the sale already succeeded, and a bookkeeping failure
// here must not look like a failed payment.
async function maybeStartSubscription(merchantId, order) {
  try {
    const result = await db.query(
      `select * from checkout_sessions where merchant_id = $1 and id = $2`,
      [merchantId, order.session_id]
    );
    const session = result.rows[0];
    if (!session || session.mode !== "subscription") return null;

    const subscriptions = require("./subscriptions");
    return await subscriptions.createFromPaidOrder({ merchantId, order, session });
  } catch (err) {
    console.error(
      `[orders] Could not start the subscription for ${order.public_id}:`,
      err && err.message
    );
    return null;
  }
}

// Asks the gateway what the state is, server to server, and applies it.
//
// This is the second of the only two things that may mark a sale paid, and it
// is what makes a missed webhook survivable. A gateway that cannot be reached
// is NEVER read as paid: the call throws and the order stays as it was.
async function reconcile(merchantId, order) {
  if (!order.gateway || !order.gateway_charge_id) return { status: order.status, changed: false };
  if (TERMINAL_PAID.includes(order.status)) return { status: order.status, changed: false };

  const gateway = await getGateway({
    merchantId,
    gateway: order.gateway,
    livemode: order.livemode,
  });

  let remote;
  try {
    remote = await gateway.getChargeStatus(order.gateway_charge_id);
  } catch (err) {
    console.error(`[orders] Could not read ${order.public_id} from ${order.gateway}:`, err.message);
    return { status: order.status, changed: false, unreachable: true };
  }

  if (!remote || !remote.status || remote.status === order.status) {
    return { status: order.status, changed: false };
  }

  // THE AMOUNT CHECK, the same rule the webhook applies.
  //
  // It lived only on the webhook path, and this is the path a Pix actually
  // takes: the page polls, the server asks the gateway, and whatever came back
  // was believed. A charge settled for less than the order would have released
  // the product at the buyer's chosen price.
  //
  // A null amount means the gateway cannot give a comparable figure, for
  // instance a per-instalment value, and that is not a mismatch.
  if (
    remote.status === "paid" &&
    remote.amountCents != null &&
    Number(remote.amountCents) !== Number(order.amount_cents)
  ) {
    console.error(
      `[orders] Amount mismatch on ${order.public_id}: ` +
        `${order.gateway} reports ${remote.amountCents}, order is ${order.amount_cents}.`
    );
    return { status: order.status, changed: false, amountMismatch: true };
  }

  const { changed, order: updated } = await markStatus(
    merchantId,
    order.id,
    remote.status,
    `gateway:${order.gateway}:query`
  );
  return { status: updated.status, changed };
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

// The payload an integrator receives. Defined once, so a column rename cannot
// change the contract, and so one place decides what is and is not exposed.
async function toEventPayload(merchantId, order) {
  const [items, customer] = await Promise.all([
    itemsOf(merchantId, order.id),
    order.customer_id ? customers.findById(merchantId, order.customer_id) : null,
  ]);

  return {
    order: {
      id: order.public_id,
      object: "order",
      status: order.status,
      livemode: order.livemode,
      kind: order.kind,
      currency: order.currency,
      amount_cents: order.amount_cents,
      discount_cents: order.discount_cents,
      coupon: order.coupon_code,
      payment_method: order.payment_method,
      installments: order.installments,
      card_brand: order.card_brand,
      card_last4: order.card_last4,
      gateway: order.gateway,
      refusal_reason: order.refusal_reason,
      external_reference: order.external_reference,
      metadata: catalog.parseMetadata(order.metadata),
      paid_at: order.paid_at,
      refunded_at: order.refunded_at,
      created_at: order.created_at,
      items: items.map((item) => ({
        kind: item.kind,
        description: item.description,
        quantity: item.quantity,
        unit_amount_cents: item.unit_amount_cents,
        amount_cents: item.amount_cents,
      })),
    },
    customer: customers.toApi(customer),
  };
}

async function emitOrderEvent(merchantId, order, type) {
  try {
    const data = await toEventPayload(merchantId, order);
    const event = await events.record(merchantId, type, data, { livemode: order.livemode });
    await webhooksOut.enqueue(merchantId, event);
  } catch (err) {
    // The sale already happened. Failing to announce it must not undo it, and
    // the event log is the backstop that lets it be replayed.
    console.error(`[orders] Could not emit ${type} for ${order.public_id}:`, err && err.message);
  }
}

async function emitSessionEvent(merchantId, session, type, order = null) {
  try {
    const data = {
      session: sessions.toApi(session),
      order: order ? { id: order.public_id, status: order.status } : null,
    };
    const event = await events.record(merchantId, type, data, { livemode: session.livemode });
    await webhooksOut.enqueue(merchantId, event);
  } catch (err) {
    console.error(`[orders] Could not emit ${type}:`, err && err.message);
  }
}

// ---------------------------------------------------------------------------
// API and page shapes
// ---------------------------------------------------------------------------

function toApi(order, { items = null, customer = null } = {}) {
  if (!order) return null;
  const body = {
    id: order.public_id,
    object: "order",
    livemode: order.livemode,
    status: order.status,
    kind: order.kind,
    currency: order.currency,
    amount_cents: order.amount_cents,
    discount_cents: order.discount_cents,
    coupon: order.coupon_code,
    payment_method: order.payment_method,
    installments: order.installments,
    card_brand: order.card_brand,
    card_last4: order.card_last4,
    gateway: order.gateway,
    refusal_reason: order.refusal_reason,
    external_reference: order.external_reference,
    metadata: catalog.parseMetadata(order.metadata),
    paid_at: order.paid_at,
    refunded_at: order.refunded_at,
    created_at: order.created_at,
  };
  if (items) {
    body.items = items.map((item) => ({
      kind: item.kind,
      description: item.description,
      quantity: item.quantity,
      unit_amount_cents: item.unit_amount_cents,
      amount_cents: item.amount_cents,
    }));
  }
  if (customer) body.customer = customers.toApi(customer);
  return body;
}

// What the waiting page polls. Deliberately narrow: a page the buyer can see
// gets the state and the payment artefacts, and nothing else.
function toStatusView(order, { locale = "pt-BR" } = {}) {
  const pt = String(locale).toLowerCase().startsWith("pt");
  return {
    id: order.public_id,
    status: order.status,
    payment_method: order.payment_method,
    currency: order.currency,
    amount_cents: order.amount_cents,
    amount_formatted: money.formatMoney(order.amount_cents, order.currency, locale),
    installments: order.installments,
    refusal_reason: order.refusal_reason,
    pix: order.pix_copy_paste
      ? {
          copy_paste: order.pix_copy_paste,
          qr_base64: order.pix_qr_base64,
          expires_at: order.pix_expires_at,
        }
      : null,
    boleto: order.boleto_url
      ? { url: order.boleto_url, barcode: order.boleto_barcode, due_date: order.boleto_due_date }
      : null,
    // Set when the gateway takes the buyer away to finish, as PayPal does.
    // The page sends them there instead of showing a waiting screen, because
    // nothing will happen until they go.
    redirect_url: order.status === "pending" ? order.redirect_url || null : null,
    message:
      order.status === "paid"
        ? pt
          ? "Pagamento confirmado."
          : "Payment confirmed."
        : order.status === "refused"
        ? order.refusal_reason || (pt ? "O pagamento não foi autorizado." : "The payment was not authorized.")
        : null,
  };
}

module.exports = {
  STATUSES,
  ALLOWED_TRANSITIONS,
  TERMINAL_PAID,
  findById,
  findByPublicId,
  findByCharge,
  findByCaptureId,
  findByToken,
  itemsOf,
  list,
  createFromSession,
  validateBuyer,
  validateCard,
  maxInstallmentsForItems,
  markStatus,
  acceptOffer,
  declineOffer,
  orderCanFunnel,
  maybeStartSubscription,
  reconcile,
  toEventPayload,
  emitOrderEvent,
  emitSessionEvent,
  toApi,
  toStatusView,
};
