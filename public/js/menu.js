// Menu-page logic: loads the live menu from /api/menu, renders category tabs + dish cards

// State
let categories = [];      // [{id, name, slug, sort_order}]
let menuItems = [];       // [{id, category_id, name, price, addons: [...], ...}]
let spiceLevels = [];     // [{id, name}]
let activeCategorySlug = "all";
let searchQuery = "";
let pendingCustomizeItem = null; // menu item currently open in the customize modal

// Delivery fee state
let deliveryFee = 0;
let deliveryDistanceKm = 0;
let geocodedDeliveryLat = null;
let geocodedDeliveryLng = null;
let geocodedDisplayAddress = "";
let deliveryFeeLoading = false;

// Cart lives in localStorage between pages. Prices here are only for display;
// the server re-prices every line at checkout.
const CART_KEY = "fulude_cart";
let cart = []; // [{lineId, itemId, name, price, quantity, spiceLevel
try {
  cart = JSON.parse(localStorage.getItem(CART_KEY) || "[]");
} catch {
  cart = [];
}
if (!Array.isArray(cart)) cart = [];

function saveCart() {
  try {
    localStorage.setItem(CART_KEY, JSON.stringify(cart));
  } catch {
    /* storage full/blocked - cart still works for this page view */
  }
  // This change came FROM the account (adoptServerCart) - nothing to send back.
  if (suppressCartPush) {
    suppressCartPush = false;
    return;
  }
  // Signed in: the account's copy follows every change (a moment later, so
  // tapping + a few times is one save, not several).
  if (currentCustomer && customerToken) {
    try {
      localStorage.setItem(CART_DIRTY_KEY, "1");
    } catch {
      /* not critical */
    }
    scheduleCartPush();
  }
}

// Cart on the customer's account
const CART_SYNC_KEY = "fulude_cart_sync"; // { customerId, version } of the last synced cart
const CART_DIRTY_KEY = "fulude_cart_dirty"; // "1" while local changes are not yet saved to the account
let cartSyncReady = false; // the account's cart has been loaded on this page
let cartSyncCustomerId = null;
let cartSyncPromise = null;
let cartVersion = 0; // version of the account cart this page last saw
let cartPushTimer = null;
let cartPushInFlight = false;
let cartPushQueued = false;
let suppressCartPush = false;

function cartToCompact() {
  return cart.map((l) => ({
    itemId: l.itemId,
    quantity: l.quantity,
    spiceLevel: l.spiceLevel || null,
    sideId: l.side ? l.side.id : null,
    extraIds: (l.extras || []).map((e) => e.id)
  }));
}

function cartIsDirty() {
  try {
    return localStorage.getItem(CART_DIRTY_KEY) === "1";
  } catch {
    return false;
  }
}

function setCartDirty(on) {
  try {
    if (on) localStorage.setItem(CART_DIRTY_KEY, "1");
    else localStorage.removeItem(CART_DIRTY_KEY);
  } catch {
    /* not critical */
  }
}

function readCartLink() {
  try {
    return JSON.parse(localStorage.getItem(CART_SYNC_KEY) || "null");
  } catch {
    return null;
  }
}

function writeCartLink(customerId, version) {
  try {
    localStorage.setItem(CART_SYNC_KEY, JSON.stringify({ customerId, version }));
  } catch {
    /* not critical */
  }
}

function cartRequest(method, items) {
  // keepalive: a DELETE sent just before the browser leaves for the payment page still goes through.
  const options = { method, headers: { Authorization: `Bearer ${customerToken}` }, cache: "no-store", keepalive: method === "DELETE" };
  if (items) {
    options.headers["Content-Type"] = "application/json";
    options.body = JSON.stringify({ items });
  }
  return fetch("/api/cart", options);
}

/** Shows the account's cart on this page (no save back - it came from there). */
function adoptServerCart(data) {
  cart = Array.isArray(data.items) ? data.items : [];
  cartVersion = Number(data.version) || 0;
  if (currentCustomer) writeCartLink(currentCustomer.id, cartVersion);
  suppressCartPush = true;
  renderCart();
  suppressCartPush = false;
  if (Array.isArray(data.notices) && data.notices.length) {
    const more = data.notices.length > 1 ? ` (+${data.notices.length - 1} more change${data.notices.length > 2 ? "s" : ""})` : "";
    showCartToast(data.notices[0] + more, "info");
  }
}

// Makes sure this device is linked to the signed-in customer's cart
function ensureCartLinked() {
  if (!currentCustomer || !customerToken) return Promise.resolve(false);
  if (cartSyncReady && cartSyncCustomerId === currentCustomer.id) return Promise.resolve(true);
  if (!cartSyncPromise) {
    cartSyncPromise = linkCart().finally(() => {
      cartSyncPromise = null;
    });
  }
  return cartSyncPromise;
}

async function linkCart() {
  const customerId = currentCustomer.id;
  try {
    const link = readCartLink();
    const linked = link && link.customerId === customerId;
    const before = JSON.stringify(cartToCompact());
    let res;
    if (linked && cartIsDirty()) res = await cartRequest("PUT", cartToCompact()); // changes made offline / before leaving
    else if (linked) res = await cartRequest("GET");
    else res = await cartRequest("POST", cartToCompact()); // first meeting: merge
    if (!res.ok) return false; // not signed in any more, or the server is down
    const data = await res.json();
    if (!currentCustomer || currentCustomer.id !== customerId) return false; // signed out meanwhile

    cartSyncReady = true;
    cartSyncCustomerId = customerId;
    setCartDirty(false);
    adoptServerCart(data);
    if (!linked && before !== JSON.stringify(cartToCompact())) {
      showCartToast(before === "[]" ? "Your saved cart is here" : "We combined your saved cart with the items on this device", "info");
    }
    return true;
  } catch {
    return false; // offline - the local cart keeps working
  }
}

function scheduleCartPush() {
  clearTimeout(cartPushTimer);
  cartPushTimer = setTimeout(() => {
    cartPushTimer = null;
    pushCart();
  }, 600);
}

async function pushCart() {
  if (!cartSyncReady || !currentCustomer || !customerToken) return;
  if (cartPushInFlight) {
    cartPushQueued = true;
    return;
  }
  cartPushInFlight = true;
  try {
    const sent = JSON.stringify(cartToCompact());
    const res = await cartRequest("PUT", cartToCompact());
    if (res.ok) {
      const data = await res.json();
      cartVersion = Number(data.version) || 0;
      writeCartLink(currentCustomer.id, cartVersion);
      const unchangedSince = JSON.stringify(cartToCompact()) === sent;
      if (unchangedSince) {
        setCartDirty(false);
        // The server removed something that can't be ordered any more: show the real cart.
        if (data.notices && data.notices.length) adoptServerCart(data);
      } else {
        cartPushQueued = true; // edited again while saving - save once more
      }
    }
  } catch {
    /* offline: stays marked unsaved, retried on the next change or page open */
  } finally {
    cartPushInFlight = false;
    if (cartPushQueued) {
      cartPushQueued = false;
      scheduleCartPush();
    }
  }
}

// The order was placed (or the customer is paying an existing one)
function clearCartAfterOrder() {
  cart = [];
  clearTimeout(cartPushTimer);
  cartPushTimer = null;
  suppressCartPush = true;
  saveCart();
  suppressCartPush = false;
  setCartDirty(false);
  if (currentCustomer && customerToken) cartRequest("DELETE").catch(() => {});
}

/** Saves any pending change right now (called before signing out). */
async function flushCartSync() {
  if (cartPushTimer) {
    clearTimeout(cartPushTimer);
    cartPushTimer = null;
  }
  if (cartSyncReady && cartIsDirty()) await pushCart();
}

/** Picks up changes made on the customer's other device. */
async function pullCart() {
  if (!cartSyncReady || !currentCustomer || !customerToken) return;
  if (cartPushInFlight || cartPushTimer || cartIsDirty()) return; // never replace edits that haven't been saved
  try {
    const res = await cartRequest("GET");
    if (!res.ok) return;
    const data = await res.json();
    if (cartPushInFlight || cartPushTimer || cartIsDirty()) return; // edited while we were asking
    if (Number(data.version) !== cartVersion) {
      const changedHere = JSON.stringify(data.items.map((l) => [l.lineId, l.quantity])) !== JSON.stringify(cart.map((l) => [l.lineId, l.quantity]));
      adoptServerCart(data);
      if (changedHere) showCartToast("Your cart was updated from your other device", "info");
    }
  } catch {
    /* offline - try again later */
  }
}

// Link the cart when sign-in state becomes known or changes (site.js fires this).
window.addEventListener("fulude:auth-changed", () => {
  if (currentCustomer) {
    ensureCartLinked();
  } else {
    cartSyncReady = false;
    cartSyncCustomerId = null;
    cartVersion = 0;
  }
});
setInterval(() => {
  if (!document.hidden) pullCart();
}, 30000);
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) pullCart();
});
window.addEventListener("focus", pullCart);

// Load menu from the server
let lastMenuSignature = "";

async function loadMenu(silent = false) {
  const grid = document.getElementById("orderItems");
  try {
    const res = await fetch("/api/menu", { cache: "no-store" });
    if (!res.ok) throw new Error("Menu request failed");
    const data = await res.json();
    const signature = JSON.stringify([data.categories, data.items, data.spice_levels]);
    const menuChanged = signature !== lastMenuSignature;
    lastMenuSignature = signature;

    categories = data.categories || [];
    menuItems = data.items || [];
    spiceLevels = data.spice_levels || [];

    // Re-price anything already in the cart against the live menu, so a special that ended
    const pricesChanged = repriceCart();

    if (menuChanged || !silent) {
      renderCategoryTabs();
      renderOrderItems();
      renderSpecialsBar();
    }
    if (pricesChanged) {
      renderCart();
      showCartToast("Prices in your cart were updated", "info");
    }
  } catch (err) {
    if (!silent) {
      grid.innerHTML = `<p class="menu-empty">Sorry, we couldn't load the menu right now. Please refresh.</p>`;
    }
  }
}

