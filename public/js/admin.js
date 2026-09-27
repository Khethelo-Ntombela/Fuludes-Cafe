/**
 * public/js/admin.js
 * -----------------------------------------------------------------------
 * Admin dashboard logic for Fulude's Cafe: password login, menu CRUD with
 * category + spice/extras assignment, in-browser image compression +
 * upload to R2, sold-out / visibility toggles, extras & spice-level
 * catalog management, buffet visibility, review replies, and a polling
 * live order monitor.
 * -----------------------------------------------------------------------
 */

const TOKEN_KEY = "fulude_admin_token";
let adminToken = localStorage.getItem(TOKEN_KEY);

let categories = [];
let menuItems = [];
let addons = [];
let spiceLevels = [];
let sides = [];
let staffAccounts = [];
let reservations = [];
let pollIntervalId = null;
let knownPaidNewOrderIds = new Set();
const ADMIN_ALERTS_MUTED_KEY = "fulude_admin_alerts_muted";

const money = (n) => `R${Number(n).toFixed(2)}`;

function addAdminPasswordVisibilityToggle(inputId) {
  const input = document.getElementById(inputId);
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

addAdminPasswordVisibilityToggle("adminPassword");
addAdminPasswordVisibilityToggle("adminResetPassword");

/** "Delivery: 12 Main Rd" / "Dine In (Table 5)" / "Collection" */
function describeOrderType(order) {
  if (order.order_type === "delivery")
    return `Delivery: ${order.delivery_address || ""}`;
  if (order.order_type === "dine_in")
    return `Dine In${order.table_number ? ` (Table ${order.table_number})` : ""}`;
  return "Collection";
}

/** Where a pay-at-X badge should say the customer will pay (legacy orders only - payment is online-only now). */
function orderTypePaymentLabel(order) {
  if (order.order_type === "delivery") return "Delivery";
  if (order.order_type === "dine_in") return "Table";
  return "Pickup";
}

/**
 * The little payment-status pill shown on every order card, in both Live
 * Orders and History. A Cancelled order that was already paid gets a
 * "Refund Needed" pill instead - cancelling never refunds anything
 * automatically (see handleOrderAction's confirm prompt), so this is the
 * at-a-glance reminder that a manual refund may still be needed.
 */
/**
 * Order History wording for a cancelled order: who cancelled it and what
 * happened to the money.
 *   customer -> "Cancelled by the customer · Automatically refunded"
 *   staff    -> "Cancelled by staff · Refund needed"   (or "· Refunded" once done)
 *   admin    -> "Cancelled by admin · Refund needed"
 */
function cancelledStatusLabel(order) {
  const who =
    order.cancelled_by === "customer"
      ? "Cancelled by the customer"
      : order.cancelled_by === "staff"
        ? "Cancelled by staff"
        : order.cancelled_by === "admin"
          ? "Cancelled by admin"
          : order.cancelled_by === "system"
            ? `Cancelled automatically (${order.cancel_reason ? escapeHtml(order.cancel_reason) : "sold out"} - after payment)`
            : "Cancelled";
  if (order.payment_status === "refunded") {
    // The customer can only cancel inside the 2-minute window, where the refund is automatic.
    const auto = order.cancelled_by === "customer" && !order.refund_error;
    return `${who} · ${auto ? "Automatically refunded" : "Refunded"}`;
  }
  if (order.payment_status === "paid") return `${who} · Refund needed`;
  return `${who} · Not paid, nothing to refund`;
}

function paymentBadgeHtml(order) {
  if (order.payment_method !== "online") {
    // Legacy orders placed before payment became mandatory.
    return `<span class="badge badge-unpaid">Pay at ${orderTypePaymentLabel(order)}</span>`;
  }
  if (order.status === "Cancelled" && order.payment_status === "paid") {
    return `<span class="badge badge-refund">Refund Needed</span>`;
  }
  if (order.payment_status === "refunded") {
    return `<span class="badge badge-paid">Refunded</span>`;
  }
  if (order.payment_status === "paid") {
    return `<span class="badge badge-paid">Paid Online</span>`;
  }
  if (order.payment_status === "failed") {
    return `<span class="badge badge-refund">Payment Failed</span>`;
  }
  return `<span class="badge badge-unpaid">Awaiting Payment</span>`;
}

// ---------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------
async function adminFetch(url, options = {}) {
  const res = await fetch(url, {
    ...options,
    headers: {
      ...(options.headers || {}),
      Authorization: `Bearer ${adminToken}`,
    },
  });
  // 401 = the session really ended. (A section this admin isn't allowed to
  // use answers 403 instead, which never logs anyone out.)
  if (res.status === 401) {
    logout();
    throw new Error("Session expired. Please log in again.");
  }
  return res;
}

// ---------------------------------------------------------------------
// Permissions: admins created by the main admin only see (and load) the
// sections they were given. Main admin = { all: true }.
// ---------------------------------------------------------------------
let adminPermissions = { all: true }; // replaced with the real ones right after sign-in
const adminCan = (perm) => Boolean(adminPermissions.all || adminPermissions[perm]);
window.adminCan = adminCan;

const TAB_PERMISSIONS = {
  dashboard: ["orders"], orders: ["orders"], placeorder: ["orders"], history: ["orders"], sales: ["orders"],
  reservations: ["orders"], menu: ["menu"], specials: ["menu"], addons: ["menu"], reviews: ["reviews"],
  buffet: ["buffet"], customers: ["customers"], audit: ["audit"],
  settings: ["settings", "admin_accounts", "marketing", "menu"],
};
const SETTINGS_TAB_PERMISSIONS = {
  general: ["settings"], staff: ["settings"], "admin-accounts": ["admin_accounts"], categories: ["menu"],
  delivery: ["settings"], payments: ["settings"], security: ["settings"], marketing: ["marketing"],
};
const allowed = (needs) => !needs || needs.some(adminCan);

async function loadAdminPermissions() {
  try {
    const res = await adminFetch("/api/admin/me");
    if (res.ok) adminPermissions = (await res.json()).permissions || {};
  } catch {
    /* logged out by adminFetch if the session is gone */
  }
}

/** Hides sidebar tabs, settings tabs and shortcut buttons this admin can't use; opens the first allowed tab. */
function applyAdminPermissions() {
  document.querySelectorAll(".admin-tab-btn").forEach((btn) => {
    btn.style.display = allowed(TAB_PERMISSIONS[btn.dataset.tab]) ? "" : "none";
  });
  document.querySelectorAll("[data-goto-tab]").forEach((btn) => {
    btn.style.display = allowed(TAB_PERMISSIONS[btn.dataset.gotoTab]) ? "" : "none";
  });
  document.querySelectorAll(".settings-tab-btn").forEach((btn) => {
    btn.style.display = allowed(SETTINGS_TAB_PERMISSIONS[btn.dataset.settingsTab]) ? "" : "none";
  });
  const activeTab = document.querySelector(".admin-tab-btn.active");
  if (!activeTab || activeTab.style.display === "none") {
    [...document.querySelectorAll(".admin-tab-btn")].find((b) => b.style.display !== "none")?.click();
  }
  const activeSettings = document.querySelector(".settings-tab-btn.active");
  if (activeSettings && activeSettings.style.display === "none") {
    [...document.querySelectorAll(".settings-tab-btn")].find((b) => b.style.display !== "none")?.click();
  }
}

document.getElementById("logoutBtn").addEventListener("click", logout);

document
  .getElementById("forgotAdminPasswordBtn")
  .addEventListener("click", async () => {
    const email = prompt(
      "Enter the admin email address for the password reset link:",
    );
    if (!email) return;

    try {
      const res = await fetch("/api/admin/forgot-password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email }),
      });
      const data = await res.json();
      if (!res.ok || !data.success)
        throw new Error(data.error || "Couldn't send reset email.");
      alert(
        data.message ||
          "If that email has an admin account, a reset link is on its way.",
      );
    } catch (err) {
      alert(err.message || "Couldn't process that request.");
    }
  });

function logout() {
  adminToken = null;
  localStorage.removeItem(TOKEN_KEY);
  clearInterval(pollIntervalId);
  document.getElementById("dashboard").style.display = "none";
  document.getElementById("loginScreen").style.display = "flex";
  document.getElementById("loginForm").style.display = "block";
  document.getElementById("adminResetForm").style.display = "none";
}

async function showDashboard() {
  document.getElementById("loginScreen").style.display = "none";
  document.getElementById("dashboard").style.display = "grid";
  await loadAdminPermissions();
  if (!adminToken) return; // the session ended while checking
  applyAdminPermissions();
  loadEverything();
  clearInterval(pollIntervalId);
  pollIntervalId = setInterval(adminLivePoll, ADMIN_POLL_MS);
  initAdminAudio();
  setupAdminAlertToggle();
  if (!adminPushBound) {
    adminPushBound = true;
    FuludePWA.bindPushToggle(document.getElementById("pushToggleBtn"), "admin", () => adminToken, {
      onLabel: "Alerts on",
      offLabel: "Phone alerts",
    });
  }
}
let adminPushBound = false;
FuludePWA.setupInstallButton("Install admin app");

document.getElementById("loginForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const errorEl = document.getElementById("loginError");
  errorEl.style.display = "none";

  try {
    const res = await fetch("/api/admin/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: document.getElementById("adminEmail").value.trim(),
        password: document.getElementById("adminPassword").value,
      }),
    });
    const data = await res.json();
    if (!res.ok || !data.success)
      throw new Error(data.error || "Couldn't log in.");

    adminToken = data.token;
    adminPermissions = data.permissions || {};
    localStorage.setItem(TOKEN_KEY, adminToken);
    document.getElementById("loginForm").reset();
    showDashboard();
  } catch (err) {
    errorEl.textContent = err.message || "Couldn't log in.";
    errorEl.style.display = "block";
  }
});

function initAdminAudio() {
  FuludeOrderAlert.init();
}

function playAdminBeep(repeats = 2) {
  FuludeOrderAlert.play(repeats, ADMIN_ALERTS_MUTED_KEY);
}

function setupAdminAlertToggle() {
  FuludeOrderAlert.bindMuteButton(
    document.getElementById("alertMuteBtn"),
    document.getElementById("alertMuteIcon"),
    ADMIN_ALERTS_MUTED_KEY,
  );
}

// ---------------------------------------------------------------------
// Tabs
// ---------------------------------------------------------------------
let historyLoadedOnce = false;

document.querySelectorAll(".admin-tab-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    document
      .querySelectorAll(".admin-tab-btn")
      .forEach((b) => b.classList.remove("active"));
    document
      .querySelectorAll(".admin-tab-panel")
      .forEach((p) => p.classList.remove("active"));
    btn.classList.add("active");
    document.getElementById(`tab-${btn.dataset.tab}`).classList.add("active");

    if (btn.dataset.tab === "history" && !historyLoadedOnce) {
      historyLoadedOnce = true;
      loadOrderHistory(true);
    }
    if (btn.dataset.tab === "sales") {
      loadSalesStats(); // always fresh - numbers change any time an order is placed or history is cleared
    }
    if (btn.dataset.tab === "audit") {
      loadAudit(true);
    }
    if (btn.dataset.tab === "customers") loadCustomerRecords();
    if (btn.dataset.tab === "buffet") loadBuffetEventsAdmin();
    if (btn.dataset.tab === "settings") loadAdminAccounts();
  });
});

/** Loads only the sections this admin is allowed to use. */
function loadEverything() {
  if (adminCan("orders")) {
    loadOrders();
    loadReservations();
  }
  if (adminCan("menu")) {
    loadCategories();
    loadMenuItems();
    loadAddonsAndSpice();
  }
  if (adminCan("reviews")) loadAdminReviews();
  if (adminCan("settings")) {
    loadBuffetSetting();
    loadStaffAccounts();
  }
  if (adminCan("admin_accounts")) loadAdminAccounts();
  initBuffetAdminHandlers();
  initStoreStatusHandlers();
  initAuditHandlers();
}

async function loadCustomerRecords() {
  const search = encodeURIComponent(
    document.getElementById("customerSearch")?.value.trim() || "",
  );
  const list = document.getElementById("customerRecordsList");
  if (!list) return;
  try {
    const response = await adminFetch(`/api/admin/customers?search=${search}`);
    const data = await response.json();
    if (!response.ok)
      throw new Error(data.error || "Failed to load customers.");
    list.innerHTML =
      (data.customers || [])
        .map(
          (customer) =>
            `<div class="sa-list-item"><div class="sa-list-main"><div class="sa-list-title">${customer.name}</div><div class="sa-list-sub">${customer.email} · ${customer.phone_number || "No phone"} · Joined ${new Date(customer.created_at).toLocaleDateString()}</div></div><span class="admin-hint">${customer.marketing_email_opt_in ? "Email opt-in" : "No email opt-in"}</span></div>`,
        )
        .join("") || '<p class="menu-empty">No recods yet</p>';
  } catch (error) {
    list.innerHTML = `<p class="menu-empty">No recods yet</p>`;
  }
}

let adminAccountsById = {};
let adminAccountsMeta = { me: null, can_manage: false };

async function loadAdminAccounts() {
  const list = document.getElementById("adminAccountsList");
  if (!list) return;
  try {
    const response = await adminFetch("/api/admin/accounts");
    const data = await response.json();
    if (!response.ok)
      throw new Error(data.error || "Failed to load admin accounts.");
    adminAccountsMeta = { me: data.me, can_manage: Boolean(data.can_manage) };
    adminAccountsById = Object.fromEntries((data.accounts || []).map((a) => [a.id, a]));
    // Only the main admin may hand out full access.
    document.getElementById("adminFullAccessOption").style.display = adminAccountsMeta.can_manage ? "" : "none";
    list.innerHTML =
      (data.accounts || [])
        .map((account) => {
          const isMe = Number(account.id) === Number(data.me);
          const perms = account.permissions?.all
            ? "Main admin (full access)"
            : Object.keys(account.permissions || {})
                .filter((key) => account.permissions[key])
                .join(", ") || "None";
          const actions = data.can_manage
            ? `<div style="display:flex;gap:6px;margin-top:8px">
                <button type="button" class="admin-mini-btn" data-edit-admin="${account.id}"><i class="fas fa-pen"></i> Edit</button>
                ${isMe ? "" : `<button type="button" class="admin-mini-btn danger" data-delete-admin="${account.id}"><i class="fas fa-trash"></i> Delete</button>`}
              </div>`
            : "";
          return `<div class="sa-list-item"><div class="sa-list-main"><div class="sa-list-title">${escapeHtml(account.email)}${isMe ? " <small>(you)</small>" : ""}${account.is_active === false ? ' <span class="badge badge-refund">Disabled</span>' : ""}</div><div class="sa-list-sub">Permissions: ${escapeHtml(perms)}</div>${actions}</div></div>`;
        })
        .join("") ||
      '<p class="menu-empty">No database admin accounts yet.</p>';
  } catch (error) {
    list.innerHTML = `<p class="form-error">${error.message}</p>`;
  }
}

/** Back to "Create Admin Account". */
function resetAdminAccountForm() {
  const form = document.getElementById("adminAccountForm");
  form.reset();
  document.getElementById("adminAccountId").value = "";
  document.getElementById("adminAccountFormTitle").textContent = "Create Admin Account";
  document.getElementById("adminAccountSubmitBtn").textContent = "Create Admin Account";
  document.getElementById("adminAccountPasswordLabel").textContent = "Temporary Password";
  document.getElementById("adminAccountPassword").required = true;
  document.getElementById("adminAccountCancelBtn").style.display = "none";
  document.getElementById("adminActiveOption").style.display = "none";
  document.getElementById("adminPermissionOptions").style.display = "";
}

function startEditAdminAccount(account) {
  const form = document.getElementById("adminAccountForm");
  document.getElementById("adminAccountId").value = account.id;
  document.getElementById("adminAccountEmail").value = account.email;
  document.getElementById("adminAccountPassword").value = "";
  document.getElementById("adminAccountPassword").required = false;
  document.getElementById("adminAccountPasswordLabel").textContent = "New Password (leave blank to keep)";
  document.getElementById("adminAccountFormTitle").textContent = `Edit: ${account.email}`;
  document.getElementById("adminAccountSubmitBtn").textContent = "Save Changes";
  document.getElementById("adminAccountCancelBtn").style.display = "";
  document.getElementById("adminActiveOption").style.display = "";
  document.getElementById("adminAccountActive").checked = account.is_active !== false;
  const full = Boolean(account.permissions?.all);
  document.getElementById("adminFullAccess").checked = full;
  document.getElementById("adminPermissionOptions").style.display = full ? "none" : "";
  document.querySelectorAll("#adminPermissionOptions input").forEach((input) => {
    input.checked = full || Boolean(account.permissions?.[input.value]);
  });
  document.getElementById("adminAccountStatus").textContent = "";
  form.scrollIntoView({ behavior: "smooth", block: "start" });
}

document.getElementById("adminFullAccess")?.addEventListener("change", (e) => {
  document.getElementById("adminPermissionOptions").style.display = e.target.checked ? "none" : "";
});
document.getElementById("adminAccountCancelBtn")?.addEventListener("click", resetAdminAccountForm);

