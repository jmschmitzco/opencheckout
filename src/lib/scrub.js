// Removes things that must never be written down, from text that is about to
// be written down.
//
// Card data goes from the form to the adapter and stops there. That is the
// rule, and this is the net under it: a gateway's error message is text we did
// not write, and it gets stored on the charge row and printed to the log. If
// one of them ever echoes back what was sent, the rule is broken by a third
// party rather than by us, and the only defence is to strip it on the way in.
//
// It is deliberately blunt. A false positive costs a few digits of a
// diagnostic message; a false negative puts a card number in a database.

// 13 to 19 digits, possibly in groups, with the usual separators. That is
// every card number format in use.
const CARD_LIKE = /\b(?:\d[ -]?){12,18}\d\b/g;

// Anything that looks like a secret we or a gateway hands out.
const TOKEN_LIKE =
  /\b(?:sk|pk|whsec|rk|ak)_(?:live|test)?_?[A-Za-z0-9_-]{12,}|\bBearer\s+[A-Za-z0-9._-]{12,}/gi;

// A CVV next to a word that says what it is. A bare three digit number is not
// worth redacting, and redacting it would mangle amounts and status codes.
const CVV_LIKE = /\b(?:cvv|cvc|ccv|security[ _-]?code)\b\s*[:=]?\s*\d{3,4}/gi;

function scrub(text) {
  if (text == null) return text;
  return String(text)
    .replace(CARD_LIKE, (match) => {
      // Keep the shape so the message still reads, drop the value. The last
      // four digits are not kept: in a log that nobody controls, they are not
      // worth the argument.
      const digits = match.replace(/\D/g, "");
      return `[redacted-${digits.length}-digits]`;
    })
    .replace(TOKEN_LIKE, "[redacted-token]")
    .replace(CVV_LIKE, "[redacted-cvv]");
}

// Walks an object and scrubs every string in it. Used before anything from a
// gateway is stored as JSON.
function scrubDeep(value, depth = 0) {
  if (depth > 6) return "[too deep]";
  if (typeof value === "string") return scrub(value);
  if (Array.isArray(value)) return value.map((item) => scrubDeep(item, depth + 1));
  if (value && typeof value === "object") {
    const out = {};
    for (const [key, item] of Object.entries(value)) {
      // A field whose NAME says it holds a card is dropped whole, whatever it
      // contains.
      if (/^(number|card_?number|pan|cvv|cvc|ccv|security_?code)$/i.test(key)) {
        out[key] = "[redacted]";
        continue;
      }
      out[key] = scrubDeep(item, depth + 1);
    }
    return out;
  }
  return value;
}

module.exports = { scrub, scrubDeep, CARD_LIKE, TOKEN_LIKE };
