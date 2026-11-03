# Audits

Three adversarial passes over this codebase, each asking a different question.
Every finding below was reproduced, fixed, and given a regression test, so a
future change that reintroduces it fails the suite rather than a customer.

They are written down because the reasoning is the valuable part. A fix with
no record of what it prevents is a line somebody deletes next year.

| Audit | Question |
|---|---|
| 1. Money and charging | Can the system take the wrong amount, take it twice, or lose a sale? |
| 2. Security and isolation | Can one merchant reach another's data, or anyone forge anything? |
| 3. Contract and resilience | Does it behave as documented when things go wrong? |

---

## Audit 1: money and charging

Scope: the session pricing path, the charge path, status transitions,
reconciliation, coupons, subscriptions and the four gateway adapters.

### 1.1 Two tabs charged the card twice — critical

A charge checked `status === 'open'` and only closed the session after the
gateway answered. Two requests in that window both passed the check and both
charged. Two browser tabs, or a double tap on a phone, is ordinary behaviour,
and the idempotency key did not help because each tab generates its own.

**Fix.** A session is CLAIMED before anything is charged, with a conditional
update that only one request can win (`claimForCharge`). The claim goes stale
on its own after two minutes, so a process that dies mid-charge does not lock
a buyer out forever.

**Test.** `audit-money.test.js`, "two tabs pressing pay at the same time
produce ONE order".

### 1.2 A declined card ended the checkout — critical

The session was marked completed after any charge attempt, including a refused
one. A buyer who mistyped a security code found the link they were looking at
no longer worked, with no way back. This is the most expensive kind of bug in a
checkout: it converts a recoverable moment into a lost sale.

**Fix.** A refusal releases the claim and leaves the session open. Only a
charge that was not refused completes it.

**Test.** "the buyer can try another card on the same link".

### 1.3 A stale session row could overcharge — high

The request loaded the session at the start and priced the order from that
copy. A coupon applied a second earlier in another tab was ignored, so the
buyer saw the discounted price and was charged the full one.

**Fix.** The claim returns the row as it is now, and everything downstream uses
that row rather than the one the request arrived with.

**Test.** "a coupon applied in another tab is honoured".

### 1.4 A foreign currency could be charged as reais — high

Asaas, Pagar.me and Mercado Pago settle in BRL only. Nothing stopped a session
priced in USD from being routed to one of them, where the amount would be sent
as the same figure in reais: the right number at a completely different price.

**Fix.** Each adapter declares `supportedCurrencies`, the capability probe
reads it, and routing narrows by currency as well as by method. A merchant with
only Brazilian gateways is told, at session creation, that no method is
available for that currency.

**Test.** "a Brazilian gateway is never offered a foreign currency".

### 1.5 Polling could accept an underpayment — high

The amount check lived only on the webhook path. Polling, which is the path a
Pix actually takes, believed whatever the status query returned. A charge that
settled for less than the order would have released the product.

**Fix.** The same check now guards `reconcile`. A null amount still means "not
comparable", which is the honest answer for a per-instalment figure, and is not
treated as a mismatch.

**Test.** "a charge that settled for less is not marked paid".

### 1.6 Coupon redemptions were counted on every attempt — medium

A redemption was counted when a code was attached to a session and again every
time one was applied on the page. One buyer trying three codes burned three
redemptions of a limited coupon, and an abandoned cart burned one forever.

**Fix.** Counted once, when an order exists.

**Test.** "typing a code does not spend a redemption".

### 1.7 A failed renewal stranded a pending order — medium

A renewal creates the order row and then calls the gateway. When that call
threw, the subscription was marked past due but the order stayed pending
forever: a renewal that looks like it is still coming, and a row the
reconciliation loop keeps asking about.

**Fix.** The order is closed on that path.

**Test.** "does not leave an order pending forever".

### What this audit confirmed was already right

- Status transitions are a table, and an illegal move is ignored rather than
  applied. Out-of-order webhook delivery is normal traffic, and a late
  "pending" after a "paid" does not un-pay a sale.
- `markStatus` updates conditionally on the previous status, so two
  notifications racing cannot both apply.
- Money never touches a float, anywhere, including inside the adapters.
- An unreachable gateway is never read as paid, on any path.

---

## Audit 2: security and isolation

Scope: the multi-merchant guard, API key scope, every token in the system,
outbound requests, what gets written down, the content policy, and the one
cookie-authenticated surface.

### 2.1 Webhook endpoints were a server-side request forgery — high

A merchant registers a webhook URL and this installation POSTs to it. Nothing
checked where that address pointed, so `http://169.254.169.254/` reached the
cloud metadata service on a hosted install, and an internal host turned the
delivery record's status code into a port scanner with a dashboard.

The webhook feature is the most natural place for SSRF to appear in a payments
project, because sending a request to an address somebody else chose is the
entire point of it.

**Fix.** `lib/safe-url.js` refuses loopback, private, link-local and reserved
ranges, as literals and as the resolved address of a hostname, and refuses a
name that resolves to a public AND a private address. A single-tenant
installation that genuinely wants to reach its own network sets
`OPENCHECKOUT_ALLOW_PRIVATE_WEBHOOKS=1`.

**What it does not promise**, stated plainly in the file: it cannot close the
race between the check and the request. A deployment that needs that puts an
egress proxy in front of outbound traffic.

**Test.** `audit-security.test.js`, "outbound address guard", including a
public name that resolves somewhere private.

### 2.2 A gateway could have made us store a card number — medium

Card data goes from the form to the adapter and stops. That is our rule, and
it holds for our code. But a gateway's error message is text we did not write,
and it was stored on the charge row and printed to the log verbatim. A
processor that ever echoed back what was sent would have broken the rule on
our behalf.

**Fix.** `lib/scrub.js` strips card-shaped digit runs, API keys and labelled
security codes from anything on its way into the database or the log, and
drops whole fields whose name says they hold a card.

**Test.** "a declined charge stores no card digits".

### 2.3 Idempotency keys collided across merchants — medium

The key is chosen by the caller and the uniqueness was global. One merchant
picking `order-1` made another merchant's `order-1` return a conflict, or the
stored response of a request that was never theirs.

**Fix.** The scope is namespaced per merchant.

**Test.** "the same key used by two merchants does not collide".

### 2.4 A portal link could be used twice — low

`consume` checked `used_at` and then set it, which two requests arriving
together both pass. An email client that prefetches links does exactly that.

**Fix.** The claim is a conditional update that only one request wins.

**Test.** "a link cannot be used twice, even by two requests at once".

### 2.5 The portal's actions had one defence, not two — low

Cancelling a subscription is authenticated by a cookie, which makes it the
only cross-site request forgery surface here. `SameSite=lax` already stops the
cookie from riding a cross-site POST, and that is the real defence.

**Fix.** A second one, because it costs a function: a request that states an
Origin has to state ours.

**Test.** "a cross-site POST is refused".

### What this audit confirmed was already right

- **The merchant guard holds.** All nineteen declared escapes were reviewed
  one by one and every one is necessary: the tables that define ownership, the
  three lookups that DISCOVER a merchant from a token in a URL, the dedupe
  table that has no owner, and four background loops that open a per-row
  context immediately afterwards.
- A publishable key cannot create a session, list orders, read events or touch
  branding, and a revoked key stops working on the next request.
- The full API key is never stored; only its SHA-256 is.
- The checkout page carries no executable inline script, so
  `script-src 'self'` is a policy the page actually lives within rather than
  one it has to weaken. Its configuration travels as
  `type="application/json"`, which the browser does not execute.
- A session's secret is compared in constant time and is useless on any other
  session.
