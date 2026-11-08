// Walk-in orders screen - used by BOTH the staff portal (fc-kitchen.html) and the admin dashboard (fc-hq.html).
//   New order : pick dishes, then either Takeaway (guest pays by card first) or Dine-in (added to the table's tab).
//   Open tabs : every table that has ordered but not paid yet. Add items, see/edit the bill, close it when the guests pay by card.
//
// FuludeWalkin.mount(rootElement, { api: "/api/staff/walkin", fetchFn, isAdmin, onTabsChanged })
(function () {
  const esc = (t) =>
    String(t ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const money = (n) => `R${Number(n || 0).toFixed(2)}`;
  const timeOf = (d) => (d ? new Date(d).toLocaleTimeString("en-ZA", { hour: "2-digit", minute: "2-digit" }) : "");
  const ago = (d) => {
    const m = Math.max(0, Math.floor((Date.now() - new Date(d).getTime()) / 60000));
    return m < 60 ? `${m} min` : `${Math.floor(m / 60)}h ${m % 60}m`;
  };

  function mount(root, opts) {
    const api = opts.api;
    const doFetch = opts.fetchFn || fetch;
    const isAdmin = !!opts.isAdmin;

    let menu = [];
    let spiceLevels = [];
    let categories = [];
    let menuError = "";
    let category = "all";
    let query = "";
    let cart = [];
    let tabs = [];
    let view = "new"; // 'new' | 'tabs'
    let orderType = "takeaway"; // 'takeaway' | 'dine_in'
    let tabChoice = "new"; // 'new' or an open tab's id
    let busy = false;
    let openBills = new Set(); // tab ids whose bill is expanded
    let pollTimer = null;
    let lastTabsKey = "";

    const form = { table: "", guest: "", notes: "" };

    root.innerHTML = `
      <div class="wi-wrap">
        <div class="wi-switch">
          <button type="button" class="wi-switch-btn active" data-view="new"><i class="fas fa-plus"></i> New order</button>
          <button type="button" class="wi-switch-btn" data-view="tabs"><i class="fas fa-receipt"></i> Open tabs <span class="admin-badge" data-wi-count>0</span></button>
        </div>
        <div class="wi-toast" data-wi-toast hidden></div>
        <div data-wi-pane="new"></div>
        <div data-wi-pane="tabs" hidden></div>
      </div>`;

    const $ = (sel) => root.querySelector(sel);
    const paneNew = $('[data-wi-pane="new"]');
    const paneTabs = $('[data-wi-pane="tabs"]');

    root.querySelectorAll(".wi-switch-btn").forEach((b) =>
      b.addEventListener("click", () => setView(b.dataset.view)),
    );

    function setView(v) {
      view = v;
      root.querySelectorAll(".wi-switch-btn").forEach((b) => b.classList.toggle("active", b.dataset.view === v));
      paneNew.hidden = v !== "new";
      paneTabs.hidden = v !== "tabs";
      if (v === "tabs") loadTabs();
    }

    let toastTimer = null;
    function toast(message, isError) {
      const el = $("[data-wi-toast]");
      el.textContent = message;
      el.className = `wi-toast ${isError ? "wi-toast-error" : "wi-toast-ok"}`;
      el.hidden = false;
      clearTimeout(toastTimer);
      toastTimer = setTimeout(() => (el.hidden = true), isError ? 7000 : 4000);
    }

    async function post(body) {
      const res = await doFetch(api, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        const err = new Error(data.error || "Something went wrong. Please try again.");
        err.data = data;
        throw err;
      }
      return data;
    }

    // ---------------------------------------------------------------- menu
    async function loadMenu() {
      menuError = "";
      try {
        const res = await fetch("/api/menu", { cache: "no-store" });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || "Couldn't load the menu.");
        menu = data.items || [];
        spiceLevels = data.spice_levels || [];
        categories = data.categories || [];
      } catch (err) {
        menu = [];
        menuError = err.message || "Couldn't load the menu.";
      }
    }

    const needsOptions = (item) =>
      (item.accepts_spice && spiceLevels.length > 0) ||
      (item.accepts_addons && (item.addons || []).length > 0) ||
      (item.sides || []).length > 0;
    const qtyInCart = (id) => cart.filter((l) => l.itemId === id).reduce((n, l) => n + l.qty, 0);
    const cartTotal = () => cart.reduce((s, l) => s + (l.unit + l.extras.reduce((x, e) => x + e.price, 0)) * l.qty, 0);
    const cartCount = () => cart.reduce((s, l) => s + l.qty, 0);

    function addLine(item, { spice, side, extras, qty }) {
      const lineId = `${item.id}|${spice || ""}|${side ? side.id : ""}|${extras.map((e) => e.id).sort().join(",")}`;
      const unit = Number(item.effective_price ?? item.price);
      const existing = cart.find((l) => l.lineId === lineId);
      if (existing) existing.qty += qty;
      else cart.push({ lineId, itemId: item.id, name: item.name, unit, qty, spice: spice || null, side: side || null, extras });
      renderNew();
    }

    // ---------------------------------------------------------------- "New order" pane
    function renderNew() {
      const q = query.trim().toLowerCase();
      const shown = menu.filter(
        (i) =>
          (category === "all" || String(i.category_id) === String(category)) &&
          (!q || `${i.name} ${i.description || ""}`.toLowerCase().includes(q)),
      );
      const keepSearch = document.activeElement && document.activeElement.id === "wiSearch";

      const grid = menuError
        ? `<p class="menu-empty">Couldn't load the menu: ${esc(menuError)}<br><button type="button" class="btn btn-primary admin-mini-btn" data-wi-retry style="margin-top:10px">Try again</button></p>`
        : !menu.length
          ? '<p class="menu-loading">Loading the menu&hellip;</p>'
          : !shown.length
            ? '<p class="menu-empty">Nothing matches that search.</p>'
            : shown
                .map((item) => {
                  const soldOut = item.is_available === false;
                  const price = Number(item.effective_price ?? item.price);
                  const qty = qtyInCart(item.id);
                  return `
          <div class="admin-menu-item${soldOut ? " sold-out" : ""}">
            <div class="admin-menu-item-info">
              <strong>${esc(item.name)}</strong>
              ${item.description ? `<small>${esc(item.description)}</small>` : ""}
              <span class="admin-menu-item-price">${item.is_on_special ? `<s>R${Number(item.price).toFixed(2)}</s> ` : ""}R${price.toFixed(2)}</span>
            </div>
            <div class="admin-menu-item-actions">
              <button type="button" class="btn btn-primary admin-mini-btn" data-wi-add="${item.id}" ${soldOut ? "disabled" : ""}>
                ${soldOut ? "Sold out" : `<i class="fas fa-plus"></i> ${needsOptions(item) ? "Options" : "Add"}${qty ? ` (${qty})` : ""}`}
              </button>
            </div>
          </div>`;
                })
                .join("");

      const chips =
        `<button type="button" class="po-chip${category === "all" ? " active" : ""}" data-wi-cat="all">All</button>` +
        categories
          .map((c) => `<button type="button" class="po-chip${String(category) === String(c.id) ? " active" : ""}" data-wi-cat="${c.id}">${esc(c.name)}</button>`)
          .join("");

      const cartRows = cart.length
        ? cart
            .map((l) => {
              const detail = [l.spice, l.side ? l.side.name : "", ...l.extras.map((e) => `+ ${e.name}`)].filter(Boolean).join(" · ");
              return `
          <div class="wi-cart-line">
            <div class="wi-cart-name"><strong>${esc(l.name)}</strong>${detail ? `<small>${esc(detail)}</small>` : ""}</div>
            <span class="admin-cart-item-qty">
              <button type="button" class="admin-mini-btn" data-wi-qty="${esc(l.lineId)}" data-d="-1">&minus;</button>
              <span>${l.qty}</span>
              <button type="button" class="admin-mini-btn" data-wi-qty="${esc(l.lineId)}" data-d="1">+</button>
            </span>
            <span class="wi-cart-price">${money((l.unit + l.extras.reduce((x, e) => x + e.price, 0)) * l.qty)}</span>
          </div>`;
            })
            .join("")
        : '<p class="admin-cart-empty">Nothing added yet</p>';

      const openTabsForPick = tabs;
      const tabOptions =
        `<option value="new">New tab (new table)</option>` +
        openTabsForPick.map((t) => `<option value="${t.id}"${String(tabChoice) === String(t.id) ? " selected" : ""}>Table ${esc(t.table_number)}${t.customer_name ? ` · ${esc(t.customer_name)}` : ""} - ${money(t.total)}</option>`).join("");

      const total = cartTotal();
      const dine = orderType === "dine_in";
      const targetTab = dine && tabChoice !== "new" ? tabs.find((t) => String(t.id) === String(tabChoice)) : null;

      const typeFields = dine
        ? `
        <div class="wi-field"><label for="wiTabPick">Table / tab</label>
          <select id="wiTabPick">${tabOptions}</select></div>
        ${
          targetTab
            ? `<p class="admin-hint" style="margin:0">Adds a new round to Table ${esc(targetTab.table_number)}'s bill. It goes to the kitchen straight away.</p>`
            : `<div class="wi-field"><label for="wiTable">Table number</label><input type="text" id="wiTable" maxlength="30" value="${esc(form.table)}" placeholder="e.g. 5" autocomplete="off"></div>`
        }`
        : `
        <div class="wi-field"><label for="wiGuest">Guest name <small>(optional)</small></label><input type="text" id="wiGuest" maxlength="100" value="${esc(form.guest)}" autocomplete="off"></div>`;

      paneNew.innerHTML = `
        <div class="wi-layout">
          <div class="wi-menu">
            <input type="search" id="wiSearch" class="po-search" placeholder="Search dishes&hellip;" value="${esc(query)}" autocomplete="off">
            <div class="po-chips">${chips}</div>
            <div class="admin-menu-grid">${grid}</div>
          </div>
          <div class="wi-side">
            <div class="admin-cart-panel">
              <div class="admin-cart-header"><h3>Order <span class="admin-badge">${cartCount()}</span></h3></div>
              <div class="wi-cart-list">${cartRows}</div>
              <div class="admin-cart-total wi-total">Total <strong>${money(total)}</strong></div>
            </div>
            <div class="admin-form-card wi-form">
              <div class="wi-type">
                <button type="button" class="wi-type-btn${dine ? "" : " active"}" data-wi-type="takeaway"><strong>Takeaway</strong><small>Guest pays by card now</small></button>
                <button type="button" class="wi-type-btn${dine ? " active" : ""}" data-wi-type="dine_in"><strong>Dine-in</strong><small>Open tab, pay at the end</small></button>
              </div>
              ${typeFields}
              <div class="wi-field"><label for="wiNotes">Notes for the kitchen <small>(optional)</small></label><input type="text" id="wiNotes" maxlength="500" value="${esc(form.notes)}" placeholder="e.g. no onions" autocomplete="off"></div>
              <button type="button" class="btn btn-primary btn-block wi-go" data-wi-go ${!cart.length || busy ? "disabled" : ""}>
                ${busy ? "Please wait&hellip;" : dine ? `Send to kitchen &middot; ${money(total)}` : `Take card payment &middot; ${money(total)}`}
              </button>
              ${cart.length ? '<button type="button" class="admin-link-btn wi-clear" data-wi-clear>Clear order</button>' : ""}
            </div>
          </div>
        </div>`;

      if (cart.length) {
        paneNew.insertAdjacentHTML(
          "beforeend",
          `<button type="button" class="wi-mobile-bar" data-wi-jump><span><i class="fas fa-basket-shopping"></i> ${cartCount()} item${cartCount() === 1 ? "" : "s"}</span><span>${money(total)} &middot; Review &amp; pay</span></button>`,
        );
      }
      if (keepSearch) {
        const s = paneNew.querySelector("#wiSearch");
        s.focus();
        s.setSelectionRange(s.value.length, s.value.length);
      }
      bindNew();
    }

    function readFields() {
      const v = (id) => paneNew.querySelector(id)?.value ?? null;
      const t = v("#wiTable"), g = v("#wiGuest"), n = v("#wiNotes");
      if (t !== null) form.table = t;
      if (g !== null) form.guest = g;
      if (n !== null) form.notes = n;
    }

    function bindNew() {
      paneNew.querySelector("#wiSearch")?.addEventListener("input", (e) => {
        readFields();
        query = e.target.value;
        renderNew();
      });
      paneNew.querySelectorAll("[data-wi-cat]").forEach((b) => b.addEventListener("click", () => { readFields(); category = b.dataset.wiCat; renderNew(); }));
      paneNew.querySelector("[data-wi-retry]")?.addEventListener("click", async () => { await loadMenu(); renderNew(); });
      paneNew.querySelectorAll("[data-wi-add]").forEach((b) =>
        b.addEventListener("click", () => {
          readFields();
          const item = menu.find((m) => m.id === parseInt(b.dataset.wiAdd, 10));
          if (!item || item.is_available === false) return;
          if (needsOptions(item)) openOptions(item);
          else addLine(item, { spice: null, side: null, extras: [], qty: 1 });
        }),
      );
      paneNew.querySelectorAll("[data-wi-qty]").forEach((b) =>
        b.addEventListener("click", () => {
          readFields();
          const line = cart.find((l) => l.lineId === b.dataset.wiQty);
          if (!line) return;
          line.qty += Number(b.dataset.d);
          if (line.qty <= 0) cart = cart.filter((l) => l !== line);
          renderNew();
        }),
      );
      paneNew.querySelectorAll("[data-wi-type]").forEach((b) =>
        b.addEventListener("click", () => { readFields(); orderType = b.dataset.wiType; renderNew(); }),
      );
      paneNew.querySelector("#wiTabPick")?.addEventListener("change", (e) => { readFields(); tabChoice = e.target.value; renderNew(); });
      paneNew.querySelector("[data-wi-clear]")?.addEventListener("click", () => {
        if (confirm("Clear this order?")) { cart = []; renderNew(); }
      });
      paneNew.querySelector("[data-wi-go]")?.addEventListener("click", () => { readFields(); submitOrder(); });
      paneNew.querySelector("[data-wi-jump]")?.addEventListener("click", () => paneNew.querySelector(".wi-side")?.scrollIntoView({ behavior: "smooth", block: "start" }));
    }

    function payload() {
      return cart.map((l) => ({
        id: l.itemId,
        quantity: l.qty,
        spice_level: l.spice,
        side: l.side ? l.side.id : undefined,
        extras: l.extras.map((e) => e.id),
      }));
    }

    async function submitOrder() {
      if (busy || !cart.length) return;
      const dine = orderType === "dine_in";
      const total = cartTotal();
      const body = {
        action: "order",
        type: orderType,
        items: payload(),
        customer_name: dine ? "" : form.guest.trim(),
        special_instructions: form.notes.trim(),
      };
      if (dine) {
        if (tabChoice !== "new") body.tab_id = Number(tabChoice);
        else {
          if (!form.table.trim()) return toast("Enter the table number first.", true);
          body.table_number = form.table.trim();
        }
      } else {
        const paid = await confirmCard({ title: "Take card payment", amount: total });
        if (!paid) return;
        body.card_paid = true;
      }
      const receiptLines = cart.map((l) => ({
        qty: l.qty,
        name: l.name,
        detail: [l.spice, l.side ? l.side.name : "", ...l.extras.map((e) => e.name)].filter(Boolean).join(" · "),
        amount: (l.unit + l.extras.reduce((x, e) => x + e.price, 0)) * l.qty,
      }));
      busy = true;
      renderNew();
      try {
        const data = await post(body);
        toast(dine ? `Sent to the kitchen · order #${data.order_id}${data.new_tab ? " · new tab opened" : ""}` : `Paid by card · order #${data.order_id} is with the kitchen`);
        cart = [];
        form.notes = "";
        if (dine) {
          tabChoice = data.tab_id; // next round for this table goes onto the same tab
          form.table = "";
        } else {
          showReceipt({ heading: "Receipt", reference: `Order #${data.order_id}`, guest: form.guest.trim(), lines: receiptLines, total: data.total_amount, paid: true });
          form.guest = "";
        }
        await loadTabs();
      } catch (err) {
        if (err.data && err.data.existing_tab_id) {
          await loadTabs();
          tabChoice = err.data.existing_tab_id;
        }
        toast(err.message, true);
      } finally {
        busy = false;
        renderNew();
      }
    }

    // ---------------------------------------------------------------- modals
    function modal(html) {
      const overlay = document.createElement("div");
      overlay.className = "wi-overlay";
      overlay.innerHTML = `<div class="wi-modal">${html}</div>`;
      document.body.appendChild(overlay);
      const close = () => overlay.remove();
      overlay.addEventListener("click", (e) => { if (e.target === overlay) close(); });
      return { overlay, close, q: (s) => overlay.querySelector(s) };
    }

    /** "Has the guest paid by card?" - the money is taken on the card machine, here staff only confirm it. */
    function confirmCard({ title, amount }) {
      return new Promise((resolve) => {
        const m = modal(`
          <h3>${esc(title)}</h3>
          <p class="wi-modal-amount">${money(amount)}</p>
          <p class="admin-hint">Take this amount on the card machine. Only tap the green button once the card payment went through.</p>
          <div class="wi-modal-actions">
            <button type="button" class="btn btn-secondary" data-no>Not yet</button>
            <button type="button" class="btn btn-primary wi-paid-btn" data-yes><i class="fas fa-credit-card"></i> Card payment successful</button>
          </div>`);
        m.q("[data-no]").addEventListener("click", () => { m.close(); resolve(false); });
        m.overlay.addEventListener("click", (e) => { if (e.target === m.overlay) resolve(false); });
        m.q("[data-yes]").addEventListener("click", () => { m.close(); resolve(true); });
      });
    }

    /** A receipt (or, before payment, the bill) that can be shown to the guest or printed. */
    function showReceipt({ heading, reference, guest, lines, total, paid }) {
      const now = new Date().toLocaleString("en-ZA", { dateStyle: "medium", timeStyle: "short" });
      const m = modal(`
        <div class="wi-receipt">
          <div class="wi-receipt-brand">Fulude's Cafe</div>
          <div class="wi-receipt-sub">${esc(heading)}</div>
          <div class="wi-receipt-meta">
            <span>${esc(reference)}</span><span>${esc(now)}</span>
            ${guest ? `<span>${esc(guest)}</span>` : ""}
          </div>
          <div class="wi-receipt-lines">
            ${lines
              .map(
                (l) => `<div class="wi-receipt-line"><span>${l.qty}× ${esc(l.name)}${l.detail ? `<small>${esc(l.detail)}</small>` : ""}</span><span>${money(l.amount)}</span></div>`,
              )
              .join("")}
          </div>
          <div class="wi-receipt-total"><span>Total</span><span>${money(total)}</span></div>
          <div class="wi-receipt-paid">${paid ? "PAID BY CARD" : "NOT PAID YET"}</div>
          <div class="wi-receipt-thanks">Thank you for visiting Fulude's Cafe!</div>
        </div>
        <div class="wi-modal-actions wi-receipt-actions">
          <button type="button" class="btn btn-secondary" data-print><i class="fas fa-print"></i> Print</button>
          <button type="button" class="btn btn-primary" data-done>Done</button>
        </div>`);
      m.q("[data-print]").addEventListener("click", () => window.print());
      m.q("[data-done]").addEventListener("click", m.close);
    }

    function openOptions(item) {
      const hasSpice = item.accepts_spice && spiceLevels.length > 0;
      const hasSides = (item.sides || []).length > 0;
      const addons = item.accepts_addons ? item.addons || [] : [];
      const m = modal(`
        <h3>${esc(item.name)}</h3>
        ${hasSpice ? '<div class="po-opt-group"><label data-spice-label>Spice level</label><div data-spice></div></div>' : ""}
        ${hasSides ? '<div class="po-opt-group"><label data-side-label>Choose a side <small>(free)</small></label><div data-side></div><p class="form-error" data-side-error style="display:none">Please choose a side.</p></div>' : ""}
        ${addons.length ? `<div class="po-opt-group"><label>Extras</label>${addons.map((a) => `<label class="checkbox-option"><input type="checkbox" value="${a.id}" data-name="${esc(a.name)}" data-price="${a.price}"> ${esc(a.name)} (+R${Number(a.price).toFixed(2)})</label>`).join("")}</div>` : ""}
        <div class="po-opt-group"><label>Quantity</label>
          <span class="admin-cart-item-qty"><button type="button" class="admin-mini-btn" data-minus>&minus;</button><span data-qty>1</span><button type="button" class="admin-mini-btn" data-plus>+</button></span></div>
        <div class="wi-modal-actions"><button type="button" class="btn btn-secondary" data-cancel>Cancel</button><button type="button" class="btn btn-primary" data-confirm>Add to order</button></div>`);
      const qtyEl = m.q("[data-qty]");
      const spiceChoices = [];
      const sideChoices = [];
      const rows = (qty, pills) =>
        Array.from({ length: qty }, (_, i) => `<div class="po-side-row">${qty > 1 ? `<span class="po-side-label">Meal ${i + 1}</span>` : ""}<div class="po-pills">${pills(i)}</div></div>`).join("");

      const renderChoices = () => {
        const qty = parseInt(qtyEl.textContent, 10) || 1;
        if (hasSpice) {
          spiceChoices.length = Math.min(spiceChoices.length, qty);
          for (let i = 0; i < qty; i++) if (!spiceChoices[i]) spiceChoices[i] = spiceLevels[0].name;
          m.q("[data-spice-label]").textContent = qty > 1 ? "Spice level for each meal" : "Spice level";
          m.q("[data-spice]").innerHTML = rows(qty, (i) =>
            spiceLevels.map((sp) => `<button type="button" class="po-pill${spiceChoices[i] === sp.name ? " selected" : ""}" data-meal="${i}" data-name="${esc(sp.name)}">${esc(sp.name)}</button>`).join(""));
          m.q("[data-spice]").querySelectorAll(".po-pill").forEach((b) => b.addEventListener("click", () => {
            spiceChoices[Number(b.dataset.meal)] = b.dataset.name;
            b.parentElement.querySelectorAll(".po-pill").forEach((x) => x.classList.toggle("selected", x === b));
          }));
        }
        if (hasSides) {
          sideChoices.length = Math.min(sideChoices.length, qty);
          m.q("[data-side-label]").innerHTML = qty > 1 ? "Choose a side for each meal <small>(free)</small>" : "Choose a side <small>(free)</small>";
          m.q("[data-side]").innerHTML = rows(qty, (i) =>
            item.sides.map((sd) => `<button type="button" class="po-pill${sideChoices[i]?.id === sd.id ? " selected" : ""}" data-meal="${i}" data-id="${sd.id}" data-name="${esc(sd.name)}">${esc(sd.name)}</button>`).join(""));
          m.q("[data-side]").querySelectorAll(".po-pill").forEach((b) => b.addEventListener("click", () => {
            sideChoices[Number(b.dataset.meal)] = { id: parseInt(b.dataset.id, 10), name: b.dataset.name };
            b.parentElement.querySelectorAll(".po-pill").forEach((x) => x.classList.toggle("selected", x === b));
          }));
        }
      };
      renderChoices();
      m.q("[data-minus]").addEventListener("click", () => { qtyEl.textContent = Math.max(1, (parseInt(qtyEl.textContent, 10) || 1) - 1); renderChoices(); });
      m.q("[data-plus]").addEventListener("click", () => { qtyEl.textContent = (parseInt(qtyEl.textContent, 10) || 1) + 1; renderChoices(); });
      m.q("[data-cancel]").addEventListener("click", m.close);
      m.q("[data-confirm]").addEventListener("click", () => {
        const qty = parseInt(qtyEl.textContent, 10) || 1;
        if (hasSides && sideChoices.filter(Boolean).length < qty) {
          const err = m.q("[data-side-error]");
          err.textContent = qty > 1 ? "Please choose a side for every meal." : "Please choose a side.";
          err.style.display = "block";
          return;
        }
        const extras = [...m.overlay.querySelectorAll('input[type="checkbox"]:checked')].map((c) => ({ id: parseInt(c.value, 10), name: c.dataset.name, price: parseFloat(c.dataset.price) }));
        // meals with the same spice level and side share one line
        const groups = [];
        for (let i = 0; i < qty; i++) {
          const spice = hasSpice ? spiceChoices[i] || null : null;
          const side = hasSides ? sideChoices[i] : null;
          const g = groups.find((x) => x.spice === spice && (x.side ? x.side.id : null) === (side ? side.id : null));
          if (g) g.qty += 1; else groups.push({ spice, side, qty: 1 });
        }
        m.close();
        groups.forEach((g) => addLine(item, { spice: g.spice, side: g.side, extras, qty: g.qty }));
      });
    }

    // ---------------------------------------------------------------- "Open tabs" pane
    async function loadTabs() {
      try {
        const res = await doFetch(api);
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || "Couldn't load the open tabs.");
        tabs = data.tabs || [];
        if (tabChoice !== "new" && !tabs.some((t) => String(t.id) === String(tabChoice))) tabChoice = "new";
        $("[data-wi-count]").textContent = tabs.length;
        if (opts.onTabsChanged) opts.onTabsChanged(tabs);
        renderTabs();
        // The "new order" pane only needs a redraw when the tab list changed - and never while someone is typing in it.
        const key = JSON.stringify(tabs.map((t) => [t.id, t.total, t.table_number]));
        const typing = paneNew.contains(document.activeElement) && /^(INPUT|SELECT|TEXTAREA)$/.test(document.activeElement.tagName);
        if (view === "new" && !busy && !modalOpen() && key !== lastTabsKey && !typing) renderNew();
        lastTabsKey = key;
      } catch (err) {
        if (view === "tabs") paneTabs.innerHTML = `<p class="menu-empty">${esc(err.message)}</p>`;
      }
    }
    const modalOpen = () => !!document.querySelector(".wi-overlay");

    const ROUND_STATUS = { New: "Waiting", Preparing: "Cooking", Ready: "Ready", Collection: "Ready to serve", Delivery: "Ready to serve", Completed: "Served", Cancelled: "Cancelled" };

    function itemLine(it) {
      const extras = Array.isArray(it.extras) ? it.extras : JSON.parse(it.extras || "[]");
      const bits = [it.spice_level, ...extras.map((e) => String(e.name).replace(/^Side: /, ""))].filter(Boolean);
      return `${it.quantity}× ${esc(it.item_name)}${bits.length ? ` <small>(${esc(bits.join(" · "))})</small>` : ""}`;
    }

    function renderTabs() {
      if (!tabs.length) {
        paneTabs.innerHTML = '<p class="menu-empty">No open tabs. A dine-in order opens a tab for its table.</p>';
        return;
      }
      paneTabs.innerHTML = `<div class="wi-tab-grid">${tabs
        .map((t) => {
          const open = openBills.has(t.id);
          const canRemove = (round) => round.status !== "Cancelled" && (isAdmin || round.status === "New");
          const bill = open
            ? `<div class="wi-bill">${t.rounds
                .map(
                  (r) => `
              <div class="wi-round${r.status === "Cancelled" ? " wi-round-cancelled" : ""}">
                <div class="wi-round-head"><strong>Round ${r.round}</strong><span class="wi-chip">${esc(ROUND_STATUS[r.status] || r.status)}</span><small>${timeOf(r.created_at)}</small></div>
                ${r.items
                  .map(
                    (it) => `<div class="wi-bill-line"><span>${itemLine(it)}</span><span>${money(it.subtotal)}</span>${
                      canRemove(r) ? `<button type="button" class="admin-mini-btn danger" title="Remove from the bill" data-wi-remove data-order="${r.id}" data-item="${it.id}" data-name="${esc(it.item_name)}">&times;</button>` : ""
                    }</div>`,
                  )
                  .join("") || '<div class="wi-bill-line"><span><small>Nothing left on this round</small></span></div>'}
                ${r.special_instructions ? `<div class="wi-note">${esc(r.special_instructions)}</div>` : ""}
              </div>`,
                )
                .join("")}</div>`
            : "";
          return `
          <div class="wi-tab-card" data-tab="${t.id}">
            <div class="wi-tab-head">
              <div><strong class="wi-tab-title">Table ${esc(t.table_number)}</strong>
                <small class="wi-tab-meta">Open ${ago(t.opened_at)} &middot; ${t.rounds.filter((r) => r.status !== "Cancelled").length} round${t.rounds.filter((r) => r.status !== "Cancelled").length === 1 ? "" : "s"}${t.opened_by ? ` &middot; ${esc(t.opened_by)}` : ""}</small></div>
              <strong class="wi-tab-total">${money(t.total)}</strong>
            </div>
            ${bill}
            <div class="wi-tab-actions">
              <button type="button" class="btn btn-secondary admin-mini-btn" data-wi-addto="${t.id}"><i class="fas fa-plus"></i> Add items</button>
              <button type="button" class="btn btn-secondary admin-mini-btn" data-wi-bill="${t.id}">${open ? "Hide bill" : "View bill"}</button>
              <button type="button" class="btn btn-secondary admin-mini-btn" data-wi-printbill="${t.id}"><i class="fas fa-print"></i> Print bill</button>
              <button type="button" class="btn btn-primary admin-mini-btn wi-paid-btn" data-wi-close="${t.id}"><i class="fas fa-credit-card"></i> Close bill &middot; card</button>
              ${isAdmin ? `<button type="button" class="admin-mini-btn danger" data-wi-writeoff="${t.id}">Write off</button>` : ""}
            </div>
          </div>`;
        })
        .join("")}</div>`;

      paneTabs.querySelectorAll("[data-wi-bill]").forEach((b) => b.addEventListener("click", () => {
        const id = Number(b.dataset.wiBill);
        openBills.has(id) ? openBills.delete(id) : openBills.add(id);
        renderTabs();
      }));
      paneTabs.querySelectorAll("[data-wi-addto]").forEach((b) => b.addEventListener("click", () => {
        orderType = "dine_in";
        tabChoice = Number(b.dataset.wiAddto);
        setView("new");
        renderNew();
      }));
      paneTabs.querySelectorAll("[data-wi-printbill]").forEach((b) => b.addEventListener("click", () => {
        const tab = tabs.find((t) => t.id === Number(b.dataset.wiPrintbill));
        if (!tab) return;
        const lines = billLines(tab);
        if (!lines.length) return toast("Nothing on this bill yet.", true);
        showReceipt({ heading: "Bill", reference: `Table ${tab.table_number}`, guest: "", lines, total: tab.total, paid: false });
      }));
      paneTabs.querySelectorAll("[data-wi-close]").forEach((b) => b.addEventListener("click", () => closeBill(Number(b.dataset.wiClose))));
      paneTabs.querySelectorAll("[data-wi-remove]").forEach((b) => b.addEventListener("click", () => removeItem(b.dataset.order, b.dataset.item, b.dataset.name)));
      paneTabs.querySelectorAll("[data-wi-writeoff]").forEach((b) => b.addEventListener("click", () => writeOff(Number(b.dataset.wiWriteoff))));
    }

    /** Every item still on the tab's bill (cancelled rounds are not on it). */
    function billLines(tab) {
      return tab.rounds
        .filter((r) => r.status !== "Cancelled")
        .flatMap((r) => r.items)
        .map((it) => {
          const extras = Array.isArray(it.extras) ? it.extras : JSON.parse(it.extras || "[]");
          return {
            qty: it.quantity,
            name: it.item_name,
            detail: [it.spice_level, ...extras.map((e) => String(e.name).replace(/^Side: /, ""))].filter(Boolean).join(" · "),
            amount: Number(it.subtotal),
          };
        });
    }

    async function closeBill(id) {
      const tab = tabs.find((t) => t.id === id);
      if (!tab) return;
      if (!tab.total) {
        if (!confirm(`Table ${tab.table_number} has nothing to pay. Close this tab?`)) return;
      }
      const paid = tab.total ? await confirmCard({ title: `Close bill · Table ${tab.table_number}`, amount: tab.total }) : true;
      if (!paid) return;
      const receiptLines = billLines(tab);
      try {
        const data = await post({ action: "close_tab", tab_id: id });
        openBills.delete(id);
        toast(`Table ${tab.table_number} paid by card · ${money(data.total_amount)}`);
        if (receiptLines.length) showReceipt({ heading: "Receipt", reference: `Table ${tab.table_number}`, guest: "", lines: receiptLines, total: data.total_amount, paid: true });
        await loadTabs();
      } catch (err) {
        toast(err.message, true);
        loadTabs();
      }
    }

    async function removeItem(orderId, itemId, name) {
      if (!confirm(`Remove "${name}" from the bill?`)) return;
      try {
        await post({ action: "remove_item", order_id: Number(orderId), item_id: Number(itemId) });
        toast(`${name} removed from the bill`);
      } catch (err) {
        toast(err.message, true);
      }
      loadTabs();
    }

    function writeOff(id) {
      const tab = tabs.find((t) => t.id === id);
      if (!tab) return;
      const m = modal(`
        <h3>Write off Table ${esc(tab.table_number)}</h3>
        <p class="admin-hint">Use this only when the guests left without paying. The ${money(tab.total)} will <strong>not</strong> count as sales, and this is recorded in the Audit log.</p>
        <div class="wi-field"><label for="wiWhy">Reason</label><input type="text" id="wiWhy" maxlength="300" placeholder="e.g. guests left without paying" autocomplete="off"></div>
        <div class="wi-modal-actions"><button type="button" class="btn btn-secondary" data-no>Cancel</button><button type="button" class="btn btn-primary" data-yes style="background:var(--sa-red)">Write off tab</button></div>`);
      m.q("[data-no]").addEventListener("click", m.close);
      m.q("[data-yes]").addEventListener("click", async () => {
        const reason = m.q("#wiWhy").value.trim();
        if (!reason) return m.q("#wiWhy").focus();
        try {
          await post({ action: "write_off", tab_id: id, reason });
          m.close();
          toast(`Table ${tab.table_number} written off`);
          loadTabs();
        } catch (err) {
          m.close();
          toast(err.message, true);
        }
      });
    }

    // ---------------------------------------------------------------- start
    renderNew();
    loadMenu().then(renderNew);
    loadTabs();
    pollTimer = setInterval(() => {
      if (root.offsetParent === null || modalOpen()) return; // hidden or a dialog is open
      loadTabs();
    }, 10000);

    return {
      refresh: () => { loadTabs(); loadMenu().then(() => { if (!busy && !modalOpen()) renderNew(); }); },
      destroy: () => clearInterval(pollTimer),
    };
  }

  window.FuludeWalkin = { mount };
})();
