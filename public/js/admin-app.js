/**
 * public/js/admin-app.js
 * -----------------------------------------------------------------------
 * SaaS shell + analytics layer on top of admin.js (which owns auth, CRUD
 * and the per-tab data loading). This file owns:
 *   - sidebar collapse / mobile drawer
 *   - sticky topbar: page titles, global search, quick actions, bell
 *   - the Dashboard home tab (KPIs, charts, recent activity, top lists)
 *   - Sales & Reports derived widgets (top items, peak hours, breakdowns)
 *   - restaurant status card, toasts, settings sub-tabs
 * Everything here is derived client-side from the existing endpoints
 * (/api/admin/stats, /api/admin/orders, /api/review) - no new backend.
 * Load AFTER admin.js.
 * -----------------------------------------------------------------------
 */

// ---------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------
const $id = (id) => document.getElementById(id);

const escHtml = (v) =>
  String(v ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
const cleanText = (v, max) => String(v || "").replace(/[<>]/g, "").trim().slice(0, max);

function toast(message) {
  const stack = $id("toastStack");
  if (!stack) return;
  const el = document.createElement("div");
  el.className = "toast";
  el.innerHTML = `<i class="fas fa-circle-check"></i> ${message}`;
  stack.appendChild(el);
  setTimeout(() => {
    el.classList.add("leaving");
    setTimeout(() => el.remove(), 300);
  }, 2600);
}

function sparklineSvg(values) {
  if (!values || values.length < 2) return "";
  const max = Math.max(...values, 1);
  const pts = values.map((v, i) => `${(i / (values.length - 1)) * 100},${27 - (v / max) * 24}`).join(" ");
  return `<svg class="kpi-spark" viewBox="0 0 100 28" preserveAspectRatio="none"><polyline points="${pts}"/></svg>`;
}

function barsHtml(items, valueFmt) {
  if (!items.length) return `<p class="menu-empty">No data yet.</p>`;
  const max = Math.max(...items.map((i) => i.value), 1);
  return `<div class="sa-bars">${items
    .map(
      (i) => `
      <div class="sa-bar-col" title="${i.label}: ${valueFmt ? valueFmt(i.value) : i.value}">
        <span class="sa-bar-value">${valueFmt ? valueFmt(i.value) : i.value}</span>
        <div class="sa-bar${i.alt ? " alt" : ""}" style="height:${Math.max(4, Math.round((i.value / max) * 108))}px"></div>
        <span class="sa-bar-label">${i.label}</span>
      </div>`
    )
    .join("")}</div>`;
}

function rowsHtml(items, valueFmt) {
  if (!items.length) return `<p class="menu-empty">No data yet.</p>`;
  const max = Math.max(...items.map((i) => i.value), 1);
  return items
    .map(
      (i) => `
      <div class="sa-row">
        <span class="sa-row-label">${i.label}</span>
        <div class="sa-row-track"><div class="sa-row-fill" style="width:${Math.max(3, Math.round((i.value / max) * 100))}%"></div></div>
        <span class="sa-row-num">${valueFmt ? valueFmt(i.value) : i.value}</span>
      </div>`
    )
    .join("");
}

function monthLabel(monthKey) {
  const [y, m] = monthKey.split("-");
  return new Date(Number(y), Number(m) - 1, 1).toLocaleString("en-ZA", { month: "short" });
}

/** A real, confirmed sale: paid online and not cancelled. Dashboard numbers are built ONLY from these. */
const isPaidOrder = (o) => o.payment_status === "paid" && o.status !== "Cancelled";

function waitingFor(isoDate) {
  const mins = Math.max(0, Math.round((Date.now() - new Date(isoDate).getTime()) / 60000));
  if (mins < 60) return `${mins} min`;
  if (mins < 60 * 24) return `${Math.floor(mins / 60)} h`;
  return `${Math.floor(mins / 1440)} d`;
}

const isToday = (isoDate) => {
  const d = new Date(isoDate);
  const now = new Date();
  return d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate();
};

// ---------------------------------------------------------------------
// Shared data: full order history (feeds dashboard, reports, specials)
// ---------------------------------------------------------------------
window.adminHistoryAll = window.adminHistoryAll || [];

async function fetchHistoryAll() {
  try {
    const res = await adminFetch("/api/admin/orders?limit=200&offset=0");
    const data = await res.json();
    window.adminHistoryAll = data.orders || [];
  } catch {
    window.adminHistoryAll = [];
  }
  return window.adminHistoryAll;
}

// ---------------------------------------------------------------------
// Sidebar: collapse (desktop) + drawer (mobile)
// ---------------------------------------------------------------------
const dashShell = $id("dashboard");
const SIDEBAR_KEY = "fulude_admin_sidebar";

if (localStorage.getItem(SIDEBAR_KEY) === "collapsed") {
  dashShell.classList.add("sidebar-collapsed");
}

$id("sidebarCollapseBtn").addEventListener("click", () => {
  dashShell.classList.toggle("sidebar-collapsed");
  localStorage.setItem(SIDEBAR_KEY, dashShell.classList.contains("sidebar-collapsed") ? "collapsed" : "open");
});

$id("topbarHamburger").addEventListener("click", (e) => {
  e.stopPropagation();
  dashShell.classList.toggle("sidebar-open");
});

document.addEventListener("click", (e) => {
  if (dashShell.classList.contains("sidebar-open") && !e.target.closest(".admin-sidebar") && !e.target.closest(".topbar-hamburger")) {
    dashShell.classList.remove("sidebar-open");
  }
});

// ---------------------------------------------------------------------
// Topbar: page titles, tab hooks, search, quick actions, bell
// ---------------------------------------------------------------------
const TAB_TITLES = {
  dashboard: "Dashboard",
  orders: "Live Orders",
  placeorder: "Place Order",
  history: "Order History",
  sales: "Sales & Reports",
  menu: "Menu & Stock",
  specials: "Specials & Promotions",
  addons: "Extras & Spice Levels",
  reviews: "Customer Reviews",
  reservations: "Reservations",
  buffet: "Buffet Events",
  audit: "Audit Logs",
  settings: "Settings"
};

function activateTab(tabName) {
  const btn = document.querySelector(`.admin-tab-btn[data-tab="${tabName}"]`);
  if (btn) btn.click();
}

document.querySelectorAll(".admin-tab-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    try {
      sessionStorage.setItem("fulude_admin_tab", btn.dataset.tab);
      history.replaceState(null, "", `#${btn.dataset.tab}`);
    } catch { /* ignore */ }
    $id("topbarTitle").textContent = TAB_TITLES[btn.dataset.tab] || "Dashboard";
    dashShell.classList.remove("sidebar-open");
    $id("topbarSearch").value = "";
    applyGlobalSearch("");

    if (btn.dataset.tab === "dashboard") loadDashboardData();
    if (btn.dataset.tab === "sales") loadReportWidgets();
    if (btn.dataset.tab === "specials") fetchHistoryAll().then(() => renderSpecialsList());
    if (btn.dataset.tab === "placeorder") setTimeout(() => initPlaceOrderTab(), 50);
  });
});

document.querySelectorAll("[data-goto-tab]").forEach((btn) => {
  btn.addEventListener("click", () => activateTab(btn.dataset.gotoTab));
});

// Global search: filters the visible cards/rows of the active panel.
const SEARCHABLE = {
  orders: ".kds-card",
  history: ".admin-order-card",
  menu: ".sa-table tbody tr",
  specials: ".promo-card",
  reviews: "#adminReviewsList .admin-item-card",
  reservations: "#reservationsList .admin-item-card"
};

function applyGlobalSearch(query) {
  const activePanel = document.querySelector(".admin-tab-panel.active");
  if (!activePanel) return;
  const tab = activePanel.id.replace("tab-", "");
  const selector = SEARCHABLE[tab];
  if (!selector) return;
  const q = query.trim().toLowerCase();
  activePanel.querySelectorAll(selector).forEach((node) => {
    node.style.display = !q || node.textContent.toLowerCase().includes(q) ? "" : "none";
  });
}

$id("topbarSearch").addEventListener("input", (e) => applyGlobalSearch(e.target.value));

// Quick actions
document.querySelectorAll("[data-quick]").forEach((btn) => {
  btn.addEventListener("click", () => {
    const action = btn.dataset.quick;
    if (action === "new-order") {
      activateTab("placeorder");
    } else if (action === "add-reservation") {
      activateTab("reservations");
    } else if (action === "add-special") {
      activateTab("specials");
      setTimeout(() => $id("specialItemSelect")?.focus(), 150);
    }
  });
});

$id("topbarBell").addEventListener("click", () => activateTab("orders"));

function updateBell(orders) {
  const fresh = orders.filter((o) => o.status === "New").length;
  const el = $id("bellCount");
  el.textContent = fresh;
  el.style.display = fresh > 0 ? "flex" : "none";
}

// ---------------------------------------------------------------------
// Restaurant status card (sidebar)
// ---------------------------------------------------------------------
function updateStatusCard() {
  // Opening hours: Mon-Thu 09:00-18:00, Fri & Sun 09:00-20:00, Sat 09:00-21:00
  const nowDate = new Date();
  const day = nowDate.getDay(); // 0 = Sunday ... 6 = Saturday
  const closeHour = day === 6 ? 21 : day === 5 || day === 0 ? 20 : 18;
  const minutesNow = nowDate.getHours() * 60 + nowDate.getMinutes();
  const open = minutesNow >= 9 * 60 && minutesNow < closeHour * 60;
  $id("statusOpenLabel").textContent = open ? "Open" : "Closed";
  $id("statusOpenDot").classList.toggle("closed", !open);

  const todays = window.adminHistoryAll.filter((o) => isToday(o.created_at) && isPaidOrder(o));
  $id("statusOrdersToday").textContent = todays.length;
  const revenue = todays.reduce((s, o) => s + Number(o.total_amount || 0), 0);
  $id("statusRevenueToday").textContent = `R${revenue.toFixed(0)}`;
}

