/**
 * public/js/menu.js
 * -----------------------------------------------------------------------
 * Menu-page logic: loads the live menu from /api/menu, renders category
 * tabs + dish cards, typo-tolerant search, specials, an on-page cart
 * (persisted in localStorage so it survives navigating between pages),
 * and checkout via POST /api/order with the hosted Yoco payment hand-off.
 *
 * Requires site.js to be loaded first (accounts, lightbox, helpers).
 * -----------------------------------------------------------------------
 */

// ---------------------------------------------------------------------
// State
// ---------------------------------------------------------------------
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

// Cart lines survive page navigation via localStorage - prices here are
// only cosmetic; the server re-prices every line from the live DB at checkout.
const CART_KEY = "fulude_cart";
let cart = []; // [{lineId, itemId, name, price, quantity, spiceLevel, extras:[{id,name,price}]}]
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
}

// ---------------------------------------------------------------------
// Load menu from the server
// ---------------------------------------------------------------------
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

    // Re-price anything already in the cart against the live menu, so a
    // special that ended (price goes back up) or one that just started
    // (price drops) is reflected before the customer pays.
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

/**
 * Syncs every cart line's price with the item's current effective price
 * (special price while a special is running, normal price otherwise).
 * Returns true if any line's price changed.
 */
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

// ---------------------------------------------------------------------
// Quick pop-up message (e.g. "Item added to cart")
// ---------------------------------------------------------------------
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

  // Categories only come back from the API while they have at least one
  // visible dish (see functions/api/menu.js) - so a category can vanish
  // between page loads (e.g. admin turns off the last visible starter).
  // If the tab someone was on is gone, fall back to "All" instead of
  // silently rendering an empty category with nothing selected.
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

