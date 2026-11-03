# OpenCheckout

**A white label checkout you host yourself.** Create a checkout session from
your backend, send the customer to a page wearing your brand, get a signed
webhook back. One-off payments and subscriptions, with the money going straight
to your own payment processor account.

MIT licensed. Node, Express, EJS, plain CSS, PostgreSQL. No React, no build
step, no TypeScript, no vendor account required to run it.

---

## See it working in two commands

```bash
npm install
```

```bash
npm run demo
```

Open <http://localhost:3000/demo>. There is no database to set up and no API
key to obtain: the demo runs on an in-memory PostgreSQL and a simulated
gateway, so nothing leaves your machine and no real money can move.

- Card `4242 4242 4242 4242` approves, any future date and any CVV
- Card `4000 0000 0000 0002` declines
- Pix and boleto settle on their own after about 12 seconds

The demo prints an API key. Point curl at it:

```bash
curl -H "Authorization: Bearer sk_test_..." http://localhost:3000/v1/me
```

---

## Why this exists

Hosted checkouts are excellent and they are also a fork in the road: your
pricing page ends at somebody else's domain, wearing somebody else's design,
and your customers' payment history lives in an account you do not own.

Rolling your own is the other fork, and it is a longer road than it looks.
Server-side pricing, idempotency, webhook signatures, retry with backoff,
instalment floors, dunning, a customer portal, abandoned carts. None of it is
hard and all of it is work, and every one of those is a way to lose money
quietly when it is missing.

OpenCheckout is the second road with the work already done. Your processor
account, your domain, your brand, your database.

---

## How you integrate

Three ways, one core. They share the same session object, so you can start with
the first and move to another without changing your backend.

### 1. Redirect, which is what most people want

Your server creates a session and sends the customer to the URL it returns.

```js
const response = await fetch("https://pay.yoursaas.com/v1/checkout/sessions", {
  method: "POST",
  headers: {
    authorization: `Bearer ${process.env.OPENCHECKOUT_KEY}`,
    "content-type": "application/json",
    // Optional, and worth sending: a repeat with the same key returns the
    // first answer instead of creating a second session.
    "idempotency-key": crypto.randomUUID(),
  },
  body: JSON.stringify({
    mode: "payment",
    line_items: [{ price: "price_abc123", quantity: 1 }],
    success_url: "https://yoursaas.com/welcome",
    cancel_url: "https://yoursaas.com/pricing",
    customer_external_id: user.id,       // your own user id
    metadata: { plan: "pro" },           // comes back on every webhook
  }),
});

const session = await response.json();
res.redirect(session.url);
```

### 2. Embedded widget, when you do not want to leave the page

```html
<script src="https://pay.yoursaas.com/embed.js"></script>
<button data-opencheckout-url="<%= session.url %>">Subscribe</button>
```

Or drive it yourself:

```js
OpenCheckout.open({
  url: sessionUrl,
  onComplete: ({ orderId, status }) => grantAccess(orderId),
});
```

The widget is an iframe, which is the point: the card fields stay on the
checkout's own origin, so your page never touches card data and your stylesheet
cannot reach inside the form. Add your domains to the merchant's allowed
origins first, or the browser will refuse to frame it.

### 3. Headless

Every price, coupon, order, subscription and entitlement is on the API, and the
session is the only thing you are obliged to use. Build your own form against
`POST /c/:id/pay` if you want to, with the amounts still decided server side.

---

## How you find out it worked

The redirect is a convenience. **The authoritative answer is the webhook**,
because the customer's browser can be closed, refreshed or lied to.

```bash
curl -X POST https://pay.yoursaas.com/v1/webhook-endpoints \
  -H "Authorization: Bearer $KEY" \
  -H "content-type: application/json" \
  -d '{"url":"https://yoursaas.com/hooks/payments","events":["order.paid"]}'
```

The response carries a signing secret, once. Every delivery is signed:

```
OpenCheckout-Timestamp: 1793672100
OpenCheckout-Signature: sha256=<hmac of "timestamp.body">
OpenCheckout-Event: order.paid
```

Verify it before you trust it:

```js
const expected =
  "sha256=" +
  crypto.createHmac("sha256", process.env.WEBHOOK_SECRET)
    .update(`${req.get("OpenCheckout-Timestamp")}.${req.rawBody}`)
    .digest("hex");

if (!crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(req.get("OpenCheckout-Signature")))) {
  return res.sendStatus(400);
}
// Reject anything more than five minutes from your own clock.
```

A delivery that fails is retried five times over about a day. Everything that
ever happened is also readable at `GET /v1/events`, so a webhook you missed
while your server was down is something you can replay rather than reconcile.

### The question a SaaS actually asks

```bash
curl -H "Authorization: Bearer $KEY" \
  "https://pay.yoursaas.com/v1/entitlements?external_id=4821"
```

