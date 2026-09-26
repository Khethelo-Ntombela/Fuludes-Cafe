/**
 * public/js/site.js
 * -----------------------------------------------------------------------
 * Shared logic for every customer-facing page: header/mobile nav,
 * customer accounts (sign in/up/out, password reset), the reservation
 * modal, the My Orders modal, the shared photo lightbox, the
 * payment-return banner, buffet visibility, and FAQ accordions.
 *
 * Page-specific logic lives in menu.js (ordering + cart + checkout),
 * reviews.js, catering.js, and contact.js. Load this file first - the
 * page scripts rely on helpers and state declared here.
 * -----------------------------------------------------------------------
 */

const money = (n) => `R${Number(n).toFixed(2)}`;

function userFriendlyError(error, fallback = "Something went wrong. Please try again.") {
  if (error instanceof TypeError && error.message.toLowerCase().includes("fetch")) {
    return "We couldn't connect to the cafe service. Please check your internet connection and try again.";
  }
  return error?.message || fallback;
}

async function readApiResponse(response) {
  const text = await response.text();
  if (!text.trim()) {
    throw new Error(
      response.status >= 500
        ? "The cafe service is temporarily unavailable. Please try again shortly."
        : "The request could not be completed. Please try again.",
    );
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(
      response.status >= 500
        ? "The cafe service is temporarily unavailable. Please try again shortly."
        : "The server returned an unexpected response. Please try again.",
    );
  }
}

// ---------------------------------------------------------------------
// Mobile nav
// ---------------------------------------------------------------------
const mobileToggle = document.getElementById("mobileToggle");
const navbar = document.getElementById("navbar");
mobileToggle.addEventListener("click", () => navbar.classList.toggle("active"));
document.querySelectorAll(".nav-link").forEach((link) => {
  link.addEventListener("click", () => navbar.classList.remove("active"));
});

// ---------------------------------------------------------------------
// Photo lightbox - shared by the dish galleries (menu page) and the
// catering inspiration gallery (catering page). The modal markup exists
// on every page so any script can call openLightboxWithPhotos().
// ---------------------------------------------------------------------
let lightboxPhotos = [];
let lightboxIndex = 0;

const photoLightbox = document.getElementById("photoLightbox");
const lightboxImage = document.getElementById("lightboxImage");
const lightboxCounter = document.getElementById("lightboxCounter");

/** Opens the shared lightbox for any photo set (dish gallery or the catering inspiration gallery). */
function openLightboxWithPhotos(photos, startIndex = 0) {
  if (!photos || photos.length === 0) return;
  lightboxPhotos = photos;
  lightboxIndex = startIndex;
  renderLightbox();
  photoLightbox.classList.add("active");
}

function renderLightbox() {
  lightboxImage.src = lightboxPhotos[lightboxIndex];
  lightboxCounter.textContent =
    lightboxPhotos.length > 1
      ? `${lightboxIndex + 1} / ${lightboxPhotos.length}`
      : "";
  document.getElementById("lightboxPrev").style.display =
    lightboxPhotos.length > 1 ? "flex" : "none";
  document.getElementById("lightboxNext").style.display =
    lightboxPhotos.length > 1 ? "flex" : "none";
}

document
  .getElementById("lightboxClose")
  .addEventListener("click", () => photoLightbox.classList.remove("active"));
photoLightbox.addEventListener("click", (e) => {
  if (e.target === photoLightbox) photoLightbox.classList.remove("active");
});
document.getElementById("lightboxPrev").addEventListener("click", () => {
  lightboxIndex =
    (lightboxIndex - 1 + lightboxPhotos.length) % lightboxPhotos.length;
  renderLightbox();
});
document.getElementById("lightboxNext").addEventListener("click", () => {
  lightboxIndex = (lightboxIndex + 1) % lightboxPhotos.length;
  renderLightbox();
});

// ---------------------------------------------------------------------
// Customer accounts - required to check out. A signed-in session is just
// a long random token in localStorage, sent as `Authorization: Bearer`
// on every request that needs to know who's asking (place/cancel order,
// view order history, log out). There's no expiry - "stay signed in
// until you sign out" - a session only ends via logout or a password
// reset (which signs every session for that account out server-side).
// ---------------------------------------------------------------------
const CUSTOMER_TOKEN_KEY = "fulude_customer_token";
let customerToken = localStorage.getItem(CUSTOMER_TOKEN_KEY);
let currentCustomer = null; // {id, name, email} once confirmed signed in
let pendingCheckoutAfterAuth = false; // true if "Checkout" was clicked before being signed in (menu page)

const accountNavBtn = document.getElementById("accountNavBtn");
const accountNavLabel = document.getElementById("accountNavLabel");
const authModal = document.getElementById("authModal");
const authModalClose = document.getElementById("authModalClose");
const authTabsEl = document.getElementById("authTabs");
const authIntroMessage = document.getElementById("authIntroMessage");
const signInForm = document.getElementById("signInForm");
const signUpForm = document.getElementById("signUpForm");
const forgotPasswordForm = document.getElementById("forgotPasswordForm");
const signInError = document.getElementById("signInError");
const signUpError = document.getElementById("signUpError");
const forgotPasswordError = document.getElementById("forgotPasswordError");
const forgotPasswordSuccess = document.getElementById("forgotPasswordSuccess");
const accountModal = document.getElementById("accountModal");
const accountModalClose = document.getElementById("accountModalClose");
const accountWelcome = document.getElementById("accountWelcome");
const resetPasswordModal = document.getElementById("resetPasswordModal");
const resetPasswordModalClose = document.getElementById(
  "resetPasswordModalClose",
);
const resetPasswordForm = document.getElementById("resetPasswordForm");
const resetPasswordError = document.getElementById("resetPasswordError");