// Syncs every cart line's price with the item's current effective price
function repriceCart() {
  let changed = false;
  for (const line of cart) {
    const item = menuItems.find((i) => i.id === line.itemId);
    if (!item) continue;
    const current = item.effective_price !== undefined && item.effective_price !== null ? item.effective_price : item.price;
    if (Number(line.price) !== Number(current)) {
      line.price = current;
      changed = true;
    }
  }
  return changed;
}

// Keep prices fresh while the page is open: poll every 30s, and refresh
// when the customer returns to the tab.
setInterval(() => {
  if (!document.hidden) loadMenu(true);
}, 30000);
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) loadMenu(true);
});

// Quick pop-up message (e.g
function showCartToast(message, kind = "success") {
  let stack = document.getElementById("cartToastStack");
  if (!stack) {
    const style = document.createElement("style");
    style.textContent = `
      #cartToastStack{position:fixed;left:50%;bottom:24px;transform:translateX(-50%);z-index:100000;display:flex;flex-direction:column;gap:8px;align-items:center;pointer-events:none;width:calc(100% - 32px);max-width:360px}
      .cart-toast{background:#2b2b2b;color:#fff;padding:12px 18px;border-radius:10px;font-size:.95rem;box-shadow:0 6px 20px rgba(0,0,0,.25);opacity:0;transform:translateY(12px);transition:opacity .25s ease,transform .25s ease;display:flex;align-items:center;gap:8px}
      .cart-toast.show{opacity:1;transform:translateY(0)}
      .cart-toast .cart-toast-icon{color:#4caf50;font-weight:700}
      .cart-toast.info .cart-toast-icon{color:#ffb300}
    `;
    document.head.appendChild(style);
    stack = document.createElement("div");
    stack.id = "cartToastStack";
    stack.setAttribute("role", "status");
    stack.setAttribute("aria-live", "polite");
    document.body.appendChild(stack);
  }
  const el = document.createElement("div");
  el.className = `cart-toast ${kind}`;
  const icon = document.createElement("span");
  icon.className = "cart-toast-icon";
  icon.textContent = kind === "info" ? "ℹ" : "✓";
  const text = document.createElement("span");
  text.textContent = message;
  el.appendChild(icon);
  el.appendChild(text);
  stack.appendChild(el);
  requestAnimationFrame(() => el.classList.add("show"));
  setTimeout(() => {
    el.classList.remove("show");
    setTimeout(() => el.remove(), 300);
  }, 1800);
}

function renderCategoryTabs() {
  const tabsContainer = document.getElementById("categoryTabs");
  const tabs = [{ id: 0, name: "All", slug: "all" }, ...categories];

  // Categories only come back from the API while they have at least one visible dish
  if (!tabs.some((t) => t.slug === activeCategorySlug)) {
    activeCategorySlug = "all";
  }

  tabsContainer.innerHTML = tabs
    .map(
      (cat) => `<button class="tab-btn${cat.slug === activeCategorySlug ? " active" : ""}" data-slug="${cat.slug}">${cat.name}</button>`
    )
    .join("");

  tabsContainer.querySelectorAll(".tab-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      activeCategorySlug = btn.dataset.slug;
      tabsContainer.querySelectorAll(".tab-btn").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");

      // Picking a category is a fresh start - clear any active search so
      // the two browsing modes don't fight each other.
      searchQuery = "";
      document.getElementById("menuSearchInput").value = "";
      document.getElementById("menuSearchClear").style.display = "none";

      renderOrderItems();
    });
  });
}

/** Category names that mean drinks (keep in sync with admin.js). */
const DRINK_CATEGORY_RE = /drink|beverage|juice|soda|cocktail|alcohol|liquor|wine|beer|smoothie|shake|coffee|\btea\b/i;

/** A drinks category: named like one, or holding items the admin gave a drink type. */
function isDrinksCategory(cat) {
  if (!cat) return false;
  return DRINK_CATEGORY_RE.test(`${cat.slug} ${cat.name}`) || menuItems.some((i) => i.category_id === cat.id && i.drink_type);
}

/** Drinks never show a photo area anywhere on the customer menu. */
function isDrinkItem(item) {
  return Boolean(item.drink_type) || isDrinksCategory(categories.find((c) => c.id === item.category_id));
}

const DRINK_GROUPS = [
  ["beverage", "Beverages"],
  ["cocktail", "Cocktails"],
  ["alcohol", "Alcohol"],
  ["other", "Others"],
];

/** Drinks tab: a plain price list (no photos) grouped Beverages -> Cocktails -> Alcohol -> Others. */
function drinksListHtml(items) {
  const byType = {};
  for (const item of items) {
    const type = DRINK_GROUPS.some(([key]) => key === item.drink_type) ? item.drink_type : "other";
    (byType[type] || (byType[type] = [])).push(item);
  }
  return `<div class="drinks-list">${DRINK_GROUPS.filter(([key]) => byType[key])
    .map(
      ([key, label]) => `
      <section class="drinks-group">
        <h4 class="drinks-group-title">${label}</h4>
        ${byType[key]
          .map((item) => {
            const priceHtml = item.is_on_special
              ? `<span class="was-price">${money(item.price)}</span>${money(item.effective_price)}`
              : money(item.price);
            return `
          <div class="drink-row${item.is_available ? "" : " sold-out"}" data-item="${item.id}">
            <div class="drink-row-info">
              <div class="order-card-header">
                <span class="order-card-name">${item.name}</span>
                <span class="order-card-dots" aria-hidden="true"></span>
                <span class="order-card-price">${priceHtml}</span>
              </div>
              ${item.description ? `<p class="order-card-desc">${item.description}</p>` : ""}
            </div>
            <div class="order-card-footer" data-id="${item.id}">${cardControlsHtml(item)}</div>
          </div>`;
          })
          .join("")}
      </section>`,
    )
    .join("")}</div>`;
}

function renderDrinksList(grid, items) {
  grid.innerHTML = drinksListHtml(items);
}

function renderOrderItems() {
  const grid = document.getElementById("orderItems");
  grid.classList.remove("is-drinks");

  let items;
  if (searchQuery.trim()) {
    // Search spans every category, ranked by relevance (best matches first).
    items = searchMenuItems(searchQuery, menuItems, categories);
    if (items.length === 0) {
      grid.innerHTML = `<p class="menu-empty">No items matched "${searchQuery}". Try a different word, or browse by category above.</p>`;
      return;
    }
    // Drinks have no photo, so they go after every dish as the same compact price list as the Drinks tab.
    const drinkResults = items.filter(isDrinkItem);
    if (drinkResults.length > 0) {
      const foodResults = items.filter((item) => !isDrinkItem(item));
      grid.innerHTML = renderFoodCards(foodResults) + `<div class="search-drinks">${drinksListHtml(drinkResults)}</div>`;
      return;
    }
  } else {
    const categoryBySlug = Object.fromEntries(categories.map((c) => [c.slug, c.id]));
    // Drinks only appear under their own tab, never mixed into "All".
    const drinkCategoryIds = new Set(categories.filter(isDrinksCategory).map((c) => c.id));
    items =
      activeCategorySlug === "all"
        ? menuItems.filter((item) => !drinkCategoryIds.has(item.category_id))
        : menuItems.filter((item) => item.category_id === categoryBySlug[activeCategorySlug]);

    if (items.length === 0) {
      grid.innerHTML = `<p class="menu-empty">No items in this category yet.</p>`;
      return;
    }
    if (drinkCategoryIds.has(categoryBySlug[activeCategorySlug])) {
      grid.classList.add("is-drinks");
      renderDrinksList(grid, items);
      return;
    }
  }

  grid.innerHTML = renderFoodCards(items);
}

function renderFoodCards(items) {
  return items
    .map((item) => {
      const photos = getPhotos(item);
      const onSpecial = item.is_on_special === true;
      const priceHtml = onSpecial
        ? `<span class="was-price">${money(item.price)}</span>${money(item.effective_price)}`
        : money(item.price);
      return `
    <div class="order-card${item.is_available ? "" : " sold-out"}" data-item="${item.id}">
      <div class="order-card-image${photos.length > 1 ? " has-slides" : ""}">
        ${
          photos.length > 0
            ? `<div class="slides-track" data-index="0">${photos
                .map(
                  (src, i) =>
                    `<img src="${src}" alt="${item.name}${photos.length > 1 ? ` (photo ${i + 1} of ${photos.length})` : ""}" ${i === 0 ? "" : 'loading="lazy"'} draggable="false" />`,
                )
                .join("")}</div>`
            : ""
        }
        ${onSpecial ? `<span class="special-badge">Special</span>` : ""}
        ${item.is_available ? "" : `<span class="sold-out-badge">Sold Out</span>`}
        ${
          photos.length > 1
            ? `<button type="button" class="slide-arrow slide-prev" aria-label="Previous photo">&#10094;</button>
               <button type="button" class="slide-arrow slide-next" aria-label="Next photo">&#10095;</button>
               <span class="slide-counter">1 / ${photos.length}</span>`
            : ""
        }
      </div>
      <div class="order-card-body">
        <div class="order-card-header">
          <span class="order-card-name">${item.name}</span>
          <span class="order-card-dots" aria-hidden="true"></span>
          <span class="order-card-price">${priceHtml}</span>
        </div>
        <p class="order-card-desc">${item.description || ""}</p>
        <div class="order-card-footer" data-id="${item.id}">${cardControlsHtml(item)}</div>
      </div>
    </div>
  `;
    })
    .join("");
}

function getPhotos(item) {
  return item.images && item.images.length > 0 ? item.images : item.image_url ? [item.image_url] : [];
}

// Per-dish quantity controls
function itemQuantityInCart(itemId) {
  return cart.filter((l) => l.itemId === itemId).reduce((sum, l) => sum + l.quantity, 0);
}
function cardControlsHtml(item) {
  if (!item.is_available) {
    return `<button class="add-to-order-btn" disabled>Sold Out</button>`;
  }
  const qty = itemQuantityInCart(item.id);
  if (qty === 0) {
    return `<button class="add-to-order-btn" data-action="add" data-id="${item.id}">Add to Order</button>`;
  }
  return `
    <div class="order-qty card-qty" role="group" aria-label="Quantity of ${item.name}">
      <button type="button" class="qty-btn" data-action="minus" data-id="${item.id}" aria-label="Remove one ${item.name}">&minus;</button>
      <span class="qty-value">${qty}</span>
      <button type="button" class="qty-btn" data-action="plus" data-id="${item.id}" aria-label="Add one ${item.name}">+</button>
    </div>`;
}