// ---------------------------------------------------------------------
// Dashboard home
// ---------------------------------------------------------------------
async function loadDashboardData() {
  const [history, statsRes, reviewsRes] = await Promise.all([
    fetchHistoryAll(),
    adminFetch("/api/admin/stats").then((r) => r.json()).catch(() => null),
    fetch("/api/review").then((r) => r.json()).catch(() => ({ reviews: [] }))
  ]);
  const reviews = reviewsRes.reviews || [];
  const months = statsRes?.monthly_breakdown || [];

  await fetchAwaitingOrders();
  window.adminDashMonths = months;
  updateStatusCard();
  renderDashKpis(history, statsRes, months);
  renderDashCharts(months);
  renderDashLists(history, reviews);
  updateKitchenCompletedToday(history);
}

function trendHtml(months, key) {
  if (months.length < 2) return "";
  const last = Number(months[months.length - 1][key] || 0);
  const prev = Number(months[months.length - 2][key] || 0);
  if (prev === 0) return "";
  const pct = ((last - prev) / prev) * 100;
  const dir = pct >= 0 ? "up" : "down";
  return `<span class="kpi-trend ${dir}"><i class="fas fa-arrow-${dir === "up" ? "trend-up" : "trend-down"}"></i> ${Math.abs(pct).toFixed(1)}%</span>`;
}

window.adminAwaiting = { awaiting: [], failed: [] };

/** Orders placed but not yet paid (and ones whose payment failed). Fetched by payment status so old ones aren't lost past the 200-order history window. */
async function fetchAwaitingOrders() {
  const get = async (status) => {
    try {
      const res = await adminFetch(`/api/admin/orders?payment_status=${status}&limit=100&offset=0`);
      const data = await res.json();
      return (data.orders || []).filter((o) => o.status !== "Cancelled");
    } catch {
      return [];
    }
  };
  const [awaiting, failed] = await Promise.all([get("awaiting"), get("failed")]);
  window.adminAwaiting = { awaiting, failed };
  return window.adminAwaiting;
}

// ---------------------------------------------------------------------
// Manual "Clear" for the dashboard's Pending Orders / Delivery Orders /
// Reservations Today cards.
//  - Pending Orders: really deletes the unpaid orders (paid ones are never
//    touched) - stale "awaiting payment" orders otherwise pile up forever.
//  - Delivery Orders / Reservations Today: these are real records, so
//    clearing only resets the card's counter for today (remembered in this
//    browser); anything new that comes in afterwards is counted again.
// ---------------------------------------------------------------------
const localDayKey = (d = new Date()) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

function getDismissedIds(kind) {
  try {
    const raw = JSON.parse(localStorage.getItem(`fulude_dash_cleared_${kind}`) || "null");
    if (raw && raw.day === localDayKey()) return new Set(raw.ids);
  } catch { /* ignore */ }
  return new Set();
}
function dismissIds(kind, ids) {
  const merged = new Set([...getDismissedIds(kind), ...ids]);
  localStorage.setItem(`fulude_dash_cleared_${kind}`, JSON.stringify({ day: localDayKey(), ids: [...merged] }));
}

/** "5h 12m" until local midnight, when the "today" numbers roll over. */
function clearsInMidnight() {
  const n = new Date();
  const mins = Math.ceil((new Date(n.getFullYear(), n.getMonth(), n.getDate() + 1) - n) / 60000);
  return `${Math.floor(mins / 60)}h ${String(mins % 60).padStart(2, "0")}m`;
}

function renderDashKpis(history, stats, months) {
  // Everything below counts PAID orders only - unpaid ones live under "Pending Orders".
  const todays = history.filter((o) => isPaidOrder(o) && isToday(o.created_at));
  const revenueToday = todays.reduce((s, o) => s + Number(o.total_amount || 0), 0);
  const avgOrder = todays.length ? revenueToday / todays.length : 0;
  const { awaiting } = window.adminAwaiting;
  const awaitingValue = awaiting.reduce((s, o) => s + Number(o.total_amount || 0), 0);
  const dismissedDelivery = getDismissedIds("delivery");
  const deliveryList = todays.filter((o) => o.order_type === "delivery" && !dismissedDelivery.has(o.id));
  const deliveryToday = deliveryList.length;
  const todayKey = localDayKey();
  const allReservations = typeof reservations !== "undefined" ? reservations : [];
  const dismissedRes = getDismissedIds("reservations");
  const resList = allReservations.filter((r) => r.reservation_date === todayKey && r.status !== "Cancelled" && !dismissedRes.has(r.id));
  const resToday = resList.length;

  const revSpark = sparklineSvg(months.map((m) => Number(m.revenue || 0)));
  const ordSpark = sparklineSvg(months.map((m) => Number(m.order_count || 0)));

  const kpis = [
    { label: "Today's Orders", sub: "paid", icon: "fa-receipt", value: todays.length, spark: ordSpark, trend: trendHtml(months, "order_count") },
    { label: "Revenue Today", icon: "fa-coins", value: `R${revenueToday.toFixed(0)}`, spark: revSpark, trend: trendHtml(months, "revenue") },
    { label: "Avg Order Value", icon: "fa-basket-shopping", value: `R${avgOrder.toFixed(0)}`, spark: "", trend: "", note: "Based on today's orders" },
    {
      label: "Pending Orders", sub: "awaiting payment", icon: "fa-hourglass-half", value: awaiting.length,
      spark: "", trend: `<span class="kpi-hint">${awaiting.length ? `R${awaitingValue.toFixed(0)} unpaid · ` : ""}View <i class="fas fa-arrow-right"></i></span>`,
      action: "awaiting", clear: awaiting.length ? "pending" : "", note: "Clears: manually only"
    },
    { label: "Delivery Orders", sub: "paid", icon: "fa-motorcycle", value: deliveryToday, spark: "", trend: "", clear: deliveryToday ? "delivery" : "" },
    { label: "Reservations Today", icon: "fa-calendar-check", value: resToday, spark: "", trend: "", clear: resToday ? "reservations" : "" }
  ];

  $id("dashKpis").innerHTML = kpis
    .map(
      (k) => `
      <div class="kpi-card${k.action ? " kpi-clickable" : ""}"${k.action ? ` data-kpi-action="${k.action}" role="button" tabindex="0"` : ""}>
        <div class="kpi-top"><span class="kpi-label">${k.label}${k.sub ? `<small class="kpi-sub">${k.sub}</small>` : ""}</span><span class="kpi-icon"><i class="fas ${k.icon}"></i></span></div>
        <span class="kpi-value">${k.value}</span>
        <div class="kpi-foot">${k.trend || "<span></span>"}${k.spark}</div>
        <span class="kpi-clears">${k.note || `Clears in: ${clearsInMidnight()}`}</span>
        ${k.clear ? `<button type="button" class="kpi-clear-btn" data-kpi-clear="${k.clear}"><i class="fas fa-eraser"></i> Clear</button>` : ""}
      </div>`
    )
    .join("");

  window._dashClearable = {
    delivery: deliveryList.map((o) => o.id),
    reservations: resList.map((r) => r.id)
  };
}

async function clearPendingOrders(singleId) {
  const msg = singleId
    ? `Delete unpaid order #${singleId}? This can't be undone.`
    : "Delete ALL unpaid (awaiting payment / failed) orders? Paid orders are never affected. This can't be undone.";
  if (!confirm(msg)) return false;
  try {
    const qs = singleId ? `&id=${singleId}` : "";
    const res = await adminFetch(`/api/admin/orders?scope=unpaid${qs}`, { method: "DELETE" });
    const data = await res.json();
    if (!res.ok || !data.success) throw new Error(data.error || "Couldn't clear.");
  } catch (err) {
    alert(err.message || "Couldn't clear pending orders.");
    return false;
  }
  await fetchAwaitingOrders();
  loadDashboardKpisOnly();
  return true;
}

// "Clear" buttons on the KPI cards
$id("dashKpis").addEventListener("click", async (e) => {
  const clearBtn = e.target.closest("[data-kpi-clear]");
  if (!clearBtn) return;
  e.stopPropagation();
  const kind = clearBtn.dataset.kpiClear;
  if (kind === "pending") {
    await clearPendingOrders();
  } else if (kind === "delivery" || kind === "reservations") {
    dismissIds(kind, (window._dashClearable || {})[kind] || []);
    loadDashboardKpisOnly();
  }
}, true);

// Click the Pending Orders card -> list of orders awaiting payment + stats
$id("dashKpis").addEventListener("click", (e) => {
  if (e.target.closest("[data-kpi-clear]")) return;
  const card = e.target.closest("[data-kpi-action]");
  if (card && card.dataset.kpiAction === "awaiting") openAwaitingModal();
});

