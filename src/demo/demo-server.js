// The demo server.
//
//   npm run demo
//
// Everything in memory, a simulated gateway, no configuration and no account
// anywhere. A project whose first run needs a database and three API keys does
// not get a first run, and this is the answer to that.
//
// OPENCHECKOUT_DEMO has to be set BEFORE any application module is required:
// it is what makes the gateway registry hand back the simulated adapter and
// what makes app.js mount the demo pages.
process.env.OPENCHECKOUT_DEMO = "1";
if (!process.env.APP_SECRET) {
  process.env.APP_SECRET = "demo-secret-with-more-than-thirty-two-characters";
}
if (process.env.NODE_ENV === "production") {
  console.error("Demo mode cannot run with NODE_ENV=production.");
  process.exit(1);
}

async function main() {
  // The same in-memory database the tests use, for the same reason: a demo
  // that does not exercise the real schema proves nothing.
  const { createMemoryDb, seedMerchant } = require("../../tests/helpers/memdb");
  createMemoryDb();

  const ctx = require("../db/merchant-context");
  const { config } = require("../config");
  const catalog = require("../services/catalog");
  const themes = require("../services/themes");
  const merchants = require("../services/merchants");
  const { setDemoState } = require("./state");

  const seed = await seedMerchant({
    name: "Northwind",
    slug: "northwind",
    productName: "Northwind Pro",
    amountCents: 14900,
    recurringAmountCents: 4900,
    gateway: "asaas",
  });

  // A second item, so the summary shows more than one line and an anchor
  // price with a strikethrough.
  const extra = await ctx.withMerchant(seed.merchant.id, async () => {
    // The demo plays both parts, merchant and integrator, so it declares its
    // own origin. Without it the embedded widget is correctly refused, which
    // is the right default everywhere except here.
    await merchants.update(seed.merchant.id, { allowedOrigins: [config.baseUrl] });

    const product = await catalog.createProduct(seed.merchant.id, {
      name: "Onboarding call",
      description: "Sixty minutes with an engineer, scheduled after checkout.",
    });
    const price = await catalog.createPrice(seed.merchant.id, product.public_id, {
      currency: "BRL",
      unitAmountCents: 4900,
      compareAtCents: 9900,
    });

    await themes.save(seed.merchant.id, {
      scope: "merchant",
      tokens: {
        brand_name: "Northwind",
        accent: "#4338ca",
        font: "inter",
        template: "split",
        headline: "Finalize sua assinatura",
        subheadline: "Cancele quando quiser, direto no seu painel.",
        support_text: "Dúvidas? Escreva para support@northwind.test",
        top_bar_text: "Modo demonstração. Nenhum pagamento real acontece.",
        top_bar_bg: "#111827",
      },
    });

    // The funnel: a bump inside the checkout, and the one click offer pair
    // after it. All three hang off the main product.
    const offers = require("../services/offers");

    const bumpProduct = await catalog.createProduct(seed.merchant.id, {
      name: "Pacote de modelos prontos",
    });
    const bumpPrice = await catalog.createPrice(seed.merchant.id, bumpProduct.public_id, {
      currency: "BRL",
      unitAmountCents: 2900,
      compareAtCents: 5900,
    });
    await offers.create(seed.merchant.id, {
      kind: "bump",
      trigger_product: seed.product.public_id,
      price: bumpPrice.public_id,
      title: "Adicione o pacote de modelos",
      description: "Doze modelos prontos para você começar hoje, em vez de do zero.",
    });

    const upsellProduct = await catalog.createProduct(seed.merchant.id, {
      name: "Um ano de atualizações",
    });
    const upsellPrice = await catalog.createPrice(seed.merchant.id, upsellProduct.public_id, {
      currency: "BRL",
      unitAmountCents: 9700,
      compareAtCents: 19700,
    });
    await offers.create(seed.merchant.id, {
      kind: "upsell",
      trigger_product: seed.product.public_id,
      price: upsellPrice.public_id,
      title: "Mantenha tudo atualizado por um ano",
      description: "Toda melhoria que sair no próximo ano chega para você sem pagar de novo.",
    });

    const downsellProduct = await catalog.createProduct(seed.merchant.id, {
      name: "Seis meses de atualizações",
    });
    const downsellPrice = await catalog.createPrice(seed.merchant.id, downsellProduct.public_id, {
      currency: "BRL",
      unitAmountCents: 4700,
      compareAtCents: 9700,
    });
    await offers.create(seed.merchant.id, {
      kind: "downsell",
      trigger_product: seed.product.public_id,
      price: downsellPrice.public_id,
      title: "Que tal seis meses, então?",
      description: "Metade do prazo, menos da metade do preço.",
    });

    return { product, price };
  });

  // Somebody to sign in to the dashboard as. The password is printed below
  // and the whole database lives in memory, so there is nothing here to leak.
  const merchantUsers = require("../services/merchant-users");
  const demoLogin = { email: "you@example.com", password: "demo-password-1234" };
  await ctx.withMerchant(seed.merchant.id, () =>
    merchantUsers.create({
      merchantId: seed.merchant.id,
      email: demoLogin.email,
      name: "Northwind owner",
      plainPassword: demoLogin.password,
    })
  );

  setDemoState({ ...seed, extraProduct: extra.product, extraPrice: extra.price, demoLogin });

  // Required only now, so the demo routes find the state already in place.
  const app = require("../app");

  app.listen(config.port, () => {
    console.log("");
    console.log("  OpenCheckout demo");
    console.log("  -----------------");
    console.log(`  Open  ${config.baseUrl}/demo`);
    console.log("");
    console.log("  Test card   4242 4242 4242 4242   any future date, any CVV");
    console.log("  Declined    4000 0000 0000 0002");
    console.log("  Pix and boleto settle on their own after about 12 seconds.");
    console.log("");
    console.log(`  Dashboard   ${config.baseUrl}/dashboard`);
    console.log(`              ${demoLogin.email} / ${demoLogin.password}`);
    console.log("");
    console.log(`  API key     ${seed.secretKey}`);
    console.log(`  Try it      curl -H "Authorization: Bearer ${seed.secretKey}" ${config.baseUrl}/v1/me`);
    console.log("");
    console.log("  The database lives in memory and is erased when this process stops.");
    console.log("");
  });
}

main().catch((err) => {
  console.error("The demo failed to start:", err && err.stack);
  process.exit(1);
});
