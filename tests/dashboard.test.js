// The merchant dashboard.
//
// It is authenticated by a cookie and every page behind it changes money or
// configuration, so most of what is tested here is the wall rather than the
// rooms: who gets in, what a forged request can do, and whether one merchant
// can reach another's data through it.
const request = require("supertest");
const { createMemoryDb, seedMerchant, asMerchant } = require("./helpers/memdb");
const db = require("../src/db");
const password = require("../src/lib/password");

let app;
let one;
let two;
let merchantUsers;

const PASSWORD = "a-good-enough-passphrase";

beforeAll(async () => {
  createMemoryDb();
  one = await seedMerchant({ name: "One", slug: "one-dash" });
  two = await seedMerchant({ name: "Two", slug: "two-dash" });
  app = require("../src/app");
  merchantUsers = require("../src/services/merchant-users");

  await asMerchant(one.merchant.id, () =>
    merchantUsers.create({
      merchantId: one.merchant.id,
      email: "owner@one.test",
      name: "Owner One",
      plainPassword: PASSWORD,
    })
  );
  await asMerchant(two.merchant.id, () =>
    merchantUsers.create({
      merchantId: two.merchant.id,
      email: "owner@two.test",
      plainPassword: PASSWORD,
    })
  );
});

// Signs in and returns an agent that keeps the cookie, plus the CSRF token
// the forms on the page would carry.
async function signIn(email = "owner@one.test", secret = PASSWORD) {
  const agent = request.agent(app);
  const page = await agent.get("/dashboard/login");
  const token = (page.text.match(/name="_csrf" value="([^"]+)"/) || [])[1];

  const response = await agent
    .post("/dashboard/login")
    .type("form")
    .send({ email, password: secret, _csrf: token });

  // The token is regenerated on sign in, so it is read again afterwards.
  const after = await agent.get("/dashboard");
  const freshToken = (after.text.match(/name="_csrf" value="([^"]+)"/) || [])[1];
  return { agent, response, token: freshToken };
}

// ===========================================================================
describe("passwords", () => {
  test("a hash verifies and a wrong password does not", async () => {
    const stored = await password.hash("correct horse battery");
    expect((await password.verify("correct horse battery", stored)).ok).toBe(true);
    expect((await password.verify("correct horse batterx", stored)).ok).toBe(false);
  });

  test("the same password hashes differently every time", async () => {
    // Different salts. Equal hashes would mean two people with the same
    // password are visibly the same in a stolen dump.
    const a = await password.hash("correct horse battery");
    const b = await password.hash("correct horse battery");
    expect(a).not.toBe(b);
  });

  test("the stored format carries its own parameters", async () => {
    // So raising the cost later does not invalidate what is already stored.
    const stored = await password.hash("correct horse battery");
    expect(stored.startsWith("scrypt$")).toBe(true);
    expect(stored.split("$").length).toBe(6);
  });

  test("a hash written with a weaker cost still verifies, and asks to be upgraded", async () => {
    const weak = await (async () => {
      const crypto = require("node:crypto");
      const salt = crypto.randomBytes(16);
      const key = crypto.scryptSync("correct horse battery", salt, 32, { N: 1024, r: 8, p: 1 });
      return ["scrypt", 1024, 8, 1, salt.toString("base64"), key.toString("base64")].join("$");
    })();

    const result = await password.verify("correct horse battery", weak);
    expect(result.ok).toBe(true);
    expect(result.needsRehash).toBe(true);
  });

  test("a corrupt hash is a refusal, not a crash", async () => {
    for (const bad of ["", "nonsense", "scrypt$x$y$z$a$b", "bcrypt$1$2$3$4$5"]) {
      expect((await password.verify("anything", bad)).ok).toBe(false);
    }
  });

  test("length is what is asked for, not symbols", () => {
    // The rules that demand a symbol are the rules that produce "P@ssw0rd!".
    expect(password.problemWith("short")).toMatch(/at least 12/i);
    expect(password.problemWith("a-long-enough-passphrase")).toBeNull();
    expect(password.problemWith("P@ss1!")).toMatch(/at least 12/i);
    expect(password.problemWith("aaaaaaaaaaaaaaa")).toMatch(/same character/i);
    // Long enough, and still one of the first things an attacker types.
    expect(password.problemWith("123456789012")).toMatch(/first passwords/i);
    expect(password.problemWith("administrator")).toMatch(/first passwords/i);
  });
});

