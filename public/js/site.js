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
const CUSTOMER_NAME_KEY = "fulude_customer_name"; // cached first name, so the nav can show it instantly on page load
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
addPasswordVisibilityToggle("reset-new-password");

/** Restores the session and handles password-reset links on page load. */
async function initAuth() {
  const googleResult = takeGoogleRedirectResult();
  if (googleResult.token) {
    customerToken = googleResult.token;
    localStorage.setItem(CUSTOMER_TOKEN_KEY, customerToken);
  }
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
  announceAuthChange();
  // load any customer-specific data (bookings)
  try {
    loadCustomerBuffetBookings();
  } catch (e) {
    /* ignore */
  }

  // Back from Google's sign-in page: finish what the customer was doing.
  if (googleResult.token && currentCustomer) {
    if (googleResult.checkout) {
      pendingCheckoutAfterAuth = true;
      onAuthSuccess(customerToken, currentCustomer);
    }
  } else if (googleResult.error) {
    pendingCheckoutAfterAuth = googleResult.checkout;
    openAuthModal("signin");
    signInError.textContent = googleResult.error;
    signInError.style.display = "block";
  }

  const params = new URLSearchParams(window.location.search);
  if (params.get("auth") === "signin") {
    window.history.replaceState({}, document.title, window.location.pathname);
    const verificationResult = params.get("admin_email_verified") || params.get("staff_email_verified");
    const verificationMessages = {
      yes: "Email verified. You can now sign in.",
      invalid: "That verification link is invalid or has expired. Please ask the admin to send a new one.",
      error: "We couldn't verify your email right now. Please try the link again.",
    };
    openAuthModal(
      "signin",
      verificationMessages[verificationResult],
    );
  } else if (params.get("create_account") === "1") {
    window.history.replaceState({}, document.title, window.location.pathname);
    openAuthModal("signup");
  } else if (params.get("recover") === "1") {
    window.history.replaceState({}, document.title, window.location.pathname);
    openAuthModal("forgot");
  }
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

/**
 * Lets other scripts react to "who is signed in" without reaching into this
 * file. The menu page uses it to load the customer's saved cart (menu.js).
 */
function announceAuthChange() {
  window.dispatchEvent(new CustomEvent("fulude:auth-changed"));
}

function updateAccountNav() {
  accountNavLabel.textContent = currentCustomer
    ? currentCustomer.name.split(" ")[0]
    : "Sign In";
  // Cache the display name locally so the next page load can show it
  // immediately instead of flashing "Sign In" while we re-confirm the token.
  try {
    if (currentCustomer) {
      localStorage.setItem(CUSTOMER_NAME_KEY, currentCustomer.name.split(" ")[0]);
    } else {
      localStorage.removeItem(CUSTOMER_NAME_KEY);
    }
  } catch (e) {
    /* localStorage unavailable (private browsing etc.) - not critical */
  }
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

/** Shared account link for desktop navigation and the mobile menu. */
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
      if (signInForm && signInForm.parentNode) {
        signInForm.parentNode.querySelectorAll(".auth-divider").forEach((d) => d.remove());
      }
    }
    // update button label to match context
    setGoogleButtonLabel(tab === "signup" ? "Create account with Google" : "Sign in with Google");
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
  signInError.classList.remove("is-locked");
  const email = document.getElementById("signin-email").value.trim();
  const password = document.getElementById("signin-password").value;
  const loginRoutes = [
    { url: "/api/admin/login", tokenKey: "fulude_admin_token", destination: "/fc-hq.html" },
    { url: "/api/staff/login", tokenKey: "fulude_staff_token", destination: "/fc-kitchen.html" },
    { url: "/api/auth/login", tokenKey: CUSTOMER_TOKEN_KEY },
  ];

  try {
    for (const route of loginRoutes) {
      const res = await fetch(route.url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password }),
      });
      const data = await readApiResponse(res);

      if (res.ok && data.success && data.token) {
        signInForm.reset();
        localStorage.setItem(route.tokenKey, data.token);
        if (route.destination) {
          location.assign(route.destination);
        } else {
          onAuthSuccess(data.token, data.customer);
        }
        return;
      }

      if (data.code === "account_not_found") continue;
      const error = new Error(data.error || "Couldn't sign in.");
      error.locked = Boolean(data.locked);
      throw error;
    }

    throw new Error("Incorrect email or password.");
  } catch (err) {
    signInError.textContent = userFriendlyError(
      err,
      "Sorry, we couldn't sign you in right now. Please try again.",
    );
    signInError.classList.toggle("is-locked", Boolean(err.locked));
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
    if (!res.ok || !data.success) {
      throw new Error(data.error || "Couldn't process that request.");
    }

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

/** Stores the session and resumes checkout when sign-in was required. */
function onAuthSuccess(token, customer) {
  customerToken = token;
  currentCustomer = customer;
  localStorage.setItem(CUSTOMER_TOKEN_KEY, token);
  updateAccountNav();
  announceAuthChange();
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

/** Google's four-colour "G" logo (inline SVG - no emoji, no extra download). */
const GOOGLE_G_SVG =
  '<svg class="google-g" viewBox="0 0 48 48" width="18" height="18" aria-hidden="true" focusable="false">' +
  '<path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"/>' +
  '<path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"/>' +
  '<path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"/>' +
  '<path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"/>' +
  "</svg>";

/** Puts the Google logo + text on the "Sign in / Create account with Google" button. */
function setGoogleButtonLabel(text) {
  const gbtn = document.getElementById("googleSignInBtn");
  if (!gbtn) return;
  gbtn.innerHTML = `<span class="google-g-wrap">${GOOGLE_G_SVG}</span><span>${text}</span>`;
  gbtn.setAttribute("aria-label", text);
}
setGoogleButtonLabel("Sign in with Google");

/**
 * "Sign in / Create account with Google" sends the whole page to Google's
 * sign-in (OpenID Connect, response_mode=form_post). Google then POSTs the
 * ID token to /api/auth/google, which creates the session and redirects
 * back here with #google_token=... (or #google_error=...) for
 * takeGoogleRedirectResult() to pick up.
 *
 * (The old approach - Google's button in an invisible iframe that opened a
 * popup - did nothing on iPhones, in the installed app and in in-app
 * browsers, where the popup is blocked or can't report back.)
 *
 * The nonce goes to Google as both `state` and `nonce`, and into a cookie
 * the server compares against - so a sign-in can't be started by another
 * site or replayed. The cart is in localStorage so it survives the trip;
 * a pending checkout is remembered in sessionStorage.
 */
const GOOGLE_CHECKOUT_KEY = "fulude_google_checkout";

function startGoogleSignIn() {
  const clientId = getGoogleClientId();
  if (!clientId) {
    signInError.textContent = "Google sign-in is not available right now.";
    signInError.style.display = "block";
    return;
  }
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  const nonce = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  document.cookie = `g_oauth_nonce=${nonce}; Path=/; Max-Age=600; Secure; SameSite=None`;
  try {
    if (pendingCheckoutAfterAuth) sessionStorage.setItem(GOOGLE_CHECKOUT_KEY, "1");
    else sessionStorage.removeItem(GOOGLE_CHECKOUT_KEY);
  } catch {
    /* private mode - checkout just won't auto-resume */
  }
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: `${location.origin}/api/auth/google`,
    response_type: "id_token",
    response_mode: "form_post",
    scope: "openid email profile",
    nonce,
    state: `${nonce}.${encodeURIComponent(location.pathname + location.search)}`,
    prompt: "select_account",
  });
  location.href = `https://accounts.google.com/o/oauth2/v2/auth?${params}`;
}