async function openAwaitingModal() {
  let overlay = $id("awaitingModal");
  if (!overlay) {
    overlay = document.createElement("div");
    overlay.id = "awaitingModal";
    overlay.className = "sa-modal-overlay";
    overlay.innerHTML = `
      <div class="sa-modal" role="dialog" aria-modal="true" aria-labelledby="awaitingTitle">
        <div class="sa-modal-head">
          <h3 id="awaitingTitle">Orders awaiting payment</h3>
          <button type="button" class="admin-mini-btn" id="awaitingClearAll"><i class="fas fa-eraser"></i> Clear all</button>
          <button type="button" class="admin-mini-btn" id="awaitingRefresh"><i class="fas fa-rotate"></i> Refresh</button>
          <button type="button" class="admin-mini-btn" id="awaitingClose" aria-label="Close">&times;</button>
        </div>
        <div id="awaitingBody"></div>
      </div>`;
    document.body.appendChild(overlay);
    overlay.addEventListener("click", (e) => { if (e.target === overlay) overlay.classList.remove("active"); });
    $id("awaitingClose").addEventListener("click", () => overlay.classList.remove("active"));
    $id("awaitingRefresh").addEventListener("click", async () => { await fetchAwaitingOrders(); renderAwaitingModal(); loadDashboardKpisOnly(); });
    $id("awaitingClearAll").addEventListener("click", async () => { if (await clearPendingOrders()) renderAwaitingModal(); });
    $id("awaitingBody").addEventListener("click", async (e) => {
      const paidBtn = e.target.closest("[data-mark-paid]");
      if (paidBtn) {
        const id = parseInt(paidBtn.dataset.markPaid, 10);
        if (!confirm(`Mark order #${id} as PAID?\n\nOnly do this after checking the payment in your Yoco dashboard (Transactions). The order will then go to the kitchen.`)) return;
        paidBtn.disabled = true;
        const res = await adminFetch("/api/admin/mark-paid", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ id }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok || !data.success) {
          alert(data.error || "Couldn't mark the order as paid.");
          paidBtn.disabled = false;
          return;
        }
        toast(`Order #${id} marked as paid.`);
        await fetchAwaitingOrders();
        renderAwaitingModal();
        loadDashboardKpisOnly();
        if (typeof loadOrders === "function") loadOrders();
        return;
      }
      const btn = e.target.closest("[data-clear-pending]");
      if (btn && (await clearPendingOrders(parseInt(btn.dataset.clearPending, 10)))) renderAwaitingModal();
    });
  }
  overlay.classList.add("active");
  $id("awaitingBody").innerHTML = '<p class="menu-loading">Loading&hellip;</p>';
  await fetchAwaitingOrders();
  renderAwaitingModal();
}

/** Re-draw the KPI cards after the awaiting list was refreshed from the modal. */
function loadDashboardKpisOnly() {
  renderDashKpis(window.adminHistoryAll, null, window.adminDashMonths || []);
}

function renderAwaitingModal() {
  const { awaiting, failed } = window.adminAwaiting;
  const total = awaiting.reduce((s, o) => s + Number(o.total_amount || 0), 0);
  const oldest = awaiting.length ? awaiting[awaiting.length - 1] : null; // API returns newest first
  const todayCount = awaiting.filter((o) => isToday(o.created_at)).length;

  const stat = (label, value) => `<div class="sa-mini-stat"><span>${label}</span><strong>${value}</strong></div>`;
  const rows = awaiting.length
    ? awaiting
        .map((o) => {
          const items = (o.items || []).map((i) => `${i.quantity}× ${escHtml(i.item_name)}`).join(", ");
          const phone = escHtml(o.customer_phone || "");
          return `
          <div class="sa-list-item">
            <div class="sa-list-main">
              <div class="sa-list-title">#${o.id} · ${escHtml(o.customer_name)}</div>
              <div class="sa-list-sub">${items || "—"}</div>
              <div class="sa-list-sub">${new Date(o.created_at).toLocaleString("en-ZA", { dateStyle: "medium", timeStyle: "short" })} · waiting ${waitingFor(o.created_at)}${phone ? ` · <a href="tel:${phone}">${phone}</a>` : ""}</div>
            </div>
            <span class="sa-list-end">${money(o.total_amount)}<br><button type="button" class="admin-mini-btn" data-mark-paid="${o.id}" title="Customer paid on Yoco but it didn't come through"><i class="fas fa-check"></i> Mark paid</button> <button type="button" class="admin-mini-btn" data-clear-pending="${o.id}" title="Delete this unpaid order"><i class="fas fa-trash"></i></button></span>
          </div>`;
        })
        .join("")
    : '<p class="menu-empty">Nothing is waiting for payment right now.</p>';

  $id("awaitingBody").innerHTML = `
    <div class="sa-mini-stats">
      ${stat("Awaiting payment", awaiting.length)}
      ${stat("Unpaid value", money(total))}
      ${stat("Placed today", todayCount)}
      ${stat("Longest wait", oldest ? waitingFor(oldest.created_at) : "—")}
      ${stat("Payment failed", failed.length)}
    </div>
    <p class="admin-hint">These customers placed an order but haven't paid yet, so they are <strong>not</strong> counted in sales, revenue or top customers. Once payment is confirmed the order moves to Live Orders and the stats.</p>
    <div class="sa-list">${rows}</div>`;
}

function renderDashCharts(months) {
  $id("dashRevChart").innerHTML = barsHtml(
    months.map((m) => ({ label: monthLabel(m.month), value: Number(m.revenue || 0) })),
    (v) => `R${Math.round(v)}`
  );
  $id("dashOrdChart").innerHTML = barsHtml(
    months.map((m) => ({ label: monthLabel(m.month), value: Number(m.order_count || 0), alt: true }))
  );
}

function renderDashLists(history, reviews) {
  const recent = history.filter(isPaidOrder).slice(0, 6);
  $id("dashRecentOrders").innerHTML = recent.length
    ? recent
        .map(
          (o) => `
        <div class="sa-list-item">
          <div class="sa-list-main">
            <div class="sa-list-title">#${o.id} · ${escHtml(o.customer_name)}</div>
            <div class="sa-list-sub">${new Date(o.created_at).toLocaleString("en-ZA", { dateStyle: "medium", timeStyle: "short" })}</div>
          </div>
          <span class="badge badge-status-${o.status.toLowerCase().replace(/ /g, "-")}">${o.status}</span>
          <span class="sa-list-end">${money(o.total_amount)}</span>
        </div>`
        )
        .join("")
    : `<p class="menu-empty">No paid orders yet.</p>`;

  $id("dashRecentReviews").innerHTML = reviews.length
    ? reviews
        .slice(0, 5)
        .map(
          (r) => `
        <div class="sa-list-item">
          <div class="sa-list-main">
            <div class="sa-list-title">${r.customer_name}</div>
            <div class="sa-list-sub">${r.comment}</div>
          </div>
          <span class="sa-list-end" style="color:var(--sa-gold)">${"★".repeat(r.rating)}</span>
        </div>`
        )
        .join("")
    : `<p class="menu-empty">No reviews yet.</p>`;

  // Popular items: aggregate quantities across the whole order history.
  const itemCounts = {};
  history.forEach((o) => {
    if (!isPaidOrder(o)) return;
    (o.items || []).forEach((line) => {
      itemCounts[line.item_name] = (itemCounts[line.item_name] || 0) + (line.quantity || 1);
    });
  });
  const topItems = Object.entries(itemCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 6)
    .map(([label, value]) => ({ label, value }));
  $id("dashTopItems").innerHTML = rowsHtml(topItems, (v) => `${v} sold`);

  // Top customers: order count + spend per customer name.
  const customers = {};
  history.forEach((o) => {
    if (!isPaidOrder(o)) return;
    const c = (customers[o.customer_name] = customers[o.customer_name] || { count: 0, spend: 0 });
    c.count += 1;
    c.spend += Number(o.total_amount || 0);
  });
  const topCustomers = Object.entries(customers)
    .sort((a, b) => b[1].spend - a[1].spend)
    .slice(0, 5);
  $id("dashTopCustomers").innerHTML = topCustomers.length
    ? topCustomers
        .map(
          ([name, c]) => `
        <div class="sa-list-item">
          <span class="sidebar-avatar" style="background:var(--sa-gold-soft);color:var(--sa-gold)">${name.charAt(0)}</span>
          <div class="sa-list-main">
            <div class="sa-list-title">${escHtml(name)}</div>
            <div class="sa-list-sub">${c.count} order${c.count === 1 ? "" : "s"}</div>
          </div>
          <span class="sa-list-end">${money(c.spend)}</span>
        </div>`
        )
        .join("")
    : `<p class="menu-empty">No paid customers yet.</p>`;
}

function updateKitchenCompletedToday(history) {
  const el = $id("kpiCompletedToday");
  if (!el) return;
  el.textContent = history.filter((o) => o.status === "Completed" && isToday(o.created_at)).length;
}

// ---------------------------------------------------------------------
// Sales & Reports derived widgets
// ---------------------------------------------------------------------
async function loadReportWidgets() {
  const history = await fetchHistoryAll();
  const active = history.filter(isPaidOrder);

  // Top selling items by revenue
  const itemRevenue = {};
  active.forEach((o) => (o.items || []).forEach((line) => {
    itemRevenue[line.item_name] = (itemRevenue[line.item_name] || 0) + Number(line.subtotal || 0);
  }));
  $id("reportTopItems").innerHTML = rowsHtml(
    Object.entries(itemRevenue).sort((a, b) => b[1] - a[1]).slice(0, 7).map(([label, value]) => ({ label, value })),
    (v) => `R${Math.round(v)}`
  );

  // Peak ordering hours (2-hour buckets across opening hours)
  const buckets = [
    { label: "9-11", from: 9 }, { label: "11-13", from: 11 }, { label: "13-15", from: 13 },
    { label: "15-17", from: 15 }, { label: "17-19", from: 17 }, { label: "19-21", from: 19 }
  ].map((b) => ({ ...b, value: 0 }));
  active.forEach((o) => {
    const h = new Date(o.created_at).getHours();
    const bucket = buckets.find((b) => h >= b.from && h < b.from + 2);
    if (bucket) bucket.value += 1;
  });
  $id("reportPeakHours").innerHTML = barsHtml(buckets.map((b) => ({ label: b.label, value: b.value, alt: true })));

  // Payment methods + order types
  const payments = {};
  const types = { collection: 0, delivery: 0, dine_in: 0 };
  active.forEach((o) => {
    const label = o.payment_method === "online" ? "Online (Yoco)" : "Pay in person";
    payments[label] = (payments[label] || 0) + 1;
    if (types[o.order_type] !== undefined) types[o.order_type] += 1;
  });
  $id("reportPayments").innerHTML = rowsHtml(Object.entries(payments).map(([label, value]) => ({ label, value })));
  $id("reportOrderTypes").innerHTML = rowsHtml([
    { label: "Collection", value: types.collection },
    { label: "Delivery", value: types.delivery },
    { label: "Dine In", value: types.dine_in }
  ]);
}

