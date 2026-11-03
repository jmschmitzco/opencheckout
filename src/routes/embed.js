// The embeddable widget.
//
//   <script src="https://pay.example.com/embed.js"></script>
//   <script>
//     OpenCheckout.open({ url: sessionUrlFromYourBackend })
//   </script>
//
// The widget is an iframe over the integrator's page, pointing at the same
// hosted checkout. That is the whole trick, and it is deliberate: the card
// fields stay on this origin, so the integrator's page never touches card
// data and their CSS can never reach inside the form.
//
// This route exists to serve the script with the right headers and to answer
// the browser's preflight. The script itself is in public/js/embed.js, and it
// is served from here rather than from the static directory so it can carry
// its own cache policy and a permissive CORS header, which is what lets it be
// loaded from the integrator's domain.
const express = require("express");
const fs = require("fs");
const path = require("path");
const { config } = require("../config");

const router = express.Router();

const SCRIPT_PATH = path.join(__dirname, "..", "..", "public", "js", "embed.js");

// Read once at boot in production, and on every request in development, so
// editing the file shows up without a restart.
let cached = null;
function readScript() {
  if (config.env === "production") {
    if (!cached) cached = fs.readFileSync(SCRIPT_PATH, "utf8");
    return cached;
  }
  return fs.readFileSync(SCRIPT_PATH, "utf8");
}

router.get("/embed.js", (_req, res) => {
  res.set("content-type", "application/javascript; charset=utf-8");
  // Any origin may LOAD the script. That is safe: it contains no secret and
  // does nothing until it is called with a session URL, which only the
  // integrator's own backend can mint.
  res.set("access-control-allow-origin", "*");
  res.set("cache-control", config.env === "production" ? "public, max-age=300" : "no-store");
  res.set("x-content-type-options", "nosniff");

  // The script needs to know where it came from, and reading its own
  // document.currentScript is unreliable once a bundler has touched it. So the
  // origin is baked in here, by the server that serves it.
  res.send(readScript().replace(/__OPENCHECKOUT_ORIGIN__/g, config.baseUrl));
});

module.exports = router;