// Refreshes only the quantity controls on the visible cards
function syncCardControls() {
  document.querySelectorAll("#orderItems .order-card-footer[data-id]").forEach((footer) => {
    const item = menuItems.find((i) => i.id === parseInt(footer.dataset.id, 10));
    if (item) footer.innerHTML = cardControlsHtml(item);
  });
}

/** Removes one unit from the most recently added matching cart line. */
function decrementItem(itemId) {
  for (let i = cart.length - 1; i >= 0; i--) {
    if (cart[i].itemId === itemId) {
      changeLineQuantity(cart[i].lineId, -1);
      return;
    }
  }
}

// Photo slideshow inside each dish card - arrows + swipe
function slideTo(imageEl, index) {
  const track = imageEl.querySelector(".slides-track");
  if (!track) return;
  const count = track.children.length;
  const next = ((index % count) + count) % count;
  track.dataset.index = next;
  track.style.transform = `translateX(-${next * 100}%)`;
  const counter = imageEl.querySelector(".slide-counter");
  if (counter) counter.textContent = `${next + 1} / ${count}`;
}

(function wireMenuGrid() {
  const grid = document.getElementById("orderItems");

  grid.addEventListener("click", (e) => {
    const arrow = e.target.closest(".slide-arrow");
    if (arrow) {
      const imageEl = arrow.closest(".order-card-image");
      const idx = parseInt(imageEl.querySelector(".slides-track").dataset.index, 10) || 0;
      slideTo(imageEl, idx + (arrow.classList.contains("slide-next") ? 1 : -1));
      return;
    }
    const btn = e.target.closest("[data-action]");
    if (!btn || btn.disabled) return;
    const id = parseInt(btn.dataset.id, 10);
    if (btn.dataset.action === "minus") decrementItem(id);
    else handleAddClick(id); // "add" and "plus"
  });

  // Swipe left/right on the photo (touch screens)
  let startX = null;
  let startY = null;
  grid.addEventListener(
    "touchstart",
    (e) => {
      const img = e.target.closest(".order-card-image.has-slides");
      if (!img) return;
      startX = e.touches[0].clientX;
      startY = e.touches[0].clientY;
    },
    { passive: true },
  );
  grid.addEventListener(
    "touchend",
    (e) => {
      if (startX === null) return;
      const imageEl = e.target.closest(".order-card-image.has-slides");
      const dx = e.changedTouches[0].clientX - startX;
      const dy = e.changedTouches[0].clientY - startY;
      startX = startY = null;
      if (!imageEl || Math.abs(dx) < 40 || Math.abs(dx) < Math.abs(dy)) return;
      const idx = parseInt(imageEl.querySelector(".slides-track").dataset.index, 10) || 0;
      slideTo(imageEl, idx + (dx < 0 ? 1 : -1));
    },
    { passive: true },
  );
})();

// Specials - the red "Save on Meals" button + the modal
const specialsBtn = document.getElementById("specialsBtn");
const specialsModal = document.getElementById("specialsModal");
const specialsModalList = document.getElementById("specialsModalList");

function getActiveSpecials() {
  return menuItems.filter((item) => item.is_on_special === true && item.is_available);
}

function renderSpecialsBar() {
  const specials = getActiveSpecials();
  specialsBtn.style.display = specials.length > 0 ? "inline-flex" : "none";
}

function openSpecialsModal() {
  const specials = getActiveSpecials();
  if (specials.length === 0) {
    specialsModalList.innerHTML = `<p class="menu-empty">No items are on special right now.</p>`;
  } else {
    specialsModalList.innerHTML = specials
      .map((item) => {
        const savings = item.price - item.effective_price;
        const photos = item.images && item.images.length > 0 ? item.images : (item.image_url ? [item.image_url] : []);
        return `
      <div class="specials-item">
        ${isDrinkItem(item) ? "" : photos.length > 0 ? `<img src="${photos[0]}" alt="${item.name}" />` : `<div class="specials-item-noimg"></div>`}
        <div class="specials-item-info">
          <span class="specials-item-name">${item.name}</span>
          <div class="specials-item-prices">
            <span class="was-price">${money(item.price)}</span>
            <span class="special-price-value">${money(item.effective_price)}</span>
          </div>
          <span class="specials-save-box">Save ${money(savings)}</span>
        </div>
        <div class="specials-item-actions">
          <button class="add-to-order-btn" data-id="${item.id}">Add to Order</button>
        </div>
      </div>
    `;
      })
      .join("");

    specialsModalList.querySelectorAll(".add-to-order-btn").forEach((btn) => {
      btn.addEventListener("click", () => handleAddClick(parseInt(btn.dataset.id, 10)));
    });
  }

  specialsModal.classList.add("active");
}

function closeSpecialsModal() {
  specialsModal.classList.remove("active");
}

specialsBtn.addEventListener("click", openSpecialsModal);
document.getElementById("specialsModalClose").addEventListener("click", closeSpecialsModal);
specialsModal.addEventListener("click", (e) => {
  if (e.target === specialsModal) closeSpecialsModal();
});

// Menu search - typo-tolerant, no external library
function levenshteinDistance(a, b) {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;

  let prevRow = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const currRow = [i];
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      currRow[j] = Math.min(
        currRow[j - 1] + 1, // insertion
        prevRow[j] + 1, // deletion
        prevRow[j - 1] + cost // substitution
      );
    }
    prevRow = currRow;
  }
  return prevRow[b.length];
}

/** 1 = identical, 0 = completely different. */
function wordSimilarity(a, b) {
  const maxLen = Math.max(a.length, b.length);
  if (maxLen === 0) return 1;
  return 1 - levenshteinDistance(a, b) / maxLen;
}

const FUZZY_THRESHOLD = 0.6; // how lenient typo-tolerance is; lower = more forgiving

/** Best-match score (0-1+) of `query` against a block of free text. Substring hits score highest. */
function scoreTextMatch(query, text) {
  if (!text) return 0;
  const normalizedText = text.toLowerCase();
  if (normalizedText.includes(query)) return 1;

  const words = normalizedText.split(/[^a-z0-9]+/).filter(Boolean);
  let best = 0;
  for (const word of words) {
    const sim = wordSimilarity(query, word);
    if (sim > best) best = sim;
  }
  return best >= FUZZY_THRESHOLD ? best * 0.85 : 0; // fuzzy hits rank below exact/substring hits
}

function searchMenuItems(query, items, categoryList) {
  const normalizedQuery = query.trim().toLowerCase();
  if (!normalizedQuery) return items;

  const categoryNameById = Object.fromEntries(categoryList.map((c) => [c.id, c.name.toLowerCase()]));

  const scored = items.map((item) => {
    const nameScore = scoreTextMatch(normalizedQuery, item.name.toLowerCase()) * 1.5; // name matches weigh most
    const descScore = scoreTextMatch(normalizedQuery, (item.description || "").toLowerCase());
    const categoryScore = scoreTextMatch(normalizedQuery, categoryNameById[item.category_id] || "") * 0.75;
    return { item, score: Math.max(nameScore, descScore, categoryScore) };
  });

  return scored
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .map((s) => s.item);
}

const menuSearchInput = document.getElementById("menuSearchInput");
const menuSearchClear = document.getElementById("menuSearchClear");
let searchDebounce = null;

menuSearchInput.addEventListener("input", () => {
  clearTimeout(searchDebounce);
  searchDebounce = setTimeout(() => {
    searchQuery = menuSearchInput.value;
    menuSearchClear.style.display = searchQuery ? "block" : "none";
    renderOrderItems();
  }, 150);
});

menuSearchClear.addEventListener("click", () => {
  menuSearchInput.value = "";
  searchQuery = "";
  menuSearchClear.style.display = "none";
  renderOrderItems();
});

// Add to cart, or open the options picker first
function handleAddClick(itemId) {
  const item = menuItems.find((i) => i.id === itemId);
  if (!item) return;

  const hasSides = Array.isArray(item.sides) && item.sides.length > 0;
  if (item.accepts_spice || hasSides || (item.accepts_addons && item.addons.length > 0)) {
    openCustomizeModal(item);
  } else {
    addToCart(item, { spiceLevel: null, side: null, extras: [], quantity: 1 });
  }
}

function addToCart(item, { spiceLevel, side = null, extras, quantity }, { quiet = false } = {}) {
  const extraIds = extras.map((e) => e.id).sort().join(",");
  const lineId = `${item.id}|${spiceLevel || ""}|${side ? side.id : ""}|${extraIds}`;
  const existing = cart.find((line) => line.lineId === lineId);
  // effective_price is the special price only while the special is actually running
  const effectivePrice =
    item.effective_price !== undefined && item.effective_price !== null ? item.effective_price : item.price;

  if (existing) {
    existing.quantity += quantity;
    existing.price = effectivePrice;
  } else {
    cart.push({
      lineId,
      itemId: item.id,
      name: item.name,
      price: effectivePrice,
      quantity,
      spiceLevel: spiceLevel || null,
      side,
      extras
    });
  }
  if (quiet) return;
  showCartToast(`${item.name} added to cart`);
  renderCart();
}

// Customize modal (spice level + extras)
const customizeModal = document.getElementById("customizeModal");
const customizeItemName = document.getElementById("customizeItemName");
const customizeSpiceGroup = document.getElementById("customizeSpiceGroup");
const customizeSpiceOptions = document.getElementById("customizeSpiceOptions");
const customizeSideGroup = document.getElementById("customizeSideGroup");
const customizeSideOptions = document.getElementById("customizeSideOptions");
const customizeSideError = document.getElementById("customizeSideError");
const customizeAddonsGroup = document.getElementById("customizeAddonsGroup");
const customizeAddonOptions = document.getElementById("customizeAddonOptions");
const customizeQtyValue = document.getElementById("customizeQtyValue");

