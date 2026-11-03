// Outbound HTTP to payment gateways.
//
// Everything here exists because of one failure mode: a gateway that accepts a
// request and never answers. Without a deadline the request hangs, the
// connection is held, and the buyer watches a spinner until their patience or
// their session runs out. Worse, the charge may well have been created on the
// other side, so a blind retry charges twice.
//
// So: every call has a deadline, and a call that times out is reported as
// exactly that, never as a refusal.

// Long enough for a card authorization to come back from an issuing bank,
// short enough that a buyer has not left. Card networks themselves give up
// around 30 seconds; there is no point waiting longer than the system we are
// asking.
const DEFAULT_TIMEOUT_MS = 20_000;

class GatewayTimeoutError extends Error {
  constructor(gateway, ms) {
    super(`${gateway} did not answer within ${Math.round(ms / 1000)}s.`);
    this.name = "GatewayTimeoutError";
    this.gateway = gateway;
    // The caller must NOT treat this as a declined payment. The charge may
    // exist on the other side, and the only safe reading is "unknown".
    this.timedOut = true;
  }
}

// fetch with a deadline.
//
// `fetchImpl` is injectable so an adapter can be tested without a network, and
// so a host with its own instrumented fetch can pass it in.
async function fetchWithTimeout(fetchImpl, url, options = {}, { timeoutMs = DEFAULT_TIMEOUT_MS, gateway = "The gateway" } = {}) {
  const impl = fetchImpl || globalThis.fetch;
  if (typeof impl !== "function") {
    throw new Error("No fetch implementation available. Node 18 or newer is required.");
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await impl(url, { ...options, signal: controller.signal });
  } catch (err) {
    // An abort is OUR deadline, not the gateway refusing. Translating it here
    // means no adapter has to remember the difference.
    if (err && (err.name === "AbortError" || err.name === "TimeoutError")) {
      throw new GatewayTimeoutError(gateway, timeoutMs);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

// Reads a JSON body without throwing on an empty or non-JSON response.
// Gateways answer 204 with no body, and error pages with HTML, and neither
// should produce a parse error that hides the status code.
async function readJsonSafely(response) {
  try {
    const text = await response.text();
    if (!text) return null;
    return JSON.parse(text);
  } catch {
    return null;
  }
}

module.exports = { DEFAULT_TIMEOUT_MS, GatewayTimeoutError, fetchWithTimeout, readJsonSafely };