function addPasswordVisibilityToggle(inputId) {
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
  // Eye icon only (no "Show"/"Hide" text); the label keeps it clear for screen readers.
  toggle.innerHTML = '<i class="fas fa-eye" aria-hidden="true"></i>';
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

addPasswordVisibilityToggle("signin-password");
addPasswordVisibilityToggle("signup-password");

/** Runs once on page load: confirms any stored token is still valid, and opens the reset-password form if we landed here from an emailed link. */
async function initAuth() {
  if (customerToken) {
    try {
      const res = await fetch("/api/auth/me", {
        headers: { Authorization: `Bearer ${customerToken}` },
      });
      if (res.ok) {
        const data = await res.json();
        currentCustomer = data.customer;
      } else {
        // Stale/invalid token - e.g. logged out elsewhere, or a password reset invalidated it.
        customerToken = null;
        localStorage.removeItem(CUSTOMER_TOKEN_KEY);
      }
    } catch {
      // Network hiccup - leave the token in place, the next authenticated action will retry.
    }
  }
  updateAccountNav();
  // load any customer-specific data (bookings)
  try {
    loadCustomerBuffetBookings();
  } catch (e) {
    /* ignore */
  }

  // Initialize optional Google Sign-In if configured
  try {
    initGoogleSignIn();
  } catch (e) {
    /* ignore if GIS missing */
  }

  const params = new URLSearchParams(window.location.search);
  const confirmPasswordToken = params.get("confirm_password");
  if (confirmPasswordToken) {
    window.history.replaceState({}, document.title, window.location.pathname);
    confirmPasswordChange(confirmPasswordToken);
  }
  // Tapped an "order update" notification: open My Orders straight away.
  if (params.get("my_orders")) {
    window.history.replaceState({}, document.title, window.location.pathname);
    if (currentCustomer) openMyOrdersModal();
  }
  const resetToken = params.get("reset_token");
  if (resetToken) {
    openResetPasswordModal(resetToken);
    window.history.replaceState({}, document.title, window.location.pathname);
  }
}

function updateAccountNav() {
  accountNavLabel.textContent = currentCustomer
    ? currentCustomer.name.split(" ")[0]
    : "Sign In";
}

// ----------------- Customer buffet bookings (My Bookings) -----------------
const myBuffetModal = document.getElementById("myBuffetModal");
const myBuffetClose = document.getElementById("myBuffetClose");
const myBuffetList = document.getElementById("myBuffetList");

const BOOKING_STATUS_LABELS = {
  pending: "Pending confirmation",
  confirmed: "Confirmed",
  cancelled: "Cancelled",
};

const LIVE_POLL_MS = 5000; // statuses (orders, bookings) refresh on their own - no page reloads

/** Re-runs fn every 5s while `modal` stays open and the tab is visible. */
function pollWhileOpen(modal, fn) {
  if (!modal) return;
  clearInterval(modal._pollTimer);
  modal._pollTimer = setInterval(() => {
    if (!modal.classList.contains("active")) {
      clearInterval(modal._pollTimer);
      return;
    }
    if (!document.hidden) fn();
  }, LIVE_POLL_MS);
}

function setOverlay(el, on) {
  if (!el) return;
  el.style.display = "";
  el.classList.toggle("active", on);
}

let myBuffetBookedEventIds = new Set(); // events with a pending/confirmed booking by this customer

async function loadCustomerBuffetBookings() {
  if (!currentCustomer || !customerToken) {
    myBuffetBookedEventIds = new Set();
    renderPublicBuffet();
    if (myBuffetList) myBuffetList.innerHTML = `<p class="menu-empty">Please sign in to see your buffet bookings.</p>`;
    return;
  }
  try {
    const res = await fetch("/api/buffet-bookings", {
      headers: { Authorization: `Bearer ${customerToken}` },
    });
    if (!res.ok) throw new Error("Failed to load");
    const data = await readApiResponse(res);
    const bookings = data.bookings || [];
    myBuffetBookedEventIds = new Set(
      bookings.filter((b) => b.status === "pending" || b.status === "confirmed").map((b) => Number(b.event_id)),
    );
    renderPublicBuffet();
    if (!myBuffetList) return;
    if (!bookings.length) {
      myBuffetList.innerHTML = `<p class="menu-empty">You have no upcoming buffet bookings.</p>`;
      return;
    }
    myBuffetList.innerHTML = "";
    bookings.forEach((b) => {
      const el = document.createElement("div");
      el.className = "receipt-card";
      const canCancel = b.status === "pending" || b.status === "confirmed";
      const color =
        b.status === "confirmed" ? "#1a7f37" : b.status === "cancelled" ? "#b42318" : "#8a6d1d";
      const pricePerSeat = Number(b.price_cents || 0) / 100;
      const fmtDate = (d) => new Date(d).toLocaleString("en-ZA", { dateStyle: "medium", timeStyle: "short" });
      el.innerHTML = `<div class="receipt-card-header"><strong>${escapeHtml(b.title)}</strong><span class="receipt-meta">Booking #${b.booking_id}</span></div>
        <div class="buffet-receipt">
          <div><span>Event date</span><span>${fmtDate(b.event_date)}</span></div>
          <div><span>Seats</span><span>${b.seats}</span></div>
          <div><span>Price per seat</span><span>R${pricePerSeat.toFixed(2)}</span></div>
          <div><span>Booked on</span><span>${b.created_at ? fmtDate(b.created_at) : "-"}</span></div>
          <div class="buffet-receipt-total"><span>Total</span><span>R${(pricePerSeat * b.seats).toFixed(2)}</span></div>
        </div>
        <div style="margin:8px 0;font-weight:600;color:${color}">Status: ${BOOKING_STATUS_LABELS[b.status] || escapeHtml(b.status)}</div>
        ${canCancel ? `<button class="receipt-cancel-btn btn-cancel-booking" data-id="${b.booking_id}">Cancel booking</button>` : ""}`;
      myBuffetList.appendChild(el);
    });
    myBuffetList.querySelectorAll(".btn-cancel-booking").forEach((btn) =>
      btn.addEventListener("click", async (e) => {
        if (!confirm("Cancel this booking?")) return;
        const id = Number(e.currentTarget.dataset.id);
        try {
          const r = await fetch("/api/buffet-bookings", {
            method: "PUT",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${customerToken}`,
            },
            body: JSON.stringify({ booking_id: id }),
          });
          const d = await r.json();
          if (!r.ok || !d.success) throw new Error(d.error || "Failed");
          await loadCustomerBuffetBookings();
          if (typeof loadPublicBuffet === "function") loadPublicBuffet();
        } catch (err) {
          alert(err.message || "Failed to cancel");
        }
      }),
    );
  } catch (err) {
    if (myBuffetList) myBuffetList.innerHTML = `<p class="menu-empty">Couldn't load your bookings. Please try again.</p>`;
  }
}

/** Opens the "My Buffet Bookings" window (asks the customer to sign in first). */
async function openMyBuffetBookings() {
  if (!currentCustomer) {
    alert("Please sign in to check your buffet bookings.");
    openAuthModal("signin");
    return;
  }
  setOverlay(myBuffetModal, true);
  await loadCustomerBuffetBookings();
  pollWhileOpen(myBuffetModal, loadCustomerBuffetBookings);
}

if (myBuffetClose)
  myBuffetClose.addEventListener("click", () => setOverlay(myBuffetModal, false));

/** Shared by both account entry points - the text+icon link inside the nav, and the standalone icon button next to the mobile menu toggle. */
function openAccountMenu() {
  if (currentCustomer) {
    accountWelcome.textContent = `Signed in as ${currentCustomer.name} (${currentCustomer.email})`;
    accountModal.classList.add("active");
  } else {
    openAuthModal("signin");
  }
}

accountNavBtn.addEventListener("click", openAccountMenu);

function openAuthModal(tab, introText) {
  switchAuthTab(tab || "signin");
  if (introText) {
    authIntroMessage.textContent = introText;
    authIntroMessage.style.display = "block";
  } else {
    authIntroMessage.style.display = "none";
  }
  authModal.classList.add("active");
}

function closeAuthModal() {
  authModal.classList.remove("active");
  pendingCheckoutAfterAuth = false;
}

authModalClose.addEventListener("click", closeAuthModal);
authModal.addEventListener("click", (e) => {
  if (e.target === authModal) closeAuthModal();
});

document.querySelectorAll("#authTabs .auth-tab").forEach((btn) => {
  btn.addEventListener("click", () => switchAuthTab(btn.dataset.authTab));
});

function switchAuthTab(tab) {
  document.querySelectorAll("#authTabs .auth-tab").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.authTab === tab);
  });
  signInForm.style.display = tab === "signin" ? "block" : "none";
  signUpForm.style.display = tab === "signup" ? "block" : "none";
  forgotPasswordForm.style.display = tab === "forgot" ? "block" : "none";
  // Ensure the Google sign-in block is placed inside the currently visible form
  const googleEl = document.querySelector(".auth-google");
  if (googleEl) {
    if (tab === "signin") {
      // place immediately after the sign-in form so it's visible
      if (signInForm && signInForm.parentNode)
        signInForm.parentNode.insertBefore(googleEl, signInForm.nextSibling);
      // ensure there's an `or` divider before the Google block (avoid duplicates)
      const before = googleEl.previousElementSibling;
      if (!before || !before.classList.contains("auth-divider")) {
        const divider = document.createElement("div");
        divider.className = "auth-divider";
        divider.textContent = "or";
        signInForm.parentNode.insertBefore(divider, googleEl);
      }
      // remove any `or` that appears after the Google block
      const after = googleEl.nextElementSibling;
      if (
        after &&
        after.classList &&
        after.classList.contains("auth-divider")
      ) {
        after.remove();
      }
      googleEl.style.display = "block";
    } else if (tab === "signup") {
      // keep it at the end of the signup form
      if (signUpForm) {
        // remove any existing dividers inside the signup form (prevents stray 'or' at top)
        signUpForm.querySelectorAll(".auth-divider").forEach((d) => d.remove());
        // also remove any stray dividers that are siblings in the modal container
        if (signUpForm.parentNode) {
          Array.from(
            signUpForm.parentNode.querySelectorAll(".auth-divider"),
          ).forEach((d) => d.remove());
        }
        signUpForm.appendChild(googleEl);
        // insert a single divider immediately before the Google block
        const divider = document.createElement("div");
        divider.className = "auth-divider";
        divider.textContent = "or";
        signUpForm.insertBefore(divider, googleEl);
        // remove any trailing divider after the Google block
        const after2 = googleEl.nextElementSibling;
        if (
          after2 &&
          after2.classList &&
          after2.classList.contains("auth-divider")
        )
          after2.remove();
      }
      googleEl.style.display = "block";
    } else {
      googleEl.style.display = "none";
    }
    // update button label to match context
    const gbtn = document.getElementById("googleSignInBtn");
    if (gbtn) {
      if (tab === "signup") {
        gbtn.textContent = "Create account with Google";
        gbtn.setAttribute("aria-label", "Create account with Google");
      } else {
        gbtn.textContent = "Sign in with Google";
        gbtn.setAttribute("aria-label", "Sign in with Google");
      }
    }
  }
  authTabsEl.style.display = tab === "forgot" ? "none" : "flex";
  signInError.style.display = "none";
  signUpError.style.display = "none";
  forgotPasswordError.style.display = "none";
  forgotPasswordSuccess.style.display = "none";
}

document
  .getElementById("forgotPasswordLink")
  .addEventListener("click", () => switchAuthTab("forgot"));
document
  .getElementById("backToSignInLink")
  .addEventListener("click", () => switchAuthTab("signin"));

signInForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  signInError.style.display = "none";
  const email = document.getElementById("signin-email").value.trim();
  const password = document.getElementById("signin-password").value;

  try {
    const res = await fetch("/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password }),
    });
    const data = await readApiResponse(res);
    if (!res.ok || !data.success)
      throw new Error(data.error || "Couldn't sign in.");

    signInForm.reset();
    onAuthSuccess(data.token, data.customer);
  } catch (err) {
    signInError.textContent = userFriendlyError(
      err,
      "Sorry, we couldn't sign you in right now. Please try again.",
    );
    signInError.style.display = "block";
  }
});

signUpForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  signUpError.style.display = "none";
  const name = document.getElementById("signup-name").value.trim();
  const email = document.getElementById("signup-email").value.trim();
  const password = document.getElementById("signup-password").value;

  try {
    const res = await fetch("/api/auth/signup", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, email, password }),
    });
    const data = await readApiResponse(res);
    if (!res.ok || !data.success)
      throw new Error(data.error || "Couldn't create your account.");

    if (data.pending_verification) {
      signUpForm.reset();
      signUpError.textContent =
        data.message ||
        "Check your email to verify your account before signing in.";
      signUpError.style.display = "block";
      return;
    }

    signUpForm.reset();
    onAuthSuccess(data.token, data.customer);
  } catch (err) {
    signUpError.textContent = userFriendlyError(
      err,
      "We couldn't create your account. Please try again.",
    );
    signUpError.style.display = "block";
  }
});

forgotPasswordForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  forgotPasswordError.style.display = "none";
  forgotPasswordSuccess.style.display = "none";
  const email = document.getElementById("forgot-email").value.trim();

  try {
    const res = await fetch("/api/auth/forgot-password", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email }),
    });
    const data = await res.json();
    if (!res.ok || !data.success)
      throw new Error(data.error || "Couldn't process that request.");

    forgotPasswordSuccess.textContent =
      data.message ||
      "If that email has an account, a reset link is on its way.";
    forgotPasswordSuccess.style.display = "block";
    forgotPasswordForm.reset();
  } catch (err) {
    forgotPasswordError.textContent = userFriendlyError(
      err,
      "We couldn't send the reset email. Please try again.",
    );
    forgotPasswordError.style.display = "block";
  }
});

/** Shared success path for both sign-in and sign-up - stores the session, then either closes the modal or, if "Checkout" is what triggered sign-in (menu page), chains straight into checkout. */
function onAuthSuccess(token, customer) {
  customerToken = token;
  currentCustomer = customer;
  localStorage.setItem(CUSTOMER_TOKEN_KEY, token);
  updateAccountNav();
  loadCustomerBuffetBookings();

  authModal.classList.remove("active");
  if (pendingCheckoutAfterAuth) {
    pendingCheckoutAfterAuth = false;
    if (typeof proceedToCheckout === "function") {
      // Don't skip the out-of-service check just because they signed in first.
      fetchStoreConfig().then((config) => {
        if (config && config.is_out_of_service) showOutOfServiceNotice(config.out_of_service_reason);
        else proceedToCheckout();
      });
    }
  }
}