let sideChoices = []; // chosen side per meal in the customize modal: [{ id, name }, ...]

/** One row of side buttons per meal, so 3 meals can be chips, pap and rice. */
function renderSideChoices() {
  const item = pendingCustomizeItem;
  if (!item || !Array.isArray(item.sides) || !item.sides.length) return;
  const quantity = parseInt(customizeQtyValue.textContent, 10) || 1;
  sideChoices.length = Math.min(sideChoices.length, quantity);
  customizeSideGroup.querySelector("label").innerHTML =
    quantity > 1 ? "Choose a side for each meal <small>(free)</small>" : "Choose your side <small>(free)</small>";
  customizeSideOptions.innerHTML = Array.from({ length: quantity }, (_, meal) => {
    const pills = item.sides
      .map((sd) => `<button type="button" class="pill-option${sideChoices[meal]?.id === sd.id ? " selected" : ""}" data-meal="${meal}" data-id="${sd.id}" data-name="${escapeHtml(sd.name)}">${escapeHtml(sd.name)}</button>`)
      .join("");
    return quantity > 1
      ? `<div class="side-meal-row"><span class="side-meal-label">Meal ${meal + 1}</span><div class="pill-options">${pills}</div></div>`
      : `<div class="pill-options">${pills}</div>`;
  }).join("");
  customizeSideOptions.querySelectorAll(".pill-option").forEach((btn) => {
    btn.addEventListener("click", () => {
      const meal = Number(btn.dataset.meal);
      sideChoices[meal] = { id: parseInt(btn.dataset.id, 10), name: btn.dataset.name };
      btn.parentElement.querySelectorAll(".pill-option").forEach((b) => b.classList.toggle("selected", b === btn));
      if (sideChoices.filter(Boolean).length === quantity) customizeSideError.style.display = "none";
    });
  });
}

function openCustomizeModal(item) {
  pendingCustomizeItem = item;
  customizeItemName.textContent = item.name;
  customizeQtyValue.textContent = "1";

  if (item.accepts_spice && spiceLevels.length > 0) {
    customizeSpiceGroup.style.display = "block";
    customizeSpiceOptions.innerHTML = spiceLevels
      .map((s, idx) => `<button type="button" class="pill-option${idx === 0 ? " selected" : ""}" data-name="${s.name}">${s.name}</button>`)
      .join("");
    customizeSpiceOptions.querySelectorAll(".pill-option").forEach((btn) => {
      btn.addEventListener("click", () => {
        customizeSpiceOptions.querySelectorAll(".pill-option").forEach((b) => b.classList.remove("selected"));
        btn.classList.add("selected");
      });
    });
  } else {
    customizeSpiceGroup.style.display = "none";
    customizeSpiceOptions.innerHTML = "";
  }

  // Free choice of side (only on dishes the cafe attached sides to) - one per meal, must pick each
  customizeSideError.style.display = "none";
  sideChoices = [];
  if (Array.isArray(item.sides) && item.sides.length > 0) {
    customizeSideGroup.style.display = "block";
    renderSideChoices();
  } else {
    customizeSideGroup.style.display = "none";
    customizeSideOptions.innerHTML = "";
  }

  if (item.accepts_addons && item.addons.length > 0) {
    customizeAddonsGroup.style.display = "block";
    customizeAddonOptions.innerHTML = item.addons
      .map(
        (a) => `<label class="checkbox-option"><input type="checkbox" value="${a.id}" data-name="${a.name}" data-price="${a.price}" /> ${a.name} (+${money(a.price)})</label>`
      )
      .join("");
  } else {
    customizeAddonsGroup.style.display = "none";
    customizeAddonOptions.innerHTML = "";
  }

  customizeModal.classList.add("active");
}

document.getElementById("customizeModalClose").addEventListener("click", () => {
  customizeModal.classList.remove("active");
});
customizeModal.addEventListener("click", (e) => {
  if (e.target === customizeModal) customizeModal.classList.remove("active");
});

document.getElementById("customizeQtyMinus").addEventListener("click", () => {
  const val = Math.max(1, parseInt(customizeQtyValue.textContent, 10) - 1);
  customizeQtyValue.textContent = val;
  renderSideChoices();
});
document.getElementById("customizeQtyPlus").addEventListener("click", () => {
  const val = parseInt(customizeQtyValue.textContent, 10) + 1;
  customizeQtyValue.textContent = val;
  renderSideChoices();
});

document.getElementById("customizeConfirmBtn").addEventListener("click", () => {
  if (!pendingCustomizeItem) return;
  const selectedSpice = customizeSpiceOptions.querySelector(".pill-option.selected");
  const quantity = parseInt(customizeQtyValue.textContent, 10) || 1;
  const hasSides = customizeSideOptions.children.length > 0;
  if (hasSides && sideChoices.filter(Boolean).length < quantity) {
    customizeSideError.textContent = quantity > 1 ? "Please choose a side for every meal." : "Please choose a side.";
    customizeSideError.style.display = "block";
    return;
  }
  const selectedExtras = [...customizeAddonOptions.querySelectorAll("input:checked")].map((input) => ({
    id: parseInt(input.value, 10),
    name: input.dataset.name,
    price: parseFloat(input.dataset.price)
  }));

  // Meals with the same side share a cart line: 2x chips + 1x rice -> two lines.
  const groups = [];
  for (const side of hasSides ? sideChoices : [null]) {
    const group = groups.find((g) => (g.side ? g.side.id : null) === (side ? side.id : null));
    if (group) group.quantity += 1;
    else groups.push({ side, quantity: hasSides ? 1 : quantity });
  }
  for (const group of groups) {
    addToCart(pendingCustomizeItem, {
      spiceLevel: selectedSpice ? selectedSpice.dataset.name : null,
      side: group.side,
      extras: selectedExtras,
      quantity: group.quantity
    });
  }

  customizeModal.classList.remove("active");
  pendingCustomizeItem = null;
});

// Cart rendering + edit/remove
function renderCart() {
  saveCart();
  syncCardControls();

  const cartItemsEl = document.getElementById("cartItems");
  const cartTotalEl = document.getElementById("cartTotal");
  const checkoutBtn = document.getElementById("checkoutBtn");

  if (cart.length === 0) {
    cartItemsEl.innerHTML = `<p class="cart-empty">Your cart is empty</p>`;
    cartTotalEl.textContent = money(0);
    checkoutBtn.disabled = true;
    updateMobileCartBar(0, 0);
    return;
  }

  checkoutBtn.disabled = false;

  let total = 0;
  cartItemsEl.innerHTML = cart
    .map((line) => {
      const extrasTotal = line.extras.reduce((s, e) => s + e.price, 0);
      const lineTotal = (line.price + extrasTotal) * line.quantity;
      total += lineTotal;

      // Itemised: the dish, then each choice/extra with its own price (x quantity)
      const rows = [];
      if (line.spiceLevel) rows.push(`<li><span>${line.spiceLevel}</span><span class="cart-free">free</span></li>`);
      if (line.side) rows.push(`<li><span>Side: ${line.side.name}</span><span class="cart-free">free</span></li>`);
      line.extras.forEach((e) =>
        rows.push(`<li><span>+ ${e.name}</span><span>${money(e.price * line.quantity)}</span></li>`)
      );

      return `
      <div class="cart-item">
        <div class="cart-item-info">
          <div class="cart-line-head">
            <span class="cart-item-name">${line.name}${line.quantity > 1 ? ` <em>&times; ${line.quantity}</em>` : ""}</span>
            <span class="cart-item-price">${money(line.price * line.quantity)}</span>
          </div>
          ${rows.length ? `<ul class="cart-breakdown">${rows.join("")}</ul>` : ""}
          <div class="cart-line-foot">
            <span class="cart-item-qty-label">Qty: ${line.quantity}</span>
            <span class="cart-line-total">${rows.length ? `Item total ${money(lineTotal)}` : ""}</span>
          </div>
        </div>
        <button class="cart-item-remove" data-line="${line.lineId}" aria-label="Remove item">&times;</button>
      </div>
    `;
    })
    .join("");

  // Add delivery fee as a separate line if applicable
  const isDelivery = document.getElementById("order-type")?.value === "delivery";
  if (isDelivery && deliveryFee > 0) {
    const deliveryFeeHtml = `
      <div class="cart-item delivery-fee-line">
        <div class="cart-item-info">
          <span class="cart-item-name">Delivery fee</span>
          ${deliveryDistanceKm ? `<div class="cart-item-options">${deliveryDistanceKm} km</div>` : ""}
          ${geocodedDisplayAddress ? `<div class="cart-item-options" style="font-size:0.75rem;color:var(--sa-muted)">${geocodedDisplayAddress}</div>` : ""}
          <span class="cart-item-price">${money(deliveryFee)}</span>
        </div>
      </div>
    `;
    cartItemsEl.innerHTML += deliveryFeeHtml;
    total += deliveryFee;
  } else if (isDelivery && deliveryFeeLoading) {
    const loadingHtml = `
      <div class="cart-item delivery-fee-line">
        <div class="cart-item-info">
          <span class="cart-item-name">Delivery fee</span>
          <span class="cart-item-price"><i class="fas fa-spinner fa-spin"></i> Calculating…</span>
        </div>
      </div>
    `;
    cartItemsEl.innerHTML += loadingHtml;
  } else if (isDelivery && deliveryFee === 0 && geocodedDeliveryLat !== null) {
    // Fee calculated but 0 (could be free delivery or address not yet geocoded)
    const feeHtml = `
      <div class="cart-item delivery-fee-line">
        <div class="cart-item-info">
          <span class="cart-item-name">Delivery fee</span>
          <span class="cart-item-price">${money(0)}</span>
        </div>
      </div>
    `;
    cartItemsEl.innerHTML += feeHtml;
  }

  cartTotalEl.textContent = money(total);
  updateMobileCartBar(cart.reduce((n, l) => n + l.quantity, 0), total);
  renderCheckoutSummary();

  cartItemsEl.querySelectorAll(".cart-item-remove").forEach((btn) => {
    btn.addEventListener("click", () => {
      cart = cart.filter((line) => line.lineId !== btn.dataset.line);
      renderCart();
    });
  });
}

