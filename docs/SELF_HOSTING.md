# Self hosting

## Requirements

- Node 18 or newer
- PostgreSQL 13 or newer
- A domain with HTTPS. Not optional: the config refuses to start in production
  without an https `BASE_URL`, because card details over http is not a thing
  that happens here.

## Install

```bash
git clone https://github.com/jmschmitzco/opencheckout.git
cd opencheckout
npm ci --omit=dev
cp .env.example .env
```

Fill in `.env`:

```bash
# At least 32 characters. Generate once and keep it safe: it encrypts every
# gateway credential and webhook secret in the database, and changing it makes
# all of them unreadable.
APP_SECRET=$(openssl rand -hex 32)

DATABASE_URL=postgres://user:password@localhost:5432/opencheckout
BASE_URL=https://pay.yourcompany.com
NODE_ENV=production
```

Then:

```bash
npm run db:migrate
npm start
```

`GET /healthz` answers when it is up.

## Behind a reverse proxy

Every rate limit in the system counts per IP address, so the app has to see
the real one. Set `TRUSTED_PROXY_HOPS` to the number of proxies **you** run in
front of it:

| Setup | Value |
|---|---|
| Local development, no proxy | `0` |
| One reverse proxy (nginx, Caddy) | `1` |
| CDN in front of a reverse proxy | `2` |

Too high is worse than too low: a visitor can then spoof their own address by
sending the header themselves, and every per-IP limit becomes decoration.

Behind a CDN this matters more than it looks. CDNs answer from different edge
nodes, so without the right value the same person arrives as several addresses
and a limit of five attempts never closes, while unrelated people sharing an
edge can lock each other out.

An nginx location block:

```nginx
location / {
  proxy_pass http://127.0.0.1:3000;
  proxy_set_header Host $host;
  proxy_set_header X-Real-IP $remote_addr;
  proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
  proxy_set_header X-Forwarded-Proto $scheme;
}
```

## Docker

```yaml
services:
  db:
    image: postgres:16-alpine
    environment:
      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD:?set a password}
      POSTGRES_DB: opencheckout
    volumes:
      - pgdata:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U postgres"]
      interval: 5s
      retries: 10

  app:
    build: .
    environment:
      NODE_ENV: production
      APP_SECRET: ${APP_SECRET:?set a secret of 32 characters or more}
      BASE_URL: ${BASE_URL:?set the public https address}
      DATABASE_URL: postgres://postgres:${POSTGRES_PASSWORD}@db:5432/opencheckout
      TRUSTED_PROXY_HOPS: "1"
    depends_on:
      db:
        condition: service_healthy
    ports:
      - "3000:3000"

volumes:
  pgdata:
```

The `:?` syntax makes the stack refuse to start when a required variable is
missing, which is better than starting with a default nobody meant.

## Creating the first merchant

There is no signup page: this is infrastructure, and who may create a merchant
is your decision, not ours. Create one from a Node shell:

```js
const ctx = require("./src/db/merchant-context");
const merchants = require("./src/services/merchants");
const apiKeys = require("./src/services/api-keys");

const merchant = await ctx.withoutMerchant("bootstrapping the first merchant", () =>
  merchants.create({ name: "Your Company", statementName: "YOURCO" })
);

await ctx.withMerchant(merchant.id, async () => {
  await merchants.update(merchant.id, { allowedOrigins: ["yourcompany.com"] });
  const live = await apiKeys.create(merchant.id, { label: "Production", livemode: true });
  const test = await apiKeys.create(merchant.id, { label: "Test", livemode: false });
  console.log(live.key, test.key); // shown once, never again
});
```

`allowedOrigins` is your own domains. It decides two things: which sites may
frame the embedded widget, and which hosts a `success_url` may point at. The
second is what stops a stolen API key from redirecting paying customers
somewhere else, so fill it in before you go live.

## Gateway credentials

Credentials are encrypted with `APP_SECRET` before they are stored, and only a
mask is ever shown back.

```js
const gatewayConfig = require("./src/services/gateway-config");

await ctx.withMerchant(merchant.id, async () => {
  const { webhookToken } = await gatewayConfig.save({
    merchantId: merchant.id,
    gateway: "asaas",
    livemode: true,
    credentials: { apiKey: "..." },
  });
  console.log(`https://pay.yourcompany.com/gateway-webhooks/asaas/${webhookToken}`);
});
```

Configure that URL in the processor's dashboard. **The token in the path is not
decoration.** With every merchant using their own processor account, an
incoming notification's signature can only be verified with that merchant's
own key, and the verification happens before the order is found. The merchant
therefore has to come from the URL, because there is nothing else to look them
up by at that point.

## Running more than one instance

Three background loops run on a clock: webhook delivery, subscription renewals,
cart reminders and session expiry. All three pick their own rows and are safe
to repeat, but repeating them is wasted work. Run them on one instance:

```bash
OPENCHECKOUT_WORKER=0 npm start   # on every instance except one
```

## Backups

`pg_dump` on a schedule. The tables that cannot be reconstructed from anywhere
else are `orders`, `order_items`, `charges`, `subscriptions`,
`subscription_invoices` and `events`. Everything else can be recreated; those
are the financial record.

## Upgrading

```bash
git pull
npm ci --omit=dev
npm run db:migrate   # the schema is idempotent, so this is also the upgrade
npm start
```

## Single tenant installations

If the installation serves exactly one business, raw CSS in the theme becomes
reasonable, because there is no neighbour to attack:

```sql
update merchants set allow_custom_css = true where id = 1;
```

Leave it off on a shared installation. CSS from one merchant is a way to draw a
convincing fake form over a real one.
