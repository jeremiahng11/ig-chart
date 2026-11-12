/* IG Charts web push client (window.IGPush). Registers /sw.js (also used for the offline app shell). */
(() => {
  const ok = 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window && window.isSecureContext;
  const listeners = new Set();
  let current = ok ? (Notification.permission === 'denied' ? 'denied' : 'off') : 'unsupported';
  let reg = null;

  const set = (s) => { if (s !== current) { current = s; listeners.forEach((cb) => { try { cb(s); } catch {} }); } return s; };
  const api = async (url, method = 'GET', body) => {
    const r = await fetch(url, { method, credentials: 'same-origin', headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
    return j;
  };
  const keyBytes = (b64) => {
    const s = atob(b64.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (b64.length % 4)) % 4));
    return Uint8Array.from(s, (c) => c.charCodeAt(0));
  };
  const sameKey = (sub, key) => {
    const k = sub.options && sub.options.applicationServerKey;
    if (!k) return true;
    const a = new Uint8Array(k);
    return a.length === key.length && a.every((v, i) => v === key[i]);
  };
  const registration = async () => {
    if (!reg) reg = await navigator.serviceWorker.register('/sw.js');
    await navigator.serviceWorker.ready;
    return reg;
  };

  async function refresh() {
    if (!ok) return set('unsupported');
    if (Notification.permission === 'denied') return set('denied');
    const r = await registration();
    const sub = await r.pushManager.getSubscription();
    return set(sub && Notification.permission === 'granted' ? 'on' : 'off');
  }

  async function enable() {
    if (!ok) return set('unsupported');
    const perm = await Notification.requestPermission();
    if (perm !== 'granted') return set(perm === 'denied' ? 'denied' : 'off');
    const r = await registration();
    const key = keyBytes((await api('/api/push/key')).publicKey);
    let sub = await r.pushManager.getSubscription();
    if (sub && !sameKey(sub, key)) { await sub.unsubscribe(); sub = null; }
    if (!sub) sub = await r.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
    await api('/api/push/subscribe', 'POST', sub.toJSON());
    return set('on');
  }

  async function disable() {
    if (!ok) return set('unsupported');
    const r = await registration();
    const sub = await r.pushManager.getSubscription();
    if (sub) {
      await api('/api/push/subscribe', 'DELETE', { endpoint: sub.endpoint }).catch(() => {});
      await sub.unsubscribe().catch(() => {});
    }
    return set(Notification.permission === 'denied' ? 'denied' : 'off');
  }

  const test = () => api('/api/push/test', 'POST', {});

  window.IGPush = {
    supported: () => ok,
    state: () => current,
    refresh, enable, disable, test,
    onChange: (cb) => { listeners.add(cb); return () => listeners.delete(cb); },
    ready: 'serviceWorker' in navigator && window.isSecureContext
      ? registration().then(refresh).catch((e) => { console.warn('[push] service worker:', e.message); return current; })
      : Promise.resolve(current),
  };
})();