// ===========================================================================
describe("signing in", () => {
  test("the right password gets in", async () => {
    const { response } = await signIn();
    expect(response.status).toBe(302);
    expect(response.headers.location).toBe("/dashboard");
  });

  test("an unknown email and a wrong password say the SAME thing", async () => {
    // Telling them apart turns this form into a list of who has an account.
    const unknown = await signIn("nobody@nowhere.test", PASSWORD);
    const wrong = await signIn("owner@one.test", "wrong-but-long-enough");

    expect(unknown.response.status).toBe(401);
    expect(wrong.response.status).toBe(401);

    const message = (text) => (text.match(/d-flash--error[^>]*>\s*([^<]+)/) || [])[1].trim();
    expect(message(unknown.response.text)).toBe(message(wrong.response.text));
  });

  test("five wrong guesses lock the account", async () => {
    await asMerchant(one.merchant.id, () =>
      merchantUsers.create({
        merchantId: one.merchant.id,
        email: "locks@one.test",
        plainPassword: PASSWORD,
      })
    );

    for (let i = 0; i < merchantUsers.MAX_ATTEMPTS; i++) {
      await merchantUsers.authenticate("locks@one.test", "wrong-but-long-enough");
    }

    // Even the RIGHT password is refused while it is locked, which is the
    // whole point: the brake does not care who is typing.
    const result = await merchantUsers.authenticate("locks@one.test", PASSWORD);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("locked");
    expect(result.lockedMinutes).toBeGreaterThan(0);
  });

  test("the lock survives a restart, because it is on the row", async () => {
    const row = await db.query(`select locked_until from merchant_users where email = $1`, [
      "locks@one.test",
    ], { withoutMerchant: "reading the lock is the point of this test" });
    expect(row.rows[0].locked_until).toBeTruthy();
  });

  test("a correct password clears the count", async () => {
    await asMerchant(one.merchant.id, () =>
      merchantUsers.create({
        merchantId: one.merchant.id,
        email: "clears@one.test",
        plainPassword: PASSWORD,
      })
    );
    await merchantUsers.authenticate("clears@one.test", "wrong-but-long-enough");
    await merchantUsers.authenticate("clears@one.test", PASSWORD);

    const row = await db.query(
      `select failed_attempts from merchant_users where email = $1`,
      ["clears@one.test"],
      { withoutMerchant: "reading the attempt count is the point of this test" }
    );
    expect(row.rows[0].failed_attempts).toBe(0);
  });

  test("the redirect after signing in cannot be pointed off site", async () => {
    const { safeNext } = require("../src/routes/dashboard/auth");
    expect(safeNext("//evil.test")).toBe("/dashboard");
    expect(safeNext("https://evil.test")).toBe("/dashboard");
    expect(safeNext("/dashboard/orders")).toBe("/dashboard/orders");
    expect(safeNext("/c/cs_something")).toBe("/dashboard");
  });
});

