// The one click offer page.
//
// Two buttons, and both of them end with the server deciding where the buyer
// goes next. This file never computes a price and never chooses a
// destination: it sends the answer and follows the URL that comes back.
(function () {
  "use strict";

  var node = document.getElementById("oc-funnel-config");
  if (!node) return;

  var config;
  try {
    config = JSON.parse(node.textContent);
  } catch (err) {
    return;
  }

  var pt = String(config.locale || "pt-BR").toLowerCase().indexOf("pt") === 0;
  function t(en, br) {
    return pt ? br : en;
  }

  var accept = document.querySelector("[data-oc-accept]");
  var decline = document.querySelector("[data-oc-decline]");
  var errorSlot = document.querySelector("[data-oc-funnel-error]");

  function busy(on) {
    if (accept) {
      accept.disabled = on;
      if (on) accept.setAttribute("data-loading", "true");
      else accept.removeAttribute("data-loading");
    }
    // The decline is disabled too, so a buyer cannot answer twice while the
    // first answer is still travelling.
    if (decline) decline.disabled = on;
  }

  function send(path, body) {
    busy(true);
    if (errorSlot) errorSlot.textContent = "";

    return fetch(path, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json",
        "x-order-token": config.token,
      },
      body: JSON.stringify(body || {}),
    })
      .then(function (response) {
        return response.json().then(function (data) {
          if (!response.ok) {
            var error = new Error(
              (data.error && data.error.message) ||
                t("That did not work.", "Não foi possível concluir.")
            );
            throw error;
          }
          return data;
        });
      })
      .then(function (data) {
        // A declined card on the EXTRA item is not a failure of the purchase
        // they already made, and the page says so rather than alarming them.
        if (data.message && data.accepted === false && data.status === "refused") {
          if (errorSlot) errorSlot.textContent = data.message;
          busy(false);
          return;
        }
        if (data.next_url) {
          window.location.assign(data.next_url);
          return;
        }
        busy(false);
      })
      .catch(function (error) {
        if (errorSlot) errorSlot.textContent = error.message;
        busy(false);
      });
  }

  var base = "/u/" + encodeURIComponent(config.orderId);

  if (accept) {
    accept.addEventListener("click", function () {
      send(base + "/accept", { offer: config.offerId });
    });
  }

  if (decline) {
    decline.addEventListener("click", function () {
      send(base + "/decline", { offer: config.offerId });
    });
  }
})();
