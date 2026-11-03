// The simulated gateway.
//
// It exists so that `npm run demo` and the whole test suite can exercise the
// real checkout, end to end, with no account anywhere and no network call. A
// project whose first run needs three API keys does not get a first run.
//
// It is also the reference implementation of the adapter contract: it is the
// shortest complete example of what a real adapter has to do.
//
// Nothing here is ever reachable in production. `getGateway` only returns it
// when demo mode is on, and `assertProductionConfig` refuses to start the
// server with demo mode set.
const { randomUrlToken } = require("../lib/crypto");
const v = require("../lib/validators");

// Module level, not per instance: `getGateway` builds a new adapter on every
// charge, and the simulated charges have to outlive the instance that made
// them, the way a real gateway's records do.
const charges = new Map();

// Test cards, chosen to match what every processor uses for the same purpose,
// so a developer's muscle memory works here too.
const CARDS = {
  "4242424242424242": { outcome: "paid" },
  "4000000000000002": { outcome: "refused", reason: "The card was declined." },
  "4000000000009995": { outcome: "refused", reason: "Insufficient funds." },
  "4000000000000069": { outcome: "refused", reason: "The card has expired." },
  "4000000000000127": { outcome: "refused", reason: "The security code is incorrect." },
};

// How long a simulated Pix or boleto takes to settle. Long enough to watch the
// waiting screen do its job, short enough that nobody walks away.
const SETTLE_AFTER_MS = 12_000;

// Renders a real QR image of the simulated Pix payload. Falls back to a 1x1
// transparent pixel if the encoder is unavailable, because a missing QR code
// must not take the demo down.
async function qrPngBase64(payload) {
  try {
    const QRCode = require("qrcode");
    const dataUrl = await QRCode.toDataURL(payload, { margin: 1, width: 440 });
    return dataUrl.replace(/^data:image\/png;base64,/, "");
  } catch {
    return "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=";
  }
}

class DemoGateway {
  constructor(credentials = {}) {
    this.credentials = credentials;
  }

  get name() {
    return "demo";
  }

  get supportedMethods() {
    return ["pix", "card", "boleto"];
  }

  // The simulated gateway takes anything, so a developer can exercise a
  // currency before they have an account that settles in it.
  get supportedCurrencies() {
    return null; // null means "no restriction"
  }

  get supportsRecurring() {
    return true;
  }

  async ensureCustomer(customer) {
    return { customerId: `demo_cus_${(customer && customer.id) || "anon"}` };
  }

