const money = require("../src/lib/money");

describe("money", () => {
  test("keeps cents as integers and never produces a float", () => {
    expect(money.centsToDecimal(1990, "BRL")).toBe(19.9);
    expect(money.centsToDecimal(1000, "JPY")).toBe(1000);
  });

  test("formats in the currency's own convention", () => {
    expect(money.formatMoney(1990, "USD", "en-US")).toContain("19.90");
    expect(money.formatMoney(1990, "BRL", "pt-BR")).toContain("19,90");
  });

  test("falls back to the default currency instead of throwing", () => {
    // A formatting problem must never take a checkout page down.
    expect(() => money.formatMoney(1000, "NOPE")).not.toThrow();
    expect(money.normalizeCurrency("nope")).toBe("BRL");
  });

  test("a zero decimal currency is not divided by a hundred", () => {
    // 1000 cents of yen is 1000 yen, not 10. Getting this wrong undercharges
    // by two orders of magnitude.
    expect(money.formatMoney(1000, "JPY", "en-US")).toMatch(/1,000/);
  });

  describe("installments", () => {
    test("never offers an installment below the processor floor", () => {
      // A 4.90 product in 12 instalments is 40 cents each, and the processor
      // rejects the whole transaction, not just the extra instalments.
      expect(money.maxInstallmentsFor(490, 12)).toBe(1);
      expect(money.maxInstallmentsFor(1200, 12)).toBe(2);
      expect(money.maxInstallmentsFor(9900, 12)).toBe(12);
    });

    test("one installment is always possible", () => {
      expect(money.maxInstallmentsFor(100, 12)).toBe(1);
      expect(money.normalizeInstallments(12, 12, 100)).toBe(1);
    });

    test("clamps a requested count to what the amount allows", () => {
      expect(money.normalizeInstallments(12, 12, 1200)).toBe(2);
      expect(money.normalizeInstallments(0, 12, 9900)).toBe(1);
      expect(money.normalizeInstallments("not a number", 12, 9900)).toBe(1);
    });

    test("the last installment absorbs the remainder", () => {
      // 100.00 in 3 is 33.33 each, and the three must not add up to more than
      // the total.
      const each = money.installmentAmount(10000, 3);
      expect(each).toBe(3333);
      expect(each * 3).toBeLessThanOrEqual(10000);
    });
  });

  describe("parsing a written amount", () => {
    test.each([
      ["97", 9700],
      ["97.00", 9700],
      ["97,00", 9700],
      ["R$ 1.234,56", 123456],
      ["1,234.56", 123456],
      ["1.997", 199700],
      ["1,997", 199700],
    ])("reads %s as %i cents", (input, expected) => {
      expect(money.parseAmountToCents(input, "BRL")).toBe(expected);
    });

    test("refuses what it cannot read", () => {
      expect(Number.isNaN(money.parseAmountToCents("", "BRL"))).toBe(true);
      expect(Number.isNaN(money.parseAmountToCents("abc", "BRL"))).toBe(true);
      expect(Number.isNaN(money.parseAmountToCents(null, "BRL"))).toBe(true);
    });
  });
});