document.getElementById("adminAccountsList")?.addEventListener("click", async (e) => {
  const editBtn = e.target.closest("[data-edit-admin]");
  if (editBtn) {
    const account = adminAccountsById[editBtn.dataset.editAdmin];
    if (account) startEditAdminAccount(account);
    return;
  }
  const delBtn = e.target.closest("[data-delete-admin]");
  if (!delBtn) return;
  const account = adminAccountsById[delBtn.dataset.deleteAdmin];
  if (!account) return;
  if (!confirm(`Delete the admin account ${account.email}?\n\nThey'll be signed out and won't be able to log in again. This can't be undone.`)) return;
  const response = await adminFetch("/api/admin/accounts", {
    method: "DELETE",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id: account.id }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.success) {
    alert(data.error || "Couldn't delete the account.");
    return;
  }
  if (String(document.getElementById("adminAccountId").value) === String(account.id)) resetAdminAccountForm();
  loadAdminAccounts();
});

document
  .getElementById("customerSearchBtn")
  ?.addEventListener("click", loadCustomerRecords);
document
  .getElementById("adminAccountForm")
  ?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const fullAccess = document.getElementById("adminFullAccess").checked;
    const permissions = fullAccess
      ? { all: true }
      : Object.fromEntries(
          [...document.querySelectorAll("#adminPermissionOptions input")].map(
            (input) => [input.value, input.checked],
          ),
        );
    const status = document.getElementById("adminAccountStatus");
    const editingId = document.getElementById("adminAccountId").value;
    try {
      const response = await adminFetch("/api/admin/accounts", {
        method: editingId ? "PUT" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: editingId ? Number(editingId) : undefined,
          email: document.getElementById("adminAccountEmail").value.trim(),
          password: document.getElementById("adminAccountPassword").value,
          permissions,
          is_active: editingId ? document.getElementById("adminAccountActive").checked : undefined,
        }),
      });
      const data = await response.json();
      if (!response.ok || !data.success)
        throw new Error(data.error || (editingId ? "Failed to save the admin account." : "Failed to create admin account."));
      resetAdminAccountForm();
      status.textContent = editingId ? "Admin account updated." : "Admin account created.";
      loadAdminAccounts();
    } catch (error) {
      status.textContent = error.message;
    }
  });

// ---------------------------------------------------------------------
// Orders: poll every 30s
// ---------------------------------------------------------------------
/**
 * Live refresh every 5s so nobody has to reload the page: the kitchen
 * board always (it drives the new-order beep, even in a background tab),
 * plus whatever fast-changing tab is open while the page is visible.
 */
const ADMIN_POLL_MS = 5000;
let adminPollTick = 0;
function adminLivePoll() {
  adminPollTick++;
  if (!adminCan("orders")) return; // nothing live to refresh for this admin
  loadOrders();
  if (document.hidden) return;
  const tab = document.querySelector(".admin-tab-btn.active")?.dataset.tab;
  if (tab === "reservations") loadReservations();
  // The dashboard pulls full history - every 30s is plenty.
  if (tab === "dashboard" && adminPollTick % 6 === 0 && typeof loadDashboardData === "function") loadDashboardData();
}

async function loadOrders() {
  try {
    const res = await adminFetch("/api/admin/pending-orders");
    const data = await res.json();
    kdsScheduleNextRelease(data, loadOrders);
    const orders = data.orders || [];

    document.getElementById("orderCountBadge").textContent = orders.length;
    renderOrders(orders);

    // Detect newly arrived PAID orders (status New && payment_status === 'paid')
    const paidNewIds = new Set(
      orders
        .filter((o) => o.status === "New" && o.payment_status === "paid")
        .map((o) => String(o.id)),
    );
    const newOnes = [...paidNewIds].filter(
      (id) => !knownPaidNewOrderIds.has(id),
    );
    if (newOnes.length > 0) {
      playAdminBeep(Math.min(4, newOnes.length));
      // Highlight new cards briefly
newOnes.forEach((id) => {
        const el = document.querySelector(`[data-order-id="${id}"]`);
        if (el) {
          el.classList.add("kds-new-arrival");
          setTimeout(() => el.classList.remove("kds-new-arrival"), 8000);
        }
      });
}

/** Load and render ingredient stock-up suggestions */
async function loadIngredientSuggestions() {
  const listEl = document.getElementById("ingredientSuggestionsList");
  const days = document.getElementById("suggestionsDays")?.value || "7";
  const threshold = document.getElementById("suggestionsLowStockThreshold")?.value || "5";
  
  if (!listEl) return;
  
  listEl.innerHTML = `<p class="menu-loading">Loading suggestions…</p>`;

  try {
    const res = await adminFetch(`/api/admin/ingredient-suggestions?days=${days}&low_stock_threshold=${threshold}`);
    const data = await res.json();
    
    if (!res.ok) throw new Error(data.error || "Failed to load");
    
    renderIngredientSuggestions(data.ingredients || []);
  } catch (err) {
    listEl.innerHTML = `<p class="form-error">Failed to load: ${err.message}</p>`;
  }
}

function renderIngredientSuggestions(ingredients) {
  const listEl = document.getElementById("ingredientSuggestionsList");
  if (!listEl) return;

  if (!ingredients.length) {
    listEl.innerHTML = `<p class="menu-empty">No ingredients flagged. All dishes are well-stocked and selling normally.</p>`;
    return;
  }

  listEl.innerHTML = ingredients.map((ing, idx) => {
    const urgencyClass = ing.urgency_score >= 3 ? "high" : ing.urgency_score >= 2 ? "medium" : "low";
    const urgencyLabel = ing.urgency_score >= 3 ? "High" : ing.urgency_score >= 2 ? "Medium" : "Low";
    
    return `
      <div class="ingredient-suggestion-item urgency-${urgencyClass}">
        <div class="ingredient-header">
          <strong>${ing.ingredient_name}</strong>
          <span class="badge badge-status-${urgencyClass}">${urgencyLabel} urgency</span>
        </div>
        <div class="ingredient-meta">
          <span>${ing.dish_count} dish${ing.dish_count === 1 ? "" : "es"} use this</span>
          <span>Urgency score: ${ing.urgency_score}</span>
        </div>
        <details class="ingredient-dishes">
          <summary>Show dishes (${ing.dishes.length})</summary>
          <table class="sa-table" style="margin-top: 8px; font-size: 0.85rem;">
            <thead>
              <tr><th>Dish</th><th style="text-align:center">Units Sold</th><th style="text-align:center">Stock Qty</th><th>Reasons</th></tr>
            </thead>
            <tbody>
              ${ing.dishes.map(d => `
                <tr>
                  <td>${d.name}</td>
                  <td style="text-align:center">${d.units_sold || "—"}</td>
                  <td style="text-align:center">${d.stock_quantity !== null ? d.stock_quantity : "Untracked"}</td>
                  <td>${d.reasons.join("; ")}</td>
                </tr>
              `).join("")}
            </tbody>
          </table>
        </details>
      </div>
    `;
  }).join("");
}

// Event listeners for suggestions panel
document.getElementById("refreshSuggestionsBtn")?.addEventListener("click", loadIngredientSuggestions);
document.getElementById("suggestionsDays")?.addEventListener("change", loadIngredientSuggestions);
document.getElementById("suggestionsLowStockThreshold")?.addEventListener("change", loadIngredientSuggestions);

// Load suggestions when Menu & Stock tab is activated
document.querySelectorAll('.admin-tab-btn[data-tab="menu"]').forEach(btn => {
  btn.addEventListener("click", () => {
    setTimeout(loadIngredientSuggestions, 100);
  });
});
    knownPaidNewOrderIds = paidNewIds;
  } catch (err) {
    // Non-fatal; the next poll will retry.
  }
}

/** Sticky kitchen control bar above the board: instant operational visibility. */
const KITCHEN_CAPACITY = 12; // active tickets considered a "full" kitchen

function renderKitchenStrip(allOrders) {
  // Stats cover today's orders only, so they start from zero at midnight.
  const orders = allOrders.filter(kdsIsToday);
  const note = document.getElementById("kpiResetNote");
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
  set("kpiWaiting", orders.filter((o) => o.status === "New").length);
  set("kpiPreparing", orders.filter((o) => o.status === "Preparing").length);
  set("kpiReady", orders.filter((o) => o.status === "Ready").length);
  set("kpiPrepTime", active.length ? `${avgAge} min` : "—");
  set("kpiLongest", active.length ? `${longest} min` : "—", longest >= 30);
  set("kpiEfficiency", `${load}%`, load >= 90);
}

let lastKitchenOrders = [];
kdsOnTick(() => renderKitchenStrip(lastKitchenOrders)); // live Avg Ticket Age / Longest Waiting

function renderOrders(orders) {
  const list = document.getElementById("ordersList");
  lastKitchenOrders = orders;
  renderKitchenStrip(orders);

  list.innerHTML = kdsBoardHtml(orders, [
    "New",
    "Preparing",
    "Ready",
    "Collection",
    "Delivery",
  ], {
    compactStatuses: ["Collection", "Delivery"],
  });

  kdsBindBoard(list, orders, {
    onAction: handleOrderAction,
    confirmAction: (order, status) => {
      if (status === "Cancelled" && order.payment_status === "paid") {
        return confirm(
          `Order #${order.id} was already paid online (${money(order.total_amount)}). Cancelling marks it "Refund needed" - you can then refund it with one tap from Order History (the "Refund via Yoco" button).\n\nCancel this order?`,
        );
      }
      if (status !== "Cancelled" && order.payment_status !== "paid") {
        return confirm(
          `Order #${order.id} hasn't been confirmed as paid yet (payment status: ${order.payment_status}). Advancing it means preparing food nobody's actually paid for.\n\nContinue anyway?`,
        );
      }
      return true;
    },
  });
}

/** The kitchen lifecycle is New -> Preparing -> Ready -> Collection/Delivery -> Completed; this renders the one "advance" button for wherever an order currently sits. */
const NEXT_STAGE = { New: "Preparing", Preparing: "Ready" };
const NEXT_STAGE_LABEL = {
  New: "Start Preparing",
  Preparing: "Mark Ready",
};

function getNextStage(order) {
  if (order.status === "Ready") {
    return order.order_type === "delivery" ? "Delivery" : "Collection";
  }
  if (order.status === "Collection" || order.status === "Delivery" || order.status === "Out for Delivery") return "Completed";
  return NEXT_STAGE[order.status] || null;
}

function getNextStageLabel(order) {
  if (order.status === "Ready") {
    return order.order_type === "delivery"
      ? "Send Delivery"
      : "Ready for Collection";
  }
  if (order.status === "Collection") return "Collected";
  if (order.status === "Delivery" || order.status === "Out for Delivery") return "Complete Delivery";
  return NEXT_STAGE_LABEL[order.status] || "";
}

function nextStageButtonHtml(order) {
  const nextStatus = getNextStage(order);
  if (!nextStatus) return ""; // already Completed or Cancelled - nothing to advance
  return `<button class="btn btn-primary admin-mini-btn" data-status="${nextStatus}" data-id="${order.id}">${getNextStageLabel(order)}</button>`;
}

async function handleOrderAction(status, orderId) {
  await adminFetch("/api/admin/order-status", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ order_id: orderId, status }),
  });

  loadOrders();
}

// ---------------------------------------------------------------------
// Order History (read-only view across every status, incl. Completed
// and Cancelled - separate from the live order monitor).
// ---------------------------------------------------------------------
const HISTORY_PAGE_SIZE = 30;
let historyOffset = 0;
let historyOrders = [];
let historySearchDebounce = null;

async function loadOrderHistory(reset) {
  if (reset) {
    historyOffset = 0;
    historyOrders = [];
  }
  const search = document.getElementById("historySearch").value.trim();
  const status = document.getElementById("historyStatusFilter").value;

  const params = new URLSearchParams({
    limit: HISTORY_PAGE_SIZE,
    offset: historyOffset,
  });
  if (search) params.set("search", search);

  // "Refund Needed" isn't a real order status - it's a shortcut for
  // Cancelled orders that were already paid, so translate it into the
  // two real filters the API understands.
  if (status === "refund_needed") {
    params.set("status", "Cancelled");
    params.set("payment_status", "paid");
  } else if (status) {
    params.set("status", status);
  }

  try {
    const res = await adminFetch(`/api/admin/orders?${params.toString()}`);
    const data = await res.json();
    const newOrders = data.orders || [];

    historyOrders = reset ? newOrders : [...historyOrders, ...newOrders];
    historyOffset += newOrders.length;

    renderOrderHistory(historyOrders);
    document.getElementById("historyLoadMoreBtn").style.display =
      newOrders.length === HISTORY_PAGE_SIZE ? "inline-block" : "none";
  } catch (err) {
    // adminFetch already handles 401 by logging out; anything else, leave the list as-is.
  }
}

function renderOrderHistory(orders) {
  const list = document.getElementById("historyList");
  if (orders.length === 0) {
    list.innerHTML = `<p class="menu-empty">No orders match yet.</p>`;
    return;
  }

  list.innerHTML = orders
    .map((order) => {
      const itemsHtml = order.items
        .map((item) => {
          const extras = Array.isArray(item.extras)
            ? item.extras
            : JSON.parse(item.extras || "[]");
          const bits = [];
          if (item.spice_level) bits.push(item.spice_level);
          if (extras.length) bits.push(extras.map((e) => e.name).join(", "));
          return `<li>${item.quantity}x ${item.item_name}${bits.length ? ` (${bits.join(" · ")})` : ""} - ${money(item.subtotal)}</li>`;
        })
        .join("");

      const orderDate = new Date(order.created_at).toLocaleString("en-ZA", {
        dateStyle: "medium",
        timeStyle: "short",
      });

      const refundNeeded =
        order.refund_needed === true ||
        (order.status === "Cancelled" &&
          order.payment_status === "paid" &&
          order.refund_processed_at == null);
      const statusLabel = order.status === "Cancelled" ? cancelledStatusLabel(order) : order.status;

      return `
      <div class="admin-order-card status-${order.status.toLowerCase()}${refundNeeded ? " refund-needed" : ""}">
        <div class="admin-order-card-header">
          <strong>#${order.id} - ${order.customer_name}</strong>
          <span>${money(order.total_amount)}</span>
        </div>
        <div class="admin-order-meta">
          ${orderDate} · ${order.status === "Cancelled" ? `<strong class="${refundNeeded ? "refund-needed-note" : ""}">${statusLabel}</strong>` : statusLabel} · ${order.customer_phone} · ${describeOrderType(order)} · ${order.pickup_time} · ${paymentBadgeHtml(order)}
          ${order.special_instructions ? `<br>Note: ${order.special_instructions}` : ""}
          ${
            refundNeeded
              ? `<div class="refund-actions">
                  ${order.refund_error ? `<div class="refund-error">Last refund attempt failed: ${escapeHtml(order.refund_error)}</div>` : ""}
                  <button type="button" class="admin-mini-btn refund-yoco-btn" data-order-id="${order.id}" data-amount="${order.total_amount}"><i class="fas fa-rotate-left"></i> Refund ${money(order.total_amount)} via Yoco</button>
                  <button type="button" class="admin-mini-btn mark-refund-btn" data-order-id="${order.id}">Already refunded in Yoco</button>
                </div>`
              : order.refund_processed_at
                ? `<br>Refunded ${new Date(order.refund_processed_at).toLocaleString("en-ZA")}${order.refund_ref ? ` (Yoco ref: ${escapeHtml(order.refund_ref)})` : ""}`
                : ""
          }
        </div>
        <ul class="admin-order-items">${itemsHtml}</ul>
      </div>
    `;
    })
    .join("");

  list.querySelectorAll(".refund-yoco-btn").forEach((button) =>
    button.addEventListener("click", async () => {
      const id = Number(button.dataset.orderId);
      if (!confirm(`Refund ${money(button.dataset.amount)} for order #${id} back to the customer's card through Yoco now?`)) return;
      button.disabled = true;
      button.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Refunding…';
      const response = await adminFetch("/api/admin/refund", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ order_id: id, mode: "yoco" }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || !data.success) {
        alert(data.error || "The refund didn't go through.");
        loadOrderHistory(true);
        return;
      }
      alert(`Order #${id} refunded through Yoco. It usually reaches the customer's card within a few business days.`);
      loadOrderHistory(true);
    }),
  );

  list.querySelectorAll(".mark-refund-btn").forEach((button) =>
    button.addEventListener("click", async () => {
      if (!confirm("Only use this if you already refunded this order yourself in the Yoco dashboard. Mark it as refunded?")) return;
      const response = await adminFetch("/api/admin/refund", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ order_id: Number(button.dataset.orderId), mode: "manual" }),
      });
      const data = await response.json();
      if (!response.ok || !data.success)
        return alert(data.error || "Failed to update refund.");
      loadOrderHistory(true);
    }),
  );
}

