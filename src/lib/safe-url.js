// Is this an address the server may call out to?
//
// THE PROBLEM. A merchant registers a webhook endpoint and this installation
// POSTs to it. On a hosted install that is a request made from inside the
// network, to an address somebody else chose. Point it at
// http://169.254.169.254/ and it reaches the cloud metadata service; point it
// at an internal host and the delivery record's status code becomes a port
// scanner with a convenient dashboard.
//
// That is server-side request forgery, and the webhook feature is the most
// natural place for it to appear in a payments project.
//
// WHAT THIS DOES AND DOES NOT PROMISE. It refuses loopback, private, link
// local and reserved ranges, both as literal addresses and as the resolved
// address of a hostname. It cannot close the race between the check and the
// request, where a name resolves to one address now and another later. A
// deployment that needs that guarantee puts an egress proxy in front of
// outbound traffic; this raises the bar a long way without one.
//
// A single-tenant installation that genuinely wants to deliver to its own
// network sets OPENCHECKOUT_ALLOW_PRIVATE_WEBHOOKS=1 and takes the trade.
const dns = require("node:dns").promises;
const net = require("node:net");

function allowsPrivate() {
  return process.env.OPENCHECKOUT_ALLOW_PRIVATE_WEBHOOKS === "1";
}

// Host names that never belong to a public endpoint, whatever they resolve to.
const BLOCKED_SUFFIXES = [".localhost", ".local", ".internal", ".home.arpa"];
const BLOCKED_NAMES = ["localhost", "metadata.google.internal"];

function isBlockedHostname(hostname) {
  const name = String(hostname || "").toLowerCase();
  if (!name) return true;
  if (BLOCKED_NAMES.includes(name)) return true;
  return BLOCKED_SUFFIXES.some((suffix) => name.endsWith(suffix));
}

// IPv4 ranges that are not the public internet.
function isPrivateIPv4(address) {
  const parts = address.split(".").map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true;
  const [a, b] = parts;

  if (a === 0) return true; // this network
  if (a === 10) return true; // private
  if (a === 127) return true; // loopback
  if (a === 169 && b === 254) return true; // link local, and cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return true; // private
  if (a === 192 && b === 168) return true; // private
  if (a === 192 && b === 0) return true; // reserved, includes 192.0.2.0/24
  if (a === 198 && (b === 18 || b === 19)) return true; // benchmarking
  if (a === 100 && b >= 64 && b <= 127) return true; // carrier grade NAT
  if (a >= 224) return true; // multicast and reserved
  return false;
}

function isPrivateIPv6(address) {
  const value = String(address).toLowerCase().replace(/^\[|\]$/g, "");
  if (value === "::" || value === "::1") return true; // unspecified, loopback
  if (value.startsWith("fe80")) return true; // link local
  if (/^f[cd]/.test(value)) return true; // unique local
  // An IPv4 address wearing an IPv6 hat still reaches the same place.
  const mapped = value.match(/::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return isPrivateIPv4(mapped[1]);
  return false;
}

function isPrivateAddress(address) {
  const family = net.isIP(address);
  if (family === 4) return isPrivateIPv4(address);
  if (family === 6) return isPrivateIPv6(address);
  return true; // not an address we can reason about
}

// Returns { ok: true } or { ok: false, reason } with a sentence a merchant can
// act on. Never throws: a DNS failure is a refusal, not a crash.
async function isPubliclyRoutable(rawUrl, { resolver = dns } = {}) {
  if (allowsPrivate()) return { ok: true, bypassed: true };

  let url;
  try {
    url = new URL(String(rawUrl));
  } catch {
    return { ok: false, reason: "That is not a valid URL." };
  }

  if (url.protocol !== "https:" && url.protocol !== "http:") {
    return { ok: false, reason: "A webhook URL must be http or https." };
  }

  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  if (isBlockedHostname(hostname)) {
    return { ok: false, reason: "That host is not reachable from the public internet." };
  }

  // A literal address needs no lookup.
  if (net.isIP(hostname)) {
    return isPrivateAddress(hostname)
      ? { ok: false, reason: "That address is on a private or reserved range." }
      : { ok: true };
  }

  let addresses;
  try {
    addresses = await resolver.lookup(hostname, { all: true });
  } catch {
    return { ok: false, reason: "That host could not be resolved." };
  }
  if (!addresses || !addresses.length) {
    return { ok: false, reason: "That host could not be resolved." };
  }

  // EVERY address has to be public. A name that resolves to one public and one
  // private address is a name that can be made to reach the private one.
  for (const entry of addresses) {
    if (isPrivateAddress(entry.address)) {
      return { ok: false, reason: "That host resolves to a private or reserved address." };
    }
  }
  return { ok: true };
}

module.exports = {
  isPubliclyRoutable,
  isPrivateAddress,
  isPrivateIPv4,
  isPrivateIPv6,
  isBlockedHostname,
  allowsPrivate,
};
