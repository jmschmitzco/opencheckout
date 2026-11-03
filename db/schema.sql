-- ============================================================================
-- OpenCheckout schema (PostgreSQL)
--
-- Idempotent: running it twice is safe.
--
-- Two rules shape every table here.
--
-- 1. MONEY IS ALWAYS AN INTEGER NUMBER OF CENTS, never a float. A float turns
--    19.90 into 19.899999999999999 and an invoice into a support ticket.
--
-- 2. ALMOST EVERY TABLE CARRIES merchant_id. One installation serves many
--    merchants, and the guard in src/db/index.js refuses any query that
--    touches an owned table without naming the merchant. See
--    src/db/owned-tables.js.
--
-- There are deliberately NO CHECK constraints. The in-memory database used by
-- the tests and by `npm run demo` (pg-mem) does not evaluate them reliably,
-- and a rule enforced in one environment but not the other is worse than no
-- rule at all. Every allowed value is validated in code, in one place, and
-- the test suite covers it.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- Merchants: one row per business using this installation. In a single
-- merchant self-hosted setup there is exactly one.
-- ---------------------------------------------------------------------------
create table if not exists merchants (
  id              serial primary key,
  public_id       text not null unique,          -- mer_...
  name            text not null,
  slug            text not null unique,
  -- How the charge shows up on the buyer's card statement. Buyers dispute what
  -- they do not recognise, so this is a revenue field, not a cosmetic one.
  statement_name  text,
  support_email   text,
  support_url     text,
  -- The merchant's OWN domains, comma separated. One list, used for two
  -- things, because both answer the same question: is this address yours?
  --   1. which origins may frame the checkout in the embedded widget
  --   2. which hosts a success_url or cancel_url may point at
  -- The second is what stops a stolen API key from redirecting paying
  -- customers to somebody else's page. Empty means "not restricted yet", which
  -- is the state a brand new installation is in; refusing everything until the
  -- list is filled in would block the first integration anybody attempts.
  allowed_origins text not null default '',
  -- Self-hosted single tenant installations may write raw CSS for their own
  -- checkout. Off by default: on a shared installation raw CSS from one
  -- merchant is a way to draw a fake form over a real one.
  allow_custom_css boolean not null default false,
  active          boolean not null default true,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- The people who sign in to the dashboard.
--
-- Email is unique across the whole installation, not per merchant: one login
-- belongs to one business. Letting the same address belong to two merchants
-- would mean a "which account?" step on every sign in, for a case almost
-- nobody has.
--
-- failed_attempts and locked_until are the brute force brake. They live on the
-- row rather than in memory because a restart must not clear them, and because
-- an attacker rotating IP addresses walks straight past any per-IP limit.
-- ---------------------------------------------------------------------------
create table if not exists merchant_users (
  id              serial primary key,
  merchant_id     integer not null references merchants(id) on delete cascade,
  email           text not null,
  name            text,
  password_hash   text not null,
  role            text not null default 'owner',
  last_login_at   timestamptz,
  failed_attempts integer not null default 0,
  locked_until    timestamptz,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
create unique index if not exists merchant_users_email_idx on merchant_users (email);
create index if not exists merchant_users_merchant_idx on merchant_users (merchant_id);

-- ---------------------------------------------------------------------------
-- API keys. The full key is shown ONCE, at creation. Only the SHA-256 lands in
-- the database, so a database leak hands out no usable key. The prefix is
-- stored in the clear just so the owner recognises the key in the dashboard,
-- the same way a card shows its last four digits.
--
-- kind = 'secret'      -> sk_live_... / sk_test_..., server side only
--        'publishable' -> pk_live_... / pk_test_..., safe in a browser, can
--                         only read a session it already holds the id of
-- ---------------------------------------------------------------------------
create table if not exists api_keys (
  id           serial primary key,
  merchant_id  integer not null references merchants(id) on delete cascade,
  public_id    text not null unique,             -- ak_...
  label        text not null default 'Integration',
  kind         text not null default 'secret',
  livemode     boolean not null default false,
  key_prefix   text not null,
  key_hash     text not null unique,
  active       boolean not null default true,
  last_used_at timestamptz,
  revoked_at   timestamptz,
  created_at   timestamptz not null default now()
);
create index if not exists api_keys_merchant_idx on api_keys (merchant_id);

-- ---------------------------------------------------------------------------
-- Gateway credentials, encrypted with APP_SECRET (AES-256-GCM).
--
-- One row per merchant, gateway and mode. webhook_token is the unguessable
-- part of the callback URL the gateway is configured with: it is what tells us
-- WHICH merchant an incoming notification belongs to, before any signature can
-- be checked, because the signature can only be verified with that merchant's
-- own key.
-- ---------------------------------------------------------------------------
create table if not exists gateway_credentials (
  id            serial primary key,
  merchant_id   integer not null references merchants(id) on delete cascade,
  gateway       text not null,                   -- asaas | pagarme | mercadopago | paypal | demo
  livemode      boolean not null default false,
  credentials   text,                            -- encrypted JSON
  webhook_token text not null unique,
  active        boolean not null default true,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create unique index if not exists gateway_credentials_unique_idx
  on gateway_credentials (merchant_id, gateway, livemode);

-- ---------------------------------------------------------------------------
-- Branding: the white label layer.
--
-- Themes resolve in three steps, most specific wins:
--   merchant default  ->  per product  ->  per checkout session override
--
-- The session override is what lets a SaaS resell the checkout to ITS own
-- customers, each with their own logo and colours, without creating a merchant
-- per customer.
--
-- `tokens` is JSON, and every value in it is validated by
-- src/services/branding.js before it is written and again before it is
-- rendered. Nothing from this column ever reaches the page as raw CSS or HTML.
-- ---------------------------------------------------------------------------
create table if not exists brand_themes (
  id          serial primary key,
  merchant_id integer not null references merchants(id) on delete cascade,
  scope       text not null default 'merchant',  -- merchant | product
  -- Zero, not null, for the merchant wide theme. A null here would make the
  -- unique index below useless, because Postgres treats two nulls as
  -- different values and would happily store two default themes.
  product_id  integer not null default 0,
  name        text,
  tokens      text not null default '{}',
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create unique index if not exists brand_themes_scope_idx
  on brand_themes (merchant_id, scope, product_id);

-- ---------------------------------------------------------------------------
-- Catalogue. A product is the thing being sold; a price is how much it costs,
-- in which currency, once or on a recurring basis. Splitting them is what lets
-- the same product carry a monthly price, a yearly price and a BRL price
-- without duplicating the product.
-- ---------------------------------------------------------------------------
create table if not exists products (
  id          serial primary key,
  merchant_id integer not null references merchants(id) on delete cascade,
  public_id   text not null unique,              -- prod_...
  name        text not null,
  description text,
  image_url   text,
  -- Free-form JSON the integrator gets back on every webhook. This is where a
  -- SaaS puts its own plan id.
  metadata    text not null default '{}',
  active      boolean not null default true,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index if not exists products_merchant_idx on products (merchant_id, active);

create table if not exists prices (
  id                serial primary key,
  merchant_id       integer not null references merchants(id) on delete cascade,
  product_id        integer not null references products(id) on delete cascade,
  public_id         text not null unique,        -- price_...
  currency          text not null default 'BRL',
  unit_amount_cents integer not null default 0,
  -- Anchor price, shown struck through next to the real one. Null hides it.
  compare_at_cents  integer,
  type              text not null default 'one_time',   -- one_time | recurring
  interval          text,                        -- day | week | month | year
  interval_count    integer not null default 1,
  trial_days        integer not null default 0,
  max_installments  integer not null default 1,
  active            boolean not null default true,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);
create index if not exists prices_product_idx on prices (merchant_id, product_id, active);

-- ---------------------------------------------------------------------------
-- Customers. `external_id` is the integrator's own user id, and it is the most
-- important column in this table: it is what lets a SaaS ask "is user 4821
-- paid?" without keeping a mapping of its own.
-- ---------------------------------------------------------------------------
create table if not exists customers (
  id             serial primary key,
  merchant_id    integer not null references merchants(id) on delete cascade,
  public_id      text not null unique,           -- cus_...
  external_id    text,
  email          text not null,
  name           text,
  document       text,                           -- CPF/CNPJ, digits only
  phone          text,
  postal_code    text,
  address_number text,
  country        text not null default 'BR',
  metadata       text not null default '{}',
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);
-- Email is stored already lowercased by src/services/customers.js, so a plain
-- index is enough. An expression index (lower(email)) would be equivalent on
-- real Postgres but is not supported by the in-memory database the tests use.
create unique index if not exists customers_merchant_email_idx on customers (merchant_id, email);
create index if not exists customers_external_idx on customers (merchant_id, external_id);

-- ---------------------------------------------------------------------------
-- Checkout sessions: the integration point.
--
-- The integrator's backend creates one, gets back a URL, and sends the buyer
-- there. Everything the page needs is frozen into the session at creation
-- time, including the amounts: the browser never gets to say what something
-- costs.
--
-- `client_secret` is what the page and the embedded widget authenticate with.
-- It is in the URL, so it is treated as a bearer token for exactly one
-- session and nothing else.
-- ---------------------------------------------------------------------------
create table if not exists checkout_sessions (
  id                 serial primary key,
  merchant_id        integer not null references merchants(id) on delete cascade,
  public_id          text not null unique,        -- cs_...
  livemode           boolean not null default false,
  mode               text not null default 'payment',  -- payment | subscription
  status             text not null default 'open',     -- open | completed | expired | canceled
  customer_id        integer references customers(id),
  customer_email     text,
  -- The integrator's own user id, carried from the API call that created the
  -- session through to the customer record. It is what lets them ask "is user
  -- 4821 paid?" later, and it has to survive the session because the buyer who
  -- pays may not have had a customer record when the session was made.
  customer_external_id text,
  -- Where the buyer lands after paying, and where "go back" points to. Both are
  -- validated against the merchant's allowed hosts when the session is created.
  success_url        text not null,
  cancel_url         text,
  -- Frozen snapshot of what is being sold, as JSON. Includes the price ids and
  -- the amounts resolved at creation time.
  line_items         text not null default '[]',
  currency           text not null default 'BRL',
  subtotal_cents     integer not null default 0,
  discount_cents     integer not null default 0,
  total_cents        integer not null default 0,
  coupon_code        text,
  allow_coupon       boolean not null default true,
  -- Order bumps the buyer ticked, as a JSON array of offer public ids.
  --
  -- They are priced separately from the line items, and added AFTER the
  -- discount, which is a deliberate choice rather than an accident of the
  -- arithmetic: a coupon is for the thing being sold, and a bump is an add-on
  -- the buyer chose after seeing the price. Halving it with a "50% off" code
  -- was never what the merchant meant by that code.
  accepted_bumps     text not null default '[]',
  bump_cents         integer not null default 0,
  payment_methods    text not null default 'pix,card,boleto',
  buyer_fields       text not null default 'name,document,phone',
  branding_override  text,
  locale             text not null default 'pt-BR',
  external_reference text,
  metadata           text not null default '{}',
  client_secret      text not null,
  order_id           integer,
  -- WHEN A CHARGE WAS CLAIMED ON THIS SESSION.
  --
  -- Two browser tabs is normal human behaviour, and without this both of them
  -- pass the "is it still open?" check and both charge the card. The claim is
  -- taken by a conditional UPDATE, so exactly one request wins, and it is
  -- released the moment a charge is refused so the buyer can fix their card
  -- and try again.
  --
  -- It goes stale on its own, because a process that dies mid-charge must not
  -- lock a session forever.
  charging_at        timestamptz,
  expires_at         timestamptz not null,
  created_at         timestamptz not null default now(),
  completed_at       timestamptz
);
create index if not exists checkout_sessions_merchant_idx on checkout_sessions (merchant_id, status, created_at desc);

-- ---------------------------------------------------------------------------
-- Orders. One per purchase attempt that reached the gateway.
--
-- `checkout_token` lets the thank-you page and the status poller read this one
-- order without an API key. It is random per order and grants nothing else.
-- ---------------------------------------------------------------------------
create table if not exists orders (
  id                 serial primary key,
  merchant_id        integer not null references merchants(id) on delete cascade,
  public_id          text not null unique,        -- ord_...
  livemode           boolean not null default false,
  session_id         integer,
  customer_id        integer references customers(id),
  kind               text not null default 'main',     -- main | upsell | downsell
  parent_order_id    integer,
  -- The offer this order came from, when it is an upsell or a downsell. It is
  -- what makes "has this offer already been taken?" answerable, which is what
  -- stops a refreshed one-click page from charging twice.
  offer_id           integer,
  status             text not null default 'pending',  -- pending | paid | refused | refunded | chargeback | expired | canceled
  payment_method     text,                        -- pix | card | boleto | paypal
  installments       integer not null default 1,
  currency           text not null default 'BRL',
  amount_cents       integer not null default 0,
  discount_cents     integer not null default 0,
  coupon_code        text,
  gateway            text,
  gateway_charge_id  text,
  -- A second identifier, for gateways where the thing that holds the money is
  -- not the thing that was created. PayPal is the case: the ORDER is what we
  -- create and the CAPTURE is what was paid, and a refund needs the capture.
  gateway_capture_id text,
  -- Where to send the buyer when the gateway takes over, as PayPal does. The
  -- order is pending until they come back and the capture succeeds.
  redirect_url       text,
  card_token         text,
  card_brand         text,
  card_last4         text,
  pix_qr_base64      text,
  pix_copy_paste     text,
  pix_expires_at     timestamptz,
  boleto_url         text,
  boleto_barcode     text,
  boleto_due_date    date,
  refusal_reason     text,
  checkout_token     text not null,
  external_reference text,
  metadata           text not null default '{}',
  remote_ip          text,
  user_agent         text,
  paid_at            timestamptz,
  refunded_at        timestamptz,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);
create index if not exists orders_merchant_idx on orders (merchant_id, status, created_at desc);
create index if not exists orders_charge_idx on orders (gateway, gateway_charge_id);
create index if not exists orders_customer_idx on orders (merchant_id, customer_id);
create index if not exists orders_funnel_idx on orders (merchant_id, parent_order_id, offer_id);

create table if not exists order_items (
  id                serial primary key,
  merchant_id       integer not null references merchants(id) on delete cascade,
  order_id          integer not null references orders(id) on delete cascade,
  kind              text not null default 'main',  -- main | bump | upsell | downsell
  product_id        integer,
  price_id          integer,
  description       text not null,
  quantity          integer not null default 1,
  unit_amount_cents integer not null default 0,
  amount_cents      integer not null default 0,
  created_at        timestamptz not null default now()
);
create index if not exists order_items_order_idx on order_items (merchant_id, order_id);

-- Every attempt against a gateway, successful or not. Orders keep the current
-- state; this table keeps the history, which is what reconciliation reads.
create table if not exists charges (
  id                serial primary key,
  merchant_id       integer not null references merchants(id) on delete cascade,
  order_id          integer not null references orders(id) on delete cascade,
  gateway           text not null,
  gateway_charge_id text,
  status            text not null default 'pending',
  amount_cents      integer not null default 0,
  currency          text not null default 'BRL',
  -- Gateway response with card data already stripped. Never store a PAN or CVV.
  detail            text,
  created_at        timestamptz not null default now()
);
create index if not exists charges_order_idx on charges (merchant_id, order_id);

-- ---------------------------------------------------------------------------
-- Subscriptions
-- ---------------------------------------------------------------------------
create table if not exists subscriptions (
  id                      serial primary key,
  merchant_id             integer not null references merchants(id) on delete cascade,
  public_id               text not null unique,  -- sub_...
  livemode                boolean not null default false,
  customer_id             integer not null references customers(id),
  product_id              integer,
  price_id                integer,
  status                  text not null default 'incomplete', -- incomplete | trialing | active | past_due | canceled | unpaid
  quantity                integer not null default 1,
  currency                text not null default 'BRL',
  amount_cents            integer not null default 0,
  interval                text not null default 'month',
  interval_count          integer not null default 1,
  current_period_start    timestamptz,
  current_period_end      timestamptz,
  trial_end               timestamptz,
  cancel_at_period_end    boolean not null default false,
  canceled_at             timestamptz,
  payment_method          text,
  gateway                 text,
  gateway_subscription_id text,
  card_token              text,
  attempt_count           integer not null default 0,
  next_attempt_at         timestamptz,
  external_reference      text,
  metadata                text not null default '{}',
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now()
);
create index if not exists subscriptions_merchant_idx on subscriptions (merchant_id, status);
create index if not exists subscriptions_customer_idx on subscriptions (merchant_id, customer_id);

create table if not exists subscription_invoices (
  id              serial primary key,
  merchant_id     integer not null references merchants(id) on delete cascade,
  subscription_id integer not null references subscriptions(id) on delete cascade,
  order_id        integer,
  period_start    timestamptz,
  period_end      timestamptz,
  status          text not null default 'pending',
  amount_cents    integer not null default 0,
  currency        text not null default 'BRL',
  created_at      timestamptz not null default now()
);
create index if not exists subscription_invoices_sub_idx on subscription_invoices (merchant_id, subscription_id);

-- ---------------------------------------------------------------------------
-- Coupons. The discount is ALWAYS recalculated on the server from this row;
-- the browser only ever sends the code the buyer typed.
-- ---------------------------------------------------------------------------
create table if not exists coupons (
  id              serial primary key,
  merchant_id     integer not null references merchants(id) on delete cascade,
  code            text not null,
  kind            text not null default 'percent',  -- percent | amount
  value           integer not null default 0,       -- percent: 1..100, amount: cents
  currency        text not null default 'BRL',
  max_redemptions integer,
  redemptions     integer not null default 0,
  once_per_email  boolean not null default false,
  expires_at      timestamptz,
  active          boolean not null default true,
  created_at      timestamptz not null default now()
);
-- Codes are stored uppercased by src/services/coupons.js, for the same reason
-- customers.email is stored lowercased.
create unique index if not exists coupons_merchant_code_idx on coupons (merchant_id, code);

-- ---------------------------------------------------------------------------
-- Offers: order bump (inside the checkout) and upsell/downsell (one click
-- after payment, reusing the saved card token).
-- ---------------------------------------------------------------------------
create table if not exists offers (
  id             serial primary key,
  merchant_id    integer not null references merchants(id) on delete cascade,
  public_id      text not null unique,            -- off_...
  trigger_product_id integer not null references products(id) on delete cascade,
  kind           text not null default 'bump',    -- bump | upsell | downsell
  offer_price_id integer not null references prices(id) on delete cascade,
  title          text not null,
  description    text,
  image_url      text,
  active         boolean not null default true,
  sort           integer not null default 0,
  created_at     timestamptz not null default now()
);
create index if not exists offers_trigger_idx on offers (merchant_id, trigger_product_id, kind, active);

-- ---------------------------------------------------------------------------
-- Outbound webhooks: how the integrator learns that money moved.
--
-- The body is signed so the receiver can confirm it came from here AND that it
-- is not a captured replay:
--   OpenCheckout-Timestamp: <unix seconds>
--   OpenCheckout-Signature: sha256=<hmac of "timestamp.body">
-- ---------------------------------------------------------------------------
create table if not exists webhook_endpoints (
  id          serial primary key,
  merchant_id integer not null references merchants(id) on delete cascade,
  public_id   text not null unique,               -- we_...
  url         text not null,
  secret      text not null,                      -- encrypted
  events      text not null default '',           -- comma separated, empty = all
  livemode    boolean not null default false,
  active      boolean not null default true,
  failures    integer not null default 0,
  disabled_at timestamptz,
  created_at  timestamptz not null default now()
);
create index if not exists webhook_endpoints_merchant_idx on webhook_endpoints (merchant_id, active);

create table if not exists webhook_deliveries (
  id               serial primary key,
  merchant_id      integer not null references merchants(id) on delete cascade,
  endpoint_id      integer not null references webhook_endpoints(id) on delete cascade,
  event_public_id  text not null,
  event_type       text not null,
  payload          text not null,
  status           text not null default 'pending',  -- pending | delivered | failed
  attempts         integer not null default 0,
  next_attempt_at  timestamptz not null default now(),
  last_status_code integer,
  last_error       text,
  created_at       timestamptz not null default now(),
  delivered_at     timestamptz
);
create index if not exists webhook_deliveries_pending_idx on webhook_deliveries (status, next_attempt_at);

-- Append only log of everything that happened, in the same shape the webhook
-- carries. An integrator that missed a webhook can replay from here.
create table if not exists events (
  id          serial primary key,
  merchant_id integer not null references merchants(id) on delete cascade,
  public_id   text not null unique,               -- evt_...
  type        text not null,
  livemode    boolean not null default false,
  payload     text not null default '{}',
  created_at  timestamptz not null default now()
);
create index if not exists events_merchant_idx on events (merchant_id, created_at desc);

-- ---------------------------------------------------------------------------
-- Inbound gateway notifications, kept only to recognise a repeat. Gateways
-- resend, and a resent "paid" must not pay twice.
-- ---------------------------------------------------------------------------
create table if not exists gateway_events (
  id          serial primary key,
  merchant_id integer,
  gateway     text not null,
  event_id    text not null,
  received_at timestamptz not null default now()
);
create unique index if not exists gateway_events_unique_idx on gateway_events (gateway, event_id);

-- ---------------------------------------------------------------------------
-- Idempotency for the routes that create money. A repeated POST (network
-- retry, double click, flaky mobile connection) must not charge twice.
-- ---------------------------------------------------------------------------
create table if not exists idempotency_keys (
  id          serial primary key,
  merchant_id integer,
  scope       text not null,
  key         text not null,
  status      text not null default 'processing',
  http_status integer,
  response    text,
  order_id    integer,
  created_at  timestamptz not null default now()
);
create unique index if not exists idempotency_keys_unique_idx on idempotency_keys (scope, key);

-- ---------------------------------------------------------------------------
-- Abandoned carts: whoever opened a session, gave an email and did not pay.
-- ---------------------------------------------------------------------------
create table if not exists abandoned_carts (
  id              serial primary key,
  merchant_id     integer not null references merchants(id) on delete cascade,
  session_id      integer not null,
  email           text not null,
  name            text,
  phone           text,
  currency        text not null default 'BRL',
  total_cents     integer not null default 0,
  status          text not null default 'open',   -- open | recovered | lost
  recovery_token  text not null,
  reminders_sent  integer not null default 0,
  last_reminder_at timestamptz,
  created_at      timestamptz not null default now(),
  recovered_at    timestamptz
);
create unique index if not exists abandoned_carts_session_idx on abandoned_carts (session_id);
create index if not exists abandoned_carts_due_idx on abandoned_carts (status, reminders_sent, created_at);

-- ---------------------------------------------------------------------------
-- Customer portal: a short lived, single use link the integrator mints for a
-- logged in user of its own. No password here, ever: the integrator already
-- knows who the user is, and asking again would mean storing credentials.
-- ---------------------------------------------------------------------------
create table if not exists portal_sessions (
  id          serial primary key,
  merchant_id integer not null references merchants(id) on delete cascade,
  customer_id integer not null references customers(id) on delete cascade,
  token       text not null unique,
  return_url  text,
  expires_at  timestamptz not null,
  used_at     timestamptz,
  created_at  timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Schema version marker, so an upgrade can tell what it is looking at.
-- ---------------------------------------------------------------------------
create table if not exists schema_versions (
  version    text primary key,
  applied_at timestamptz not null default now()
);
insert into schema_versions (version)
  values ('0.1.0') on conflict (version) do nothing;