document.getElementById("historySearch").addEventListener("input", () => {
  clearTimeout(historySearchDebounce);
  historySearchDebounce = setTimeout(() => loadOrderHistory(true), 350);
});
document
  .getElementById("historyStatusFilter")
  .addEventListener("change", () => loadOrderHistory(true));
document
  .getElementById("historyLoadMoreBtn")
  .addEventListener("click", () => loadOrderHistory(false));

document
  .getElementById("clearHistoryBtn")
  .addEventListener("click", async () => {
    if (
      !confirm(
        "Permanently delete every Completed and Cancelled order? Live orders are kept. This also lowers the counts on Your Sales and can't be undone.",
      )
    ) {
      return;
    }
    const res = await adminFetch("/api/admin/orders", { method: "DELETE" });
    const data = await res.json();
    alert(`Cleared ${data.deleted_count || 0} order(s) from history.`);
    loadOrderHistory(true);
    loadSalesStats();
  });

const salesPeriodSelect = document.getElementById("salesPeriodSelect");
document
  .getElementById("salesFilterBtn")
  .addEventListener("click", () => loadSalesStats());

if (salesPeriodSelect) {
  salesPeriodSelect.addEventListener("change", toggleSalesDateInputs);
}

populateSalesMonthSelect();
setDefaultSalesDates();
toggleSalesDateInputs();

// ---------------------------------------------------------------------
// Your Sales: period-based order + revenue stats and a hand-drawn SVG pie
// chart of orders per menu category (no charting library - keeps this
// vanilla/free-tier).
// ---------------------------------------------------------------------
const PIE_COLORS = [
  "#a88b4a",
  "#0a0a0a",
  "#c9a96e",
  "#6e6e6e",
  "#2c2c2c",
  "#e8d5b7",
  "#8a6f3a",
  "#4a4a4a",
  "#d4b483",
  "#3a3a3a",
  "#b89968",
  "#5c5c5c",
  "#c2a06a",
  "#242424",
];

function formatDateInput(date) {
  const year = date.getFullYear();
  const month = `${date.getMonth() + 1}`.padStart(2, "0");
  const day = `${date.getDate()}`.padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function getLastSixMonths() {
  const now = new Date();
  return Array.from({ length: 6 }, (_, idx) => {
    const date = new Date(now.getFullYear(), now.getMonth() - (5 - idx), 1);
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
  });
}

function populateSalesMonthSelect() {
  const select = document.getElementById("salesMonthSelect");
  if (!select) return;

  const months = getLastSixMonths();
  select.innerHTML = months
    .map((month) => {
      const [year, monthNumber] = month.split("-");
      const label = new Date(
        Number(year),
        Number(monthNumber) - 1,
        1,
      ).toLocaleString("en-ZA", { month: "short", year: "numeric" });
      return `<option value="${month}" selected>${label}</option>`;
    })
    .join("");
}

function getSelectedSalesMonths() {
  const select = document.getElementById("salesMonthSelect");
  if (!select) return [];
  return Array.from(select.selectedOptions).map((option) => option.value);
}

function formatMonthLabel(monthKey) {
  const [year, monthNumber] = monthKey.split("-");
  return new Date(Number(year), Number(monthNumber) - 1, 1).toLocaleString(
    "en-ZA",
    { month: "long", year: "numeric" },
  );
}

function buildSalesHeading(months) {
  if (!months || months.length === 0) return "Category Breakdown";
  if (months.length === 1)
    return `Category Breakdown for ${formatMonthLabel(months[0])}`;
  if (months.length === 6) return "Category Breakdown for the last 6 months";
  const first = formatMonthLabel(months[0]);
  const last = formatMonthLabel(months[months.length - 1]);
  return `Category Breakdown for ${first} to ${last}`;
}

function setDefaultSalesDates() {
  const now = new Date();
  const fromInput = document.getElementById("salesFromDate");
  const toInput = document.getElementById("salesToDate");
  if (!fromInput || !toInput) return;

  const from = new Date(now.getFullYear(), now.getMonth() - 5, 1);
  const to = new Date(now.getFullYear(), now.getMonth() + 1, 1);

  fromInput.value = formatDateInput(from);
  toInput.value = formatDateInput(to);
}

function toggleSalesDateInputs() {
  const salesPeriodSelect = document.getElementById("salesPeriodSelect");
  const fromInput = document.getElementById("salesFromDate");
  const toInput = document.getElementById("salesToDate");
  if (!salesPeriodSelect || !fromInput || !toInput) return;

  const isCustom = salesPeriodSelect.value === "custom";
  // Hide the whole labelled group, not just the input, so no orphan labels remain.
  (fromInput.closest(".form-group") || fromInput).style.display = isCustom
    ? ""
    : "none";
  (toInput.closest(".form-group") || toInput).style.display = isCustom
    ? ""
    : "none";
}

async function loadSalesStats() {
  const chartWrap = document.getElementById("salesChartWrap");
  const salesPeriodSelect = document.getElementById("salesPeriodSelect");
  const salesFromDate = document.getElementById("salesFromDate");
  const salesToDate = document.getElementById("salesToDate");
  const selectedMonths = getSelectedSalesMonths();

  try {
    const params = new URLSearchParams();
    params.set("period", salesPeriodSelect?.value || "last_6_months");
    if (selectedMonths.length > 0) {
      params.set("months", selectedMonths.join(","));
    }
    if (salesPeriodSelect?.value === "custom") {
      if (salesFromDate?.value) params.set("from", salesFromDate.value);
      if (salesToDate?.value) params.set("to", salesToDate.value);
    }

    const res = await adminFetch(`/api/admin/stats?${params.toString()}`);
    const data = await res.json();

    document.getElementById("statsTotalOrders").textContent =
      data.total_orders ?? 0;
    document.getElementById("statsTotalRevenue").textContent =
      `R${Number(data.total_revenue || 0).toFixed(2)}`;
    document.getElementById("statsMonthlyOrders").textContent =
      data.monthly_orders ?? 0;
    document.getElementById("statsMonthlyRevenue").textContent =
      `R${Number(data.monthly_revenue || 0).toFixed(2)}`;

    // Derived KPIs: average basket + month-over-month revenue growth.
    const avgBasketEl = document.getElementById("statsAvgBasket");
    if (avgBasketEl) {
      const avg =
        data.total_orders > 0
          ? Number(data.total_revenue || 0) / data.total_orders
          : 0;
      avgBasketEl.textContent = `R${avg.toFixed(2)}`;
    }
    const growthEl = document.getElementById("statsGrowth");
    if (growthEl) {
      const months = data.monthly_breakdown || [];
      if (months.length >= 2) {
        const last = Number(months[months.length - 1].revenue || 0);
        const prev = Number(months[months.length - 2].revenue || 0);
        const pct = prev > 0 ? ((last - prev) / prev) * 100 : 0;
        growthEl.innerHTML = `${pct >= 0 ? "▲" : "▼"} ${Math.abs(pct).toFixed(1)}%`;
        growthEl.style.color =
          pct >= 0 ? "var(--sa-green-deep)" : "var(--sa-red)";
      } else {
        growthEl.textContent = "—";
      }
    }

    renderSalesPieChart(
      data.categories || [],
      data.monthly_breakdown || [],
      selectedMonths,
    );
    // Store for the sidebar status card + dashboard (admin-app.js reads this).
    window.adminLastStats = data;
    if (typeof window.onStatsLoaded === "function") window.onStatsLoaded(data);
  } catch (err) {
    chartWrap.innerHTML = `<p class="menu-empty">Couldn't load sales stats.</p>`;
  }
}

/** Renders the month-by-month revenue trend as simple div-based bars (no chart library). */
function renderMonthlyTrendHtml(monthlyBreakdown) {
  if (monthlyBreakdown.length === 0) return "";

  const maxRevenue = Math.max(
    ...monthlyBreakdown.map((m) => Number(m.revenue || 0)),
    1,
  );
  const cols = monthlyBreakdown
    .map((m) => {
      const revenue = Number(m.revenue || 0);
      const heightPct = Math.max(2, Math.round((revenue / maxRevenue) * 100));
      const [year, monthNumber] = m.month.split("-");
      const label = new Date(
        Number(year),
        Number(monthNumber) - 1,
        1,
      ).toLocaleString("en-ZA", { month: "short" });
      return `
        <div class="admin-trend-col" title="${m.month}: ${m.order_count} order${m.order_count === 1 ? "" : "s"} · R${revenue.toFixed(2)}">
          <span class="admin-trend-value">R${Math.round(revenue)}</span>
          <div class="admin-trend-bar" style="height: ${heightPct}%"></div>
          <span class="admin-trend-label">${label} '${year.slice(2)}</span>
          <span class="admin-trend-orders">${m.order_count} order${m.order_count === 1 ? "" : "s"}</span>
        </div>
      `;
    })
    .join("");

  return `
    <div style="width: 100%; margin-bottom: 28px;">
      <h3 style="margin-bottom: 4px;">Revenue by Month</h3>
      <div class="admin-trend-chart">${cols}</div>
    </div>
  `;
}

function renderSalesPieChart(categories, monthlyBreakdown, selectedMonths) {
  const chartWrap = document.getElementById("salesChartWrap");
  const headingText = buildSalesHeading(selectedMonths);

  const monthlyBreakdownHtml = renderMonthlyTrendHtml(monthlyBreakdown);

  if (categories.length === 0) {
    chartWrap.innerHTML = `
      ${monthlyBreakdownHtml}
      <h3 style="margin-bottom: 12px;">${headingText}</h3>
      <p class="menu-empty">No paid orders yet - stats will show up here once customers start paying.</p>
    `;
    return;
  }

  const total = categories.reduce((sum, c) => sum + c.order_count, 0);
  const radius = 100;
  const cx = 110;
  const cy = 110;

  let cumulativeAngle = -90; // start at 12 o'clock
  const slices = categories.map((cat, idx) => {
    const percent = total > 0 ? cat.order_count / total : 0;
    const startAngle = cumulativeAngle;
    const sweepAngle = percent * 360;
    cumulativeAngle += sweepAngle;
    const endAngle = cumulativeAngle;
    const color = PIE_COLORS[idx % PIE_COLORS.length];

    return {
      name: cat.category_name,
      count: cat.order_count,
      percent,
      color,
      startAngle,
      endAngle,
      pathD: describeArc(cx, cy, radius, startAngle, endAngle),
    };
  });

  const pathsHtml = slices
    .map(
      (s, idx) =>
        `<path d="${s.pathD}" fill="${s.color}" data-idx="${idx}"></path>`,
    )
    .join("");

  const labelsHtml = slices
    .filter((s) => s.percent >= 0.04)
    .map((s) => {
      const midAngle = (s.startAngle + s.endAngle) / 2;
      const labelRadius = radius * 0.72;
      const labelX = cx + labelRadius * Math.cos((midAngle * Math.PI) / 180);
      const labelY = cy + labelRadius * Math.sin((midAngle * Math.PI) / 180);
      return `<text x="${labelX}" y="${labelY}" text-anchor="middle" dominant-baseline="middle" fill="white" font-size="12" font-weight="700">${Math.round(s.percent * 100)}%</text>`;
    })
    .join("");

  const legendHtml = slices
    .map(
      (s) => `
    <div class="admin-pie-legend-item">
      <span class="admin-pie-legend-swatch" style="background:${s.color}"></span>
      <span>${s.name}</span>
      <span class="admin-pie-legend-count">${s.count} order${s.count === 1 ? "" : "s"}</span>
    </div>
  `,
    )
    .join("");

  chartWrap.innerHTML = `
    ${monthlyBreakdownHtml}
    <h3 style="margin-bottom: 12px; width: 100%;">${headingText}</h3>
    <div style="display: flex; flex-wrap: wrap; gap: 20px; align-items: flex-start;">
      <svg class="admin-pie-svg" viewBox="0 0 220 220" id="salesPieSvg">${pathsHtml}${labelsHtml}</svg>
      <div class="admin-pie-legend">${legendHtml}</div>
    </div>
    <div class="admin-pie-tooltip" id="salesPieTooltip"></div>
  `;

  const tooltip = document.getElementById("salesPieTooltip");
  chartWrap.querySelectorAll(".admin-pie-svg path").forEach((path) => {
    const slice = slices[parseInt(path.dataset.idx, 10)];
    path.addEventListener("mousemove", (e) => {
      const wrapRect = chartWrap.getBoundingClientRect();
      tooltip.textContent = `${slice.name}: ${slice.count} order${slice.count === 1 ? "" : "s"} (${Math.round(slice.percent * 100)}%)`;
      tooltip.style.left = `${e.clientX - wrapRect.left}px`;
      tooltip.style.top = `${e.clientY - wrapRect.top}px`;
      tooltip.style.display = "block";
    });
    path.addEventListener("mouseleave", () => {
      tooltip.style.display = "none";
    });
  });
}

/** Builds an SVG arc path "wedge" from centre (cx,cy), for a pie slice spanning startAngle..endAngle (degrees, 0 = 3 o'clock). */
function describeArc(cx, cy, r, startAngle, endAngle) {
  // A full-circle single-category case needs special handling - an SVG arc
  // can't sweep a full 360° in one path, so nudge it just under 360.
  if (endAngle - startAngle >= 359.99) endAngle = startAngle + 359.99;

  const start = polarToCartesian(cx, cy, r, endAngle);
  const end = polarToCartesian(cx, cy, r, startAngle);
  const largeArcFlag = endAngle - startAngle <= 180 ? "0" : "1";

  return `M ${cx} ${cy} L ${start.x} ${start.y} A ${r} ${r} 0 ${largeArcFlag} 0 ${end.x} ${end.y} Z`;
}

function polarToCartesian(cx, cy, r, angleDegrees) {
  const angleRadians = (angleDegrees * Math.PI) / 180;
  return {
    x: cx + r * Math.cos(angleRadians),
    y: cy + r * Math.sin(angleRadians),
  };
}

// ---------------------------------------------------------------------
// Categories
// ---------------------------------------------------------------------
async function loadCategories() {
  const res = await adminFetch("/api/admin/categories");
  const data = await res.json();
  categories = data.categories || [];
  renderCategoryOptions();
  renderCategoriesList();
  setupIngredientsVisibility(); // initial check
}

function renderCategoryOptions() {
  const select = document.getElementById("itemCategory");
  select.innerHTML = categories
    .map((c) => `<option value="${c.id}">${c.name}</option>`)
    .join("");

  // Keep the inventory table's category filter in sync too.
  const tableFilter = document.getElementById("menuTableCategory");
  if (tableFilter) {
    const previous = tableFilter.value;
    tableFilter.innerHTML =
      `<option value="">All categories</option>` +
      categories
        .map((c) => `<option value="${c.id}">${c.name}</option>`)
        .join("");
    if (previous && categories.some((c) => String(c.id) === previous))
      tableFilter.value = previous;
  }
}

/** A category counts as drinks when its name says so (keep DRINK_CATEGORY_RE in menu.js in sync). */
function isDrinksCategory(cat) {
  return !!cat && /drink|beverage|juice|soda|cocktail|alcohol|liquor|wine|beer|smoothie|shake|coffee|\btea\b/i.test(`${cat.slug} ${cat.name}`);
}

/** Drinks: show the drink-type picker, hide photos + ingredients. Dessert: hide ingredients. */
function updateMenuFormForCategory() {
  const categorySelect = document.getElementById("itemCategory");
  if (!categorySelect) return;
  const selectedCat = categories.find((c) => String(c.id) === categorySelect.value);
  const drinks = isDrinksCategory(selectedCat);
  const ingredientsGroup = document.getElementById("itemIngredients")?.closest(".form-group");
  if (ingredientsGroup) ingredientsGroup.style.display = drinks || selectedCat?.slug === "dessert" ? "none" : "block";
  document.getElementById("itemDrinkTypeGroup").style.display = drinks ? "block" : "none";
  document.getElementById("itemPhotosGroup").style.display = drinks ? "none" : "";
  document.getElementById("itemImageThumbs").style.display = drinks ? "none" : "";
}

let menuCategoryListenerAttached = false;
function setupIngredientsVisibility() {
  const categorySelect = document.getElementById("itemCategory");
  if (!categorySelect) return;
  if (!menuCategoryListenerAttached) {
    categorySelect.addEventListener("change", updateMenuFormForCategory);
    menuCategoryListenerAttached = true;
  }
  updateMenuFormForCategory();
}

function renderCategoriesList() {
  const list = document.getElementById("categoriesList");
  list.innerHTML = categories
    .map(
      (c) =>
        `<span class="admin-chip">${escapeHtml(c.name)}<button type="button" class="chip-remove" data-delete-category="${c.id}" title="Delete ${escapeHtml(c.name)}" aria-label="Delete ${escapeHtml(c.name)}">&times;</button></span>`,
    )
    .join("");
}

document.getElementById("categoriesList")?.addEventListener("click", async (e) => {
  const btn = e.target.closest("[data-delete-category]");
  if (!btn) return;
  const cat = categories.find((c) => String(c.id) === btn.dataset.deleteCategory);
  if (!cat || !confirm(`Delete the category "${cat.name}"?`)) return;
  const res = await adminFetch("/api/admin/categories", {
    method: "DELETE",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id: cat.id }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.success) {
    alert(data.error || "Couldn't delete the category.");
    return;
  }
  loadCategories();
});

document
  .getElementById("categoryForm")
  .addEventListener("submit", async (e) => {
    e.preventDefault();
    const input = document.getElementById("categoryName");
    await adminFetch("/api/admin/categories", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: input.value.trim() }),
    });
    input.value = "";
    loadCategories();
  });

