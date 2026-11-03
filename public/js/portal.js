// The customer portal's behaviour.
//
// Two actions, and both of them matter enough to confirm first: cancelling a
// subscription and undoing that cancellation. There is no API key here; the
// portal cookie is the credential, and the server checks that the subscription
// belongs to whoever that cookie names.
(function () {
  "use strict";

  var errorSlot = document.querySelector("[data-oc-portal-error]");

  function send(path, subscription, button) {
    button.disabled = true;
    if (errorSlot) errorSlot.textContent = "";

    fetch(path, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ subscription: subscription }),
    })
      .then(function (response) {
        return response.json().then(function (data) {
          if (!response.ok) throw new Error((data.error && data.error.message) || "That did not work.");
          return data;
        });
      })
      .then(function () {
        // Re-rendered from the server rather than patched in place. The status
        // chip, the renewal date and which button is shown all change
        // together, and keeping that logic in one place is worth a reload.
        window.location.reload();
      })
      .catch(function (error) {
        if (errorSlot) errorSlot.textContent = error.message;
        button.disabled = false;
      });
  }

  document.querySelectorAll("[data-oc-cancel]").forEach(function (button) {
    button.addEventListener("click", function () {
      var id = button.getAttribute("data-oc-cancel");
      if (!window.confirm("Cancel at the end of the current period? You keep access until then.")) return;
      send("/portal/cancel", id, button);
    });
  });

  document.querySelectorAll("[data-oc-resume]").forEach(function (button) {
    button.addEventListener("click", function () {
      send("/portal/resume", button.getAttribute("data-oc-resume"), button);
    });
  });
})();