// ===========================================================================
describe("the wall", () => {
  test("a signed out visitor is sent to the login page", async () => {
    for (const path of [
      "/dashboard",
      "/dashboard/orders",
      "/dashboard/settings/gateways",
      "/dashboard/settings/keys",
    ]) {
      const response = await request(app).get(path);
      expect(response.status).toBe(302);
      expect(response.headers.location).toMatch(/\/dashboard\/login/);
    }
  });

  test("the dashboard is never framed", async () => {
    const { agent } = await signIn();
    const response = await agent.get("/dashboard");
    expect(response.headers["x-frame-options"]).toBe("DENY");
  });

  test("a revoked account stops working on the next click", async () => {
    // The user is reloaded on every request rather than trusted from the
    // cookie, so this takes effect immediately.
    await asMerchant(one.merchant.id, () =>
      merchantUsers.create({
        merchantId: one.merchant.id,
        email: "gone@one.test",
        plainPassword: PASSWORD,
      })
    );
    const { agent } = await signIn("gone@one.test");
    expect((await agent.get("/dashboard")).status).toBe(200);

    await db.query(`delete from merchant_users where email = $1`, ["gone@one.test"], {
      withoutMerchant: "removing an account is the point of this test",
    });

    const after = await agent.get("/dashboard");
    expect(after.status).toBe(302);
  });
});

// ===========================================================================
describe("cross-site request forgery", () => {
  test("a POST with no token is refused", async () => {
    const { agent } = await signIn();
    const response = await agent.post("/dashboard/settings/keys").type("form").send({ label: "x" });
    expect(response.status).toBe(403);
  });

  test("a POST with somebody else's token is refused", async () => {
    const { agent } = await signIn();
    const other = await signIn("owner@two.test");
    const response = await agent
      .post("/dashboard/settings/keys")
      .type("form")
      .send({ label: "x", _csrf: other.token });
    expect(response.status).toBe(403);
  });

  test("a POST that says it came from another site is refused", async () => {
    const { agent, token } = await signIn();
    const response = await agent
      .post("/dashboard/settings/keys")
      .set("origin", "https://evil.test")
      .type("form")
      .send({ label: "x", _csrf: token });
    expect(response.status).toBe(403);
  });

  test("a POST with the right token goes through", async () => {
    const { agent, token } = await signIn();
    const response = await agent
      .post("/dashboard/settings/keys")
      .type("form")
      .send({ label: "Works", kind: "secret", mode: "test", _csrf: token });
    expect(response.status).toBe(302);
  });

  test("the refusal explains the likely cause instead of naming the mechanism", async () => {
    // "Invalid CSRF token" sends somebody hunting for a bug in their own form.
    // The real cause is almost always a page left open.
    const { agent } = await signIn();
    const response = await agent.post("/dashboard/settings/keys").type("form").send({ label: "x" });
    expect(response.text).toMatch(/expired|another site/i);
  });
});

// ===========================================================================
describe("one merchant cannot reach another through the dashboard", () => {
  test("the orders list only shows its own", async () => {
    // A sale on merchant one.
    const session = await request(app)
      .post("/v1/checkout/sessions")
      .set("authorization", `Bearer ${one.secretKey}`)
      .send({
        line_items: [{ price: one.price.public_id }],
        success_url: "https://acme.test/thanks",
      });
    const paid = await request(app)
      .post(`/c/${session.body.id}/pay`)
      .query({ k: session.body.client_secret })
      .send({
        method: "card",
        buyer: {
          email: "dash@example.com",
          name: "Ada Lovelace",
          document: "52998224725",
          phone: "11988887777",
        },
        card: { number: "4242424242424242", holder_name: "Ada Lovelace", expiry: "12/34", cvv: "123" },
      });

    const mine = await (await signIn("owner@one.test")).agent.get("/dashboard/orders");
    expect(mine.text).toContain(paid.body.order_id);

    const theirs = await (await signIn("owner@two.test")).agent.get("/dashboard/orders");
    expect(theirs.text).not.toContain(paid.body.order_id);
  });

  test("an order of one is a 404 in the other's dashboard", async () => {
    const orders = await (await signIn("owner@one.test")).agent.get("/dashboard/orders");
    const id = (orders.text.match(/ord_[a-z0-9]+/) || [])[0];
    expect(id).toBeTruthy();

    const theirs = await (await signIn("owner@two.test")).agent.get(`/dashboard/orders/${id}`);
    expect(theirs.status).toBe(404);
  });
});

