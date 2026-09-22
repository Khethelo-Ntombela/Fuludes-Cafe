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
async function loadMenu() {
  const grid = document.getElementById("orderItems");
  try {
    const res = await fetch("/api/menu");
    if (!res.ok) throw new Error("Menu request failed");
    const data = await res.json();
    categories = data.categories || [];
    menuItems = data.items || [];
    spiceLevels = data.spice_levels || [];
    renderCategoryTabs();
    renderOrderItems();
    renderSpecialsBar();
  } catch (err) {
    grid.innerHTML = `<p class="menu-empty">Sorry, we couldn't load the menu right now. Please refresh.</p>`;
  }
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
      const photos = item.images && item.images.length > 0 ? item.images : (item.image_url ? [item.image_url] : []);
      const onSpecial = item.is_on_special === true;
      const priceHtml = onSpecial
        ? `<span class="was-price">${money(item.price)}</span>${money(item.effective_price)}`
        : money(item.price);
      return `
    <div class="order-card${item.is_available ? "" : " sold-out"}">
      <div class="order-card-image" ${photos.length > 0 ? `data-id="${item.id}"` : ""}>
        ${photos.length > 0 ? `<img src="${photos[0]}" alt="${item.name}" loading="lazy" />` : ""}
        ${onSpecial ? `<span class="special-badge">Special</span>` : ""}
        ${item.is_available ? "" : `<span class="sold-out-badge">Sold Out</span>`}
        ${photos.length > 1 ? `<span class="photo-count-badge"><i class="fas fa-images"></i> ${photos.length}</span>` : ""}
      </div>
      <div class="order-card-body">
        <div class="order-card-header">
          <span class="order-card-name">${item.name}</span>
          <span class="order-card-dots" aria-hidden="true"></span>
          <span class="order-card-price">${priceHtml}</span>
        </div>
        <p class="order-card-desc">${item.description || ""}</p>
        <div class="order-card-footer">
          <button class="add-to-order-btn" data-id="${item.id}" ${item.is_available ? "" : "disabled"}>
            ${item.is_available ? "Add to Order" : "Sold Out"}
          </button>
        </div>
      </div>
    </div>
  `;
    })
    .join("");

  grid.querySelectorAll(".add-to-order-btn:not([disabled])").forEach((btn) => {
    btn.addEventListener("click", () => handleAddClick(parseInt(btn.dataset.id, 10)));
  });

  grid.querySelectorAll(".order-card-image[data-id]").forEach((el) => {
    el.addEventListener("click", () => openLightbox(parseInt(el.dataset.id, 10)));
  });
}

/** Opens the shared lightbox (site.js) for a dish's photo set. */
function openLightbox(itemId) {
  const item = menuItems.find((i) => i.id === itemId);
  if (!item) return;
  const photos = item.images && item.images.length > 0 ? item.images : (item.image_url ? [item.image_url] : []);
  openLightboxWithPhotos(photos, 0);
}

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
  // Special price (when set) is the real selling price - the server
  // re-checks and re-prices this from the live DB at checkout regardless,
  // but reflecting it here keeps the cart total from looking wrong.
  const effectivePrice = item.special_price !== null && item.special_price !== undefined ? item.special_price : item.price;

  if (existing) {
    existing.quantity += quantity;
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

  const cartItemsEl = document.getElementById("cartItems");
  const cartTotalEl = document.getElementById("cartTotal");
  const checkoutBtn = document.getElementById("checkoutBtn");

  if (cart.length === 0) {
    cartItemsEl.innerHTML = `<p class="cart-empty">Your cart is empty</p>`;
    cartTotalEl.textContent = money(0);
    checkoutBtn.disabled = true;
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
          <div class="cart-item-qty">
            <button class="cart-qty-minus" data-line="${line.lineId}">-</button>
            <span>${line.quantity}</span>
            <button class="cart-qty-plus" data-line="${line.lineId}">+</button>
          </div>
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

  cartItemsEl.querySelectorAll(".cart-qty-minus").forEach((btn) => {
    btn.addEventListener("click", () => changeLineQuantity(btn.dataset.line, -1));
  });
  cartItemsEl.querySelectorAll(".cart-qty-plus").forEach((btn) => {
    btn.addEventListener("click", () => changeLineQuantity(btn.dataset.line, 1));
  });
  cartItemsEl.querySelectorAll(".cart-item-remove").forEach((btn) => {
    btn.addEventListener("click", () => {
      cart = cart.filter((line) => line.lineId !== btn.dataset.line);
      renderCart();
    });
  });
}

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
  proceedToCheckout();
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

/** Sets up geocoding on blur for the delivery address field. */
function setupDeliveryGeocoding(addressInput) {
  if (!addressInput) return;

  // Remove any existing blur listener to avoid duplicates
  addressInput.removeEventListener("blur", handleDeliveryAddressBlur);
  addressInput.addEventListener("blur", handleDeliveryAddressBlur);
}

async function handleDeliveryAddressBlur() {
  const addressInput = document.getElementById("delivery-address");
  const address = addressInput?.value?.trim();
  if (!address) return;

  // Don't re-geocode the same address
  if (address === geocodedDisplayAddress && geocodedDeliveryLat !== null) return;

  deliveryFeeLoading = true;
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
      throw new Error(geoData.error || "Could not find that address");
    }

    geocodedDeliveryLat = geoData.lat;
    geocodedDeliveryLng = geoData.lng;
    geocodedDisplayAddress = geoData.display_name;

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

    if (feeData.too_far) {
      deliveryFee = 0;
      deliveryDistanceKm = feeData.distance_km;
      showCheckoutError(
        `${feeData.message} Call ${feeData.cafe_phone} or email ${feeData.cafe_email}.`
      );
    } else {
      deliveryFee = feeData.fee;
      deliveryDistanceKm = feeData.distance_km;
    }
  } catch (err) {
    deliveryFee = 0;
    deliveryDistanceKm = 0;
    geocodedDeliveryLat = null;
    geocodedDeliveryLng = null;
    geocodedDisplayAddress = "";
    // Don't show error for geocoding failures - let user correct address
    console.warn("Delivery geocoding/fee failed:", err.message);
  } finally {
    deliveryFeeLoading = false;
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

  // Reset delivery fee state
  deliveryFee = 0;
  deliveryDistanceKm = 0;
  geocodedDeliveryLat = null;
  geocodedDeliveryLng = null;
  geocodedDisplayAddress = "";
  deliveryFeeLoading = false;

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
  deliveryFee = 0;
  deliveryDistanceKm = 0;
  geocodedDeliveryLat = null;
  geocodedDeliveryLng = null;
  geocodedDisplayAddress = "";
  deliveryFeeLoading = false;
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