// ---------------------------------------------------------------------
// Settings sub-tabs
// ---------------------------------------------------------------------
document.querySelectorAll(".settings-tab-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".settings-tab-btn").forEach((b) => b.classList.remove("active"));
    document.querySelectorAll(".settings-panel").forEach((p) => p.classList.remove("active"));
    btn.classList.add("active");
    $id(`settings-${btn.dataset.settingsTab}`).classList.add("active");

    if (btn.dataset.settingsTab === "delivery") {
      loadDeliveryFeeSettings();
    }
    if (btn.dataset.settingsTab === "payments") loadPaymentSettings();
  });
});

// ---------------------------------------------------------------------
// Payments (Yoco): key mode, payment-notification webhook, recent events
// ---------------------------------------------------------------------
const PAYMENT_EVENT_TEXT = {
  payment_notify_processed: "Payment confirmed",
  payment_notify_payment_failed: "Payment failed on Yoco",
  payment_notify_invalid_signature: "Rejected: signature didn't match (reconnect below)",
  payment_notify_not_configured: "Rejected: payment notifications not connected",
  payment_notify_unmatched: "Rejected: couldn't tell which order it was for",
  payment_notify_amount_mismatch: "Rejected: amount didn't match the order",
  payment_notify_stock_mismatch: "Rejected: not enough stock",
  payment_notify_ignored: "Ignored: order no longer waiting for payment",
  payment_notify_error: "Error while processing",
  order_marked_paid: "Marked as paid by admin",
};

async function loadPaymentSettings() {
  const box = $id("yocoStatus");
  if (!box) return;
  box.innerHTML = '<p class="menu-loading">Checking with Yoco&hellip;</p>';
  try {
    const res = await adminFetch("/api/admin/yoco");
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Couldn't load the payment setup.");
    renderPaymentSettings(data);
  } catch (err) {
    box.innerHTML = `<p class="form-error">${escHtml(err.message)}</p>`;
  }
}

function renderPaymentSettings(d) {
  const ok = (good, text) => `<span style="color:${good ? "var(--sa-green-deep, #1a7f37)" : "var(--sa-red)"};font-weight:600">${good ? "✓" : "✗"} ${text}</span>`;
  const modeText = {
    test: ok(true, "Test key (sk_test) - use Yoco's test cards"),
    live: ok(true, "Live key (sk_live) - real payments"),
    missing: ok(false, "YOCO_SECRET_KEY isn't set in Cloudflare"),
    unknown: ok(false, "YOCO_SECRET_KEY doesn't look like a Yoco secret key (should start with sk_)"),
  }[d.key_mode];
  const events = (d.recent_events || []).length
    ? d.recent_events
        .map((e) => {
          const when = new Date(e.created_at).toLocaleString("en-ZA", { dateStyle: "medium", timeStyle: "short" });
          return `<div class="sa-list-item"><div class="sa-list-main"><div class="sa-list-title">${escHtml(PAYMENT_EVENT_TEXT[e.action] || e.action)}${e.target_id ? ` · order #${e.target_id}` : ""}</div><div class="sa-list-sub">${when}</div></div></div>`;
        })
        .join("")
    : '<p class="admin-hint">No payment notifications received yet. If customers have paid, Yoco isn\'t reaching the app - connect below.</p>';

  $id("yocoStatus").innerHTML = `
    <div class="sa-list">
      <div class="sa-list-item"><div class="sa-list-main"><div class="sa-list-title">Secret key</div><div class="sa-list-sub">${modeText}</div></div></div>
      <div class="sa-list-item"><div class="sa-list-main"><div class="sa-list-title">Payment notifications (webhook)</div>
        <div class="sa-list-sub">${d.connected ? ok(true, "Connected - paid orders go to the kitchen automatically") : ok(false, "Not connected - paid orders will stay \"waiting for payment\"")}</div>
        <div class="sa-list-sub">Address: ${escHtml(d.notify_url)}${d.yoco_error ? ` · Yoco: ${escHtml(d.yoco_error)}` : ""}</div></div></div>
    </div>
    <h4 style="margin:16px 0 6px">Latest payment notifications</h4>
    <div class="sa-list">${events}</div>`;
}

async function connectYocoWebhook() {
  const btn = $id("yocoConnectBtn");
  btn.disabled = true;
  btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Connecting&hellip;';
  try {
    const res = await adminFetch("/api/admin/yoco", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "connect" }),
    });
    const data = await res.json();
    if (!res.ok || !data.success) throw new Error(data.error || "Couldn't connect.");
    renderPaymentSettings(data);
    toast("Payment notifications connected.");
  } catch (err) {
    alert(err.message);
  } finally {
    btn.disabled = false;
    btn.innerHTML = '<i class="fas fa-plug"></i> Connect payment notifications';
  }
}
$id("yocoConnectBtn")?.addEventListener("click", connectYocoWebhook);
$id("yocoRefreshBtn")?.addEventListener("click", loadPaymentSettings);

// ---------------------------------------------------------------------
// Delivery fee settings
// ---------------------------------------------------------------------
async function loadDeliveryFeeSettings() {
  try {
    const res = await adminFetch("/api/admin/delivery-fee");
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Failed to load");

    renderDeliveryBands(data.bands || []);
    populateCafeLocation(data.config || {});
  } catch (err) {
    $id("deliveryBandsStatus").textContent = err.message;
    $id("deliveryBandsStatus").style.color = "var(--sa-red)";
  }
}

function populateCafeLocation(config) {
  $id("cafeLatitude").value = config.cafe_latitude || "";
  $id("cafeLongitude").value = config.cafe_longitude || "";
  $id("cafePhone").value = config.cafe_phone || "";
  $id("cafeEmail").value = config.cafe_email || "";
}

function renderDeliveryBands(bands) {
  const tbody = $id("deliveryBandsList");
  tbody.innerHTML = bands
    .map((band) => {
      const fromKm = band.sort_order === 1 ? 0 : (bands.find(b => b.sort_order === band.sort_order - 1)?.up_to_km || 0);
      const toKm = band.up_to_km;
      return `
        <tr data-band-id="${band.id}">
          <td>${fromKm}–${toKm} km</td>
          <td><input type="number" class="band-fee-input" value="${Number(band.fee).toFixed(2)}" step="0.01" min="0" style="width: 100px" /></td>
          <td><span class="badge ${band.fee > 0 ? "badge-paid" : "badge-unpaid"}">${band.fee > 0 ? "Active" : "Free"}</span></td>
        </tr>
      `;
    })
    .join("");
}

async function saveDeliveryFeeSettings() {
  const statusEl = $id("deliveryBandsStatus");
  statusEl.textContent = "Saving…";
  statusEl.style.color = "";

  const bands = [];
  document.querySelectorAll("#deliveryBandsList tr[data-band-id]").forEach((row) => {
    const id = parseInt(row.dataset.bandId, 10);
    const fee = parseFloat(row.querySelector(".band-fee-input").value);
    if (!Number.isNaN(fee) && fee >= 0) {
      bands.push({ id, fee });
    }
  });

  const config = {
    cafe_latitude: parseFloat($id("cafeLatitude").value) || null,
    cafe_longitude: parseFloat($id("cafeLongitude").value) || null,
    cafe_phone: $id("cafePhone").value.trim() || null,
    cafe_email: $id("cafeEmail").value.trim() || null,
  };

  try {
    const res = await adminFetch("/api/admin/delivery-fee", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ bands, ...config }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Failed to save");

    statusEl.textContent = "Saved successfully.";
    statusEl.style.color = "var(--sa-green-deep)";
    loadDeliveryFeeSettings(); // refresh to show updated status badges
  } catch (err) {
    statusEl.textContent = err.message;
    statusEl.style.color = "var(--sa-red)";
  }
}

async function saveCafeLocation() {
  const statusEl = $id("cafeLocationStatus");
  statusEl.textContent = "Saving…";
  statusEl.style.color = "";

  const config = {
    cafe_latitude: parseFloat($id("cafeLatitude").value) || null,
    cafe_longitude: parseFloat($id("cafeLongitude").value) || null,
    cafe_phone: $id("cafePhone").value.trim() || null,
    cafe_email: $id("cafeEmail").value.trim() || null,
  };

  try {
    const res = await adminFetch("/api/admin/delivery-fee", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ bands: [], ...config }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Failed to save");

    statusEl.textContent = "Location & contact saved.";
    statusEl.style.color = "var(--sa-green-deep)";
  } catch (err) {
    statusEl.textContent = err.message;
    statusEl.style.color = "var(--sa-red)";
  }
}

// Event listeners
$id("saveDeliveryBandsBtn")?.addEventListener("click", saveDeliveryFeeSettings);
$id("cafeLocationForm")?.addEventListener("submit", (e) => {
  e.preventDefault();
  saveCafeLocation();
});

// ---------------------------------------------------------------------
// Menu tab: Add Item collapse + table filters
// ---------------------------------------------------------------------
$id("addItemToggleBtn").addEventListener("click", () => {
  const card = $id("menuFormCard");
  card.classList.toggle("open");
  if (card.classList.contains("open")) $id("itemName").focus();
});