// ---------------------------------------------------------------------
// Menu items
// ---------------------------------------------------------------------
async function loadMenuItems() {
  const res = await adminFetch("/api/admin/menu");
  const data = await res.json();
  menuItems = data.items || [];
  renderMenuItemsList();
  renderSpecialItemSelect();
  renderSpecialsList();
}

/* Stock button states: unlimited/healthy (gold), low (amber, 5 or fewer left), out (red). */
const LOW_STOCK_THRESHOLD = 5;

function stockButtonClass(item) {
  if (item.stock_quantity === null || item.stock_quantity === undefined) {
    return item.is_available ? " active-toggle" : "";
  }
  if (item.stock_quantity === 0) return " stock-out";
  if (item.stock_quantity <= LOW_STOCK_THRESHOLD) return " stock-low";
  return item.is_available ? " active-toggle" : "";
}

function stockButtonLabel(item) {
  if (item.stock_quantity === null || item.stock_quantity === undefined)
    return "Unlimited";
  if (item.stock_quantity === 0) return "Sold Out";
  if (item.stock_quantity <= LOW_STOCK_THRESHOLD)
    return `${item.stock_quantity} left - Low`;
  return `${item.stock_quantity} in Stock`;
}

/** Stock health cards above the inventory table. */
function renderStockCards() {
  const set = (id, val) => {
    const el = document.getElementById(id);
    if (el) el.textContent = val;
  };
  const tracked = menuItems.filter(
    (i) => i.stock_quantity !== null && i.stock_quantity !== undefined,
  );
  set("stockTotal", menuItems.length);
  set(
    "stockLow",
    tracked.filter(
      (i) => i.stock_quantity > 0 && i.stock_quantity <= LOW_STOCK_THRESHOLD,
    ).length,
  );
  set("stockOut", tracked.filter((i) => i.stock_quantity === 0).length);
  set(
    "stockSpecials",
    menuItems.filter(
      (i) => i.special_price !== null && i.special_price !== undefined,
    ).length,
  );
}

function renderMenuItemsList() {
  const list = document.getElementById("menuItemsList");
  renderStockCards();

  if (menuItems.length === 0) {
    list.innerHTML = `<p class="menu-empty">No menu items yet - add your first dish with the Add Item button.</p>`;
    return;
  }

  const search = (document.getElementById("menuTableSearch")?.value || "")
    .trim()
    .toLowerCase();
  const categoryFilter =
    document.getElementById("menuTableCategory")?.value || "";

  const visible = menuItems.filter((item) => {
    if (search && !item.name.toLowerCase().includes(search)) return false;
    if (categoryFilter && String(item.category_id) !== categoryFilter)
      return false;
    return true;
  });

  const rows = visible
    .map((item) => {
      const priceHtml =
        item.special_price !== null && item.special_price !== undefined
          ? `<s style="color:var(--sa-faint)">${money(item.price)}</s> <strong style="color:var(--sa-gold)">${money(item.special_price)}</strong>`
          : money(item.price);
      const statusBadge = !item.is_visible
        ? `<span class="badge badge-status-completed">Hidden</span>`
        : item.stock_quantity === 0
          ? `<span class="badge badge-status-cancelled">Sold Out</span>`
          : `<span class="badge badge-paid">Live</span>`;
      return `
      <tr>
        <td>${item.image_url ? `<img src="${item.image_url}" alt="${item.name}" loading="lazy" />` : `<div class="table-noimg"></div>`}</td>
        <td><strong>${item.name}</strong>${item.accepts_spice || item.accepts_addons || (item.side_ids || []).length ? `<div class="admin-item-meta">${[item.accepts_spice ? "Spice" : "", item.accepts_addons ? "Extras" : "", (item.side_ids || []).length ? "Side choice" : ""].filter(Boolean).join(" · ")}</div>` : ""}</td>
        <td>${item.category_name}</td>
        <td>${priceHtml}</td>
        <td><button class="admin-mini-btn${stockButtonClass(item)}" data-action="edit-stock" data-id="${item.id}">${stockButtonLabel(item)}</button></td>
        <td>${statusBadge}</td>
        <td>
          <div class="row-actions">
            <button class="admin-mini-btn${item.is_visible ? " active-toggle" : ""}" data-action="toggle-visible" data-id="${item.id}">${item.is_visible ? "Visible" : "Hidden"}</button>
            <button class="admin-mini-btn" data-action="edit" data-id="${item.id}">Edit</button>
            <button class="admin-mini-btn danger" data-action="delete" data-id="${item.id}">Delete</button>
          </div>
        </td>
      </tr>
    `;
    })
    .join("");

  list.innerHTML = `
    <div class="sa-table-wrap">
      <table class="sa-table">
        <thead>
          <tr><th style="width:56px"></th><th>Item</th><th>Category</th><th>Price</th><th>Stock</th><th>Status</th><th style="text-align:right">Actions</th></tr>
        </thead>
        <tbody>${rows || `<tr><td colspan="7"><p class="menu-empty">No items match your search.</p></td></tr>`}</tbody>
      </table>
    </div>
  `;

  list.querySelectorAll("[data-action]").forEach((btn) => {
    btn.addEventListener("click", () =>
      handleMenuItemAction(btn.dataset.action, parseInt(btn.dataset.id, 10)),
    );
  });
}

async function handleMenuItemAction(action, id) {
  const item = menuItems.find((i) => i.id === id);
  if (!item) return;

  if (action === "edit-stock") {
    await handleStockQuantityEdit(item);
  } else if (action === "toggle-visible") {
    await saveMenuItemPatch(item, { is_visible: !item.is_visible });
  } else if (action === "edit") {
    populateFormForEdit(item);
    document.querySelector('.admin-tab-btn[data-tab="menu"]').click();
    window.scrollTo({ top: 0, behavior: "smooth" });
  } else if (action === "delete") {
    if (!confirm(`Delete "${item.name}"? This can't be undone.`)) return;
    await adminFetch(`/api/admin/menu?id=${id}`, { method: "DELETE" });
    loadMenuItems();
  }
}

async function handleStockQuantityEdit(item) {
  const current =
    item.stock_quantity === null || item.stock_quantity === undefined
      ? ""
      : String(item.stock_quantity);
  const input = prompt(
    `Stock quantity for "${item.name}" (leave blank for unlimited/always available):`,
    current,
  );
  if (input === null) return; // dismissed without saving

  const trimmed = input.trim();
  let stockQuantity = null;
  if (trimmed !== "") {
    const n = Number(trimmed);
    if (!Number.isInteger(n) || n < 0) {
      alert(
        "Stock quantity must be a whole number of 0 or more (or left blank for unlimited).",
      );
      return;
    }
    stockQuantity = n;
  }

  await saveMenuItemPatch(item, { stock_quantity: stockQuantity });
}

async function saveMenuItemPatch(item, patch) {
  const merged = { ...item, ...patch };
  await adminFetch("/api/admin/menu", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(merged),
  });
  loadMenuItems();
}

// ---------------------------------------------------------------------
// Specials - pick an existing dish and set a discounted price for it.
// While special_price is set, it IS the dish's real selling price
// everywhere (customer menu, cart, checkout) - see functions/api/order.js.
// ---------------------------------------------------------------------
function renderSpecialItemSelect() {
  const select = document.getElementById("specialItemSelect");
  const previousValue = select.value;
  select.innerHTML = menuItems
    .map(
      (item) =>
        `<option value="${item.id}">${item.name} (${item.category_name} · ${money(item.price)})</option>`,
    )
    .join("");
  if (previousValue && menuItems.some((i) => String(i.id) === previousValue)) {
    select.value = previousValue;
  }
}

function renderSpecialsList() {
  const list = document.getElementById("specialsList");
  const specialItems = menuItems.filter(
    (item) => item.special_price !== null && item.special_price !== undefined,
  );

  if (specialItems.length === 0) {
    list.innerHTML = `<p class="menu-empty">No dishes are on special right now.</p>`;
    return;
  }

  // Campaign performance is derived from order history when admin-app.js
  // has fetched it (orders/revenue that included the discounted dish).
  const history = window.adminHistoryAll || [];

  list.innerHTML = specialItems
    .map((item) => {
      const savings = item.price - item.special_price;
      const matching = history.filter(
        (o) =>
          o.status !== "Cancelled" &&
          (o.items || []).some((line) => line.item_name === item.name),
      );
      const ordersGenerated = matching.length;
      const revenueGenerated = matching.reduce((sum, o) => {
        return (
          sum +
          (o.items || [])
            .filter((line) => line.item_name === item.name)
            .reduce((s, line) => s + Number(line.subtotal || 0), 0)
        );
      }, 0);

      return `
    <div class="promo-card">
      <div class="promo-card-img">${item.image_url ? `<img src="${item.image_url}" alt="${item.name}" loading="lazy" />` : ""}</div>
      <div class="promo-card-body">
        <div class="promo-card-title">${item.name}</div>
        <div class="promo-prices"><span class="was-price">${money(item.price)}</span><span class="now-price">${money(item.special_price)}</span> · Save ${money(savings)}</div>
        <div class="promo-stats">
          <div><strong>${ordersGenerated}</strong> orders</div>
          <div><strong>${money(revenueGenerated)}</strong> revenue</div>
        </div>
        <button class="admin-mini-btn danger" data-end-special-id="${item.id}">End Special</button>
      </div>
    </div>
  `;
    })
    .join("");

  list.querySelectorAll("[data-end-special-id]").forEach((btn) => {
    btn.addEventListener("click", () =>
      handleEndSpecial(parseInt(btn.dataset.endSpecialId, 10)),
    );
  });
}

async function handleEndSpecial(id) {
  const item = menuItems.find((i) => i.id === id);
  if (!item) return;
  await saveMenuItemPatch(item, { special_price: null });
}

document.getElementById("specialForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const hint = document.getElementById("specialFormHint");
  hint.textContent = "";

  const itemId = parseInt(
    document.getElementById("specialItemSelect").value,
    10,
  );
  const item = menuItems.find((i) => i.id === itemId);
  if (!item) {
    hint.textContent = "Pick a dish first.";
    return;
  }

  const priceInput = document.getElementById("specialPriceInput").value.trim();
  const specialPrice = parseFloat(priceInput);
  if (
    !Number.isFinite(specialPrice) ||
    specialPrice < 0 ||
    specialPrice >= item.price
  ) {
    hint.textContent = `Special price must be less than the regular price (${money(item.price)}).`;
    return;
  }
  const startsRaw = document.getElementById("specialStartsInput").value;
  const endsRaw = document.getElementById("specialEndsInput").value;
  // Convert local datetime-local string to ISO by appending timezone offset
  const normalize = (s) => (s ? new Date(s).toISOString() : null);
  const startsIso = normalize(startsRaw);
  const endsIso = normalize(endsRaw);
  if (startsIso && endsIso && new Date(endsIso) <= new Date(startsIso)) {
    hint.textContent = "End must be after start.";
    return;
  }

  await saveMenuItemPatch(item, {
    special_price: specialPrice,
    special_starts_at: startsIso,
    special_ends_at: endsIso,
  });
  document.getElementById("specialForm").reset();
});

function renderSideCheckboxesForForm(selectedIds = []) {
  const container = document.getElementById("itemSideCheckboxes");
  if (!container) return;
  if (sides.length === 0) {
    container.innerHTML = `<p class="admin-hint">Add sides in the "Extras" tab first.</p>`;
    return;
  }
  container.innerHTML = sides
    .map(
      (sd) =>
        `<label class="checkbox-option"><input type="checkbox" value="${sd.id}" ${selectedIds.includes(sd.id) ? "checked" : ""} /> ${sd.name}</label>`,
    )
    .join("");
}

function renderAddonCheckboxesForForm(selectedIds = []) {
  const container = document.getElementById("itemAddonCheckboxes");
  if (addons.length === 0) {
    container.innerHTML = `<p class="admin-hint">Add extras in the "Extras" tab first.</p>`;
    return;
  }
  container.innerHTML = addons
    .map(
      (a) =>
        `<label class="checkbox-option"><input type="checkbox" value="${a.id}" ${selectedIds.includes(a.id) ? "checked" : ""} /> ${a.name} (+${money(a.price)})</label>`,
    )
    .join("");
}

const MAX_ITEM_IMAGES = 6;
let formImages = []; // URLs already uploaded to R2 for the item currently being added/edited

function populateFormForEdit(item) {
  document.getElementById("menuFormTitle").textContent = `Edit: ${item.name}`;
  document.getElementById("itemId").value = item.id;
  document.getElementById("itemName").value = item.name;
  document.getElementById("itemCategory").value = item.category_id;
  document.getElementById("itemDescription").value = item.description || "";
  document.getElementById("itemPrice").value = item.price;
  document.getElementById("itemSpecialPrice").value =
    item.special_price === null || item.special_price === undefined
      ? ""
      : item.special_price;
  document.getElementById("itemStockQuantity").value =
    item.stock_quantity === null || item.stock_quantity === undefined
      ? ""
      : item.stock_quantity;
  document.getElementById("itemVisible").checked = item.is_visible;
  document.getElementById("itemAcceptsSpice").checked = item.accepts_spice;
  document.getElementById("itemAcceptsAddons").checked = item.accepts_addons;
  document.getElementById("itemIngredients").value = item.ingredients || "";
  document.getElementById("itemDrinkType").value = item.drink_type || "beverage";
  updateMenuFormForCategory();

  formImages =
    Array.isArray(item.images) && item.images.length > 0
      ? [...item.images]
      : item.image_url
        ? [item.image_url]
        : [];
  renderImageThumbs();

  renderAddonCheckboxesForForm(item.addon_ids || []);
  renderSideCheckboxesForForm(item.side_ids || []);
  document.getElementById("cancelEditBtn").style.display = "inline-block";
}

function resetMenuForm() {
  document.getElementById("menuFormTitle").textContent = "Add Menu Item";
  document.getElementById("menuItemForm").reset();
  document.getElementById("itemId").value = "";
  document.getElementById("itemSpecialPrice").value = "";
  document.getElementById("itemIngredients").value = "";
  document.getElementById("cancelEditBtn").style.display = "none";
  formImages = [];
  renderImageThumbs();
  renderAddonCheckboxesForForm([]);
  renderSideCheckboxesForForm([]);
  updateMenuFormForCategory();
}

/** Renders the uploaded-photo thumbnail strip, first photo marked as the cover. */
function renderImageThumbs() {
  const container = document.getElementById("itemImageThumbs");
  container.innerHTML = formImages
    .map(
      (url, idx) => `
    <div class="admin-thumb">
      <img src="${url}" alt="Dish photo ${idx + 1}" />
      <button type="button" class="thumb-remove" data-idx="${idx}" aria-label="Remove photo">&times;</button>
      ${idx === 0 ? `<span class="cover-badge">Cover</span>` : ""}
    </div>
  `,
    )
    .join("");

  container.querySelectorAll(".thumb-remove").forEach((btn) => {
    btn.addEventListener("click", () => {
      formImages.splice(parseInt(btn.dataset.idx, 10), 1);
      renderImageThumbs();
    });
  });
}

document
  .getElementById("cancelEditBtn")
  .addEventListener("click", resetMenuForm);

