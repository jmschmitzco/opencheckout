# Gateway adapter contract

Every file in `src/gateways/` except `index.js` exports a class built with the
credentials already resolved. An adapter never reads the environment and never
touches the database: `gateway-config.js` hands it what it needs. That is what
makes one testable without a database, and what stops one merchant's sale being
charged to another merchant's key.

`demo.js` implements all of this and is the shortest complete example.

```js
class ExampleGateway {
  constructor(credentials) {}

  // ---- identity and capabilities -------------------------------------
  // These are read by building an adapter with NO credentials, so they must
  // not touch anything.
  get name() {}              // 'asaas' | 'pagarme' | 'mercadopago' | 'paypal' | 'demo'
  get supportedMethods() {}  // ['pix', 'card', 'boleto'] — what it can take TODAY
  get supportsRecurring() {} // can a saved credential be charged again later
  get usesRedirect() {}      // does the buyer leave to finish (PayPal)
  get statusFromQuery() {}   // does its webhook omit the status (Mercado Pago)

  // ---- customers ------------------------------------------------------
  // Creates or reuses the customer on the gateway's side. Returns the id the
  // gateway knows them by, or null when the gateway has no such concept.
  async ensureCustomer(customer) {}            // -> { customerId }

  // ---- charging -------------------------------------------------------
  //   order      { id, publicId, amountCents, currency, description,
  //                installments, method, remoteIp, statementName }
  //   customer   the row from `customers`
  //   customerId from ensureCustomer
  //   card       { number, holderName, expiry: 'MM/YY', cvv } for method 'card'
  //              NEVER logged, never stored, never echoed in an error
  async createCharge({ order, customer, customerId, card }) {}   // -> Charge

  // One click charge against a credential saved from an earlier sale. This is
  // what an upsell and a subscription renewal use. Throws where the gateway
  // does not allow it, and supportsRecurring says so in advance.
  async chargeWithToken({ order, customer, customerId, cardToken }) {}  // -> Charge

  // Only for usesRedirect gateways. Called when the buyer comes back. MUST be
  // safe to call twice: the return route and the webhook race by design.
  async captureIfApproved(gatewayChargeId) {}  // -> Capture

  // ---- reading and reversing -----------------------------------------
  // Server to server, always. This and a verified webhook are the only two
  // things that may mark a sale paid. If it cannot answer, it says pending or
  // throws; it never guesses.
  async getChargeStatus(gatewayChargeId) {}   // -> ChargeStatus

  async refund(idOrCaptureId, { amountCents, currency }) {}  // -> Refund

  // ---- webhooks -------------------------------------------------------
  // `req` is the Express request, with req.rawBody available. Both may be
  // async: PayPal fetches a certificate to verify.
  async verifyWebhook(req) {}  // -> boolean
  async parseWebhook(req) {}   // -> WebhookEvent | null
}
```

## Charge

```js
{
  gatewayChargeId: 'ch_123',
  status: 'pending' | 'paid' | 'refused',
  // Only on a card charge, and only when the gateway returns a reusable
  // credential. It is what makes an upsell one click and a renewal possible.
  cardToken: 'tok_123' | undefined,
  cardBrand: 'visa' | undefined,
  cardLast4: '4242' | undefined,
  pix: { qrCodeBase64, copyPaste, expiresAt } | undefined,  // no data: prefix
  boleto: { url, barcode, dueDate } | undefined,
  // For a usesRedirect gateway. The status is ALWAYS pending here: the buyer
  // has not approved anything yet, let alone paid.
  redirect: { url } | undefined,
  // On 'refused': a sentence the buyer can act on. "The security code is
  // incorrect", not "cc_rejected_bad_filled_security_code". The raw code
  // belongs in the log.
  refusalReason: 'string' | undefined,
}
```

## ChargeStatus

```js
{
  status: NormalizedStatus,
  paidAt: Date | string | null,
  // What ARRIVED, in cents, so the caller can compare it with the order
  // before releasing anything. null means "do not compare", which is the
  // honest answer when the gateway reports a per-instalment figure.
  amountCents: number | null,
  currency: 'BRL' | null,
}
```

## WebhookEvent