// The "Order Summary" inside the checkout modal: every line with its choices and extras
function renderCheckoutSummary() {
  const el = document.getElementById("checkoutSummary");
  if (!el) return;
  if (cart.length === 0) {
    el.innerHTML = `<p class="cart-empty">Your cart is empty</p>`;
    return;
  }
  const row = (label, value, cls = "") =>
    `<div class="cs-row ${cls}"><span class="cs-label">${label}</span><span class="cs-value">${value}</span></div>`;

  let subtotal = 0;
  const lines = cart
    .map((line) => {
      const extrasUnit = line.extras.reduce((s, e) => s + e.price, 0);
      const lineTotal = (line.price + extrasUnit) * line.quantity;
      subtotal += lineTotal;
      const details = [];
      if (line.spiceLevel) details.push(row(`Spice: ${line.spiceLevel}`, "free", "cs-sub"));
      if (line.side) details.push(row(`Side: ${line.side.name}`, "free", "cs-sub"));
      line.extras.forEach((e) =>
        details.push(row(`+ ${e.name}${line.quantity > 1 ? ` (${line.quantity} &times; ${money(e.price)})` : ""}`, money(e.price * line.quantity), "cs-sub")),
      );
      return `<div class="cs-item">
        ${row(`<strong>${line.quantity} &times; ${line.name}</strong>${line.quantity > 1 ? ` <small>(${money(line.price)} each)</small>` : ""}`, money(line.price * line.quantity))}
        ${details.join("")}
        ${details.length ? row("Item total", money(lineTotal), "cs-item-total") : ""}
      </div>`;
    })
    .join("");

  const type = orderTypeSelect?.value || "collection";
  let fee = 0;
  let deliveryRows = "";
  let whereRow = "";
  if (type === "delivery") {
    let feeValue;
    if (deliveryFeeLoading) feeValue = `<i class="fas fa-spinner fa-spin"></i> Calculating…`;
    else if (deliveryTooFar) feeValue = "Not available (too far)";
    else if (geocodedDeliveryLat !== null) {
      fee = Number(deliveryFee) || 0;
      feeValue = money(fee);
    } else feeValue = `<em>Fill in your address and tap OK, or share your location</em>`;
    const km = deliveryDistanceKm && !deliveryTooFar && geocodedDeliveryLat !== null ? ` (${deliveryDistanceKm} km)` : "";
    deliveryRows = row(`Delivery fee${km}`, feeValue);
    const address = composeDeliveryAddress() || geocodedDisplayAddress;
    whereRow = `<div class="cs-where"><i class="fas fa-motorcycle"></i> Delivery${address ? ` to ${address.replace(/</g, "&lt;")}` : ""}${deliveryFromLocation ? " (your shared location)" : ""}</div>`;
  } else if (type === "dine_in") {
    whereRow = `<div class="cs-where"><i class="fas fa-utensils"></i> Dine in</div>`;
  } else {
    whereRow = `<div class="cs-where"><i class="fas fa-bag-shopping"></i> Collection at the cafe</div>`;
  }

  el.innerHTML = `${whereRow}
    ${lines}
    <div class="cs-totals">
      ${row("Items subtotal", money(subtotal))}
      ${deliveryRows}
      ${row("Total to pay", money(subtotal + fee), "cs-grand")}
    </div>`;
}

// Phones/tablets: "Your Order" lives on its own page instead
const cartPanelEl = document.querySelector(".cart-panel");
const mobileCartBar = document.getElementById("mobileCartBar");
const mobileCartCount = document.getElementById("mobileCartCount");
const mobileCartTotal = document.getElementById("mobileCartTotal");
const cartPageBack = document.getElementById("cartPageBack");

function updateMobileCartBar(count, total) {
  if (!mobileCartBar) return;
  mobileCartCount.textContent = count;
  mobileCartTotal.textContent = money(total);
  mobileCartBar.classList.toggle("has-items", count > 0);
}

function openCartPage() {
  if (cartPanelEl.classList.contains("cart-page-open")) return;
  cartPanelEl.classList.add("cart-page-open");
  document.body.classList.add("cart-page-active");
  history.pushState({ cartPage: true }, "", "#your-order");
  window.scrollTo(0, 0);
}

function closeCartPage({ fromPopState = false } = {}) {
  if (!cartPanelEl.classList.contains("cart-page-open")) return;
  cartPanelEl.classList.remove("cart-page-open");
  document.body.classList.remove("cart-page-active");
  if (!fromPopState && location.hash === "#your-order") history.back();
}

if (mobileCartBar) mobileCartBar.addEventListener("click", openCartPage);
if (cartPageBack) cartPageBack.addEventListener("click", () => closeCartPage());
window.addEventListener("popstate", () => closeCartPage({ fromPopState: true }));
// Leaving the phone layout (e.g. rotating a tablet) drops the "page" state.
window.matchMedia("(min-width: 901px)").addEventListener("change", (e) => {
  if (e.matches) closeCartPage({ fromPopState: true });
});

function changeLineQuantity(lineId, delta) {
  const line = cart.find((l) => l.lineId === lineId);
  if (!line) return;
  line.quantity += delta;
  if (line.quantity <= 0) {
    cart = cart.filter((l) => l.lineId !== lineId);
  }
  renderCart();
}

// Checkout modal
const checkoutModal = document.getElementById("checkoutModal");
const checkoutBtn = document.getElementById("checkoutBtn");
const modalClose = document.getElementById("modalClose");
const checkoutForm = document.getElementById("checkoutForm");
const orderTypeSelect = document.getElementById("order-type");
const addressField = document.getElementById("addressField");
const tableNumberField = document.getElementById("tableNumberField");
const dineInTimeField = document.getElementById("dineInTimeField");
const preferredTimeField = document.getElementById("preferredTimeField");
const checkoutError = document.getElementById("checkoutError");

checkoutBtn.addEventListener("click", () => {
  if (!currentCustomer) {
    pendingCheckoutAfterAuth = true;
    openAuthModal("signin", "Please sign in or create an account to continue to checkout.");
    return;
  }
  // Closed right now? No checkout (a pre-order for a booked table is allowed).
  if (!isTakingOrdersNow() && !getActiveReservation()) {
    showOutOfServiceNotice(ordersClosedMessage());
    return;
  }
  // Out of service? Ask the server (not a cached copy) and stop here if so.
  fetchStoreConfig().then((config) => {
    if (config && config.is_out_of_service) {
      showOutOfServiceNotice(config.out_of_service_reason);
      return;
    }
    // Pull the latest prices first so a special that started/ended while the
    // item sat in the cart is reflected before the customer pays.
    loadMenu(true).finally(proceedToCheckout);
  });
});

function updateCheckoutFieldVisibility() {
  const isDelivery = orderTypeSelect.value === "delivery";
  addressField.style.display = isDelivery ? "block" : "none";
  tableNumberField.style.display = orderTypeSelect.value === "dine_in" ? "block" : "none";
  dineInTimeField.style.display = orderTypeSelect.value === "dine_in" ? "block" : "none";
  preferredTimeField.style.display = orderTypeSelect.value === "dine_in" ? "none" : "block";
  // The address fields are checked in submitOrderCheckout (a shared location
  // can stand in for them), so they're not marked required here.
}

let lastQuotedAddressInput = ""; // the exact text we last looked up
let deliveryTooFar = false;
let deliveryFromLocation = false; // priced from the phone's shared location (GPS)

function resetDeliveryQuote() {
  deliveryFee = 0;
  deliveryDistanceKm = 0;
  geocodedDeliveryLat = null;
  geocodedDeliveryLng = null;
  geocodedDisplayAddress = "";
  deliveryFeeLoading = false;
  deliveryTooFar = false;
  lastQuotedAddressInput = "";
  deliveryFromLocation = false;
  setLocationStatus("");
}

// ---- Structured delivery address: street, unit (optional), suburb, town/city, postal code
const addrField = (id) => document.getElementById(id);
function addressParts() {
  const v = (id) => (addrField(id)?.value || "").trim();
  return {
    street: v("addr-street"),
    unit: v("addr-unit"),
    suburb: v("addr-suburb"),
    city: v("addr-city"),
    postal: v("addr-postal"),
    province: v("addr-province"),
  };
}

/** The full address saved on the order (what the driver reads). */
function composeDeliveryAddress() {
  const a = addressParts();
  return [a.unit, a.street, a.suburb, a.city, a.postal, a.province].filter(Boolean).join(", ");
}

/** Labels of the required parts still empty (unit number is optional). */
function missingAddressParts() {
  const a = addressParts();
  return [
    [a.street, "street address"],
    [a.suburb, "suburb"],
    [a.city, "town/city"],
    [a.postal, "postal code"],
    [a.province, "province"],
  ]
    .filter(([value]) => !value)
    .map(([, label]) => label);
}

function syncDeliveryAddressInput() {
  const hidden = addrField("delivery-address");
  if (hidden) hidden.value = composeDeliveryAddress() || geocodedDisplayAddress;
}

/** Picks the matching province option ("Limpopo Province" -> "Limpopo"). */
function setProvince(name) {
  const select = addrField("addr-province");
  if (!select || !name) return;
  const match = [...select.options].find((o) => o.value && name.toLowerCase().includes(o.value.toLowerCase()));
  if (match) select.value = match.value;
}

function fillAddressFields(parts) {
  if (parts.street !== undefined) addrField("addr-street").value = parts.street;
  if (parts.unit !== undefined) addrField("addr-unit").value = parts.unit;
  if (parts.suburb !== undefined) addrField("addr-suburb").value = parts.suburb;
  if (parts.city !== undefined) addrField("addr-city").value = parts.city;
  if (parts.postal !== undefined) addrField("addr-postal").value = parts.postal;
  if (parts.province !== undefined) setProvince(parts.province);
  syncDeliveryAddressInput();
}