document
  .getElementById("menuItemForm")
  .addEventListener("submit", async (e) => {
    e.preventDefault();
    const id = document.getElementById("itemId").value;
    const selectedAddonIds = [
      ...document.querySelectorAll("#itemAddonCheckboxes input:checked"),
    ].map((el) => parseInt(el.value, 10));
    const stockInput = document
      .getElementById("itemStockQuantity")
      .value.trim();
    const stockQuantity = stockInput === "" ? null : parseInt(stockInput, 10);
    if (
      stockInput !== "" &&
      (!Number.isInteger(stockQuantity) || stockQuantity < 0)
    ) {
      alert(
        "Stock quantity must be a whole number of 0 or more (or left blank for unlimited).",
      );
      return;
    }

    const price = parseFloat(document.getElementById("itemPrice").value);
    // special_price isn't editable on this form (see the Specials tab) - just
    // carry the item's existing special forward. If the regular price was
    // dropped to/below the existing special here, the special no longer
    // makes sense, so end it automatically rather than blocking this save.
    const carriedSpecialInput = document
      .getElementById("itemSpecialPrice")
      .value.trim();
    const carriedSpecialPrice =
      carriedSpecialInput === "" ? null : parseFloat(carriedSpecialInput);
    const specialPrice =
      carriedSpecialPrice !== null && carriedSpecialPrice < price
        ? carriedSpecialPrice
        : null;

    const categoryId = parseInt(document.getElementById("itemCategory").value, 10);
    const isDrink = isDrinksCategory(categories.find((c) => c.id === categoryId));
    const payload = {
      category_id: categoryId,
      drink_type: isDrink ? document.getElementById("itemDrinkType").value : null,
      name: document.getElementById("itemName").value.trim(),
      description: document.getElementById("itemDescription").value.trim(),
      price,
      special_price: specialPrice,
      images: isDrink ? [] : formImages,
      stock_quantity: stockQuantity,
      is_visible: document.getElementById("itemVisible").checked,
      accepts_spice: document.getElementById("itemAcceptsSpice").checked,
      accepts_addons: document.getElementById("itemAcceptsAddons").checked,
      addon_ids: selectedAddonIds,
      side_ids: [...document.querySelectorAll("#itemSideCheckboxes input:checked")].map((el) =>
        parseInt(el.value, 10),
      ),
      ingredients: document.getElementById("itemIngredients").value
        .split("\n")
        .map((s) => s.trim())
        .filter((s) => s.length > 0),
    };

    if (id) {
      payload.id = parseInt(id, 10);
      await adminFetch("/api/admin/menu", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
    } else {
      await adminFetch("/api/admin/menu", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
    }

    resetMenuForm();
    loadMenuItems();
  });

// ---- Image compression + upload (supports selecting several photos at once) ----
document.getElementById("itemImage").addEventListener("change", async (e) => {
  const files = [...e.target.files];
  if (files.length === 0) return;
  const statusEl = document.getElementById("imageUploadStatus");

  const room = MAX_ITEM_IMAGES - formImages.length;
  if (room <= 0) {
    statusEl.textContent = `You've reached the ${MAX_ITEM_IMAGES}-photo limit. Remove one first.`;
    e.target.value = "";
    return;
  }
  const filesToUpload = files.slice(0, room);
  if (files.length > filesToUpload.length) {
    statusEl.textContent = `Only uploading ${filesToUpload.length} - the ${MAX_ITEM_IMAGES}-photo limit per dish.`;
  }

  for (let i = 0; i < filesToUpload.length; i++) {
    const file = filesToUpload[i];
    statusEl.textContent = `Compressing photo ${i + 1} of ${filesToUpload.length}…`;
    try {
      const webpBlob = await compressImageToWebP(file, 300 * 1024);
      statusEl.textContent = `Uploading photo ${i + 1} of ${filesToUpload.length} (${Math.round(webpBlob.size / 1024)}KB)…`;

      const filename = `${Date.now()}-${i}.webp`;
      const res = await adminFetch(
        `/api/admin/upload?filename=${encodeURIComponent(filename)}`,
        {
          method: "POST",
          headers: { "Content-Type": "image/webp" },
          body: webpBlob,
        },
      );
      const data = await res.json();
      if (!res.ok || !data.success)
        throw new Error(data.error || "Upload failed.");

      formImages.push(data.url);
      renderImageThumbs();
    } catch (err) {
      statusEl.textContent = `Upload failed: ${err.message}`;
      e.target.value = "";
      return;
    }
  }

  statusEl.textContent = `${filesToUpload.length} photo${filesToUpload.length > 1 ? "s" : ""} uploaded ✓`;
  e.target.value = "";
});

/**
 * compressImageToWebP(file, maxBytes)
 * Downscales/re-encodes a photo entirely in the browser (canvas) to a
 * WebP under maxBytes, so the server never has to receive or process
 * an oversized upload - keeping R2 usage and Worker CPU time inside the
 * free tier.
 */
function compressImageToWebP(file, maxBytes = 300 * 1024, type = "image/webp") {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("Could not read the file."));
    reader.onload = (e) => {
      const img = new Image();
      img.onerror = () => reject(new Error("Could not read the image."));
      img.onload = () => {
        let width = img.width;
        let height = img.height;
        const maxDimension = 1600;
        if (width > maxDimension || height > maxDimension) {
          const scale = maxDimension / Math.max(width, height);
          width = Math.round(width * scale);
          height = Math.round(height * scale);
        }

        const canvas = document.createElement("canvas");
        const ctx = canvas.getContext("2d");
        let quality = 0.85;
        let attempts = 0;

        const tryExport = () => {
          canvas.width = width;
          canvas.height = height;
          ctx.clearRect(0, 0, width, height);
          ctx.drawImage(img, 0, 0, width, height);

          canvas.toBlob(
            (blob) => {
              attempts += 1;
              if (!blob) return reject(new Error("Compression failed."));
              if (blob.size <= maxBytes || attempts >= 8) {
                resolve(blob);
                return;
              }
              if (quality > 0.35) {
                quality -= 0.12;
              } else {
                width = Math.round(width * 0.8);
                height = Math.round(height * 0.8);
                quality = 0.7;
              }
              tryExport();
            },
            type, // "image/jpeg" for email images - every email app can show JPEG
            quality,
          );
        };

        tryExport();
      };
      img.src = e.target.result;
    };
    reader.readAsDataURL(file);
  });
}

// ---------------------------------------------------------------------
// Extras (addons) & spice levels
// ---------------------------------------------------------------------
async function loadAddonsAndSpice() {
  const res = await adminFetch("/api/admin/addons");
  const data = await res.json();
  addons = data.addons || [];
  spiceLevels = data.spice_levels || [];
  sides = data.sides || [];
  renderAddonsList();
  renderSpiceLevelsList();
  renderSidesList();

  // Keep the menu item form's extras checkboxes in sync, preserving
  // whatever is currently checked (e.g. mid-edit) where possible.
  const currentlyChecked = [
    ...document.querySelectorAll("#itemAddonCheckboxes input:checked"),
  ].map((el) => parseInt(el.value, 10));
  renderAddonCheckboxesForForm(currentlyChecked);
  renderSideCheckboxesForForm(
    [...document.querySelectorAll("#itemSideCheckboxes input:checked")].map((el) => parseInt(el.value, 10)),
  );
}

function renderSidesList() {
  const list = document.getElementById("sidesList");
  if (!list) return;
  list.innerHTML = sides
    .map((sd) => `<span class="admin-chip">${sd.name} <button data-id="${sd.id}" data-type="side">&times;</button></span>`)
    .join("");
  attachChipDeleteHandlers(list);
}

function renderAddonsList() {
  const list = document.getElementById("addonsList");
  list.innerHTML = addons
    .map(
      (a) =>
        `<span class="admin-chip">${a.name} (+${money(a.price)}) <button data-id="${a.id}" data-type="addon">&times;</button></span>`,
    )
    .join("");
  attachChipDeleteHandlers(list);
}

function renderSpiceLevelsList() {
  const list = document.getElementById("spiceLevelsList");
  list.innerHTML = spiceLevels
    .map(
      (s) =>
        `<span class="admin-chip">${s.name} <button data-id="${s.id}" data-type="spice">&times;</button></span>`,
    )
    .join("");
  attachChipDeleteHandlers(list);
}

function attachChipDeleteHandlers(container) {
  container.querySelectorAll("button[data-id]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const type = btn.dataset.type;
      const query =
        type === "spice" || type === "side"
          ? `?type=${type}&id=${btn.dataset.id}`
          : `?id=${btn.dataset.id}`;
      await adminFetch(`/api/admin/addons${query}`, { method: "DELETE" });
      loadAddonsAndSpice();
    });
  });
}

document.getElementById("addonForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const nameInput = document.getElementById("addonName");
  const priceInput = document.getElementById("addonPrice");
  await adminFetch("/api/admin/addons", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name: nameInput.value.trim(),
      price: parseFloat(priceInput.value),
    }),
  });
  nameInput.value = "";
  priceInput.value = "";
  loadAddonsAndSpice();
});

document.getElementById("sideForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const nameInput = document.getElementById("sideName");
  await adminFetch("/api/admin/addons?type=side", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: nameInput.value.trim() }),
  });
  nameInput.value = "";
  loadAddonsAndSpice();
});

document.getElementById("spiceForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const nameInput = document.getElementById("spiceName");
  await adminFetch("/api/admin/addons?type=spice", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: nameInput.value.trim() }),
  });
  nameInput.value = "";
  loadAddonsAndSpice();
});

// ---------------------------------------------------------------------
// Reviews
// ---------------------------------------------------------------------
/** Summary cards + rating distribution above the review feed. */
function renderReviewSummary(reviews) {
  const wrap = document.getElementById("reviewSummary");
  if (!wrap) return;

  if (reviews.length === 0) {
    wrap.innerHTML = "";
    return;
  }

  const avg = reviews.reduce((s, r) => s + r.rating, 0) / reviews.length;
  const positive = Math.round(
    (reviews.filter((r) => r.rating >= 4).length / reviews.length) * 100,
  );
  const distribution = [5, 4, 3, 2, 1].map((stars) => ({
    stars,
    count: reviews.filter((r) => r.rating === stars).length,
  }));
  const maxCount = Math.max(...distribution.map((d) => d.count), 1);

  wrap.innerHTML = `
    <div class="kpi-card">
      <span class="kpi-label">Average Rating</span>
      <span class="rating-big">${avg.toFixed(1)}</span>
      <span class="rating-stars">${"★".repeat(Math.round(avg))}${"☆".repeat(5 - Math.round(avg))}</span>
    </div>
    <div class="kpi-card">
      <span class="kpi-label">Total Reviews</span>
      <span class="rating-big">${reviews.length}</span>
      <span class="admin-hint" style="margin:0">${positive}% rated 4★ or higher</span>
    </div>
    <div class="kpi-card" style="grid-column: span 2;">
      <span class="kpi-label">Rating Distribution</span>
      <div class="sa-rows" style="margin-top: 4px;">
        ${distribution
          .map(
            (d) => `
          <div class="sa-row" style="grid-template-columns: 40px 1fr auto;">
            <span class="sa-row-label">${d.stars}★</span>
            <div class="sa-row-track"><div class="sa-row-fill" style="width:${Math.round((d.count / maxCount) * 100)}%"></div></div>
            <span class="sa-row-num">${d.count}</span>
          </div>
        `,
          )
          .join("")}
      </div>
    </div>
  `;
}

async function loadAdminReviews() {
  // Admin endpoint: every review including pending ones (the public
  // /api/review only returns approved reviews, so pending never showed here).
  const res = await adminFetch("/api/admin/reviews");
  const data = await res.json().catch(() => ({}));
  const reviews = data.reviews || [];
  const list = document.getElementById("adminReviewsList");
  renderReviewSummary(reviews);

  if (reviews.length === 0) {
    list.innerHTML = `<p class="menu-empty">No reviews yet.</p>`;
    return;
  }

  list.innerHTML = reviews
    .map((r) => {
      const statusColors = { pending: "var(--sa-gold)", approved: "var(--sa-green-deep, #1a7f37)", rejected: "var(--sa-red)" };
      const statusBadge = r.status
        ? `<div class="admin-item-meta">Status: <strong style="color:${statusColors[r.status] || "inherit"}">${r.status === "pending" ? "Waiting for approval" : escapeHtml(r.status)}</strong></div>`
        : "";
      const buttons = [
        r.status !== "approved" ? `<button class="admin-mini-btn" data-action="approve" data-id="${r.id}">Approve</button>` : "",
        r.status === "pending" ? `<button class="admin-mini-btn danger" data-action="reject" data-id="${r.id}">Reject</button>` : "",
        `<button class="admin-mini-btn" data-edit-review="${r.id}"><i class="fas fa-pen"></i> Edit</button>`,
        `<button class="admin-mini-btn danger" data-action="delete" data-id="${r.id}">Delete</button>`,
      ].join(" ");

      return `
    <div class="admin-item-card" style="flex-direction: column; align-items: stretch;">
      <div class="admin-item-info">
        <strong>${escapeHtml(r.customer_name)} - ${"★".repeat(r.rating)}${"☆".repeat(5 - r.rating)}</strong>
        <div class="admin-item-meta">${escapeHtml(r.comment)}</div>
        ${r.items && r.items.length ? `<div class="admin-item-meta"><i class="fas fa-utensils"></i> Ordered: ${escapeHtml(r.items.join(", "))}${r.order_id ? ` (order #${r.order_id})` : ""}</div>` : ""}
        ${r.owner_reply ? `<div class="admin-item-meta"><strong>Your reply:</strong> ${escapeHtml(r.owner_reply)}</div>` : ""}
        ${statusBadge}
        <div class="admin-item-meta">${new Date(r.created_at).toLocaleString("en-ZA", { dateStyle: "medium", timeStyle: "short" })}</div>
      </div>
      <form class="review-edit-form" data-edit-form="${r.id}" style="display:none">
        <div class="form-row">
          <div class="form-group"><label>Name</label><input type="text" name="customer_name" maxlength="100" value="${escapeHtml(r.customer_name)}" required /></div>
          <div class="form-group"><label>Rating</label><select name="rating">${[5, 4, 3, 2, 1].map((n) => `<option value="${n}" ${n === r.rating ? "selected" : ""}>${"★".repeat(n)}</option>`).join("")}</select></div>
        </div>
        <div class="form-group"><label>Review</label><textarea name="comment" rows="3" maxlength="1000" required>${escapeHtml(r.comment)}</textarea></div>
        <button type="submit" class="btn btn-primary admin-mini-btn">Save changes</button>
        <button type="button" class="admin-mini-btn" data-cancel-edit="${r.id}">Cancel</button>
      </form>
      <form class="admin-form-inline" data-review-id="${r.id}" style="padding: 0; margin-top: 10px;">
        <input type="text" placeholder="Write a reply…" value="${escapeHtml(r.owner_reply || "")}" required />
        <button type="submit" class="btn btn-primary admin-mini-btn">Reply</button>
      </form>
      <div class="admin-item-actions" style="margin-top:8px;">${buttons}</div>
    </div>
  `;
    })
    .join("");

  list.querySelectorAll("form[data-review-id]").forEach((form) => {
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const input = form.querySelector("input");
      await adminFetch("/api/admin/review-reply", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          review_id: parseInt(form.dataset.reviewId, 10),
          reply: input.value.trim(),
        }),
      });
      loadAdminReviews();
    });
  });

  // Edit: show the inline form, save through review-moderate (action "edit")
  list.querySelectorAll("[data-edit-review]").forEach((btn) =>
    btn.addEventListener("click", () => {
      const form = list.querySelector(`[data-edit-form="${btn.dataset.editReview}"]`);
      if (form) form.style.display = form.style.display === "none" ? "" : "none";
    }),
  );
  list.querySelectorAll("[data-cancel-edit]").forEach((btn) =>
    btn.addEventListener("click", () => {
      list.querySelector(`[data-edit-form="${btn.dataset.cancelEdit}"]`).style.display = "none";
    }),
  );
  list.querySelectorAll("form[data-edit-form]").forEach((form) =>
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const res = await adminFetch("/api/admin/review-moderate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          review_id: Number(form.dataset.editForm),
          action: "edit",
          customer_name: form.customer_name.value.trim(),
          rating: Number(form.rating.value),
          comment: form.comment.value.trim(),
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.success) return alert(data.error || "Couldn't save the review.");
      loadAdminReviews();
    }),
  );

  // moderation action handlers
  list.querySelectorAll("[data-action]").forEach((btn) => {
    btn.addEventListener("click", async (e) => {
      const action = btn.dataset.action;
      const id = parseInt(btn.dataset.id, 10);
      if (!confirm(`Confirm ${action} review #${id}?`)) return;
      try {
        await adminFetch("/api/admin/review-moderate", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ review_id: id, action }),
        });
        loadAdminReviews();
      } catch (err) {
        alert(err.message || "Failed");
      }
    });
  });
}

// ---------------------------------------------------------------------
// Settings: admin password + staff accounts
// ---------------------------------------------------------------------
document
  .getElementById("adminPasswordForm")
  .addEventListener("submit", async (e) => {
    e.preventDefault();
    const statusEl = document.getElementById("adminPasswordStatus");
    const currentPassword = document.getElementById(
      "currentAdminPassword",
    ).value;
    const newPassword = document.getElementById("newAdminPassword").value;

    try {
      const res = await adminFetch("/api/admin/password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          current_password: currentPassword,
          new_password: newPassword,
        }),
      });
      const data = await res.json();
      if (!res.ok || !data.success)
        throw new Error(data.error || "Couldn't update the password.");
      statusEl.textContent = "Admin password updated.";
      document.getElementById("adminPasswordForm").reset();
    } catch (err) {
      statusEl.textContent = err.message;
    }
  });

async function loadStaffAccounts() {
  try {
    const res = await adminFetch("/api/admin/staff");
    const data = await res.json();
    staffAccounts = data.staff || [];
    renderStaffAccountsList();
  } catch {
    staffAccounts = [];
    renderStaffAccountsList();
  }
}