function renderOrderItems() {
  const grid = document.getElementById("orderItems");

  let items;
  if (searchQuery.trim()) {
    // Search spans every category, ranked by relevance (best matches first).
    items = searchMenuItems(searchQuery, menuItems, categories);
    if (items.length === 0) {
      grid.innerHTML = `<p class="menu-empty">No dishes matched "${searchQuery}". Try a different word, or browse by category above.</p>`;
      return;
    }
  } else {
    const categoryBySlug = Object.fromEntries(categories.map((c) => [c.slug, c.id]));
    items =
      activeCategorySlug === "all"
        ? menuItems
        : menuItems.filter((item) => item.category_id === categoryBySlug[activeCategorySlug]);

    if (items.length === 0) {
      grid.innerHTML = `<p class="menu-empty">No dishes in this category yet.</p>`;
      return;
    }
  }

  grid.innerHTML = items
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

// ---------------------------------------------------------------------
// Per-dish quantity controls. Each dish card owns its own "Add to Order"
// button, which turns into a  -  2  +  stepper once the dish is in the
// cart. (The Your Order panel only displays quantities.)
// ---------------------------------------------------------------------
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

/** Refreshes only the quantity controls on the visible cards (keeps any photo the customer has slid to). */
function syncCardControls() {
  document.querySelectorAll("#orderItems .order-card-footer[data-id]").forEach((footer) => {
    const item = menuItems.find((i) => i.id === parseInt(footer.dataset.id, 10));
    if (item) footer.innerHTML = cardControlsHtml(item);
  });
}

/** Takes one unit off a dish. For dishes with several variants (spice/extras) it trims the most recently added one. */
function decrementItem(itemId) {
  for (let i = cart.length - 1; i >= 0; i--) {
    if (cart[i].itemId === itemId) {
      changeLineQuantity(cart[i].lineId, -1);
      return;
    }
  }
}

// ---------------------------------------------------------------------
// Photo slideshow inside each dish card - arrows + swipe, no full-screen
// lightbox. The customer stays right where they are on the menu.
// ---------------------------------------------------------------------
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

// ---------------------------------------------------------------------
// Specials - the red "Save on Meals" button + the modal listing every
// dish currently discounted by the admin. Only items that are visible
// AND in stock are counted/shown here - a sold-out special would just be
// confusing to promote.
// ---------------------------------------------------------------------
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
    specialsModalList.innerHTML = `<p class="menu-empty">No dishes are on special right now.</p>`;
  } else {
    specialsModalList.innerHTML = specials
      .map((item) => {
        const savings = item.price - item.effective_price;
        const photos = item.images && item.images.length > 0 ? item.images : (item.image_url ? [item.image_url] : []);
        return `
      <div class="specials-item">
        ${photos.length > 0 ? `<img src="${photos[0]}" alt="${item.name}" />` : `<div class="specials-item-noimg"></div>`}
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

// ---------------------------------------------------------------------
// Menu search - typo-tolerant, no external library. Matches on dish
// name, description, and category name; ranks exact/substring matches
// highest and falls back to fuzzy (edit-distance) matching so a
// misspelled search like "chiken" or "piza" still finds something
// "sort of relevant" instead of coming up empty.
// ---------------------------------------------------------------------
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

// ---------------------------------------------------------------------
// Add to cart - either straight in, or via the customize modal when the
// dish accepts a spice level and/or extras.
// ---------------------------------------------------------------------
function handleAddClick(itemId) {
  const item = menuItems.find((i) => i.id === itemId);
  if (!item) return;

  if (item.accepts_spice || (item.accepts_addons && item.addons.length > 0)) {
    openCustomizeModal(item);
  } else {
    addToCart(item, { spiceLevel: null, extras: [], quantity: 1 });
  }
}

function addToCart(item, { spiceLevel, extras, quantity }) {
  const extraIds = extras.map((e) => e.id).sort().join(",");
  const lineId = `${item.id}|${spiceLevel || ""}|${extraIds}`;
  const existing = cart.find((line) => line.lineId === lineId);
  // effective_price is the special price only while the special is
  // actually running (start/end dates respected); otherwise the normal
  // price. The server re-prices from the live DB at checkout regardless.
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
      extras
    });
  }
  showCartToast(`${item.name} added to cart`);
  renderCart();
}

// ---------------------------------------------------------------------
// Customize modal (spice level + extras)
// ---------------------------------------------------------------------
const customizeModal = document.getElementById("customizeModal");
const customizeItemName = document.getElementById("customizeItemName");
const customizeSpiceGroup = document.getElementById("customizeSpiceGroup");
const customizeSpiceOptions = document.getElementById("customizeSpiceOptions");
const customizeAddonsGroup = document.getElementById("customizeAddonsGroup");
const customizeAddonOptions = document.getElementById("customizeAddonOptions");
const customizeQtyValue = document.getElementById("customizeQtyValue");

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
});
document.getElementById("customizeQtyPlus").addEventListener("click", () => {
  const val = parseInt(customizeQtyValue.textContent, 10) + 1;
  customizeQtyValue.textContent = val;
});

document.getElementById("customizeConfirmBtn").addEventListener("click", () => {
  if (!pendingCustomizeItem) return;
  const selectedSpice = customizeSpiceOptions.querySelector(".pill-option.selected");
  const selectedExtras = [...customizeAddonOptions.querySelectorAll("input:checked")].map((input) => ({
    id: parseInt(input.value, 10),
    name: input.dataset.name,
    price: parseFloat(input.dataset.price)
  }));
  const quantity = parseInt(customizeQtyValue.textContent, 10) || 1;

  addToCart(pendingCustomizeItem, {
    spiceLevel: selectedSpice ? selectedSpice.dataset.name : null,
    extras: selectedExtras,
    quantity
  });

  customizeModal.classList.remove("active");
  pendingCustomizeItem = null;
});

// ---------------------------------------------------------------------
// Cart rendering + edit/remove
// ---------------------------------------------------------------------
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

      const optionBits = [];
      if (line.spiceLevel) optionBits.push(line.spiceLevel);
      if (line.extras.length > 0) optionBits.push(line.extras.map((e) => e.name).join(", "));
      const optionsText = optionBits.join(" · ");

      return `
      <div class="cart-item">
        <div class="cart-item-info">
          <span class="cart-item-name">${line.name}</span>
          ${optionsText ? `<div class="cart-item-options">${optionsText}</div>` : ""}
          <span class="cart-item-qty-label">Qty: ${line.quantity}</span>
          <span class="cart-item-price">${money(lineTotal)}</span>
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

  cartItemsEl.querySelectorAll(".cart-item-remove").forEach((btn) => {
    btn.addEventListener("click", () => {
      cart = cart.filter((line) => line.lineId !== btn.dataset.line);
      renderCart();
    });
  });
}

// ---------------------------------------------------------------------
// Phones/tablets: "Your Order" lives on its own page instead of sitting at
// the very bottom of a long menu. A bar fixed to the bottom of the screen
// (the order nav bar) shows the item count + total and opens it in one tap;
// the browser's Back button (or the Back arrow) returns to the menu.
// ---------------------------------------------------------------------
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

// ---------------------------------------------------------------------
// Checkout modal
// ---------------------------------------------------------------------
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
  // Pull the latest prices first so a special that started/ended while the
  // item sat in the cart is reflected before the customer pays.
  loadMenu(true).finally(proceedToCheckout);
});