// ===========================================================================
describe("gateway credentials", () => {
  test("are stored encrypted and never shown back", async () => {
    const { agent, token } = await signIn();
    const saved = await agent
      .post("/dashboard/settings/gateways")
      .type("form")
      .send({
        gateway: "asaas",
        mode: "test",
        apiKey: "super-secret-asaas-key",
        webhookToken: "wh-token-value",
        _csrf: token,
      });
    expect(saved.status).toBe(302);

    const rows = await asMerchant(one.merchant.id, () =>
      db.query(`select credentials from gateway_credentials where merchant_id = $1`, [
        one.merchant.id,
      ])
    );
    expect(JSON.stringify(rows.rows)).not.toContain("super-secret-asaas-key");

    const page = await agent.get("/dashboard/settings/gateways");
    expect(page.text).not.toContain("super-secret-asaas-key");
  });

  test("saving without what verifies the webhook warns rather than refusing", async () => {
    // The gateway dashboards are filled in in this order too: keys first,
    // webhook second. Refusing the first half would mean nobody could do the
    // second.
    const { agent, token } = await signIn();
    await agent
      .post("/dashboard/settings/gateways")
      .type("form")
      .send({ gateway: "pagarme", mode: "test", secretKey: "sk_test_x", _csrf: token });

    const page = await agent.get("/dashboard/settings/gateways");
    expect(page.text).toMatch(/discarded unverified|never confirm/i);
  });

  test("the callback URL is shown, because nothing works until it is set", async () => {
    const { agent } = await signIn();
    const page = await agent.get("/dashboard/settings/gateways");
    expect(page.text).toContain("/gateway-webhooks/asaas/");
  });
});

// ===========================================================================
describe("API keys", () => {
  test("the full key is shown once and never stored", async () => {
    const { agent, token } = await signIn();
    await agent
      .post("/dashboard/settings/keys")
      .type("form")
      .send({ label: "Shown once", kind: "secret", mode: "test", _csrf: token });

    const page = await agent.get("/dashboard/settings/keys");
    const shown = (page.text.match(/sk_test_[A-Za-z0-9_-]{20,}/) || [])[0];
    expect(shown).toBeTruthy();

    // Gone on the next load: the flash is consumed.
    const again = await agent.get("/dashboard/settings/keys");
    expect(again.text).not.toContain(shown);

    const rows = await db.query(`select * from api_keys where merchant_id = $1`, [one.merchant.id], {
      withoutMerchant: "reading the key table is the point of this test",
    });
    expect(JSON.stringify(rows.rows)).not.toContain(shown);
  });

  test("revoking one takes effect immediately", async () => {
    const apiKeys = require("../src/services/api-keys");
    const created = await asMerchant(one.merchant.id, () =>
      apiKeys.create(one.merchant.id, { label: "To revoke" })
    );
    expect((await request(app).get("/v1/me").set("authorization", `Bearer ${created.key}`)).status).toBe(200);

    const { agent, token } = await signIn();
    await agent
      .post(`/dashboard/settings/keys/${created.public_id}/revoke`)
      .type("form")
      .send({ _csrf: token });

    expect((await request(app).get("/v1/me").set("authorization", `Bearer ${created.key}`)).status).toBe(401);
  });
});

