// Keeps the exact bytes of a request body around.
//
// A webhook signature covers the body as it was SENT. Re-serializing the
// parsed JSON produces different bytes (key order, spacing, unicode escapes),
// and the signature then fails for a notification that was perfectly valid.
// So for the routes that verify a signature, the original buffer is kept on
// req.rawBody.
//
// Only those routes: keeping a copy of every body in memory would be waste,
// and on an upload it would be a memory problem.
const RAW_BODY_PATHS = [/^\/gateway-webhooks\//];

function needsRawBody(req) {
  return RAW_BODY_PATHS.some((pattern) => pattern.test(req.path));
}

// Passed to express.json() as its `verify` hook.
function keepRawBody(req, _res, buf) {
  if (buf && buf.length && needsRawBody(req)) {
    req.rawBody = buf.toString("utf8");
  }
}

module.exports = { keepRawBody, needsRawBody };