// Editing an item should always reveal the form.
const _populateFormForEdit = populateFormForEdit;
populateFormForEdit = function (item) {
  $id("menuFormCard").classList.add("open");
  _populateFormForEdit(item);
};

$id("menuTableSearch").addEventListener("input", () => renderMenuItemsList());
$id("menuTableCategory").addEventListener("change", () => renderMenuItemsList());

// ---------------------------------------------------------------------
// Hooks into admin.js flows (function declarations are reassignable)
// ---------------------------------------------------------------------
const _renderOrders = renderOrders;
renderOrders = function (orders) {
  _renderOrders(orders);
  updateBell(orders);
  applyGlobalSearch($id("topbarSearch").value);
};

const _handleOrderAction = handleOrderAction;
handleOrderAction = async function (status, orderId) {
  await _handleOrderAction(status, orderId);
  toast(`Order #${orderId} → ${status}`);
  fetchHistoryAll().then(updateStatusCard);
};

const _saveMenuItemPatch = saveMenuItemPatch;
saveMenuItemPatch = async function (item, patch) {
  await _saveMenuItemPatch(item, patch);
  toast(`"${item.name}" updated`);
};

const _showDashboard = showDashboard;
let shellInitialized = false;
showDashboard = function () {
  _showDashboard();
  initShellData();
};

function initShellData() {
  if (shellInitialized) return;
  shellInitialized = true;
  $id("topbarTitle").textContent = TAB_TITLES.dashboard;
  loadDashboardData();
  setInterval(updateStatusCard, 60000);
}

// admin.js may have already shown the dashboard (stored token) before this
// file loaded - catch up if so.
if ($id("dashboard").style.display !== "none") {
  initShellData();
}

// ---------------------------------------------------------------------
// Place Order: admin orders on behalf of a customer, generates Yoco link
// ---------------------------------------------------------------------
let adminCart = [];
let adminMenuData = [];
let adminSpiceLevels = [];
let adminMenuLoadError = "";
let adminMenuCategory = "all";
let adminMenuQuery = "";
let orderGenerating = false;

// Delivery quote for the order being built (filled by the address lookup)
const poDelivery = { fee: 0, distanceKm: 0, lat: null, lng: null, display: "", lastInput: "", tooFar: false, loading: false, error: "", manualFee: null };
// poReset keeps a manually typed fee; poClearManualFee drops it (new address, cancel, ...).
const poReset = () => Object.assign(poDelivery, { fee: 0, distanceKm: 0, lat: null, lng: null, display: "", lastInput: "", tooFar: false, loading: false, error: "" });
function poClearManualFee() {
  poDelivery.manualFee = null;
  const input = $id("poManualFee");
  if (input) input.value = "";
}

/** Same public menu the customers see (all dishes, spice levels, extras, sides) - photos are simply not drawn. */
async function loadAdminMenu() {
  adminMenuLoadError = "";
  try {
    const res = await fetch("/api/menu", { cache: "no-store" });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `Menu request failed (${res.status})`);
    adminMenuData = data.items || [];
    adminSpiceLevels = data.spice_levels || [];
    window.adminMenuCategories = data.categories || [];
  } catch (err) {
    adminMenuData = [];
    adminMenuLoadError = err.message || "Couldn't load the menu.";
  }
  return adminMenuData;
}

const itemNeedsOptions = (item) =>
  (item.accepts_spice && adminSpiceLevels.length > 0) ||
  (item.accepts_addons && (item.addons || []).length > 0) ||
  (item.sides || []).length > 0;

const cartQtyForItem = (id) => adminCart.filter((l) => l.itemId === id).reduce((n, l) => n + l.qty, 0);

function renderAdminMenu() {
  const container = $id("adminMenuGrid");
  if (!container) return;

  if (adminMenuLoadError) {
    container.innerHTML = `<p class="menu-empty">Couldn't load the menu: ${escHtml(adminMenuLoadError)}
      <br><button type="button" class="btn btn-primary admin-mini-btn" id="retryAdminMenu" style="margin-top:10px">Try again</button></p>`;
    $id("retryAdminMenu")?.addEventListener("click", refreshPlaceOrderMenu);
    return;
  }
  if (!adminMenuData.length) {
    container.innerHTML = '<p class="menu-empty">No menu items found.</p>';
    return;
  }

  const cats = window.adminMenuCategories || [];
  const chipsEl = $id("adminMenuCats");
  if (chipsEl) {
    chipsEl.innerHTML =
      `<button type="button" class="po-chip${adminMenuCategory === "all" ? " active" : ""}" data-cat="all">All</button>` +
      cats.map((c) =>
        `<button type="button" class="po-chip${String(adminMenuCategory) === String(c.id) ? " active" : ""}" data-cat="${c.id}">${escHtml(c.name)}</button>`
      ).join("");
    chipsEl.querySelectorAll(".po-chip").forEach((b) =>
      b.addEventListener("click", () => {
        adminMenuCategory = b.dataset.cat;
        renderAdminMenu();
      }),
    );
  }

  const q = adminMenuQuery.trim().toLowerCase();
  const shown = adminMenuData.filter(
    (i) =>
      (adminMenuCategory === "all" || String(i.category_id) === String(adminMenuCategory)) &&
      (!q || `${i.name} ${i.description || ""}`.toLowerCase().includes(q)),
  );
  if (!shown.length) {
    container.innerHTML = '<p class="menu-empty">Nothing matches that search.</p>';
    return;
  }

  container.innerHTML = shown
    .map((item) => {
      const soldOut = item.is_available === false;
      const price = Number(item.effective_price ?? item.price);
      const onSpecial = item.is_on_special === true;
      const qty = cartQtyForItem(item.id);
      const tags = [
        item.accepts_spice && adminSpiceLevels.length ? "Spice level" : "",
        (item.sides || []).length ? "Choice of side" : "",
        item.accepts_addons && (item.addons || []).length ? "Extras" : "",
      ].filter(Boolean);
      return `
      <div class="admin-menu-item${soldOut ? " sold-out" : ""}">
        <div class="admin-menu-item-info">
          <strong>${escHtml(item.name)}</strong>
          <span class="admin-menu-item-price">${onSpecial ? `<s>R${Number(item.price).toFixed(2)}</s> ` : ""}R${price.toFixed(2)}</span>
          ${item.description ? `<small>${escHtml(item.description)}</small>` : ""}
          ${tags.length ? `<small class="po-tags">${tags.join(" · ")}</small>` : ""}
        </div>
        <div class="admin-menu-item-actions">
          <button type="button" class="btn btn-primary admin-mini-btn add-to-cart-btn" data-id="${item.id}" ${soldOut ? "disabled" : ""}>
            ${soldOut ? "Sold out" : `<i class="fas fa-plus"></i> ${itemNeedsOptions(item) ? "Choose options" : "Add"}${qty ? ` (${qty})` : ""}`}
          </button>
        </div>
      </div>`;
    })
    .join("");
  container.querySelectorAll(".add-to-cart-btn").forEach((btn) => {
    btn.addEventListener("click", () => onAdminAddClick(parseInt(btn.dataset.id, 10)));
  });
}

function onAdminAddClick(itemId) {
  const item = adminMenuData.find((m) => m.id === itemId);
  if (!item || item.is_available === false) return;
  if (itemNeedsOptions(item)) openAdminOptionsModal(item);
  else addLineToAdminCart(item, { spice: null, side: null, extras: [], qty: 1 });
}

function addLineToAdminCart(item, { spice, side, extras, qty }) {
  const lineId = `${item.id}|${spice || ""}|${side ? side.id : ""}|${extras.map((e) => e.id).sort().join(",")}`;
  const unit = Number(item.effective_price ?? item.price);
  const existing = adminCart.find((l) => l.lineId === lineId);
  if (existing) existing.qty += qty;
  else adminCart.push({ lineId, itemId: item.id, name: item.name, unit, qty, spice: spice || null, side: side || null, extras });
  renderAdminCart();
  renderAdminMenu();
}

