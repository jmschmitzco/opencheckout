# Roadmap

What is built, what is next, and what was deliberately left out. Anything
refused here is refused with a reason, because "not yet" and "never" are
different answers and an integrator deserves to know which one they got.

## Built

- Four real gateway adapters: Asaas, Pagar.me, Mercado Pago and PayPal, plus
  the simulated one. See `src/gateways/contract.md` for what each can do.
- Checkout sessions: the API, the hosted page, the embedded widget
- Server-side pricing, with line items from a catalogue or ad hoc
- Card with instalments, Pix, boleto, PayPal as method types
- The simulated gateway, which is also the reference adapter
- Subscriptions: trials, renewals, dunning with three retries, cancel at
  period end, resume
- Entitlements, answering from subscriptions and one-off purchases
- Customer portal with short-lived single-use links
- Coupons: percentage or fixed, redemption limits, once per customer
- Abandoned carts as events carrying a recovery link
- Outbound webhooks: HMAC signed, retried with backoff, auto-disabled after
  repeated failure, replayable from the event log
- Three-layer white label with a per-session brand override
- Multi-merchant isolation enforced at the query layer
- Test mode keys that cannot reach a real processor
- 150 tests against the real schema

## Next

### 1. Mercado Pago card payments

The adapter's card path is written. What is missing is on the page: Mercado
Pago requires the card to be tokenized in the BROWSER with their public key,
which needs their SDK loaded on the checkout, a content policy entry for it,
and a gateway-specific step before submit.

Until then `supportedMethods` leaves card out, so the method is never offered
through Mercado Pago rather than being offered and failing.

### 2. The merchant dashboard

Everything is on the API today, which is enough for a developer and not enough
for the person who actually owns the business. Needed: paste gateway
credentials, pick a theme, see orders and subscriptions, create coupons,
manage webhook endpoints and read delivery failures.

### 3. Order bump and post-purchase upsell

The `offers` table is in the schema and nothing reads it yet. Needed: the
checkbox inside the checkout that adds a bump to the order before it is
charged, and the one-click page after payment that charges an upsell against
the card token the first sale already produced.

The token side is already built, because subscription renewals use the same
`chargeWithToken` path. What is missing is the offer selection, the two routes
and the funnel state on the order.

### 4. Refunds and disputes

`POST /v1/orders/:id/refund`, partial and full, plus handling the dispute
notifications the gateways send. The order statuses and the transition table
already cover `refunded` and `chargeback`; what is missing is the route and
the adapter calls behind it.

### 5. Usage-based billing

Report usage against a subscription, bill it at period end. The pieces exist
(ad hoc line items, the renewal loop); what is missing is a meter and the
rollup.

## Deliberately not built

### Holding anybody's money

Each merchant plugs in their own processor credentials, and funds land in
their own account. Holding third-party funds is a regulated activity in most
jurisdictions, and a project someone else self-hosts is in no position to be
one. This is a design constraint, not a gap.

### Sending email

Abandoned carts emit `cart.abandoned` with a working recovery link, and the
integrator sends the message. Owning email would mean owning SMTP
configuration, sender domains, SPF, DKIM, bounce handling and deliverability
reputation inside somebody else's installation, and doing it worse than the
provider they already pay for. A message from their own domain also gets
opened more often.

### Proration on a plan change

Charging a partial period correctly is the kind of arithmetic a customer finds
on their statement when it is wrong. Today a plan change ends one subscription
and starts another. Proration is wanted, and it is wanted correct.

### A one-off fee alongside a subscription

A setup fee plus a recurring price means two charges and two refund paths.
Folding it into the first period would silently overcharge every renewal, so
the session creation refuses the combination out loud instead.

### Storing card numbers

Never. Cards go from the form to the adapter and stop there. What comes back
is a token, a brand and four digits.
