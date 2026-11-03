# Contributing

Issues and pull requests are welcome.

## Getting it running

```bash
npm install
```

```bash
npm run demo
```

No database, no API keys, nothing to configure: an in-memory PostgreSQL and a
simulated gateway. If that is not true for you after a clean clone, that is a
bug worth reporting on its own.

```bash
npm test
```

396 tests, no network. The exit code is meaningful, so trust it.

## What a change needs

**A change that touches money or the merchant guard needs a test that fails
without it.** Not a test that exercises the code: one that goes red if the fix
is reverted. Those two parts of the system are where a bug costs somebody real
money or shows them somebody else's customers.

Everything else needs a test if it reasonably can have one.

## House style

The code is in English. Comments explain **why**, not what: the what is already
on the line below. A comment that records a decision, a constraint or an
expensive lesson earns its place; one that narrates the code does not.

Some specific rules, each of which exists because its absence cost something:

- **Money is an integer number of cents.** Never a float, anywhere, including
  inside a gateway adapter. Convert at the gateway boundary and nowhere else.
- **A sale is paid only when the gateway says so**, through a verified webhook
  or a server-to-server query. A browser is never a source of truth, and a
  gateway that cannot be reached is never read as paid.
- **Card data is never logged or stored.** It goes from the form to the
  adapter and stops.
- **Every query names its merchant**, or declares why it cannot with
  `{ withoutMerchant: "reason" }`. The guard in `src/db/index.js` enforces it.
  A new escape needs a reason somebody else can check.
- **Everything from outside is data, not code.** Themes, metadata, redirect
  targets and coupon codes are validated against closed lists.
- **No CHECK constraints in the schema.** The in-memory database the tests use
  does not evaluate them the way Postgres does, and a rule that holds in one
  environment and not the other is worse than no rule. Validate in code, in one
  place, and cover it with a test.
- **No inline `<script>` on the checkout page.** The content policy forbids it,
  and that directive is the one doing the most work on a page where somebody
  types a card number. Configuration travels as `type="application/json"`.

## Writing a gateway adapter

`src/gateways/contract.md` is the specification and `src/gateways/demo.js` is a
complete worked example. The rules at the bottom of the contract are not
suggestions; each one is there because an integration broke without it.

Read the processor's current documentation when you map statuses. A status name
is the single thing most likely to have changed since anybody last looked.

## Audits

`docs/AUDITS.md` records three adversarial passes over this codebase: what was
wrong, why it mattered, and the test that stops it coming back. It is worth
reading before a first change, because most of it is about traps that are easy
to walk back into.

If you find something in that class, an issue describing how to reproduce it is
more useful than a quiet patch.