/** Spice level / free side / paid extras picker - same choices the customer gets. */
function openAdminOptionsModal(item) {
  let overlay = $id("poOptionsModal");
  if (!overlay) {
    overlay = document.createElement("div");
    overlay.id = "poOptionsModal";
    overlay.className = "sa-modal-overlay";
    document.body.appendChild(overlay);
    overlay.addEventListener("click", (e) => { if (e.target === overlay) overlay.classList.remove("active"); });
  }
  const spiceHtml = item.accepts_spice && adminSpiceLevels.length
    ? `<div class="po-opt-group"><label>Spice level</label><div class="po-pills" data-group="spice">${adminSpiceLevels
        .map((s, i) => `<button type="button" class="po-pill${i === 0 ? " selected" : ""}" data-name="${escHtml(s.name)}">${escHtml(s.name)}</button>`)
        .join("")}</div></div>` : "";
  const sideHtml = (item.sides || []).length
    ? `<div class="po-opt-group"><label>Choice of side <small>(free)</small></label><div class="po-pills" data-group="side">${item.sides
        .map((sd) => `<button type="button" class="po-pill" data-id="${sd.id}" data-name="${escHtml(sd.name)}">${escHtml(sd.name)}</button>`)
        .join("")}</div><p class="form-error" id="poSideError" style="display:none">Please choose a side.</p></div>` : "";
  const extrasHtml = item.accepts_addons && (item.addons || []).length
    ? `<div class="po-opt-group"><label>Extras</label>${item.addons
        .map((a) => `<label class="checkbox-option"><input type="checkbox" value="${a.id}" data-name="${escHtml(a.name)}" data-price="${a.price}" /> ${escHtml(a.name)} (+R${Number(a.price).toFixed(2)})</label>`)
        .join("")}</div>` : "";

  overlay.innerHTML = `
    <div class="sa-modal" style="max-width:460px">
      <div class="sa-modal-head"><h3>${escHtml(item.name)}</h3><button type="button" class="admin-mini-btn" id="poOptClose">&times;</button></div>
      ${spiceHtml}${sideHtml}${extrasHtml}
      <div class="po-opt-group"><label>Quantity</label>
        <span class="admin-cart-item-qty"><button type="button" class="admin-mini-btn" id="poQtyMinus">&minus;</button><span id="poQtyVal">1</span><button type="button" class="admin-mini-btn" id="poQtyPlus">+</button></span>
      </div>
      <button type="button" class="btn btn-primary btn-block" id="poOptConfirm">Add to order</button>
    </div>`;
  overlay.classList.add("active");
  const close = () => overlay.classList.remove("active");
  $id("poOptClose").addEventListener("click", close);
  overlay.querySelectorAll(".po-pills").forEach((group) =>
    group.querySelectorAll(".po-pill").forEach((btn) =>
      btn.addEventListener("click", () => {
        group.querySelectorAll(".po-pill").forEach((b) => b.classList.remove("selected"));
        btn.classList.add("selected");
        if ($id("poSideError")) $id("poSideError").style.display = "none";
      }),
    ),
  );
  const qtyEl = $id("poQtyVal");
  $id("poQtyMinus").addEventListener("click", () => (qtyEl.textContent = Math.max(1, parseInt(qtyEl.textContent, 10) - 1)));
  $id("poQtyPlus").addEventListener("click", () => (qtyEl.textContent = parseInt(qtyEl.textContent, 10) + 1));
  $id("poOptConfirm").addEventListener("click", () => {
    const spiceBtn = overlay.querySelector('[data-group="spice"] .po-pill.selected');
    const sideBtn = overlay.querySelector('[data-group="side"] .po-pill.selected');
    if ((item.sides || []).length && !sideBtn) {
      $id("poSideError").style.display = "block";
      return;
    }
    const extras = [...overlay.querySelectorAll('input[type="checkbox"]:checked')].map((c) => ({
      id: parseInt(c.value, 10), name: c.dataset.name, price: parseFloat(c.dataset.price),
    }));
    addLineToAdminCart(item, {
      spice: spiceBtn ? spiceBtn.dataset.name : null,
      side: sideBtn ? { id: parseInt(sideBtn.dataset.id, 10), name: sideBtn.dataset.name } : null,
      extras,
      qty: parseInt(qtyEl.textContent, 10) || 1,
    });
    close();
  });
}

function updateCartQty(lineId, delta) {
  const line = adminCart.find((l) => l.lineId === lineId);
  if (!line) return;
  line.qty += delta;
  if (line.qty <= 0) adminCart = adminCart.filter((l) => l.lineId !== lineId);
  renderAdminCart();
  renderAdminMenu();
}

const adminItemsTotal = () =>
  adminCart.reduce((sum, l) => sum + (l.unit + l.extras.reduce((s, e) => s + e.price, 0)) * l.qty, 0);

function poOrderType() {
  return $id("orderType")?.value || "collection";
}

function renderAdminCart() {
  const cartContainer = $id("adminCartList");
  const cartCount = $id("adminCartCount");
  const cartEmpty = $id("adminCartEmpty");
  const totalEl = $id("adminCartTotal");
  if (!cartContainer) return;

  if (cartCount) cartCount.textContent = adminCart.reduce((s, c) => s + c.qty, 0);
  if ($id("poJumpCount")) $id("poJumpCount").textContent = adminCart.reduce((s, c) => s + c.qty, 0);

  if (adminCart.length === 0) {
    if (cartEmpty) cartEmpty.style.display = "";
    cartContainer.innerHTML = "";
    if (totalEl) totalEl.innerHTML = "";
    if ($id("poJumpTotal")) $id("poJumpTotal").textContent = "R0.00";
    if ($id("poManualFeeField")) $id("poManualFeeField").style.display = poOrderType() === "delivery" && (poDelivery.tooFar || poDelivery.error || poDelivery.manualFee !== null) ? "" : "none";
    return;
  }
  if (cartEmpty) cartEmpty.style.display = "none";

  cartContainer.innerHTML = adminCart
    .map((l) => {
      const extrasUnit = l.extras.reduce((s, e) => s + e.price, 0);
      const rows = [];
      if (l.spice) rows.push(`<li><span>${escHtml(l.spice)}</span><span class="po-free">free</span></li>`);
      if (l.side) rows.push(`<li><span>Side: ${escHtml(l.side.name)}</span><span class="po-free">free</span></li>`);
      l.extras.forEach((e) => rows.push(`<li><span>+ ${escHtml(e.name)}</span><span>R${(e.price * l.qty).toFixed(2)}</span></li>`));
      return `
      <div class="admin-cart-item" data-line="${escHtml(l.lineId)}">
        <div class="admin-cart-item-info">
          <div class="po-line-head"><strong>${escHtml(l.name)}${l.qty > 1 ? ` <em>&times; ${l.qty}</em>` : ""}</strong><span>R${(l.unit * l.qty).toFixed(2)}</span></div>
          ${rows.length ? `<ul class="po-breakdown">${rows.join("")}</ul>` : ""}
          <div class="po-line-foot">
            <span class="admin-cart-item-qty">
              <button type="button" class="admin-mini-btn qty-btn" data-delta="-1">&minus;</button>
              <span>${l.qty}</span>
              <button type="button" class="admin-mini-btn qty-btn" data-delta="1">+</button>
            </span>
            ${rows.length ? `<span class="admin-cart-item-price">Item total R${((l.unit + extrasUnit) * l.qty).toFixed(2)}</span>` : ""}
          </div>
        </div>
        <button type="button" class="admin-mini-btn danger remove-from-cart-btn" title="Remove"><i class="fas fa-xmark"></i></button>
      </div>`;
    })
    .join("");

  cartContainer.querySelectorAll(".admin-cart-item").forEach((row) => {
    const id = row.dataset.line;
    row.querySelectorAll(".qty-btn").forEach((btn) =>
      btn.addEventListener("click", () => updateCartQty(id, parseInt(btn.dataset.delta, 10))),
    );
    row.querySelector(".remove-from-cart-btn").addEventListener("click", () => {
      adminCart = adminCart.filter((l) => l.lineId !== id);
      renderAdminCart();
      renderAdminMenu();
    });
  });

  const items = adminItemsTotal();
  const isDelivery = poOrderType() === "delivery";
  let feeRow = "";
  let fee = 0;
  // The manual fee box only matters when the band price can't be used.
  const manualField = $id("poManualFeeField");
  if (manualField) manualField.style.display = isDelivery && (poDelivery.tooFar || poDelivery.error || poDelivery.manualFee !== null) ? "" : "none";
  if (isDelivery) {
    if (poDelivery.loading) feeRow = `<div class="po-total-row"><span>Delivery fee</span><span>Calculating&hellip;</span></div>`;
    else if (poDelivery.manualFee !== null) {
      fee = poDelivery.manualFee;
      feeRow = `<div class="po-total-row"><span>Delivery fee (set manually)</span><span>R${fee.toFixed(2)}</span></div>`;
    } else if (poDelivery.tooFar) feeRow = `<div class="po-total-row po-warn"><span>Delivery</span><span>A bit far (${poDelivery.distanceKm} km) - set fee below</span></div>`;
    else if (poDelivery.lat !== null) {
      fee = poDelivery.fee;
      feeRow = `<div class="po-total-row"><span>Delivery fee (${poDelivery.distanceKm} km)</span><span>R${fee.toFixed(2)}</span></div>`;
    } else feeRow = `<div class="po-total-row"><span>Delivery fee</span><span>Enter address</span></div>`;
  }
  if ($id("poJumpTotal")) $id("poJumpTotal").textContent = `R${(items + fee).toFixed(2)}`;
  if (totalEl) {
    totalEl.innerHTML = `
      <div class="po-total-row"><span>Items</span><span>R${items.toFixed(2)}</span></div>
      ${feeRow}
      <div class="po-total-row po-grand"><span>Total</span><span>R${(items + fee).toFixed(2)}</span></div>`;
  }
}

/** Address -> coordinates -> fee, exactly like the customer checkout. */
// ---- Structured delivery address (same fields as the customer checkout) ----
function poAddressParts() {
  const v = (id) => ($id(id)?.value || "").trim();
  return { street: v("poStreet"), unit: v("poUnit"), suburb: v("poSuburb"), city: v("poCity"), postal: v("poPostal"), province: v("poProvince") };
}
/** Full address for the order (unit included); also kept in the hidden #orderDeliveryAddress. */
function poComposeAddress() {
  const a = poAddressParts();
  const full = [a.unit, a.street, a.suburb, a.city, a.postal, a.province].filter(Boolean).join(", ");
  if ($id("orderDeliveryAddress")) $id("orderDeliveryAddress").value = full;
  return full;
}
function poMissingAddressParts() {
  const a = poAddressParts();
  return [[a.street, "street address"], [a.suburb, "suburb"], [a.city, "town/city"], [a.postal, "postal code"], [a.province, "province"]]
    .filter(([value]) => !value)
    .map(([, label]) => label);
}

/** OK button: every required field filled in, then look it up and price it. Nothing is calculated before this. */
async function poConfirmAddress() {
  const missing = poMissingAddressParts();
  if (missing.length) {
    $id("poDeliveryStatus").textContent = `Please add the ${missing.join(", ")}, then tap OK.`;
    return;
  }
  const btn = $id("poAddressOkBtn");
  btn.disabled = true;
  try {
    await poLookupAddress();
  } finally {
    btn.disabled = false;
  }
}