// ---------------- Google Sign-In ----------------
function getGoogleClientId() {
  const m = document.querySelector('meta[name="google-client-id"]');
  return m ? (m.content || "").trim() : "";
}

function initGoogleSignIn() {
  const clientId = getGoogleClientId();
  if (!clientId) return;
  if (typeof google === "undefined" || !google.accounts || !google.accounts.id)
    return;

  google.accounts.id.initialize({
    client_id: clientId,
    callback: handleGoogleCredential,
  });

  // The real Google button is rendered into #googleSignInContainer, which
  // is stacked invisibly (opacity: 0) directly on top of the styled
  // #googleSignInBtn via CSS (position: absolute; inset: 0) - see the
  // .auth-google markup. The user's click lands on Google's real button,
  // which reliably opens the sign-in flow. We deliberately do NOT also
  // wire #googleSignInBtn to google.accounts.id.prompt() - that's Google's
  // "One Tap" prompt, which fails completely silently (no popup, no
  // error) under common conditions like blocked third-party cookies or
  // FedCM restrictions, and would double-fire alongside the overlay click.
  const container = document.getElementById("googleSignInContainer");
  if (container) {
    google.accounts.id.renderButton(container, {
      theme: "outline",
      size: "large",
      width: "100%",
    });
  }
}

async function handleGoogleCredential(response) {
  if (!response || !response.credential) return;
  try {
    const res = await fetch("/api/auth/google", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id_token: response.credential }),
    });
    const data = await res.json();
    if (!res.ok || !data.success) {
      if (data.error === "account_exists_use_password") {
        throw new Error(
          data.message ||
            "An account with this email already exists. Please sign in with your password instead.",
        );
      }
      throw new Error(data.error || "Google sign-in failed");
    }
    onAuthSuccess(data.token, data.customer);
  } catch (err) {
    // surface error in sign-in form area
    const el = document.getElementById("signInError");
    if (el) {
      el.textContent = err.message || "Google sign-in failed";
      el.style.display = "block";
    }
  }
}

// ---- Reset password (from the emailed link) ----
let activeResetToken = null;

function openResetPasswordModal(token) {
  activeResetToken = token;
  resetPasswordError.style.display = "none";
  resetPasswordModal.classList.add("active");
}

// ----------------- Buffet public UI -----------------
let publicBuffetEvents = null; // last /api/buffet result, so bookings can re-render it

async function loadPublicBuffet() {
  const el = document.getElementById("buffetContent");
  if (!el) return;
  try {
    const res = await fetch("/api/buffet");
    const data = await res.json();
    publicBuffetEvents = data.events || [];
    renderPublicBuffet();
  } catch (err) {
    el.innerHTML = "<p>Failed to load buffet events.</p>";
  }
}

/** "Sat, 3 Oct 2026 · 21:58" */
function buffetWhen(value) {
  const d = new Date(value);
  if (isNaN(d.getTime())) return "";
  return `${d.toLocaleDateString("en-ZA", { weekday: "short", day: "numeric", month: "short", year: "numeric" })} · ${d.toLocaleTimeString("en-ZA", { hour: "2-digit", minute: "2-digit" })}`;
}

/** Events the customer already holds a live booking for get "Check My Booking" instead of "Book". */
function renderPublicBuffet() {
  const el = document.getElementById("buffetContent");
  if (!el || !publicBuffetEvents) return;
  const events = publicBuffetEvents;
  if (!events.length) {
    el.innerHTML = "<p>No upcoming buffet events.</p>";
    return;
  }
  el.innerHTML = events
    .map((evt) => {
      const booked = myBuffetBookedEventIds.has(Number(evt.id));
      const soldOut = evt.seats_remaining <= 0;
      const action = booked
        ? `<button type="button" class="btn btn-gold btn-buffet btn-check-buffet">Check My Booking</button>`
        : `<button type="button" class="btn btn-primary btn-buffet btn-book-buffet" data-id="${evt.id}" data-title="${escapeHtml(evt.title)}" ${soldOut ? "disabled" : ""}>${soldOut ? "Sold out" : "Book"}</button>`;
      return `
      <div class="sa-card buffet-card" data-event-id="${evt.id}">
        ${(evt.photos || []).length ? `<div class="buffet-card-photos">${evt.photos.map((ph) => `<img src="${escapeHtml(ph)}" alt="${escapeHtml(evt.title)}" loading="lazy" style="height:180px;max-width:100%;object-fit:cover;border-radius:6px;flex:0 0 auto" onerror="this.style.display='none'" />`).join("")}</div>` : ""}
        <div class="sa-card-title">${escapeHtml(evt.title)}</div>
        <div class="buffet-when"><i class="far fa-calendar"></i> ${buffetWhen(evt.event_date)}</div>
        ${evt.description ? `<p class="buffet-desc">${escapeHtml(evt.description)}</p>` : ""}
        <ul class="buffet-details">
          <li><strong>Seats:</strong> ${evt.seats_remaining} of ${evt.capacity} left</li>
          <li><strong>Price:</strong> R${(Number(evt.price_cents) / 100).toFixed(2)} per seat</li>
        </ul>
        <div class="buffet-actions">${action}</div>
        ${evt.booking_closes_at ? `<div class="admin-hint">Booking closes ${buffetWhen(evt.booking_closes_at)}</div>` : ""}
      </div>`;
    })
    .join("");

  el.querySelectorAll(".btn-check-buffet").forEach((b) => b.addEventListener("click", openMyBuffetBookings));
  el.querySelectorAll(".btn-book-buffet").forEach((b) =>
    b.addEventListener("click", () => openBuffetBookingModal(b.dataset.id, b.dataset.title)),
  );
}

function escapeHtml(s) {
  return String(s || "").replace(
    /[&<>"']/g,
    (c) => "&#" + c.charCodeAt(0) + ";",
  );
}

function openBuffetBookingModal(eventId, title) {
  const modal = document.getElementById("buffetBookingModal");
  if (!modal) return;
  document.getElementById("buffetModalTitle").textContent = `Book: ${title}`;
  document.getElementById("buffetEventId").value = eventId;
  if (currentCustomer) {
    document.getElementById("buffetName").value = currentCustomer.name || "";
    document.getElementById("buffetEmail").value = currentCustomer.email || "";
    document.getElementById("buffetPhone").value =
      currentCustomer.phone_number || "";
  } else {
    document.getElementById("buffetName").value = "";
    document.getElementById("buffetEmail").value = "";
    document.getElementById("buffetPhone").value = "";
  }
  document.getElementById("buffetBookingError").style.display = "none";
  document.getElementById("buffetBookingSuccess").style.display = "none";
  setOverlay(modal, true);
}

document.getElementById("buffetBookingClose")?.addEventListener("click", () => {
  setOverlay(document.getElementById("buffetBookingModal"), false);
});

document
  .getElementById("buffetBookingForm")
  ?.addEventListener("submit", async (e) => {
    e.preventDefault();
    const event_id = Number(document.getElementById("buffetEventId").value);
    const name = document.getElementById("buffetName").value.trim();
    const email = document.getElementById("buffetEmail").value.trim();
    const phone = document.getElementById("buffetPhone").value.trim();
    const seats = Number(document.getElementById("buffetSeats").value) || 1;
    const errEl = document.getElementById("buffetBookingError");
    const okEl = document.getElementById("buffetBookingSuccess");
    errEl.style.display = "none";
    okEl.style.display = "none";
    const missing = [];
    if (!name) missing.push("your name");
    if (!email) missing.push("your email");
    if (!phone) missing.push("your WhatsApp number");
    if (missing.length) {
      errEl.textContent = `Please add ${missing.join(", ")} to book.`;
      errEl.style.display = "block";
      return;
    }
    try {
      const res = await fetch("/api/buffet", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(customerToken ? { Authorization: `Bearer ${customerToken}` } : {}),
        },
        body: JSON.stringify({ event_id, name, email, phone, seats }),
      });
      const data = await res.json();
      if (!res.ok || !data.success)
        throw new Error(data.error || "Booking failed");
      okEl.textContent =
        "Booking received! We should send your confirmation on WhatsApp shortly. You can check the status anytime under “Check My Bookings”.";
      okEl.style.display = "block";
      document.getElementById("buffetBookingForm").reset();
      // refresh events/bookings availability
      loadPublicBuffet();
      loadCustomerBuffetBookings();
    } catch (err) {
      errEl.textContent = err.message || "Booking failed";
      errEl.style.display = "block";
    }
  });

resetPasswordModalClose.addEventListener("click", () =>
  resetPasswordModal.classList.remove("active"),
);
resetPasswordModal.addEventListener("click", (e) => {
  if (e.target === resetPasswordModal)
    resetPasswordModal.classList.remove("active");
});

resetPasswordForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  resetPasswordError.style.display = "none";
  const password = document.getElementById("reset-new-password").value;

  try {
    const res = await fetch("/api/auth/reset-password", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: activeResetToken, password }),
    });
    const data = await res.json();
    if (!res.ok || !data.success)
      throw new Error(data.error || "Couldn't reset your password.");

    resetPasswordModal.classList.remove("active");
    resetPasswordForm.reset();
    alert(
      "Your password has been reset. Please sign in with your new password.",
    );
    openAuthModal("signin");
  } catch (err) {
    resetPasswordError.textContent = err.message;
    resetPasswordError.style.display = "block";
  }
});

// ---- Account modal (signed-in state) ----
accountModalClose.addEventListener("click", () =>
  accountModal.classList.remove("active"),
);
accountModal.addEventListener("click", (e) => {
  if (e.target === accountModal) accountModal.classList.remove("active");
});

document
  .getElementById("viewMyOrdersFromAccountBtn")
  .addEventListener("click", () => {
    accountModal.classList.remove("active");
    openMyOrdersModal();
  });