function renderStaffAccountsList() {
  const list = document.getElementById("staffAccountsList");
  if (staffAccounts.length === 0) {
    list.innerHTML = `<p class="menu-empty">No staff accounts yet.</p>`;
    return;
  }

  list.innerHTML = staffAccounts
    .map(
      (account) => `
      <div class="admin-item-card">
        <div class="admin-item-info">
          <strong>${account.name}</strong>
          <div class="admin-item-meta">${account.email} · ${account.is_active ? "Active" : "Inactive"}</div>
        </div>
        <div class="admin-item-actions">
          <button class="admin-mini-btn" data-staff-action="edit" data-id="${account.id}">Edit</button>
          <button class="admin-mini-btn danger" data-staff-action="delete" data-id="${account.id}">Delete</button>
        </div>
      </div>
    `,
    )
    .join("");

  list.querySelectorAll("[data-staff-action]").forEach((btn) => {
    btn.addEventListener("click", () =>
      handleStaffAccountAction(
        btn.dataset.staffAction,
        parseInt(btn.dataset.id, 10),
      ),
    );
  });
}

function resetStaffAccountForm() {
  document.getElementById("staffAccountForm").reset();
  document.getElementById("staffAccountId").value = "";
  document.getElementById("staffAccountPassword").required = false;
  document.getElementById("cancelStaffEditBtn").style.display = "none";
  document.getElementById("staffAccountStatus").textContent = "";
}

document
  .getElementById("cancelStaffEditBtn")
  .addEventListener("click", resetStaffAccountForm);

document
  .getElementById("marketingEmailForm")
  ?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const status = document.getElementById("marketingEmailStatus");
    const button = form.querySelector("button[type=submit]");
    const picked = getMarketingPicker().files();
    const formData = new FormData();
    formData.append(
      "subject",
      document.getElementById("marketingSubject").value.trim(),
    );
    formData.append(
      "body",
      document.getElementById("marketingBody").value.trim(),
    );
    button.disabled = true;
    try {
      // Images are optional: each one is shrunk here, uploaded once, and shown inside the email.
      const imageUrls = [];
      for (let i = 0; i < picked.length; i++) {
        status.textContent = `Preparing image ${i + 1} of ${picked.length}…`;
        const blob = await compressImageToWebP(picked[i], 300 * 1024, "image/jpeg");
        const up = await adminFetch("/api/admin/marketing/upload?filename=email.jpeg", {
          method: "POST",
          headers: { "Content-Type": "image/jpeg" },
          body: blob,
        });
        const upData = await up.json().catch(() => ({}));
        if (!up.ok || !upData.url) throw new Error(upData.error || `Couldn't upload image ${i + 1}.`);
        imageUrls.push(upData.url);
      }
      formData.append("image_urls", JSON.stringify(imageUrls));
      status.textContent = "Sending…";
      const response = await adminFetch("/api/admin/marketing/send", {
        method: "POST",
        body: formData,
      });
      const data = await response.json();
      if (!response.ok || !data.success)
        throw new Error(
          data.error ||
            `Sent ${data.sent || 0} email(s); ${data.failed || 0} failed.`,
        );
      status.textContent = `Sent to ${data.sent} subscriber${data.sent === 1 ? "" : "s"}${data.images ? ` with ${data.images} image${data.images === 1 ? "" : "s"}` : ""}.`;
      form.reset();
      getMarketingPicker().reset();
    } catch (error) {
      status.textContent = error.message;
    } finally {
      button.disabled = false;
    }
  });

let marketingPicker = null;
function getMarketingPicker() {
  if (!marketingPicker) marketingPicker = createImagePicker({ inputId: "marketingImages", previewId: "marketingImagePreview", max: 5 });
  return marketingPicker;
}
getMarketingPicker();

document
  .getElementById("staffAccountForm")
  .addEventListener("submit", async (e) => {
    e.preventDefault();
    const statusEl = document.getElementById("staffAccountStatus");
    const id = document.getElementById("staffAccountId").value;
    const payload = {
      name: document.getElementById("staffAccountName").value.trim(),
      email: document.getElementById("staffAccountEmail").value.trim(),
      password: document.getElementById("staffAccountPassword").value,
      permissions: { orders: true },
    };

    if (!payload.name || !payload.email) {
      statusEl.textContent = "Name and email are required.";
      return;
    }

    if (!id && !payload.password) {
      statusEl.textContent = "Create a staff account with a password.";
      return;
    }

    try {
      const res = await adminFetch("/api/admin/staff", {
        method: id ? "PUT" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(
          id ? { ...payload, id: parseInt(id, 10) } : payload,
        ),
      });
      const data = await res.json();
      if (!res.ok || !data.success)
        throw new Error(data.error || "Couldn't save the staff account.");
      statusEl.textContent = id
        ? "Staff account updated."
        : "Staff account created.";
      resetStaffAccountForm();
      loadStaffAccounts();
    } catch (err) {
      statusEl.textContent = err.message;
    }
  });

async function handleStaffAccountAction(action, id) {
  if (action === "delete") {
    const account = staffAccounts.find((item) => item.id === id);
    if (!account) return;
    if (!confirm(`Delete staff account "${account.name}"?`)) return;
    try {
      const res = await adminFetch(`/api/admin/staff?id=${id}`, {
        method: "DELETE",
      });
      const data = await res.json();
      if (!res.ok || !data.success)
        throw new Error(data.error || "Couldn't delete that account.");
      loadStaffAccounts();
    } catch (err) {
      alert(err.message);
    }
    return;
  }

  const account = staffAccounts.find((item) => item.id === id);
  if (!account) return;
  document.getElementById("staffAccountId").value = account.id;
  document.getElementById("staffAccountName").value = account.name;
  document.getElementById("staffAccountEmail").value = account.email;
  document.getElementById("staffAccountPassword").value = "";
  document.getElementById("staffAccountPassword").required = false;
  document.getElementById("cancelStaffEditBtn").style.display = "inline-block";
  document.getElementById("staffAccountStatus").textContent =
    "Editing existing staff account.";
  document.querySelector('.admin-tab-btn[data-tab="settings"]').click();
}

/** Confirmation text for a table booking (opened in WhatsApp for the admin to send). */
function reservationWhatsAppText(r) {
  const d = new Date(`${String(r.reservation_date).slice(0, 10)}T00:00:00`);
  const dateLabel = d.toLocaleDateString("en-ZA", { weekday: "long", day: "numeric", month: "long" });
  const time = r.reservation_time ? String(r.reservation_time).slice(0, 5) : "";
  const cancelled = r.status === "Cancelled";
  if (cancelled) {
    const prepaid = ["paid", "refunded"].includes(r.preorder_payment_status);
    return `Hi ${r.customer_name}, your table booking at Fulude's Cafe for ${dateLabel} at ${time} has been cancelled${prepaid ? " and will be refunded" : ""}. Please contact us if you need any further assistance.`;
  }
  return `Hi ${r.customer_name}, your table at Fulude's Cafe is ${r.status === "Confirmed" ? "confirmed" : "reserved"} for ${dateLabel} at ${time} for ${r.party_size} guest${r.party_size > 1 ? "s" : ""}${r.table_number ? ` (table ${r.table_number})` : ""}. We look forward to seeing you! Reply here if you need to change anything.`;
}
window.reservationWhatsAppText = reservationWhatsAppText;

async function loadReservations() {
  try {
    const res = await adminFetch("/api/admin/reservations");
    const data = await res.json();
    reservations = data.reservations || [];
    renderReservations();
  } catch {
    reservations = [];
    renderReservations();
  }
}

/** Booking overview cards: today's covers, upcoming bookings, pending confirmations. */
function renderReservationSummary() {
  const wrap = document.getElementById("resSummary");
  if (!wrap) return;

  // "Today" is the cafe's day (South Africa time): these cards count
  // today's bookings only and start from zero again at 12:00 am.
  const todayKey = kdsDayKey();
  // Completed (fulfilled) bookings still count towards today's stats even
  // after the admin has cleared them from the list.
  const today = reservations.filter(
    (r) => r.reservation_date === todayKey && r.status !== "Cancelled",
  );
  const upcoming = reservations.filter(
    (r) => r.reservation_date > todayKey && r.status !== "Cancelled" && r.status !== "Completed",
  );
  const pending = reservations.filter((r) => r.status === "Pending");
  const guestsToday = today.reduce((s, r) => s + (Number(r.party_size) || 0), 0);

  wrap.innerHTML = `
    <div class="kpi-card"><span class="kpi-label">Today's Reservations</span><span class="kpi-value">${today.length}</span></div>
    <div class="kpi-card"><span class="kpi-label">Guests Today</span><span class="kpi-value">${guestsToday}</span></div>
    <div class="kpi-card"><span class="kpi-label">Upcoming</span><span class="kpi-value">${upcoming.length}</span></div>
    <div class="kpi-card"><span class="kpi-label">Awaiting Confirmation</span><span class="kpi-value">${pending.length}</span></div>
    <p class="kds-reset-note" style="grid-column:1 / -1;margin:0">${kdsResetLabel().replace("Today's stats", "Today's Reservations and Guests Today")}</p>
  `;
}
// Page left open overnight: roll the "today" cards and kitchen strip over at midnight.
kdsOnMidnight(() => {
  if (!adminToken) return;
  renderReservationSummary();
  loadOrders();
});

function renderReservations() {
  const list = document.getElementById("reservationsList");
  renderReservationSummary();

  const visible = reservations.filter((r) => !r.admin_cleared);
  const finishedCount = visible.filter((r) => r.status === "Completed" || r.status === "Cancelled").length;
  if (visible.length === 0) {
    list.innerHTML = `<p class="menu-empty">No reservations to show.</p>`;
    return;
  }

  const clearBar = finishedCount
    ? `<div style="margin-bottom:10px"><button type="button" class="btn admin-mini-btn" id="clearFinishedReservationsBtn"><i class="fas fa-eraser"></i> Clear completed &amp; cancelled (${finishedCount})</button> <span class="admin-hint" style="margin:0">Completed bookings stay in today's stats.</span></div>`
    : "";

  list.innerHTML = clearBar + visible
    .map((reservation) => {
      const dateLabel = new Date(
        `${String(reservation.reservation_date).slice(0, 10)}T00:00:00`,
      ).toLocaleDateString("en-ZA", {
        weekday: "short",
        day: "2-digit",
        month: "short",
      });
      const timeLabel = reservation.reservation_time
        ? reservation.reservation_time.slice(0, 5)
        : "";
      // Paid pre-order: confirmed by the payment, so only Confirmed / Cancelled / Completed.
      const prepaid = ["paid", "refunded"].includes(reservation.preorder_payment_status);
      const statusOptions = prepaid ? ["Confirmed", "Cancelled", "Completed"] : ["Pending", "Confirmed", "Cancelled", "Completed"];
      return `
        <div class="admin-item-card" style="flex-direction: column; align-items: stretch;">
          <div class="admin-item-info">
            <strong>${reservation.customer_name} · ${reservation.party_size} guest${reservation.party_size > 1 ? "s" : ""}</strong>
            <div class="admin-item-meta">${dateLabel} at ${timeLabel} · ${reservation.customer_phone} · ${reservation.customer_email}</div>
            ${reservation.table_number ? `<div class="admin-item-meta">Table: ${reservation.table_number}</div>` : ""}
            ${reservation.notes ? `<div class="admin-item-meta">Notes: ${reservation.notes}</div>` : ""}
            ${
              prepaid
                ? `<div class="admin-item-meta"><span class="badge badge-paid">${reservation.preorder_payment_status === "refunded" ? "Pre-order refunded" : "Pre-order paid"}</span> Order #${reservation.advance_order_id} · ${money(reservation.preorder_total)}</div>`
                : reservation.advance_order_requested
                  ? `<div class="admin-item-meta">Advance order requested: ${reservation.advance_order_details || "Details provided"}</div>`
                  : ""
            }
            <div class="admin-item-meta">Status: ${reservation.status}</div>
          </div>
          <div class="admin-form-inline" style="padding: 0; margin-top: 10px;">
            <select data-reservation-status="${reservation.id}" data-prepaid="${prepaid && reservation.preorder_payment_status === "paid" ? "1" : ""}" data-total="${reservation.preorder_total || 0}">
              ${statusOptions.map((s) => `<option value="${s}" ${reservation.status === s ? "selected" : ""}>${s}</option>`).join("")}
            </select>
            <button type="button" class="btn btn-primary admin-mini-btn" data-reservation-update="${reservation.id}">Save</button>
            ${reservation.status === "Completed" || reservation.status === "Cancelled" ? `<button type="button" class="btn admin-mini-btn" data-reservation-clear="${reservation.id}" title="Remove from this list"><i class="fas fa-eraser"></i> Clear</button>` : ""}
            <a class="btn admin-mini-btn wa-btn" target="_blank" rel="noopener" title="Send the customer a WhatsApp confirmation"
               href="${window.waLink ? window.waLink(reservation.customer_phone, reservationWhatsAppText(reservation)) : "#"}"><i class="fab fa-whatsapp"></i> WhatsApp</a>
          </div>
        </div>
      `;
    })
    .join("");

  const doClear = async (payload) => {
    try {
      await adminFetch("/api/admin/reservations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      loadReservations();
    } catch {
      alert("Couldn't clear.");
    }
  };
  list.querySelectorAll("[data-reservation-clear]").forEach((btn) =>
    btn.addEventListener("click", () => doClear({ action: "clear", reservation_id: parseInt(btn.dataset.reservationClear, 10) })),
  );
  document.getElementById("clearFinishedReservationsBtn")?.addEventListener("click", () => {
    if (confirm("Clear all completed & cancelled bookings from this list? Completed ones still count in today's stats.")) doClear({ action: "clear_finished" });
  });

  list.querySelectorAll("[data-reservation-update]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const id = parseInt(btn.dataset.reservationUpdate, 10);
      const select = list.querySelector(`[data-reservation-status="${id}"]`);
      if (!select) return;
      const current = reservations.find((r) => r.id === id);
      if (select.value === "Cancelled" && select.dataset.prepaid && current?.status !== "Cancelled") {
        if (!confirm(`Cancel this booking?\n\nIts pre-order (${money(select.dataset.total)}) will be cancelled and refunded to the customer's card through Yoco.`)) return;
      }
      try {
        const res = await adminFetch("/api/admin/reservations", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ reservation_id: id, status: select.value }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok || !data.success) throw new Error(data.error || "Couldn't update the reservation.");
        if (data.refund?.outcome === "refunded") alert("Booking cancelled and the pre-order refunded through Yoco.");
        else if (data.refund?.outcome === "refund_needed")
          alert(`Booking cancelled, but the automatic refund didn't go through (${data.refund.error || "unknown reason"}). Refund it from Order History with "Refund via Yoco".`);
        loadReservations();
      } catch (err) {
        alert(err.message || "Couldn't update the reservation.");
      }
    });
  });
}

async function loadBuffetSetting() {
  const res = await fetch("/api/config", { cache: "no-store" });
  const data = await res.json();
  document.getElementById("buffetToggle").checked = !!data.is_buffet_visible;
  applyStoreStatus(data);
}

// ---------------- Store status: Out of Service + hero announcement ----------------
function applyStoreStatus(data) {
  const on = !!data.is_out_of_service;
  const reason = data.out_of_service_reason || "";
  const toggle = document.getElementById("oosToggle");
  if (toggle) toggle.checked = on;
  const banner = document.getElementById("oosBanner");
  if (banner) banner.style.display = on ? "flex" : "none";
  const row = document.getElementById("oosReasonRow");
  if (row) row.style.display = on ? "block" : "none";
  const text = document.getElementById("oosReasonText");
  if (text) text.textContent = reason;
  const ann = document.getElementById("announcementInput");
  if (ann && document.activeElement !== ann) ann.value = data.announcement_message || "";
}

async function saveConfig(patch) {
  const res = await adminFetch("/api/admin/config", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(patch),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.success) throw new Error(data.error || "Couldn't save that setting.");
  applyStoreStatus(data);
  return data;
}

let oosModalMode = "enable"; // "enable" | "edit"
function openOosModal(mode, currentReason = "") {
  oosModalMode = mode;
  document.querySelector("#oosModal h3").textContent =
    mode === "edit" ? "Edit Out of Service reason" : "Turn on Out of Service";
  document.getElementById("oosConfirmBtn").textContent = mode === "edit" ? "Save" : "Turn on";
  document.getElementById("oosReasonInput").value = currentReason;
  document.getElementById("oosModalError").style.display = "none";
  document.getElementById("oosModal").classList.add("active");
  document.getElementById("oosReasonInput").focus();
}
function closeOosModal() {
  document.getElementById("oosModal").classList.remove("active");
  // Toggle reflects the saved state, not the cancelled click.
  const banner = document.getElementById("oosBanner");
  document.getElementById("oosToggle").checked = banner && banner.style.display !== "none";
}

