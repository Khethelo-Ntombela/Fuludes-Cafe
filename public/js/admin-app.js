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
  audit: "Audit Logs",
  settings: "Settings"
};

function activateTab(tabName) {
  const btn = document.querySelector(`.admin-tab-btn[data-tab="${tabName}"]`);
  if (btn) btn.click();
}

document.querySelectorAll(".admin-tab-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
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

  const todays = window.adminHistoryAll.filter((o) => isToday(o.created_at) && o.status !== "Cancelled");
  $id("statusOrdersToday").textContent = todays.length;
  const revenue = todays.filter((o) => o.payment_status === "paid").reduce((s, o) => s + Number(o.total_amount || 0), 0);
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

function renderDashKpis(history, stats, months) {
  const active = history.filter((o) => o.status !== "Cancelled");
  const todays = active.filter((o) => isToday(o.created_at));
  const paidToday = todays.filter((o) => o.payment_status === "paid");
  const revenueToday = paidToday.reduce((s, o) => s + Number(o.total_amount || 0), 0);
  const avgOrder = paidToday.length ? revenueToday / paidToday.length : 0;
  const pending = history.filter((o) => ["New", "Preparing", "Ready", "Collection", "Delivery"].includes(o.status)).length;
  const deliveryToday = todays.filter((o) => o.order_type === "delivery").length;
  const todayKey = new Date().toISOString().slice(0, 10);
  const allReservations = typeof reservations !== "undefined" ? reservations : [];
  const resToday = allReservations.filter((r) => r.reservation_date === todayKey && r.status !== "Cancelled").length;

  const revSpark = sparklineSvg(months.map((m) => Number(m.revenue || 0)));
  const ordSpark = sparklineSvg(months.map((m) => Number(m.order_count || 0)));

  const kpis = [
    { label: "Today's Orders", icon: "fa-receipt", value: todays.length, spark: ordSpark, trend: trendHtml(months, "order_count") },
    { label: "Revenue Today", icon: "fa-coins", value: `R${revenueToday.toFixed(0)}`, spark: revSpark, trend: trendHtml(months, "revenue") },
    { label: "Avg Order Value", icon: "fa-basket-shopping", value: `R${avgOrder.toFixed(0)}`, spark: "", trend: "" },
    { label: "Pending Orders", icon: "fa-hourglass-half", value: pending, spark: "", trend: "" },
    { label: "Delivery Orders", icon: "fa-motorcycle", value: deliveryToday, spark: "", trend: "" },
    { label: "Reservations Today", icon: "fa-calendar-check", value: resToday, spark: "", trend: "" }
  ];

  $id("dashKpis").innerHTML = kpis
    .map(
      (k) => `
      <div class="kpi-card">
        <div class="kpi-top"><span class="kpi-label">${k.label}</span><span class="kpi-icon"><i class="fas ${k.icon}"></i></span></div>
        <span class="kpi-value">${k.value}</span>
        <div class="kpi-foot">${k.trend || "<span></span>"}${k.spark}</div>
      </div>`
    )
    .join("");
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
  const recent = history.slice(0, 6);
  $id("dashRecentOrders").innerHTML = recent.length
    ? recent
        .map(
          (o) => `
        <div class="sa-list-item">
          <div class="sa-list-main">
            <div class="sa-list-title">#${o.id} · ${o.customer_name}</div>
            <div class="sa-list-sub">${new Date(o.created_at).toLocaleString("en-ZA", { dateStyle: "medium", timeStyle: "short" })}</div>
          </div>
          <span class="badge badge-status-${o.status.toLowerCase().replace(/ /g, "-")}">${o.status}</span>
          <span class="sa-list-end">${money(o.total_amount)}</span>
        </div>`
        )
        .join("")
    : `<p class="menu-empty">No orders yet.</p>`;

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
    if (o.status === "Cancelled") return;
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
    if (o.status === "Cancelled") return;
    const c = (customers[o.customer_name] = customers[o.customer_name] || { count: 0, spend: 0 });
    c.count += 1;
    if (o.payment_status === "paid") c.spend += Number(o.total_amount || 0);
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
            <div class="sa-list-title">${name}</div>
            <div class="sa-list-sub">${c.count} order${c.count === 1 ? "" : "s"}</div>
          </div>
          <span class="sa-list-end">${money(c.spend)}</span>
        </div>`
        )
        .join("")
    : `<p class="menu-empty">No customers yet.</p>`;
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
  const active = history.filter((o) => o.status !== "Cancelled");

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
  });
});

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
let adminMenuLoadError = "";
let adminMenuCategory = "all";
let adminMenuQuery = "";
let orderGenerating = false;

const escHtml = (v) =>
  String(v ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
const cleanText = (v, max) => String(v || "").replace(/[<>]/g, "").trim().slice(0, max);

/** The price the customer would actually pay right now (special only counts inside its window). */
function adminEffectivePrice(item) {
  const now = Date.now();
  const sp = item.special_price;
  const active =
    sp !== null && sp !== undefined &&
    (!item.special_starts_at || new Date(item.special_starts_at).getTime() <= now) &&
    (!item.special_ends_at || new Date(item.special_ends_at).getTime() >= now);
  return Number(active ? sp : item.price);
}

async function loadAdminMenu() {
  adminMenuLoadError = "";
  try {
    const res = await adminFetch("/api/admin/menu");
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `Menu request failed (${res.status})`);
    // Hidden dishes aren't orderable; sold-out ones are shown but disabled.
    adminMenuData = (data.items || []).filter((i) => i.is_visible !== false);
  } catch (err) {
    adminMenuData = [];
    adminMenuLoadError = err.message || "Couldn't load the menu.";
  }
  return adminMenuData;
}

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

  // Category chips (rebuilt from the data every time)
  const cats = [...new Map(adminMenuData.map((i) => [i.category_id, i.category_name])).entries()];
  const chipsEl = $id("adminMenuCats");
  if (chipsEl) {
    chipsEl.innerHTML =
      `<button type="button" class="po-chip${adminMenuCategory === "all" ? " active" : ""}" data-cat="all">All</button>` +
      cats.map(([id, name]) =>
        `<button type="button" class="po-chip${String(adminMenuCategory) === String(id) ? " active" : ""}" data-cat="${id}">${escHtml(name)}</button>`
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
      const price = adminEffectivePrice(item);
      const onSpecial = price < Number(item.price);
      const qty = adminCart.find((c) => c.id === item.id)?.quantity || 0;
      return `
      <div class="admin-menu-item${soldOut ? " sold-out" : ""}" data-id="${item.id}">
        <div class="admin-menu-item-info">
          <strong>${escHtml(item.name)}</strong>
          <span class="admin-menu-item-price">${onSpecial ? `<s>R${Number(item.price).toFixed(2)}</s> ` : ""}R${price.toFixed(2)}</span>
          ${item.description ? `<small>${escHtml(item.description)}</small>` : ""}
        </div>
        <div class="admin-menu-item-actions">
          <button type="button" class="btn btn-primary admin-mini-btn add-to-cart-btn" data-id="${item.id}" ${soldOut ? "disabled" : ""}>
            ${soldOut ? "Sold out" : `<i class="fas fa-plus"></i> Add${qty ? ` (${qty})` : ""}`}
          </button>
        </div>
      </div>`;
    })
    .join("");
  container.querySelectorAll(".add-to-cart-btn").forEach((btn) => {
    btn.addEventListener("click", () => addToCart(parseInt(btn.dataset.id, 10)));
  });
}

function addToCart(menuItemId) {
  const item = adminMenuData.find((m) => m.id === menuItemId);
  if (!item || item.is_available === false) return;
  const existing = adminCart.find((c) => c.id === menuItemId);
  if (existing) {
    existing.quantity++;
  } else {
    adminCart.push({ id: item.id, name: item.name, unit: adminEffectivePrice(item), quantity: 1 });
  }
  renderAdminCart();
  renderAdminMenu();
}

function removeFromCart(menuItemId) {
  adminCart = adminCart.filter((c) => c.id !== menuItemId);
  renderAdminCart();
  renderAdminMenu();
}

function updateCartQty(menuItemId, delta) {
  const item = adminCart.find((c) => c.id === menuItemId);
  if (!item) return;
  item.quantity += delta;
  if (item.quantity <= 0) return removeFromCart(menuItemId);
  renderAdminCart();
  renderAdminMenu();
}

function renderAdminCart() {
  const cartContainer = $id("adminCartList");
  const cartCount = $id("adminCartCount");
  const cartEmpty = $id("adminCartEmpty");
  const totalEl = $id("adminCartTotal");
  if (!cartContainer) return;

  if (cartCount) cartCount.textContent = adminCart.reduce((s, c) => s + c.quantity, 0);

  if (adminCart.length === 0) {
    if (cartEmpty) cartEmpty.style.display = "";
    cartContainer.innerHTML = "";
    if (totalEl) totalEl.textContent = "";
    return;
  }
  if (cartEmpty) cartEmpty.style.display = "none";

  const total = adminCart.reduce((sum, c) => sum + c.unit * c.quantity, 0);
  cartContainer.innerHTML = adminCart
    .map(
      (c) => `
      <div class="admin-cart-item" data-id="${c.id}">
        <div class="admin-cart-item-info">
          <strong>${escHtml(c.name)}</strong>
          <span class="admin-cart-item-qty">
            <button type="button" class="admin-mini-btn qty-btn" data-id="${c.id}" data-delta="-1">&minus;</button>
            <span>${c.quantity}</span>
            <button type="button" class="admin-mini-btn qty-btn" data-id="${c.id}" data-delta="1">+</button>
          </span>
          <span class="admin-cart-item-price">R${(c.unit * c.quantity).toFixed(2)}</span>
        </div>
        <button type="button" class="admin-mini-btn danger remove-from-cart-btn" data-id="${c.id}" title="Remove">
          <i class="fas fa-xmark"></i>
        </button>
      </div>`,
    )
    .join("");

  cartContainer.querySelectorAll(".qty-btn").forEach((btn) =>
    btn.addEventListener("click", () =>
      updateCartQty(parseInt(btn.dataset.id, 10), parseInt(btn.dataset.delta, 10)),
    ),
  );
  cartContainer.querySelectorAll(".remove-from-cart-btn").forEach((btn) =>
    btn.addEventListener("click", () => removeFromCart(parseInt(btn.dataset.id, 10))),
  );
  if (totalEl) totalEl.textContent = `Total: R${total.toFixed(2)}`;
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

  if (!customerName || !customerEmail || !customerPhone) {
    toast("Enter customer name, email and phone.");
    return;
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
        cart_items: adminCart.map((c) => ({ id: c.id, quantity: c.quantity })),
      }),
    });
    const data = await res.json().catch(() => ({}));

    if (!res.ok || !data.success) {
      toast(data.error || "Failed to generate payment link.");
      return;
    }

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
          <small class="admin-hint">Send this link to the customer to complete payment.</small>
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
        <div class="admin-panel-header">
          <h3>Menu</h3>
        </div>
        <input type="search" id="adminMenuSearch" class="po-search" placeholder="Search dishes&hellip;" />
        <div id="adminMenuCats" class="po-chips"></div>
        <div id="adminMenuGrid" class="admin-menu-grid">
          <p class="menu-loading">Loading&hellip;</p>
        </div>
      </div>
      <div class="place-order-sidebar">
        <div class="admin-cart-panel">
          <div class="admin-cart-header">
            <h3>Cart <span id="adminCartCount" class="admin-badge">0</span></h3>
          </div>
          <div id="adminCartEmpty" class="admin-cart-empty">Cart is empty</div>
          <div id="adminCartList" class="admin-cart-list"></div>
          <div id="adminCartTotal" class="admin-cart-total"></div>
        </div>
        <div class="admin-form-card">
          <h3>Customer Details</h3>
          <div class="form-group">
            <label for="orderCustomerName">Name</label>
            <input type="text" id="orderCustomerName" placeholder="Customer name" required>
          </div>
          <div class="form-group">
            <label for="orderCustomerEmail">Email</label>
            <input type="email" id="orderCustomerEmail" placeholder="customer@example.com" required>
          </div>
          <div class="form-group">
            <label for="orderCustomerPhone">Phone</label>
            <input type="tel" id="orderCustomerPhone" placeholder="0821234567" required>
          </div>
          <button type="button" id="generatePayLinkBtn" class="btn btn-primary btn-block">
            <i class="fas fa-bolt"></i> Generate Payment Link
          </button>
          <div id="paymentLinkResult" style="display: none; margin-top: 16px"></div>
        </div>
      </div>
    </div>`;

  container.dataset.loaded = "true";
  $id("generatePayLinkBtn").addEventListener("click", generatePaymentLink);
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
