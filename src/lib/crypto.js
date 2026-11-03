// Encryption for secrets at rest (gateway credentials, webhook signing
// secrets) and generation of random tokens.
//
// AES-256-GCM with a key derived from APP_SECRET. GCM is authenticated, so a
// tampered blob fails to decrypt instead of returning plausible garbage.
const crypto = require("crypto");
const { config } = require("../config");

// Derived once. scrypt is deliberately slow, and doing it per call would make
// every credential read cost milliseconds.
const key = crypto.scryptSync(config.appSecret, "opencheckout-v1", 32);

// Returns "iv.tag.ciphertext", all base64.
function encryptText(text) {
  if (text == null || text === "") return null;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(String(text), "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString("base64")}.${tag.toString("base64")}.${encrypted.toString("base64")}`;
}

function decryptText(blob) {
  if (!blob) return null;
  try {
    const [ivB64, tagB64, dataB64] = String(blob).split(".");
    const decipher = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(ivB64, "base64"));
    decipher.setAuthTag(Buffer.from(tagB64, "base64"));
    const plain = Buffer.concat([decipher.update(Buffer.from(dataB64, "base64")), decipher.final()]);
    return plain.toString("utf8");
  } catch {
    // APP_SECRET changed, or the value is corrupt. Treated as "not configured"
    // rather than crashing: a merchant with an unreadable credential should see
    // "configure your gateway", not a 500.
    return null;
  }
}

function encryptJson(value) {
  return encryptText(JSON.stringify(value == null ? null : value));
}

function decryptJson(blob) {
  const text = decryptText(blob);
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function randomToken(bytes = 32) {
  return crypto.randomBytes(bytes).toString("hex");
}

// URL safe, shorter, same entropy. Used for ids that end up in a link.
function randomUrlToken(bytes = 24) {
  return crypto.randomBytes(bytes).toString("base64url");
}

function sha256(text) {
  return crypto.createHash("sha256").update(String(text)).digest("hex");
}

// Constant time comparison, so a wrong token cannot be found one character at
// a time by measuring how long the rejection took.
function safeEqual(a, b) {
  const bufA = Buffer.from(String(a == null ? "" : a));
  const bufB = Buffer.from(String(b == null ? "" : b));
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

// HMAC used to sign outbound webhooks. The signed material includes the
// timestamp, which is what makes a captured body useless later on.
function signPayload(body, secret, timestampSeconds) {
  const material = `${timestampSeconds}.${body}`;
  return "sha256=" + crypto.createHmac("sha256", String(secret)).update(material).digest("hex");
}

// How a receiver shows a secret on screen without revealing it.
function maskSecret(value) {
  if (!value) return "";
  const text = String(value);
  return text.length <= 4 ? "****" : `****${text.slice(-4)}`;
}

module.exports = {
  encryptText,
  decryptText,
  encryptJson,
  decryptJson,
  randomToken,
  randomUrlToken,
  sha256,
  safeEqual,
  signPayload,
  maskSecret,
};