  async createCharge({ order, card }) {
    const id = `demo_ch_${randomUrlToken(8)}`;

    if (order.method === "card") {
      const number = v.digitsOnly(card && card.number);
      const known = CARDS[number];
      // An unknown but well formed number approves. A developer trying their
      // own test data should see the happy path, not a dead end.
      const outcome = known ? known.outcome : "paid";

      if (outcome === "refused") {
        charges.set(id, { status: "refused", amountCents: order.amountCents, method: "card" });
        return {
          gatewayChargeId: id,
          status: "refused",
          refusalReason: known.reason,
        };
      }

      charges.set(id, { status: "paid", paidAt: new Date(), amountCents: order.amountCents, method: "card" });
      return {
        gatewayChargeId: id,
        status: "paid",
        // A reusable credential, which is what makes the one click upsell and
        // the subscription renewal possible. A real gateway returns a token
        // here; this one returns something that only means anything to itself.
        cardToken: `demo_tok_${randomUrlToken(8)}`,
        cardBrand: v.cardBrand(number),
        cardLast4: number.slice(-4),
      };
    }

    // Pix and boleto are born pending and settle on their own. The clock is
    // stored rather than a timer being set: a timer would fire into a process
    // that may already have moved on, and the status is read by polling
    // anyway, which is exactly how the real thing works.
    const settlesAt = new Date(Date.now() + SETTLE_AFTER_MS);
    charges.set(id, { status: "pending", settlesAt, amountCents: order.amountCents, method: order.method });

    if (order.method === "pix") {
      // A payload shaped like a real Pix string, and a REAL QR image of it.
      // A placeholder image here would make the demo look broken at the exact
      // moment someone is deciding whether this project works.
      const copyPaste = `00020126580014BR.GOV.BCB.PIX0136demo-${id}520400005303986540${(
        order.amountCents / 100
      ).toFixed(2)}5802BR5909OPENCHECK6009SAO PAULO62070503***6304DEMO`;

      return {
        gatewayChargeId: id,
        status: "pending",
        pix: {
          // Base64 with no data: prefix, which is what the contract specifies,
          // because a real gateway returns the bytes and the page decides how
          // to show them.
          qrCodeBase64: await qrPngBase64(copyPaste),
          copyPaste,
          expiresAt: new Date(Date.now() + 30 * 60 * 1000),
        },
      };
    }

    const dueDate = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000);
    return {
      gatewayChargeId: id,
      status: "pending",
      boleto: {
        url: `about:blank#demo-boleto-${id}`,
        barcode: "00190500954014481606906809350314337370000000100",
        dueDate: dueDate.toISOString().slice(0, 10),
      },
    };
  }

  async chargeWithToken({ order, cardToken }) {
    if (!cardToken) {
      return { gatewayChargeId: null, status: "refused", refusalReason: "No saved card." };
    }
    const id = `demo_ch_${randomUrlToken(8)}`;
    charges.set(id, { status: "paid", paidAt: new Date(), amountCents: order.amountCents, method: "card" });
    return { gatewayChargeId: id, status: "paid", cardToken };
  }

  async getChargeStatus(gatewayChargeId) {
    const charge = charges.get(gatewayChargeId);
    if (!charge) {
      // An id this gateway never issued. Not an error: a stale order from a
      // previous run of the in-memory database looks exactly like this.
      return { status: "pending", paidAt: null };
    }
    if (charge.status === "pending" && charge.settlesAt && charge.settlesAt <= new Date()) {
      charge.status = "paid";
      charge.paidAt = charge.settlesAt;
    }
    return { status: charge.status, paidAt: charge.paidAt || null };
  }

  // A refund, answered the way the real ones answer.
  //
  // A CARD refund comes back settled: the money is given back on the same
  // authorization, and the processor says so in the response. A Pix or boleto
  // refund is a NEW transfer to the buyer's bank, so it comes back pending and
  // is only confirmed later. The demo keeps that difference, because "asked"
  // and "done" are the whole point of the refunds screen and a demo where
  // everything settles instantly teaches the wrong lesson.
  async refund(gatewayChargeId, { amountCents = null } = {}) {
    const charge = charges.get(gatewayChargeId);
    if (!charge) throw new Error("This simulated gateway never issued that charge.");
    if (charge.status !== "paid") {
      throw new Error(`A charge that is ${charge.status} cannot be refunded.`);
    }

    const whole = amountCents == null || Number(amountCents) >= Number(charge.amountCents);
    charge.refundedCents = Number(charge.refundedCents || 0) + Number(amountCents == null ? charge.amountCents : amountCents);
    if (whole) charge.status = "refunded";

    return {
      ok: true,
      refundId: `demo_re_${randomUrlToken(6)}`,
      refundStatus: charge.method === "card" ? "DONE" : "PENDING",
      chargeStatus: charge.status,
    };
  }

  // The simulated gateway sends no webhooks, because there is nothing on the
  // other side to send them. Settlement is discovered by polling
  // getChargeStatus, which is the same path a real gateway's missed webhook
  // falls back to.
  verifyWebhook() {
    return false;
  }

  parseWebhook() {
    return null;
  }

  // ---------------------------------------------------------------------
  // Test helpers. Not part of the contract; a real adapter has no such thing.
  // ---------------------------------------------------------------------

  // Settles a pending charge immediately, so a test does not wait 12 seconds.
  static settleNow(gatewayChargeId) {
    const charge = charges.get(gatewayChargeId);
    if (!charge) return false;
    charge.status = "paid";
    charge.paidAt = new Date();
    charge.settlesAt = null;
    return true;
  }

  static reset() {
    charges.clear();
  }

  static get CARDS() {
    return CARDS;
  }
}

module.exports = DemoGateway;
