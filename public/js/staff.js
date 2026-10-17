// Kitchen Staff Portal: uses its own token and storage key

const STAFF_TOKEN_KEY = "fulude_staff_token";
let staffToken = localStorage.getItem(STAFF_TOKEN_KEY);
let pollIntervalId = null;
let knownPaidNewOrderIds = new Set();
const STAFF_ALERTS_MUTED_KEY = "fulude_staff_alerts_muted";

// Auth
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
  window.location.assign("/home");
}

function showBoard() {
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

// Board: poll every 15s
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
  // Only tickets the kitchen is still working on count towards ticket age, longest wait and load
  const active = orders.filter((o) => ["New", "Preparing", "Ready"].includes(o.status));
  const ages = active.filter(kdsCountsInStats).map(kdsMinutes);
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
  set("sAvgAge", ages.length ? `${avgAge} min` : "—");
  set("sLongest", ages.length ? `${longest} min` : "—", longest >= 30);
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
      // Every ticket on this board has already been paid for, so cancelling always means a refund is owed
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

// Init
if (staffToken) {
  showBoard();
} else {
  window.location.replace("/home.html?auth=signin");
}