document.getElementById("logoutBtn").addEventListener("click", async () => {
  try {
    await fetch("/api/auth/logout", {
      method: "POST",
      headers: { Authorization: `Bearer ${customerToken}` },
    });
  } catch {
    // Even if the request fails, forget the token locally - logging out should always work from the customer's point of view.
  }
  customerToken = null;
  currentCustomer = null;
  localStorage.removeItem(CUSTOMER_TOKEN_KEY);
  updateAccountNav();
  accountModal.classList.remove("active");
  loadCustomerBuffetBookings();
});

// ---------------------------------------------------------------------
// Reservation modal - reachable from the nav on every page (plus the
// hero button on the home page and the cart panel on the menu page).
// ---------------------------------------------------------------------
const navReservationLink = document.getElementById("navReservationLink");
const heroReservationBtn = document.getElementById("heroReservationBtn");
const menuReservationBtn = document.getElementById("menuReservationBtn");
const reservationBtn = document.getElementById("reservationBtn");
const reservationModal = document.getElementById("reservationModal");
const reservationModalClose = document.getElementById("reservationModalClose");
const reservationForm = document.getElementById("reservationForm");
const reservationError = document.getElementById("reservationError");
const reservationSuccess = document.getElementById("reservationSuccess");
const reservationAdvanceOrderCheckbox = document.getElementById(
  "reservation-advance-order",
);
const reservationAdvanceInfo = document.getElementById(
  "reservationAdvanceInfo",
);
const reservationAdvanceInfoText = document.getElementById(
  "reservationAdvanceInfoText",
);
const reservationGoToMenuBtn = document.getElementById(
  "reservationGoToMenuBtn",
);

// ---- Opening hours (South Africa time) - keep in sync with functions/_lib/hours.js ----
const OPENING_HOURS = { open: 9 * 60, close: { 0: 20 * 60, 1: 18 * 60, 2: 18 * 60, 3: 18 * 60, 4: 18 * 60, 5: 20 * 60, 6: 21 * 60 } };
const NOT_OPEN_MESSAGE = "Sorry, try a different time because we don't operate at the time you chose.";

/** Returns an error message when the chosen date/time isn't bookable, else "". */
function checkReservationSlot(dateStr, timeStr) {
  const d = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateStr || "");
  const t = /^(\d{1,2}):(\d{2})/.exec(timeStr || "");
  if (!d || !t) return "Please choose both a date and a time for your reservation.";
  const weekday = new Date(Date.UTC(+d[1], +d[2] - 1, +d[3])).getUTCDay();
  const minutes = +t[1] * 60 + +t[2];
  if (minutes < OPENING_HOURS.open || minutes >= OPENING_HOURS.close[weekday]) return NOT_OPEN_MESSAGE;
  const now = new Date();
  const todayKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
  if (dateStr < todayKey || (dateStr === todayKey && minutes <= now.getHours() * 60 + now.getMinutes())) {
    return "That date and time has already passed. Please choose a future time.";
  }
  return "";
}

/** Is the cafe open right now? Uses South Africa time, whatever the device's timezone. */
function isCafeOpenNow() {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Africa/Johannesburg", weekday: "short", hour: "2-digit", minute: "2-digit", hour12: false,
  }).formatToParts(new Date());
  const get = (t) => parts.find((p) => p.type === t)?.value;
  const weekday = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(get("weekday"));
  const minutes = (+get("hour") % 24) * 60 + +get("minute");
  return minutes >= OPENING_HOURS.open && minutes < OPENING_HOURS.close[weekday];
}
const CLOSED_MESSAGE = "Can't order at this time, we are currently closed.";

/** Reads a fetch response as JSON without throwing when the server sent an HTML error page. */
async function safeJson(res) {
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    return { error: `The service isn't responding right now (error ${res.status}). Please try again in a moment, or call the cafe to order.` };
  }
}

/** "2026-09-24" + "13:30" -> "Thu, 24 Sep 2026 at 13:30" (never "Invalid Date"). */
function formatReservationWhen(dateStr, timeStr) {
  const iso = String(dateStr || "").slice(0, 10);
  const d = new Date(`${iso}T00:00:00`);
  const dateLabel = isNaN(d.getTime())
    ? iso
    : d.toLocaleDateString("en-ZA", { weekday: "short", day: "numeric", month: "short", year: "numeric" });
  const time = timeStr ? String(timeStr).slice(0, 5) : "";
  return time ? `${dateLabel} at ${time}` : dateLabel;
}

const ACTIVE_RES_KEY = "fulude_active_reservation"; // the booking a pre-order belongs to
const MY_RES_KEY = "fulude_my_reservations"; // guests: bookings sent from this device

function todayKeyLocal() {
  const n = new Date();
  return `${n.getFullYear()}-${String(n.getMonth() + 1).padStart(2, "0")}-${String(n.getDate()).padStart(2, "0")}`;
}
function getActiveReservation() {
  try {
    const r = JSON.parse(localStorage.getItem(ACTIVE_RES_KEY) || "null");
    if (r && r.date >= todayKeyLocal()) return r;
  } catch { /* ignore */ }
  localStorage.removeItem(ACTIVE_RES_KEY);
  return null;
}
function rememberReservation(r) {
  try {
    const list = JSON.parse(localStorage.getItem(MY_RES_KEY) || "[]").filter((x) => x.id !== r.id);
    list.unshift(r);
    localStorage.setItem(MY_RES_KEY, JSON.stringify(list.slice(0, 5)));
  } catch { /* ignore */ }
}

// Existing-booking panel shown at the top of the reservation modal
const reservationExisting = document.createElement("div");
reservationExisting.id = "reservationExisting";
reservationForm.parentNode.insertBefore(reservationExisting, reservationForm);