// ===========================================================================
describe("branding", () => {
  test("the preview is a real checkout, framed only for its own merchant", async () => {
    const { agent } = await signIn();
    const page = await agent.get("/dashboard/settings/branding");
    expect(page.status).toBe(200);

    const previewUrl = (page.text.match(/src="(\/c\/cs_[^"]+preview=1)"/) || [])[1];
    expect(previewUrl).toBeTruthy();

    // Signed in as the owner, it may be framed by the dashboard itself.
    const framed = await agent.get(previewUrl.replace(/&amp;/g, "&"));
    expect(framed.status).toBe(200);
    expect(framed.headers["content-security-policy"]).toContain("frame-ancestors 'self'");

    // A stranger asking for the same URL gets no such permission.
    const stranger = await request(app).get(previewUrl.replace(/&amp;/g, "&"));
    expect(stranger.headers["content-security-policy"]).not.toContain("frame-ancestors 'self'");
  });

  test("saving writes the theme and the checkout wears it", async () => {
    const { agent, token } = await signIn();
    await agent
      .post("/dashboard/settings/branding")
      .type("form")
      .send({ accent: "#ff6600", headline: "Almost yours", _csrf: token });

    const session = await request(app)
      .post("/v1/checkout/sessions")
      .set("authorization", `Bearer ${one.secretKey}`)
      .send({
        line_items: [{ price: one.price.public_id }],
        success_url: "https://acme.test/thanks",
      });

    const checkout = await request(app).get(
      `/c/${session.body.id}?k=${session.body.client_secret}`
    );
    expect(checkout.text).toContain("--oc-accent:#ff6600");
    expect(checkout.text).toContain("Almost yours");
  });

  test("a preset replaces the theme in one click", async () => {
    const { agent, token } = await signIn();
    const response = await agent
      .post("/dashboard/settings/branding")
      .type("form")
      .send({ preset: "midnight", _csrf: token });
    expect(response.status).toBe(302);

    const themes = require("../src/services/themes");
    const theme = await asMerchant(one.merchant.id, () =>
      themes.resolveFor({ merchant: one.merchant })
    );
    expect(theme.color_scheme).toBe("dark");
  });

  test("a colour that is not a colour is ignored, not stored", async () => {
    const { agent, token } = await signIn();
    await agent
      .post("/dashboard/settings/branding")
      .type("form")
      .send({ accent: "#ff6600; } body { display: none", _csrf: token });

    const themes = require("../src/services/themes");
    const theme = await asMerchant(one.merchant.id, () =>
      themes.resolveFor({ merchant: one.merchant })
    );
    expect(theme.accent).not.toContain("body");
    expect(theme.accent).toMatch(/^#[0-9a-f]{3,6}$/);
  });
});

// ===========================================================================
describe("first run", () => {
  test("the setup page is gone once an account exists", async () => {
    expect(await merchantUsers.installationIsEmpty()).toBe(false);
    const response = await request(app).get("/dashboard/setup");
    expect(response.status).toBe(302);
    expect(response.headers.location).toBe("/dashboard/login");
  });

  test("and the login page does not bounce to it", async () => {
    const response = await request(app).get("/dashboard/login");
    expect(response.status).toBe(200);
    expect(response.text).toContain("Sign in");
  });
});

// ===========================================================================
describe("giving money back from the dashboard", () => {
  // A paid sale on merchant one, which is the only state the panel appears in.
  async function paidOrder(email) {
    const session = await request(app)
      .post("/v1/checkout/sessions")
      .set("authorization", `Bearer ${one.secretKey}`)
      .send({
        line_items: [{ price: one.price.public_id }],
        success_url: "https://acme.test/thanks",
      });
    const paid = await request(app)
      .post(`/c/${session.body.id}/pay`)
      .query({ k: session.body.client_secret })
      .send({
        method: "card",
        buyer: { email, name: "Ada Lovelace", document: "52998224725", phone: "11988887777" },
        card: { number: "4242424242424242", holder_name: "Ada Lovelace", expiry: "12/34", cvv: "123" },
      });
    return paid.body.order_id;
  }

  test("the panel offers the amount that is actually left", async () => {
    const id = await paidOrder("refund-panel@example.com");
    const { agent } = await signIn();
    const page = await agent.get(`/dashboard/orders/${id}`);

    expect(page.status).toBe(200);
    expect(page.text).toContain("Refunds");
    expect(page.text).toContain("All of what is left");
  });

  test("a partial refund leaves a PAID order, and the panel says why", async () => {
    // The simulated gateway settles a card refund on the spot, as a real one
    // does on the same authorization. What matters on the screen is that the
    // sale is STILL PAID: the buyer kept what they bought.
    const id = await paidOrder("refund-post@example.com");
    const { agent, token } = await signIn();

    const response = await agent
      .post(`/dashboard/orders/${id}/refund`)
      .type("form")
      .send({ how: "part", amount: "19,90", reason: "Half the course", _csrf: token });
    expect(response.status).toBe(302);

    const page = await agent.get(`/dashboard/orders/${id}`);
    expect(page.text).toContain("Half the course");
    expect(page.text).toContain("succeeded");
    expect(page.text).toContain("Given back");
    expect(page.text).toContain("19,90");
    expect(page.text).toMatch(/still a paid order/i);
    // And the panel keeps warning about the asked-but-not-done case, which is
    // what every other method answers.
    expect(page.text).toMatch(/only done when they confirm/i);
  });

  test("without the CSRF token nothing is refunded", async () => {
    const id = await paidOrder("refund-csrf@example.com");
    const { agent } = await signIn();

    const response = await agent
      .post(`/dashboard/orders/${id}/refund`)
      .type("form")
      .send({ how: "all" });
    expect(response.text).toMatch(/expired|another site/i);

    const refunds = require("../src/services/refunds");
    const rows = await asMerchant(one.merchant.id, () =>
      db.query(`select count(*)::int as n from refunds where merchant_id = $1`, [one.merchant.id])
    );
    // Only the one the test above asked for.
    expect(rows.rows[0].n).toBe(1);
    expect(refunds.STATUSES).toContain("requested");
  });

  test("another merchant cannot refund this order", async () => {
    const id = await paidOrder("refund-theirs@example.com");
    const { agent, token } = await signIn("owner@two.test");

    // The order does not exist for them, so the form comes back with that
    // said rather than finding it. What matters is that no refund was created
    // against somebody else's sale.
    const response = await agent
      .post(`/dashboard/orders/${id}/refund`)
      .type("form")
      .send({ how: "all", _csrf: token });
    expect(response.status).toBe(302);

    const rows = await asMerchant(one.merchant.id, () =>
      db.query(
        `select count(*)::int as n from refunds r
           join orders o on o.id = r.order_id
          where o.public_id = $1`,
        [id],
        { withoutMerchant: "the test is checking that nothing was written at all" }
      )
    );
    expect(rows.rows[0].n).toBe(0);
  });
});

// ===========================================================================
describe("the disputes screen", () => {
  test("says plainly that the money has already gone", async () => {
    const { agent } = await signIn();
    const page = await agent.get("/dashboard/disputes");

    expect(page.status).toBe(200);
    expect(page.text).toMatch(/money is gone/i);
    // And it does not pretend evidence can be uploaded here.
    expect(page.text).toMatch(/processor's own dashboard/i);
  });

  test("shows a dispute and the amount at stake, and only its own", async () => {
    const disputes = require("../src/services/disputes");
    await asMerchant(one.merchant.id, () =>
      disputes.open({
        merchantId: one.merchant.id,
        order: null,
        gateway: "demo",
        gatewayDisputeId: "gw_dp_dash",
        amountCents: 12345,
        reason: "Unrecognised charge",
      })
    );

    const mine = await (await signIn("owner@one.test")).agent.get("/dashboard/disputes");
    expect(mine.text).toContain("Open right now");
    expect(mine.text).toContain("123,45");
    expect(mine.text).toContain("Unrecognised charge");

    const theirs = await (await signIn("owner@two.test")).agent.get("/dashboard/disputes");
    expect(theirs.text).not.toContain("Unrecognised charge");
  });
});
