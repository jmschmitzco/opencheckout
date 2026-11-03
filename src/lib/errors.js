// One error type for everything a caller did wrong, and one shape for how it
// comes back over the API.
//
// The point is that a service can throw without knowing it is inside an HTTP
// request, and the route turns it into a response without knowing what went
// wrong. Anything that is NOT an ApiError is a bug on our side and becomes a
// 500 with a generic message, because the details of our bugs are not the
// integrator's business.

class ApiError extends Error {
  // status  HTTP status to answer with
  // code    stable machine readable string, safe to branch on
  // message one sentence a developer reads in their logs
  // fields  per field messages, for a form
  constructor(status, code, message, fields = null) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.fields = fields;
  }

  toJSON() {
    const body = { error: { code: this.code, message: this.message } };
    if (this.fields) body.error.fields = this.fields;
    return body;
  }
}

const badRequest = (message, fields) => new ApiError(400, "invalid_request", message, fields);
const unauthorized = (message = "Missing or invalid API key.") =>
  new ApiError(401, "unauthorized", message);
const forbidden = (message = "This key may not do that.") => new ApiError(403, "forbidden", message);
const notFound = (message = "Not found.") => new ApiError(404, "not_found", message);
const conflict = (message, fields) => new ApiError(409, "conflict", message, fields);
const tooManyRequests = (message = "Too many requests.") =>
  new ApiError(429, "rate_limited", message);

// The gateway said no, or could not be reached. Separated from our own bugs
// because the integrator can act on it: retry, or tell the buyer.
const gatewayError = (message, code = "gateway_error") => new ApiError(502, code, message);

// Express error handler. Last middleware in the chain.
function errorHandler(logger = console) {
  return (err, req, res, _next) => {
    if (err instanceof ApiError) {
      return res.status(err.status).json(err.toJSON());
    }
    // A query that forgot the merchant filter is a programming mistake, and it
    // gets its own log line because it is the one bug class that could leak
    // one merchant's data to another.
    if (err && err.code === "NO_MERCHANT_SCOPE") {
      logger.error("[db] Query without merchant scope:", err.message, err.sql || "");
    } else {
      logger.error("[error]", (err && err.stack) || err);
    }
    return res.status(500).json({
      error: { code: "internal_error", message: "Something went wrong on our side." },
    });
  };
}

module.exports = {
  ApiError,
  badRequest,
  unauthorized,
  forbidden,
  notFound,
  conflict,
  tooManyRequests,
  gatewayError,
  errorHandler,
};