function initStoreStatusHandlers() {
  const toggle = document.getElementById("oosToggle");
  if (!toggle) return;

  toggle.addEventListener("change", async (e) => {
    if (e.target.checked) {
      openOosModal("enable");
      return;
    }
    try {
      await saveConfig({ is_out_of_service: false });
    } catch (err) {
      alert(err.message);
      toggle.checked = true;
    }
  });

  document.getElementById("oosEditReasonBtn").addEventListener("click", () =>
    openOosModal("edit", document.getElementById("oosReasonText").textContent),
  );
  document.getElementById("oosBannerManage").addEventListener("click", () => {
    document.querySelector('[data-tab="settings"]')?.click();
    document.querySelector('[data-settings-tab="general"]')?.click();
  });
  document.getElementById("oosCancelBtn").addEventListener("click", closeOosModal);

  document.getElementById("oosConfirmBtn").addEventListener("click", async () => {
    const reason = document.getElementById("oosReasonInput").value.trim();
    const err = document.getElementById("oosModalError");
    if (!reason) {
      err.textContent = "Please enter a reason - your customers will see it.";
      err.style.display = "block";
      return;
    }
    try {
      await saveConfig({ is_out_of_service: true, out_of_service_reason: reason });
      document.getElementById("oosModal").classList.remove("active");
    } catch (e) {
      err.textContent = e.message;
      err.style.display = "block";
    }
  });

  const status = document.getElementById("announcementStatus");
  const saveAnnouncement = async (value) => {
    try {
      await saveConfig({ announcement_message: value });
      document.getElementById("announcementInput").value = value;
      status.textContent = value ? "Saved - it's now showing on the home page." : "Removed - nothing is showing on the home page.";
    } catch (e) {
      status.textContent = e.message;
    }
  };
  document.getElementById("announcementSaveBtn").addEventListener("click", () =>
    saveAnnouncement(document.getElementById("announcementInput").value.trim()),
  );
  document.getElementById("announcementClearBtn").addEventListener("click", () => saveAnnouncement(""));
}

// ----------------- Buffet admin UI handlers -----------------
/** Empties the event form back to "Add Buffet Event". */
function resetBuffetEventForm() {
  const form = document.getElementById("buffetEventForm");
  if (!form) return;
  form.reset();
  form.dataset.existingPhotos = "[]";
  getBuffetPhotoPicker().reset();
  document.getElementById("buffetEventId").value = "";
  document.getElementById("buffetFormTitle").textContent = "Add Buffet Event";
}

/** The Buffet page (its own sidebar tab): event form, events list and bookings. */
function initBuffetAdminHandlers() {
  const form = document.getElementById("buffetEventForm");
  if (form) getBuffetPhotoPicker(); // start collecting picked photos
  document.getElementById("buffetEventNewBtn")?.addEventListener("click", resetBuffetEventForm);
  if (form) {
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const id = Number(document.getElementById("buffetEventId").value) || null;
      const title = document.getElementById("buffetEventTitle").value.trim();
      const event_date = document.getElementById("buffetEventDate").value;
      const capacity =
        Number(document.getElementById("buffetEventCapacity").value) || 30;
      const price_cents = Math.round(
        (Number(document.getElementById("buffetEventPrice").value) || 0) * 100,
      );
      const description = document
        .getElementById("buffetEventDescription")
        .value.trim();
      const is_published = !!document.getElementById("buffetEventPublished")
        .checked;
      const booking_closes_at_raw =
        document.getElementById("buffetEventBookingCloses").value || null;
      const booking_closes_at = booking_closes_at_raw
        ? new Date(booking_closes_at_raw).toISOString()
        : null;
      // Dates matter - ask for anything that's missing instead of failing quietly.
      const missing = [];
      if (!title) missing.push("Title");
      if (!event_date) missing.push("Date & time of the buffet");
      if (!booking_closes_at) missing.push("Date & time booking closes");
      if (missing.length) {
        alert(`Please fill in: ${missing.join(", ")}.`);
        return;
      }
      if (new Date(event_date) < new Date() && !id) {
        alert("The buffet date is in the past. Please pick a future date & time.");
        return;
      }
      if (new Date(booking_closes_at) > new Date(event_date)) {
        alert("Booking must close before (or at) the buffet start time. Please fix the 'Booking closes at' date.");
        return;
      }
      const saveBtn = form.querySelector('button[type="submit"]');
      const saveLabel = saveBtn ? saveBtn.textContent : "";
      try {
        if (saveBtn) { saveBtn.disabled = true; saveBtn.textContent = "Saving…"; }
        const existingPhotos = JSON.parse(form.dataset.existingPhotos || "[]");
        const photos = [...existingPhotos];
        for (const file of getBuffetPhotoPicker().files().slice(0, 6 - photos.length)) {
          // Phone photos are several MB - shrink to WebP (<300KB) first,
          // otherwise the server rejects them and the picture never shows.
          const webpBlob = await compressImageToWebP(file, 300 * 1024);
          const upload = await adminFetch(
            `/api/admin/upload?filename=${encodeURIComponent(`${Date.now()}.webp`)}`,
            {
              method: "POST",
              headers: { "Content-Type": "image/webp" },
              body: webpBlob,
            },
          );
          const uploadData = await upload.json();
          if (!upload.ok || !uploadData.success)
            throw new Error(
              uploadData.error || "Failed to upload buffet image.",
            );
          photos.push(uploadData.url);
        }
        const url = "/api/admin/buffet-events";
        const method = id ? "PUT" : "POST";
        const res = await adminFetch(url, {
          method,
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            id,
            title,
            event_date,
            capacity,
            price_cents,
            description,
            photos,
            is_published,
            booking_closes_at,
          }),
        });
        const data = await res.json();
        if (!res.ok || !data.success) throw new Error(data.error || "Failed");
        resetBuffetEventForm();
        await loadBuffetEventsAdmin();
      } catch (err) {
        alert(err.message || "Failed to save event");
      } finally {
        if (saveBtn) { saveBtn.disabled = false; saveBtn.textContent = saveLabel; }
      }
    });
  }
}

let buffetEventsById = {};

/** Photo thumbnails in the buffet form, each with a remove (x) button. */
/**
 * Photo picker that lets admins add pictures in several goes: every pick is
 * ADDED to the list (never replaces it), all of them - already-saved and
 * new - show as thumbnails with a remove (x), and nothing is uploaded until
 * Save / Send. Used by the buffet event form and the marketing email.
 */
function createImagePicker({ inputId, previewId, max, existing = () => [], setExisting = () => {} }) {
  const input = document.getElementById(inputId);
  const preview = document.getElementById(previewId);
  let pending = []; // [{ file, url }]
  const thumb = (src, attr, isNew) =>
    `<span class="picker-thumb"><img src="${escapeHtml(src)}" alt="" />${isNew ? '<span class="picker-new">new</span>' : ""}<button type="button" ${attr} aria-label="Remove photo">&times;</button></span>`;
  const render = () => {
    if (!preview) return;
    const saved = existing();
    const total = saved.length + pending.length;
    preview.innerHTML =
      saved.map((src, i) => thumb(src, `data-remove-saved="${i}"`, false)).join("") +
      pending.map((p, i) => thumb(p.url, `data-remove-new="${i}"`, true)).join("") +
      (total ? `<span class="picker-count">${total} of ${max}</span>` : "");
  };
  input?.addEventListener("change", () => {
    const room = max - existing().length - pending.length;
    const picked = [...input.files];
    picked.slice(0, Math.max(0, room)).forEach((file) => pending.push({ file, url: URL.createObjectURL(file) }));
    if (picked.length > room) alert(`Up to ${max} photos - ${picked.length - Math.max(0, room)} weren't added.`);
    input.value = ""; // the next pick adds to the list instead of replacing it
    render();
  });
  preview?.addEventListener("click", (e) => {
    const savedBtn = e.target.closest("[data-remove-saved]");
    const newBtn = e.target.closest("[data-remove-new]");
    if (savedBtn) {
      const list = existing();
      list.splice(Number(savedBtn.dataset.removeSaved), 1);
      setExisting(list);
    } else if (newBtn) {
      const [gone] = pending.splice(Number(newBtn.dataset.removeNew), 1);
      if (gone) URL.revokeObjectURL(gone.url);
    } else return;
    render();
  });
  return {
    files: () => pending.map((p) => p.file),
    reset() {
      pending.forEach((p) => URL.revokeObjectURL(p.url));
      pending = [];
      render();
    },
    render,
  };
}

let buffetPhotoPicker = null;
function getBuffetPhotoPicker() {
  if (!buffetPhotoPicker) {
    const form = document.getElementById("buffetEventForm");
    buffetPhotoPicker = createImagePicker({
      inputId: "buffetEventPhotos",
      previewId: "buffetEventPhotoPreview",
      max: 6,
      existing: () => JSON.parse(form.dataset.existingPhotos || "[]"),
      setExisting: (list) => (form.dataset.existingPhotos = JSON.stringify(list)),
    });
  }
  return buffetPhotoPicker;
}

function renderBuffetPhotoPreview() {
  getBuffetPhotoPicker().render();
}

function buffetWhatsAppText(bk) {
  const evt = buffetEventsById[bk.event_id] || {};
  const when = evt.event_date
    ? new Date(evt.event_date).toLocaleString("en-ZA", { weekday: "long", day: "numeric", month: "long", hour: "2-digit", minute: "2-digit" })
    : "";
  if (bk.status === "cancelled") {
    return `Hi ${bk.name}, your buffet booking${evt.title ? ` for "${evt.title}"` : ""} at Fulude's Cafe has been cancelled. Please contact us if you'd like to rebook.`;
  }
  if (bk.status === "pending") {
    return `Hi ${bk.name}, we've received your buffet booking${evt.title ? ` for "${evt.title}"` : ""} at Fulude's Cafe for ${bk.seats} seat${bk.seats > 1 ? "s" : ""}. We'll confirm it shortly.`;
  }
  return `Hi ${bk.name}, your buffet booking at Fulude's Cafe is confirmed${evt.title ? `: "${evt.title}"` : ""}${when ? ` on ${when}` : ""} for ${bk.seats} seat${bk.seats > 1 ? "s" : ""}. We look forward to seeing you! Reply here if you need to change anything.`;
}

let buffetBookingsTab = "pending"; // which status tab is open in the bookings list

/** Receipt block for one booking: what was booked and what it costs, whatever the status. */
function buffetReceiptHtml(bk) {
  const evt = buffetEventsById[bk.event_id] || {};
  const perSeat = Number(evt.price_cents || 0) / 100;
  const seats = Number(bk.seats) || 0;
  const row = (label, value) => `<div style="display:flex;justify-content:space-between;gap:12px"><span class="admin-hint">${label}</span><span>${value}</span></div>`;
  return `<div class="buffet-admin-receipt" style="border:1px dashed var(--sa-border-strong);border-radius:8px;padding:8px 10px;margin-top:8px;font-size:0.85rem">
    ${row("Booking", `#${bk.id}`)}
    ${row("Event", escapeHtml(evt.title || "Buffet"))}
    ${evt.event_date ? row("Date", new Date(evt.event_date).toLocaleString("en-ZA", { dateStyle: "medium", timeStyle: "short" })) : ""}
    ${row("Seats", seats)}
    ${row("Price per seat", money(perSeat))}
    ${row("Booked on", new Date(bk.created_at).toLocaleString("en-ZA", { dateStyle: "medium", timeStyle: "short" }))}
    ${row("Status", escapeHtml(bk.status))}
    <div style="display:flex;justify-content:space-between;border-top:1px solid var(--sa-border);margin-top:4px;padding-top:4px;font-weight:700"><span>Total</span><span>${money(perSeat * seats)}</span></div>
  </div>`;
}

/** Bookings for one buffet event + a form so admin can book seats for customers who phone in. */
async function showBuffetBookings(eventId) {
  const container = document.getElementById("buffetBookingsList");
  try {
    const res = await adminFetch(`/api/admin/buffet-bookings?event_id=${eventId}`);
    const data = await res.json();
    const evt = buffetEventsById[eventId] || {};
    const active = (data.bookings || []).filter((bk) => bk.status === "confirmed" || bk.status === "pending").reduce((n, bk) => n + Number(bk.seats), 0);
    container.innerHTML = `
      <h4 style="margin:0 0 8px">${evt.title || "Buffet"} - ${active}/${evt.capacity || "?"} seats booked</h4>
      <form id="buffetAdminBookForm" class="res-new-form">
        <div class="form-group"><label>Customer name</label><input type="text" id="bbName" required></div>
        <div class="form-group"><label>Phone / WhatsApp</label><input type="tel" id="bbPhone" required></div>
        <div class="form-group"><label>Email (optional)</label><input type="email" id="bbEmail"></div>
        <div class="form-group"><label>Seats</label><input type="number" id="bbSeats" min="1" value="1" required></div>
        <div class="res-full"><button type="submit" class="btn btn-primary">Book seats for customer</button>
          <span id="bbMsg" class="admin-hint" style="margin-left:10px"></span></div>
      </form>
      <div class="res-tabs" id="bbTabs" style="display:flex;gap:6px;flex-wrap:wrap;margin:12px 0"></div>
      <div id="bbRows"></div>`;
    const rows = container.querySelector("#bbRows");
    const all = data.bookings || [];
    const tabs = [["pending", "Pending"], ["confirmed", "Confirmed"], ["cancelled", "Cancelled"], ["all", "All"]];
    const tabsEl = container.querySelector("#bbTabs");
    tabsEl.innerHTML = tabs
      .map(([key, label]) => {
        const n = key === "all" ? all.length : all.filter((bk) => bk.status === key).length;
        return `<button type="button" class="admin-mini-btn${key === buffetBookingsTab ? " active" : ""}" data-bb-tab="${key}" style="${key === buffetBookingsTab ? "background:var(--sa-gold);color:#fff;border-color:var(--sa-gold)" : ""}">${label} (${n})</button>`;
      })
      .join("");
    tabsEl.querySelectorAll("[data-bb-tab]").forEach((b) =>
      b.addEventListener("click", () => {
        buffetBookingsTab = b.dataset.bbTab;
        showBuffetBookings(eventId);
      }),
    );
    const visible = buffetBookingsTab === "all" ? all : all.filter((bk) => bk.status === buffetBookingsTab);
    if (!visible.length) rows.innerHTML = `<p class="admin-hint">No ${buffetBookingsTab === "all" ? "" : buffetBookingsTab + " "}bookings.</p>`;
    visible.forEach((bk) => {
      const row = document.createElement("div");
      row.className = "sa-list-item";
      // The message matches the booking's status, ready to send as-is.
      const text = buffetWhatsAppText(bk);
      const wa = window.waLink ? window.waLink(bk.phone, text) : "#";
      row.innerHTML = `<div class="sa-list-main"><div class="sa-list-title">${escapeHtml(bk.name)} (${bk.seats} seat${bk.seats > 1 ? "s" : ""}) - ${escapeHtml(bk.status)}</div><div class="sa-list-sub">${escapeHtml(bk.email || "no email")} • ${escapeHtml(bk.phone || "")}</div>
        ${buffetReceiptHtml(bk)}
        ${bk.phone ? `<div style="margin-top:8px"><div class="admin-hint" style="margin-bottom:4px"><i class="fab fa-whatsapp"></i> Message ready to send:</div><div style="background:var(--sa-green-soft, #ecfdf3);border-radius:8px;padding:8px 10px;font-size:0.85rem;white-space:pre-wrap">${escapeHtml(text)}</div></div>` : ""}</div>
        <div style="margin-top:8px">${bk.status === "pending" ? `<button class="admin-mini-btn btn-confirm" data-id="${bk.id}">Confirm</button> ` : ""}${bk.status === "pending" || bk.status === "confirmed" ? `<button class="admin-mini-btn danger btn-cancel" data-id="${bk.id}">Cancel</button>` : ""} ${bk.phone ? `<a class="admin-mini-btn wa-btn" target="_blank" rel="noopener" href="${wa}"><i class="fab fa-whatsapp"></i> Send on WhatsApp</a>` : ""}</div>`;
      rows.appendChild(row);
    });
    const act = (cls, action) =>
      rows.querySelectorAll(cls).forEach((btn) =>
        btn.addEventListener("click", async (ev) => {
          await adminFetch("/api/admin/buffet-bookings", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ booking_id: Number(ev.currentTarget.dataset.id), action }),
          });
          await loadBuffetEventsAdmin();
          showBuffetBookings(eventId);
        }),
      );
    act(".btn-confirm", "confirm");
    act(".btn-cancel", "cancel");

    container.querySelector("#buffetAdminBookForm").addEventListener("submit", async (ev) => {
      ev.preventDefault();
      const msg = container.querySelector("#bbMsg");
      const body = {
        action: "create",
        event_id: eventId,
        name: container.querySelector("#bbName").value.trim(),
        phone: container.querySelector("#bbPhone").value.trim(),
        email: container.querySelector("#bbEmail").value.trim(),
        seats: Number(container.querySelector("#bbSeats").value),
      };
      const r = await adminFetch("/api/admin/buffet-bookings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const out = await r.json().catch(() => ({}));
      if (!r.ok || !out.success) {
        msg.textContent = out.error || "Couldn't book the seats.";
        msg.style.color = "var(--sa-red)";
        return;
      }
      await loadBuffetEventsAdmin();
      await showBuffetBookings(eventId);
      // Offer the WhatsApp confirmation right away
      const created = { id: out.booking_id, event_id: eventId, name: body.name, phone: body.phone, seats: body.seats, status: "confirmed" };
      const m = document.getElementById("buffetBookingsList").querySelector("#bbMsg");
      if (m) {
        m.style.color = "var(--sa-green-deep)";
        m.innerHTML = `Booked. <a class="admin-mini-btn wa-btn" target="_blank" rel="noopener" href="${window.waLink(body.phone, buffetWhatsAppText(created))}"><i class="fab fa-whatsapp"></i> Send WhatsApp confirmation</a>`;
      }
    });
  } catch (err) {
    alert("Failed to load bookings");
  }
}

