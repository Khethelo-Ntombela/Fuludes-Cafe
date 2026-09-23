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
const marketingEmailOptIn = document.getElementById("marketingEmailOptIn");
const marketingSmsOptIn = document.getElementById("marketingSmsOptIn");
const saveMarketingPreferencesBtn = document.getElementById(
  "saveMarketingPreferencesBtn",
);
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
  toggle.textContent = "Show";
  toggle.setAttribute("aria-label", "Show password");
  toggle.addEventListener("click", () => {
    const isVisible = input.type === "text";
    input.type = isVisible ? "password" : "text";
    toggle.textContent = isVisible ? "Show" : "Hide";
    toggle.setAttribute("aria-label", `${isVisible ? "Show" : "Hide"} password`);
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
const myBuffetBtn = document.getElementById("myBuffetBtn");
const myBuffetModal = document.getElementById("myBuffetModal");
const myBuffetClose = document.getElementById("myBuffetClose");
const myBuffetList = document.getElementById("myBuffetList");

async function loadCustomerBuffetBookings() {
  if (!currentCustomer || !customerToken) {
    if (myBuffetBtn) myBuffetBtn.style.display = "none";
    return;
  }
  try {
    const res = await fetch("/api/buffet-bookings", {
      headers: { Authorization: `Bearer ${customerToken}` },
    });
    if (!res.ok) throw new Error("Failed to load");
    const data = await readApiResponse(res);
    const bookings = data.bookings || [];
    if (!bookings.length) {
      if (myBuffetBtn) myBuffetBtn.style.display = "none";
      return;
    }
    if (myBuffetBtn) {
      myBuffetBtn.style.display = "inline-block";
      myBuffetBtn.textContent = `Buffet (${bookings.length})`;
    }
    // render inside modal
    if (!myBuffetList) return;
    myBuffetList.innerHTML = "";
    bookings.forEach((b) => {
      const el = document.createElement("div");
      el.className = "sa-list-item";
      el.innerHTML = `<div class="sa-list-main"><div class="sa-list-title">${escapeHtml(b.title)} — ${new Date(b.event_date).toLocaleString()}</div><div class="sa-list-sub">Seats: ${b.seats} • Status: ${b.status}</div></div>
        <div style="margin-top:8px"><button class="btn btn-secondary btn-cancel-booking" data-id="${b.booking_id}">Cancel</button></div>`;
      myBuffetList.appendChild(el);
    });
    myBuffetList.querySelectorAll(".btn-cancel-booking").forEach((btn) =>
      btn.addEventListener("click", async (e) => {
        if (!confirm("Cancel this booking?")) return;
        const id = Number(e.target.dataset.id);
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
        } catch (err) {
          alert(err.message || "Failed to cancel");
        }
      }),
    );
  } catch (err) {
    if (myBuffetBtn) myBuffetBtn.style.display = "none";
  }
}

if (myBuffetBtn)
  myBuffetBtn.addEventListener("click", () => {
    if (myBuffetModal) myBuffetModal.style.display = "block";
  });
if (myBuffetClose)
  myBuffetClose.addEventListener("click", () => {
    if (myBuffetModal) myBuffetModal.style.display = "none";
  });

/** Shared by both account entry points - the text+icon link inside the nav, and the standalone icon button next to the mobile menu toggle. */
function openAccountMenu() {
  if (currentCustomer) {
    accountWelcome.textContent = `Signed in as ${currentCustomer.name} (${currentCustomer.email})`;
    if (marketingEmailOptIn)
      marketingEmailOptIn.checked = Boolean(
        currentCustomer.marketing_email_opt_in,
      );
    if (marketingSmsOptIn)
      marketingSmsOptIn.checked = Boolean(currentCustomer.marketing_sms_opt_in);
    accountModal.classList.add("active");
  } else {
    openAuthModal("signin");
  }
}

if (saveMarketingPreferencesBtn)
  saveMarketingPreferencesBtn.addEventListener("click", async () => {
    const response = await fetch("/api/auth/account", {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${customerToken}`,
      },
      body: JSON.stringify({
        marketing_email_opt_in: marketingEmailOptIn.checked,
        marketing_sms_opt_in: marketingSmsOptIn.checked,
      }),
    });
    const data = await response.json();
    if (!response.ok || !data.success)
      return alert(data.error || "Failed to save preferences.");
    currentCustomer = { ...currentCustomer, ...data };
    alert("Marketing preferences saved.");
  });

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
      "We couldn't sign you in. Please check your details and try again.",
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

  authModal.classList.remove("active");
  if (pendingCheckoutAfterAuth) {
    pendingCheckoutAfterAuth = false;
    if (typeof proceedToCheckout === "function") proceedToCheckout();
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

  const container = document.getElementById("googleSignInContainer");
  if (container) {
    container.style.display = "block";
    google.accounts.id.renderButton(container, {
      theme: "outline",
      size: "large",
      width: "100%",
    });
  }

  const btn = document.getElementById("googleSignInBtn");
  if (btn) btn.addEventListener("click", () => google.accounts.id.prompt());
  // If the GIS script wasn't ready at init time, ensure the button will
  // attempt to initialize and prompt on the first user click.
  if (btn)
    btn.addEventListener("click", async () => {
      if (
        typeof google === "undefined" ||
        !google.accounts ||
        !google.accounts.id
      ) {
        // try to initialize again (script may have loaded after earlier check)
        try {
          initGoogleSignIn();
        } catch (e) {}
      }
    });
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
async function loadPublicBuffet() {
  const el = document.getElementById("buffetContent");
  if (!el) return;
  try {
    const res = await fetch("/api/buffet");
    const data = await res.json();
    const events = data.events || [];
    if (!events.length) {
      el.innerHTML = "<p>No upcoming buffet events.</p>";
      return;
    }
    el.innerHTML = events
      .map(
        (evt) => `
      <div class="sa-card" data-event-id="${evt.id}">
        <div class="sa-card-title">${evt.title} <span class="admin-hint">${new Date(evt.event_date).toLocaleString()}</span></div>
        <p>${evt.description || ""}</p>
        <div><strong>Seats:</strong> ${evt.seats_remaining} remaining of ${evt.capacity} &nbsp; <strong>Price:</strong> R${(Number(evt.price_cents) / 100).toFixed(2)}</div>
        <div style="margin-top:8px"><button class="btn btn-primary btn-book-buffet" data-id="${evt.id}" data-title="${escapeHtml(evt.title)}" ${evt.seats_remaining <= 0 ? "disabled" : ""}>${evt.seats_remaining <= 0 ? "Sold out" : "Book"}</button></div>
        ${evt.booking_closes_at ? `<div class="admin-hint">Booking closes: ${new Date(evt.booking_closes_at).toLocaleString()}</div>` : ""}
      </div>
    `,
      )
      .join("");

    document.querySelectorAll(".btn-book-buffet").forEach((b) =>
      b.addEventListener("click", (e) => {
        const id = b.dataset.id || e.target.dataset.id;
        const title = b.dataset.title || e.target.dataset.title;
        openBuffetBookingModal(id, title);
      }),
    );
  } catch (err) {
    el.innerHTML = "<p>Failed to load buffet events.</p>";
  }
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
  modal.style.display = "block";
}

document.getElementById("buffetBookingClose")?.addEventListener("click", () => {
  document.getElementById("buffetBookingModal").style.display = "none";
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
    try {
      const res = await fetch("/api/buffet", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ event_id, name, email, phone, seats }),
      });
      const data = await res.json();
      if (!res.ok || !data.success)
        throw new Error(data.error || "Booking failed");
      okEl.textContent = "Booking confirmed — we look forward to seeing you!";
      okEl.style.display = "block";
      document.getElementById("buffetBookingForm").reset();
      // refresh events/bookings availability
      loadPublicBuffet();
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
});

document
  .getElementById("deleteAccountBtn")
  ?.addEventListener("click", async () => {
    if (
      !confirm("Delete your account? This is permanent and cannot be undone.")
    )
      return;
    try {
      const res = await fetch("/api/auth/account", {
        method: "DELETE",
        headers: { Authorization: `Bearer ${customerToken}` },
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to delete account");
      // Clear local session and UI
      customerToken = null;
      currentCustomer = null;
      localStorage.removeItem(CUSTOMER_TOKEN_KEY);
      updateAccountNav();
      accountModal.classList.remove("active");
      alert("Your account has been deleted.");
    } catch (err) {
      alert(err.message || "Failed to delete account");
    }
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
let reservationRedirectTimer = null;

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
  reservationModal.classList.add("active");
}

if (navReservationLink) {
  navReservationLink.addEventListener("click", (e) => {
    e.preventDefault();
    openReservationModal();
  });
}

if (heroReservationBtn) {
  heroReservationBtn.addEventListener("click", openReservationModal);
}

if (menuReservationBtn) {
  menuReservationBtn.addEventListener("click", openReservationModal);
}

if (reservationBtn) {
  reservationBtn.addEventListener("click", openReservationModal);
}

reservationModalClose.addEventListener("click", () =>
  reservationModal.classList.remove("active"),
);
reservationModal.addEventListener("click", (e) => {
  if (e.target === reservationModal)
    reservationModal.classList.remove("active");
});

function clearReservationRedirectTimer() {
  if (reservationRedirectTimer) {
    clearInterval(reservationRedirectTimer);
    reservationRedirectTimer = null;
  }
}

/** On the menu page, scroll to the ordering section; from any other page, navigate to it. */
function redirectToMenu() {
  reservationModal.classList.remove("active");
  const orderSection = document.getElementById("order");
  if (orderSection) {
    orderSection.scrollIntoView({ behavior: "smooth" });
  } else {
    window.location.href = "menu.html";
  }
}

function redirectToSignup() {
  reservationModal.classList.remove("active");
  openAuthModal(
    "signup",
    "Create an account to request advance food ordering and checkout.",
  );
}

function startReservationRedirectCountdown() {
  clearReservationRedirectTimer();
  let seconds = 7;
  reservationRedirectCountdown.textContent = seconds;
  const redirectTarget = currentCustomer ? "menu" : "signup";

  reservationRedirectTimer = setInterval(() => {
    seconds -= 1;
    reservationRedirectCountdown.textContent = seconds;
    if (seconds <= 0) {
      clearReservationRedirectTimer();
      if (redirectTarget === "menu") {
        redirectToMenu();
      } else {
        redirectToSignup();
      }
    }
  }, 1000);
}

reservationAdvanceOrderCheckbox.addEventListener("change", () => {
  if (reservationAdvanceOrderCheckbox.checked) {
    reservationAdvanceInfo.style.display = "block";
    reservationAdvanceInfoText.textContent = currentCustomer
      ? "Requesting advanced food ordering will take you to the menu in "
      : "Requesting advanced food ordering requires an account. Redirecting to signup in ";
    reservationAdvanceInfoText.innerHTML +=
      '<span id="reservationRedirectCountdown">7</span> seconds.';
    startReservationRedirectCountdown();
  } else {
    reservationAdvanceInfo.style.display = "none";
    clearReservationRedirectTimer();
  }
});

reservationGoToMenuBtn.addEventListener("click", () => {
  clearReservationRedirectTimer();
  if (!currentCustomer) {
    redirectToSignup();
    return;
  }

  redirectToMenu();
});

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
    cart_items: (() => {
      try {
        return JSON.parse(localStorage.getItem("fulude_cart") || "[]").map(
          (item) => ({
            id: item.itemId,
            quantity: item.quantity,
            spice_level: item.spiceLevel,
            extras: (item.extras || []).map((extra) => extra.id),
          }),
        );
      } catch {
        return [];
      }
    })(),
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

    reservationForm.reset();
    reservationAdvanceInfo.style.display = "none";
    reservationSuccess.textContent =
      data.message || "Reservation request received.";
    reservationSuccess.style.display = "block";
    if (data.payment?.action_url)
      window.location.href = data.payment.action_url;
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
const MY_ORDERS_POLL_MS = 15000; // status can change any time the kitchen updates it
const CUSTOMER_CANCEL_WINDOW_MS = 2 * 60 * 1000; // keep in sync with CUSTOMER_CANCEL_WINDOW_MS in functions/api/order.js
let expandedReceipts = new Set(); // which order ids currently have "View Receipt" open
let myOrdersPollTimer = null;
let cancelCountdownTimer = null;

async function openMyOrdersModal() {
  myOrdersModal.classList.add("active");
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
 * separate from the 15s network poll so the countdown doesn't look stuck.
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
      myOrdersList.innerHTML = `<p class="menu-empty">You haven't placed any orders yet.</p>`;
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
        if (!res.ok || !data.payment?.action_url)
          throw new Error(data.error || "Couldn't retry payment.");
        window.location.href = data.payment.action_url;
      } catch (err) {
        alert(err.message);
        btn.disabled = false;
      }
    });
  });
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
function renderStatusTracker(order) {
  if (order.status === "Cancelled") {
    return `<div class="order-status-cancelled"><i class="fas fa-circle-xmark"></i> This order was cancelled</div>`;
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
 * Customers can cancel their own order for a short window right after
 * placing it (while it's still "New" and within 2 minutes) - after that,
 * or once staff starts preparing it, this returns nothing and the button
 * simply isn't offered. The server re-checks both conditions itself
 * (functions/api/order.js onRequestPut), so this is just UI convenience.
 */
function renderCancelSection(order) {
  if (order.status !== "New") return "";

  const createdAtMs = new Date(order.created_at).getTime();
  const cancelExpiresAtMs = order.kitchen_release_at
    ? new Date(order.kitchen_release_at).getTime()
    : createdAtMs + CUSTOMER_CANCEL_WINDOW_MS;
  const msLeft = cancelExpiresAtMs - Date.now();
  if (msLeft <= 0) return "";

  const isPaid =
    order.payment_method === "online" && order.payment_status === "paid";

  return `
    <div class="receipt-cancel-row">
      <button type="button" class="receipt-cancel-btn" data-cancel-order="${order.id}" data-cancel-expires-at="${cancelExpiresAtMs}" data-paid="${isPaid}">
        Cancel Order <span data-cancel-countdown="${order.id}">(${formatCountdown(msLeft)} left)</span>
      </button>
    </div>
  `;
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

      ${renderStatusTracker(order)}
      ${renderCancelSection(order)}

      <button type="button" class="receipt-toggle-btn" data-toggle-receipt="${order.id}">${isOpen ? "Hide Receipt" : "View Receipt"}</button>

      <div class="receipt-details${isOpen ? " open" : ""}" data-order-id="${order.id}">
        <div class="receipt-meta">${order.pickup_time} · ${paymentText}</div>
        ${retryPayment ? `<button type="button" class="receipt-cancel-btn" data-retry-payment="${order.id}">Retry Payment</button>` : ""}
        <ul class="receipt-items">${itemsHtml}</ul>
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
async function loadConfig() {
  const buffetSection = document.getElementById("buffetSection");
  if (!buffetSection) return;
  try {
    const res = await fetch("/api/config");
    if (!res.ok) return;
    const config = await res.json();
    if (config.is_buffet_visible) {
      buffetSection.style.display = "block";
      try {
        loadPublicBuffet();
      } catch (e) {
        /* ignore */
      }
    }
  } catch {
    /* non-critical - buffet section just stays hidden */
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
