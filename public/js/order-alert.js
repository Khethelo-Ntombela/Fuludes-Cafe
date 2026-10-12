// New-order sound for the admin dashboard and the staff/kitchen board
const FuludeOrderAlert = (() => {
  let ctx = null;
  let banner = null;

  function getContext() {
    if (ctx) return ctx;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    try {
      if (navigator.audioSession) navigator.audioSession.type = "playback";
    } catch {
      /* older browsers */
    }
    try {
      ctx = new AC();
    } catch {
      ctx = null;
    }
    return ctx;
  }

  function isRunning() {
    return !!ctx && ctx.state === "running";
  }

  /** Must run inside a tap/key handler the first time. */
  function unlock() {
    const c = getContext();
    if (!c) return Promise.resolve(false);
    // iOS: playing a silent buffer inside the tap is what actually unlocks it
    try {
      const src = c.createBufferSource();
      src.buffer = c.createBuffer(1, 1, 22050);
      src.connect(c.destination);
      src.start(0);
    } catch {
      /* ignore */
    }
    const p = c.state === "running" ? Promise.resolve() : c.resume();
    return p.then(() => {
      if (isRunning()) hideBanner();
      return isRunning();
    }).catch(() => false);
  }

  function init() {
    getContext();
    if (init.done) return;
    init.done = true;
    const onGesture = () => {
      if (!isRunning()) unlock();
    };
    ["pointerdown", "touchend", "keydown"].forEach((type) =>
      document.addEventListener(type, onGesture, { capture: true, passive: true }),
    );
    document.addEventListener("visibilitychange", () => {
      if (!document.hidden && ctx && ctx.state !== "running") ctx.resume().catch(() => {});
    });
  }

  /** Two-tone "ding-dong", loud enough to hear across a kitchen. */
  function chime(repeats) {
    const now = ctx.currentTime + 0.02;
    for (let i = 0; i < repeats; i++) {
      const base = now + i * 0.9;
      [
        [988, 0],
        [784, 0.3],
      ].forEach(([freq, offset]) => {
        const t = base + offset;
        const o = ctx.createOscillator();
        const g = ctx.createGain();
        o.type = "triangle";
        o.frequency.value = freq;
        o.connect(g);
        g.connect(ctx.destination);
        g.gain.setValueAtTime(0.0001, t);
        g.gain.exponentialRampToValueAtTime(0.6, t + 0.02);
        g.gain.exponentialRampToValueAtTime(0.0001, t + 0.55);
        o.start(t);
        o.stop(t + 0.6);
      });
    }
  }

  function play(repeats, mutedKey) {
    if (mutedKey && localStorage.getItem(mutedKey) === "1") return;
    const c = getContext();
    if (!c) return;
    const n = Math.max(2, Math.min(4, repeats || 2));
    if (c.state === "running") return chime(n);
    c.resume()
      .then(() => (isRunning() ? chime(n) : showBanner(n)))
      .catch(() => showBanner(n));
    // resume() can hang without a tap - show the bar if it hasn't started soon
    setTimeout(() => {
      if (!isRunning()) showBanner(n);
    }, 400);
  }

  function showBanner(repeats) {
    if (!banner) {
      banner = document.createElement("button");
      banner.type = "button";
      banner.className = "order-sound-banner";
      banner.innerHTML = '<i class="fas fa-volume-up"></i> New order - tap to turn on order sound';
      banner.addEventListener("click", () => {
        unlock().then((ok) => {
          if (ok) chime(banner.repeats || 2);
        });
      });
      document.body.appendChild(banner);
    }
    banner.repeats = repeats;
    banner.style.display = "flex";
  }

  function hideBanner() {
    if (banner) banner.style.display = "none";
  }

  /** Mute/unmute button; unmuting plays the chime so staff can check the volume. */
  function bindMuteButton(btn, icon, mutedKey) {
    if (!btn) return;
    const update = () => {
      const muted = localStorage.getItem(mutedKey) === "1";
      if (icon) icon.className = muted ? "fas fa-volume-mute" : "fas fa-volume-up";
      btn.title = muted ? "Unmute order alerts" : "Mute order alerts";
    };
    update();
    if (btn.dataset.alertBound) return; // bound on an earlier login
    btn.dataset.alertBound = "1";
    btn.addEventListener("click", () => {
      const muted = localStorage.getItem(mutedKey) === "1";
      localStorage.setItem(mutedKey, muted ? "0" : "1");
      update();
      if (muted) unlock().then((ok) => ok && chime(1));
    });
  }

  return { init, play, bindMuteButton };
})();