async function loadBuffetEventsAdmin() {
  try {
    const res = await adminFetch("/api/admin/buffet-events");
    const data = await res.json();
    const list = document.getElementById("buffetEventsList");
    const form = document.getElementById("buffetEventForm");
    if (!list) return;
    list.innerHTML = "";
    (data.events || []).forEach((evt) => {
      const el = document.createElement("div");
      el.className = "sa-list-item";
      el.innerHTML = `<div class="sa-list-main"><div class="sa-list-title">${evt.title}</div><div class="sa-list-sub">${new Date(evt.event_date).toLocaleString()} • Capacity ${evt.capacity} • Price R${(Number(evt.price_cents) / 100).toFixed(2)} ${evt.is_published ? "• Published" : ""}</div></div>
        <div style="margin-top:8px"><button class="admin-mini-btn btn-view" data-id="${evt.id}">View Bookings</button> <button class="admin-mini-btn btn-edit" data-id="${evt.id}">Edit</button> <button class="admin-mini-btn danger btn-del" data-id="${evt.id}">Delete</button></div>`;
      list.appendChild(el);
    });
    document.querySelectorAll("#buffetEventsList .btn-del").forEach((b) =>
      b.addEventListener("click", async (e) => {
        if (!confirm("Delete this event?")) return;
        const id = Number(e.target.dataset.id);
        try {
          const res = await adminFetch("/api/admin/buffet-events", {
            method: "DELETE",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ id }),
          });
          const data = await res.json();
          if (!res.ok || !data.success) throw new Error(data.error || "Failed");
          await loadBuffetEventsAdmin();
        } catch (err) {
          alert(err.message || "Failed to delete");
        }
      }),
    );
    document.querySelectorAll("#buffetEventsList .btn-edit").forEach((b) =>
      b.addEventListener("click", async (e) => {
        const id = Number(e.target.dataset.id);
        const res = await adminFetch("/api/admin/buffet-events");
        const all = await res.json();
        const evt = (all.events || []).find((x) => x.id === id);
        if (!evt) return alert("Not found");
        document.getElementById("buffetFormTitle").textContent = `Edit: ${evt.title}`;
        form.scrollIntoView({ behavior: "smooth", block: "start" });
        document.getElementById("buffetEventId").value = evt.id;
        document.getElementById("buffetEventTitle").value = evt.title;
        const d = new Date(evt.event_date);
        const isoLocal = new Date(d.getTime() - d.getTimezoneOffset() * 60000)
          .toISOString()
          .slice(0, 16);
        document.getElementById("buffetEventDate").value = isoLocal;
        document.getElementById("buffetEventCapacity").value = evt.capacity;
        document.getElementById("buffetEventPrice").value = (
          Number(evt.price_cents || 0) / 100
        ).toFixed(2);
        document.getElementById("buffetEventDescription").value =
          evt.description || "";
        const eventPhotos = Array.isArray(evt.photos) ? evt.photos : [];
        form.dataset.existingPhotos = JSON.stringify(eventPhotos);
        getBuffetPhotoPicker().reset(); // drop unsaved picks, show this event's photos
        document.getElementById("buffetEventPublished").checked =
          !!evt.is_published;
        if (evt.booking_closes_at) {
          const d = new Date(evt.booking_closes_at);
          const isoLocal = new Date(d.getTime() - d.getTimezoneOffset() * 60000)
            .toISOString()
            .slice(0, 16);
          document.getElementById("buffetEventBookingCloses").value = isoLocal;
        } else {
          document.getElementById("buffetEventBookingCloses").value = "";
        }
      }),
    );
    buffetEventsById = Object.fromEntries((data.events || []).map((e) => [e.id, e]));
    document.querySelectorAll("#buffetEventsList .btn-view").forEach((b) =>
      b.addEventListener("click", async (e) => {
        await showBuffetBookings(Number(e.currentTarget.dataset.id));
        document.getElementById("buffetBookingsCard")?.scrollIntoView({ behavior: "smooth", block: "start" });
      }),
    );
  } catch (err) {
    console.error("Failed to load buffet events", err);
  }
}

document
  .getElementById("buffetToggle")
  .addEventListener("change", async (e) => {
    await adminFetch("/api/admin/config", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ is_buffet_visible: e.target.checked }),
    });
  });

// ---------------------------------------------------------------------
// Admin password reset flow on the login page
// ---------------------------------------------------------------------
function getResetTokenFromUrl() {
  const params = new URLSearchParams(window.location.search);
  return params.get("reset_token") || "";
}

function showAdminResetForm(token) {
  const loginForm = document.getElementById("loginForm");
  const resetForm = document.getElementById("adminResetForm");
  const resetTokenInput = document.getElementById("adminResetToken");

  loginForm.style.display = "none";
  resetForm.style.display = "block";
  resetTokenInput.value = token;
}

document
  .getElementById("adminResetForm")
  .addEventListener("submit", async (e) => {
    e.preventDefault();
    const token = document.getElementById("adminResetToken").value;
    const password = document.getElementById("adminResetPassword").value;
    const statusEl = document.getElementById("adminResetStatus");

    try {
      const res = await fetch("/api/admin/reset-password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token, password }),
      });
      const data = await res.json();
      if (!res.ok || !data.success)
        throw new Error(data.error || "Couldn't reset the password.");
      statusEl.textContent =
        "Password reset successfully. You can now log in with your new password.";
      document.getElementById("adminResetForm").reset();
      setTimeout(() => {
        window.history.replaceState(
          {},
          document.title,
          window.location.pathname,
        );
        document.getElementById("loginForm").style.display = "flex";
        document.getElementById("adminResetForm").style.display = "none";
      }, 1500);
    } catch (err) {
      statusEl.textContent = err.message;
    }
  });

const initialResetToken = getResetTokenFromUrl();
if (initialResetToken) {
  showAdminResetForm(initialResetToken);
}

// ---------------- Audit viewer (init and helpers appended) ----------------
// (Uses adminFetch already defined above)
let auditOffset = 0;
const auditLimit = 100;

function escapeHtml(s) {
  return String(s || "").replace(
    /[&<>"']/g,
    (c) => "&#" + c.charCodeAt(0) + ";",
  );
}

async function fetchAudit(offset = 0) {
  const from = document.getElementById("auditFrom")?.value;
  const to = document.getElementById("auditTo")?.value;
  const actor_role = document.getElementById("auditActorRole")?.value;
  const action = document.getElementById("auditAction")?.value?.trim();
  const params = new URLSearchParams();
  if (from) params.set("from", new Date(from).toISOString());
  if (to) params.set("to", new Date(to).toISOString());
  if (actor_role) params.set("actor_role", actor_role);
  if (action) params.set("action", action);
  params.set("limit", auditLimit);
  params.set("offset", offset);
  const res = await adminFetch("/api/admin/audit?" + params.toString());
  return res.json();
}

async function loadAudit(reset = true) {
  if (reset) auditOffset = 0;
  try {
    const data = await fetchAudit(auditOffset);
    renderAuditTable(data.rows || []);
    document.getElementById("auditPrevBtn").style.display =
      auditOffset > 0 ? "" : "none";
    document.getElementById("auditNextBtn").style.display =
      data.rows && data.rows.length === auditLimit ? "" : "none";
  } catch (err) {
    console.error("Failed to load audit:", err);
  }
}

const AUDIT_LABELS = {
  menu_item_created: "Menu item added",
  menu_item_updated: "Menu item updated",
  menu_item_deleted: "Menu item deleted",
  special_added: "Special added",
  special_updated: "Special updated",
  special_removed: "Special removed",
  delivery_fee_updated: "Delivery fee updated",
  cafe_details_updated: "Cafe details updated",
  out_of_service_enabled: "Out of service ON",
  out_of_service_disabled: "Out of service OFF",
  out_of_service_reason_updated: "Out-of-service reason changed",
  announcement_updated: "Announcement updated",
  buffet_visibility_updated: "Buffet visibility changed",
};

function auditLabel(action) {
  if (AUDIT_LABELS[action]) return AUDIT_LABELS[action];
  const t = String(action || "").replace(/_/g, " ").trim();
  return t.charAt(0).toUpperCase() + t.slice(1);
}

function auditTone(action) {
  if (/deleted|removed|enabled$|refund/.test(action || "")) return "danger";
  if (/disabled$|created|added/.test(action || "")) return "good";
  return "";
}

// Turns a details object into readable lines. New-style entries carry
// details.changes [{label, from, to}]; older entries fall back to key: value.
function auditChangesHtml(details) {
  if (!details || typeof details !== "object") return escapeHtml(details || "");
  if (Array.isArray(details.changes) && details.changes.length) {
    return details.changes
      .map(
        (c) =>
          `<span class="audit-change-line"><b>${escapeHtml(c.label)}:</b> <span class="audit-from">${escapeHtml(c.from)}</span> → <span class="audit-to">${escapeHtml(c.to)}</span></span>`,
      )
      .join("");
  }
  const skip = new Set(["summary", "changes"]);
  const lines = Object.entries(details)
    .filter(([k, v]) => !skip.has(k) && v !== null && v !== undefined && v !== "")
    .map(([k, v]) => {
      const label = k.replace(/_/g, " ");
      const val = typeof v === "object" ? JSON.stringify(v) : String(v);
      return `<span class="audit-change-line"><b>${escapeHtml(label.charAt(0).toUpperCase() + label.slice(1))}:</b> ${escapeHtml(val)}</span>`;
    });
  return lines.join("") || "-";
}

function parseAuditDetails(d) {
  if (d && typeof d === "object") return d;
  try { return JSON.parse(d); } catch { return d || {}; }
}

function renderAuditTable(rows) {
  const body = document.getElementById("auditTableBody");
  if (!body) return;
  body.innerHTML = "";
  if (!rows.length) {
    body.innerHTML = '<tr><td colspan="6">No results</td></tr>';
    return;
  }
  rows.forEach((r) => {
    const details = parseAuditDetails(r.details);
    const raw = typeof details === "object" ? JSON.stringify(details) : String(details);
    const summary = details && details.summary ? details.summary : "";
    const tone = auditTone(r.action);
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${new Date(r.created_at).toLocaleString()}</td>
      <td><span class="audit-action-tag ${tone}">${escapeHtml(auditLabel(r.action))}</span>${summary ? `<span class="audit-summary">${escapeHtml(summary)}</span>` : ""}</td>
      <td>${escapeHtml(r.actor_role || "")}</td>
      <td>${escapeHtml(r.actor_type || "")}${r.actor_id ? " #" + r.actor_id : ""}</td>
      <td>${escapeHtml(r.target_type || "")}${r.target_id ? " #" + r.target_id : ""}</td>
      <td class="audit-details audit-changes" data-raw="${escapeHtml(raw)}" title="Click to copy the raw details">${auditChangesHtml(details)}</td>
    `;
    body.appendChild(tr);
  });
}

function initAuditHandlers() {
  document
    .getElementById("auditLoadBtn")
    ?.addEventListener("click", () => loadAudit(true));
  // Clearing is permanent, so it only happens after an explicit "yes".
  document.getElementById("auditClearBtn")?.addEventListener("click", async () => {
    const sure = confirm(
      "Are you sure you want to clear the whole audit log?\n\nThis permanently deletes every entry and CANNOT be undone. (Tip: use Export CSV first if you want a copy.)",
    );
    if (!sure) return;
    try {
      const res = await adminFetch("/api/admin/audit", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ confirm: "CLEAR" }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.success) throw new Error(data.error || "Couldn't clear the audit log.");
      alert(`Audit log cleared (${data.deleted} entr${data.deleted === 1 ? "y" : "ies"} removed).`);
      loadAudit(true);
    } catch (err) {
      alert(err.message || "Couldn't clear the audit log.");
    }
  });
  document.getElementById("auditPrevBtn")?.addEventListener("click", () => {
    auditOffset = Math.max(0, auditOffset - auditLimit);
    loadAudit(false);
  });
  document.getElementById("auditNextBtn")?.addEventListener("click", () => {
    auditOffset += auditLimit;
    loadAudit(false);
  });
  document
    .getElementById("auditExportBtn")
    ?.addEventListener("click", async () => {
      try {
        const data = await fetchAudit(auditOffset);
        const rows = data.rows || [];
        const csv = ["time,action,actor_role,actor, target, details"];
        rows.forEach((r) => {
          const details =
            typeof r.details === "object"
              ? JSON.stringify(r.details)
              : String(r.details || "");
          const line = [
            `"${new Date(r.created_at).toISOString()}"`,
            `"${r.action || ""}"`,
            `"${r.actor_role || ""}"`,
            `"${r.actor_type || ""}${r.actor_id ? " #" + r.actor_id : ""}"`,
            `"${r.target_type || ""}${r.target_id ? " #" + r.target_id : ""}"`,
            `"${details.replace(/"/g, '""')}"`,
          ].join(",");
          csv.push(line);
        });
        const blob = new Blob([csv.join("\n")], { type: "text/csv" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = "audit_logs.csv";
        document.body.appendChild(a);
        a.click();
        a.remove();
        URL.revokeObjectURL(url);
      } catch (err) {
        console.error("Export failed", err);
      }
    });
  // Click-to-copy details
  const body = document.getElementById("auditTableBody");
  if (body) {
    body.addEventListener("click", (e) => {
      const td = e.target.closest(".audit-details");
      if (!td) return;
      const text = td.dataset.raw || td.textContent || "";
      if (navigator.clipboard && text) {
        navigator.clipboard
          .writeText(text)
          .then(() => {
            if (typeof toast === "function")
              toast("Copied details to clipboard");
          })
          .catch(() => {
            // ignore
          });
      }
    });
  }
}
// Init
// ---------------------------------------------------------------------
if (adminToken) {
  showDashboard();
}

// ---------------------------------------------------------------------
// Form validation for every admin form - rules live in js/form-validation.js
// (shared with the customer site); the server re-checks all of it.
// ---------------------------------------------------------------------
if (typeof FuludeValidation !== "undefined") {
  const money = (max, title) => ({ min: 0, max, step: 0.01, title });
  FuludeValidation.apply({
    // Customer details entered by staff: Place Order, Book for a customer, buffet seats
    names: ["resNewName", "orderCustomerName", "bbName", "staffAccountName"],
    newPasswords: ["staffAccountPassword", "adminAccountPassword", "newAdminPassword", "adminResetPassword"],
    futureDates: ["resNewDate"],
    futureDateTimes: ["buffetEventDate"],
    numbers: {
      itemPrice: money(100000, "Price in Rand, e.g. 85 or 85.50"),
      addonPrice: money(100000, "Price in Rand, e.g. 15"),
      specialPriceInput: money(100000, "Special price in Rand"),
      buffetEventPrice: money(100000, "Price per seat in Rand"),
      poManualFee: money(10000, "Delivery fee in Rand"),
      itemStockQuantity: { min: 0, max: 100000, step: 1, title: "Whole number - leave empty for unlimited" },
      buffetEventCapacity: { min: 1, max: 1000, step: 1, title: "Number of seats (1-1000)" },
      resNewParty: { min: 1, max: 200, step: 1, title: "1 to 200 guests" },
      bbSeats: { min: 1, max: 500, step: 1, title: "Number of seats" },
      cafeLatitude: { min: -90, max: 90, step: "any", title: "Between -90 and 90, e.g. -22.9834" },
      cafeLongitude: { min: -180, max: 180, step: "any", title: "Between -180 and 180, e.g. 30.3571" },
    },
    maxLengths: {
      itemName: 100, itemDescription: 500, itemIngredients: 1000,
      addonName: 60, spiceName: 60, sideName: 60, categoryName: 60,
      resNewTable: 30, resNewNotes: 500, orderTableNumber: 30, orderInstructions: 500,
      poStreet: 200, poUnit: 50, poSuburb: 100, poCity: 100,
      buffetEventTitle: 200, buffetEventDescription: 2000,
      marketingSubject: 150, marketingBody: 5000,
    },
    patterns: { poPostal: { pattern: "[0-9]{4}", title: "4-digit postal code, e.g. 0950" } },
    custom: [
      {
        id: "buffetEventBookingCloses",
        test: (v) => !document.getElementById("buffetEventDate")?.value || v <= document.getElementById("buffetEventDate").value,
        message: "Booking must close before the event starts.",
      },
      {
        id: "specialEndsInput",
        test: (v) => !document.getElementById("specialStartsInput")?.value || v > document.getElementById("specialStartsInput").value,
        message: "The special must end after it starts.",
      },
    ],
  });
}