const googleSignInBtn = document.getElementById("googleSignInBtn");
if (googleSignInBtn) googleSignInBtn.addEventListener("click", startGoogleSignIn);

/** Reads (and clears from the address bar) the result of a Google sign-in redirect. */
function takeGoogleRedirectResult() {
  const result = { token: null, error: null, checkout: false };
  const hash = new URLSearchParams(location.hash.slice(1));
  result.token = hash.get("google_token");
  result.error = hash.get("google_error");
  if (!result.token && !result.error) return result;
  history.replaceState({}, document.title, location.pathname + location.search);
  try {
    result.checkout = sessionStorage.getItem(GOOGLE_CHECKOUT_KEY) === "1";
    sessionStorage.removeItem(GOOGLE_CHECKOUT_KEY);
  } catch {
    /* ignore */
  }
  return result;
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

// "Orders" link in the header, just left of the account/profile link.
(function addNavOrdersLink() {
  const actions = accountNavBtn?.parentElement;
  if (!actions || document.getElementById("navOrdersLink")) return;
  const link = document.createElement("a");
  link.href = "#";
  link.id = "navOrdersLink";
  link.className = "nav-orders-link";
  link.textContent = "Orders";
  actions.insertBefore(link, accountNavBtn);
  link.addEventListener("click", (e) => {
    e.preventDefault();
    if (!currentCustomer) {
      openAuthModal("signin", "Sign in to see your orders.");
      return;
    }
    openMyOrdersModal();
  });
})();

document.getElementById("logoutBtn").addEventListener("click", async () => {
  // Send any cart change still waiting to be saved to the account first
  // (flushCartSync lives in menu.js, so it only exists on the menu page).
  try {
    if (typeof flushCartSync === "function") await flushCartSync();
  } catch {
    /* never block signing out */
  }
  try {
    await fetch("/api/auth/logout", {
      method: "POST",
      headers: { Authorization: `Bearer ${customerToken}` },
    });
  } catch {
    // Clear the local token even if the logout request fails.
  }
  customerToken = null;
  currentCustomer = null;
  localStorage.removeItem(CUSTOMER_TOKEN_KEY);
    updateAccountNav(); // Update the account navigation to reflect the new session
  // signed out - don't leave them behind for the next person on this device.
  // (They are still on the account for the next sign-in.)
  ["fulude_cart", "fulude_cart_sync", "fulude_cart_dirty", ACTIVE_RES_KEY].forEach((k) => localStorage.removeItem(k));
  updateAccountNav();
  accountModal.classList.remove("active");
  loadCustomerBuffetBookings();
  window.location.assign("/home");
});

// ---------------------------------------------------------------------
// Reservation modal - reachable from the nav on every page (plus the
// hero button on the home page and the cart panel on the menu page).
// ---------------------------------------------------------------------
const navReservationLink = document.getElementById("navReservationLink");
const heroReservationBtn = document.getElementById("heroReservationBtn");
const menuReservationBtn = document.getElementById("menuReservationBtn");
const reservationBtn = document.getElementById("reservationBtn");
    updateAccountNav(); // Update the account navigation to reflect the new session
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
  let loadedFromAccount = false;
  const today = todayKeyLocal();
  if (currentCustomer && customerToken) {
    try {
      const res = await fetch("/api/reservations", { headers: { Authorization: `Bearer ${customerToken}` } });
      if (res.ok) {
        list = (await res.json()).reservations || [];
        loadedFromAccount = true;
      }
    } catch { /* fall through to local copy */ }
  }
  // Signed in: the account's list is the list - an empty answer means no
  // bookings (or history cleared), not "show what this device remembers".
  // The copy kept on this device is only for guests, or if the account can't be reached.
  if (!loadedFromAccount) {
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
    `<div class="reservation-history-head"><h4 style="margin:0">Your reservation${list.length > 1 ? "s" : ""}</h4>` +
    `<button type="button" class="reservation-clear-btn" id="reservationClearBtn"><i class="fas fa-trash-can"></i> Clear history</button></div>` +
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
  const clearBtn = document.getElementById("reservationClearBtn");
  if (clearBtn) clearBtn.addEventListener("click", clearReservationHistory);
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
  // Existing bookings (even unpaid or unconfirmed ones) never block booking another table.
  reservationForm.style.display = "block";
}

/**
 * "Clear history": removes every booking from the customer's own list.
 * Signed in, the server hides them on the account (the cafe still has them);
 * the copy kept on this device for guests is wiped too.
 */
async function clearReservationHistory() {
  if (!confirm("Clear your reservation history? Your bookings will be removed from this list. The cafe still has them - contact us if you need to change or cancel one.")) return;
  const btn = document.getElementById("reservationClearBtn");
  if (btn) btn.disabled = true;
  try {
    if (currentCustomer && customerToken) {
      const res = await fetch("/api/reservations", { method: "DELETE", headers: { Authorization: `Bearer ${customerToken}` } });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.success) throw new Error(data.error || "Couldn't clear your reservation history.");
    }
    localStorage.removeItem(MY_RES_KEY);
    localStorage.removeItem(ACTIVE_RES_KEY);
    await loadExistingReservations();
  } catch (err) {
    alert(err.message);
    if (btn) btn.disabled = false;
  }
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

/**
 * "Leave a review" for one completed order: a pop-up with the thank-you
 * message, star rating and comment. The review is tied to that order
 * (one per order) and appears on the Reviews page once the admin approves it.
 */
function openOrderReviewModal(orderId) {
  let overlay = document.getElementById("orderReviewModal");
  if (!overlay) {
    overlay = document.createElement("div");
    overlay.className = "modal-overlay";
    overlay.id = "orderReviewModal";
    overlay.innerHTML = `
      <div class="modal order-review-modal">
        <button class="modal-close" type="button" id="orderReviewClose">&times;</button>
        <h3>Thank you for dining with us, enjoy your meal!</h3>
        <p class="auth-hint" id="orderReviewIntro"></p>
        <form id="orderReviewForm">
          <div class="order-review-stars" role="radiogroup" aria-label="Your rating">
            ${[1, 2, 3, 4, 5].map((n) => `<button type="button" class="order-review-star" data-star="${n}" aria-label="${n} star${n > 1 ? "s" : ""}">★</button>`).join("")}
          </div>
          <div class="form-group">
            <label for="orderReviewName">Your name</label>
            <input id="orderReviewName" maxlength="100" required />
          </div>
          <div class="form-group">
            <label for="orderReviewComment">Your review</label>
            <textarea id="orderReviewComment" rows="4" maxlength="1000" required placeholder="What did you enjoy? Anything we can do better?"></textarea>
          </div>
          <p class="form-error" id="orderReviewError" style="display:none"></p>
          <p class="form-success" id="orderReviewSuccess" style="display:none"></p>
          <button type="submit" class="btn btn-primary btn-block" id="orderReviewSubmit">Submit review</button>
        </form>
      </div>`;
    document.body.appendChild(overlay);
    overlay.addEventListener("click", (e) => {
      if (e.target === overlay) overlay.classList.remove("active");
    });
    overlay.querySelector("#orderReviewClose").addEventListener("click", () => overlay.classList.remove("active"));
    overlay.querySelectorAll("[data-star]").forEach((star) =>
      star.addEventListener("click", () => {
        overlay.dataset.rating = star.dataset.star;
        overlay.querySelectorAll("[data-star]").forEach((s) => s.classList.toggle("on", Number(s.dataset.star) <= Number(star.dataset.star)));
      }),
    );
    overlay.querySelector("#orderReviewForm").addEventListener("submit", async (e) => {
      e.preventDefault();
      const err = overlay.querySelector("#orderReviewError");
      const ok = overlay.querySelector("#orderReviewSuccess");
      const submit = overlay.querySelector("#orderReviewSubmit");
      err.style.display = "none";
      const rating = Number(overlay.dataset.rating || 0);
      if (!rating) {
        err.textContent = "Please tap the stars to rate your meal.";
        err.style.display = "block";
        return;
      }
      submit.disabled = true;
      try {
        const res = await fetch("/api/review", {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${customerToken}` },
          body: JSON.stringify({
            order_id: Number(overlay.dataset.orderId),
            rating,
            customer_name: overlay.querySelector("#orderReviewName").value.trim(),
            comment: overlay.querySelector("#orderReviewComment").value.trim(),
          }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok || !data.success) throw new Error(data.error || "Couldn't send your review.");
        ok.textContent = "Thank you! Your review will appear on our Reviews page once it's approved.";
        ok.style.display = "block";
        overlay.querySelector("#orderReviewForm").querySelectorAll("input, textarea, button").forEach((el) => (el.disabled = true));
        refreshMyOrders();
        setTimeout(() => overlay.classList.remove("active"), 2500);
      } catch (e2) {
        err.textContent = e2.message;
        err.style.display = "block";
        submit.disabled = false;
      }
    });
  }
  // Fresh form for this order
  overlay.dataset.orderId = orderId;
  overlay.dataset.rating = "";
  overlay.querySelectorAll("[data-star]").forEach((s) => s.classList.remove("on"));
  const form = overlay.querySelector("#orderReviewForm");
  form.reset();
  form.querySelectorAll("input, textarea, button").forEach((el) => (el.disabled = false));
  overlay.querySelector("#orderReviewName").value = currentCustomer?.name || "";
  overlay.querySelector("#orderReviewIntro").textContent = `How was order #${orderId}? Tell us about it.`;
  overlay.querySelector("#orderReviewError").style.display = "none";
  overlay.querySelector("#orderReviewSuccess").style.display = "none";
  overlay.classList.add("active");
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

  myOrdersList.querySelectorAll("[data-review-order]").forEach((btn) =>
    btn.addEventListener("click", () => openOrderReviewModal(Number(btn.dataset.reviewOrder))),
  );

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
/** "A", "A and B", "A, B and C" */
function listNames(names) {
  return names.length <= 1 ? names.join("") : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

/**
 * The whole order is refunded when one or more of its items sold out
 * before the payment completed (someone else's payment got them first).
 */
function soldOutRefundMessage(order) {
  const names = String(order.cancel_reason || "")
    .replace(/^Sold out:\s*/i, "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s && s !== "an item in the order");
  const what = names.length ? `${listNames(names)} ${names.length > 1 ? "were" : "was"}` : "one of the items";
  return `Sorry, your order #${order.id} was refunded because ${what} sold out before your payment went through. The money goes back to your card, usually within a few business days.`;
}

function cancelledMessage(order) {
  // Only a paid (or already refunded) order has money to give back -
  // never mention a refund for one that was never paid.
  if (!["paid", "refunded"].includes(order.payment_status)) {
    return "This order was cancelled.";
  }
  if (order.cancelled_by === "system") return soldOutRefundMessage(order);

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

/**
 * ETA settings - change numbers here only.
 * Preparation time applies to every order. Drive time is only shown once a delivery order is out for delivery.
 */
const ETA_CONFIG = {
  prepMin: 30,
  prepMax: 40,
  driveBandKm: 3, // each band is 3 km wide
  driveBaseMax: [7, 11, 16], // max drive mins for 0-3, 3-6, 6-9 km
  driveStepAfter: 4, // +4 mins per extra 3 km band beyond 9 km
  minDriveRatio: 0.675, // min drive = 67.5% of max drive, rounded
};

/** Max drive minutes for a road distance in km (0-3 inclusive in the first band). */
function maxDriveMinutes(km) {
  const c = ETA_CONFIG;
  const band = Math.max(0, Math.ceil(km / c.driveBandKm) - 1); // 0 = first band
  if (band < c.driveBaseMax.length) return c.driveBaseMax[band];
  return c.driveBaseMax[c.driveBaseMax.length - 1] + c.driveStepAfter * (band - c.driveBaseMax.length + 1);
}

/** { minDrive, maxDrive } minutes for a delivery order, or null without a usable distance. */
function driveRange(order) {
  const km = Number(order.delivery_distance_km);
  if (!Number.isFinite(km) || km <= 0) return null;
  const maxDrive = maxDriveMinutes(km);
  return { minDrive: Math.round(maxDrive * ETA_CONFIG.minDriveRatio), maxDrive };
}

/** { min, max } kitchen preparation minutes. Same for collection and delivery orders. */
function calcPrepEta() {
  return { min: ETA_CONFIG.prepMin, max: ETA_CONFIG.prepMax };
}

/** If staff forget to tick Delivered, the delivery line disappears this long after the order left. */
const ETA_HIDE_AFTER_MIN = 90;

function etaBox(html) {
  return `<div class="order-eta">${html}</div>`;
}

/**
 * ETA line for the order tracker.
 *  - Collection: preparation time while New / Preparing, "ready" message once Ready.
 *  - Delivery before it leaves the cafe: preparation time only.
 *  - Delivery out for delivery: drive-time countdown -> "Arriving any moment" ->
 *    "Sorry, we are running late"; "Delivered" once the cafe ticks it (admin History);
 *    disappears by itself ETA_HIDE_AFTER_MIN after the order left.
 *  - Scheduled orders (not "As soon as possible"): shown once the kitchen starts preparing.
 */
function renderOrderEta(order) {
  if (order.status === "Cancelled" || order.order_type === "dine_in") return "";
  // Nothing to estimate until payment has gone through.
  if (order.payment_method === "online" && ["awaiting", "failed"].includes(order.payment_status)) return "";

  const isDelivery = order.order_type === "delivery";
  const isAsap = /as soon as possible/i.test(String(order.pickup_time || ""));

  if (isDelivery && order.delivered_at) {
    return etaBox('<i class="fas fa-circle-check"></i> <strong>Delivered.</strong> Enjoy your meal!');
  }

  // Out for delivery: show delivery (drive) time.
  const handedOver = isDelivery && ["Delivery", "Completed"].includes(order.status);
  if (handedOver) {
    const icon = '<i class="fas fa-motorcycle"></i>';
    const d = driveRange(order);
    const outMs = order.out_for_delivery_at ? new Date(order.out_for_delivery_at).getTime() : NaN;
    if (!d) return etaBox(`${icon} <strong>Your order is on its way.</strong>`);
    if (!Number.isFinite(outMs)) {
      return etaBox(`${icon} Estimated delivery time: <strong>${d.minDrive} - ${d.maxDrive} mins</strong>`);
    }
    const elapsed = (Date.now() - outMs) / 60000;
    if (elapsed >= ETA_HIDE_AFTER_MIN) return "";
    if (elapsed > d.maxDrive) return etaBox(`${icon} <strong>Sorry, we are running late.</strong>`);
    const leftMin = Math.ceil(d.minDrive - elapsed);
    const leftMax = Math.ceil(d.maxDrive - elapsed);
    if (leftMin <= 0) return etaBox(`${icon} <strong>Arriving any moment</strong>`);
    return etaBox(`${icon} Arriving in about <strong>${leftMin} - ${leftMax} mins</strong>`);
  }

  // Collection order that is ready: no more waiting.
  if (!isDelivery && order.status === "Ready") {
    return etaBox('<i class="fas fa-bag-shopping"></i> <strong>Your order is ready for collection.</strong>');
  }

  // Preparation time (delivery before it leaves, and collection).
  const active = isDelivery ? ["New", "Preparing", "Ready"] : ["New", "Preparing"];
  if (!active.includes(order.status)) return "";
  if (!isAsap && order.status !== "Preparing") return "";

  const eta = calcPrepEta();
  const startMs = new Date(
    (!isAsap && order.preparing_at) || order.kitchen_release_at || order.payment_confirmed_at || order.created_at
  ).getTime();
  const clock = (mins) =>
    new Date(startMs + mins * 60000).toLocaleTimeString("en-ZA", { hour: "2-digit", minute: "2-digit", hour12: false });
  const clockText = Number.isFinite(startMs)
    ? ` <span class="order-eta-clock">(${clock(eta.min)} - ${clock(eta.max)})</span>`
    : "";
  const label = isDelivery ? "Order preparation time" : "Ready for collection in";
  const note = isDelivery
    ? '<div style="opacity:.85;font-size:.85rem;margin-top:4px">Your delivery time will appear once your order is out for delivery.</div>'
    : "";
  return etaBox(
    `<i class="fas fa-clock"></i> ${label}: <strong>${eta.min} - ${eta.max} mins</strong>${clockText}${note}`
  );
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
      ${renderOrderEta(order)}
      ${retryPayment && order.status !== "Cancelled" ? `<div class="receipt-cancel-row"><button type="button" class="receipt-cancel-btn" data-retry-payment="${order.id}">Pay Now</button></div>` : ""}
      ${renderCancelSection(order)}
      ${
        order.status === "Completed"
          ? `<div class="order-thanks">
              <p><strong>Thank you for dining with us, enjoy your meal!</strong></p>
              ${
                order.reviewed
                  ? `<p class="order-thanks-done"><i class="fas fa-star"></i> Thanks for your review!</p>`
                  : `<button type="button" class="order-review-btn" data-review-order="${order.id}"><i class="fas fa-star"></i> Leave a review</button>`
              }
            </div>`
          : ""
      }

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
/** Polls My Orders for this order until the payment is confirmed or refunded (about 30 seconds max). */
async function showPaymentOutcome(banner, orderId) {
  for (let attempt = 0; attempt < 15; attempt++) {
    if (!customerToken) break;
    try {
      const res = await fetch("/api/order/my", { headers: { Authorization: `Bearer ${customerToken}` } });
      const order = res.ok ? ((await res.json()).orders || []).find((o) => Number(o.id) === orderId) : null;
      if (order && order.status === "Cancelled") {
        banner.textContent = order.cancelled_by === "system" ? soldOutRefundMessage(order) : cancelledMessage(order);
        banner.className = "payment-banner cancelled";
        return;
      }
      if (order && order.payment_status === "paid") {
        banner.textContent = `Payment received - thank you! Order #${orderId} is confirmed and on its way to the kitchen.`;
        banner.className = "payment-banner success";
        return;
      }
    } catch {
      /* try again */
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  banner.textContent = `Thank you! We're still confirming the payment for order #${orderId} - check Orders in a moment to see its status.`;
  banner.className = "payment-banner success";
}

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
    // Coming back from Yoco doesn't mean the order went through yet - the
    // payment is confirmed (or refunded if an item sold out) moments later.
    // Show what really happened to this order.
    banner.textContent = `Thank you! Confirming your payment for order #${orderId}…`;
    banner.className = "payment-banner success";
    showPaymentOutcome(banner, Number(orderId));
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
  applyConfig(config);
  try {
    localStorage.setItem(STORE_CONFIG_CACHE_KEY, JSON.stringify(config));
  } catch (e) {
    /* localStorage unavailable - not critical, just means no instant render next visit */
  }
}

/** Renders the buffet section, out-of-service notice and announcement bar
 * from a config object. Shared by the cached instant-render on page load
 * and the fresh server response in loadConfig(), so both draw the same way. */
function applyConfig(config) {
  // Buffet section (home page)
  const buffetSection = document.getElementById("buffetSection");
  if (buffetSection && config.is_buffet_visible) {
    buffetSection.style.display = "block";
    try {
      loadPublicBuffet();
    } catch (e) {
      /* ignore */
    }
  } else if (buffetSection && !config.is_buffet_visible) {
    buffetSection.style.display = "none";
  }

  // Out of service: hero notice on the home page only. The menu page no
  // longer shows a persistent banner - checkout itself still blocks and
  // shows a pop-up notice if the store is out of service (see menu.js).
  const heroNotice = document.getElementById("heroServiceNotice");
  if (heroNotice) {
    if (config.is_out_of_service) renderOutOfServiceNotice(heroNotice, config);
    else heroNotice.style.display = "none";
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

// Instant render from the last known config (cached locally), so the
// buffet section / out-of-service notice / announcement don't disappear
// and reappear on every page navigation while we re-confirm with the
// server. loadConfig() above still runs and corrects anything that's
// changed since this was cached (e.g. admin just flipped a switch).
const STORE_CONFIG_CACHE_KEY = "fulude_store_config_cache";
try {
  const cachedConfig = JSON.parse(localStorage.getItem(STORE_CONFIG_CACHE_KEY) || "null");
  if (cachedConfig) applyConfig(cachedConfig);
} catch (e) {
  /* ignore a corrupted cache entry */
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

  addPasswordVisibilityToggle("settings-current-password");
  addPasswordVisibilityToggle("settings-new-password");

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

// ---------------------------------------------------------------------
// Form validation (every customer form on every page) - rules live in
// js/form-validation.js, shared with the admin and staff dashboards.
// ---------------------------------------------------------------------
if (typeof FuludeValidation !== "undefined") {
  FuludeValidation.apply({
    names: ["reservation-name", "signup-name", "customer-name", "buffetName", "catName", "reviewName", "orderReviewName", "settings-name"],
    newPasswords: ["signup-password", "reset-new-password", "settings-new-password"],
    futureDates: ["reservation-date", "catDate"],
    numbers: {
      "reservation-party-size": { min: 1, max: 50, step: 1, title: "1 to 50 guests - for bigger groups please contact us." },
    },
    maxLengths: { "special-instructions": 500, "reservation-notes": 500, catMessage: 1000, reviewComment: 1000 },
    patterns: { "addr-postal": { pattern: "[0-9]{4}", title: "4-digit postal code, e.g. 0950" } },
  });
}
