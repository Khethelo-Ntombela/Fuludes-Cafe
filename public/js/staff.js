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
let staffAudioContext = null;
const STAFF_ALERTS_MUTED_KEY = "fulude_staff_alerts_muted";

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
  pollIntervalId = setInterval(loadOrders, 15000);
  initStaffAudio();
  setupStaffAlertToggle();
}

function initStaffAudio() {
  if (staffAudioContext) return;
  try {
    staffAudioContext = new (
      window.AudioContext || window.webkitAudioContext
    )();
  } catch (e) {
    staffAudioContext = null;
  }
}

function playStaffBeep(repeats = 2) {
  if (!staffAudioContext) return;
  if (localStorage.getItem(STAFF_ALERTS_MUTED_KEY) === "1") return;
  const ctx = staffAudioContext;
  const now = ctx.currentTime;
  for (let i = 0; i < repeats; i++) {
    const t = now + i * 0.18;
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.type = "sine";
    o.frequency.value = 880 - i * 80;
    g.gain.value = 0;
    o.connect(g);
    g.connect(ctx.destination);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.12, t + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.12);
    o.start(t);
    o.stop(t + 0.14);
  }
}

function setupStaffAlertToggle() {
  const btn = document.getElementById("staffAlertMuteBtn");
  const icon = document.getElementById("staffAlertMuteIcon");
  if (!btn) return;
  const update = () => {
    const muted = localStorage.getItem(STAFF_ALERTS_MUTED_KEY) === "1";
    if (icon)
      icon.className = muted ? "fas fa-volume-mute" : "fas fa-volume-up";
    btn.title = muted ? "Unmute order alerts" : "Mute order alerts";
  };
  btn.addEventListener("click", () => {
    const muted = localStorage.getItem(STAFF_ALERTS_MUTED_KEY) === "1";
    localStorage.setItem(STAFF_ALERTS_MUTED_KEY, muted ? "0" : "1");
    update();
  });
  update();
}

// ---------------------------------------------------------------------
// Board: poll every 15s
// ---------------------------------------------------------------------
async function loadOrders() {
  try {
    const res = await staffFetch("/api/staff/orders");
    const data = await res.json();
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

function renderControlBar(orders) {
  const active = orders.filter((o) =>
    ["New", "Preparing", "Ready", "Collection", "Delivery", "Out for Delivery"].includes(o.status),
  );
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

function renderBoard(orders) {
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
      // cancelling always means a refund is owed. Staff don't have Yoco
      // access - make sure they flag it to the owner.
      if (status === "Cancelled") {
        return confirm(
          `Order #${order.id} was already paid online. Cancelling here won't refund it - please let Fulufhelo know so she can process the refund via Yoco.\n\nCancel this order anyway?`,
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