async function poLookupAddress() {
  const address = poComposeAddress();
  if (!address || poMissingAddressParts().length || poOrderType() !== "delivery") return;
  if (address === poDelivery.lastInput && poDelivery.lat !== null) return;
  poReset();
  poDelivery.loading = true;
  $id("poDeliveryStatus").textContent = "";
  renderAdminCart();
  try {
    const geoRes = await fetch("/api/delivery/geocode", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ parts: poAddressParts() }),
      signal: AbortSignal.timeout(30000),
    });
    const geo = await geoRes.json();
    if (!geoRes.ok || !geo.lat) throw new Error(geo.error || "Couldn't find that address.");
    const feeRes = await fetch("/api/delivery/fee", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ lat: geo.lat, lng: geo.lng }),
      signal: AbortSignal.timeout(15000),
    });
    const fee = await feeRes.json();
    if (!feeRes.ok) throw new Error(fee.error || "Couldn't work out the delivery fee.");
    Object.assign(poDelivery, { lat: geo.lat, lng: geo.lng, display: geo.display_name, lastInput: address, distanceKm: fee.distance_km });
    if (fee.too_far) {
      poDelivery.tooFar = true;
      $id("poDeliveryStatus").textContent = `Found: ${geo.display_name}. It's a bit far (${fee.distance_km} km) - set the delivery fee manually below to continue.`;
    } else {
      poDelivery.fee = Number(fee.fee) || 0;
      $id("poDeliveryStatus").textContent = geo.approximate
        ? `Street not pinned - priced for the area: ${geo.display_name} (${fee.distance_km} km). Set the fee manually if needed.`
        : `Found: ${geo.display_name} (${fee.distance_km} km)`;
      if (geo.approximate) poDelivery.error = "approximate"; // shows the manual fee box
    }
  } catch (err) {
    poReset();
    poDelivery.error = err.message || "lookup failed";
    $id("poDeliveryStatus").textContent =
      (err.name === "TimeoutError" ? "The address lookup timed out." : err.message) +
      " Add the suburb or village and try again, or set the delivery fee manually.";
  } finally {
    poDelivery.loading = false;
    renderAdminCart();
  }
}

/** South African number -> international digits for wa.me (0821234567 -> 27821234567). */
function waNumber(phone) {
  let d = String(phone || "").replace(/[^\d+]/g, "");
  if (d.startsWith("+")) return d.slice(1);
  if (d.startsWith("00")) return d.slice(2);
  if (d.startsWith("0")) return "27" + d.slice(1);
  return d;
}
const waLink = (phone, text) => `https://wa.me/${waNumber(phone)}?text=${encodeURIComponent(text)}`;
window.waLink = waLink;

function updateOrderTypeFields() {
  const type = poOrderType();
  $id("poDeliveryFields").style.display = type === "delivery" ? "" : "none";
  $id("poTableField").style.display = type === "dine_in" ? "" : "none";
  if (type !== "delivery") {
    poReset();
    poClearManualFee();
  }
  renderAdminCart();
}

async function generatePaymentLink() {
  if (orderGenerating) return;
  if (adminCart.length === 0) {
    toast("Add items to the cart first.");
    return;
  }
  const customerName = cleanText($id("orderCustomerName")?.value, 100);
  const customerEmail = cleanText($id("orderCustomerEmail")?.value, 200).toLowerCase();
  const customerPhone = cleanText($id("orderCustomerPhone")?.value, 50);
  const type = poOrderType();
  const address = cleanText($id("orderDeliveryAddress")?.value, 500);
  const table = cleanText($id("orderTableNumber")?.value, 30);

  if (!customerName || !customerPhone) {
    toast("Enter the customer's name and phone number.");
    return;
  }
  if (type === "dine_in" && !table) {
    toast("Enter the table number.");
    return;
  }
  if (type === "delivery") {
    const missing = poMissingAddressParts();
    if (missing.length) { toast(`Enter the ${missing.join(", ")}.`); return; }
    if (poDelivery.manualFee === null) {
      if (poDelivery.lat === null || poComposeAddress() !== poDelivery.lastInput) { toast("Tap OK under the address to calculate the delivery fee first."); return; }
      if (poDelivery.loading) { toast("Still working out the delivery fee - try again in a moment."); return; }
      if (poDelivery.lat === null) { toast("The address couldn't be located - set the delivery fee manually."); return; }
      if (poDelivery.tooFar) { toast("That address is a bit far - set the delivery fee manually first."); return; }
    }
  }

  orderGenerating = true;
  const btn = $id("generatePayLinkBtn");
  if (btn) {
    btn.disabled = true;
    btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Generating&hellip;';
  }

  try {
    const res = await adminFetch("/api/admin/build-cart", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        customer_name: customerName,
        customer_email: customerEmail,
        customer_phone: customerPhone,
        order_type: type,
        delivery_address: type === "delivery" ? address : undefined,
        delivery_lat: type === "delivery" ? poDelivery.lat : undefined,
        delivery_lng: type === "delivery" ? poDelivery.lng : undefined,
        delivery_fee_override: type === "delivery" && poDelivery.manualFee !== null ? poDelivery.manualFee : undefined,
        table_number: type === "dine_in" ? table : undefined,
        pickup_time: $id("orderPickupTime")?.value || undefined,
        special_instructions: cleanText($id("orderInstructions")?.value, 500),
        cart_items: adminCart.map((l) => ({
          id: l.itemId,
          quantity: l.qty,
          spice_level: l.spice,
          side: l.side ? l.side.id : undefined,
          extras: l.extras.map((e) => e.id),
        })),
      }),
    });
    const data = await res.json().catch(() => ({}));

    if (!res.ok || !data.success) {
      toast(data.error || "Failed to generate payment link.");
      return;
    }

    const msg = `Hi ${customerName}, your Fulude's Cafe order #${data.order_id} comes to R${Number(data.total_amount).toFixed(2)}. Please pay securely here to confirm it: ${data.pay_url}`;
    const linkEl = $id("paymentLinkResult");
    if (linkEl) {
      linkEl.style.display = "";
      linkEl.innerHTML = `
        <div class="payment-link-card">
          <div class="payment-link-info">
            <strong>Order #${escHtml(data.order_id)}</strong>
            <span class="payment-link-total">R${Number(data.total_amount).toFixed(2)}</span>
          </div>
          <div class="payment-link-url-wrap">
            <input type="text" id="paymentLinkUrl" value="${escHtml(data.pay_url)}" readonly>
            <button type="button" class="btn btn-primary copy-paylink-btn">Copy</button>
          </div>
          <a class="btn btn-primary btn-block" style="margin-top:8px" target="_blank" rel="noopener" href="${waLink(customerPhone, msg)}"><i class="fab fa-whatsapp"></i> Send link on WhatsApp</a>
          <small class="admin-hint">The order only goes to the kitchen once the customer has paid.</small>
        </div>`;
      $id("paymentLinkUrl").addEventListener("click", (e) => e.target.select());
      linkEl.querySelector(".copy-paylink-btn").addEventListener("click", () => {
        const input = $id("paymentLinkUrl");
        input.select();
        navigator.clipboard
          .writeText(input.value)
          .then(() => toast("Payment link copied!"))
          .catch(() => {
            document.execCommand("copy");
            toast("Payment link copied!");
          });
      });
    }
    toast("Payment link generated!");
    adminCart = [];
    poReset();
    poClearManualFee();
    renderAdminCart();
    renderAdminMenu();
  } catch (err) {
    toast(err.message || "Failed to generate payment link.");
  } finally {
    orderGenerating = false;
    if (btn) {
      btn.disabled = false;
      btn.innerHTML = '<i class="fas fa-bolt"></i> Generate Payment Link';
    }
  }
}

/** Abandons the order being built: empties the cart and every field, hides any generated link. */
function cancelPlaceOrder() {
  const touched = adminCart.length || ["orderCustomerName", "orderCustomerPhone", "poStreet"].some((id) => $id(id)?.value.trim());
  if (touched && !confirm("Cancel this order? Everything you added will be cleared.")) return;
  adminCart = [];
  poReset();
  poClearManualFee();
  ["orderCustomerName", "orderCustomerPhone", "orderCustomerEmail", "orderDeliveryAddress", "poStreet", "poUnit", "poSuburb", "poCity", "poPostal", "poProvince", "orderTableNumber", "orderInstructions"].forEach((id) => {
    if ($id(id)) $id(id).value = "";
  });
  $id("orderType").value = "collection";
  $id("orderPickupTime").selectedIndex = 0;
  $id("poDeliveryStatus").textContent = "";
  const linkEl = $id("paymentLinkResult");
  linkEl.style.display = "none";
  linkEl.innerHTML = "";
  updateOrderTypeFields();
  renderAdminMenu();
  toast("Order cleared.");
}

async function refreshPlaceOrderMenu() {
  const grid = $id("adminMenuGrid");
  if (grid) grid.innerHTML = '<p class="menu-loading">Loading&hellip;</p>';
  await loadAdminMenu();
  renderAdminMenu();
  renderAdminCart();
}

