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

function kdsFmt(n) {
  return `R${Number(n).toFixed(2)}`;
}

function kdsMinutes(order) {
  return Math.max(0, Math.round((Date.now() - new Date(order.created_at).getTime()) / 60000));
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
          <button type="button" data-open-details="${order.id}">View details</button>
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
      if (!wasOpen) actions.classList.add("menu-open");
    });
  });

  container.querySelectorAll("[data-open-details]").forEach((el) => {
    el.addEventListener("click", (e) => {
      e.stopPropagation();
      const order = byId[el.dataset.openDetails];
      closeMenus();
      if (order) kdsOpenDetails(order);
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

/* ---------------- Details overlay ---------------- */
function kdsOpenDetails(order) {
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
  const mins = kdsMinutes(order);
  const placed = new Date(order.created_at).toLocaleString("en-ZA", { dateStyle: "medium", timeStyle: "short" });
  const typeLabel =
    order.order_type === "delivery"
      ? `Delivery${order.delivery_address ? ` · ${order.delivery_address}` : ""}`
      : order.order_type === "dine_in"
      ? `Dine In${order.table_number ? ` (Table ${order.table_number})` : ""}`
      : "Collection";

  const itemsHtml = (order.items || [])
    .map((i) => `<li>${kdsItemLine(i)}${i.subtotal !== undefined ? ` — ${fmt(i.subtotal)}` : ""}</li>`)
    .join("");

  overlay.querySelector("#kdsDetailTitle").textContent = `Order #${order.id}`;
  overlay.querySelector("#kdsDetailBody").innerHTML = `
    <div class="kds-detail-rows">
      <div class="row"><span>Status</span><span>${order.status} · ${mins} min ago</span></div>
      <div class="row"><span>Placed</span><span>${placed}</span></div>
      <div class="row"><span>Type</span><span>${typeLabel}</span></div>
      <div class="row"><span>Timing</span><span>${order.pickup_time || "—"}</span></div>
      <div class="row"><span>Customer</span><span>${order.customer_name}${order.customer_phone ? ` · ${order.customer_phone}` : ""}</span></div>
      ${order.payment_status ? `<div class="row"><span>Payment</span><span>${order.payment_status === "paid" ? "Paid online" : order.payment_status}</span></div>` : ""}
      ${order.total_amount !== undefined ? `<div class="row"><span>Total</span><span><strong>${fmt(order.total_amount)}</strong></span></div>` : ""}
      ${order.special_instructions ? `<div class="row"><span>Note</span><span>${order.special_instructions}</span></div>` : ""}
      <ul>${itemsHtml}</ul>
    </div>
  `;
  overlay.classList.add("active");
}
