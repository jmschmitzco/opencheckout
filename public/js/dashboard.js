// The dashboard's behaviour. There is deliberately very little of it.
//
// Every page here is server rendered and every form is a real form, so this
// file only does the three things HTML cannot: copy to the clipboard, confirm
// something irreversible, and hide fields that do not apply to the current
// choice. If any of it fails to load, the dashboard still works.
(function () {
  "use strict";

  function all(selector, root) {
    return Array.prototype.slice.call((root || document).querySelectorAll(selector));
  }

  // -----------------------------------------------------------------------
  // Copy a secret
  //
  // Secrets are shown once. A copy button is not a convenience here, it is the
  // difference between keeping the key and creating another one.
  // -----------------------------------------------------------------------
  all("[data-d-copy]").forEach(function (button) {
    button.addEventListener("click", function () {
      var holder = button.parentNode.querySelector("[data-d-copy-value]");
      if (!holder) return;

      var done = function () {
        var original = button.textContent;
        button.textContent = "Copied";
        setTimeout(function () {
          button.textContent = original;
        }, 1800);
      };

      var fallback = function () {
        // Selecting it still lets somebody copy by hand, which beats a button
        // that silently does nothing.
        holder.removeAttribute("readonly");
        holder.select();
        try {
          document.execCommand("copy");
          done();
        } catch (err) {
          /* the selection is the fallback */
        }
        holder.setAttribute("readonly", "readonly");
      };

      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(holder.value).then(done, fallback);
      } else {
        fallback();
      }
    });
  });

  // -----------------------------------------------------------------------
  // Confirm something that cannot be undone
  //
  // Only on forms that say they need it. A confirm on every button trains
  // people to click through confirms.
  // -----------------------------------------------------------------------
  all("[data-d-confirm]").forEach(function (form) {
    form.addEventListener("submit", function (event) {
      if (!window.confirm(form.getAttribute("data-d-confirm"))) {
        event.preventDefault();
      }
    });
  });

  // -----------------------------------------------------------------------
  // Fields that only apply to one choice
  //
  // The server validates all of this anyway; hiding is only so the form stops
  // asking for a billing period on something charged once.
  // -----------------------------------------------------------------------
  all("[data-d-price-type]").forEach(function (select) {
    var form = select.closest("form") || document;
    var recurring = form.querySelector("[data-d-recurring]");
    var oneTime = form.querySelector("[data-d-one-time]");

    var sync = function () {
      var isRecurring = select.value === "recurring";
      if (recurring) recurring.hidden = !isRecurring;
      if (oneTime) oneTime.hidden = isRecurring;
    };

    select.addEventListener("change", sync);
    sync();
  });

  all("[data-d-coupon-kind]").forEach(function (select) {
    var form = select.closest("form") || document;
    var currency = form.querySelector("[data-d-coupon-currency]");
    var value = form.querySelector('input[name="value"]');

    var sync = function () {
      var isAmount = select.value === "amount";
      if (currency) currency.hidden = !isAmount;
      // The placeholder is the whole explanation: 20 means twenty percent, or
      // twenty of something, and which one is not obvious from the field.
      if (value) value.placeholder = isAmount ? "20,00" : "20";
    };

    select.addEventListener("change", sync);
    sync();
  });
})();
