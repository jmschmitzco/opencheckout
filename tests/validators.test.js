const v = require("../src/lib/validators");

describe("validators", () => {
  test("refuses rather than repairs", () => {
    // A validator that "fixes" a value makes the system act on something the
    // caller never sent.
    expect(v.hexColor("red")).toBeNull();
    expect(v.hexColor("#ff0000")).toBe("#ff0000");
    expect(v.taxId("123")).toBeNull();
  });

  describe("hexColor", () => {
    test("accepts only a hex triplet", () => {
      expect(v.hexColor("#FFF")).toBe("#fff");
      expect(v.hexColor("#a1b2c3")).toBe("#a1b2c3");
    });

    test("refuses anything that could carry CSS", () => {
      // This is the check that stops a theme field from becoming a way to
      // draw a fake card form over the real one.
      for (const attempt of [
        "rgb(0,0,0)",
        "var(--x)",
        "url(javascript:alert(1))",
        "#fff;}body{display:none",
        "#fff /* comment */",
        "expression(alert(1))",
      ]) {
        expect(v.hexColor(attempt)).toBeNull();
      }
    });
  });

  describe("email", () => {
    test.each([
      ["someone@example.com", "someone@example.com"],
      ["  Someone@Example.COM ", "someone@example.com"],
      ["a@b.co.uk", "a@b.co.uk"],
    ])("accepts %s", (input, expected) => {
      expect(v.email(input)).toBe(expected);
    });

    test.each(["nope", "a@b", "a@@b.com", "a b@c.com", "", null])("refuses %s", (input) => {
      expect(v.email(input)).toBeNull();
    });
  });

  describe("Brazilian tax ids", () => {
    test("validates the check digits, not just the length", () => {
      expect(v.isValidCpf("52998224725")).toBe(true);
      expect(v.isValidCpf("52998224726")).toBe(false);
      expect(v.isValidCpf("11111111111")).toBe(false);
    });

    test("validates a CNPJ", () => {
      expect(v.isValidCnpj("11222333000181")).toBe(true);
      expect(v.isValidCnpj("11222333000182")).toBe(false);
    });

    test("accepts either and returns digits only", () => {
      expect(v.taxId("529.982.247-25")).toBe("52998224725");
      expect(v.taxId("11.222.333/0001-81")).toBe("11222333000181");
    });
  });

  describe("cards", () => {
    test("Luhn catches a mistyped digit before a request is spent", () => {
      expect(v.isValidCardNumber("4242424242424242")).toBe(true);
      expect(v.isValidCardNumber("4242424242424243")).toBe(false);
    });

    test("an expired card is refused and a future one is not", () => {
      const nextYear = String((new Date().getFullYear() + 1) % 100).padStart(2, "0");
      expect(v.cardExpiry(`12/${nextYear}`)).toEqual({ month: 12, year: 2000 + Number(nextYear) });
      expect(v.cardExpiry("01/20")).toBeNull();
      expect(v.cardExpiry("13/30")).toBeNull();
      expect(v.cardExpiry("nope")).toBeNull();
    });

    test("a card is valid through the last day of its month", () => {
      const now = new Date();
      const month = String(now.getMonth() + 1).padStart(2, "0");
      const year = String(now.getFullYear() % 100).padStart(2, "0");
      // The current month has not expired, even on the 28th.
      expect(v.cardExpiry(`${month}/${year}`)).not.toBeNull();
    });

    test("identifies the brand from the leading digits", () => {
      expect(v.cardBrand("4242424242424242")).toBe("visa");
      expect(v.cardBrand("5555555555554444")).toBe("mastercard");
      expect(v.cardBrand("378282246310005")).toBe("amex");
    });
  });

  describe("urls", () => {
    test("refuses a scheme that is not http(s)", () => {
      expect(v.httpUrl("javascript:alert(1)")).toBeNull();
      expect(v.httpUrl("data:text/html,<script>")).toBeNull();
      expect(v.httpUrl("https://example.com/ok")).toBe("https://example.com/ok");
    });

    test("refuses credentials embedded in the url", () => {
      expect(v.httpUrl("https://user:pass@example.com")).toBeNull();
    });

    test("a redirect target must be on an allowed host", () => {
      // This is what stops a stolen API key from pointing paying customers at
      // somebody else's page.
      const hosts = ["example.com"];
      expect(v.redirectUrl("https://example.com/thanks", hosts)).toBeTruthy();
      expect(v.redirectUrl("https://app.example.com/thanks", hosts)).toBeTruthy();
      expect(v.redirectUrl("https://evil.test/thanks", hosts)).toBeNull();
      // An empty list means the merchant has not restricted anything yet.
      expect(v.redirectUrl("https://anywhere.test/x", [])).toBeTruthy();
    });

    test("a lookalike host does not pass", () => {
      expect(v.redirectUrl("https://notexample.com/x", ["example.com"])).toBeNull();
    });
  });
});
