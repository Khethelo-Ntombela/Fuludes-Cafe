/**
 * public/js/kds.js
 * -----------------------------------------------------------------------
 * Shared Kitchen Display System renderer used by BOTH the admin Live
 * Orders board (admin.js) and the staff kitchen board (staff.js), so the
 * two boards stay pixel-identical.
 *
 * KDS rules enforced here:
 *  - every order card is a fixed height; long items/notes never stretch
 *    a card ("+N more" + a details overlay instead)
 *  - the elapsed-time timer dominates the card (urgency colored)
 *  - hierarchy: order # > timer > type > items > note; customer/contact
 *    details live in the details overlay only
 *  - one primary action + an overflow (⋮) menu per card
 *  - hand-off columns can render compact single-line rows
 *  - column headers show status, count and average ticket age
 *  - drag cards/rows between status columns to persist status changes
 *
 * Load BEFORE admin.js / staff.js.
 * -----------------------------------------------------------------------
 */

const KDS_MAX_ITEM_LINES = 3;

/* ---------------- Daily reset (South Africa time) ----------------
 * Today's stats (kitchen strip, today's reservations) only count things
 * from the current cafe day, so they clear by themselves at 12:00 am. */
const KDS_TZ = "Africa/Johannesburg";

/** "YYYY-MM-DD" of a moment in cafe time (defaults to now). */
function kdsDayKey(date = new Date()) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: KDS_TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(date);
}

function kdsIsToday(order) {
  return kdsDayKey(new Date(order.created_at)) === kdsDayKey();
}

/** Milliseconds until the next 12:00 am in cafe time. */
function kdsMsUntilMidnight() {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: KDS_TZ, hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
  }).formatToParts(new Date());
  const get = (t) => Number(parts.find((p) => p.type === t)?.value || 0);
  const elapsed = (get("hour") * 3600 + get("minute") * 60 + get("second")) * 1000;
  return 24 * 3600 * 1000 - elapsed;
}

/** "Resets at 12:00 am (in 5h 12m)" */
function kdsResetLabel() {
  const mins = Math.ceil(kdsMsUntilMidnight() / 60000);
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return `Today's stats reset at 12:00 am (in ${h ? `${h}h ` : ""}${m}m)`;
}

/** Runs fn right after every cafe midnight while the page stays open. */
function kdsOnMidnight(fn) {
  setTimeout(() => {
    fn();
    kdsOnMidnight(fn);
  }, kdsMsUntilMidnight() + 1000);
}

function kdsFmt(n) {
  return `R${Number(n).toFixed(2)}`;
}

/**
 * When the order reached the admin/staff boards: paid orders wait out the
 * customer's 2-minute cancel window first (kitchen_release_at), so all
 * timers - card timer, column average, Avg Ticket Age, Longest Waiting -
 * count from then, not from when the customer placed it.
 */
function kdsStartTime(order) {
  return new Date(order.kitchen_release_at || order.created_at).getTime();
}

function kdsMinutes(order) {
  return Math.max(0, Math.round((Date.now() - kdsStartTime(order)) / 60000));
}

/**
 * The boards poll every 5s; the API also says when the next paid order
 * leaves its 2-minute window, so fetch again at exactly that moment and the
 * new-order sound rings as soon as it reaches the kitchen.
 */
let kdsReleaseTimer = null;
function kdsScheduleNextRelease(data, refresh) {
  clearTimeout(kdsReleaseTimer);
  if (!data || !data.next_release_at) return;
  // Server clock for both ends - a wrong clock on this device doesn't matter.
  const serverNow = data.server_now ? new Date(data.server_now).getTime() : Date.now();
  const wait = new Date(data.next_release_at).getTime() - serverNow + 250;
  if (wait > 0 && wait < 10 * 60 * 1000) kdsReleaseTimer = setTimeout(refresh, wait);
}

/* Urgency tiers: 0-10 green, 10-20 amber, 20-30 orange, 30+ red (pulse). */
function kdsUrgency(order) {
  const mins = kdsMinutes(order);
  if (!["New", "Preparing", "Ready"].includes(order.status)) return { cls: "u-done", mins };
  if (mins >= 30) return { cls: "u-late", mins };
  if (mins >= 20) return { cls: "u-hot", mins };
  if (mins >= 10) return { cls: "u-warn", mins };
  return { cls: "u-ok", mins };
}