function initPlaceOrderTab() {
  const container = $id("placeOrderContent");
  if (!container) return;

  // Already built: keep the cart and typed details, just refresh the menu
  // (dishes/prices/stock may have changed - or the first load may have failed).
  if (container.dataset.loaded === "true") {
    refreshPlaceOrderMenu();
    return;
  }

  container.innerHTML = `
    <div class="place-order-layout">
      <div class="place-order-main">
        <div class="admin-panel-header"><h3>Menu</h3></div>
        <input type="search" id="adminMenuSearch" class="po-search" placeholder="Search dishes&hellip;" />
        <div id="adminMenuCats" class="po-chips"></div>
        <div id="adminMenuGrid" class="admin-menu-grid"><p class="menu-loading">Loading&hellip;</p></div>
      </div>
      <div class="place-order-sidebar">
        <div class="admin-cart-panel">
          <div class="admin-cart-header"><h3>Order <span id="adminCartCount" class="admin-badge">0</span></h3></div>
          <div id="adminCartEmpty" class="admin-cart-empty">Nothing added yet</div>
          <div id="adminCartList" class="admin-cart-list"></div>
          <div id="adminCartTotal" class="admin-cart-total"></div>
        </div>
        <div class="admin-form-card">
          <h3>Order type</h3>
          <div class="form-group">
            <select id="orderType">
              <option value="collection">Collection</option>
              <option value="delivery">Delivery</option>
              <option value="dine_in">Dine in</option>
            </select>
          </div>
          <div id="poDeliveryFields" style="display:none">
            <div class="form-group">
              <label for="poStreet">Street address</label>
              <input type="text" id="poStreet" class="po-addr" placeholder="e.g. 12 Mvelaphanda Street" autocomplete="off">
            </div>
            <div class="form-group">
              <label for="poUnit">Unit / flat number <small>(optional)</small></label>
              <input type="text" id="poUnit" class="po-addr" autocomplete="off">
            </div>
            <div class="form-group">
              <label for="poSuburb">Suburb</label>
              <input type="text" id="poSuburb" class="po-addr" autocomplete="off">
            </div>
            <div class="form-group">
              <label for="poCity">Town / City</label>
              <input type="text" id="poCity" class="po-addr" autocomplete="off">
            </div>
            <div class="form-group">
              <label for="poPostal">Postal code</label>
              <input type="text" id="poPostal" class="po-addr" inputmode="numeric" maxlength="4" autocomplete="off">
            </div>
            <div class="form-group">
              <label for="poProvince">Province</label>
              <select id="poProvince" class="po-addr">
                <option value="">Choose…</option>
                <option>Limpopo</option><option>Gauteng</option><option>Mpumalanga</option>
                <option>North West</option><option>KwaZulu-Natal</option><option>Free State</option>
                <option>Eastern Cape</option><option>Western Cape</option><option>Northern Cape</option>
              </select>
            </div>
            <input type="hidden" id="orderDeliveryAddress">
            <button type="button" id="poAddressOkBtn" class="btn btn-primary btn-block">OK - calculate delivery fee</button>
            <small id="poDeliveryStatus" class="admin-hint" style="display:block;margin:6px 0 10px"></small>
            <div class="form-group" id="poManualFeeField" style="display:none">
              <label for="poManualFee">Delivery fee (R) - set manually</label>
              <input type="number" id="poManualFee" min="0" step="0.01" placeholder="e.g. 80">
              <small class="admin-hint">Added to the total before the payment link is sent.</small>
            </div>
          </div>
          <div id="poTableField" class="form-group" style="display:none">
            <label for="orderTableNumber">Table number</label>
            <input type="text" id="orderTableNumber" placeholder="e.g. 4">
          </div>
          <div class="form-group">
            <label for="orderPickupTime">When</label>
            <select id="orderPickupTime">
              <option value="As soon as possible">As soon as possible</option>
              <option value="In 30 minutes">In 30 minutes</option>
              <option value="In 1 hour">In 1 hour</option>
              <option value="In 2 hours">In 2 hours</option>
            </select>
          </div>
          <div class="form-group">
            <label for="orderInstructions">Special instructions</label>
            <input type="text" id="orderInstructions" placeholder="Optional">
          </div>
        </div>
        <div class="admin-form-card">
          <h3>Customer details</h3>
          <div class="form-group">
            <label for="orderCustomerName">Name</label>
            <input type="text" id="orderCustomerName" placeholder="Customer name" required>
          </div>
          <div class="form-group">
            <label for="orderCustomerPhone">Phone / WhatsApp</label>
            <input type="tel" id="orderCustomerPhone" placeholder="0821234567" required>
          </div>
          <div class="form-group">
            <label for="orderCustomerEmail">Email <small>(optional - links the order to their account)</small></label>
            <input type="email" id="orderCustomerEmail" placeholder="customer@example.com">
          </div>
          <button type="button" id="generatePayLinkBtn" class="btn btn-primary btn-block">
            <i class="fas fa-bolt"></i> Generate Payment Link
          </button>
          <button type="button" id="cancelPlaceOrderBtn" class="btn btn-secondary btn-block po-cancel-btn">
            <i class="fas fa-xmark"></i> Cancel
          </button>
          <div id="paymentLinkResult" style="display: none; margin-top: 16px"></div>
        </div>
      </div>
    </div>
    <button type="button" class="po-jump-btn" id="poJumpBtn" aria-label="Go to the order">
      <i class="fas fa-receipt"></i> Order (<span id="poJumpCount">0</span>) &middot; <span id="poJumpTotal">R0.00</span>
    </button>`;

  container.dataset.loaded = "true";
  $id("generatePayLinkBtn").addEventListener("click", generatePaymentLink);
  $id("cancelPlaceOrderBtn").addEventListener("click", cancelPlaceOrder);
  $id("poJumpBtn").addEventListener("click", () =>
    document.querySelector(".place-order-sidebar").scrollIntoView({ behavior: "smooth", block: "start" }),
  );
  $id("poManualFee").addEventListener("input", (e) => {
    const value = e.target.value.trim();
    const n = Number(value);
    poDelivery.manualFee = value !== "" && Number.isFinite(n) && n >= 0 ? Math.round(n * 100) / 100 : null;
    renderAdminCart();
  });
  $id("orderType").addEventListener("change", updateOrderTypeFields);
  $id("poAddressOkBtn").addEventListener("click", poConfirmAddress);
  const onAddressEdit = () => {
    if (poComposeAddress() !== poDelivery.lastInput && (poDelivery.lat !== null || poDelivery.error || poDelivery.tooFar)) {
      // A different address needs a fresh price - and a new tap on OK.
      poReset();
      poClearManualFee();
      $id("poDeliveryStatus").textContent = "Address changed - tap OK to update the delivery fee.";
      renderAdminCart();
    }
  };
  container.querySelectorAll(".po-addr").forEach((el) => {
    el.addEventListener("input", onAddressEdit);
    el.addEventListener("change", onAddressEdit);
  });
  $id("adminMenuSearch").addEventListener("input", (e) => {
    adminMenuQuery = e.target.value;
    renderAdminMenu();
  });
  loadAdminMenu().then(() => {
    renderAdminMenu();
    renderAdminCart();
  });
}

// Hook: quick-action buttons that jump to the Place Order tab
document.querySelectorAll("[data-goto-tab]").forEach((btn) => {
  btn.addEventListener("click", () => {
    if (btn.dataset.gotoTab === "placeorder") {
      setTimeout(() => initPlaceOrderTab(), 50);
    }
  });
});


// ---------------------------------------------------------------------
// Reservations: admin books a table for a customer who phoned in, then
// sends the confirmation over WhatsApp (opens WhatsApp with the message
// filled in - the admin taps send).
// ---------------------------------------------------------------------
(function setupAdminReservationForm() {
  const form = $id("resNewForm");
  const toggle = $id("resNewToggle");
  if (!form || !toggle) return;

  toggle.addEventListener("click", () => {
    const open = form.style.display !== "none";
    form.style.display = open ? "none" : "";
    if (!open) $id("resNewDate").min = new Date().toISOString().slice(0, 10);
  });

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const msg = $id("resNewMsg");
    msg.style.color = "";
    msg.textContent = "Saving\u2026";
    const body = {
      action: "create",
      name: cleanText($id("resNewName").value, 100),
      phone: cleanText($id("resNewPhone").value, 50),
      email: cleanText($id("resNewEmail").value, 100),
      reservation_date: $id("resNewDate").value,
      reservation_time: $id("resNewTime").value,
      party_size: parseInt($id("resNewParty").value, 10),
      table_number: cleanText($id("resNewTable").value, 30),
      notes: cleanText($id("resNewNotes").value, 500),
      status: $id("resNewStatus").value,
    };
    try {
      const res = await adminFetch("/api/admin/reservations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.success) {
        msg.style.color = "var(--sa-red)";
        msg.textContent = data.error || "Couldn't save the reservation.";
        return;
      }
      const text = window.reservationWhatsAppText({
        customer_name: body.name, reservation_date: body.reservation_date, reservation_time: body.reservation_time,
        party_size: body.party_size, table_number: body.table_number, status: data.status,
      });
      msg.style.color = "var(--sa-green-deep)";
      msg.innerHTML = `Saved. <a class="btn admin-mini-btn wa-btn" target="_blank" rel="noopener" href="${waLink(body.phone, text)}"><i class="fab fa-whatsapp"></i> Send WhatsApp confirmation</a>`;
      form.reset();
      $id("resNewParty").value = 2;
      if (typeof loadReservations === "function") await loadReservations();
      if (typeof loadDashboardData === "function") loadDashboardData();
    } catch (err) {
      msg.style.color = "var(--sa-red)";
      msg.textContent = err.message || "Couldn't save the reservation.";
    }
  });
})();


// Refreshing the admin page keeps you on the tab you were on (not back on Dashboard).
function restoreAdminTab() {
  const wanted = (location.hash || "").replace("#", "") || sessionStorage.getItem("fulude_admin_tab");
  if (wanted && wanted !== "dashboard") activateTab(wanted);
}
if ($id("dashboard").style.display !== "none") restoreAdminTab();
const _showDashboardForRestore = showDashboard;
showDashboard = function () {
  _showDashboardForRestore();
  setTimeout(restoreAdminTab, 0);
};
