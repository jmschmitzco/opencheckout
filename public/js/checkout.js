// The checkout page's behaviour.
//
// No framework and no build step, for a reason that is about money rather than
// taste: this file runs on the page where someone is deciding whether to pay,
// often on a phone on mobile data, and every kilobyte before the first paint
// is measurable in abandoned carts.
//
// Three rules it follows:
//   - It never computes a price. Totals come from the server, including after
//     a coupon, because a page that can price itself is a page that can be
//     edited to price itself differently.
//   - It never decides that a payment succeeded. It asks, and the server asks
//     the gateway.
//   - It degrades. The form is a real form with a real action, so a failure to
//     load this file leaves a submit that still reaches the server.
(function () {
  "use strict";

  var configNode = document.getElementById("oc-config");
  if (!configNode) return;

  var config;
  try {
    config = JSON.parse(configNode.textContent);
  } catch (err) {
    return;
  }

  var pt = String(config.locale || "pt-BR").toLowerCase().indexOf("pt") === 0;
  function t(en, br) {
    return pt ? br : en;
  }

  var form = document.getElementById("oc-form");
  var submit = document.querySelector("[data-oc-submit]");
  var formError = document.querySelector("[data-oc-form-error]");
  var waiting = document.querySelector("[data-oc-waiting]");
  var framed = window.parent !== window;

  // ---------------------------------------------------------------------
  // Small helpers
  // ---------------------------------------------------------------------

  function $(selector, root) {
    return (root || document).querySelector(selector);
  }
  function $$(selector, root) {
    return Array.prototype.slice.call((root || document).querySelectorAll(selector));
  }
  function setText(node, text) {
    if (node) node.textContent = text == null ? "" : String(text);
  }
  function digits(value) {
    return String(value || "").replace(/\D/g, "");
  }

  function post(path, body) {
    return fetch(path, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json",
        "x-checkout-key": config.clientSecret,
      },
      body: JSON.stringify(body || {}),
    }).then(readJson);
  }

  function readJson(response) {
    return response
      .json()
      .catch(function () {
        return {};
      })
      .then(function (data) {
        if (!response.ok) {
          var error = new Error((data.error && data.error.message) || t("Something went wrong.", "Algo deu errado."));
          error.fields = (data.error && data.error.fields) || null;
          error.status = response.status;
          throw error;
        }
        return data;
      });
  }

  // A fresh value per purchase attempt, so a retried request is recognised as
  // the same intent and does not charge twice. It is regenerated after a
  // business error, because then the buyer genuinely IS making a new attempt.
  var idempotencyKey = newKey();
  function newKey() {
    if (window.crypto && window.crypto.randomUUID) return window.crypto.randomUUID();
    return "k" + Date.now() + Math.random().toString(36).slice(2, 10);
  }

  // ---------------------------------------------------------------------
  // Errors on fields
  // ---------------------------------------------------------------------

  function clearErrors() {
    setText(formError, "");
    $$("[data-oc-error-for]").forEach(function (node) {
      node.textContent = "";
    });
    $$(".oc-input[aria-invalid]").forEach(function (node) {
      node.removeAttribute("aria-invalid");
    });
  }

  function showErrors(error) {
    var fields = error.fields || {};
    var first = null;
    Object.keys(fields).forEach(function (name) {
      var slot = $('[data-oc-error-for="' + name + '"]');
      if (slot) {
        slot.textContent = fields[name];
        var input = slot.parentNode.querySelector(".oc-input");
        if (input) {
          input.setAttribute("aria-invalid", "true");
          if (!first) first = input;
        }
      }
    });
    // A message at the top too, when nothing could be attached to a field.
    // Silence after a failed submit is the worst possible outcome here.
    if (!first) setText(formError, error.message);
    if (first) first.focus();
  }

  // ---------------------------------------------------------------------
  // Payment method
  // ---------------------------------------------------------------------

  var cardFields = $("[data-oc-card-fields]");

  function currentMethod() {
    var checked = $('input[name="method"]:checked');
    if (checked) return checked.value;
    var hidden = $('input[name="method"]');
    return hidden ? hidden.value : "card";
  }

  function applyMethod() {
    var method = currentMethod();
    if (cardFields) cardFields.classList.toggle("oc-hidden", method !== "card");
    $$("[data-oc-note]").forEach(function (node) {
      node.classList.toggle("oc-hidden", node.getAttribute("data-oc-note") !== method);
    });
    reportHeight();
  }

  $$('input[name="method"]').forEach(function (radio) {
    radio.addEventListener("change", applyMethod);
  });
  applyMethod();

  // ---------------------------------------------------------------------
  // Field formatting
  //
  // Formatting as you type, never validating as you type. Telling someone
  // their card number is wrong while they are on the fourth digit is noise.
  // ---------------------------------------------------------------------

  var cardNumber = $("#oc-card-number");
  var cardBrandNode = $("[data-oc-card-brand]");

  var BRANDS = [
    [/^4/, "visa"],
    [/^(5[1-5]|2[2-7])/, "mastercard"],
    [/^3[47]/, "amex"],
    [/^(36|38|30[0-5])/, "diners"],
    [/^(6011|65|64[4-9])/, "discover"],
    [/^(606282|3841)/, "hipercard"],
    [/^(4011|4312|4389|5041|5067|509|6277|6363|650)/, "elo"],
  ];

  function brandOf(value) {
    for (var i = 0; i < BRANDS.length; i++) {
      if (BRANDS[i][0].test(value)) return BRANDS[i][1];
    }
    return "";
  }

  if (cardNumber) {
    cardNumber.addEventListener("input", function () {
      var raw = digits(this.value).slice(0, 19);
      var brand = brandOf(raw);
      // Amex groups 4-6-5; everybody else groups in fours.
      var groups = brand === "amex" ? [4, 6, 5] : [4, 4, 4, 4, 3];
      var out = [];
      var index = 0;
      for (var g = 0; g < groups.length && index < raw.length; g++) {
        out.push(raw.substr(index, groups[g]));
        index += groups[g];
      }
      this.value = out.join(" ").trim();
      setText(cardBrandNode, brand === "unknown" ? "" : brand);
    });
  }

  var cardExpiry = $("#oc-card-expiry");
  if (cardExpiry) {
    cardExpiry.addEventListener("input", function () {
      var raw = digits(this.value).slice(0, 4);
      // A leading digit above 1 can only be a month typed without its zero.
      if (raw.length === 1 && Number(raw) > 1) raw = "0" + raw;
      this.value = raw.length > 2 ? raw.slice(0, 2) + " / " + raw.slice(2) : raw;
    });
  }

  var cvv = $("#oc-card-cvv");
  if (cvv) {
    cvv.addEventListener("input", function () {
      this.value = digits(this.value).slice(0, 4);
    });
  }

  var documentField = $("#oc-document");
  if (documentField) {
    documentField.addEventListener("input", function () {
      var raw = digits(this.value).slice(0, 14);
      if (raw.length <= 11) {
        this.value = raw
          .replace(/^(\d{3})(\d)/, "$1.$2")
          .replace(/^(\d{3})\.(\d{3})(\d)/, "$1.$2.$3")
          .replace(/\.(\d{3})(\d{1,2})$/, ".$1-$2");
      } else {
        this.value = raw
          .replace(/^(\d{2})(\d)/, "$1.$2")
          .replace(/^(\d{2})\.(\d{3})(\d)/, "$1.$2.$3")
          .replace(/\.(\d{3})(\d)/, ".$1/$2")
          .replace(/(\d{4})(\d{1,2})$/, "$1-$2");
      }
    });
  }

  var phone = $("#oc-phone");
  if (phone) {
    phone.addEventListener("input", function () {
      var raw = digits(this.value).slice(0, 11);
      if (raw.length <= 10) {
        this.value = raw.replace(/^(\d{2})(\d)/, "($1) $2").replace(/(\d{4})(\d{1,4})$/, "$1-$2");
      } else {
        this.value = raw.replace(/^(\d{2})(\d)/, "($1) $2").replace(/(\d{5})(\d{1,4})$/, "$1-$2");
      }
    });
  }

  var postalCode = $("#oc-postal-code");
  if (postalCode) {
    postalCode.addEventListener("input", function () {
      var raw = digits(this.value).slice(0, 8);
      this.value = raw.length > 5 ? raw.slice(0, 5) + "-" + raw.slice(5) : raw;
    });
  }

  // ---------------------------------------------------------------------
  // Abandoned cart
  //
  // Sent as soon as there is a usable email, while the buyer is still here.
  // After they close the tab there is nobody left to ask.
  // ---------------------------------------------------------------------

  var email = $("#oc-email");
  var contactSent = "";

  function rememberContact() {
    if (!email) return;
    var value = String(email.value || "").trim().toLowerCase();
    if (!value || value.indexOf("@") < 1 || value === contactSent) return;
    contactSent = value;
    var name = $("#oc-name");
    post("/c/" + config.sessionId + "/contact", {
      email: value,
      name: name ? name.value : null,
      phone: phone ? phone.value : null,
    }).catch(function () {
      // Best effort. A failure here costs a recovery email, not a sale, and
      // must never interrupt someone who is mid-purchase.
      contactSent = "";
    });
  }

  if (email) {
    email.addEventListener("blur", rememberContact);
  }

  // ---------------------------------------------------------------------
  // Coupon
  // ---------------------------------------------------------------------

  var applyCoupon = $("[data-oc-apply-coupon]");
  if (applyCoupon) {
    applyCoupon.addEventListener("click", function () {
      var input = $("#oc-coupon");
      var slot = $("[data-oc-coupon-error]");
      if (!input) return;
      applyCoupon.disabled = true;
      setText(slot, "");

      post("/c/" + config.sessionId + "/coupon", {
        code: input.value,
        email: email ? email.value : null,
      })
        .then(function (data) {
          if (!data.applied && data.reason) {
            setText(slot, data.reason);
          }
          // Every total on the page is replaced from the server's answer. The
          // page does not know how to subtract a discount, and it should not.
          $$("[data-oc-total]").forEach(function (node) {
            node.textContent = data.total_formatted;
          });
          setText($("[data-oc-subtotal]"), data.subtotal_formatted);
          setText($("[data-oc-discount]"), "−" + data.discount_formatted);
          setText($("[data-oc-coupon-chip]"), data.coupon || "");
          var row = $("[data-oc-discount-row]");
          if (row) row.classList.toggle("oc-hidden", !data.discount_cents);

          var select = $("#oc-installments");
          if (select && data.installment_options) {
            var chosen = select.value;
            select.innerHTML = "";
            data.installment_options.forEach(function (option) {
              var node = document.createElement("option");
              node.value = option.count;
              node.textContent =
                option.count + "× " + option.label + (option.count === 1 ? " " + t("in full", "à vista") : "");
              select.appendChild(node);
            });
            // Keep the buyer's choice when it is still possible. A smaller
            // total can reduce how many instalments are allowed.
            if (select.querySelector('option[value="' + chosen + '"]')) select.value = chosen;
          }
        })
        .catch(function (error) {
          setText(slot, error.message);
        })
        .finally(function () {
          applyCoupon.disabled = false;
          reportHeight();
        });
    });
  }

  // ---------------------------------------------------------------------
  // Order bump
  //
  // Sends WHICH offer and whether it is ticked, and takes the new total from
  // the answer. The page never adds the price itself: a page that can do the
  // arithmetic is a page that can be edited to do it differently.
  // ---------------------------------------------------------------------

  function applyTotals(data, select) {
    $$("[data-oc-total]").forEach(function (el) {
      el.textContent = data.total_formatted;
    });
    if (!select || !data.installment_options) return;

    var chosen = select.value;
    select.innerHTML = "";
    data.installment_options.forEach(function (option) {
      var el = document.createElement("option");
      el.value = option.count;
      el.textContent =
        option.count + "× " + option.label + (option.count === 1 ? " " + t("in full", "à vista") : "");
      select.appendChild(el);
    });
    // Keep the buyer's choice when it is still possible: a different total can
    // change how many instalments are allowed.
    if (select.querySelector('option[value="' + chosen + '"]')) select.value = chosen;
  }

  $$("[data-oc-bump]").forEach(function (input) {
    input.addEventListener("change", function () {
      var row = input.closest("[data-oc-bump-row]");
      var slot = $("[data-oc-bump-error]");
      var wanted = input.checked;
      input.disabled = true;
      setText(slot, "");

      post("/c/" + config.sessionId + "/bump", {
        offer: input.getAttribute("data-oc-bump"),
        accepted: wanted,
      })
        .then(function (data) {
          if (row) row.classList.toggle("oc-bump--on", wanted);
          applyTotals(data, $("#oc-installments"));
        })
        .catch(function (error) {
          // Put the tick back where the server thinks it is, so the box and
          // the total never tell the buyer different stories.
          input.checked = !wanted;
          if (row) row.classList.toggle("oc-bump--on", !wanted);
          setText(slot, error.message);
        })
        .finally(function () {
          input.disabled = false;
          reportHeight();
        });
    });
  });

  // ---------------------------------------------------------------------
  // Submitting
  // ---------------------------------------------------------------------

  function collectPayload() {
    var method = currentMethod();
    var body = {
      method: method,
      installments: Number((($("#oc-installments") || {}).value) || 1),
      buyer: {
        email: email ? email.value : null,
        confirm_email: ($("#oc-confirm-email") || {}).value || null,
        name: ($("#oc-name") || {}).value || null,
        document: documentField ? digits(documentField.value) : null,
        phone: phone ? digits(phone.value) : null,
        postalCode: postalCode ? digits(postalCode.value) : null,
        addressNumber: ($("#oc-address-number") || {}).value || null,
      },
    };

    if (method === "card") {
      body.card = {
        number: cardNumber ? digits(cardNumber.value) : null,
        holder_name: ($("#oc-card-holder") || {}).value || null,
        expiry: cardExpiry ? cardExpiry.value.replace(/\s/g, "") : null,
        cvv: cvv ? cvv.value : null,
      };
    }
    return body;
  }

  if (form) {
    form.addEventListener("submit", function (event) {
      event.preventDefault();
      clearErrors();
      submit.disabled = true;
      submit.setAttribute("data-loading", "true");

      fetch("/c/" + config.sessionId + "/pay", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json",
          "x-checkout-key": config.clientSecret,
          "idempotency-key": idempotencyKey,
        },
        body: JSON.stringify(collectPayload()),
      })
        .then(readJson)
        .then(handlePayResult)
        .catch(function (error) {
          // A new attempt is genuinely a new intent, so the key is renewed.
          // Keeping it would mean the stored answer comes back forever.
          idempotencyKey = newKey();
          showErrors(error);
        })
        .finally(function () {
          submit.disabled = false;
          submit.removeAttribute("data-loading");
          reportHeight();
        });
    });
  }

  function handlePayResult(data) {
    if (data.status === "refused") {
      idempotencyKey = newKey();
      setText(formError, data.message || t("The payment was not authorized.", "O pagamento não foi autorizado."));
      return;
    }

    // The gateway takes over from here, as PayPal does. Nothing happens until
    // the buyer goes, so there is no waiting screen to show: send them.
    if (data.redirect_url) return leaveFor(data.redirect_url);

    if (data.next_url) return finish(data);

    // Pending: show the waiting screen and start asking.
    showWaiting(data);
    startPolling(data.order_id, data.token);
  }

  // Sends the buyer to the gateway. Inside the widget this has to be the TOP
  // window: approving a payment inside an iframe is blocked by most gateways,
  // and the ones that allow it put the buyer in a box where they cannot see
  // the address bar they are being asked to trust.
  function leaveFor(url) {
    if (framed) {
      window.parent.postMessage({ source: "opencheckout", type: "redirect", url: url }, "*");
      return;
    }
    window.location.assign(url);
  }

  function finish(data) {
    if (framed) {
      // The host page performs the redirect. A framed page navigating the top
      // window is exactly what frame sandboxing exists to prevent.
      window.parent.postMessage(
        {
          source: "opencheckout",
          type: "completed",
          order_id: data.order_id || data.id,
          status: data.status,
          next_url: data.next_url,
        },
        "*"
      );
      return;
    }
    window.location.assign(data.next_url);
  }

  // ---------------------------------------------------------------------
  // Waiting and polling
  // ---------------------------------------------------------------------

  function showWaiting(data) {
    if (!waiting) return;

    // The whole form panel goes, not just the form. Hiding the form alone
    // leaves its heading and footer behind as a half empty card next to the QR
    // code, which reads as something having gone wrong.
    var panel = $(".oc-panel");
    if (panel) panel.classList.add("oc-hidden");
    var summary = $(".oc-summary");
    if (summary) summary.classList.add("oc-hidden");

    // One column from here on: there is nothing beside the waiting card.
    var page = $(".oc-page");
    if (page) page.classList.add("oc-page--waiting");

    waiting.classList.remove("oc-hidden");

    setText(
      $("[data-oc-waiting-title]"),
      data.payment_method === "pix"
        ? t("Scan to pay", "Escaneie para pagar")
        : data.payment_method === "boleto"
        ? t("Your bank slip is ready", "Seu boleto está pronto")
        : t("Almost there", "Quase lá")
    );
    setText(
      $("[data-oc-waiting-text]"),
      data.payment_method === "pix"
        ? t("Approval is instant. Keep this page open.", "A aprovação é na hora. Mantenha esta página aberta.")
        : data.payment_method === "boleto"
        ? t("Clearing can take up to two business days.", "A compensação pode levar até dois dias úteis.")
        : ""
    );

    if (data.pix) {
      var pix = $("[data-oc-pix]");
      if (pix) pix.classList.remove("oc-hidden");
      var qr = $("[data-oc-pix-qr]");
      if (qr && data.pix.qr_base64) qr.src = "data:image/png;base64," + data.pix.qr_base64;
      var code = $("[data-oc-pix-code]");
      if (code) code.value = data.pix.copy_paste || "";
    }

    if (data.boleto) {
      var boleto = $("[data-oc-boleto]");
      if (boleto) boleto.classList.remove("oc-hidden");
      var link = $("[data-oc-boleto-url]");
      if (link) link.href = data.boleto.url;
      setText($("[data-oc-boleto-barcode]"), data.boleto.barcode);
    }

    waiting.scrollIntoView({ block: "start", behavior: "smooth" });
    reportHeight();
  }

  var pollTimer = null;

  function startPolling(orderId, token) {
    if (!orderId || !token) return;
    var attempts = 0;

    var ask = function () {
      attempts += 1;
      var query =
        "/c/" +
        config.sessionId +
        "/status?k=" +
        encodeURIComponent(config.clientSecret) +
        "&order_id=" +
        encodeURIComponent(orderId) +
        "&token=" +
        encodeURIComponent(token);

      fetch(query, { headers: { accept: "application/json" } })
        .then(readJson)
        .then(function (data) {
          if (data.next_url) {
            clearTimeout(pollTimer);
            setText($("[data-oc-poll-status]"), t("Confirmed. One moment.", "Confirmado. Um instante."));
            return finish(data);
          }
          if (data.status === "refused" || data.status === "expired" || data.status === "canceled") {
            clearTimeout(pollTimer);
            setText($("[data-oc-poll-status]"), data.message || data.status);
            return;
          }
          schedule();
        })
        .catch(function () {
          // A failed poll is usually a network blip. Keep asking, just less
          // eagerly, rather than telling the buyer anything alarming.
          schedule();
        });
    };

    // Backs off: every 3 seconds for the first minute, then every 10. A Pix is
    // usually confirmed in seconds, and a boleto will not be confirmed today,
    // so hammering past the first minute buys nothing.
    var schedule = function () {
      if (attempts > 200) return;
      pollTimer = setTimeout(ask, attempts < 20 ? 3000 : 10000);
    };

    pollTimer = setTimeout(ask, 3000);
  }

  // Resuming: the page was rendered from a stored pending order, so there is
  // nothing to submit and everything to poll.
  if (config.resume) {
    startPolling(config.resume.orderId, config.resume.token);
  }

  // ---------------------------------------------------------------------
  // Copy the Pix code
  // ---------------------------------------------------------------------

  $$("[data-oc-copy-pix]").forEach(function (button) {
    button.addEventListener("click", function () {
      var input = $("[data-oc-pix-code]");
      if (!input) return;
      var done = function () {
        var original = button.textContent;
        button.textContent = t("Copied", "Copiado");
        setTimeout(function () {
          button.textContent = original;
        }, 1800);
      };
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(input.value).then(done, selectFallback);
      } else {
        selectFallback();
      }
      function selectFallback() {
        // Selecting the text still lets the buyer copy it by hand, which is
        // better than a button that silently does nothing.
        input.removeAttribute("readonly");
        input.select();
        try {
          document.execCommand("copy");
          done();
        } catch (err) {
          /* the selection is the fallback */
        }
        input.setAttribute("readonly", "readonly");
      }
    });
  });

  // ---------------------------------------------------------------------
  // Framed mode
  // ---------------------------------------------------------------------

  // The host page cannot measure the content of a cross origin iframe, so the
  // page tells it how tall it is. Without this the widget is either clipped or
  // padded with empty space.
  var lastHeight = 0;
  function reportHeight() {
    if (!framed) return;
    var height = Math.ceil(document.documentElement.scrollHeight);
    if (Math.abs(height - lastHeight) < 8) return;
    lastHeight = height;
    window.parent.postMessage({ source: "opencheckout", type: "resize", height: height }, "*");
  }

  if (framed) {
    window.addEventListener("load", reportHeight);
    if (window.ResizeObserver) {
      new ResizeObserver(reportHeight).observe(document.body);
    }
    $$("[data-oc-cancel]").forEach(function (link) {
      link.addEventListener("click", function (event) {
        event.preventDefault();
        window.parent.postMessage(
          { source: "opencheckout", type: "cancel", cancel_url: config.cancelUrl || null },
          "*"
        );
      });
    });
    reportHeight();
  }
})();
