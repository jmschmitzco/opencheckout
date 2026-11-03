const branding = require("../src/services/branding");

describe("branding, the white label layer", () => {
  test("a merchant that never touched the theme still gets a finished page", () => {
    const theme = branding.resolveTheme([]);
    expect(theme.accent).toBeTruthy();
    expect(theme.font_stack).toBeTruthy();
    expect(theme.template).toBe("split");
    // The copy helper fills every string the page prints, so no template has
    // to carry a fallback.
    const copy = branding.copyFor(theme, { locale: "en-US" });
    expect(copy.headline).toBeTruthy();
    expect(copy.submitLabel).toBeTruthy();
  });

  test("layers resolve most specific last", () => {
    const theme = branding.resolveTheme([
      { accent: "#111111", brand_name: "Merchant" },
      { accent: "#222222" },
      { brand_name: "Their customer" },
    ]);
    expect(theme.accent).toBe("#222222");
    expect(theme.brand_name).toBe("Their customer");
  });

  test("a bad value falls through to the layer below instead of blanking it", () => {
    const theme = branding.resolveTheme([{ accent: "#00ff00" }, { accent: "rgb(1,2,3)" }]);
    expect(theme.accent).toBe("#00ff00");
  });

  describe("the style attribute", () => {
    test("carries only validated custom properties", () => {
      const theme = branding.resolveTheme([{ accent: "#ff6600", radius_card: 4 }]);
      const style = branding.themeStyleAttribute(theme);
      expect(style).toContain("--oc-accent:#ff6600");
      expect(style).toContain("--oc-radius-card:4px");
    });

    test("cannot be escaped into a new CSS rule", () => {
      // The last line of defence. Even if a future change let a bad value past
      // the validators, it must not be able to close the declaration and open
      // a rule of its own.
      const theme = branding.resolveTheme([]);
      theme.accent = '#fff;} body{display:none} .x{color:red';
      theme.font_stack = 'Arial"; background: url(http://evil.test)';
      const style = branding.themeStyleAttribute(theme);
      expect(style).not.toContain("}");
      expect(style).not.toContain("{");
      expect(style).not.toContain(";}");
      expect(style).not.toContain("url(http");
    });

    test("every integer token is rendered with a unit", () => {
      const style = branding.themeStyleAttribute(branding.resolveTheme([]));
      expect(style).toMatch(/--oc-radius-control:\d+px/);
      expect(style).toMatch(/--oc-font-size:\d+px/);
    });
  });

  describe("sanitizing", () => {
    test("refuses a font that is not on the list", () => {
      // An arbitrary family name would be interpolated into CSS, and a font
      // from an arbitrary URL is a third party request from the page where the
      // card is typed.
      expect(branding.sanitizeTokens({ font: "Comic Sans" }).font).toBe("system");
      expect(branding.sanitizeTokens({ font: "inter" }).font).toBe("inter");
    });

    test("refuses a template that is not one of the known frames", () => {
      expect(branding.sanitizeTokens({ template: "whatever" }).template).toBe("split");
    });

    test("caps every piece of text", () => {
      const long = "x".repeat(5000);
      const clean = branding.sanitizeTokens({ headline: long });
      expect(clean.headline.length).toBe(branding.TEXT_LIMITS.headline);
    });

    test("never lets the input font size drop below 16px", () => {
      // Mobile Safari zooms the page when it focuses a field with a smaller
      // font, which jumps the layout while someone is typing a card number.
      expect(branding.sanitizeTokens({ base_font_size: 12 }).base_font_size).toBe(16);
      expect(branding.sanitizeTokens({ base_font_size: 18 }).base_font_size).toBe(18);
    });

    test("drops raw CSS unless the installation declared itself single tenant", () => {
      // A refused value is OMITTED rather than stored as null, so it falls
      // through to the layer below instead of blanking it. That is also what
      // makes "never set" and "cleared" one state rather than two that look
      // identical in a dashboard.
      expect(branding.sanitizeTokens({ custom_css: "body{}" })).not.toHaveProperty("custom_css");
      expect(
        branding.sanitizeTokens({ custom_css: "body{}" }, { allowCustomCss: true }).custom_css
      ).toBe("body{}");
      // And a stored value is dropped again on resolve, so revoking the
      // permission takes effect without rewriting anybody's theme.
      expect(branding.resolveTheme([{ custom_css: "body{}" }]).custom_css).toBeNull();
    });

    test("an http image url is refused in production", () => {
      const previous = process.env.NODE_ENV;
      process.env.NODE_ENV = "production";
      try {
        expect(branding.sanitizeTokens({ logo_url: "http://example.com/logo.png" })).not.toHaveProperty(
          "logo_url"
        );
        expect(
          branding.sanitizeTokens({ logo_url: "https://example.com/logo.png" }).logo_url
        ).toBeTruthy();
      } finally {
        process.env.NODE_ENV = previous;
      }
    });
  });

  describe("contrast", () => {
    test("overrides unreadable text on the merchant's own button colour", () => {
      // A yellow button with white text is unreadable, and the person who
      // picked it will blame the checkout rather than their own choice.
      const theme = branding.resolveTheme([{ accent: "#ffee00", accent_text: "#ffffff" }]);
      expect(theme.accent_text).toBe("#111827");
      expect(branding.contrastRatio(theme.accent, theme.accent_text)).toBeGreaterThanOrEqual(4.5);
    });

    test("keeps a readable choice the merchant made", () => {
      const theme = branding.resolveTheme([{ accent: "#111111", accent_text: "#ffffff" }]);
      expect(theme.accent_text).toBe("#ffffff");
    });

    test("the soft tint follows the surface, so a dark theme stays readable", () => {
      // Lightening the accent works on a white page and fails on a dark one:
      // the selected payment method becomes a bright block with light text,
      // in exactly the place where the buyer chooses how to pay.
      const light = branding.resolveTheme([{ accent: "#22d3ee", surface: "#ffffff", text: "#111827" }]);
      const dark = branding.resolveTheme([
        { accent: "#22d3ee", surface: "#141924", text: "#f3f4f6", color_scheme: "dark" },
      ]);

      expect(branding.luminance(light.accent_soft)).toBeGreaterThan(0.5);
      expect(branding.luminance(dark.accent_soft)).toBeLessThan(0.2);
      // And the page's own text is still readable on that tint.
      expect(branding.contrastRatio(dark.accent_soft, dark.text)).toBeGreaterThanOrEqual(4.5);
      expect(branding.contrastRatio(light.accent_soft, light.text)).toBeGreaterThanOrEqual(4.5);
    });

    test("hover and pressed states derive from the merchant's colour", () => {
      // Deriving them from a fixed token is how a custom accent quietly turns
      // back into the default the moment the buyer presses the button.
      const theme = branding.resolveTheme([{ accent: "#ff6600" }]);
      expect(theme.accent_hover).not.toBe(theme.accent);
      expect(theme.accent_hover).toMatch(/^#[0-9a-f]{6}$/);
      expect(branding.luminance(theme.accent_active)).toBeLessThan(branding.luminance(theme.accent));
    });
  });
});