/** Splits a saved one-line address ("12 Main Rd, Sibasa, Thohoyandou, 0950, Limpopo") into the fields. */
function fillFromSavedAddress(saved) {
  const bits = String(saved || "").split(",").map((s) => s.trim()).filter(Boolean);
  const parts = { street: "", unit: "", suburb: "", city: "", postal: "", province: "" };
  const rest = [];
  for (const bit of bits) {
    if (/^\d{4}$/.test(bit)) parts.postal = bit;
    else if (/limpopo|gauteng|mpumalanga|north west|kwazulu|natal|free state|eastern cape|western cape|northern cape/i.test(bit)) parts.province = bit;
    else if (!/^south africa$/i.test(bit)) rest.push(bit);
  }
  if (rest.length && /^(unit|flat|apt|apartment|no\.?)\s*\w+$/i.test(rest[0]) && rest.length > 1) parts.unit = rest.shift();
  parts.street = rest.shift() || "";
  parts.city = rest.pop() || "";
  parts.suburb = rest.join(", ");
  fillAddressFields(parts);
}

function setLocationStatus(text, kind = "info") {
  const el = addrField("locationStatus");
  if (!el) return;
  el.style.display = text ? "block" : "none";
  el.className = `address-status ${kind}`;
  el.innerHTML = text;
  // The message sits above the pay button, so bring it into view if the customer is further up the form
  if (text && !text.includes("fa-spinner")) el.scrollIntoView({ block: "nearest", behavior: "smooth" });
}

/** Uses device location for delivery pricing and address lookup. */
async function useMyLocation() {
  if (!navigator.geolocation) {
    showCheckoutError("Your browser can't share your location - please type your address instead.");
    return;
  }
  const btn = addrField("useMyLocationBtn");
  btn.disabled = true;
  setLocationStatus('<i class="fas fa-spinner fa-spin"></i> Getting your location…');
  checkoutError.style.display = "none";
  let position;
  try {
    position = await new Promise((resolve, reject) =>
      navigator.geolocation.getCurrentPosition(resolve, reject, { enableHighAccuracy: true, timeout: 20000, maximumAge: 60000 }),
    );
  } catch (err) {
    btn.disabled = false;
    setLocationStatus("");
    showCheckoutError(
      err && err.code === 1
        ? "Location permission was denied. Allow location for this site in your phone settings, or type your address below."
        : "We couldn't get your location. Please try again outside/with GPS on, or type your address below.",
    );
    return;
  }
  const lat = position.coords.latitude;
  const lng = position.coords.longitude;
  resetDeliveryQuote();
  deliveryFromLocation = true;
  deliveryFeeLoading = true;
  renderCart();
  try {
    const geoRes = await fetch("/api/delivery/geocode", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ lat, lng }),
      signal: AbortSignal.timeout(20000),
    });
    const geo = await safeJson(geoRes);
    if (geo.address) {
      const a = geo.address;
      // Keep anything the customer already typed that the lookup doesn't know (e.g. unit number).
      fillAddressFields({
        street: a.street || addressParts().street,
        suburb: a.suburb || addressParts().suburb,
        city: a.city || addressParts().city,
        postal: a.postal_code || addressParts().postal,
        province: a.province || addressParts().province,
      });
    }
    const feeRes = await fetch("/api/delivery/fee", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ lat, lng }),
      signal: AbortSignal.timeout(15000),
    });
    const feeData = await safeJson(feeRes);
    if (!feeRes.ok) throw new Error(feeData.error || "Failed to calculate delivery fee");
    geocodedDeliveryLat = lat;
    geocodedDeliveryLng = lng;
    geocodedDisplayAddress = geo.display_name || "";
    deliveryDistanceKm = feeData.distance_km;
    syncDeliveryAddressInput();
    if (feeData.too_far) {
      deliveryFee = 0;
      deliveryTooFar = true;
      showCheckoutError(`${feeData.message} You're about ${feeData.distance_km} km away. Call ${feeData.cafe_phone} or email ${feeData.cafe_email}.`);
    } else {
      deliveryFee = Number(feeData.fee) || 0;
    }
    setLocationStatus(
      `<i class="fas fa-location-dot"></i> Using your current location (${feeData.distance_km} km away). Check the address below for the driver, and add a unit number if you have one. <button type="button" class="link-btn" id="useTypedAddressBtn">Use a typed address instead</button>`,
      "ok",
    );
    addrField("useTypedAddressBtn")?.addEventListener("click", () => {
      resetDeliveryQuote();
      setLocationStatus('Check your address below, then tap OK.');
      renderCart();
    });
  } catch (err) {
    resetDeliveryQuote();
    showCheckoutError(
      err.name === "TimeoutError"
        ? "Working out the delivery fee is taking too long. Please try again or type your address."
        : err.message || "We couldn't price delivery to your location. Please type your address instead.",
    );
  } finally {
    deliveryFeeLoading = false;
    btn.disabled = false;
    renderCart();
  }
}

// Looks the typed address up (geocode -> distance -> fee)
async function handleDeliveryAddressBlur() {
  syncDeliveryAddressInput();
  if (deliveryFromLocation) return; // already priced from the phone's location
  // Every field the customer filled in (unit number included) is used for the lookup.
  const address = composeDeliveryAddress();
  if (!address || missingAddressParts().length || orderTypeSelect.value !== "delivery") return;

  // Don't re-look-up the same text
  if (address === lastQuotedAddressInput && geocodedDeliveryLat !== null) return;

  deliveryFeeLoading = true;
  deliveryTooFar = false;
  renderCart(); // show loading state

  try {
    // Step 1: Geocode the address
    const geoRes = await fetch("/api/delivery/geocode", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ parts: addressParts() }),
      signal: AbortSignal.timeout(30000),
    });
    const geoData = await safeJson(geoRes);

    if (!geoRes.ok || !geoData.lat || !geoData.lng) {
      throw new Error(geoData.error || "We couldn't find that address.");
    }

    // Step 2: Calculate delivery fee
    const feeRes = await fetch("/api/delivery/fee", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ lat: geoData.lat, lng: geoData.lng }),
      signal: AbortSignal.timeout(15000),
    });
    const feeData = await safeJson(feeRes);

    if (!feeRes.ok) {
      throw new Error(feeData.error || "Failed to calculate delivery fee");
    }

    geocodedDeliveryLat = geoData.lat;
    geocodedDeliveryLng = geoData.lng;
    geocodedDisplayAddress = geoData.display_name;
    lastQuotedAddressInput = address;

    if (feeData.too_far) {
      deliveryFee = 0;
      deliveryDistanceKm = feeData.distance_km;
      deliveryTooFar = true;
      setLocationStatus("");
      showCheckoutError(
        `${feeData.message} We found "${geoData.display_name}" (about ${feeData.distance_km} km away). If that's not the right place, add your suburb or village to the address. Otherwise call ${feeData.cafe_phone} or email ${feeData.cafe_email}.`
      );
    } else {
      deliveryFee = Number(feeData.fee) || 0;
      deliveryDistanceKm = feeData.distance_km;
      checkoutError.style.display = "none";
      setLocationStatus(
        geoData.approximate
          ? `<i class="fas fa-circle-info"></i> We couldn't pin your exact street, so the fee is for your area: ${geoData.display_name} (${feeData.distance_km} km). Delivery fee ${money(deliveryFee)}.`
          : `<i class="fas fa-circle-check"></i> Address found (${feeData.distance_km} km away). Delivery fee ${money(deliveryFee)}.`,
        "ok",
      );
    }
  } catch (err) {
    resetDeliveryQuote();
    showCheckoutError(
      err.name === "TimeoutError"
        ? "Looking up that address is taking too long. Please check your connection and try again."
        : err.message || "We couldn't find that address. Please check it and try again.",
    );
  } finally {
    deliveryFeeLoading = false;
    renderCart();
  }
}

// Wires the address fields once
let deliveryFieldsWired = false;
function setupDeliveryGeocoding() {
  if (deliveryFieldsWired) return;
  deliveryFieldsWired = true;
  ["addr-street", "addr-unit", "addr-suburb", "addr-city", "addr-postal", "addr-province"].forEach((id) => {
    const el = addrField(id);
    if (!el) return;
    el.addEventListener("input", invalidateQuoteOnEdit);
    el.addEventListener("change", invalidateQuoteOnEdit);
  });
  addrField("useMyLocationBtn")?.addEventListener("click", useMyLocation);
  addrField("addressOkBtn")?.addEventListener("click", confirmTypedAddress);
}

// OK button: check the address fields, then price the delivery
async function confirmTypedAddress() {
  checkoutError.style.display = "none";
  const missing = missingAddressParts();
  if (missing.length) {
    showCheckoutError(`Please add your ${missing.join(", ")}, then tap OK.`);
    return;
  }
  const btn = addrField("addressOkBtn");
  btn.disabled = true;
  if (deliveryFromLocation) resetDeliveryQuote(); // they chose to type it instead
  setLocationStatus('<i class="fas fa-spinner fa-spin"></i> Finding your address and working out the delivery fee…');
  try {
    await handleDeliveryAddressBlur();
    if (geocodedDeliveryLat === null && !deliveryFeeLoading) setLocationStatus("");
  } finally {
    btn.disabled = false;
  }
}

function invalidateQuoteOnEdit() {
  syncDeliveryAddressInput();
  renderCheckoutSummary();
  // A shared location stays - the fields are just the driver's description of it.
  if (deliveryFromLocation) return;
  if (composeDeliveryAddress() !== lastQuotedAddressInput && geocodedDeliveryLat !== null) {
    resetDeliveryQuote();
    setLocationStatus('<i class="fas fa-pen"></i> Address changed - tap OK to update the delivery fee.');
    renderCart();
  }
}

/** "Preferred Time": As soon as possible, then today's half-hour slots from 1h30 from now. */
function renderPickupTimeSlots() {
  const pickupSelect = document.getElementById("pickup-time-slot");
  const previous = pickupSelect.value;
  pickupSelect.innerHTML =
    `<option value="As soon as possible">As soon as possible</option>` +
    orderTimeSlotsToday().map((t) => `<option value="At ${t}">${t}</option>`).join("");
  if ([...pickupSelect.options].some((o) => o.value === previous)) pickupSelect.value = previous;
}

