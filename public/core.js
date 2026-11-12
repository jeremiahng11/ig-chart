/* IG Charts — shared core: storage, settings, formatting, API, event bus, live quotes. */
(() => {
  const IGC = (window.IGC = window.IGC || {});
  const $ = (id) => document.getElementById(id);
  const esc = (t) => String(t ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  // ── storage: localStorage cache + server sync (/api/state) so every device sees the same workspace ─
  const SYNC_KEYS = new Set(['settings', 'layouts', 'watchlists', 'drawings', 'indTemplates', 'indFavs', 'ivFavs', 'ivCustom', 'ac', 'toolLast', 'recentSymbols', 'names', 'drawTemplates', 'acLog', 'mod.paper.v1', 'mod.paper.ticket', 'mod.scripts', 'mod.strategy', 'mt5Map', 'mt5Prefs', 'cursorMode', 'notes', 'tabGroups']);
  const CLIENT_ID = Math.random().toString(36).slice(2, 12);
  const lsGet = (k) => { try { return localStorage.getItem('igc.' + k); } catch { return null; } };
  const lsSet = (k, s) => { try { localStorage.setItem('igc.' + k, s); } catch {} };
  const versions = (() => { try { return JSON.parse(lsGet('__sync') || '{}'); } catch { return {}; } })();
  const saveVersions = () => lsSet('__sync', JSON.stringify(versions));
  const pending = new Map();
  let syncOn = false, flushT = null;
  const store = {
    get(k, d) { const v = lsGet(k); if (!v) return d; try { return JSON.parse(v); } catch { return d; } },
    set(k, v) { const s = JSON.stringify(v); if (lsGet(k) === s) return; lsSet(k, s); if (syncOn && SYNC_KEYS.has(k)) { pending.set(k, s); clearTimeout(flushT); flushT = setTimeout(flush, 800); } },
    del(k) { try { localStorage.removeItem('igc.' + k); } catch {} },
  };
  async function putKey(k, s, base) {
    const r = await fetch(`/api/state/${encodeURIComponent(k)}`, { method: 'PUT', credentials: 'same-origin', headers: { 'Content-Type': 'application/json', 'X-Client-Id': CLIENT_ID }, body: `{"value":${s},"baseVersion":${base == null ? 'null' : JSON.stringify(base)}}` });
    const j = await r.json().catch(() => ({}));
    if (r.status === 409) return putKey(k, s, j.version ?? null);
    if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
    versions[k] = j.version; saveVersions();
  }
  async function flush() {
    const items = [...pending]; pending.clear();
    for (const [k, s] of items) { try { await putKey(k, s, versions[k] ?? null); } catch (e) { console.warn('[sync]', k, e.message); bus && bus.emit('sync-status', 'error'); } }
  }
  window.addEventListener('beforeunload', () => { if (!pending.size) return; for (const [k, s] of pending) { try { navigator.sendBeacon && fetch(`/api/state/${encodeURIComponent(k)}`, { method: 'PUT', keepalive: true, credentials: 'same-origin', headers: { 'Content-Type': 'application/json', 'X-Client-Id': CLIENT_ID }, body: `{"value":${s},"baseVersion":${versions[k] == null ? 'null' : JSON.stringify(versions[k])}}` }); } catch {} } });
  async function pullKey(k) {
    const r = await fetch(`/api/state/${encodeURIComponent(k)}`, { credentials: 'same-origin' });
    if (!r.ok) return false;
    const j = await r.json();
    lsSet(k, JSON.stringify(j.value)); versions[k] = j.version; saveVersions();
    return true;
  }
  // Pull newer server state before the app reads storage; push local-only keys up (first run on this server).
  const ready = (async () => {
    try {
      const r = await fetch('/api/state', { credentials: 'same-origin' });
      if (!r.ok) return;
      const { keys = {} } = await r.json();
      syncOn = true;
      await Promise.all([...SYNC_KEYS].map(async (k) => {
        const srv = keys[k];
        if (srv && srv.version !== versions[k]) { await pullKey(k).catch(() => {}); return; }
        const local = lsGet(k);
        if (!srv && local != null) await putKey(k, local, null).catch(() => {});
      }));
    } catch (e) { console.warn('[sync] unavailable', e.message); }
  })();

  // ── settings / theme ─────────────────────────────────
  const SETTINGS_DEFAULTS = { theme: 'dark', up: '#26a69a', down: '#ef5350', grid: 'both', crosshair: 'normal', bidAsk: true, countdown: true, watermark: false, tz: 'Local', sound: true, maxBars: 500 };
  const settings = { ...SETTINGS_DEFAULTS, ...store.get('settings', {}) };
  const THEMES = {
    dark: { bg: '#0f1218', text: '#9aa4b2', grid: '#1a2029', border: '#232a35', cross: '#5d6673', crossLabel: '#2a3140', wm: 'rgba(214,219,227,.06)', level: 'rgba(120,123,134,.55)', accent: '#2962ff', panel: '#151a22' },
    light: { bg: '#ffffff', text: '#4a5160', grid: '#f0f3fa', border: '#e0e3eb', cross: '#9598a1', crossLabel: '#4a5160', wm: 'rgba(19,23,34,.06)', level: 'rgba(120,123,134,.6)', accent: '#2962ff', panel: '#ffffff' },
  };
  const T = () => ({ ...(THEMES[settings.theme] || THEMES.dark), up: settings.up, down: settings.down });
  const alpha = (hex, a) => { if (!/^#[0-9a-f]{6}$/i.test(hex)) return hex; const n = parseInt(hex.slice(1), 16); return `rgba(${n >> 16},${(n >> 8) & 255},${n & 255},${a})`; };

  // ── formatting (bars stay UTC; labels follow the chosen timezone) ─
  const fmtCache = new Map();
  const dtf = (opts) => {
    const k = settings.tz + JSON.stringify(opts);
    if (!fmtCache.has(k)) fmtCache.set(k, new Intl.DateTimeFormat(undefined, { ...(settings.tz === 'Local' ? {} : { timeZone: settings.tz }), ...opts }));
    return fmtCache.get(k);
  };
  const fmtTime = (t, sec) => dtf(sec ? { year: '2-digit', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' } : { year: '2-digit', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(t * 1000));
  const fmtDate = (t) => dtf({ year: 'numeric', month: 'short', day: 'numeric' }).format(new Date(t * 1000));
  const tickFmt = (t, type) => {
    const d = new Date(t * 1000);
    if (type === 0) return dtf({ year: 'numeric' }).format(d);
    if (type === 1) return dtf({ month: 'short' }).format(d);
    if (type === 2) return dtf({ day: 'numeric' }).format(d);
    if (type === 4) return dtf({ hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).format(d);
    return dtf({ hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(d);
  };
  const fmtNum = (v, d = 2) => (v == null || !Number.isFinite(v) ? '—' : Number(v).toLocaleString(undefined, { minimumFractionDigits: d, maximumFractionDigits: d }));
  const fmtVal = (v) => { if (v == null || !Number.isFinite(v)) return '—'; const a = Math.abs(v); return a >= 1e9 ? (v / 1e9).toFixed(2) + 'B' : a >= 1e6 ? (v / 1e6).toFixed(2) + 'M' : a >= 1e4 ? (v / 1e3).toFixed(1) + 'K' : v.toFixed(a >= 1 ? 2 : 4); };
  const durText = (s) => { const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.round((s % 3600) / 60); return [d && `${d}d`, h && `${h}h`, (m || (!d && !h)) && `${m}m`].filter(Boolean).join(' '); };

  // ── API ──────────────────────────────────────────────
  async function api(p, opts = {}) {
    const init = { method: opts.method || 'GET', credentials: 'same-origin', headers: { 'X-Client-Id': CLIENT_ID } };
    if (opts.body !== undefined) { init.body = JSON.stringify(opts.body); init.headers['Content-Type'] = 'application/json'; }
    const r = await fetch(p, init);
    const j = await r.json().catch(() => ({}));
    if (!r.ok) { const e = new Error(j.error || `HTTP ${r.status}`); e.status = r.status; e.body = j; throw e; }
    return j;
  }

  // ── event bus ────────────────────────────────────────
  const handlers = new Map();
  const bus = {
    on(ev, cb) { if (!handlers.has(ev)) handlers.set(ev, new Set()); handlers.get(ev).add(cb); return () => handlers.get(ev).delete(cb); },
    emit(ev, ...a) { const s = handlers.get(ev); if (s) for (const cb of [...s]) { try { cb(...a); } catch (e) { console.error('[bus]', ev, e); } } },
  };

  // ── names / quotes / live stream ─────────────────────
  const names = store.get('names', {});
  const nameOf = (epic) => names[epic] || epic;
  const setName = (epic, n) => { if (n && names[epic] !== n) { names[epic] = n; store.set('names', names); } };
  const quotes = {};
  const subs = new Map(); // epic -> refcount
  let ws, wsBackoff = 1000, wsOpened = false, streamStatus = 'connecting';
  const wsSend = (m) => { if (ws && ws.readyState === 1) ws.send(JSON.stringify(m)); };
  function subscribe(epics) {
    const fresh = [];
    for (const e of epics) { if (!e) continue; const n = subs.get(e) || 0; subs.set(e, n + 1); if (!n) fresh.push(e); }
    if (fresh.length) wsSend({ type: 'subscribe', epics: fresh });
  }
  function unsubscribe(epics) {
    const gone = [];
    for (const e of epics) { const n = subs.get(e) || 0; if (n <= 1) { subs.delete(e); if (n) gone.push(e); } else subs.set(e, n - 1); }
    if (gone.length) wsSend({ type: 'unsubscribe', epics: gone });
  }
  function connect() {
    ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);
    ws.onopen = () => { if (wsOpened) bus.emit('reconnect'); wsOpened = true; wsBackoff = 1000; if (subs.size) wsSend({ type: 'subscribe', epics: [...subs.keys()] }); };
    ws.onmessage = (ev) => {
      let m; try { m = JSON.parse(ev.data); } catch { return; }
      if (m.type === 'status') { streamStatus = m.stream; bus.emit('status', m.stream); return; }
      if (m.type === 'trade') { bus.emit('trade', m); return; }
      if (m.type === 'tick') {
        const q = (quotes[m.epic] = { ...quotes[m.epic], ...Object.fromEntries(Object.entries(m).filter(([, v]) => v != null)) });
        bus.emit('tick', m.epic, q);
        return;
      }
      if (m.type === 'alert') bus.emit('alert', m);
      if (m.type === 'alerts-changed') bus.emit('alerts-changed');
      if (m.type === 'mt5') bus.emit('mt5', m);
      if (m.type === 'state-changed' && m.origin !== CLIENT_ID && SYNC_KEYS.has(m.key) && m.version !== versions[m.key]) pullKey(m.key).then((ok) => ok && bus.emit('state-remote', m.key)).catch(() => {});
    };
    ws.onclose = (ev) => {
      streamStatus = 'server disconnected'; bus.emit('status', streamStatus);
      const delay = wsBackoff; wsBackoff = Math.min(wsBackoff * 2, 15000);
      if (ev.code === 4401) fetch('/api/status', { credentials: 'same-origin' }).catch(() => {}).finally(() => setTimeout(connect, 500));
      else setTimeout(connect, delay);
    };
  }
  const mid = (q) => (q && q.bid != null ? (q.offer != null ? (q.bid + q.offer) / 2 : q.bid) : null);

  // ── toasts / sound / notifications ───────────────────
  function toast(text, kind = '') {
    let box = $('toasts');
    if (!box) { box = document.createElement('div'); box.id = 'toasts'; box.className = 'toasts'; document.body.appendChild(box); }
    const t = document.createElement('div');
    t.className = 'toast-item ' + kind; t.textContent = text; t.title = 'Click to dismiss'; t.onclick = () => t.remove();
    box.prepend(t);
    setTimeout(() => t.remove(), kind === 'alert' ? 20000 : 2600);
  }
  let audio = null;
  const unlockAudio = () => { try { audio = audio || new (window.AudioContext || window.webkitAudioContext)(); if (audio.state === 'suspended') audio.resume(); } catch {} };
  document.addEventListener('pointerdown', unlockAudio, { once: true });
  function beep(up = true) {
    if (!audio || !settings.sound) return;
    [0, 0.18, 0.36].forEach((t, k) => {
      const o = audio.createOscillator(), g = audio.createGain();
      o.type = 'sine'; o.frequency.value = up ? 660 + k * 220 : 1100 - k * 220;
      g.gain.setValueAtTime(0.0001, audio.currentTime + t);
      g.gain.exponentialRampToValueAtTime(0.25, audio.currentTime + t + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, audio.currentTime + t + 0.16);
      o.connect(g).connect(audio.destination); o.start(audio.currentTime + t); o.stop(audio.currentTime + t + 0.17);
    });
  }
  const notify = (title, body) => { try { if ('Notification' in window && Notification.permission === 'granted') new Notification(title, { body, tag: title + body }); } catch {} };

  function download(name, text, type = 'text/csv') {
    const a = document.createElement('a');
    a.download = name;
    a.href = typeof text === 'string' && text.startsWith('data:') ? text : URL.createObjectURL(new Blob([text], { type }));
    a.click();
    setTimeout(() => { if (a.href.startsWith('blob:')) URL.revokeObjectURL(a.href); }, 2000);
  }
  const csvCell = (v) => { const s = v == null ? '' : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  const toCSV = (rows) => rows.map((r) => r.map(csvCell).join(',')).join('\n');

  // ── IG resolutions ↔ seconds ─────────────────────────
  const RES_SEC = { SECOND: 1, MINUTE: 60, MINUTE_2: 120, MINUTE_3: 180, MINUTE_5: 300, MINUTE_10: 600, MINUTE_15: 900, MINUTE_30: 1800, HOUR: 3600, HOUR_2: 7200, HOUR_3: 10800, HOUR_4: 14400, DAY: 86400, WEEK: 604800, MONTH: 2592000 };
  const RESOLUTIONS = Object.keys(RES_SEC);

  Object.assign(IGC, {
    $, esc, uid, store, ready, CLIENT_ID, SYNC_KEYS, settings, SETTINGS_DEFAULTS, saveSettings: () => store.set('settings', settings), THEMES, T, alpha,
    dtf, fmtTime, fmtDate, tickFmt, fmtNum, fmtVal, durText, clearFmtCache: () => fmtCache.clear(),
    api, bus, names, nameOf, setName, quotes, mid, subscribe, unsubscribe, connect, wsSend, get streamStatus() { return streamStatus; },
    toast, beep, notify, unlockAudio, download, toCSV, RES_SEC, RESOLUTIONS,
  });
})();
