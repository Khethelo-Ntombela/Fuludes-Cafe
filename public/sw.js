/* Service worker: makes the site installable as an app and gives an offline
   fallback. API calls are never cached (orders/payments must be live). */
const CACHE = "fulude-shell-v3";
const SHELL = ["/home.html", "/offline.html", "/css/style.css", "/js/site.js", "/icon-192.png"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});
self.addEventListener("fetch", (e) => {
  const req = e.request;
  const url = new URL(req.url);
  if (req.method !== "GET" || url.origin !== location.origin || url.pathname.startsWith("/api/")) return;
  if (req.mode === "navigate") {
    e.respondWith(fetch(req).catch(() => caches.match(req).then((r) => r || caches.match("/offline.html"))));
    return;
  }
  // static assets: network first, fall back to cache
  e.respondWith(
    fetch(req)
      .then((res) => {
        if (res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(req, copy)); }
        return res;
      })
      .catch(() => caches.match(req))
  );
});

/* Push notifications (new orders for admin/kitchen, order + booking updates
   for customers) - delivered even when the app is closed. Sent by
   functions/_lib/push.js. */
self.addEventListener("push", (e) => {
  let data = {};
  try {
    data = e.data ? e.data.json() : {};
  } catch {
    data = { title: "Fulude's Cafe", body: e.data ? e.data.text() : "" };
  }
  e.waitUntil(
    self.registration.showNotification(data.title || "Fulude's Cafe", {
      body: data.body || "",
      icon: "/icon-192.png",
      badge: "/icon-192.png",
      tag: data.tag,
      renotify: Boolean(data.tag),
      data: { url: data.url || "/" },
    }),
  );
});

self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  const target = new URL(e.notification.data?.url || "/", self.location.origin);
  e.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((wins) => {
      // Reuse an open window of the same page (admin, kitchen or customer app) if there is one.
      const same = wins.find((w) => new URL(w.url).pathname === target.pathname);
      if (same) return same.focus().then((w) => (w && "navigate" in w ? w.navigate(target.href) : w));
      return self.clients.openWindow(target.href);
    }),
  );
});