function updateCheckoutFieldVisibility() {
  const isDelivery = orderTypeSelect.value === "delivery";
  addressField.style.display = isDelivery ? "block" : "none";
  tableNumberField.style.display = orderTypeSelect.value === "dine_in" ? "block" : "none";
  dineInTimeField.style.display = orderTypeSelect.value === "dine_in" ? "block" : "none";
  preferredTimeField.style.display = orderTypeSelect.value === "dine_in" ? "none" : "block";

  const addressInput = document.getElementById("delivery-address");
  if (addressInput) {
    addressInput.required = isDelivery;
  }
}

let lastQuotedAddressInput = ""; // the exact text we last looked up
let deliveryTooFar = false;

function resetDeliveryQuote() {
  deliveryFee = 0;
  deliveryDistanceKm = 0;
  geocodedDeliveryLat = null;
  geocodedDeliveryLng = null;
  geocodedDisplayAddress = "";
  deliveryFeeLoading = false;
  deliveryTooFar = false;
  lastQuotedAddressInput = "";
}

/**
 * Looks the typed address up (geocode -> distance -> fee). Runs when the
 * address field loses focus, when a saved address is filled in, and once
 * more at submit time if there is still no quote - so a delivery order is
 * never sent without coordinates.
 */
async function handleDeliveryAddressBlur() {
  const addressInput = document.getElementById("delivery-address");
  const address = addressInput?.value?.trim();
  if (!address || orderTypeSelect.value !== "delivery") return;

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
      body: JSON.stringify({ address }),
    });
    const geoData = await geoRes.json();

    if (!geoRes.ok || !geoData.lat || !geoData.lng) {
      throw new Error(geoData.error || "We couldn't find that address.");
    }

    // Step 2: Calculate delivery fee
    const feeRes = await fetch("/api/delivery/fee", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ lat: geoData.lat, lng: geoData.lng }),
    });
    const feeData = await feeRes.json();

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
      showCheckoutError(
        `${feeData.message} We found "${geoData.display_name}" (about ${feeData.distance_km} km away). If that's not the right place, add your suburb or village to the address. Otherwise call ${feeData.cafe_phone} or email ${feeData.cafe_email}.`
      );
    } else {
      deliveryFee = feeData.fee;
      deliveryDistanceKm = feeData.distance_km;
      checkoutError.style.display = "none";
    }
  } catch (err) {
    resetDeliveryQuote();
    showCheckoutError(err.message || "We couldn't find that address. Please check it and try again.");
  } finally {
    deliveryFeeLoading = false;
    renderCart();
  }
}

/** Sets up geocoding on blur for the delivery address field. */
function setupDeliveryGeocoding(addressInput) {
  if (!addressInput) return;
  addressInput.removeEventListener("blur", handleDeliveryAddressBlur);
  addressInput.addEventListener("blur", handleDeliveryAddressBlur);
  // Editing the text invalidates the previous quote
  addressInput.removeEventListener("input", invalidateQuoteOnEdit);
  addressInput.addEventListener("input", invalidateQuoteOnEdit);
}

function invalidateQuoteOnEdit() {
  const typed = document.getElementById("delivery-address").value.trim();
  if (typed !== lastQuotedAddressInput && geocodedDeliveryLat !== null) {
    resetDeliveryQuote();
    renderCart();
  }
}

