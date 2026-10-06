/**
 * public/js/pwa.js
 * -----------------------------------------------------------------------
 * Shared by the admin app, the kitchen (staff) app and the customer site:
 *   - FuludePWA.setupInstallButton(label): floating "Install app" button
 *     (Chrome/Edge/Android; iPhone uses Share > Add to Home Screen)
 *   - FuludePWA.bindPushToggle(btn, role, getToken): on/off button for
 *     push notifications that arrive even when the app is closed
 *     (server side: functions/api/push/subscribe.js + functions/_lib/push.js)
 * -----------------------------------------------------------------------
 */
const FuludePWA = (() => {
  const isStandalone = () => window.matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;
  const isIos = () => /iphone|ipad|ipod/i.test(navigator.userAgent);
  const pushSupported = () => "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
  const storageKey = (role) => `fulude_push_${role}`;
  const safeGet = (k) => {
    try {
      return localStorage.getItem(k);
    } catch {
      return null;
    }
  };
  const safeSet = (k, v) => {
    try {
      if (v === null) localStorage.removeItem(k);
      else localStorage.setItem(k, v);
    } catch {
      /* storage blocked - the toggle just won't remember its state */
    }
  };

  function setupInstallButton(label = "Install app") {
    if (isStandalone()) return;
    let deferred = null;
    const btn = document.createElement("button");
    btn.type = "button";
    btn.innerHTML = `<i class="fas fa-download"></i> ${label}`;
    btn.style.cssText =
      "display:none;position:fixed;left:16px;bottom:16px;z-index:150;background:#000;color:#fff;border:1.5px solid #b8963f;border-radius:999px;padding:10px 18px;font-weight:600;cursor:pointer;box-shadow:0 4px 14px rgba(0,0,0,.3)";
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
  }

  function keyToBytes(b64url) {
    const b64 = b64url.replace(/-/g, "+").replace(/_/g, "/");
    const bin = atob(b64 + "=".repeat((4 - (b64.length % 4)) % 4));
    return Uint8Array.from(bin, (c) => c.charCodeAt(0));
  }

  async function registration() {
    await navigator.serviceWorker.register("/sw.js");
    return navigator.serviceWorker.ready;
  }

  async function enable(role, token) {
    if (!pushSupported()) {
      throw new Error(
        isIos() && !isStandalone()
          ? "On iPhone/iPad, first add this app to your Home Screen (Share > Add to Home Screen), open it from there, then turn notifications on."
          : "This browser doesn't support notifications.",
      );
    }
    const permission = await Notification.requestPermission();
    if (permission !== "granted") {
      throw new Error("Notifications are blocked. Allow them for this site in your browser/phone settings, then try again.");
    }
    const reg = await registration();
    const keyRes = await fetch("/api/push/subscribe");
    const { publicKey, error } = await keyRes.json().catch(() => ({}));
    if (!keyRes.ok || !publicKey) throw new Error(error || "Notifications aren't available right now.");

    let sub = await reg.pushManager.getSubscription();
    // A subscription made with a different server key can't receive our pushes.
    const existingKey = sub?.options?.applicationServerKey;
    if (sub && existingKey && btoa(String.fromCharCode(...new Uint8Array(existingKey))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "") !== publicKey) {
      await sub.unsubscribe();
      sub = null;
    }
    if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyToBytes(publicKey) });

    const res = await fetch("/api/push/subscribe", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify({ role, subscription: sub.toJSON() }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.success) throw new Error(data.error || "Couldn't turn on notifications.");
    safeSet(storageKey(role), "on");
  }

  async function disable(role) {
    safeSet(storageKey(role), null);
    if (!pushSupported()) return;
    const reg = await navigator.serviceWorker.getRegistration();
    const sub = reg && (await reg.pushManager.getSubscription());
    if (!sub) return;
    await fetch("/api/push/subscribe", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ endpoint: sub.endpoint }),
    }).catch(() => {});
    await sub.unsubscribe().catch(() => {});
  }

  async function isOn(role) {
    if (!pushSupported() || Notification.permission !== "granted" || safeGet(storageKey(role)) !== "on") return false;
    const reg = await navigator.serviceWorker.getRegistration();
    return Boolean(reg && (await reg.pushManager.getSubscription()));
  }

  /** Turns `btn` into an on/off switch. getToken() returns the signed-in bearer token. */
  function bindPushToggle(btn, role, getToken, { onLabel = "Notifications on", offLabel = "Turn on notifications" } = {}) {
    if (!btn) return;
    const render = async () => {
      const on = await isOn(role).catch(() => false);
      btn.innerHTML = `<i class="fas ${on ? "fa-bell" : "fa-bell-slash"}"></i> <span>${on ? onLabel : offLabel}</span>`;
      btn.title = on ? "Tap to turn phone notifications off" : "Get notified even when the app is closed";
      btn.classList.toggle("is-on", on);
    };
    btn.addEventListener("click", async () => {
      btn.disabled = true;
      try {
        if (await isOn(role)) await disable(role);
        else await enable(role, getToken());
      } catch (err) {
        alert(err.message || "Couldn't change notifications.");
      } finally {
        btn.disabled = false;
        render();
      }
    });
    render();
  }

  return { setupInstallButton, bindPushToggle, pushSupported };
})();
