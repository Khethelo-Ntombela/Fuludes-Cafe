/**
 * public/js/staff.js
 * -----------------------------------------------------------------------
 * Kitchen Staff Portal: separate login (own token, own storage key -
 * entirely independent from the owner's admin session), then a live
 * live Kanban board polled every 15s. The board itself is rendered by the
 * shared KDS engine (js/kds.js) so it stays identical to the admin's
 * Live Orders view: fixed-height cards, urgency timers, one primary
 * action + overflow menu, compact rows for hand-off columns.
 *
 * Load kds.js BEFORE this file.
 * -----------------------------------------------------------------------
 */

const STAFF_TOKEN_KEY = "fulude_staff_token";
let staffToken = localStorage.getItem(STAFF_TOKEN_KEY);
let pollIntervalId = null;
let knownPaidNewOrderIds = new Set();
const STAFF_ALERTS_MUTED_KEY = "fulude_staff_alerts_muted";

function addStaffPasswordVisibilityToggle() {
  const input = document.getElementById("staffPassword");
  if (!input || input.parentElement.classList.contains("password-input-wrapper"))
    return;

  const wrapper = document.createElement("div");
  wrapper.className = "password-input-wrapper";
  input.parentNode.insertBefore(wrapper, input);
  wrapper.appendChild(input);

  const toggle = document.createElement("button");
  toggle.type = "button";
  toggle.className = "password-visibility-toggle";
  toggle.innerHTML = '<i class="fas fa-eye" aria-hidden="true"></i>'; // eye icon only
  toggle.setAttribute("aria-label", "Show password");
  toggle.title = "Show password";
  toggle.addEventListener("click", () => {
    const isVisible = input.type === "text";
    input.type = isVisible ? "password" : "text";
    toggle.innerHTML = `<i class="fas ${isVisible ? "fa-eye" : "fa-eye-slash"}" aria-hidden="true"></i>`;
    toggle.setAttribute("aria-label", `${isVisible ? "Show" : "Hide"} password`);
    toggle.title = `${isVisible ? "Show" : "Hide"} password`;
  });
  wrapper.appendChild(toggle);
}

addStaffPasswordVisibilityToggle();

// ---------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------
async function staffFetch(url, options = {}) {
  const res = await fetch(url, {
    ...options,
    headers: {
      ...(options.headers || {}),
      Authorization: `Bearer ${staffToken}`,
    },
  });
  if (res.status === 401) {
    logout();
    throw new Error("Session expired. Please log in again.");
  }
  return res;
}

document.getElementById("staffLogoutBtn").addEventListener("click", logout);

function logout() {
  staffToken = null;
  localStorage.removeItem(STAFF_TOKEN_KEY);
  clearInterval(pollIntervalId);
  document.getElementById("staffBoard").style.display = "none";
  document.getElementById("staffLoginScreen").style.display = "flex";
}

function showBoard() {
  document.getElementById("staffLoginScreen").style.display = "none";
  document.getElementById("staffBoard").style.display = "block";
  loadOrders();
  clearInterval(pollIntervalId);
  pollIntervalId = setInterval(loadOrders, 5000); // live board: new tickets appear within 5s
  initStaffAudio();
  setupStaffAlertToggle();
  if (!staffPushBound) {
    staffPushBound = true;
    FuludePWA.bindPushToggle(document.getElementById("staffPushToggleBtn"), "staff", () => staffToken, {
      onLabel: "Alerts on",
      offLabel: "Phone alerts",
    });
  }
}
let staffPushBound = false;
FuludePWA.setupInstallButton("Install kitchen app");

document
  .getElementById("staffLoginForm")
  .addEventListener("submit", async (e) => {
    e.preventDefault();
    const errorEl = document.getElementById("staffLoginError");
    errorEl.style.display = "none";

    try {
      const res = await fetch("/api/staff/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email: document.getElementById("staffEmail").value.trim(),
          password: document.getElementById("staffPassword").value,
        }),
      });
      const data = await res.json();
      if (!res.ok || !data.success)
        throw new Error(data.error || "Couldn't log in.");

      staffToken = data.token;
      localStorage.setItem(STAFF_TOKEN_KEY, staffToken);
      document.getElementById("staffLoginForm").reset();
      showBoard();
    } catch (err) {
      errorEl.textContent = err.message || "Couldn't log in.";
      errorEl.style.display = "block";
    }
  });

function initStaffAudio() {
  FuludeOrderAlert.init();
}

function playStaffBeep(repeats = 2) {
  FuludeOrderAlert.play(repeats, STAFF_ALERTS_MUTED_KEY);
}

function setupStaffAlertToggle() {
  FuludeOrderAlert.bindMuteButton(
    document.getElementById("staffAlertMuteBtn"),
    document.getElementById("staffAlertMuteIcon"),
    STAFF_ALERTS_MUTED_KEY,
  );
}

