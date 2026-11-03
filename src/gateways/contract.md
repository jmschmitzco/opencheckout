# Gateway adapter contract

Every file in `src/gateways/` except `index.js` exports a class built with the
credentials already resolved. An adapter never reads the environment and never
touches the database: `gateway-config.js` hands it what it needs. That is what
makes one testable without a database and what stops one merchant's sale being
charged to another merchant's key.

```js
class ExampleGateway {
  constructor(credentials) {}

  get name() {}              // 'asaas' | 'pagarme' | 'mercadopago' | 'paypal' | 'demo'
  get supportedMethods() {}  // ['pix', 'card', 'boleto']
  get supportsRecurring() {} // can a saved credential be charged again later

  // Creates or reuses the customer on the gateway's side. Returns the id the
  // gateway knows them by, or null when the gateway has no such concept.
  async ensureCustomer(customer) {}            // -> { customerId }

  // Creates a charge.
  //   order      { id, publicId, amountCents, currency, description,
  //                installments, method, remoteIp, statementName }
  //   customer   the row from `customers`
  //   customerId from ensureCustomer
  //   card       { number, holderName, expiry: 'MM/YY', cvv } for method 'card'
  //              NEVER logged, never stored, never echoed in an error
  async createCharge({ order, customer, customerId, card }) {}   // -> Charge

  // One click charge against a credential saved from an earlier sale. This is
  // what an upsell and a subscription renewal use.
  async chargeWithToken({ order, customer, customerId, cardToken }) {}  // -> Charge

  // Asks the gateway what the current state is. Server to server, always: this
  // is the only thing besides a verified webhook that may mark a sale paid.
  async getChargeStatus(gatewayChargeId) {}   // -> { status, paidAt }

  async refund(gatewayChargeId, { amountCents }) {}  // -> { ok, refundId }

  // Webhooks. `req` is the Express request, with req.rawBody available.
  verifyWebhook(req) {}  // -> boolean. Signature or shared token valid?
  parseWebhook(req) {}   // -> WebhookEvent | null
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
  // On 'refused': a sentence the buyer can act on. "Insufficient funds", not
  // "ERR_4091". The raw code belongs in the log.
  refusalReason: 'string' | undefined,
}
```

## Normalized status

`'pending' | 'paid' | 'refused' | 'expired' | 'refunded' | 'chargeback'`

Map the gateway's own vocabulary onto these. Read the gateway's current docs
when writing a mapping; do not trust memory for a status name.

## WebhookEvent

```js
{
  eventId: 'evt_123',        // the gateway's id, used to recognise a resend
  eventType: 'payment.paid', // the gateway's own name, for the log
  gatewayChargeId: 'ch_123',
  status: 'paid' | null,     // null when the event does not change state
  amountCents: 1990 | null,  // when present, checked against the order
  currency: 'BRL' | null,
}
```

## Rules

- Use the global `fetch`. The constructor accepts `credentials.fetchImpl` for
  tests, defaulting to `globalThis.fetch`.
- On an HTTP error from the gateway, throw with the status and the gateway's
  message, and nothing sensitive.
- Amount units differ per gateway. Asaas takes decimals, Pagar.me takes cents.
  Convert at the adapter boundary with `centsToDecimal` and nowhere else.
- Missing credentials throw a sentence a merchant can act on, naming the
  gateway and what is missing.
- A failure to reach the gateway is NEVER a paid sale. If `getChargeStatus`
  cannot answer, it throws; it does not guess.
