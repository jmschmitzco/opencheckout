// Password hashing, with nothing from npm.
//
// scrypt is in Node's standard library and is a memory-hard function, which is
// the property that matters: it makes a stolen hash expensive to attack on a
// rack of GPUs, which is where stolen hashes go.
//
// WHY NOT bcrypt. It is the usual answer and a perfectly good one, but it is a
// native dependency, and a native dependency in a self-hosted project is the
// thing that fails to build on somebody's machine at the worst moment. This
// project already lost an afternoon to a binary compiled for another platform.
// scrypt ships with the runtime and cannot do that.
//
// The stored format carries its own parameters:
//
//   scrypt$N$r$p$<salt base64>$<hash base64>
//
// so raising the cost later does not invalidate the passwords already stored:
// an old hash still verifies with the parameters it was written with, and is
// rewritten on the next successful login.
const crypto = require("node:crypto");

// OWASP's current floor for scrypt. N is the work factor, and 2^17 takes
// roughly a tenth of a second on a modern server, which is slow enough to
// matter to an attacker and fast enough not to matter to a login.
const PARAMS = { N: 1 << 17, r: 8, p: 1 };
const KEY_LENGTH = 32;
const SALT_BYTES = 16;

// scrypt needs memory proportional to N*r*128. Node's default limit is 32 MB,
// which this exceeds, so it is raised explicitly rather than silently failing.
const MAX_MEMORY = 256 * 1024 * 1024;

function derive(password, salt, params) {
  return new Promise((resolve, reject) => {
    crypto.scrypt(
      String(password),
      salt,
      KEY_LENGTH,
      { N: params.N, r: params.r, p: params.p, maxmem: MAX_MEMORY },
      (err, key) => (err ? reject(err) : resolve(key))
    );
  });
}

async function hash(password) {
  const salt = crypto.randomBytes(SALT_BYTES);
  const key = await derive(password, salt, PARAMS);
  return [
    "scrypt",
    PARAMS.N,
    PARAMS.r,
    PARAMS.p,
    salt.toString("base64"),
    key.toString("base64"),
  ].join("$");
}

// Returns { ok, needsRehash }. A hash written with weaker parameters than the
// current ones still verifies, and says so, so the caller can upgrade it while
// it holds the plaintext.
async function verify(password, stored) {
  const parts = String(stored || "").split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return { ok: false, needsRehash: false };

  const params = { N: Number(parts[1]), r: Number(parts[2]), p: Number(parts[3]) };
  if (![params.N, params.r, params.p].every((n) => Number.isInteger(n) && n > 0)) {
    return { ok: false, needsRehash: false };
  }

  let salt;
  let expected;
  try {
    salt = Buffer.from(parts[4], "base64");
    expected = Buffer.from(parts[5], "base64");
  } catch {
    return { ok: false, needsRehash: false };
  }

  let key;
  try {
    key = await derive(password, salt, params);
  } catch {
    return { ok: false, needsRehash: false };
  }

  // Constant time, so a wrong password cannot be found one byte at a time by
  // measuring how long the rejection took.
  const ok = key.length === expected.length && crypto.timingSafeEqual(key, expected);
  return { ok, needsRehash: ok && params.N < PARAMS.N };
}

// Is this password good enough to accept?
//
// LENGTH, NOT CHARACTER CLASSES. A twelve character passphrase beats
// "P@ssw0rd!" by every measure that matters, and the rules that demand a
// symbol are the rules that produce "P@ssw0rd!". The only other check is
// against the handful of passwords that are tried first in every attack.
const MIN_LENGTH = 12;

const OBVIOUS = new Set([
  "password",
  "passw0rd",
  "123456789012",
  "qwertyuiop",
  "administrator",
  "letmeinplease",
  "opencheckout",
  "changemenow",
]);

function problemWith(password) {
  const value = String(password == null ? "" : password);
  if (value.length < MIN_LENGTH) {
    return `Use at least ${MIN_LENGTH} characters. A short phrase you can remember beats a short password you cannot.`;
  }
  if (value.length > 200) return "That is longer than 200 characters.";

  const normalized = value.toLowerCase().replace(/[^a-z0-9]/g, "");
  if (OBVIOUS.has(normalized)) return "That is one of the first passwords an attacker tries.";
  // One repeated character, however long, is one character.
  if (/^(.)\1+$/.test(value)) return "That is the same character repeated.";
  return null;
}

module.exports = { hash, verify, problemWith, MIN_LENGTH, PARAMS };
