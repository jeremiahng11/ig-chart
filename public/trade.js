/* IG Trading: real IG orders from the chart. Every order, close and amend is previewed by the server, shown in a
   confirmation dialog and executed only with the single-use confirm token the preview returned. */
(function () {
  'use strict';
  const C = window.IGC;
  if (!C) return;
  const { esc, api, bus, store, toast, fmtNum, fmtTime } = C;
  const OWNER = 'igtrade', PREF_KEY = 'trade.prefs';
  const prefs = Object.assign({
    lines: true, drag: true, oneClick: false, oneClickLive: false, follow: true, epic: null, used: false,
    orderType: 'MARKET', size: '', level: '', stopMode: 'none', stop: '', limitMode: 'none', limit: '', guaranteed: false, trailing: false, trailInc: '', forceOpen: true,
  }, store.get(PREF_KEY, {}) || {});
  const savePrefs = () => store.set(PREF_KEY, prefs);
  const num = (v) => (v === '' || v == null || !Number.isFinite(+v) ? null : +v);
  const S = { status: null, accounts: [], positions: [], orders: [], activity: [], log: [], accountId: null, env: null, rules: new Map(), tab: 'positions',
    edit: null, busy: false, subs: [], loadedAt: 0, err: null, started: false, seen: new Set() };
  let inst = null;

  // ── DOM self-mounting: bottom-panel tab, pane, side button and stylesheet ──
  const ICON = '<svg class="ico" viewBox="0 0 18 18"><path d="M3 15V9M7 15V5M11 15V8M15 15V3" /><path d="M2 16.5h14" /></svg>';
  function ensureDom() {
    const tabs = document.querySelector('.bp-tabs'), body = document.querySelector('.bp-body');
    if (!tabs || !body) return null;
    if (!tabs.querySelector('[data-bp="trade"]')) {
      const b = document.createElement('button'); b.dataset.bp = 'trade'; b.textContent = 'IG Trading'; b.title = 'IG trading — real orders';
      tabs.insertBefore(b, tabs.querySelector('.spacer'));
    }
    let pane = body.querySelector('.bp-pane[data-pane="trade"]');
    if (!pane) { pane = document.createElement('div'); pane.className = 'bp-pane hidden'; pane.dataset.pane = 'trade'; body.appendChild(pane); }
    const sb = document.getElementById('sidebtns');
    if (sb && !sb.querySelector('[data-bp="trade"]')) {
      const b = document.createElement('button'); b.dataset.bp = 'trade'; b.title = 'IG trading (real orders)'; b.innerHTML = ICON;
      const after = sb.querySelector('[data-bp="mt5"]'); if (after) after.after(b); else sb.appendChild(b);
    }
    if (!document.querySelector('link[href="/trade.css"]')) { const l = document.createElement('link'); l.rel = 'stylesheet'; l.href = '/trade.css'; document.head.appendChild(l); }
    return pane;
  }

  const views = () => ((window.IGApp && window.IGApp.views) || []);
  const activeView = () => (window.IGApp && window.IGApp.active) || null;
  const isLive = () => S.env === 'LIVE';
  const enabled = () => !!(S.status && S.status.enabled);
  const decOf = (epic) => { const r = S.rules.get(epic); if (r && r.rules && Number.isInteger(r.rules.decimals)) return r.rules.decimals; const v = views().find((x) => x.symbol === epic); return v && Number.isInteger(v.decimals) ? v.decimals : 2; };
  const fp = (v, epic, d) => (v == null || !Number.isFinite(v) ? '—' : fmtNum(v, d ?? decOf(epic)));
  const money = (v, ccy) => (v == null || !Number.isFinite(v) ? '—' : `${v < 0 ? '−' : ''}${fmtNum(Math.abs(v), 2)}${ccy ? ' ' + esc(ccy) : ''}`);
  const quoteOf = (epic, fb) => { const q = C.quotes[epic]; return q && q.bid != null && q.offer != null ? q : fb && fb.bid != null ? { bid: fb.bid, offer: fb.offer } : null; };
  const pnlOf = (p) => { const q = quoteOf(p.epic, p); if (!q) return null; const x = p.direction === 'BUY' ? q.bid : q.offer; return (x - p.level) * (p.direction === 'BUY' ? 1 : -1) * p.size * (p.pointValue || 1); };
  const acct = () => S.accounts.find((a) => a.accountId === S.accountId) || S.accounts.find((a) => a.current) || null;
  const envBadge = (env) => `<span class="igt-env ${esc(String(env || '').toLowerCase())}">${env === 'LIVE' ? 'LIVE · REAL MONEY' : env === 'MOCK' ? 'SIMULATED' : esc(env || '…')}</span>`;

  // ── data ──
  async function loadStatus() {
    try { S.status = await api('/api/trade/status'); S.env = S.status.environment; } catch (e) { S.status = { enabled: false, reason: e.message }; }
  }
  async function load(force) {
    try {
      const d = await api(`/api/trade/snapshot${force ? '?force=1' : ''}`);
      Object.assign(S, { accounts: d.accounts || [], positions: d.positions || [], orders: d.orders || [], accountId: d.accountId, env: d.environment || S.env, loadedAt: Date.now(), err: null });
    } catch (e) { S.err = e.message; S.loadedAt = Date.now(); }
    syncSubs(); renderLines(); if (inst) inst.render();
  }
  let refreshT = null;
  const refreshSoon = (ms = 250) => { clearTimeout(refreshT); refreshT = setTimeout(() => load(true), ms); };
  async function rulesFor(epic) {
    if (!epic) return null;
    const c = S.rules.get(epic);
    if (c && Date.now() - c.at < 30000) return c.rules;
    try { const r = await api(`/api/trade/market/${encodeURIComponent(epic)}`); S.rules.set(epic, { at: Date.now(), rules: r }); return r; } catch (e) { S.rules.set(epic, { at: Date.now(), rules: null, err: e.message }); return null; }
  }
  function syncSubs() {
    const want = [...new Set([...S.positions.map((p) => p.epic), ...S.orders.map((w) => w.epic), ticketEpic()].filter(Boolean))];
    C.subscribe(want); C.unsubscribe(S.subs); S.subs = want;
  }

  // Trade events: the server broadcasts { type:'trade' } over /ws; core.js ignores unknown types, so listen on a
  // dedicated socket (and on bus 'trade' too, in case core.js forwards it).
  function onTradeEvent(m) {
    if (!m || m.type !== 'trade') return;
    const d = m.data || {};
    if (m.event === 'CONFIRMS' && d.dealReference && !S.seen.has(d.dealReference)) {
      S.seen.add(d.dealReference);
      if (d.reason && /TRIGGERED/.test(d.reason)) toast(`IG: ${d.reason.replace(/_/g, ' ').toLowerCase()} — ${d.epic} ${d.size ?? ''} @ ${fp(d.level, d.epic)}${d.profit != null ? ` (P&L ${money(d.profit, d.profitCurrency)})` : ''}`, 'alert');
    }
    refreshSoon(m.event === 'RESULT' ? 50 : 300);
  }
  let ws = null, wsBackoff = 1000;
  function openSocket() {
    try { ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`); } catch { return; }
    ws.onopen = () => { wsBackoff = 1000; };
    ws.onmessage = (ev) => { let m; try { m = JSON.parse(ev.data); } catch { return; } if (m.type === 'trade') onTradeEvent(m); };
    ws.onclose = () => { ws = null; setTimeout(openSocket, wsBackoff); wsBackoff = Math.min(wsBackoff * 2, 30000); };
  }

  function start() {
    if (S.started) return;
    S.started = true;
    loadStatus().then(() => load(true));
    openSocket();
    bus.on('trade', onTradeEvent);
    bus.on('tick', (epic) => { if (inst && S.subs.includes(epic)) inst.tick(epic); });
    bus.on('active-changed', () => { if (inst) inst.onActive(); renderLines(); });
    // Poll as a fallback: faster while the panel is visible, slower when IG pushes trade updates over Lightstreamer.
    setInterval(() => {
      const vis = inst && inst.visible();
      const push = S.status && S.status.push;
      const every = push === 'mock' ? (vis ? 4000 : 15000) : push === 'lightstreamer' ? (vis ? 30000 : 60000) : vis ? 8000 : 45000;
      if (Date.now() - S.loadedAt > every) load();
      renderLines();
    }, 1000);
  }

  // ── chart lines ──
  const sigs = new WeakMap();
  function renderLines(force) {
    const th = C.T ? C.T() : {}, up = th.up || '#26a69a', dn = th.down || '#ef5350', ac = '#2962ff';
    for (const v of views()) {
      if (!v || typeof v.setOverlay !== 'function') continue;
      const epic = v.symbol, lines = [], drag = prefs.drag && enabled();
      if (prefs.lines && epic) {
        for (const p of S.positions) {
          if (p.epic !== epic) continue;
          const c = p.direction === 'BUY' ? up : dn;
          lines.push({ id: `pos:${p.dealId}`, price: p.level, color: c, width: 2, style: 0, title: `IG ${p.direction} ${p.size}` });
          if (p.stopLevel != null) lines.push({ id: `sl:${p.dealId}`, price: p.stopLevel, color: dn, style: 2, title: `IG SL${p.trailingStopDistance != null ? ' (trail)' : ''}${p.guaranteedStop ? ' (G)' : ''}`, draggable: drag && !p.guaranteedStop });
          if (p.limitLevel != null) lines.push({ id: `tp:${p.dealId}`, price: p.limitLevel, color: up, style: 2, title: 'IG TP', draggable: drag });
        }
        for (const w of S.orders) {
          if (w.epic !== epic) continue;
          const sgn = w.direction === 'BUY' ? 1 : -1;
          lines.push({ id: `wo:${w.dealId}`, price: w.level, color: ac, style: 1, title: `IG ${w.direction} ${w.type} ${w.size}`, draggable: drag });
          if (w.stopDistance != null) lines.push({ id: `wsl:${w.dealId}`, price: w.level - sgn * w.stopDistance, color: dn, style: 1, title: 'IG order SL', draggable: drag && !w.guaranteedStop });
          if (w.limitDistance != null) lines.push({ id: `wtp:${w.dealId}`, price: w.level + sgn * w.limitDistance, color: up, style: 1, title: 'IG order TP', draggable: drag });
        }
      }
      const sig = epic + JSON.stringify(lines);
      if (!force && sigs.get(v) === sig) continue;
      sigs.set(v, sig);
      if (!lines.length) v.clearOverlay(OWNER);
      else v.setOverlay(OWNER, { lines }, { onDrag: (id, price) => onDrag(v, id, price) });
    }
  }
  async function onDrag(v, id, price) {
    const [kind, dealId] = [id.slice(0, id.indexOf(':')), id.slice(id.indexOf(':') + 1)];
    const p = S.positions.find((x) => x.dealId === dealId), w = S.orders.find((x) => x.dealId === dealId);
    const epic = (p || w || {}).epic, d = decOf(epic);
    const px = Math.round(price * 10 ** d) / 10 ** d;
    let action = null, params = null;
    if (kind === 'sl' && p) { action = 'amend'; params = { dealId, stopLevel: px }; }
    else if (kind === 'tp' && p) { action = 'amend'; params = { dealId, limitLevel: px }; }
    else if (kind === 'wo' && w) { action = 'order-amend'; params = { dealId, level: px }; }
    else if ((kind === 'wsl' || kind === 'wtp') && w) { action = 'order-amend'; params = { dealId, [kind === 'wsl' ? 'stopDistance' : 'limitDistance']: Math.round(Math.abs(px - w.level) * 10 ** d) / 10 ** d }; }
    if (action) await run(action, params);
    renderLines(true);
  }

  // ── preview → confirm → place ──
  const ACTION_LABEL = { open: 'Place order', close: 'Close position', amend: 'Amend stop / limit', 'order-amend': 'Amend working order', 'order-cancel': 'Cancel working order' };
  const oneClickOn = () => (isLive() ? prefs.oneClickLive : prefs.oneClick);
  async function run(action, params) {
    if (S.busy) { toast('Another IG request is in progress'); return null; }
    if (!enabled()) { toast((S.status && S.status.reason) || 'IG trading is disabled', 'alert'); return null; }
    S.busy = true; inst && inst.setBusy(true); inst && inst.msg('');
    try {
      const pv = await api('/api/trade/preview', { method: 'POST', body: { action, params } });
      if (!oneClickOn() && !(await confirmDialog(pv))) { inst && inst.msg('Cancelled — nothing was sent to IG.', 'muted'); return null; }
      const r = await api('/api/trade/place', { method: 'POST', body: { action, params, token: pv.token } });
      report(action, r.result || {});
      refreshSoon(50);
      return r;
    } catch (e) {
      const m = e.body && e.body.code ? `${e.message}` : e.message;
      inst && inst.msg(m); toast(`IG: ${m}`, 'alert');
      return null;
    } finally { S.busy = false; inst && inst.setBusy(false); }
  }
  function report(action, r) {
    if (r.dealReference) S.seen.add(r.dealReference);
    const what = `${r.direction || ''} ${r.size ?? ''} ${r.epic || ''}${r.level != null ? ` @ ${fp(r.level, r.epic)}` : ''}`.replace(/\s+/g, ' ').trim();
    if (r.dealStatus === 'ACCEPTED') {
      const t = `IG ${ACTION_LABEL[action].toLowerCase()}: accepted${what ? ' — ' + what : ''}${r.profit != null ? ` (P&L ${money(r.profit, r.profitCurrency)})` : ''}`;
      toast(t); inst && inst.msg(t, 'ok');
    } else if (r.dealStatus === 'REJECTED') {
      const t = `IG rejected: ${r.reason || 'unknown reason'}`; toast(t, 'alert'); inst && inst.msg(t);
    } else {
      const t = `IG outcome unknown (${r.reason || 'no confirmation'}) — check positions before retrying.`; toast(t, 'alert'); inst && inst.msg(t);
    }
  }

  function modalShell(cls, title, body, foot) {
    const host = document.getElementById('modals') || document.body;
    const m = document.createElement('div');
    m.className = `modal igt-modal ${cls || ''}`;
    m.innerHTML = `<div class="modal-card small"><div class="modal-head"><b>${title}</b><button class="x" data-res="0" title="Cancel">✕</button></div><div class="modal-body">${body}</div><div class="modal-foot">${foot}</div></div>`;
    host.appendChild(m);
    return m;
  }
  function settle(m, onKey) {
    return new Promise((resolve) => {
      const done = (v) => { document.removeEventListener('keydown', key, true); m.remove(); resolve(v); };
      const key = (e) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); done(false); } else if (onKey) onKey(e); };
      document.addEventListener('keydown', key, true);
      m.addEventListener('mousedown', (e) => { if (e.target === m) done(false); });
      m.addEventListener('click', (e) => { const b = e.target.closest('[data-res]'); if (b && !b.disabled) done(b.dataset.res === '1'); });
      const c = m.querySelector('[data-res="0"].igt-cancel'); if (c) c.focus();
      m._done = done;
    });
  }
  function confirmDialog(pv) {
    const s = pv.summary || {}, e = s.epic, live = s.environment === 'LIVE';
    const row = (k, v, cls = '') => (v == null || v === '' ? '' : `<tr class="${cls}"><th>${k}</th><td>${v}</td></tr>`);
    const dirCls = s.direction === 'BUY' ? 'buy' : s.direction === 'SELL' ? 'sell' : '';
    const ccy = s.instrumentCurrency || '';
    const lvl = (v) => (v == null ? null : fp(v, e, s.decimals));
    const rows = [
      row('Environment', envBadge(s.environment)),
      row('Account', `${esc(s.accountName || '')} <span class="muted">${esc(s.accountId || '')}${s.accountType ? ' · ' + esc(s.accountType) : ''}</span>`),
      row('Market', `<b>${esc(s.name || e)}</b> <span class="muted">${esc(e)}${s.expiry && s.expiry !== '-' ? ' · ' + esc(s.expiry) : ''}</span>`),
      row('Action', esc(ACTION_LABEL[pv.action] || pv.action)),
      row('Direction', s.direction ? `<b class="igt-dir ${dirCls}">${esc(s.direction)}</b>${pv.action === 'close' ? ` <span class="muted">(closing a ${esc(s.positionDirection)} position)</span>` : ''}` : null),
      row('Size', s.size != null ? `<b>${esc(s.size)}</b> contracts${s.positionSize != null ? ` <span class="muted">of ${esc(s.positionSize)}${s.full ? ' — full close' : ` — ${esc(s.remaining)} remains`}</span>` : ''}` : null),
      row('Order type', s.orderType ? esc(s.orderType) : null),
      row('Price', s.price != null ? `${lvl(s.price)} <span class="muted">${esc(s.priceNote || '')}</span>${s.previousLevel != null && s.previousLevel !== s.price ? ` <span class="muted">(was ${lvl(s.previousLevel)})</span>` : ''}` : null),
      row('Open level', s.openLevel != null ? lvl(s.openLevel) : null),
      pv.action === 'close' || pv.action === 'order-cancel' ? '' : row('Stop', s.stopLevel != null ? `${lvl(s.stopLevel)}${s.stopDistance != null ? ` <span class="muted">(${esc(s.stopDistance)} away)</span>` : ''}${s.guaranteedStop ? ' <b>guaranteed</b>' : ''}${s.trailingStop ? ` <b>trailing</b>${s.trailingStopIncrement ? ` step ${esc(s.trailingStopIncrement)}` : ''}` : ''}${s.previousStopLevel !== undefined ? ` <span class="muted">(was ${s.previousStopLevel == null ? 'none' : lvl(s.previousStopLevel)})</span>` : ''}` : `none${s.previousStopLevel != null ? ` <span class="muted">(was ${lvl(s.previousStopLevel)})</span>` : ''}`),
      pv.action === 'close' || pv.action === 'order-cancel' ? '' : row('Limit', s.limitLevel != null ? `${lvl(s.limitLevel)}${s.limitDistance != null ? ` <span class="muted">(${esc(s.limitDistance)} away)</span>` : ''}${s.previousLimitLevel !== undefined ? ` <span class="muted">(was ${s.previousLimitLevel == null ? 'none' : lvl(s.previousLimitLevel)})</span>` : ''}` : `none${s.previousLimitLevel != null ? ` <span class="muted">(was ${lvl(s.previousLimitLevel)})</span>` : ''}`),
      row('Est. margin', s.marginEst != null ? money(s.marginEst, ccy) : null),
      row('Est. risk at stop', s.riskEst != null ? money(s.riskEst, ccy) : pv.action === 'open' ? '<span class="igt-warn">no stop — risk not limited</span>' : null),
      row('Est. reward at limit', s.rewardEst != null ? money(s.rewardEst, ccy) : null),
      row('Est. P&L of closed part', s.pnlEst != null ? money(s.pnlEst, ccy) : null),
    ].join('');
    const warns = (s.warnings || []).map((w) => `<li>${esc(w)}</li>`).join('');
    const body = `${live ? '<div class="igt-livebar">LIVE ACCOUNT — this sends a real-money order to IG.</div>' : ''}
      <table class="igt-conf">${rows}</table>
      ${warns ? `<ul class="igt-warns">${warns}</ul>` : ''}
      <div class="igt-note muted">Estimates use IG market details (margin factor, contract size) and are indicative only.</div>
      ${live ? '<label class="igt-ack"><input type="checkbox" class="igt-ackbox"> I understand this is a real-money order on a LIVE account.</label>' : ''}`;
    const foot = `<span class="igt-ttl muted"></span><span class="sp"></span><button class="igt-cancel" data-res="0">Cancel</button><button class="primary igt-confirm ${dirCls}" data-res="1" ${live ? 'disabled' : ''}>Confirm ${esc(ACTION_LABEL[pv.action] || '')}</button>`;
    const m = modalShell(live ? 'live' : '', `Confirm IG order — ${esc(s.environment || '')}`, body, foot);
    const btn = m.querySelector('.igt-confirm'), ttl = m.querySelector('.igt-ttl'), ack = m.querySelector('.igt-ackbox');
    const tickT = setInterval(() => {
      const left = Math.max(0, Math.ceil((pv.expiresAt - Date.now()) / 1000));
      ttl.textContent = left > 0 ? `Quote/token valid ${left}s` : 'Expired — cancel and try again';
      if (left <= 0) btn.disabled = true;
    }, 250);
    if (ack) ack.onchange = () => { btn.disabled = !ack.checked || Date.now() > pv.expiresAt; };
    return settle(m).finally(() => clearInterval(tickT));
  }
  function simpleConfirm(title, html, okLabel, danger) {
    const m = modalShell(danger ? 'live' : '', esc(title), `<div class="igt-simple">${html}</div>`, `<span class="sp"></span><button class="igt-cancel" data-res="0">Cancel</button><button class="primary" data-res="1">${esc(okLabel)}</button>`);
    return settle(m);
  }

  // ── panel ──
  const ticketEpic = () => (prefs.follow ? (activeView() && activeView().symbol) || prefs.epic : prefs.epic);

  function mount(el, host) {
    if (inst) {
      if (el && inst.root.parentNode !== el) { el.textContent = ''; el.appendChild(inst.root); }
      inst.render(); return inst.api;
    }
    prefs.used = true; savePrefs();
    const root = document.createElement('div');
    root.className = 'igt';
    root.innerHTML = `
      <div class="igt-head">
        <span class="igt-envslot"></span>
        <select class="igt-acct" title="IG account"></select>
        <span class="igt-bal"></span>
        <span class="sp"></span>
        <span class="igt-push muted"></span>
        <label title="Show IG positions and working orders on the chart"><input type="checkbox" data-pref="lines"> Chart lines</label>
        <label title="Drag stop / limit / order lines on the chart to amend (always confirmed unless one-click is on)"><input type="checkbox" data-pref="drag"> Drag to amend</label>
        <label class="igt-oclab" title="Skip the confirmation dialog"><input type="checkbox" data-pref="oneclick"> One-click</label>
        <button data-act="refresh" title="Refresh">↻</button>
      </div>
      <div class="igt-gate hidden"></div>
      <div class="igt-body">
        <div class="igt-ticket">
          <div class="igt-sym"><b class="igt-name">—</b><label title="Ticket follows the active chart's symbol"><input type="checkbox" data-tk="follow"> follow chart</label></div>
          <div class="igt-bs">
            <button class="igt-sell" data-side="SELL"><small>Sell</small><b class="igt-bid">—</b></button>
            <span class="igt-spr"></span>
            <button class="igt-buy" data-side="BUY"><small>Buy</small><b class="igt-ask">—</b></button>
          </div>
          <div class="igt-grid">
            <label>Order type<select data-tk="orderType"><option value="MARKET">Market</option><option value="LIMIT">Limit (entry)</option><option value="STOP">Stop (entry)</option></select></label>
            <label>Size (contracts)<input data-tk="size" type="number" step="any" min="0"></label>
            <label class="full igt-lvl">Entry level<input data-tk="level" type="number" step="any"></label>
            <label>Stop<select data-tk="stopMode"><option value="none">None</option><option value="distance">Distance</option><option value="level">Level</option></select></label>
            <label>&nbsp;<input data-tk="stop" type="number" step="any" min="0"></label>
            <label>Limit<select data-tk="limitMode"><option value="none">None</option><option value="distance">Distance</option><option value="level">Level</option></select></label>
            <label>&nbsp;<input data-tk="limit" type="number" step="any" min="0"></label>
            <label class="chk full"><input type="checkbox" data-tk="guaranteed"> Guaranteed stop</label>
            <label class="chk"><input type="checkbox" data-tk="trailing"> Trailing stop</label>
            <label class="igt-trail">Trail step<input data-tk="trailInc" type="number" step="any" min="0"></label>
            <label class="chk full" title="Open a new position instead of reducing an opposite one"><input type="checkbox" data-tk="forceOpen"> Force open</label>
          </div>
          <div class="igt-info muted"></div>
          <div class="igt-msg"></div>
        </div>
        <div class="igt-main">
          <div class="igt-tabs">
            <button class="tab" data-tab="positions">Positions</button><button class="tab" data-tab="orders">Working orders</button>
            <button class="tab" data-tab="activity">Activity</button><button class="tab" data-tab="log">Order log</button>
            <span class="sp"></span><span class="igt-tot"></span>
          </div>
          <div class="igt-tabbody"></div>
        </div>
      </div>`;
    el.textContent = '';
    el.appendChild(root);
    const $q = (s) => root.querySelector(s);
    let lastBody = '';

    function setMsg(t, kind) { const m = $q('.igt-msg'); m.textContent = t || ''; m.className = `igt-msg ${kind || ''}`; }
    function setBusy(b) { root.classList.toggle('busy', !!b); }

    // ticket
    function readTicket() {
      for (const inp of root.querySelectorAll('[data-tk]')) { const k = inp.dataset.tk; prefs[k] = inp.type === 'checkbox' ? inp.checked : inp.value; }
      if (!prefs.follow && !prefs.epic) prefs.epic = ticketEpic();
      savePrefs();
    }
    function writeTicket() {
      for (const inp of root.querySelectorAll('[data-tk]')) { const k = inp.dataset.tk; if (inp.type === 'checkbox') inp.checked = !!prefs[k]; else if (document.activeElement !== inp) inp.value = prefs[k] ?? ''; }
      const mkt = prefs.orderType === 'MARKET';
      $q('.igt-lvl').classList.toggle('hidden', mkt);
      $q('[data-tk="stop"]').disabled = prefs.stopMode === 'none';
      $q('[data-tk="limit"]').disabled = prefs.limitMode === 'none';
      $q('.igt-trail').classList.toggle('hidden', !prefs.trailing);
    }
    async function renderTicket() {
      const epic = ticketEpic();
      $q('.igt-name').textContent = epic ? `${C.nameOf(epic)}${C.nameOf(epic) !== epic ? ` · ${epic}` : ''}` : 'Open a chart to trade';
      writeTicket();
      tick(epic);
      const r = epic ? await rulesFor(epic) : null;
      if (epic !== ticketEpic()) return;
      const c = epic && S.rules.get(epic);
      const g = $q('[data-tk="guaranteed"]'), t = $q('[data-tk="trailing"]');
      g.disabled = !!r && !r.guaranteedAllowed; t.disabled = !!r && !r.trailingAllowed;
      if (r && !prefs.size && r.minSize) { prefs.size = String(r.minSize); writeTicket(); }
      infoLine(r, c && c.err);
    }
    function infoLine(r, err) {
      const box = $q('.igt-info');
      if (!r) { box.textContent = err ? `Not tradeable via IG: ${err}` : ''; return; }
      const size = num(prefs.size), q = quoteOf(r.epic, r);
      const px = prefs.orderType === 'MARKET' ? (q ? (q.bid + q.offer) / 2 : null) : num(prefs.level);
      const margin = size && px && r.marginFactor != null ? (r.marginFactorUnit === 'PERCENTAGE' ? (size * (r.pointValue || 1) * px * r.marginFactor) / 100 : size * (r.pointValue || 1) * r.marginFactor) : null;
      const parts = [`Status ${r.status || '?'}`, r.minSize != null ? `min size ${r.minSize}` : null, r.minStop ? `min stop ${r.minStop.value}${r.minStop.unit === 'PERCENTAGE' ? '%' : ''}` : null,
        margin != null ? `est. margin ${fmtNum(margin, 2)} ${r.currency || ''}` : null, r.guaranteedAllowed ? null : 'no guaranteed stops', r.trailingAllowed ? null : 'no trailing stops'];
      box.textContent = parts.filter(Boolean).join(' · ');
      box.classList.toggle('bad', r.status !== 'TRADEABLE');
    }
    function tick(epic) {
      if (epic !== ticketEpic()) { if (S.tab === 'positions') liveCells(epic); return; }
      const c = S.rules.get(epic), q = quoteOf(epic, c && c.rules);
      $q('.igt-bid').textContent = q ? fp(q.bid, epic) : '—';
      $q('.igt-ask').textContent = q ? fp(q.offer, epic) : '—';
      $q('.igt-spr').textContent = q ? fmtNum(q.offer - q.bid, Math.min(decOf(epic), 2)) : '';
      if (S.tab === 'positions') liveCells(epic);
    }
    function buildOpen(side) {
      readTicket();
      const p = { epic: ticketEpic(), direction: side, orderType: prefs.orderType, size: num(prefs.size) };
      if (prefs.orderType !== 'MARKET') p.level = num(prefs.level);
      if (prefs.stopMode !== 'none') p[prefs.trailing || prefs.stopMode === 'distance' ? 'stopDistance' : 'stopLevel'] = num(prefs.stop);
      if (prefs.limitMode !== 'none') p[prefs.limitMode === 'distance' ? 'limitDistance' : 'limitLevel'] = num(prefs.limit);
      if (prefs.guaranteed) p.guaranteedStop = true;
      if (prefs.trailing) { p.trailingStop = true; p.trailingStopIncrement = num(prefs.trailInc); }
      if (!prefs.forceOpen) p.forceOpen = false;
      return p;
    }

    // tables
    function liveCells(epic) {
      let tot = 0, any = false;
      for (const p of S.positions) {
        const pnl = pnlOf(p);
        if (pnl != null) { tot += pnl; any = true; }
        if (epic && p.epic !== epic) continue;
        const tr = root.querySelector(`tr[data-deal="${CSS.escape(p.dealId)}"]`); if (!tr) continue;
        const q = quoteOf(p.epic, p);
        tr.querySelector('[data-k="cur"]').textContent = q ? fp(p.direction === 'BUY' ? q.bid : q.offer, p.epic) : '—';
        const c = tr.querySelector('[data-k="pnl"]'); c.textContent = pnl == null ? '—' : money(pnl); c.className = 'igt-pnl ' + (pnl > 0 ? 'gain' : pnl < 0 ? 'loss' : '');
      }
      const t = $q('.igt-tot');
      if (S.tab === 'positions' && any) { t.textContent = `Open P&L (est.) ${money(tot, (acct() || {}).currency)}`; t.className = 'igt-tot ' + (tot > 0 ? 'gain' : tot < 0 ? 'loss' : ''); } else t.textContent = '';
    }
    const dirTag = (d) => `<span class="igt-dir ${d === 'BUY' ? 'buy' : 'sell'}">${esc(d)}</span>`;
    function bodyHtml() {
      const dis = enabled() ? '' : 'disabled';
      if (S.tab === 'positions') {
        if (!S.positions.length) return `<div class="igt-empty">${S.err ? `Could not load positions: ${esc(S.err)}` : 'No open IG positions.'}</div>`;
        return `<table class="igt-tbl"><thead><tr><th>Market</th><th>Dir</th><th>Size</th><th>Open</th><th>Current</th><th>Stop</th><th>Limit</th><th>P&L (est.)</th><th>Opened</th><th class="act"></th></tr></thead><tbody>${S.positions.map((p) => {
          const ed = S.edit === `p:${p.dealId}`;
          const stop = ed ? `<input data-e="stopLevel" type="number" step="any" value="${p.stopLevel ?? ''}" placeholder="none">` : `${fp(p.stopLevel, p.epic)}${p.guaranteedStop ? ' G' : ''}${p.trailingStopDistance != null ? ' T' : ''}`;
          const lim = ed ? `<input data-e="limitLevel" type="number" step="any" value="${p.limitLevel ?? ''}" placeholder="none">` : fp(p.limitLevel, p.epic);
          const acts = ed ? `<button data-a="amend-save" ${dis}>Save</button><button data-a="edit-cancel">✕</button>`
            : `<button data-a="edit" ${dis} title="Amend stop / limit">Edit</button><input class="igt-csize" type="number" step="any" min="0" value="${p.size}" title="Size to close"><button data-a="close" class="igt-close" ${dis}>Close</button>`;
          return `<tr data-deal="${esc(p.dealId)}" data-kind="p"><td title="${esc(p.epic)} · ${esc(p.dealId)}">${esc(p.name || p.epic)}</td><td>${dirTag(p.direction)}</td><td>${esc(p.size)}</td><td>${fp(p.level, p.epic)}</td><td data-k="cur">—</td><td>${stop}</td><td>${lim}</td><td data-k="pnl" class="igt-pnl">—</td><td class="muted">${p.createdUTC ? esc(fmtTime(Math.floor(Date.parse(/Z|[+-]\d\d:?\d\d$/.test(p.createdUTC) ? p.createdUTC : p.createdUTC + 'Z') / 1000))) : ''}</td><td class="act"><div>${acts}</div></td></tr>`;
        }).join('')}</tbody></table>`;
      }
      if (S.tab === 'orders') {
        if (!S.orders.length) return `<div class="igt-empty">${S.err ? `Could not load orders: ${esc(S.err)}` : 'No IG working orders.'}</div>`;
        return `<table class="igt-tbl"><thead><tr><th>Market</th><th>Type</th><th>Dir</th><th>Size</th><th>Level</th><th>From market</th><th>Stop dist.</th><th>Limit dist.</th><th>Expiry</th><th class="act"></th></tr></thead><tbody>${S.orders.map((w) => {
          const ed = S.edit === `w:${w.dealId}`, q = quoteOf(w.epic, w);
          const away = q ? (w.direction === 'BUY' ? w.level - q.offer : w.level - q.bid) : null;
          const cell = (k, v) => (ed ? `<input data-e="${k}" type="number" step="any" value="${v ?? ''}" placeholder="none">` : fp(v, w.epic));
          const acts = ed ? `<button data-a="order-save" ${dis}>Save</button><button data-a="edit-cancel">✕</button>` : `<button data-a="edit" ${dis}>Edit</button><button data-a="order-cancel" class="igt-close" ${dis}>Cancel order</button>`;
          return `<tr data-deal="${esc(w.dealId)}" data-kind="w"><td title="${esc(w.epic)} · ${esc(w.dealId)}">${esc(w.name || w.epic)}</td><td>${esc(w.type)}</td><td>${dirTag(w.direction)}</td><td>${esc(w.size)}</td><td>${cell('level', w.level)}</td><td>${away == null ? '—' : fp(away, w.epic)}</td><td>${cell('stopDistance', w.stopDistance)}${w.guaranteedStop ? ' G' : ''}</td><td>${cell('limitDistance', w.limitDistance)}</td><td class="muted">${w.timeInForce === 'GOOD_TILL_DATE' ? esc(w.goodTill || 'GTD') : 'GTC'}</td><td class="act"><div>${acts}</div></td></tr>`;
        }).join('')}</tbody></table>`;
      }
      if (S.tab === 'activity') {
        if (!S.activity.length) return '<div class="igt-empty">No recent activity.</div>';
        return `<table class="igt-tbl"><thead><tr><th>Date</th><th>Market</th><th>Type</th><th>Status</th><th>Dir</th><th>Size</th><th>Level</th><th>Description</th></tr></thead><tbody>${S.activity.map((a) => `<tr><td>${esc(a.date || '')}</td><td>${esc(a.epic || '')}</td><td>${esc(a.type || '')}</td><td>${esc(a.status || '')}</td><td>${a.direction ? dirTag(a.direction) : ''}</td><td>${esc(a.size ?? '')}</td><td>${a.level != null ? fp(a.level, a.epic) : ''}</td><td class="igt-desc">${esc(a.description || '')}</td></tr>`).join('')}</tbody></table>`;
      }
      if (!S.log.length) return '<div class="igt-empty">No orders sent from this app yet.</div>';
      return `<table class="igt-tbl"><thead><tr><th>Time</th><th>Env</th><th>Account</th><th>Action</th><th>Order</th><th>Result</th></tr></thead><tbody>${S.log.map((l) => {
        const o = l.order || l.params || {}, r = l.result || {};
        const res = l.rejected ? `blocked: ${l.rejected}` : l.error ? `error: ${l.error}` : `${r.dealStatus || ''} ${r.reason || ''} ${r.dealId || ''}`;
        return `<tr><td>${esc(l.t || '')}</td><td>${esc(l.environment || '')}</td><td>${esc(l.accountId || '')}</td><td>${esc(l.action || '')}</td><td class="igt-desc">${esc([o.direction, o.size, o.epic || o.dealId, o.orderType, o.level != null ? '@' + o.level : '', o.stopLevel != null ? 'SL ' + o.stopLevel : '', o.limitLevel != null ? 'TP ' + o.limitLevel : ''].filter((x) => x != null && x !== '').join(' '))}</td><td class="${r.dealStatus === 'ACCEPTED' ? 'gain' : 'loss'}">${esc(res.trim())}</td></tr>`;
      }).join('')}</tbody></table>`;
    }
    function render() {
      const g = $q('.igt-gate');
      const st = S.status;
      $q('.igt-envslot').innerHTML = envBadge(S.env);
      root.classList.toggle('live', isLive());
      g.classList.toggle('hidden', !st || st.enabled);
      if (st && !st.enabled) g.textContent = `Trading disabled — ${st.reason || ''} Positions are shown read-only.`;
      const sel = $q('.igt-acct');
      const opts = S.accounts.map((a) => `<option value="${esc(a.accountId)}" ${a.accountId === S.accountId ? 'selected' : ''}>${esc(a.name || a.accountId)} · ${esc(a.accountId)}${a.type ? ' · ' + esc(a.type) : ''}</option>`).join('');
      if (sel.dataset.sig !== opts) { sel.innerHTML = opts || '<option>—</option>'; sel.dataset.sig = opts; }
      sel.disabled = !enabled() || S.accounts.length < 2;
      const a = acct();
      $q('.igt-bal').innerHTML = a ? `<span><i>Balance</i> ${money(a.balance, a.currency)}</span><span><i>Available</i> ${money(a.available, a.currency)}</span><span><i>P&L</i> <b class="${a.profitLoss > 0 ? 'gain' : a.profitLoss < 0 ? 'loss' : ''}">${money(a.profitLoss, a.currency)}</b></span>` : '';
      $q('.igt-push').textContent = st ? (st.push === 'lightstreamer' ? 'live updates' : st.push === 'mock' ? 'simulated broker' : 'polling') : '';
      $q('[data-pref="lines"]').checked = !!prefs.lines; $q('[data-pref="drag"]').checked = !!prefs.drag;
      const oc = $q('[data-pref="oneclick"]'); oc.checked = oneClickOn();
      $q('.igt-oclab').classList.toggle('on', oneClickOn());
      $q('.igt-oclab').lastChild.textContent = isLive() ? ' One-click (LIVE)' : ' One-click';
      for (const b of root.querySelectorAll('.igt-bs button')) b.disabled = !enabled();
      for (const b of root.querySelectorAll('.igt-tabs .tab')) {
        b.classList.toggle('on', b.dataset.tab === S.tab);
        const n = b.dataset.tab === 'positions' ? S.positions.length : b.dataset.tab === 'orders' ? S.orders.length : null;
        b.textContent = { positions: 'Positions', orders: 'Working orders', activity: 'Activity', log: 'Order log' }[b.dataset.tab] + (n ? ` (${n})` : '');
      }
      const html = bodyHtml();
      const tb = $q('.igt-tabbody');
      const editing = tb.contains(document.activeElement) && document.activeElement.tagName === 'INPUT';
      if (html !== lastBody && !editing) { tb.innerHTML = html; lastBody = html; }
      liveCells();
      renderTicket();
    }

    // events
    root.addEventListener('change', async (e) => {
      const t = e.target;
      if (t.dataset.tk) { readTicket(); if (t.dataset.tk === 'follow') { if (!prefs.follow) prefs.epic = (activeView() && activeView().symbol) || prefs.epic; savePrefs(); syncSubs(); } renderTicket(); return; }
      if (t.dataset.pref === 'lines' || t.dataset.pref === 'drag') { prefs[t.dataset.pref] = t.checked; savePrefs(); renderLines(true); return; }
      if (t.dataset.pref === 'oneclick') {
        const key = isLive() ? 'oneClickLive' : 'oneClick';
        if (t.checked) {
          const ok = await simpleConfirm(isLive() ? 'Enable one-click trading on LIVE?' : 'Enable one-click trading?',
            `${isLive() ? '<p class="igt-livebar">This is a LIVE real-money account.</p>' : ''}<p>Orders, closes and amends (including chart-line drags) will be sent to IG <b>without</b> a confirmation dialog. The server still validates every order.</p>`,
            isLive() ? 'Enable on LIVE' : 'Enable', isLive());
          if (!ok) { t.checked = false; return; }
        }
        prefs[key] = t.checked; savePrefs(); render(); return;
      }
      if (t.classList.contains('igt-acct')) {
        const id = t.value, target = S.accounts.find((a) => a.accountId === id);
        const ok = await simpleConfirm('Switch IG account?', `<p>Switch the server's IG session to <b>${esc(target ? target.name : id)}</b> (${esc(id)})? This applies to the whole app session.</p>`, 'Switch account');
        if (!ok) { t.value = S.accountId; return; }
        try { await api('/api/trade/account', { method: 'POST', body: { accountId: id } }); toast(`IG account → ${id}`); S.rules.clear(); } catch (err) { toast(`Account switch failed: ${err.message}`, 'alert'); }
        load(true);
      }
    });
    root.addEventListener('input', (e) => { if (e.target.dataset.tk) { readTicket(); const c = S.rules.get(ticketEpic()); infoLine(c && c.rules, c && c.err); } });
    root.addEventListener('click', async (e) => {
      const b = e.target.closest('button'); if (!b || b.disabled) return;
      if (b.dataset.act === 'refresh') { await loadStatus(); return load(true); }
      if (b.dataset.side) { const p = buildOpen(b.dataset.side); if (!p.epic) return setMsg('Open a chart first.'); return run('open', p); }
      if (b.dataset.tab) { S.tab = b.dataset.tab; S.edit = null; render(); if (S.tab === 'activity') { try { S.activity = (await api('/api/trade/activity?days=3')).activities || []; } catch (err) { setMsg(err.message); } render(); } if (S.tab === 'log') { try { S.log = (await api('/api/trade/log?limit=200')).entries || []; } catch (err) { setMsg(err.message); } render(); } return; }
      const tr = b.closest('tr[data-deal]'); if (!tr) return;
      const dealId = tr.dataset.deal, kind = tr.dataset.kind;
      const val = (k) => { const i = tr.querySelector(`[data-e="${k}"]`); return i ? (i.value.trim() === '' ? null : num(i.value)) : undefined; };
      if (b.dataset.a === 'edit') { S.edit = `${kind}:${dealId}`; lastBody = ''; return render(); }
      if (b.dataset.a === 'edit-cancel') { S.edit = null; lastBody = ''; return render(); }
      if (b.dataset.a === 'close') { const sz = num(tr.querySelector('.igt-csize').value); return run('close', { dealId, size: sz }); }
      if (b.dataset.a === 'amend-save') { const r = await run('amend', { dealId, stopLevel: val('stopLevel'), limitLevel: val('limitLevel') }); if (r) { S.edit = null; lastBody = ''; } return; }
      if (b.dataset.a === 'order-save') { const r = await run('order-amend', { dealId, level: val('level'), stopDistance: val('stopDistance'), limitDistance: val('limitDistance') }); if (r) { S.edit = null; lastBody = ''; } return; }
      if (b.dataset.a === 'order-cancel') return run('order-cancel', { dealId });
    });

    const visible = () => !!root.isConnected && !root.closest('.hidden') && !root.closest('.collapsed');
    inst = { root, render, tick, msg: setMsg, setBusy, visible, onActive: () => { if (prefs.follow) { syncSubs(); renderTicket(); } }, api: { refresh: () => load(true), root } };
    start();
    render();
    return inst.api;
  }

  window.IGTrade = { mount, renderLines, state: S };

  // Self-mount: the pane is shown by panels.js; mount on first show and keep our root if panels.js overwrites it.
  const pane = ensureDom();
  if (pane) {
    const shown = () => !pane.classList.contains('hidden') && !(document.getElementById('bpanel') || {}).classList?.contains('collapsed');
    const check = () => { if (shown()) C.ready.then(() => { if (!inst) mount(pane); else if (!pane.contains(inst.root)) { pane.textContent = ''; pane.appendChild(inst.root); inst.render(); } }); };
    new MutationObserver(check).observe(pane, { attributes: true, attributeFilter: ['class'] });
    new MutationObserver(() => { if (inst && !pane.contains(inst.root)) { pane.textContent = ''; pane.appendChild(inst.root); } }).observe(pane, { childList: true });
    const bp = document.getElementById('bpanel'); if (bp) new MutationObserver(check).observe(bp, { attributes: true, attributeFilter: ['class'] });
  }
  // Show chart lines without opening the panel once the user has used IG Trading on this device.
  if (prefs.used && prefs.lines) C.ready.then(() => setTimeout(() => { if (!S.started) { start(); } }, 1500));
})();