```js
{
  eventId: 'evt_123',        // the gateway's id, used to recognise a resend
  eventType: 'payment.paid', // the gateway's own name, for the log
  gatewayChargeId: 'ch_123' | null,
  // A second identifier, where the thing holding the money is not the thing
  // that was created. PayPal: the ORDER is created, the CAPTURE is paid.
  gatewayCaptureId: 'CAP_1' | null,
  // OUR order's public id, echoed back from whatever field the gateway
  // provides. THIS IS THE RESCUE PATH, not a convenience: see below.
  externalReference: 'ord_abc' | null,
  status: NormalizedStatus | null,  // null when the event changes nothing
  amountCents: number | null,
  currency: 'BRL' | null,

  // ---- money going back ------------------------------------------------
  // How much went back in THIS event. null means the gateway did not say,
  // which the caller reads as "match it against what we asked for" rather
  // than guessing an amount.
  refundedCents: number | null,
  // True on a partial refund, where `status` must NOT be 'refunded': the
  // buyer still has what they bought, so the order stays paid.
  partialRefund: boolean,
  // The gateway's own id for the refund, where it gives one. It is what makes
  // a resent notification recognisable as the same refund.
  gatewayRefundId: 'RE_1' | null,
  // On a chargeback: the gateway's dispute id, and its reason code or text.
  disputeId: 'DIS_1' | null,
  disputeReason: string | null,
}
```

## Refund

```js
{
  ok: true,
  refundId: 'RE_1' | null,
  // The gateway's own word for where the refund got to. ONLY 'DONE',
  // 'SUCCEEDED' or 'COMPLETED' is read as money that has moved; anything
  // else, including 'PENDING' and a missing value, leaves the refund waiting
  // for a notification. A request is not a refund: the gateway can still
  // refuse it, and a merchant told otherwise tells their buyer.
  refundStatus: 'DONE' | 'PENDING' | string | undefined,
  chargeStatus: NormalizedStatus | undefined,
}
```

A `refund` that cannot be performed THROWS. Returning something falsy and
leaving the caller to guess is how a failed refund becomes a refunded order.

## Normalized status

`'pending' | 'paid' | 'refused' | 'expired' | 'refunded' | 'chargeback'`

Map the gateway's own vocabulary onto these. Read the gateway's current docs
when writing a mapping; a status name is the thing most likely to have changed
since anybody last looked.

## Rules

- **An unknown status is `pending`, never `paid`.** A status the gateway adds
  tomorrow must not release a product today.
- **Send our public id on every creation**, in whatever field the gateway
  echoes back (`externalReference`, `code`, `custom_id`). If the response to a
  charge creation is lost in transit, the order has no charge id and the
  payment notification has no order: money in the merchant's account, an order
  pending forever, and nobody alerted. That field is the only way back.
- **Send an idempotency key on every creation.** A retry after our own timeout
  must not become a second charge on somebody's card.
- **With no webhook credential configured, `verifyWebhook` returns false**, in
  every environment, including development. Returning true outside production
  means a deploy that forgets an environment variable accepts any POST and lets
  anybody mark an order paid.
- **Where the signature covers a timestamp, check its age.** Otherwise a
  captured notification is valid forever.
- **A partial refund is not a refunded order.** Report it with
  `partialRefund: true` and the amount, and leave `status` alone. The caller
  adds it to the order's running total and decides from that whether the sale
  is reversed at all; an adapter that reports 'refunded' for half the money
  revokes an entitlement somebody still has.
- Use `fetchWithTimeout` from `lib/http`. A gateway that accepts a request and
  never answers must not hold a connection until the buyer gives up, and a
  timeout is reported as a timeout, never as a refusal.
- Amount units differ per gateway. Asaas takes decimal reais, Pagar.me takes
  cents, Mercado Pago takes a decimal string. Convert at the adapter boundary
  and nowhere else, with `centsToDecimal`.
- Missing credentials throw a sentence a merchant can act on, naming the
  gateway and what is missing.
- Never put card data, an API key or a token in a log line or an error message.

## What each gateway can do

| | Pix | Card | Boleto | Saved card | Redirect |
|---|---|---|---|---|---|
| Asaas | yes | yes | yes | yes | no |
| Pagar.me | yes | yes | yes | yes | no |
| Mercado Pago | yes | not yet | yes | no | no |
| PayPal | no | no | no | no | yes |

**Mercado Pago card** needs the card tokenized in the BROWSER with their public
key. That is a better design than sending a number to a server, and it means
the checkout page needs their SDK and a gateway-specific step before it
submits. `_cardPayment` is written and waiting; `supportedMethods` is the only
thing that changes the day the page tokenizes.

**Mercado Pago tokens are single use**, so there is no credential to charge
again: no renewals and no one-click upsells through it.

**PayPal** will not charge again without the buyer approving, so the same
applies. It is also the only redirect gateway, and the only one where the thing
that was created (an order) is not the thing that holds the money (a capture).
