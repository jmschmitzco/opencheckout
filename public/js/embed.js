// OpenCheckout embed script.
//
// Served from /embed.js, with __OPENCHECKOUT_ORIGIN__ replaced by the origin
// that served it.
//
// It opens the hosted checkout in an iframe over the host page. The card
// fields therefore live on the checkout's own origin: the host page never
// touches card data, and its stylesheet cannot reach inside the form.
//
// No dependency, no build step, and it adds nothing to the host page until
// `open` is called.
(function () {
  "use strict";

  var ORIGIN = "__OPENCHECKOUT_ORIGIN__";
  var STYLE_ID = "opencheckout-embed-style";

  // Written once, as a string, rather than pulling a stylesheet: a widget that
  // needs a second request to look right flashes unstyled on a slow phone.
  var CSS =
    "." + "oc-embed-backdrop{position:fixed;inset:0;z-index:2147483000;background:rgba(15,23,42,.55);" +
    "backdrop-filter:blur(2px);display:flex;align-items:flex-start;justify-content:center;" +
    "padding:24px 16px;overflow:auto;opacity:0;transition:opacity .18s ease}" +
    ".oc-embed-backdrop.oc-open{opacity:1}" +
    ".oc-embed-shell{position:relative;width:100%;max-width:960px;margin:auto;" +
    "transform:translateY(8px) scale(.995);transition:transform .22s cubic-bezier(.2,.8,.2,1)}" +
    ".oc-embed-backdrop.oc-open .oc-embed-shell{transform:none}" +
    ".oc-embed-frame{width:100%;height:100%;min-height:560px;border:0;border-radius:16px;" +
    "background:#fff;box-shadow:0 24px 70px rgba(2,8,23,.35);display:block}" +
    ".oc-embed-close{position:absolute;top:-14px;right:-14px;width:36px;height:36px;border-radius:999px;" +
    "border:0;background:#fff;color:#111827;font-size:20px;line-height:1;cursor:pointer;" +
    "box-shadow:0 6px 18px rgba(2,8,23,.3)}" +
    ".oc-embed-close:focus-visible{outline:2px solid #2c67c5;outline-offset:2px}" +
    "@media (max-width:640px){.oc-embed-backdrop{padding:0}" +
    ".oc-embed-frame{min-height:100vh;border-radius:0}" +
    ".oc-embed-close{top:8px;right:8px;box-shadow:none;background:rgba(255,255,255,.9)}}" +
    "@media (prefers-reduced-motion:reduce){.oc-embed-backdrop,.oc-embed-shell{transition:none}}";

  function ensureStyle() {
    if (document.getElementById(STYLE_ID)) return;
    var style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = CSS;
    document.head.appendChild(style);
  }

  // Accepts the whole session URL, which is what the backend already has, or
  // the pieces. Taking the URL means the integrator copies one value instead
  // of two and cannot mismatch them.
  function frameUrlFrom(options) {
    var url = options.url || options.sessionUrl;
    if (url) {
      var parsed;
      try {
        parsed = new URL(url, ORIGIN);
      } catch (err) {
        throw new Error("OpenCheckout: that is not a valid session URL.");
      }
      if (parsed.origin !== new URL(ORIGIN).origin) {
        // A session URL from another origin is either a mistake or an attempt
        // to frame somebody else's page inside this widget.
        throw new Error("OpenCheckout: the session URL does not belong to " + ORIGIN + ".");
      }
      // /c/:id becomes /c/:id/embed, keeping the ?k= secret.
      parsed.pathname = parsed.pathname.replace(/\/?$/, "").replace(/(\/c\/[^/]+)(\/embed)?$/, "$1/embed");
      parsed.searchParams.set("embedded", "1");
      return parsed.toString();
    }

    var id = options.session || options.sessionId;
    var secret = options.clientSecret || options.client_secret;
    if (!id || !secret) {
      throw new Error("OpenCheckout: pass either { url } or { session, clientSecret }.");
    }
    return (
      ORIGIN + "/c/" + encodeURIComponent(id) + "/embed?k=" + encodeURIComponent(secret) + "&embedded=1"
    );
  }

  var current = null;

  function close(reason) {
    if (!current) return;
    var instance = current;
    current = null;

    window.removeEventListener("message", instance.onMessage);
    document.removeEventListener("keydown", instance.onKey);
    instance.backdrop.classList.remove("oc-open");
    document.documentElement.style.overflow = instance.previousOverflow;

    var remove = function () {
      if (instance.backdrop.parentNode) instance.backdrop.parentNode.removeChild(instance.backdrop);
    };
    // Matches the CSS transition. A widget that vanishes instantly reads as a
    // crash rather than a dismissal.
    setTimeout(remove, 200);

    if (instance.previousFocus && instance.previousFocus.focus) {
      try {
        instance.previousFocus.focus();
      } catch (err) {
        /* the element may be gone */
      }
    }
    if (typeof instance.options.onClose === "function") instance.options.onClose({ reason: reason });
  }

  function open(options) {
    options = options || {};
    if (current) close("reopened");
    ensureStyle();

    var frameUrl = frameUrlFrom(options);

    var backdrop = document.createElement("div");
    backdrop.className = "oc-embed-backdrop";
    backdrop.setAttribute("role", "dialog");
    backdrop.setAttribute("aria-modal", "true");
    backdrop.setAttribute("aria-label", options.title || "Checkout");

    var shell = document.createElement("div");
    shell.className = "oc-embed-shell";

    var frame = document.createElement("iframe");
    frame.className = "oc-embed-frame";
    frame.src = frameUrl;
    frame.title = options.title || "Checkout";
    // Only what the checkout needs. No allow-top-navigation: a framed page
    // must not be able to navigate the host away, and the redirect after
    // payment is performed by the host, from the message below.
    frame.setAttribute("allow", "payment");
    frame.setAttribute("referrerpolicy", "origin");

    var closeButton = document.createElement("button");
    closeButton.type = "button";
    closeButton.className = "oc-embed-close";
    closeButton.setAttribute("aria-label", options.closeLabel || "Close checkout");
    closeButton.innerHTML = "&times;";

    shell.appendChild(frame);
    shell.appendChild(closeButton);
    backdrop.appendChild(shell);

    var instance = {
      options: options,
      backdrop: backdrop,
      frame: frame,
      previousOverflow: document.documentElement.style.overflow,
      previousFocus: document.activeElement,
    };

    // Messages from the framed checkout. The origin is checked on every one:
    // without that check, any page could post a "paid" message and the host
    // would unlock whatever it unlocks on payment.
    instance.onMessage = function (event) {
      if (event.origin !== new URL(ORIGIN).origin) return;
      var data = event.data;
      if (!data || typeof data !== "object" || data.source !== "opencheckout") return;

      if (data.type === "resize" && typeof data.height === "number") {
        var height = Math.max(420, Math.min(2400, data.height));
        frame.style.height = height + "px";
        return;
      }
      if (data.type === "completed") {
        if (typeof options.onComplete === "function") {
          options.onComplete({ orderId: data.order_id, status: data.status, nextUrl: data.next_url });
          close("completed");
          return;
        }
        // No callback: do what a redirect checkout would have done.
        close("completed");
        if (data.next_url) window.location.assign(data.next_url);
        return;
      }
      if (data.type === "cancel") {
        close("canceled");
        if (!options.onClose && data.cancel_url) window.location.assign(data.cancel_url);
      }
    };

    instance.onKey = function (event) {
      if (event.key === "Escape") close("escape");
    };

    closeButton.addEventListener("click", function () {
      close("button");
    });
    backdrop.addEventListener("click", function (event) {
      // Only a click on the backdrop itself, not one that bubbled out of the
      // dialog. Closing a payment form because someone clicked a label would
      // be unforgivable.
      if (event.target === backdrop && options.dismissible !== false) close("backdrop");
    });

    window.addEventListener("message", instance.onMessage);
    document.addEventListener("keydown", instance.onKey);

    document.body.appendChild(backdrop);
    document.documentElement.style.overflow = "hidden";
    current = instance;

    // One frame later, so the transition has a start state to animate from.
    requestAnimationFrame(function () {
      backdrop.classList.add("oc-open");
      closeButton.focus();
    });

    return { close: close };
  }

  // Declarative form, for a page with no JavaScript of its own:
  //   <button data-opencheckout-url="https://pay.example.com/c/cs_x?k=...">Buy</button>
  function bindTriggers(root) {
    var nodes = (root || document).querySelectorAll("[data-opencheckout-url]");
    for (var i = 0; i < nodes.length; i++) {
      var node = nodes[i];
      if (node.getAttribute("data-opencheckout-bound")) continue;
      node.setAttribute("data-opencheckout-bound", "1");
      node.addEventListener("click", function (event) {
        event.preventDefault();
        open({ url: this.getAttribute("data-opencheckout-url") });
      });
    }
  }

  window.OpenCheckout = { open: open, close: close, bindTriggers: bindTriggers, origin: ORIGIN };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", function () {
      bindTriggers(document);
    });
  } else {
    bindTriggers(document);
  }
})();
