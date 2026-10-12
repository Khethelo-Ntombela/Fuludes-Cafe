// Shared form validation for the customer site, the admin dashboard and the staff board
const FuludeValidation = (() => {
  const MESSAGES = {
    name: "Please enter a full name (at least 2 letters).",
    email: "Please enter a valid email address, e.g. name@example.com.",
    phone: "Please enter a valid phone number, e.g. 066 364 9016 or +27 66 364 9016.",
    password: "The password needs at least 8 characters.",
    pastDate: "Please choose today or a date in the future.",
    pastDateTime: "Please choose a date and time in the future.",
  };

  const nameOk = (v) => v.length >= 2 && v.length <= 100 && /\p{L}/u.test(v);
  const emailOk = (v) => v.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(v);
  function phoneOk(v) {
    if (!/^\+?[\d\s().-]+$/.test(v)) return false;
    const d = v.replace(/\D/g, "");
    if (d.startsWith("0")) return d.length === 10;
    if (d.startsWith("27")) return d.length === 11;
    return d.length >= 9 && d.length <= 15;
  }
  const pad = (n) => String(n).padStart(2, "0");
  function todayKey() {
    const n = new Date();
    return `${n.getFullYear()}-${pad(n.getMonth() + 1)}-${pad(n.getDate())}`;
  }
  function nowLocalKey() {
    const n = new Date();
    return `${todayKey()}T${pad(n.getHours())}:${pad(n.getMinutes())}`;
  }

  /** Re-checks on every keystroke; an empty field is left to `required`. */
  function bind(el, test, message) {
    if (!el || el.dataset.fvBound) return;
    el.dataset.fvBound = "1";
    const check = () => {
      const v = el.value.trim();
      el.setCustomValidity(!v || test(v, el) ? "" : typeof message === "function" ? message(el) : message);
    };
    el._fvCheck = check;
    el.addEventListener("input", check);
    el.addEventListener("change", check);
    check();
  }

  const byId = (id) => document.getElementById(id);
  let config = {};

  function enhance() {
    const c = config;
    document.querySelectorAll('input[type="tel"]').forEach((el) => {
      el.maxLength = 20;
      el.inputMode = "tel";
      if (!el.autocomplete) el.autocomplete = "tel";
      if (!el.placeholder) el.placeholder = "e.g. 066 364 9016";
      bind(el, phoneOk, MESSAGES.phone);
    });
    document.querySelectorAll('input[type="email"]').forEach((el) => {
      el.maxLength = 254;
      bind(el, emailOk, MESSAGES.email);
    });
    (c.names || []).forEach((id) => {
      const el = byId(id);
      if (!el) return;
      el.minLength = 2;
      el.maxLength = 100;
      bind(el, nameOk, MESSAGES.name);
    });
    (c.newPasswords || []).forEach((id) => {
      const el = byId(id);
      if (!el) return;
      el.minLength = 8;
      el.maxLength = 128;
      bind(el, (v) => v.length >= 8, MESSAGES.password);
    });
    (c.futureDates || []).forEach((id) => {
      const el = byId(id);
      if (!el) return;
      el.min = todayKey();
      bind(el, (v) => v >= todayKey(), MESSAGES.pastDate);
    });
    (c.futureDateTimes || []).forEach((id) => {
      const el = byId(id);
      if (!el) return;
      el.min = nowLocalKey();
      bind(el, (v) => v >= nowLocalKey(), MESSAGES.pastDateTime);
    });
    Object.entries(c.numbers || {}).forEach(([id, r]) => {
      const el = byId(id);
      if (!el) return;
      if (r.min !== undefined) el.min = r.min;
      if (r.max !== undefined) el.max = r.max;
      if (r.step !== undefined) el.step = r.step;
      if (r.title && !el.title) el.title = r.title;
    });
    Object.entries(c.maxLengths || {}).forEach(([id, max]) => {
      const el = byId(id);
      if (el) el.maxLength = max;
    });
    Object.entries(c.patterns || {}).forEach(([id, p]) => {
      const el = byId(id);
      if (!el) return;
      el.pattern = p.pattern;
      el.title = p.title;
    });
    (c.custom || []).forEach(({ id, test, message }) => bind(byId(id), test, message));
  }

  /** Fields filled in or cleared by code don't fire "input" - re-check as a form is submitted or reset. */
  function recheck(root) {
    if (root) root.querySelectorAll("[data-fv-bound]").forEach((el) => el._fvCheck && el._fvCheck());
  }
  document.addEventListener(
    "click",
    (e) => {
      const btn = e.target.closest && e.target.closest('button, input[type="submit"]');
      if (btn && btn.form) recheck(btn.form);
    },
    true,
  );
  document.addEventListener("reset", (e) => setTimeout(() => recheck(e.target)), true);

  let observing = false;
  function apply(pageConfig) {
    config = pageConfig || {};
    enhance();
    if (observing) return;
    observing = true;
    // Windows built later (account settings, Place Order, buffet seats...) get the same rules.
    new MutationObserver(() => {
      clearTimeout(apply.timer);
      apply.timer = setTimeout(enhance, 50);
    }).observe(document.body, { childList: true, subtree: true });
  }

  // For actions sent from a plain button: checks the given fields
  function check(ids) {
    enhance();
    for (const id of ids) {
      const el = byId(id);
      if (!el || el.offsetParent === null) continue; // missing or hidden (e.g
      if (el._fvCheck) el._fvCheck();
      if (!el.checkValidity()) {
        el.reportValidity();
        el.focus();
        return false;
      }
    }
    return true;
  }

  return { apply, check, MESSAGES, todayKey };
})();