/** Opens checkout with the account name prefilled but editable. */
function proceedToCheckout() {
  checkoutError.style.display = "none";
  const dupPanel = document.getElementById("duplicateOrderPanel");
  if (dupPanel) dupPanel.style.display = "none";
  checkoutForm.reset();
  const preorder = getActiveReservation();
  orderTypeSelect.disabled = Boolean(preorder);
  // Dine In is only for a table pre-order - a normal order is collection or delivery.
  orderTypeSelect.querySelector('option[value="dine_in"]').hidden = !preorder;
  if (!preorder && orderTypeSelect.value === "dine_in") orderTypeSelect.value = "collection";
  renderPickupTimeSlots();
  const arrivalInput = document.getElementById("dine-in-arrival-time");
  arrivalInput.readOnly = Boolean(preorder);
  let preorderNote = document.getElementById("checkoutPreorderNote");
  if (preorder) {
    // Pre-order for a table booking: dine-in is fixed and the booking's details are filled in.
    orderTypeSelect.value = "dine_in";
    arrivalInput.value = preorder.time || "";
    if (!preorderNote) {
      preorderNote = document.createElement("p");
      preorderNote.id = "checkoutPreorderNote";
      preorderNote.className = "auth-hint";
      checkoutForm.parentNode.insertBefore(preorderNote, checkoutForm);
    }
    preorderNote.textContent = `Pre-order for your table: ${formatReservationWhen(preorder.date, preorder.time)}${preorder.party ? ` · ${preorder.party} guest${preorder.party > 1 ? "s" : ""}` : ""}. Order type is set to Dine In.`;
    preorderNote.style.display = "block";
  } else if (preorderNote) {
    preorderNote.style.display = "none";
  }
  updateCheckoutFieldVisibility();

  const nameInput = document.getElementById("customer-name");
  const phoneInput = document.getElementById("customer-phone");
  resetDeliveryQuote();
  fillAddressFields({ street: "", unit: "", suburb: "", city: "", postal: "", province: "" });

  if (preorder) {
    nameInput.value = preorder.name || (currentCustomer && currentCustomer.name) || "";
    phoneInput.value = preorder.phone || (currentCustomer && currentCustomer.phone_number) || "";
  } else if (currentCustomer) {
    if (!nameInput.value.trim()) {
      nameInput.value = currentCustomer.name || "";
    }

    const hasSavedProfile = currentCustomer.phone_number || currentCustomer.delivery_address;
    if (hasSavedProfile && !phoneInput.value.trim() && !composeDeliveryAddress()) {
      const shouldUseSaved = window.confirm("Use your saved contact details for this order?");
      if (shouldUseSaved) {
        phoneInput.value = currentCustomer.phone_number || "";
        fillFromSavedAddress(currentCustomer.delivery_address || "");
        // Not looked up yet - the customer checks it and taps OK.
      }
    }
  }

  // Editing an unpaid order: start from that order's details.
  const editing = getEditingOrder();
  if (editing && !preorder) {
    if (["collection", "delivery"].includes(editing.order_type)) orderTypeSelect.value = editing.order_type;
    document.getElementById("special-instructions").value = editing.special_instructions || "";
    if (editing.order_type === "delivery" && !composeDeliveryAddress()) fillFromSavedAddress(editing.delivery_address || "");
    updateCheckoutFieldVisibility();
  }

  // Set up delivery address geocoding + "use my location"
  setupDeliveryGeocoding();

  checkoutModal.classList.add("active");
  renderCart(); // refresh to show/hide delivery fee line
}

modalClose.addEventListener("click", () => checkoutModal.classList.remove("active"));
checkoutModal.addEventListener("click", (e) => {
  if (e.target === checkoutModal) checkoutModal.classList.remove("active");
});
orderTypeSelect.addEventListener("change", () => {
  updateCheckoutFieldVisibility();
  // Reset delivery fee state when order type changes
  resetDeliveryQuote();
  checkoutError.style.display = "none";
  renderCart();
});

/** "18:5" -> "6:05 PM" - friendlier than raw 24-hour input for a printed/displayed ticket. */
function formatArrivalTime(timeStr) {
  const [h, m] = timeStr.split(":").map(Number);
  if (Number.isNaN(h) || Number.isNaN(m)) return timeStr;
  const period = h >= 12 ? "PM" : "AM";
  const hour12 = h % 12 === 0 ? 12 : h % 12;
  return `${hour12}:${String(m).padStart(2, "0")} ${period}`;
}

// submitOrderCheckout() Validates the contact fields, ensures the cart isn't empty
async function submitOrderCheckout(event) {
  event.preventDefault();
  checkoutError.style.display = "none";

  const nameInput = document.getElementById("customer-name");
  const phoneInput = document.getElementById("customer-phone");
  const tableInput = document.getElementById("table-number");
  const pickupSelect = document.getElementById("pickup-time-slot");
  const dineInTimeInput = document.getElementById("dine-in-arrival-time");
  const instructionsInput = document.getElementById("special-instructions");

  const customerName = nameInput.value.trim();
  const customerPhone = phoneInput.value.trim();
  const orderType = orderTypeSelect.value;
  syncDeliveryAddressInput();
  const deliveryAddress = composeDeliveryAddress() || geocodedDisplayAddress;

  if (!isTakingOrdersNow() && !getActiveReservation()) {
    checkoutModal.classList.remove("active");
    showOutOfServiceNotice(ordersClosedMessage());
    return;
  }
  if (!currentCustomer) {
    // Session must have expired between opening checkout and submitting it.
    checkoutModal.classList.remove("active");
    pendingCheckoutAfterAuth = true;
    openAuthModal("signin", "Your session expired. Please sign in again to finish checking out.");
    return;
  }
  if (!customerName || !customerPhone) {
    showCheckoutError("Please enter your name and cell number.");
    return;
  }
  if (orderType === "delivery" && !deliveryFromLocation && missingAddressParts().length) {
    showCheckoutError(`Please add your ${missingAddressParts().join(", ")} - or tap "Use my current location".`);
    return;
  }
  if (orderType === "delivery" && !deliveryAddress) {
    showCheckoutError("Please enter a delivery address or use your current location.");
    return;
  }
  if (cart.length === 0) {
    showCheckoutError("Your cart is empty.");
    return;
  }
  // Just signed in? Let the account's cart finish loading first, so what is
  // paid for is exactly what the order summary shows.
  await ensureCartLinked();
  if (cart.length === 0) {
    showCheckoutError("Your cart is empty.");
    return;
  }

  // Delivery: make sure the address has been located and priced
  if (orderType === "delivery") {
    if (!deliveryFromLocation && (geocodedDeliveryLat === null || composeDeliveryAddress() !== lastQuotedAddressInput)) {
      await handleDeliveryAddressBlur();
    }
    if (deliveryFeeLoading) return;
    if (geocodedDeliveryLat === null) return; // error already shown by the lookup
    if (deliveryTooFar) return; // message already shown - don't send an order we can't
  }

  const pickupTime =
    orderType === "dine_in"
      ? dineInTimeInput.value
        ? `Arriving at ${formatArrivalTime(dineInTimeInput.value)}`
        : "As soon as possible"
      : pickupSelect.value;

  const payload = {
    customer_name: customerName,
    phone_number: customerPhone,
    order_type: orderType,
    delivery_address: orderType === "delivery" ? deliveryAddress : "",
    delivery_lat: orderType === "delivery" ? geocodedDeliveryLat : undefined,
    delivery_lng: orderType === "delivery" ? geocodedDeliveryLng : undefined,
    table_number: orderType === "dine_in" ? tableInput.value.trim() : "",
    pickup_time: pickupTime,
    special_instructions: instructionsInput.value.trim(),
    reservation_id: getActiveReservation()?.id,
    replaces_order_id: getEditingOrder()?.id,
    cart_items: cart.map((line) => ({
      id: line.itemId,
      quantity: line.quantity,
      spice_level: line.spiceLevel,
      side: line.side ? line.side.id : undefined,
      extras: line.extras.map((e) => e.id)
    }))
  };

  const submitBtn = checkoutForm.querySelector("button[type=submit]");
  submitBtn.disabled = true;
  submitBtn.textContent = "Redirecting to payment…";

  try {
    const res = await fetch("/api/order", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${customerToken}` },
      body: JSON.stringify(payload)
    });
    const result = await safeJson(res);

    if (res.status === 503 && result.closed) {
      checkoutModal.classList.remove("active");
      showOutOfServiceNotice(result.error);
      submitBtn.disabled = false;
      submitBtn.textContent = "Continue to Payment";
      return;
    }
    if (res.status === 503 && result.out_of_service) {
      // Admin switched Out of Service on while the customer was checking out.
      checkoutModal.classList.remove("active");
      showOutOfServiceNotice(result.reason || result.error);
      submitBtn.disabled = false;
      submitBtn.textContent = "Continue to Payment";
      return;
    }
    if (res.status === 409 && result.duplicate_order) {
      // Same order already waiting for payment - pay that one or edit, no second ticket.
      submitBtn.disabled = false;
      submitBtn.textContent = "Continue to Payment";
      showDuplicateOrderChoice(result.duplicate_order);
      return;
    }
    if (!res.ok || !result.success) {
      throw new Error(result.error || "Something went wrong placing your order.");
    }

    // Order is already saved (payment_status = 'awaiting')
    clearCartAfterOrder();
    localStorage.removeItem(ACTIVE_RES_KEY); // pre-order done - this booking no longer drives checkout
    localStorage.removeItem(EDIT_ORDER_KEY); // the edited order has replaced the old one
    redirectToYoco(result.payment);
  } catch (err) {
    showCheckoutError(err.message);
    submitBtn.disabled = false;
    submitBtn.textContent = "Continue to Payment";
  }
}

// Checkout found an identical unpaid order: let the customer pay that existing ticket
function showDuplicateOrderChoice(existing) {
  checkoutError.style.display = "none";
  let panel = document.getElementById("duplicateOrderPanel");
  if (!panel) {
    panel = document.createElement("div");
    panel.id = "duplicateOrderPanel";
    panel.className = "duplicate-order-panel";
    // Below the "Continue to Payment" button, where the customer is looking.
    checkoutForm.after(panel);
  }
  const placed = new Date(existing.created_at).toLocaleTimeString("en-ZA", { hour: "2-digit", minute: "2-digit" });
  panel.innerHTML = `
    <strong><i class="fas fa-receipt"></i> You already have this order</strong>
    <p>Order #${existing.id} (placed at ${placed}) has exactly the same items and details and hasn't been paid yet - ${money(existing.total_amount)}.</p>
    <div class="duplicate-order-actions">
      <button type="button" class="btn btn-primary" id="dupPayBtn">Pay order #${existing.id}</button>
      <button type="button" class="btn dup-edit-btn" id="dupEditBtn">Edit my order</button>
    </div>
    <p class="form-error" id="dupError" style="display:none"></p>`;
  panel.style.display = "block";
  panel.scrollIntoView({ behavior: "smooth", block: "end" });
  const fail = (message) => {
    const el = document.getElementById("dupError");
    el.textContent = message;
    el.style.display = "block";
  };

  const payBtn = document.getElementById("dupPayBtn");
  const editBtn = document.getElementById("dupEditBtn");
  payBtn.addEventListener("click", async () => {
    document.getElementById("dupError").style.display = "none";
    payBtn.disabled = true;
    payBtn.textContent = "Redirecting to payment…";
    try {
      const res = await fetch("/api/order/retry", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${customerToken}` },
        body: JSON.stringify({ id: existing.id }),
      });
      const data = await safeJson(res);
      if (!res.ok || !(data.payment?.redirect_url || data.payment?.action_url)) throw new Error(data.error || "Couldn't start the payment.");
      clearCartAfterOrder();
      localStorage.removeItem(ACTIVE_RES_KEY);
      localStorage.removeItem(EDIT_ORDER_KEY);
      redirectToYoco(data.payment);
    } catch (err) {
      fail(`${err.message} You can tap "Edit my order" to change it instead.`);
      payBtn.disabled = false;
      payBtn.textContent = `Pay order #${existing.id}`;
    }
  });

  editBtn.addEventListener("click", async () => {
    editBtn.disabled = true;
    try {
      const res = await fetch("/api/order/discard", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${customerToken}` },
        body: JSON.stringify({ id: existing.id }),
      });
      const data = await safeJson(res);
      if (!res.ok || !data.success) throw new Error(data.error || "Couldn't remove the old order.");
      panel.style.display = "none";
      checkoutModal.classList.remove("active");
      if (window.matchMedia("(max-width: 900px)").matches) openCartPage();
      showCartToast(`Order #${existing.id} removed - edit your cart, then check out again.`, "info");
    } catch (err) {
      fail(err.message);
      editBtn.disabled = false;
    }
  });
}

