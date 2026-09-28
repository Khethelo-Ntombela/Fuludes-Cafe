const portalLoginForm = document.getElementById("portalLoginForm");
const portalLoginError = document.getElementById("portalLoginError");
const portalSubmitButton = portalLoginForm.querySelector('button[type="submit"]');

const loginRoutes = [
  { url: "/api/admin/login", tokenKey: "fulude_admin_token", destination: "/admin.html" },
  { url: "/api/staff/login", tokenKey: "fulude_staff_token", destination: "/staff.html" },
  { url: "/api/auth/login", tokenKey: "fulude_customer_token", destination: "/home.html" },
];

function showLoginError(message) {
  portalLoginError.textContent = message;
  portalLoginError.style.display = "block";
  portalLoginError.classList.toggle("is-locked", message.toLowerCase().includes("account has been locked"));
}

function getCustomerDestination() {
  const requested = new URLSearchParams(location.search).get("next");
  if (!requested) return "/home.html";

  try {
    const destination = new URL(requested, location.origin);
    if (destination.origin !== location.origin) return "/home.html";
    if (/\/(admin|staff)\.html$/i.test(destination.pathname)) return "/home.html";
    if (/\/(signin|index\.html)$/i.test(destination.pathname)) return "/home.html";
    return `${destination.pathname}${destination.search}${destination.hash}`;
  } catch {
    return "/home.html";
  }
}

portalLoginForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  portalLoginError.style.display = "none";
  portalLoginError.classList.remove("is-locked");
  portalSubmitButton.disabled = true;
  portalSubmitButton.textContent = "Signing in...";

  const credentials = {
    email: document.getElementById("portalEmail").value.trim(),
    password: document.getElementById("portalPassword").value,
  };

  try {
    for (const route of loginRoutes) {
      const response = await fetch(route.url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(credentials),
      });
      const data = await response.json().catch(() => ({}));

      if (response.ok && data.success && data.token) {
        localStorage.setItem(route.tokenKey, data.token);
        if (route.tokenKey === "fulude_customer_token" && data.customer) {
          localStorage.setItem("fulude_customer_name", data.customer.name.split(" ")[0]);
        }
        location.replace(
          route.tokenKey === "fulude_customer_token"
            ? getCustomerDestination()
            : route.destination,
        );
        return;
      }

      if (data.code === "account_not_found") continue;
      showLoginError(data.error || "We couldn't sign you in. Please try again.");
      return;
    }

    showLoginError("Incorrect email or password.");
  } catch {
    showLoginError("We couldn't connect to the sign-in service. Please try again.");
  } finally {
    portalSubmitButton.disabled = false;
    portalSubmitButton.textContent = "Sign in";
  }
});

document.getElementById("forgotAdminPassword").addEventListener("click", async () => {
  const email = prompt("Enter the main admin email address for the password reset link:");
  if (!email) return;

  try {
    const response = await fetch("/api/admin/forgot-password", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: email.trim() }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || !data.success) {
      throw new Error(data.error || "Couldn't process the password reset request.");
    }
    alert(data.message || "If that email has an admin account, a reset link is on its way.");
  } catch (error) {
    alert(error.message || "Couldn't process the password reset request.");
  }
});