// ---------------------------------------------------------------------
// Board: poll every 15s
// ---------------------------------------------------------------------
async function loadOrders() {
  try {
    const res = await staffFetch("/api/staff/orders");
    const data = await res.json();
    kdsScheduleNextRelease(data, loadOrders);
    renderBoard(data.orders || []);

    // Detect newly arrived PAID orders (status New && payment_status === 'paid')
    const paidNewIds = new Set(
      (data.orders || [])
        .filter((o) => o.status === "New" && o.payment_status === "paid")
        .map((o) => String(o.id)),
    );
    const newOnes = [...paidNewIds].filter(
      (id) => !knownPaidNewOrderIds.has(id),
    );
    if (newOnes.length > 0) {
      playStaffBeep(Math.min(4, newOnes.length));
      newOnes.forEach((id) => {
        const el = document.querySelector(`[data-order-id="${id}"]`);
        if (el) {
          el.classList.add("kds-new-arrival");
          setTimeout(() => el.classList.remove("kds-new-arrival"), 8000);
        }
      });
    }
    knownPaidNewOrderIds = paidNewIds;
  } catch (err) {
    // Non-fatal; the next poll will retry.
  }
}

/** Sticky control bar above the board: instant operational visibility. */
const KITCHEN_CAPACITY = 12; // active tickets considered a "full" kitchen

function renderControlBar(allOrders) {
  // Stats cover today's orders only, so they start from zero at midnight.
  const orders = allOrders.filter(kdsIsToday);
  const note = document.getElementById("sResetNote");
  if (note) note.textContent = kdsResetLabel();
  // Only tickets the kitchen is still working on count towards ticket age,
  // longest wait and load - once an order is out for collection/delivery
  // it stops counting.
  const active = orders.filter((o) => ["New", "Preparing", "Ready"].includes(o.status));
  const ages = active.map(kdsMinutes);
  const avgAge = ages.length
    ? Math.round(ages.reduce((s, m) => s + m, 0) / ages.length)
    : 0;
  const longest = ages.length ? Math.max(...ages) : 0;
  const load = Math.min(
    100,
    Math.round((active.length / KITCHEN_CAPACITY) * 100),
  );

  const set = (id, val, alert) => {
    const el = document.getElementById(id);
    if (!el) return;
    el.textContent = val;
    el.classList.toggle("alert", !!alert);
  };
  set("sWaiting", orders.filter((o) => o.status === "New").length);
  set("sPreparing", orders.filter((o) => o.status === "Preparing").length);
  set("sReady", orders.filter((o) => o.status === "Ready").length);
  set("sAvgAge", active.length ? `${avgAge} min` : "—");
  set("sLongest", active.length ? `${longest} min` : "—", longest >= 30);
  set("sLoad", `${load}%`, load >= 90);
}

let lastBoardOrders = [];
kdsOnTick(() => renderControlBar(lastBoardOrders)); // live Avg Ticket Age / Longest Waiting

function renderBoard(orders) {
  lastBoardOrders = orders;
  renderControlBar(orders);

  const container = document.getElementById("staffColumns");
  container.innerHTML = kdsBoardHtml(
    orders,
    ["New", "Preparing", "Ready", "Collection", "Delivery"],
    {
      // Hand-off columns render as compact rows so the active
      // workflow stages get the screen space.
      compactStatuses: ["Collection", "Delivery"],
    },
  );

  kdsBindBoard(container, orders, {
    onAction: handleAdvance,
    confirmAction: (order, status) => {
      // Every ticket on this board has already been paid for, so
      // cancelling always means a refund is owed - the admin refunds it
      // through Yoco from Order History.
      if (status === "Cancelled") {
        return confirm(
          `Order #${order.id} was already paid online. Cancelling marks it \"Refund needed\" - the admin can then refund it through Yoco from Order History.\n\nCancel this order anyway?`,
        );
      }
      return true;
    },
  });
}

async function handleAdvance(status, orderId) {
  await staffFetch("/api/staff/order-status", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ order_id: orderId, status }),
  });

  loadOrders();
}

// ---------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------
if (staffToken) {
  showBoard();
}

// Staff login: email checked with the shared rules (js/form-validation.js).
if (typeof FuludeValidation !== "undefined") FuludeValidation.apply({});

// Landing after clicking the verification link in the new-account email
// (/api/staff/verify-email redirects here with ?staff_email_verified=...).
(function showStaffVerifyResult() {
  const params = new URLSearchParams(location.search);
  const result = params.get("staff_email_verified");
  if (!result) return;
  const errorEl = document.getElementById("staffLoginError");
  const messages = {
    yes: "Email verified. You can now sign in.",
    invalid: "That verification link is invalid or has expired. Ask the admin to send a new one.",
    error: "We couldn't verify your email right now. Please try the link again.",
  };
  if (errorEl) {
    errorEl.textContent = messages[result] || messages.error;
    errorEl.style.display = "block";
  }
  history.replaceState(null, "", location.pathname);
})();