```json
{ "active": true, "items": [{ "product": "prod_abc", "status": "active", "current_period_end": "..." }] }
```

It answers from subscriptions and from one-off purchases, because plenty of
products sell lifetime access next to a monthly plan. An unknown customer is
not a 404; it is `"active": false`.

---

## White label

Themes resolve in three layers, most specific winning:

```
merchant default  ->  per product  ->  per checkout session
```

The third layer is the one that matters if you are a SaaS reselling to your
own customers: pass `branding` when you create the session and the page wears
**their** brand, without a merchant per customer.

```json
{
  "line_items": [{ "price": "price_abc" }],
  "success_url": "https://yoursaas.com/done",
  "branding": {
    "brand_name": "Globex",
    "logo_url": "https://cdn.globex.com/logo.svg",
    "accent": "#f59e0b",
    "page_bg": "#fffbeb",
    "font": "figtree",
    "template": "single",
    "radius_button": 999,
    "headline": "One last step",
    "submit_label": "Complete order"
  }
}
```

Colours, fonts, radii, three layouts, every piece of copy, which fields are
asked for, light or dark, and whether the attribution line shows. `GET
/v1/branding` returns the editable surface, so you can build your own theme
editor without reading this source.

**What a theme may not contain is as deliberate as what it may.** A colour must
be a hex triplet; a font must be on the list; a layout must be one of the known
words. Nothing from a theme reaches the page as raw CSS. This is the page where
somebody types a card number, and a colour field that accepted arbitrary text
would be a way to draw a convincing fake form over the real one. Raw CSS is
available, off by default, for single-tenant installations that accept the
trade.

---

## What it does

| | |
|---|---|
| Payments | Card with instalments, Pix, boleto, PayPal |
| Subscriptions | Trials, renewals, dunning with retries, cancel at period end |
| Entitlements | One call that answers "may this user in?" |
| Customer portal | Short-lived single-use link, no password to store |
| Coupons | Percentage or fixed, limits, once per customer |
| Abandoned carts | A `cart.abandoned` event with a working recovery link |
| White label | Three theme layers, per-session override |
| Multi-merchant | One installation, many businesses, enforced at the query layer |
| Test mode | `sk_test_` keys that never reach a real processor |

### What it deliberately does not do

- **Hold anybody's money.** Each merchant plugs in their own processor
  credentials and the money lands in their own account. Holding third-party
  funds is a regulated activity, and a self-hosted project is in no position
  to be one.
- **Send email.** Abandoned carts emit an event with a recovery link, and you
  send the message with the provider you already have. Owning deliverability,
  sender domains and bounce handling inside a project someone else hosts would
  be worse at the job than the tool you already pay for.
- **Prorate a plan change.** Charging a partial period correctly is a refund
  request when you get it wrong. Changing a plan today ends one subscription
  and starts another. See [docs/ROADMAP.md](docs/ROADMAP.md).

---

## Running it for real

```bash
cp .env.example .env     # fill in APP_SECRET, DATABASE_URL, BASE_URL
npm run db:migrate
npm start
```

Then add a merchant's processor credentials, which are encrypted with
`APP_SECRET` before they are written. Each gateway gets a callback URL with an
unguessable token in it; configure that URL in the processor's dashboard.

Full instructions, including Docker and the reverse proxy, are in
[docs/SELF_HOSTING.md](docs/SELF_HOSTING.md).

---

## The rules this code follows

Every one of these is here because the alternative loses money or leaks data.

1. **The server decides the price.** An order is priced from the stored
   session, never from the request body. The browser chooses a method and an
   instalment count; it never names an amount.
2. **A sale is paid only when the gateway says so**, through a verified
   webhook or a server-to-server status query. A browser is never a source of
   truth about payment. A gateway that cannot be reached is never read as paid.
3. **Card data is never logged or stored.** It goes from the form to the
   adapter and stops. What comes back is a token, a brand and four digits.
4. **Money is an integer number of cents.** A float turns 19.90 into
   19.899999999999999, and a hundred of those do not match the invoice.
5. **Every query names its merchant.** A query that touches an owned table
   without saying whose it is does not reach the database; it throws, with the
   SQL attached. One forgotten filter is one business reading another's
   customers.
6. **Everything from outside is data, not code.** Themes, metadata, redirect
   targets and coupon codes are all validated against closed lists before they
   are stored and again before they are rendered.

---

## Tests

```bash
npm test
```

150 tests against the real schema, in an in-memory PostgreSQL, with a simulated
gateway. No network, no credentials, and the exit code is meaningful.

---

## Contributing

Issues and pull requests are welcome. A change that touches money or the
merchant guard needs a test that fails without it.

## Licence

MIT. See [LICENSE](LICENSE).