/** Opens the checkout modal, prefilling the name field from the account (still editable, e.g. ordering for someone else). */
function proceedToCheckout() {
  checkoutError.style.display = "none";
  checkoutForm.reset();
  updateCheckoutFieldVisibility();

  const nameInput = document.getElementById("customer-name");
  const phoneInput = document.getElementById("customer-phone");
  const addressInput = document.getElementById("delivery-address");

  resetDeliveryQuote();

  if (currentCustomer) {
    if (!nameInput.value.trim()) {
      nameInput.value = currentCustomer.name || "";
    }

    const hasSavedProfile = currentCustomer.phone_number || currentCustomer.delivery_address;
    if (hasSavedProfile && !phoneInput.value.trim() && !addressInput.value.trim()) {
      const shouldUseSaved = window.confirm("Use your saved contact details for this order?");
      if (shouldUseSaved) {
        phoneInput.value = currentCustomer.phone_number || "";
        addressInput.value = currentCustomer.delivery_address || "";
        // A saved address was never looked up in this visit - do it now
        // if they're already choosing delivery.
        if (orderTypeSelect.value === "delivery") handleDeliveryAddressBlur();
      }
    }
  }

  // Set up delivery address geocoding on blur
  setupDeliveryGeocoding(addressInput);

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
  // Switching to delivery with an address already typed/saved: quote it.
  if (orderTypeSelect.value === "delivery") handleDeliveryAddressBlur();
});

/** "18:5" -> "6:05 PM" - friendlier than raw 24-hour input for a printed/displayed ticket. */
function formatArrivalTime(timeStr) {
  const [h, m] = timeStr.split(":").map(Number);
  if (Number.isNaN(h) || Number.isNaN(m)) return timeStr;
  const period = h >= 12 ? "PM" : "AM";
  const hour12 = h % 12 === 0 ? 12 : h % 12;
  return `${hour12}:${String(m).padStart(2, "0")} ${period}`;
}

/**
 * submitOrderCheckout()
 * Validates the contact fields, ensures the cart isn't empty, packages
 * the full payload (including per-line spice level + extras), and POSTs
 * it to /api/order. Resets the cart only after a confirmed success.
 */
async function submitOrderCheckout(event) {
  event.preventDefault();
  checkoutError.style.display = "none";

  const nameInput = document.getElementById("customer-name");
  const phoneInput = document.getElementById("customer-phone");
  const addressInput = document.getElementById("delivery-address");
  const tableInput = document.getElementById("table-number");
  const pickupSelect = document.getElementById("pickup-time-slot");
  const dineInTimeInput = document.getElementById("dine-in-arrival-time");
  const instructionsInput = document.getElementById("special-instructions");

  const customerName = nameInput.value.trim();
  const customerPhone = phoneInput.value.trim();
  const orderType = orderTypeSelect.value;
  const deliveryAddress = addressInput.value.trim();

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
  if (orderType === "delivery" && !deliveryAddress) {
    showCheckoutError("Please enter a delivery address.");
    return;
  }
  if (cart.length === 0) {
    showCheckoutError("Your cart is empty.");
    return;
  }

  // Delivery: make sure the address has been located and priced (the
  // customer may tap "Continue" straight after typing, before the field
  // has lost focus).
  if (orderType === "delivery") {
    if (geocodedDeliveryLat === null || deliveryAddress !== lastQuotedAddressInput) {
      await handleDeliveryAddressBlur();
    }
    if (deliveryFeeLoading) return;
    if (geocodedDeliveryLat === null) return; // error already shown by the lookup
    if (deliveryTooFar) return; // message already shown - don't send an order we can't deliver
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
    cart_items: cart.map((line) => ({
      id: line.itemId,
      quantity: line.quantity,
      spice_level: line.spiceLevel,
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
    const result = await res.json();

    if (!res.ok || !result.success) {
      throw new Error(result.error || "Something went wrong placing your order.");
    }

    // Order is already saved (payment_status = 'awaiting'); hand the
    // browser off to the hosted Yoco payment page. Clear the cart now
    // since the order itself exists regardless of payment outcome.
    cart = [];
    saveCart();
    redirectToYoco(result.payment);
  } catch (err) {
    showCheckoutError(err.message);
    submitBtn.disabled = false;
    submitBtn.textContent = "Continue to Payment";
  }
}

/** Builds a hidden form and submits it to send the browser to the hosted Yoco checkout. */
function redirectToYoco(payment) {
  const form = document.createElement("form");
  form.method = "POST";
  form.action = payment.action_url;

  for (const [key, value] of Object.entries(payment.fields)) {
    const input = document.createElement("input");
    input.type = "hidden";
    input.name = key;
    input.value = value;
    form.appendChild(input);
  }

  document.body.appendChild(form);
  form.submit();
}

function showCheckoutError(message) {
  checkoutError.textContent = message;
  checkoutError.style.display = "block";
}

checkoutForm.addEventListener("submit", submitOrderCheckout);

// ---------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------
loadMenu();
renderCart(); // restore any cart carried over from a previous visit