function kdsTypeBadgeHtml(order) {
  const label =
    order.order_type === "delivery"
      ? "Delivery"
      : order.order_type === "dine_in"
      ? `Dine In${order.table_number ? ` · T${order.table_number}` : ""}`
      : "Collection";
  return `<span class="badge badge-type-${order.order_type}">${label}</span>`;
}

/* Kitchen lifecycle: New -> Preparing -> Ready -> Collection/Delivery -> Completed */
function kdsNextStage(order) {
  if (order.status === "New") return "Preparing";
  if (order.status === "Preparing") return "Ready";
  if (order.status === "Ready") return order.order_type === "delivery" ? "Delivery" : "Collection";
  if (order.status === "Collection" || order.status === "Delivery" || order.status === "Out for Delivery") return "Completed";
  return null;
}

function kdsNextStageLabel(order) {
  if (order.status === "New") return "Start Preparing";
  if (order.status === "Preparing") return "Mark Ready";
  if (order.status === "Ready") return order.order_type === "delivery" ? "Send Delivery" : "Ready for Collection";
  if (order.status === "Collection") return "Collected";
  if (order.status === "Delivery" || order.status === "Out for Delivery") return "Complete Delivery";
  return "";
}

function kdsItemLine(item) {
  const extras = Array.isArray(item.extras) ? item.extras : JSON.parse(item.extras || "[]");
  const bits = [];
  if (item.spice_level) bits.push(item.spice_level);
  if (extras.length) bits.push(extras.map((e) => e.name).join(", "));
  return `${item.quantity}× ${item.item_name}${bits.length ? ` <span style="color:var(--sa-muted)">(${bits.join(" · ")})</span>` : ""}`;
}

function kdsStatusMenuHtml(order) {
  if (order.status !== "Ready") return "";
  return `
          <button type="button" data-status="Collection" data-id="${order.id}">Move to Collection</button>
          <button type="button" data-status="Delivery" data-id="${order.id}">Move to Delivery</button>`;
}

function kdsCardHtml(order) {
  const { cls, mins } = kdsUrgency(order);
  const items = order.items || [];
  const shown = items.slice(0, KDS_MAX_ITEM_LINES);
  const moreCount = items.length - shown.length;
  const nextStatus = kdsNextStage(order);

  return `
    <div class="kds-card ${cls}" data-order-id="${order.id}" draggable="true">
      <div class="kds-card-head">
        <div class="kds-card-head-left">
          <span class="kds-card-id">#${order.id}</span>
          ${kdsTypeBadgeHtml(order)}
          ${order.total_amount !== undefined ? `<span class="kds-card-total">${kdsFmt(order.total_amount)}</span>` : ""}
        </div>
        <span class="kds-timer ${cls}">${mins}<small>min</small></span>
      </div>
      <ul class="kds-card-items">${shown.map((i) => `<li>${kdsItemLine(i)}</li>`).join("")}</ul>
      ${moreCount > 0 ? `<div class="kds-more">+${moreCount} more item${moreCount === 1 ? "" : "s"} · tap ⋮</div>` : ""}
      ${order.special_instructions ? `<div class="kds-card-note"><i class="fas fa-circle-exclamation"></i> ${order.special_instructions}</div>` : ""}
      <div class="kds-card-actions">
        ${
          nextStatus
            ? `<button class="kds-advance-btn" data-status="${nextStatus}" data-id="${order.id}">${kdsNextStageLabel(order)}</button>`
            : `<button class="kds-advance-btn" data-open-details="${order.id}" style="background:var(--sa-bg);color:var(--sa-text)">Details</button>`
        }
        <button type="button" class="kds-menu-btn" data-menu-toggle aria-label="More actions">⋮</button>
        <div class="kds-menu">
          <button type="button" data-open-details="${order.id}"><i class="fas fa-circle-info"></i> Order info</button>
          ${kdsStatusMenuHtml(order)}
          <button type="button" class="danger" data-status="Cancelled" data-id="${order.id}">Cancel order</button>
        </div>
      </div>
    </div>`;
}

