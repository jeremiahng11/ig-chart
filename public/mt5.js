/* IG Charts — MT5 account viewer (read-only). The IGChartsBridge EA in your MT5 terminal pushes account,
   positions, orders and deals to the server; this module shows them in a panel and on matching charts. */
(() => {
  const C = window.IGC;
  const { esc, store, api, bus, nameOf, fmtNum, fmtTime, toast, download, toCSV } = C;
  const S = { accounts: [], cfg: null, login: store.get('mt5Login', null), tab: 'positions', el: null, app: null, sigs: new WeakMap() };
  let prefs = { positions: true, orders: true, deals: true, ...store.get('mt5Prefs', {}) };
  let map = store.get('mt5Map', {});
  const savePrefs = () => store.set('mt5Prefs', prefs);
  const saveMap = () => store.set('mt5Map', map);
  const acct = () => S.accounts.find((a) => a.account.login === S.login) || S.accounts[0] || null;

  // MT5 symbol → IG epic: explicit mapping first, then a guess from names and epics the app knows
  const base = (sym) => String(sym || '').toUpperCase().replace(/[^A-Z0-9]/g, '').replace(/(PRO|ECN|RAW|MICRO|MINI|CASH|SPOT|M|I|C|X)$/, '');
  function known() {
    const epics = new Set(Object.keys(C.names));
    for (const l of store.get('watchlists', { lists: [] }).lists || []) for (const e of l.items || []) if (!String(e).startsWith('###')) epics.add(e);
    if (S.app) for (const v of S.app.views) if (v.symbol) epics.add(v.symbol);
    return [...epics];
  }
  function guess(sym) {
    const b = base(sym), list = known();
    const find = (re) => list.find((e) => re.test(e) || re.test(nameOf(e)));
    if (/XAU|GOLD/.test(b)) return find(/gold|xau/i);
    if (/XAG|SILVER/.test(b)) return find(/silver|xag/i);
    if (/BTC|BITCOIN/.test(b)) return find(/bitcoin|btc/i);
    if (/ETH/.test(b)) return find(/ether|eth/i);
    const fx = b.match(/^([A-Z]{3})([A-Z]{3})/);
    if (fx) return find(new RegExp(`${fx[1]}\\W?${fx[2]}`, 'i'));
    return find(new RegExp(b.replace(/\d+$/, ''), 'i'));
  }
  const epicFor = (sym) => (map[sym] !== undefined ? map[sym] || null : guess(sym) || null);

  async function load() {
    try { const r = await api('/api/mt5/state'); S.accounts = r.accounts || []; } catch { S.accounts = []; }
    if (!acct() && S.accounts[0]) S.login = S.accounts[0].account.login;
    syncCharts(); render();
  }
  async function loadCfg() { try { S.cfg = await api('/api/mt5/config'); } catch (e) { S.cfg = { error: e.message }; } render(); }

  // ── chart overlays (every chart whose market maps to an MT5 symbol) ──
  function overlayFor(epic, a) {
    const lines = [], markers = [];
    if (!a) return { lines, markers };
    const sym = (s) => epicFor(s) === epic;
    if (prefs.positions) for (const p of a.positions.filter((x) => sym(x.symbol))) {
      const buy = p.type === 'buy', pl = p.profit != null ? `${p.profit >= 0 ? '+' : ''}${fmtNum(p.profit, 2)}` : '';
      lines.push({ id: `mt5p:${p.ticket}`, price: p.priceOpen, color: buy ? '#2962ff' : '#ef5350', width: 2, style: 0, title: `MT5 ${buy ? 'BUY' : 'SELL'} ${p.volume} · ${pl}` });
      if (p.sl) lines.push({ id: `mt5sl:${p.ticket}`, price: p.sl, color: '#ef5350', style: 2, title: `MT5 SL #${p.ticket}` });
      if (p.tp) lines.push({ id: `mt5tp:${p.ticket}`, price: p.tp, color: '#26a69a', style: 2, title: `MT5 TP #${p.ticket}` });
    }
    if (prefs.orders) for (const o of a.orders.filter((x) => sym(x.symbol))) {
      lines.push({ id: `mt5o:${o.ticket}`, price: o.priceOpen, color: '#ff9800', style: 1, title: `MT5 ${o.type.replace(/_/g, ' ').toUpperCase()} ${o.volume}` });
    }
    if (prefs.deals) for (const d of (a.deals || []).filter((x) => sym(x.symbol)).slice(-300)) {
      const buy = d.type === 'buy';
      if (d.entry === 'in') markers.push({ time: d.time, position: buy ? 'belowBar' : 'aboveBar', shape: buy ? 'arrowUp' : 'arrowDown', color: buy ? '#2962ff' : '#ef5350', text: `${buy ? 'B' : 'S'} ${d.volume}` });
      else markers.push({ time: d.time, position: buy ? 'belowBar' : 'aboveBar', shape: 'circle', color: (d.profit || 0) >= 0 ? '#26a69a' : '#ef5350', text: `× ${d.profit >= 0 ? '+' : ''}${fmtNum(d.profit || 0, 2)}` });
    }
    return { lines, markers };
  }
  function syncCharts() {
    if (!S.app) return;
    const a = acct();
    for (const v of S.app.views) {
      const spec = v.symbol ? overlayFor(v.symbol, a) : { lines: [], markers: [] };
      const sig = JSON.stringify(spec);
      if (S.sigs.get(v) === sig && v.hostOverlays.has('mt5') === !!(spec.lines.length || spec.markers.length)) continue;
      S.sigs.set(v, sig);
      if (!spec.lines.length && !spec.markers.length) v.clearOverlay('mt5'); else v.setOverlay('mt5', spec);
    }
  }

  // ── panel ──
  const ago = (ms) => { if (!ms) return 'never'; const s = Math.round((Date.now() - ms) / 1000); return s < 5 ? 'just now' : s < 90 ? `${s}s ago` : s < 5400 ? `${Math.round(s / 60)} min ago` : fmtTime(Math.floor(ms / 1000)); };
  const money = (v) => (v == null ? '—' : `${v >= 0 ? '' : '−'}${fmtNum(Math.abs(v), 2)}`);
  const cls = (v) => (v > 0 ? 'up' : v < 0 ? 'down' : '');
  function setupHtml() {
    const cfg = S.cfg || {}, url = `${location.origin}${cfg.pushPath || '/api/mt5/push'}`;
    return `<div class="m5-setup">
      <h4>Connect your MT5 account (read-only)</h4>
      <ol>
        <li><a href="/mt5/IGChartsBridge.mq5" download>Download IGChartsBridge.mq5</a>. In MT5: <b>File → Open Data Folder → MQL5 → Experts</b>, put the file there, then right-click <b>Experts → Refresh</b> in the Navigator (or open it in MetaEditor and press Compile).</li>
        <li>In MT5: <b>Tools → Options → Expert Advisors</b>, tick <b>Allow WebRequest for listed URL</b> and add <code>${esc(location.origin)}</code>.</li>
        <li>Drag <b>IGChartsBridge</b> onto any chart and enable <b>Algo Trading</b>. In its Inputs set:
          <div class="m5-kv"><span>ServerUrl</span><code id="m5Url">${esc(url)}</code><button data-copy="m5Url">Copy</button></div>
          <div class="m5-kv"><span>BridgeToken</span><code id="m5Tok">${esc(cfg.token || '…')}</code><button data-copy="m5Tok">Copy</button>${cfg.fromEnv ? '' : '<button data-act="rotate" title="Make a new token (the EA must be updated)">New token</button>'}</div></li>
      </ol>
      <p class="muted">The EA only reads your account and sends it here; it cannot open, change or close trades, and your MT5 password never leaves the terminal. If MT5 refuses <code>127.0.0.1</code>, use this computer's network address or your https deployment URL instead.</p>
    </div>`;
  }
  function render() {
    const el = S.el; if (!el) return;
    const a = acct();
    const live = a && Date.now() - a.lastSeen < 15000;
    const head = `<div class="m5-head">
      <span class="m5-dot ${a ? (live ? 'ok' : 'stale') : ''}"></span>
      ${a ? `<select id="m5Acct">${S.accounts.map((x) => `<option value="${esc(x.account.login)}" ${x === a ? 'selected' : ''}>${esc(x.account.login)} · ${esc(x.account.server)}${x.account.tradeMode ? ` (${esc(x.account.tradeMode)})` : ''}</option>`).join('')}</select>
        <span class="muted">${esc(a.account.name || '')} · updated ${ago(a.lastSeen)}</span>` : '<b>MT5</b><span class="muted">no account connected yet</span>'}
      <span class="spacer"></span>
      <label><input type="checkbox" data-pref="positions" ${prefs.positions ? 'checked' : ''}> positions</label>
      <label><input type="checkbox" data-pref="orders" ${prefs.orders ? 'checked' : ''}> orders</label>
      <label><input type="checkbox" data-pref="deals" ${prefs.deals ? 'checked' : ''}> history on chart</label>
    </div>`;
    if (!a) { el.innerHTML = `<div class="m5">${head}${setupHtml()}</div>`; wire(); return; }
    const A = a.account;
    const sum = `<div class="m5-sum">${[['Balance', money(A.balance)], ['Equity', money(A.equity)], ['Profit', money(A.profit), cls(A.profit)], ['Margin', money(A.margin)], ['Free margin', money(A.freeMargin)], ['Margin level', A.marginLevel ? `${fmtNum(A.marginLevel, 0)}%` : '—'], ['Leverage', A.leverage ? `1:${A.leverage}` : '—']].map(([k, v, c]) => `<span><small>${k}</small><b class="${c || ''}">${v}</b></span>`).join('')}<span><small>Currency</small><b>${esc(A.currency)}</b></span></div>`;
    const symCell = (s) => { const e = epicFor(s); return `<td title="${e ? 'Shown on ' + esc(nameOf(e)) : 'Not mapped to an IG market — see Symbols'}">${esc(s)}${e ? '' : ' <span class="down">●</span>'}</td>`; };
    const tabs = `<div class="m5-tabs">${['positions', 'orders', 'history', 'symbols', 'setup'].map((t) => `<button data-tab="${t}" class="${S.tab === t ? 'on' : ''}">${t[0].toUpperCase() + t.slice(1)}${t === 'positions' ? ` (${a.positions.length})` : t === 'orders' ? ` (${a.orders.length})` : ''}</button>`).join('')}<span class="spacer"></span>${S.tab === 'history' ? '<button data-act="csv">Export CSV</button>' : ''}</div>`;
    let body = '';
    if (S.tab === 'positions') body = a.positions.length ? `<table><thead><tr><th>Ticket</th><th>Symbol</th><th>Type</th><th>Lots</th><th>Open</th><th>Current</th><th>SL</th><th>TP</th><th>Swap</th><th>Profit</th><th>Opened</th></tr></thead><tbody>${a.positions.map((p) => `<tr data-sym="${esc(p.symbol)}"><td>${esc(p.ticket)}</td>${symCell(p.symbol)}<td class="${p.type === 'buy' ? 'up' : 'down'}">${p.type}</td><td>${p.volume}</td><td>${p.priceOpen}</td><td>${p.priceCurrent ?? '—'}</td><td>${p.sl ?? '—'}</td><td>${p.tp ?? '—'}</td><td>${money(p.swap)}</td><td class="${cls(p.profit)}">${money(p.profit)}</td><td>${p.time ? esc(fmtTime(p.time)) : ''}</td></tr>`).join('')}</tbody></table>` : '<div class="muted pad">No open positions</div>';
    if (S.tab === 'orders') body = a.orders.length ? `<table><thead><tr><th>Ticket</th><th>Symbol</th><th>Type</th><th>Lots</th><th>Price</th><th>SL</th><th>TP</th><th>Placed</th></tr></thead><tbody>${a.orders.map((o) => `<tr data-sym="${esc(o.symbol)}"><td>${esc(o.ticket)}</td>${symCell(o.symbol)}<td>${esc(o.type.replace(/_/g, ' '))}</td><td>${o.volume}</td><td>${o.priceOpen}</td><td>${o.sl ?? '—'}</td><td>${o.tp ?? '—'}</td><td>${o.time ? esc(fmtTime(o.time)) : ''}</td></tr>`).join('')}</tbody></table>` : '<div class="muted pad">No pending orders</div>';
    if (S.tab === 'history') { const ds = (a.deals || []).slice(-300).reverse(); body = ds.length ? `<table><thead><tr><th>Time</th><th>Ticket</th><th>Symbol</th><th>Type</th><th>Entry</th><th>Lots</th><th>Price</th><th>Commission</th><th>Swap</th><th>Profit</th></tr></thead><tbody>${ds.map((d) => `<tr data-sym="${esc(d.symbol)}"><td>${esc(fmtTime(d.time))}</td><td>${esc(d.ticket)}</td>${symCell(d.symbol)}<td class="${d.type === 'buy' ? 'up' : 'down'}">${d.type}</td><td>${d.entry}</td><td>${d.volume}</td><td>${d.price}</td><td>${money(d.commission)}</td><td>${money(d.swap)}</td><td class="${cls(d.profit)}">${d.entry === 'in' ? '' : money(d.profit)}</td></tr>`).join('')}</tbody></table>` : '<div class="muted pad">No deals in the history window</div>'; }
    if (S.tab === 'symbols') {
      const syms = [...new Set([...a.positions, ...a.orders, ...(a.deals || [])].map((x) => x.symbol))].sort();
      const opts = known();
      body = `<div class="pad muted">Match each MT5 symbol to the IG market to draw it on. Prices come from your broker, so lines may sit slightly off IG's prices.</div><table><thead><tr><th>MT5 symbol</th><th>IG market</th></tr></thead><tbody>${syms.map((s) => { const cur = epicFor(s); return `<tr><td>${esc(s)}</td><td><select data-map="${esc(s)}"><option value="">— not shown —</option>${opts.map((e) => `<option value="${esc(e)}" ${e === cur ? 'selected' : ''}>${esc(nameOf(e))} (${esc(e)})</option>`).join('')}</select>${map[s] === undefined && cur ? ' <small class="muted">auto</small>' : ''}</td></tr>`; }).join('') || '<tr><td colspan="2" class="muted">No symbols yet</td></tr>'}</tbody></table>`;
    }
    if (S.tab === 'setup') body = setupHtml() + `<div class="pad"><button data-act="remove">Remove account ${esc(A.login)} from IG Charts</button></div>`;
    el.innerHTML = `<div class="m5">${head}${sum}${tabs}<div class="m5-body">${body}</div></div>`;
    wire();
  }
  function wire() {
    const el = S.el;
    el.querySelectorAll('[data-pref]').forEach((c) => c.onchange = () => { prefs[c.dataset.pref] = c.checked; savePrefs(); syncCharts(); });
    const sel = el.querySelector('#m5Acct'); if (sel) sel.onchange = () => { S.login = sel.value; store.set('mt5Login', S.login); syncCharts(); render(); };
    el.querySelectorAll('[data-tab]').forEach((b) => b.onclick = () => { S.tab = b.dataset.tab; if (S.tab === 'setup') loadCfg(); render(); });
    el.querySelectorAll('[data-map]').forEach((s) => s.onchange = () => { map[s.dataset.map] = s.value; saveMap(); syncCharts(); render(); });
    el.querySelectorAll('[data-copy]').forEach((b) => b.onclick = async () => { try { await navigator.clipboard.writeText(document.getElementById(b.dataset.copy).textContent); toast('Copied'); } catch { toast('Select and copy the text manually'); } });
    el.querySelectorAll('tr[data-sym]').forEach((tr) => tr.ondblclick = () => { const e = epicFor(tr.dataset.sym); if (e && S.app.active) S.app.active.setSymbol(e); });
    el.querySelectorAll('[data-act]').forEach((b) => b.onclick = async () => {
      const act = b.dataset.act, a = acct();
      if (act === 'rotate' && confirm('Make a new bridge token? You will need to paste it into the EA inputs again.')) { try { await api('/api/mt5/token/rotate', { method: 'POST' }); await loadCfg(); toast('New token created'); } catch (e) { toast(e.message); } }
      if (act === 'remove' && a && confirm(`Remove MT5 account ${a.account.login} from IG Charts? (Stop or remove the EA in MT5 too, or it will reappear.)`)) { await api(`/api/mt5/accounts/${encodeURIComponent(a.account.login)}`, { method: 'DELETE' }).catch(() => {}); load(); }
      if (act === 'csv' && a) download(`mt5-${a.account.login}-deals.csv`, toCSV([['time', 'ticket', 'symbol', 'type', 'entry', 'volume', 'price', 'commission', 'swap', 'profit'], ...(a.deals || []).map((d) => [new Date(d.time * 1000).toISOString(), d.ticket, d.symbol, d.type, d.entry, d.volume, d.price, d.commission, d.swap, d.profit])]));
    });
  }

  let liveT = 0;
  function onPush(m) {
    if (m.removed) return load();
    const a = S.accounts.find((x) => x.account.login === m.login);
    if (!a || m.changed) return load();
    Object.assign(a, { account: m.account, positions: m.positions, orders: m.orders, lastSeen: m.lastSeen });
    syncCharts();
    const n = Date.now(); if (S.el && n - liveT > 1000) { liveT = n; render(); }
  }

  window.IGMT5 = {
    init(app) {
      S.app = app;
      load(); loadCfg();
      bus.on('mt5', onPush);
      bus.on('active-changed', syncCharts);
      bus.on('state-remote', (k) => { if (k === 'mt5Map') { map = store.get('mt5Map', {}); syncCharts(); render(); } });
      setInterval(() => { syncCharts(); if (S.el) render(); }, 5000);
    },
    mount(el) { S.el = el; if (!S.cfg) loadCfg(); render(); return { refresh: render, destroy() { S.el = null; } }; },
  };
})();