async function loadExistingReservations() {
  let list = [];
  const today = todayKeyLocal();
  if (currentCustomer && customerToken) {
    try {
      const res = await fetch("/api/reservations", { headers: { Authorization: `Bearer ${customerToken}` } });
      if (res.ok) list = (await res.json()).reservations || [];
    } catch { /* fall through to local copy */ }
  }
  if (!list.length) {
    try { list = JSON.parse(localStorage.getItem(MY_RES_KEY) || "[]"); } catch { list = []; }
  }
  list = list.filter((r) => String(r.reservation_date || r.date).slice(0, 10) >= today && r.status !== "Completed");
  if (!list.length) {
    reservationExisting.innerHTML = "";
    reservationForm.style.display = "block";
    return;
  }
  const colors = { Confirmed: "#1a7f37", Cancelled: "#b42318", Pending: "#8a6d1d", AwaitingPayment: "#8a6d1d" };
  const labels = { AwaitingPayment: "Waiting for your pre-order payment" };
  reservationExisting.innerHTML =
    `<h4 style="margin:0 0 8px">Your reservation${list.length > 1 ? "s" : ""}</h4>` +
    list.map((r) => {
      const date = r.reservation_date || r.date;
      const time = r.reservation_time || r.time;
      const size = r.party_size || r.party;
      const status = r.status || "Pending";
      const prepaid = ["paid", "refunded"].includes(r.preorder_payment_status);
      const unpaidOrder = r.advance_order_id && ["awaiting", "failed"].includes(r.preorder_payment_status);
      // Day and time as the customer reads them: "Saturday, 26 September" at "15:00"
      const day = new Date(`${String(date).slice(0, 10)}T00:00:00`).toLocaleDateString("en-ZA", { weekday: "long", day: "numeric", month: "long" });
      const hhmm = String(time || "").slice(0, 5);
      const name = escapeHtml(r.customer_name || currentCustomer?.name || "there");
      let note = "";
      if (status === "Confirmed" && prepaid) {
        note = "Thank you, we have received your reservation and order. We look forward to seeing you! If there are any changes we will let you know.";
      } else if (status === "Cancelled") {
        note = `Hi ${name}, your table booking at Fulude's Cafe for ${day} at ${hhmm} has been cancelled${prepaid ? " and will be refunded" : ""}. Please contact us if you need any further assistance.`;
      } else if (status === "AwaitingPayment") {
        note = "Your table is held until your pre-order is paid - it's confirmed as soon as the payment goes through.";
      }
      const action =
        status !== "AwaitingPayment"
          ? ""
          : unpaidOrder
            ? `<button type="button" class="receipt-cancel-btn" data-pay-preorder="${r.advance_order_id}">Pay for my pre-order${r.preorder_total ? ` (${money(r.preorder_total)})` : ""}</button>`
            : `<button type="button" class="receipt-cancel-btn" data-continue-preorder="${r.id}" data-date="${escapeHtml(String(date).slice(0, 10))}" data-time="${escapeHtml(hhmm)}" data-party="${size}">Continue pre-order</button>`;
      return `<div class="receipt-card" style="margin-bottom:10px">
        <div class="receipt-card-header"><strong>${escapeHtml(formatReservationWhen(date, time))}</strong></div>
        <div class="receipt-meta">${size} guest${size > 1 ? "s" : ""}${r.table_number ? ` · Table ${escapeHtml(r.table_number)}` : ""}${prepaid ? ` · Pre-order ${r.preorder_payment_status === "refunded" ? "refunded" : "paid"}` : ""}</div>
        <div style="margin:6px 0;font-weight:600;color:${colors[status] || "#8a6d1d"}">Status: ${escapeHtml(labels[status] || status)}${status === "Pending" ? " (we should confirm on WhatsApp)" : ""}</div>
        ${note ? `<p class="reservation-note${status === "Cancelled" ? " is-cancelled" : ""}">${note}</p>` : ""}
        ${action}
      </div>`;
    }).join("");
  reservationExisting.querySelectorAll("[data-pay-preorder]").forEach((btn) =>
    btn.addEventListener("click", async () => {
      btn.disabled = true;
      try {
        const res = await fetch("/api/order/retry", {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${customerToken}` },
          body: JSON.stringify({ id: Number(btn.dataset.payPreorder) }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok || !(data.payment?.redirect_url || data.payment?.action_url)) throw new Error(data.error || "Couldn't start the payment.");
        goToYocoPayment(data.payment);
      } catch (err) {
        alert(err.message);
        btn.disabled = false;
      }
    }),
  );
  reservationExisting.querySelectorAll("[data-continue-preorder]").forEach((btn) =>
    btn.addEventListener("click", () => {
      startPreorder({
        id: Number(btn.dataset.continuePreorder),
        date: btn.dataset.date,
        time: btn.dataset.time,
        party: Number(btn.dataset.party),
        name: currentCustomer?.name || "",
        phone: currentCustomer?.phone_number || "",
      });
    }),
  );
  // One live booking at a time (the server enforces this per email too):
  // the form only comes back once every booking is cancelled.
  const hasLive = list.some((r) => (r.status || "Pending") !== "Cancelled");
  reservationForm.style.display = hasLive ? "none" : "block";
}

/** Remember the booking as the pre-order target and go to the cart (items already in it stay). */
function startPreorder(r) {
  localStorage.setItem(ACTIVE_RES_KEY, JSON.stringify(r));
  reservationModal.classList.remove("active");
  if (document.getElementById("cartPageBack") || document.querySelector(".cart-panel")) {
    window.dispatchEvent(new CustomEvent("fulude:preorder"));
  } else {
    window.location.href = "menu.html?preorder=1";
  }
}

function openReservationModal() {
  reservationError.style.display = "none";
  reservationSuccess.style.display = "none";
  reservationForm.reset();
  reservationAdvanceInfo.style.display = "none";
  if (currentCustomer) {
    document.getElementById("reservation-name").value =
      currentCustomer.name || "";
    document.getElementById("reservation-email").value =
      currentCustomer.email || "";
    document.getElementById("reservation-phone").value =
      currentCustomer.phone_number || "";
  }
  const dateInput = document.getElementById("reservation-date");
  if (dateInput) dateInput.min = todayKeyLocal();
  reservationModal.classList.add("active");
  loadExistingReservations();
  pollWhileOpen(reservationModal, loadExistingReservations);
}

if (navReservationLink) {
  navReservationLink.addEventListener("click", (e) => {
    e.preventDefault();
    openReservationModal();
  });
}
if (heroReservationBtn) heroReservationBtn.addEventListener("click", openReservationModal);
if (menuReservationBtn) menuReservationBtn.addEventListener("click", openReservationModal);
if (reservationBtn) reservationBtn.addEventListener("click", openReservationModal);

reservationModalClose.addEventListener("click", () =>
  reservationModal.classList.remove("active"),
);
reservationModal.addEventListener("click", (e) => {
  if (e.target === reservationModal)
    reservationModal.classList.remove("active");
});

function redirectToSignup() {
  reservationModal.classList.remove("active");
  openAuthModal(
    "signup",
    "Create an account to request advance food ordering and checkout.",
  );
}

// Ticking "pre-order" no longer redirects on its own - it only explains what happens next.
reservationAdvanceOrderCheckbox.addEventListener("change", () => {
  if (reservationAdvanceOrderCheckbox.checked) {
    reservationAdvanceInfo.style.display = "block";
    reservationAdvanceInfoText.textContent = currentCustomer
      ? "After you book, we'll open your cart so you can add, edit or remove items and check out. Items already in your cart are included."
      : "Pre-ordering needs an account. You'll be asked to sign in or create one when you book.";
  } else {
    reservationAdvanceInfo.style.display = "none";
  }
});
reservationGoToMenuBtn.style.display = "none";

reservationForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  reservationError.style.display = "none";
  reservationSuccess.style.display = "none";

  if (reservationAdvanceOrderCheckbox.checked && !currentCustomer) {
    reservationError.textContent =
      "Advanced food ordering requires an account. Please sign in or create an account, then choose your items from the menu to checkout.";
    reservationError.style.display = "block";
    reservationModal.classList.remove("active");
    openAuthModal(
      "signup",
      "Create an account to request advance food ordering and checkout.",
    );
    return;
  }

  const slotError = checkReservationSlot(
    document.getElementById("reservation-date").value,
    document.getElementById("reservation-time").value,
  );
  if (slotError) {
    reservationError.textContent = slotError;
    reservationError.style.display = "block";
    return;
  }

  const payload = {
    name: document.getElementById("reservation-name").value.trim(),
    email: document.getElementById("reservation-email").value.trim(),
    phone: document.getElementById("reservation-phone").value.trim(),
    reservation_date: document.getElementById("reservation-date").value,
    reservation_time: document.getElementById("reservation-time").value,
    party_size: parseInt(
      document.getElementById("reservation-party-size").value,
      10,
    ),
    notes: document.getElementById("reservation-notes").value.trim(),
    advance_order_requested: reservationAdvanceOrderCheckbox.checked,
  };

  try {
    const headers = { "Content-Type": "application/json" };
    if (currentCustomer && customerToken) {
      headers.Authorization = `Bearer ${customerToken}`;
    }

    const res = await fetch("/api/reservations", {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
    });
    const data = await res.json();
    if (!res.ok || !data.success)
      throw new Error(data.error || "Couldn't book the reservation.");

    const booked = {
      id: data.reservation_id,
      date: payload.reservation_date,
      time: payload.reservation_time,
      party: payload.party_size,
      party_size: payload.party_size,
      name: payload.name,
      phone: payload.phone,
      status: payload.advance_order_requested ? "AwaitingPayment" : "Pending",
      advance_order_requested: payload.advance_order_requested,
    };
    rememberReservation(booked);
    reservationForm.reset();
    reservationAdvanceInfo.style.display = "none";
    if (payload.advance_order_requested) {
      // Keep whatever is already in the cart; the menu page opens the cart with dine-in fixed.
      startPreorder(booked);
      return;
    }
    reservationSuccess.textContent =
      "Thank you! We should send your confirmation on WhatsApp shortly. You can reopen “Book Reservation” anytime to see its status.";
    reservationSuccess.style.display = "block";
    loadExistingReservations();
  } catch (err) {
    reservationError.textContent = err.message;
    reservationError.style.display = "block";
  }
});

// ---------------------------------------------------------------------
// My Orders: every order ever placed on the signed-in account, fetched
// fresh from /api/order/my each time - accounts are required to check
// out, so order history just lives on the account server-side.
// ---------------------------------------------------------------------
const myOrdersModal = document.getElementById("myOrdersModal");
const myOrdersList = document.getElementById("myOrdersList");
const MY_ORDERS_POLL_MS = LIVE_POLL_MS; // status can change any time the kitchen updates it
const CUSTOMER_CANCEL_WINDOW_MS = 2 * 60 * 1000; // keep in sync with CUSTOMER_CANCEL_WINDOW_MS in functions/api/order.js
let expandedReceipts = new Set(); // which order ids currently have "View Receipt" open
let myOrdersPollTimer = null;
let cancelCountdownTimer = null;

/** Loads js/pwa.js once (only customers who open My Orders need it). */
let pwaScriptPromise = null;
function loadPwaScript() {
  if (typeof FuludePWA !== "undefined") return Promise.resolve();
  pwaScriptPromise =
    pwaScriptPromise ||
    new Promise((resolve, reject) => {
      const s = document.createElement("script");
      s.src = "js/pwa.js";
      s.onload = resolve;
      s.onerror = reject;
      document.head.appendChild(s);
    });
  return pwaScriptPromise;
}

/** "Notify me about my orders" switch at the top of My Orders (push works even with the app closed). */
function setupOrderNotifyToggle() {
  if (document.getElementById("orderNotifyBtn")) return;
  const btn = document.createElement("button");
  btn.type = "button";
  btn.id = "orderNotifyBtn";
  btn.className = "receipt-cancel-btn";
  btn.style.cssText = "margin:0 0 12px;background:#000;color:#fff;border-color:#000";
  myOrdersList.parentNode.insertBefore(btn, myOrdersList);
  loadPwaScript()
    .then(() => {
      if (!FuludePWA.pushSupported() && !/iphone|ipad|ipod/i.test(navigator.userAgent)) {
        btn.remove();
        return;
      }
      FuludePWA.bindPushToggle(btn, "customer", () => customerToken, {
        onLabel: "Order notifications on",
        offLabel: "Notify me about my orders",
      });
    })
    .catch(() => btn.remove());
}

async function openMyOrdersModal() {
  myOrdersModal.classList.add("active");
  if (currentCustomer) setupOrderNotifyToggle();
  await refreshMyOrders();

  clearInterval(myOrdersPollTimer);
  myOrdersPollTimer = setInterval(refreshMyOrders, MY_ORDERS_POLL_MS);
  startCancelCountdownTicker();
}

function closeMyOrdersModal() {
  myOrdersModal.classList.remove("active");
  clearInterval(myOrdersPollTimer);
  myOrdersPollTimer = null;
  stopCancelCountdownTicker();
}

/** "173" (seconds) -> "2:53" */
function formatCountdown(ms) {
  const totalSeconds = Math.max(0, Math.ceil(ms / 1000));
  const mins = Math.floor(totalSeconds / 60);
  const secs = totalSeconds % 60;
  return `${mins}:${String(secs).padStart(2, "0")}`;
}

/**
 * Ticks every second purely to keep each order's cancel countdown fresh
 * (and to drop the button the instant the 2-minute window closes) -
 * separate from the 5s network poll so the countdown doesn't look stuck.
 */
function startCancelCountdownTicker() {
  clearInterval(cancelCountdownTimer);
  cancelCountdownTimer = setInterval(() => {
    document.querySelectorAll("[data-cancel-order]").forEach((btn) => {
      const expiresAt = parseInt(btn.dataset.cancelExpiresAt, 10);
      const msLeft = expiresAt - Date.now();
      if (msLeft <= 0) {
        btn.closest(".receipt-cancel-row")?.remove();
        return;
      }
      const countdownEl = btn.querySelector("[data-cancel-countdown]");
      if (countdownEl)
        countdownEl.textContent = `(${formatCountdown(msLeft)} left)`;
    });
  }, 1000);
}

function stopCancelCountdownTicker() {
  clearInterval(cancelCountdownTimer);
  cancelCountdownTimer = null;
}

async function refreshMyOrders() {
  if (!currentCustomer) {
    myOrdersList.innerHTML = `<p class="menu-empty">Please sign in to view your orders.</p>`;
    clearInterval(myOrdersPollTimer);
    return;
  }

  if (!myOrdersList.querySelector(".receipt-card")) {
    myOrdersList.innerHTML = `<p class="menu-loading">Loading your orders…</p>`;
  }

  try {
    const res = await fetch("/api/order/my", {
      headers: { Authorization: `Bearer ${customerToken}` },
    });
    if (res.status === 401) {
      myOrdersList.innerHTML = `<p class="menu-empty">Your session has expired. Please sign in again.</p>`;
      clearInterval(myOrdersPollTimer);
      return;
    }
    const data = await res.json();
    const orders = data.orders || [];

    if (orders.length === 0) {
      myOrdersList.innerHTML = `<p class="menu-empty">You have no orders from the last 24 hours.</p>`;
      return;
    }

    myOrdersList.innerHTML = orders.map(renderReceiptCard).join("");
  } catch {
    myOrdersList.innerHTML = `<p class="menu-empty">Couldn't load your orders right now. Please try again.</p>`;
    return;
  }

  myOrdersList.querySelectorAll("[data-toggle-receipt]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const orderId = parseInt(btn.dataset.toggleReceipt, 10);
      const details = myOrdersList.querySelector(
        `.receipt-details[data-order-id="${orderId}"]`,
      );
      if (expandedReceipts.has(orderId)) {
        expandedReceipts.delete(orderId);
        details.classList.remove("open");
        btn.textContent = "View Receipt";
      } else {
        expandedReceipts.add(orderId);
        details.classList.add("open");
        btn.textContent = "Hide Receipt";
      }
    });
  });

  myOrdersList.querySelectorAll("[data-cancel-order]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const orderId = parseInt(btn.dataset.cancelOrder, 10);

      const isPaid = btn.dataset.paid === "true";
      const confirmed = confirm(
        isPaid
          ? `Cancel order #${orderId}? You've already paid, so Fulude's Cafe will refund you via Yoco back to your original payment method.`
          : `Cancel order #${orderId}?`,
      );
      if (!confirmed) return;

      btn.disabled = true;
      btn.textContent = "Cancelling…";

      try {
        const res = await fetch("/api/order", {
          method: "PUT",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${customerToken}`,
          },
          body: JSON.stringify({ id: orderId }),
        });
        const data = await res.json();
        if (!res.ok || !data.success)
          throw new Error(data.error || "Couldn't cancel this order.");
        refreshMyOrders();
      } catch (err) {
        alert(err.message);
        btn.disabled = false;
        btn.textContent = "Cancel Order";
      }
    });
  });

  myOrdersList.querySelectorAll("[data-retry-payment]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      btn.disabled = true;
      try {
        const res = await fetch("/api/order/retry", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${customerToken}`,
          },
          body: JSON.stringify({ id: Number(btn.dataset.retryPayment) }),
        });
        const data = await res.json();
        if (!res.ok || !(data.payment?.redirect_url || data.payment?.action_url))
          throw new Error(data.error || "Couldn't retry payment.");
        goToYocoPayment(data.payment);
      } catch (err) {
        alert(err.message);
        btn.disabled = false;
      }
    });
  });
}