/* Compact row for hand-off columns. */
function kdsRowHtml(order) {
  const mins = kdsMinutes(order);
  const type = order.order_type === "delivery" ? "Delivery" : order.order_type === "dine_in" ? "Dine In" : "Collection";
  return `
    <div class="kds-row" data-open-details="${order.id}" data-order-id="${order.id}" draggable="true">
      <strong>#${order.id}</strong>
      <span class="kds-row-meta">${type}</span>
      ${order.total_amount !== undefined ? `<span class="kds-row-total">${kdsFmt(order.total_amount)}</span>` : ""}
      <span class="kds-row-age">${mins} min</span>
      <div class="kds-card-actions kds-row-actions">
        <button type="button" class="kds-menu-btn" data-menu-toggle aria-label="More actions">⋮</button>
        <div class="kds-menu">
          <button type="button" data-open-details="${order.id}"><i class="fas fa-circle-info"></i> Order info</button>
          <button type="button" data-status="Completed" data-id="${order.id}">Mark as Completed</button>
          <button type="button" class="danger" data-status="Cancelled" data-id="${order.id}">Cancel order</button>
        </div>
      </div>
    </div>`;
}

/**
 * Renders the full board (columns incl. headers) as HTML.
 * opts.compactStatuses: statuses rendered as compact rows instead of cards.
 */
function kdsBoardHtml(orders, columns, opts = {}) {
  const compact = new Set(opts.compactStatuses || []);
  return columns
    .map((col) => {
      const list = orders.filter((o) => o.status === col);
      const ages = list.map(kdsMinutes);
      const avg = ages.length ? Math.round(ages.reduce((s, m) => s + m, 0) / ages.length) : null;
      return `
      <div class="kds-col" data-column="${col}">
        <div class="kds-col-header">
          <span class="kds-col-dot"></span>
          <div class="kds-col-titles">
            <strong>${col}</strong>
            <small>${list.length} order${list.length === 1 ? "" : "s"}${avg !== null ? ` · Avg ${avg} min` : ""}</small>
          </div>
          <span class="admin-badge">${list.length}</span>
        </div>
        <div class="kds-col-list">
          ${list.length === 0 ? `<p class="kds-empty">Nothing here right now.</p>` : list.map((o) => (compact.has(col) ? kdsRowHtml(o) : kdsCardHtml(o))).join("")}
        </div>
      </div>`;
    })
    .join("");
}

/**
 * Wires up a rendered board: overflow menus, details overlay, and status
 * actions. `confirmAction(order, status)` may return false to abort;
 * `onAction(status, orderId)` performs the update.
 */