/** Hands the browser to the Yoco payment page (see goToYocoPayment in site.js). */
function redirectToYoco(payment) {
  goToYocoPayment(payment);
}

function showCheckoutError(message) {
  checkoutError.textContent = message;
  checkoutError.style.display = "block";
  checkoutError.scrollIntoView({ block: "nearest", behavior: "smooth" });
}

checkoutForm.addEventListener("submit", submitOrderCheckout);

// Init Pre-order for a table reservation
function refreshPreorderUI() {
  const r = getActiveReservation();
  const resBtn = document.getElementById("menuReservationBtn");
  if (resBtn) resBtn.style.display = r ? "none" : "";
  let banner = document.getElementById("preorderBanner");
  if (!r) {
    if (banner) banner.remove();
    return;
  }
  if (!banner) {
    banner = document.createElement("div");
    banner.id = "preorderBanner";
    banner.className = "auth-hint";
    banner.style.cssText = "background:#fff8e6;border:1px solid #f0d78a;border-radius:6px;padding:10px 12px;margin-bottom:12px";
    const panel = cartPanelEl;
    const back = document.getElementById("cartPageBack");
    if (back) back.after(banner); else panel.prepend(banner);
  }
  banner.style.position = "relative";
  banner.style.paddingRight = "36px";
  banner.innerHTML = `<button type="button" class="preorder-banner-close" id="preorderBannerClose" aria-label="Remove this pre-order and delete the reservation" title="Remove pre-order &amp; delete reservation">&times;</button><strong>Pre-order for your table</strong><br>${escapeHtml(formatReservationWhen(r.date, r.time))}${r.party ? ` · ${r.party} guest${r.party > 1 ? "s" : ""}` : ""}<br>Dine In is set for you. Add, edit or remove items, then check out.`;
  document.getElementById("preorderBannerClose").addEventListener("click", clearPreorderFromCart);
}

/**
 * The "x" on the pre-order message: drops the pre-order and deletes that booking from the stored
 * reservations too. The banner disappears and the cart goes back to a normal order straight
 * away - no refresh needed. (Items already in the cart stay.)
 */
async function clearPreorderFromCart() {
  const r = getActiveReservation();
  if (!r) { refreshPreorderUI(); return; }
  if (!confirm("Remove this pre-order? Your table reservation for " + formatReservationWhen(r.date, r.time) + " will be deleted too.")) return;
  const closeBtn = document.getElementById("preorderBannerClose");
  if (closeBtn) closeBtn.disabled = true;
  try {
    if (r.id) await deleteReservation(r.id); // removes it from the stored reservations (and clears the active pre-order)
    localStorage.removeItem(ACTIVE_RES_KEY);
    refreshPreorderUI();
    renderCart();
    showCartToast("Pre-order removed and your reservation deleted.", "info");
  } catch (err) {
    if (closeBtn) closeBtn.disabled = false;
    showCartToast(err.message || "Couldn't delete the reservation. Please try again.", "error");
  }
}
// Deleted from the reservation window while the cart is showing it
window.addEventListener("fulude:preorder-cleared", () => { refreshPreorderUI(); renderCart(); });

// Editing an unpaid order from My Orders: its items are put back in the cart, and checking
// out again replaces that order (the server removes the old, unpaid one).
function getEditingOrder() {
  try {
    return JSON.parse(localStorage.getItem(EDIT_ORDER_KEY) || "null");
  } catch {
    return null;
  }
}

async function loadEditingOrderIntoCart() {
  const edit = getEditingOrder();
  if (!edit) return;
  if (edit.items) {
    if (currentCustomer) await ensureCartLinked(); // so the account's saved cart can't overwrite it afterwards
    if (!menuItems.length) await loadMenu(true);
    if (cart.length && !confirm(`Replace the items in your cart with order #${edit.id} so you can edit it?`)) {
      localStorage.removeItem(EDIT_ORDER_KEY);
      refreshEditOrderUI();
      return;
    }
    cart = [];
    const missing = [];
    for (const line of edit.items) {
      const item = menuItems.find((m) => m.id === line.menu_item_id);
      if (!item) {
        missing.push(line.item_name);
        continue;
      }
      // Sides and extras were saved by name on the order; match them back to the menu.
      const names = line.extras || [];
      const side = (item.sides || []).find((sd) => names.includes(sd.name));
      const extras = (item.addons || [])
        .filter((a) => names.includes(a.name))
        .map((a) => ({ id: a.id, name: a.name, price: parseFloat(a.price) }));
      addToCart(
        item,
        { spiceLevel: line.spice_level, side: side ? { id: side.id, name: side.name } : null, extras, quantity: line.quantity },
        { quiet: true },
      );
    }
    delete edit.items; // loaded once - later visits keep whatever the customer changed
    localStorage.setItem(EDIT_ORDER_KEY, JSON.stringify(edit));
    renderCart();
    showCartToast(
      missing.length
        ? `Order #${edit.id} is in your cart. No longer on the menu: ${missing.join(", ")}.`
        : `Order #${edit.id} is in your cart - make your changes, then check out.`,
      "info",
    );
  }
  refreshPreorderUI();
  refreshEditOrderUI();
  if (window.matchMedia("(max-width: 900px)").matches) openCartPage();
  else cartPanelEl.scrollIntoView({ behavior: "smooth", block: "start" });
}

function refreshEditOrderUI() {
  const edit = getEditingOrder();
  let banner = document.getElementById("editOrderBanner");
  if (!edit) {
    if (banner) banner.remove();
    return;
  }
  if (!banner) {
    banner = document.createElement("div");
    banner.id = "editOrderBanner";
    banner.className = "auth-hint";
    banner.style.cssText = "background:#fff8e6;border:1px solid #f0d78a;border-radius:6px;padding:10px 12px;margin-bottom:12px";
    const back = document.getElementById("cartPageBack");
    if (back) back.after(banner); else cartPanelEl.prepend(banner);
  }
  banner.innerHTML = `<strong>Editing order #${edit.id}</strong><br>Add, change or remove items, then check out. Your changes replace order #${edit.id}. <button type="button" id="editOrderStopBtn" class="auth-link-btn" style="display:inline">Keep the original order</button>`;
  document.getElementById("editOrderStopBtn").addEventListener("click", () => {
    localStorage.removeItem(EDIT_ORDER_KEY);
    refreshEditOrderUI();
    showCartToast(`Order #${edit.id} is unchanged - you can still pay for it in My Orders.`, "info");
  });
}

function showPreorderCart() {
  refreshPreorderUI();
  if (window.matchMedia("(max-width: 900px)").matches) openCartPage();
  else cartPanelEl.scrollIntoView({ behavior: "smooth", block: "start" });
}
window.addEventListener("fulude:preorder", showPreorderCart);

loadMenu();
renderCart(); // restore any cart carried over from a previous visit
if (currentCustomer) ensureCartLinked(); // sign-in already confirmed before this script ran
refreshPreorderUI();
if (location.hash === "#your-order" && window.matchMedia("(max-width: 900px)").matches) {
  // Page was refreshed while viewing the cart - stay on the cart.
  cartPanelEl.classList.add("cart-page-open");
  document.body.classList.add("cart-page-active");
}
if (new URLSearchParams(location.search).get("preorder") === "1") {
  history.replaceState({}, "", location.pathname + location.hash);
  if (getActiveReservation()) showPreorderCart();
}
if (new URLSearchParams(location.search).get("edit") === "1") {
  history.replaceState({}, "", location.pathname + location.hash);
  loadEditingOrderIntoCart();
} else {
  refreshEditOrderUI();
}