/**
 * Sends the browser to Yoco. The server returns either Yoco's own
 * redirect_url (Checkout API) or, in the legacy setup, a form to POST.
 */
function goToYocoPayment(payment) {
  if (payment.redirect_url) {
    window.location.href = payment.redirect_url;
    return;
  }
  const form = document.createElement("form");
  form.method = "POST";
  form.action = payment.action_url;
  for (const [key, value] of Object.entries(payment.fields || {})) {
    const input = document.createElement("input");
    input.type = "hidden";
    input.name = key;
    input.value = value;
    form.appendChild(input);
  }
  document.body.appendChild(form);
  form.submit();
}

function escapeAttr(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/**
 * A small live tracker with customer-facing labels and a pulsing current
 * stage, so customers can watch their order move without refreshing.
 */
/**
 * The customer never paid, or paid but nothing's owed back - a flat
 * "cancelled" is accurate and enough.
 */
function cancelledMessage(order) {
  // Only a paid (or already refunded) order has money to give back -
  // never mention a refund for one that was never paid.
  if (!["paid", "refunded"].includes(order.payment_status)) {
    return "This order was cancelled.";
  }

  if (order.payment_status === "refunded") {
    const when = order.refund_processed_at
      ? new Date(order.refund_processed_at).toLocaleDateString("en-ZA", {
          dateStyle: "medium",
        })
      : null;
    return `This order was cancelled and refunded${when ? ` on ${when}` : ""}. It should reflect on your card within a few business days.`;
  }

  if (order.refund_needed) {
    return "This order was cancelled. Your refund is being processed and should reflect on your card within a few business days - if it hasn't after a week, please contact the cafe.";
  }

  // paid, cancelled, refund_needed is false and payment_status isn't yet
  // 'refunded' - a brief in-between state (e.g. refund initiated but the
  // webhook confirmation hasn't landed yet).
  return "This order was cancelled. A refund is being arranged for your payment.";
}

function renderStatusTracker(order) {
  // Tracking only starts once payment is confirmed. While payment is still
  // pending (or failed) there is nothing for the kitchen to track yet.
  if (
    order.status !== "Cancelled" &&
    order.payment_method === "online" &&
    ["awaiting", "failed"].includes(order.payment_status)
  ) {
    return `<div class="order-status-cancelled" style="background:#fff8e6;color:#8a6d1d;border-color:#f0d78a"><i class="fas fa-hourglass-half"></i> ${
      order.payment_status === "failed"
        ? "Payment failed. Tracking will start once your payment goes through - tap Retry Payment in the receipt below."
        : "Waiting for payment. Order tracking will start once your payment is confirmed."
    }</div>`;
  }
  if (order.status === "Cancelled") {
    return `<div class="order-status-cancelled"><i class="fas fa-circle-xmark"></i> ${cancelledMessage(order)}</div>`;
  }

  const handoffStage =
    order.status === "Delivery" || order.status === "Collection"
      ? order.status
      : order.order_type === "delivery"
        ? "Delivery"
        : "Collection";
  const stages = ["New", "Preparing", "Ready", handoffStage, "Completed"];
  const currentIndex = stages.indexOf(order.status);
  const labels = {
    New: "Order received",
    Preparing: "Preparing",
    Ready: "The order is ready",
    Collection: "Ready for collection",
    Delivery: "Out for delivery",
    Completed: "Completed",
  };
  return `
    <div class="order-status-tracker">
      ${stages
        .map((stage, i) => {
          const stateClass =
            i < currentIndex
              ? "completed"
              : i === currentIndex
                ? "active"
                : "upcoming";
          return `
          <div class="status-step ${stateClass}">
            <span class="status-dot">${i < currentIndex ? '<i class="fas fa-check"></i>' : ""}</span>
            <span class="status-label">${labels[stage] || stage}</span>
          </div>
        `;
        })
        .join("")}
    </div>
  `;
}

/**
 * Cancel button - only for a PAID order that's still "New", during the
 * 2 minutes that start when the payment is confirmed; cancelling then
 * refunds automatically through Yoco. Unpaid orders get no cancel button
 * (there's nothing to refund - they just offer "Pay Now").
 * The server re-checks all of this (functions/api/order.js onRequestPut).
 */
function renderCancelSection(order) {
  if (order.status !== "New") return "";

  const isPaid =
    order.payment_method === "online" && order.payment_status === "paid";
  if (!isPaid) return "";

  const paidAtMs = order.payment_confirmed_at ? new Date(order.payment_confirmed_at).getTime() : null;
  const cancelExpiresAtMs = order.kitchen_release_at
    ? new Date(order.kitchen_release_at).getTime()
    : paidAtMs !== null
      ? paidAtMs + CUSTOMER_CANCEL_WINDOW_MS
      : 0;
  const msLeft = cancelExpiresAtMs - Date.now();
  if (msLeft <= 0) return "";

  return `
    <div class="receipt-cancel-row">
      <button type="button" class="receipt-cancel-btn" data-cancel-order="${order.id}" data-cancel-expires-at="${cancelExpiresAtMs}" data-paid="${isPaid}">
        Cancel Order <span data-cancel-countdown="${order.id}">(${formatCountdown(msLeft)} left)</span>
      </button>
    </div>
  `;
}

/** "5h 12m" until this order drops off My Orders (24 hours after it was placed). */
function formatClearsIn(createdAt) {
  const msLeft = new Date(createdAt).getTime() + 24 * 60 * 60 * 1000 - Date.now();
  if (!(msLeft > 0)) return "soon";
  const mins = Math.ceil(msLeft / 60000);
  return `${Math.floor(mins / 60)}h ${String(mins % 60).padStart(2, "0")}m`;
}

function renderReceiptCard(order) {
  const itemsHtml = order.items
    .map((item) => {
      const extras = Array.isArray(item.extras)
        ? item.extras
        : JSON.parse(item.extras || "[]");
      const bits = [];
      if (item.spice_level) bits.push(item.spice_level);
      if (extras.length) bits.push(extras.map((e) => e.name).join(", "));
      return `<li>${item.quantity}x ${item.item_name}${bits.length ? ` (${bits.join(" · ")})` : ""} — ${money(item.subtotal)}</li>`;
    })
    .join("");

  const orderTypeLabel =
    order.order_type === "delivery"
      ? "Delivery"
      : order.order_type === "dine_in"
        ? `Dine In${order.table_number ? ` (Table ${order.table_number})` : ""}`
        : "Collection";
  const payAtLabel =
    order.order_type === "delivery"
      ? "delivery"
      : order.order_type === "dine_in"
        ? "the table"
        : "pickup";

  const paymentText =
    order.payment_method === "online"
      ? order.payment_status === "paid"
        ? "Paid online"
        : order.payment_status === "failed"
          ? "Payment failed"
          : "Payment pending"
      : `Pay at ${payAtLabel}`;
  const retryPayment =
    order.payment_method === "online" &&
    ["awaiting", "failed"].includes(order.payment_status);

  const placedDate = new Date(order.created_at).toLocaleString("en-ZA", {
    dateStyle: "medium",
    timeStyle: "short",
  });
  const isOpen = expandedReceipts.has(order.id);

  return `
    <div class="receipt-card">
      <div class="receipt-card-header">
        <strong>Order #${order.id}</strong>
      </div>
      <div class="receipt-meta">${placedDate} · ${orderTypeLabel}</div>
      <div class="receipt-meta" style="font-style:italic">Clears in: ${formatClearsIn(order.created_at)}</div>

      ${renderStatusTracker(order)}
      ${retryPayment && order.status !== "Cancelled" ? `<div class="receipt-cancel-row"><button type="button" class="receipt-cancel-btn" data-retry-payment="${order.id}">Pay Now</button></div>` : ""}
      ${renderCancelSection(order)}

      <button type="button" class="receipt-toggle-btn" data-toggle-receipt="${order.id}">${isOpen ? "Hide Receipt" : "View Receipt"}</button>

      <div class="receipt-details${isOpen ? " open" : ""}" data-order-id="${order.id}">
        <div class="receipt-meta">${order.pickup_time} · ${paymentText}</div>
        ${order.order_type === "delivery" && order.delivery_address ? `<div class="receipt-meta">Deliver to: ${escapeHtml(order.delivery_address)}</div>` : ""}
        <ul class="receipt-items">${itemsHtml}</ul>
        ${order.order_type === "delivery"
          ? `<div class="receipt-total" style="font-weight:500"><span>Items subtotal</span><span>${money(order.total_amount - (order.delivery_fee || 0))}</span></div>
        <div class="receipt-total" style="font-weight:500"><span>Delivery fee${order.delivery_distance_km ? ` (${Number(order.delivery_distance_km)} km)` : ""}</span><span>${money(order.delivery_fee || 0)}</span></div>`
          : ""}
        <div class="receipt-total"><span>Total</span><span>${money(order.total_amount)}</span></div>
      </div>
    </div>
  `;
}

document
  .getElementById("myOrdersModalClose")
  .addEventListener("click", closeMyOrdersModal);
myOrdersModal.addEventListener("click", (e) => {
  if (e.target === myOrdersModal) myOrdersModal.classList.remove("active");
});

// ---------------------------------------------------------------------
// Payment-return banner - Yoco bounces the browser back here with a
// `payment` query param. The real confirmation is the server-side ITN
// webhook; this banner is just a friendly heads-up, not a source of truth.
// ---------------------------------------------------------------------
function checkPaymentReturn() {
  const params = new URLSearchParams(window.location.search);
  const emailVerified = params.get("email_verified");
  if (emailVerified) {
    // Back from the sign-up verification link (functions/api/auth/verify-email.js).
    const banner = document.getElementById("paymentBanner");
    if (banner) {
      banner.textContent =
        emailVerified === "yes"
          ? "Your email is verified - you can now sign in."
          : emailVerified === "invalid"
            ? "That verification link is invalid or has expired. Please sign up again or contact us."
            : "We couldn't verify your email right now. Please try the link again in a moment.";
      banner.className = `payment-banner ${emailVerified === "yes" ? "success" : "cancelled"}`;
      banner.style.display = "block";
    }
    window.history.replaceState({}, document.title, window.location.pathname);
    if (emailVerified === "yes" && !currentCustomer) openAuthModal("signin");
    return;
  }
  const paymentResult = params.get("payment");
  const orderId = params.get("order_id");
  if (!paymentResult) return;

  const banner = document.getElementById("paymentBanner");
  if (!banner) return;
  if (paymentResult === "success") {
    banner.textContent = `Payment received - thank you! Order #${orderId} is confirmed and on its way to the kitchen.`;
    banner.className = "payment-banner success";
  } else {
    banner.textContent = `Payment was cancelled. Order #${orderId} is still saved but won't be sent to the kitchen until it's paid - contact us to complete payment, or place a new order to try again.`;
    banner.className = "payment-banner cancelled";
  }
  banner.style.display = "block";

  // Clean the query string so refreshing the page doesn't re-show this.
  window.history.replaceState({}, document.title, window.location.pathname);
}

// ---------------------------------------------------------------------
// Buffet visibility (admin-controlled, home page only)
// ---------------------------------------------------------------------
const OUT_OF_SERVICE_TITLE = "Sorry, we are not taking orders at the moment.";

/** Always asks the server (never cached) so checkout reacts the moment admin flips the switch. */
async function fetchStoreConfig() {
  try {
    const res = await fetch("/api/config", { cache: "no-store" });
    if (!res.ok) return null;
    const config = await res.json();
    window.storeConfig = config;
    return config;
  } catch {
    return null;
  }
}

/** Pop-up notice in the site's standard gold notice style. */
function showSiteNotice(title, message) {
  let overlay = document.getElementById("siteNoticeModal");
  if (!overlay) {
    overlay = document.createElement("div");
    overlay.className = "modal-overlay";
    overlay.id = "siteNoticeModal";
    overlay.innerHTML = `
      <div class="modal" style="max-width: 440px">
        <button class="modal-close" type="button" aria-label="Close">&times;</button>
        <h3 id="siteNoticeTitle"></h3>
        <p class="site-notice" id="siteNoticeText" style="margin-bottom: 0"></p>
      </div>`;
    document.body.appendChild(overlay);
    const close = () => overlay.classList.remove("active");
    overlay.querySelector(".modal-close").addEventListener("click", close);
    overlay.addEventListener("click", (e) => { if (e.target === overlay) close(); });
  }
  overlay.querySelector("#siteNoticeTitle").textContent = title;
  overlay.querySelector("#siteNoticeText").textContent = message || "";
  overlay.classList.add("active");
}

/** Out-of-service pop-up: title + the reason the admin typed. */
function showOutOfServiceNotice(reason) {
  showSiteNotice(OUT_OF_SERVICE_TITLE, reason || "Please check back soon.");
}

function renderOutOfServiceNotice(el, config) {
  el.innerHTML = "";
  const strong = document.createElement("strong");
  strong.textContent = OUT_OF_SERVICE_TITLE;
  el.appendChild(strong);
  if (config.out_of_service_reason) {
    const span = document.createElement("span");
    span.textContent = config.out_of_service_reason;
    el.appendChild(span);
  }
  el.style.display = "block";
}

async function loadConfig() {
  const config = await fetchStoreConfig();
  if (!config) return; // non-critical - everything just stays hidden

  // Buffet section (home page)
  const buffetSection = document.getElementById("buffetSection");
  if (buffetSection && config.is_buffet_visible) {
    buffetSection.style.display = "block";
    try {
      loadPublicBuffet();
    } catch (e) {
      /* ignore */
    }
  }

  // Out of service: hero notice on the home page, banner on the menu page
  const heroNotice = document.getElementById("heroServiceNotice");
  if (heroNotice) {
    if (config.is_out_of_service) renderOutOfServiceNotice(heroNotice, config);
    else heroNotice.style.display = "none";
  } else if (config.is_out_of_service && document.getElementById("checkoutBtn")) {
    const banner = document.createElement("div");
    banner.className = "site-notice service-banner";
    renderOutOfServiceNotice(banner, config);
    const anchor = document.getElementById("paymentBanner");
    if (anchor) anchor.insertAdjacentElement("afterend", banner);
  }

  // Admin announcement: white rounded bar under the hero buttons
  const annWrap = document.getElementById("heroAnnouncementWrap");
  const annEl = document.getElementById("heroAnnouncement");
  if (annWrap && annEl) {
    if (config.announcement_message) {
      annEl.textContent = config.announcement_message;
      annWrap.style.display = "block";
    } else {
      annWrap.style.display = "none";
    }
  }
}

// ---------------------------------------------------------------------
// FAQ / policies accordions (contact page)
// ---------------------------------------------------------------------
document.querySelectorAll(".faq-question").forEach((btn) => {
  btn.addEventListener("click", () => {
    const item = btn.parentElement;
    const list = item.closest(".faq-list"); // scope to this accordion group (FAQ vs. Our Policies are separate)
    const isActive = item.classList.contains("active");
    list
      .querySelectorAll(".faq-item")
      .forEach((i) => i.classList.remove("active"));
    if (!isActive) item.classList.add("active");
  });
});

// ---------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------
initAuth();
checkPaymentReturn();
loadConfig();


// ---------------------------------------------------------------------
// Settings (signed-in customers): update username / contact details,
// change password (needs email confirmation), email marketing, and
// delete the account. The markup is injected here so every page that
// loads site.js gets it without duplicating HTML.
// ---------------------------------------------------------------------
(function setupSettings() {
  const overlay = document.createElement("div");
  overlay.className = "modal-overlay";
  overlay.id = "settingsModal";
  overlay.innerHTML = `
    <div class="modal">
      <button class="modal-close" id="settingsModalClose" aria-label="Close">&times;</button>
      <h3>Settings</h3>
      <div class="auth-tabs" id="settingsTabs">
        <button type="button" class="auth-tab active" data-settings-tab="details">Details</button>
        <button type="button" class="auth-tab" data-settings-tab="password">Password</button>
        <button type="button" class="auth-tab" data-settings-tab="account">Account</button>
      </div>

      <!-- Details: username + contact -->
      <div class="settings-pane" data-settings-pane="details">
        <form id="settingsDetailsForm">
          <div class="form-group">
            <label for="settings-name">Username</label>
            <input type="text" id="settings-name" required maxlength="100" />
          </div>
          <div class="form-group">
            <label for="settings-phone">Phone (optional)</label>
            <input type="tel" id="settings-phone" maxlength="30" />
          </div>
          <div class="form-group">
            <label for="settings-address">Delivery address (optional)</label>
            <input type="text" id="settings-address" maxlength="500" placeholder="Include your suburb or village" />
          </div>
          <p class="auth-hint" style="margin-bottom:14px">Your email (<span id="settings-email"></span>) can't be changed here.</p>
          <p id="settingsDetailsMsg" class="form-success" style="display:none"></p>
          <p id="settingsDetailsErr" class="form-error" style="display:none"></p>
          <button type="submit" class="btn btn-primary btn-block">Save changes</button>
        </form>
      </div>

      <!-- Password: needs email confirmation -->
      <div class="settings-pane" data-settings-pane="password" style="display:none">
        <p id="settingsGooglePwNote" class="auth-hint" style="display:none">
          You signed in with Google, so there is no password on this account to change here.
        </p>
        <form id="settingsPasswordForm">
          <div class="form-group">
            <label for="settings-current-password">Current password</label>
            <input type="password" id="settings-current-password" required autocomplete="current-password" />
          </div>
          <div class="form-group">
            <label for="settings-new-password">New password</label>
            <input type="password" id="settings-new-password" required minlength="8" autocomplete="new-password" />
            <span class="auth-hint">At least 8 characters. We'll email you a link to confirm - your password only changes after you open it.</span>
          </div>
          <p id="settingsPasswordMsg" class="form-success" style="display:none"></p>
          <p id="settingsPasswordErr" class="form-error" style="display:none"></p>
          <button type="submit" class="btn btn-primary btn-block">Send confirmation link</button>
        </form>
      </div>

      <!-- Account: marketing + delete -->
      <div class="settings-pane" data-settings-pane="account" style="display:none">
        <label class="checkbox-option" style="margin-bottom:8px">
          <input type="checkbox" id="settingsEmailOptIn" /> Send me email offers and news
        </label>
        <p class="auth-hint" style="margin:0 0 8px">Saved automatically - you stay subscribed until you untick it.</p>
        <p id="settingsAccountMsg" class="form-success" style="display:none"></p>
        <p id="settingsAccountErr" class="form-error" style="display:none"></p>
        <div class="settings-danger-zone">
          <h4>Delete account</h4>
          <p class="auth-hint">This permanently removes your account and saved details. It can't be undone. Past orders may be kept for our accounting records without your login.</p>
          <button type="button" class="btn btn-danger btn-block" id="deleteAccountBtn">Delete my account</button>
        </div>
      </div>
    </div>`;
  document.body.appendChild(overlay);

  const $ = (id) => document.getElementById(id);
  const show = (el, text) => {
    el.textContent = text;
    el.style.display = "block";
  };
  const hide = (...els) => els.forEach((el) => (el.style.display = "none"));
  const authHeaders = () => ({
    "Content-Type": "application/json",
    Authorization: `Bearer ${customerToken}`,
  });

  function switchTab(tab) {
    overlay.querySelectorAll("#settingsTabs .auth-tab").forEach((b) =>
      b.classList.toggle("active", b.dataset.settingsTab === tab),
    );
    overlay.querySelectorAll(".settings-pane").forEach((pane) => {
      pane.style.display = pane.dataset.settingsPane === tab ? "block" : "none";
    });
  }
  overlay.querySelectorAll("#settingsTabs .auth-tab").forEach((b) =>
    b.addEventListener("click", () => switchTab(b.dataset.settingsTab)),
  );

  window.openSettingsModal = async function () {
    if (!currentCustomer) return;
    // Sign-in responses don't carry every profile field (marketing opt-in,
    // whether the account has a password) - pull the full profile first.
    try {
      const res = await fetch("/api/auth/me", {
        headers: { Authorization: `Bearer ${customerToken}` },
      });
      if (res.ok) currentCustomer = { ...currentCustomer, ...(await res.json()).customer };
    } catch {
      /* fall back to what we already have */
    }
    $("settings-name").value = currentCustomer.name || "";
    $("settings-phone").value = currentCustomer.phone_number || "";
    $("settings-address").value = currentCustomer.delivery_address || "";
    $("settings-email").textContent = currentCustomer.email || "";
    $("settingsEmailOptIn").checked = Boolean(currentCustomer.marketing_email_opt_in);
    const hasPassword = currentCustomer.has_password !== false;
    $("settingsPasswordForm").style.display = hasPassword ? "block" : "none";
    $("settingsGooglePwNote").style.display = hasPassword ? "none" : "block";
    hide(
      $("settingsDetailsMsg"), $("settingsDetailsErr"),
      $("settingsPasswordMsg"), $("settingsPasswordErr"),
      $("settingsAccountMsg"), $("settingsAccountErr"),
    );
    $("settingsPasswordForm").reset();
    switchTab("details");
    accountModal.classList.remove("active");
    overlay.classList.add("active");
  };

  $("settingsModalClose").addEventListener("click", () => overlay.classList.remove("active"));
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) overlay.classList.remove("active");
  });
  const openBtn = document.getElementById("openSettingsBtn");
  if (openBtn) openBtn.addEventListener("click", () => window.openSettingsModal());

  async function saveAccount(fields) {
    const res = await fetch("/api/auth/account", {
      method: "PUT",
      headers: authHeaders(),
      body: JSON.stringify(fields),
    });
    const data = await readApiResponse(res);
    if (!res.ok || !data.success) throw new Error(data.error || "Couldn't save your changes.");
    currentCustomer = { ...currentCustomer, ...data.customer };
    updateAccountNav();
    return data;
  }

  // Username / details - just confirm with a message, no email needed
  $("settingsDetailsForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    hide($("settingsDetailsMsg"), $("settingsDetailsErr"));
    const before = currentCustomer.name;
    try {
      const name = $("settings-name").value.trim();
      await saveAccount({
        name,
        phone_number: $("settings-phone").value.trim(),
        delivery_address: $("settings-address").value.trim(),
      });
      show(
        $("settingsDetailsMsg"),
        name !== before
          ? `Username updated to "${name}". Your changes have been saved.`
          : "Your changes have been saved.",
      );
    } catch (err) {
      show($("settingsDetailsErr"), userFriendlyError(err, "Couldn't save your changes."));
    }
  });

  // Password - emails a confirmation link; nothing changes until it's opened
  $("settingsPasswordForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    hide($("settingsPasswordMsg"), $("settingsPasswordErr"));
    const btn = e.target.querySelector("button[type=submit]");
    btn.disabled = true;
    try {
      const res = await fetch("/api/auth/change-password", {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify({
          current_password: $("settings-current-password").value,
          new_password: $("settings-new-password").value,
        }),
      });
      const data = await readApiResponse(res);
      if (!res.ok || !data.success) throw new Error(data.error || "Couldn't start the password change.");
      $("settingsPasswordForm").reset();
      show($("settingsPasswordMsg"), data.message);
    } catch (err) {
      show($("settingsPasswordErr"), userFriendlyError(err, "Couldn't start the password change."));
    } finally {
      btn.disabled = false;
    }
  });

  // Email marketing preference - saved the moment it's ticked/unticked, so it
  // stays that way after refreshing or signing in again.
  $("settingsEmailOptIn").addEventListener("change", async (e) => {
    const box = e.currentTarget;
    const wanted = box.checked;
    hide($("settingsAccountMsg"), $("settingsAccountErr"));
    box.disabled = true;
    try {
      await saveAccount({ marketing_email_opt_in: wanted });
      show($("settingsAccountMsg"), wanted ? "You're subscribed to our email offers and news." : "You've been unsubscribed.");
    } catch (err) {
      box.checked = !wanted; // didn't save - show what's really stored
      show($("settingsAccountErr"), userFriendlyError(err, "Couldn't save your preference."));
    } finally {
      box.disabled = false;
    }
  });

  // Delete account
  $("deleteAccountBtn").addEventListener("click", async () => {
    if (!confirm("Delete your account? This is permanent and cannot be undone.")) return;
    hide($("settingsAccountMsg"), $("settingsAccountErr"));
    try {
      const res = await fetch("/api/auth/account", {
        method: "DELETE",
        headers: { Authorization: `Bearer ${customerToken}` },
      });
      const data = await readApiResponse(res);
      if (!res.ok) throw new Error(data.error || "Failed to delete account");
      customerToken = null;
      currentCustomer = null;
      localStorage.removeItem(CUSTOMER_TOKEN_KEY);
      updateAccountNav();
      overlay.classList.remove("active");
      alert("Your account has been deleted.");
    } catch (err) {
      show($("settingsAccountErr"), userFriendlyError(err, "Failed to delete account."));
    }
  });
})();