function kdsBindBoard(container, orders, { onAction, confirmAction, onError }) {
  const byId = Object.fromEntries(orders.map((o) => [String(o.id), o]));

  const closeMenus = () => container.querySelectorAll(".kds-card-actions.menu-open").forEach((a) => a.classList.remove("menu-open"));

  const dispatchAction = async (status, orderId, order) => {
    if (confirmAction && order && confirmAction(order, status) === false) return;
    try {
      await onAction(status, orderId, order);
    } catch (err) {
      if (onError) onError(err, order, status);
      else window.alert(err.message || `Could not move order #${orderId}.`);
    }
  };

  container.querySelectorAll("[data-menu-toggle]").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const actions = btn.closest(".kds-card-actions");
      const wasOpen = actions.classList.contains("menu-open");
      closeMenus();
      if (wasOpen) return;
      actions.classList.add("menu-open");
      if (actions.classList.contains("kds-row-actions")) kdsPlaceFloatingMenu(btn, actions.querySelector(".kds-menu"));
    });
  });

  container.querySelectorAll("[data-open-details]").forEach((el) => {
    el.addEventListener("click", (e) => {
      e.stopPropagation();
      const order = byId[el.dataset.openDetails];
      closeMenus();
      // The details window can finish the order itself (Collection / Delivery -> Completed).
      if (order) kdsOpenDetails(order, (status) => dispatchAction(status, order.id, order));
    });
  });

  container.querySelectorAll("[data-status][data-id]").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const order = byId[btn.dataset.id];
      const status = btn.dataset.status;
      closeMenus();
      if (confirmAction && order && confirmAction(order, status) === false) return;
      onAction(status, parseInt(btn.dataset.id, 10));
    });
  });

  container.querySelectorAll("[data-order-id][draggable='true']").forEach((el) => {
    el.addEventListener("dragstart", (e) => {
      closeMenus();
      e.dataTransfer.effectAllowed = "move";
      e.dataTransfer.setData("text/plain", el.dataset.orderId);
      el.classList.add("kds-dragging");
    });
    el.addEventListener("dragend", () => {
      el.classList.remove("kds-dragging");
      container.querySelectorAll(".kds-col.drop-target").forEach((col) => col.classList.remove("drop-target"));
    });
  });

  container.querySelectorAll(".kds-col").forEach((col) => {
    col.addEventListener("dragover", (e) => {
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
      col.classList.add("drop-target");
    });
    col.addEventListener("dragleave", (e) => {
      if (!col.contains(e.relatedTarget)) col.classList.remove("drop-target");
    });
    col.addEventListener("drop", (e) => {
      e.preventDefault();
      col.classList.remove("drop-target");
      const orderId = e.dataTransfer.getData("text/plain");
      const order = byId[orderId];
      const status = col.dataset.column;
      if (!order || !status || order.status === status) return;
      if (confirmAction && confirmAction(order, status) === false) return;
      onAction(status, parseInt(orderId, 10));
    });
  });
}

document.addEventListener("click", () => {
  document.querySelectorAll(".kds-card-actions.menu-open").forEach((a) => a.classList.remove("menu-open"));
});
// Floating row menus follow their ⋮ button when the page or a column scrolls.
document.addEventListener(
  "scroll",
  () => {
    document.querySelectorAll(".kds-row-actions.menu-open").forEach((actions) => {
      kdsPlaceFloatingMenu(actions.querySelector("[data-menu-toggle]"), actions.querySelector(".kds-menu"));
    });
  },
  true,
);

/** Escapes customer-typed text (names, addresses, notes) before it goes into HTML. */
function kdsEsc(value) {
  return String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

/** Row menus sit in a scrolling column - float them next to the ⋮ button, above or below, whichever fits. */
function kdsPlaceFloatingMenu(btn, menu) {
  if (!menu) return;
  const r = btn.getBoundingClientRect();
  menu.style.position = "fixed";
  menu.style.right = `${Math.max(8, window.innerWidth - r.right)}px`;
  menu.style.left = "auto";
  const h = menu.offsetHeight;
  if (r.top - h - 6 > 8) {
    menu.style.top = `${r.top - h - 6}px`;
  } else {
    menu.style.top = `${Math.min(r.bottom + 6, window.innerHeight - h - 8)}px`;
  }
  menu.style.bottom = "auto";
}

/* ---------------- Details overlay ---------------- */
function kdsOpenDetails(order, onAction) {
  let overlay = document.getElementById("kdsDetailOverlay");
  if (!overlay) {
    overlay = document.createElement("div");
    overlay.id = "kdsDetailOverlay";
    overlay.className = "modal-overlay";
    overlay.innerHTML = `<div class="modal" style="border-radius:12px;"><button class="modal-close" id="kdsDetailClose">&times;</button><h3 id="kdsDetailTitle"></h3><div id="kdsDetailBody"></div></div>`;
    document.body.appendChild(overlay);
    overlay.addEventListener("click", (e) => {
      if (e.target === overlay) overlay.classList.remove("active");
    });
    overlay.querySelector("#kdsDetailClose").addEventListener("click", () => overlay.classList.remove("active"));
  }

  const fmt = kdsFmt;
  const esc = kdsEsc;
  const mins = kdsMinutes(order);
  const when = (d) => (d ? new Date(d).toLocaleString("en-ZA", { dateStyle: "medium", timeStyle: "short" }) : "");
  const row = (label, value) => (value ? `<div class="row"><span>${label}</span><span>${value}</span></div>` : "");
  const section = (title) => `<div class="kds-detail-section">${title}</div>`;
  const typeLabel = order.order_type === "delivery" ? "Delivery" : order.order_type === "dine_in" ? "Dine in" : "Collection";

  const items = order.items || [];
  const itemsTotal = items.reduce((sum, i) => sum + Number(i.subtotal || 0), 0);
  const itemsHtml = items
    .map((i) => `<li><span>${kdsItemLine(i)}</span>${i.subtotal !== undefined ? `<span>${fmt(i.subtotal)}</span>` : ""}</li>`)
    .join("");

  let deliveryHtml = "";
  if (order.order_type === "delivery") {
    const hasPin = order.delivery_lat && order.delivery_lng;
    const mapQuery = hasPin ? `${order.delivery_lat},${order.delivery_lng}` : order.delivery_address || "";
    const mapLink = mapQuery
      ? `<a class="kds-map-link" href="https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(mapQuery)}" target="_blank" rel="noopener"><i class="fas fa-map-location-dot"></i> Open in Google Maps</a>`
      : "";
    deliveryHtml = `
      ${section("Delivery")}
      <div class="kds-address">${order.delivery_address ? esc(order.delivery_address) : "No address given"}${mapLink}</div>
      ${row("Distance", order.delivery_distance_km ? `${Number(order.delivery_distance_km).toFixed(1)} km` : "")}
      ${row("Delivery fee", order.delivery_fee !== undefined && order.delivery_fee !== null ? fmt(order.delivery_fee) : "")}`;
  }

  const phone = order.customer_phone ? `<a href="tel:${esc(order.customer_phone.replace(/s+/g, ""))}">${esc(order.customer_phone)}</a>` : "";
  const payment =
    order.payment_status === "paid"
      ? `Paid online${order.payment_confirmed_at ? ` · ${when(order.payment_confirmed_at)}` : ""}`
      : esc(order.payment_status || "");

  overlay.querySelector("#kdsDetailTitle").textContent = `Order #${order.id}`;
  overlay.querySelector("#kdsDetailBody").innerHTML = `
    <div class="kds-detail-rows">
      ${section("Order")}
      ${row("Status", `${esc(order.status)} · ${mins} min in kitchen`)}
      ${row("Type", order.order_type === "dine_in" && order.table_number ? `Dine in · Table ${esc(order.table_number)}` : typeLabel)}
      ${row("Placed", when(order.created_at))}
      ${order.kitchen_release_at ? row("Reached kitchen", when(order.kitchen_release_at)) : ""}
      ${row("Timing", esc(order.pickup_time || ""))}
      ${section("Customer")}
      ${row("Name", esc(order.customer_name || "—"))}
      ${row("Phone", phone)}
      ${deliveryHtml}
      ${section(`Items (${items.reduce((n, i) => n + Number(i.quantity || 0), 0)})`)}
      <ul class="kds-detail-items">${itemsHtml}</ul>
      ${order.special_instructions ? `<div class="kds-detail-note"><i class="fas fa-circle-exclamation"></i> ${esc(order.special_instructions)}</div>` : ""}
      ${section("Payment")}
      ${order.order_type === "delivery" && order.delivery_fee ? row("Items", fmt(itemsTotal)) : ""}
      ${order.order_type === "delivery" && order.delivery_fee ? row("Delivery fee", fmt(order.delivery_fee)) : ""}
      ${order.total_amount !== undefined ? row("Total", `<strong>${fmt(order.total_amount)}</strong>`) : ""}
      ${row("Payment", payment)}
      ${row("Reference", esc(order.payment_ref || ""))}
    </div>
    ${
      onAction && ["Collection", "Delivery", "Out for Delivery"].includes(order.status)
        ? `<button type="button" class="kds-complete-btn" id="kdsCompleteBtn"><i class="fas fa-circle-check"></i> Mark as Completed</button>`
        : ""
    }
  `;
  const completeBtn = overlay.querySelector("#kdsCompleteBtn");
  if (completeBtn) {
    completeBtn.addEventListener("click", async () => {
      completeBtn.disabled = true;
      completeBtn.textContent = "Completing…";
      await onAction("Completed");
      overlay.classList.remove("active"); // the board refreshes and the order drops off it
    });
  }
  overlay.classList.add("active");
}