/** Opened from the emailed "confirm your password change" link (?confirm_password=...). */
async function confirmPasswordChange(token) {
  let message;
  let ok = false;
  try {
    const res = await fetch("/api/auth/confirm-password-change", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token }),
    });
    const data = await readApiResponse(res);
    ok = res.ok && data.success;
    message = ok ? data.message : data.error || "We couldn't confirm this password change.";
  } catch (err) {
    message = userFriendlyError(err, "We couldn't confirm this password change.");
  }
  if (ok) {
    // Every session was ended server-side; forget the stale token here too.
    customerToken = null;
    currentCustomer = null;
    localStorage.removeItem(CUSTOMER_TOKEN_KEY);
    updateAccountNav();
  }
  alert(message);
  if (ok) openAuthModal("signin");
}

// ---------------------------------------------------------------------
// "Install app" button - shown when the browser says the site can be
// installed as a real app (Chrome/Edge/Android). iPhone: Share > Add to Home Screen.
// ---------------------------------------------------------------------
(function setupInstallPrompt() {
  let deferred = null;
  const isStandalone = window.matchMedia("(display-mode: standalone)").matches || navigator.standalone;
  if (isStandalone) return;
  const btn = document.createElement("button");
  btn.type = "button";
  btn.innerHTML = '<i class="fas fa-download"></i> Install app';
  btn.style.cssText = "display:none;position:fixed;left:16px;bottom:16px;z-index:150;background:#000;color:#fff;border:1.5px solid #b8963f;border-radius:999px;padding:10px 18px;font-weight:600;cursor:pointer;box-shadow:0 4px 14px rgba(0,0,0,.3)";
  document.body.appendChild(btn);
  window.addEventListener("beforeinstallprompt", (e) => {
    e.preventDefault();
    deferred = e;
    btn.style.display = "block";
  });
  btn.addEventListener("click", async () => {
    if (!deferred) return;
    deferred.prompt();
    await deferred.userChoice.catch(() => {});
    deferred = null;
    btn.style.display = "none";
  });
  window.addEventListener("appinstalled", () => (btn.style.display = "none"));
})();
