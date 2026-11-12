/* IG Charts — side and bottom panels: watchlists, alerts, object tree & data window, screener, module host. */
window.IGC.ready.then(() => {
  const C = window.IGC;
  const { $, esc, uid, store, settings, T, api, bus, nameOf, quotes, mid, toast, download, toCSV, fmtTime, fmtNum, beep, notify } = C;
  const IND = window.IGInd, IV = C.iv;
  let app;
  const active = () => app.active;

  // ------------------------------------------------------------ Panels layout
  let sbOpen = store.get('sbOpen', 'watchlist'), bpOpen = store.get('bpOpen', null), bpH = store.get('bpH', 300);
  function showSidebar(k) {
    sbOpen = sbOpen === k ? null : k; store.set('sbOpen', sbOpen);
    applyPanels();
  }
  function showBottom(k) {
    bpOpen = bpOpen === k ? null : k; store.set('bpOpen', bpOpen);
    applyPanels();
    if (bpOpen) mountModule(bpOpen);
  }
  function applyPanels() {
    $('layout').classList.toggle('sb-closed', !sbOpen);
    document.querySelectorAll('.sb-pane').forEach((p) => p.classList.toggle('hidden', p.dataset.sb !== sbOpen));
    document.querySelectorAll('#sidebtns [data-sb]').forEach((b) => b.classList.toggle('active', b.dataset.sb === sbOpen));
    document.querySelectorAll('[data-bp]').forEach((b) => b.classList.toggle('active', b.dataset.bp === bpOpen));
    const bp = $('bpanel');
    bp.classList.toggle('collapsed', !bpOpen);
    bp.style.height = bpOpen ? bpH + 'px' : '';
    document.querySelectorAll('.bp-pane').forEach((p) => p.classList.toggle('hidden', p.dataset.pane !== bpOpen));
    $('bpToggle').textContent = bpOpen ? '▾' : '▴';
    if (sbOpen === 'tree') refreshTree();
    if (sbOpen === 'news') { renderNews(); loadCalendar(); }
  }
  function wirePanels() {
    $('sidebtns').addEventListener('click', (e) => { const b = e.target.closest('button'); if (!b) return; if (b.dataset.sb) showSidebar(b.dataset.sb); if (b.dataset.bp) showBottom(b.dataset.bp); });
    document.querySelector('.bp-tabs').addEventListener('click', (e) => { const b = e.target.closest('[data-bp]'); if (b) { if (bpOpen !== b.dataset.bp) showBottom(b.dataset.bp); } });
    $('bpToggle').onclick = () => { if (bpOpen) showBottom(bpOpen); else showBottom(store.get('bpLast', 'strategy')); };
    $('bpResize').addEventListener('mousedown', (e) => {
      e.preventDefault();
      const y0 = e.clientY, h0 = $('bpanel').offsetHeight;
      const mv = (ev) => { bpH = Math.max(140, Math.min(window.innerHeight - 200, h0 + (y0 - ev.clientY))); $('bpanel').style.height = bpH + 'px'; };
      const up = () => { window.removeEventListener('mousemove', mv); window.removeEventListener('mouseup', up); store.set('bpH', bpH); };
      window.addEventListener('mousemove', mv); window.addEventListener('mouseup', up);
    });
  }

  // ------------------------------------------------------------ Module host (strategy tester, paper trading)
  const overlays = new Map();
  const host = {
    active: () => { const v = active(); return v ? { epic: v.symbol, name: v.title(), tf: v.interval, tfSec: v.tfSec, candles: v.basis, decimals: v.decimals } : { epic: null, name: '', tf: '', tfSec: 60, candles: [], decimals: 2 }; },
    onChange: (cb) => { let t; return bus.on('active-changed', () => { clearTimeout(t); t = setTimeout(cb, 60); }); },
    onTick: (cb) => bus.on('tick', cb),
    setOverlay(owner, spec, handlers) { overlays.set(owner, { spec, handlers }); active() && active().setOverlay(owner, spec, handlers); },
    clearOverlay(owner) { overlays.delete(owner); app.views.forEach((v) => v.clearOverlay(owner)); },
    fmt: (p) => (active() ? active().fmt(p) : fmtNum(p)), fmtTime: (t) => fmtTime(t),
    notify: (t) => toast(t),
    store: { get: (k, d) => store.get('mod.' + k, d), set: (k, v) => store.set('mod.' + k, v) },
    LW: window.LightweightCharts, theme: () => ({ ...T(), accent: '#2962ff' }), ind: IND,
    addStudy: (id) => active() && active().addStudy(id),
    aiChance: (c) => (active() ? active().aiSignals(c) : []),
    quote: (e) => quotes[e], watchlist: () => listItems(curList()).filter((x) => !isSection(x)), name: nameOf,
    async fetchBars(epic, interval, max = 1000) {
      const sp = IV.parse(interval); if (!sp || sp.kind !== 'time') throw new Error('time intervals only');
      const res = IV.baseRes(sp), ratio = Math.max(1, Math.round(sp.sec / C.RES_SEC[res]));
      const r = await api(`/api/history?epic=${encodeURIComponent(epic)}&resolution=${res}&max=${Math.min(5000, Math.ceil(max * ratio))}`);
      app.shell.onAllowance(r.allowance);
      return (ratio > 1 && window.IGTypes ? window.IGTypes.aggregate(r.candles, sp) : r.candles).slice(-max);
    },
    notifyAlert: (title, message) => api('/api/notify', { method: 'POST', body: { title, message, epic: active() && active().symbol } }),
  };
  function moveOverlays(prev, next) { for (const [owner, o] of overlays) { prev.clearOverlay(owner); next.setOverlay(owner, o.spec, o.handlers); } }
  const mounted = {};
  function mountModule(k) {
    store.set('bpLast', k);
    if (mounted[k]) return mounted[k].refresh && mounted[k].refresh();
    const el = document.querySelector(`.bp-pane[data-pane="${k}"]`);
    try {
      if (k === 'strategy' && window.IGStrategy) mounted[k] = window.IGStrategy.mount(el, host);
      else if (k === 'paper' && window.IGPaper) mounted[k] = window.IGPaper.mount(el, host);
      else if (k === 'screener') mounted[k] = mountScreener(el);
      else if (k === 'mt5' && window.IGMT5) mounted[k] = window.IGMT5.mount(el);
      else if (k === 'trade' && window.IGTrade) mounted[k] = window.IGTrade.mount(el, host);
      else el.innerHTML = '<div class="muted pad">Module not available.</div>';
    } catch (e) { console.error(e); el.innerHTML = `<div class="muted pad">Failed to load: ${esc(e.message)}</div>`; }
  }

  // ------------------------------------------------------------ Watchlists
  const FLAGS = ['#ef5350', '#2962ff', '#26a69a', '#ff9800', '#c77dff', '#00bcd4', '#f06292'];
  const COLS = { last: ['Last', 72], chg: ['Chg', 64], chgp: ['Chg%', 60], bid: ['Bid', 72], ask: ['Ask', 72], spread: ['Spr', 50], high: ['High', 72], low: ['Low', 72], state: ['Status', 70] };
  let WL = store.get('watchlists', null);
  if (!WL) { const id = uid(); WL = { lists: [{ id, name: 'Watchlist', items: store.get('watch', []) }], active: id, columns: ['last', 'chgp'], flags: {}, sort: null }; }
  const saveWL = () => store.set('watchlists', WL);
  const isSection = (x) => typeof x === 'string' && x.startsWith('###');
  const curList = () => (String(WL.active).startsWith('flag:') ? { id: WL.active, name: `Flagged ${Number(WL.active.slice(5)) + 1}`, virtual: true, items: Object.keys(WL.flags).filter((e) => WL.flags[e] === Number(WL.active.slice(5))) } : WL.lists.find((l) => l.id === WL.active) || WL.lists[0]);
  const listItems = (l) => (l ? l.items : []);
  let wlSubs = [];
  const nameAsked = new Set();
  function syncWlSubs() {
    const next = [...new Set(WL.lists.flatMap((l) => l.items).filter((x) => !isSection(x)))];
    C.subscribe(next); C.unsubscribe(wlSubs); wlSubs = next;
    const missing = next.filter((e) => !C.names[e] && !nameAsked.has(e)).slice(0, 20);
    missing.forEach((e) => nameAsked.add(e));
    Promise.all(missing.map((e) => api(`/api/market/${encodeURIComponent(e)}`).then((m) => C.setName(e, m.name)).catch(() => {}))).then(() => missing.length && renderWatchlist());
  }
  const prevChg = {};
  function colVal(e, k) {
    const q = quotes[e] || {};
    const m = mid(q);
    switch (k) {
      case 'last': return [fmtNum(q.bid, 2), q.bid];
      case 'chg': { const c = q.changePct != null && m ? (m * q.changePct) / (100 + q.changePct) : null; return [c == null ? '' : `${c > 0 ? '+' : ''}${fmtNum(c, 2)}`, c, c > 0 ? 'up' : c < 0 ? 'down' : '']; }
      case 'chgp': return [q.changePct != null ? `${q.changePct > 0 ? '+' : ''}${q.changePct.toFixed(2)}%` : '', q.changePct, q.changePct > 0 ? 'up' : q.changePct < 0 ? 'down' : ''];
      case 'bid': return [fmtNum(q.bid, 2), q.bid];
      case 'ask': return [fmtNum(q.offer, 2), q.offer];
      case 'spread': return [q.bid != null && q.offer != null ? fmtNum(q.offer - q.bid, 2) : '', q.offer - q.bid];
      case 'high': return [fmtNum(q.high, 2), q.high];
      case 'low': return [fmtNum(q.low, 2), q.low];
      case 'state': return [q.state || '', q.state || ''];
      default: return ['', null];
    }
  }
  function renderWatchlist() {
    const pane = document.querySelector('.sb-pane[data-sb=watchlist]');
    const L = curList();
    const cols = WL.columns.filter((k) => COLS[k]);
    const gridCols = `14px minmax(70px,1fr) ${cols.map((k) => COLS[k][1] + 'px').join(' ')} 14px`;
    let items = listItems(L);
    if (WL.sort) {
      const { k, dir } = WL.sort;
      const val = (e) => (k === 'name' ? nameOf(e).toLowerCase() : colVal(e, k)[1] ?? -Infinity);
      items = items.filter((x) => !isSection(x)).sort((a, b) => { const x = val(a), y = val(b); return (x < y ? -1 : x > y ? 1 : 0) * dir; });
    }
    const cur = active() && active().symbol;
    pane.innerHTML = `<div class="wl-head"><div class="dd"><button class="wl-name" id="wlListBtn">${esc(L ? L.name : 'Watchlist')} ▾</button><div class="dd-menu hidden" id="wlListMenu"></div></div>
        <span class="spacer"></span><button class="icon-btn" id="wlAdd" title="Add symbol">＋</button><button class="icon-btn" id="wlAlert" title="Create a watchlist alert">🔔</button></div>
      <div class="wl-cols" style="grid-template-columns:${gridCols}"><span></span><button data-sort="name">Symbol${WL.sort && WL.sort.k === 'name' ? (WL.sort.dir > 0 ? ' ▲' : ' ▼') : ''}</button>${cols.map((k) => `<button data-sort="${k}">${COLS[k][0]}${WL.sort && WL.sort.k === k ? (WL.sort.dir > 0 ? ' ▲' : ' ▼') : ''}</button>`).join('')}<span></span></div>
      <ul class="wl-list" id="wlList">${items.map((e, i) => isSection(e)
        ? `<li class="wl-sec" draggable="${!WL.sort && !L.virtual}" data-i="${i}"><span>${esc(e.slice(3))}</span><button class="rm" data-rm="${i}">✕</button></li>`
        : `<li class="${e === cur ? 'active' : ''}" draggable="${!WL.sort && !L.virtual}" data-epic="${esc(e)}" data-i="${i}" style="grid-template-columns:${gridCols}">
            <i class="flag" data-flag="${esc(e)}" style="background:${WL.flags[e] != null ? FLAGS[WL.flags[e]] : 'transparent'}" title="Flag (click to cycle, right-click to clear)"></i>
            <span class="nm" title="${esc(e)}">${esc(nameOf(e))}</span>${cols.map((k) => { const [t, , cls] = colVal(e, k); return `<span class="c ${cls || ''}" data-col="${k}">${esc(t)}</span>`; }).join('')}
            ${L.virtual ? '<span></span>' : `<button class="rm" data-rm="${i}" title="Remove">✕</button>`}</li>`).join('') || '<li class="muted wl-empty">Empty — add symbols with ＋</li>'}</ul>
      <div class="wl-details" id="wlDetails"></div>`;
    renderDetails();
    const list = pane.querySelector('#wlList');
    list.onclick = (e) => {
      const fl = e.target.closest('[data-flag]');
      if (fl) { const k = fl.dataset.flag; const c = WL.flags[k]; WL.flags[k] = c == null ? 0 : c + 1; if (WL.flags[k] >= FLAGS.length) delete WL.flags[k]; saveWL(); return renderWatchlist(); }
      const rm = e.target.closest('[data-rm]');
      if (rm) { L.items.splice(Number(rm.dataset.rm), 1); saveWL(); syncWlSubs(); return renderWatchlist(); }
      const li = e.target.closest('li[data-epic]');
      if (li && active()) active().setSymbol(li.dataset.epic);
    };
    list.oncontextmenu = (e) => { const fl = e.target.closest('[data-flag]'); if (fl) { e.preventDefault(); delete WL.flags[fl.dataset.flag]; saveWL(); renderWatchlist(); } };
    let dragI = null;
    list.ondragstart = (e) => { const li = e.target.closest('li[data-i]'); if (li) { dragI = Number(li.dataset.i); e.dataTransfer.effectAllowed = 'move'; } };
    list.ondragover = (e) => { if (dragI != null) e.preventDefault(); };
    list.ondrop = (e) => {
      e.preventDefault();
      const li = e.target.closest('li[data-i]'); if (dragI == null || !li) return;
      const to = Number(li.dataset.i), [x] = L.items.splice(dragI, 1); L.items.splice(to, 0, x); dragI = null; saveWL(); renderWatchlist();
    };
    pane.querySelector('.wl-cols').onclick = (e) => {
      const b = e.target.closest('[data-sort]'); if (!b) return;
      const k = b.dataset.sort, s = WL.sort;
      WL.sort = !s || s.k !== k ? { k, dir: k === 'name' ? 1 : -1 } : s.dir === (k === 'name' ? 1 : -1) ? { k, dir: -s.dir } : null;
      saveWL(); renderWatchlist();
    };
    pane.querySelector('#wlAdd').onclick = () => app.openSearch('watchlist');
    pane.querySelector('#wlAlert').onclick = () => openAlertDialog({ watchlist: true });
    pane.querySelector('#wlListBtn').onclick = () => {
      const menu = pane.querySelector('#wlListMenu');
      menu.innerHTML = `<div class="dd-h">Lists</div>${WL.lists.map((l) => `<button data-list="${l.id}" class="${l.id === WL.active ? 'active' : ''}">${esc(l.name)} <small class="muted">${l.items.filter((x) => !isSection(x)).length}</small></button>`).join('')}
        <div class="dd-h">Flagged</div><div class="flag-row">${FLAGS.map((c, i) => `<button data-list="flag:${i}" title="Flagged list ${i + 1}" class="${WL.active === `flag:${i}` ? 'active' : ''}"><i class="flag" style="background:${c}"></i></button>`).join('')}</div>
        <div class="dd-sep"></div><button data-act="new">Create new list…</button><button data-act="rename">Rename list…</button><button data-act="section">Add section…</button><button data-act="delete">Delete list</button>
        <button data-act="import">Import list (.txt)…</button><button data-act="export">Export list (.txt)</button>
        <div class="dd-sep"></div><div class="dd-h">Columns</div>${Object.entries(COLS).map(([k, [l]]) => `<button data-col="${k}">${WL.columns.includes(k) ? '☑' : '☐'} ${l}</button>`).join('')}`;
      menu.classList.toggle('hidden');
      menu.onclick = (ev) => {
        const b = ev.target.closest('button'); if (!b) return;
        if (b.dataset.list) { WL.active = b.dataset.list; WL.sort = null; saveWL(); return renderWatchlist(); }
        if (b.dataset.col) { const k = b.dataset.col; WL.columns = WL.columns.includes(k) ? WL.columns.filter((x) => x !== k) : [...WL.columns, k]; saveWL(); return renderWatchlist(); }
        const act = b.dataset.act, Lx = curList();
        const ask = (title, val, cb) => { const m = app.modal('wlAsk', title, `<form class="ac-form">${app.formField({ k: 'v', label: 'Name', type: 'text' }, val)}</form>`, '<button data-close>Cancel</button><button class="primary" id="wlAskOk">OK</button>', 'small'); const go = (e2) => { e2 && e2.preventDefault(); const v = m.querySelector('[name=v]').value.trim(); if (v) cb(v); app.closeModals(); }; m.querySelector('#wlAskOk').onclick = go; m.querySelector('form').onsubmit = go; setTimeout(() => m.querySelector('[name=v]').select(), 0); };
        if (act === 'new') ask('New watchlist', '', (v) => { const id = uid(); WL.lists.push({ id, name: v, items: [] }); WL.active = id; saveWL(); renderWatchlist(); });
        if (act === 'rename' && !Lx.virtual) ask('Rename watchlist', Lx.name, (v) => { Lx.name = v; saveWL(); renderWatchlist(); });
        if (act === 'section' && !Lx.virtual) ask('Section name', '', (v) => { Lx.items.push('###' + v); saveWL(); renderWatchlist(); });
        if (act === 'delete' && !Lx.virtual && WL.lists.length > 1 && confirm(`Delete watchlist "${Lx.name}"?`)) { WL.lists = WL.lists.filter((l) => l !== Lx); WL.active = WL.lists[0].id; saveWL(); syncWlSubs(); renderWatchlist(); }
        if (act === 'export') download(`${Lx.name.replace(/[^\w.-]+/g, '_')}.txt`, Lx.items.join('\n'), 'text/plain');
        if (act === 'import') {
          const inp = document.createElement('input'); inp.type = 'file'; inp.accept = '.txt,.csv';
          inp.onchange = async () => { const items = (await inp.files[0].text()).split(/[\n,]+/).map((s) => s.trim()).filter(Boolean); const id = uid(); WL.lists.push({ id, name: inp.files[0].name.replace(/\.\w+$/, ''), items }); WL.active = id; saveWL(); syncWlSubs(); renderWatchlist(); };
          inp.click();
        }
      };
    };
  }
  function updateWatchRow(epic) {
    const li = document.querySelector(`#wlList li[data-epic="${CSS.escape(epic)}"]`);
    if (!li) return;
    li.querySelectorAll('[data-col]').forEach((c) => {
      const [t, , cls] = colVal(epic, c.dataset.col);
      if (c.textContent !== t) {
        if (c.dataset.col === 'last') { const v = quotes[epic].bid, p = prevChg[epic]; if (p != null && v !== p) { c.classList.remove('flash-up', 'flash-down'); void c.offsetWidth; c.classList.add(v > p ? 'flash-up' : 'flash-down'); } prevChg[epic] = v; }
        c.textContent = t;
      }
      if (cls != null) { c.classList.toggle('up', cls === 'up'); c.classList.toggle('down', cls === 'down'); }
    });
  }
  function renderDetails() {
    const box = $('wlDetails'); if (!box) return;
    const v = active(), e = v && v.symbol;
    if (!e || IV.isExpr(e)) { box.innerHTML = e ? `<div class="wd-name">${esc(e)}</div><div class="wd-epic muted">Formula chart</div>` : ''; return; }
    const q = quotes[e] || {}, last = v.basis[v.basis.length - 1];
    const row = (k, val, cls = '') => `<span class="k">${k}</span><span class="v ${cls}">${val}</span>`;
    const range = q.high != null && q.low != null && q.bid != null && q.high > q.low ? ((q.bid - q.low) / (q.high - q.low)) * 100 : null;
    box.innerHTML = `<div class="wd-name">${esc(nameOf(e))}</div><div class="wd-epic muted">${esc(e)}</div>
      <div class="wd-price ${q.changePct > 0 ? 'up' : q.changePct < 0 ? 'down' : ''}">${v.fmt(q.bid)} <small>${q.changePct != null ? (q.changePct > 0 ? '+' : '') + q.changePct.toFixed(2) + '%' : ''}</small></div>
      ${range != null ? `<div class="wd-range"><span class="muted">Day range</span><div class="bar"><i style="left:${range}%"></i></div><span>${v.fmt(q.low)}</span><span>${v.fmt(q.high)}</span></div>` : ''}
      <div class="wd-grid">${row('Bid', v.fmt(q.bid), 'down')}${row('Ask', v.fmt(q.offer), 'up')}${row('Spread', q.bid != null && q.offer != null ? v.fmt(q.offer - q.bid) : '—')}
      ${row('Day high', v.fmt(q.high))}${row('Day low', v.fmt(q.low))}${row('Status', esc(q.state || '—'))}${row('Bars', `${v.basis.length} × ${esc(IV.label(v.interval))}`)}${row('Last bar', last ? fmtTime(last.time) : '—')}</div>`;
  }
  function addToWatchlist(epic, quiet) {
    const L = curList();
    if (L.virtual) { if (!quiet) toast('Pick a normal list to add symbols'); return; }
    if (!L.items.includes(epic)) { L.items.push(epic); saveWL(); syncWlSubs(); renderWatchlist(); if (!quiet) toast(`Added ${nameOf(epic)}`); }
  }

  // ------------------------------------------------------------ Alerts (server price alerts + client technical / drawing alerts)
  let serverAlerts = [], streamInfo = null, alertLog = [], alertTab = 'list';
  let tech = store.get('techAlerts', []);
  const saveTech = () => store.set('techAlerts', tech);
  const COND = [['crossing', 'Crossing'], ['crossing_up', 'Crossing up'], ['crossing_down', 'Crossing down'], ['greater_than', 'Greater than'], ['less_than', 'Less than'], ['entering_channel', 'Entering channel'], ['exiting_channel', 'Exiting channel'], ['inside_channel', 'Inside channel'], ['outside_channel', 'Outside channel'], ['moving_up', 'Moving up (value)'], ['moving_down', 'Moving down (value)'], ['moving_up_pct', 'Moving up %'], ['moving_down_pct', 'Moving down %']];
  const condLabel = (c) => (COND.find((x) => x[0] === c) || [c, c])[1];
  async function loadAlerts() {
    try { const r = await api('/api/alerts'); serverAlerts = r.alerts || []; streamInfo = r.stream || null; } catch (e) { serverAlerts = []; }
    renderAlerts(); app && app.views.forEach((v) => v.renderAlertLines());
  }
  async function loadLog() { try { alertLog = (await api('/api/alerts/log?limit=200')).events || []; } catch { alertLog = []; } if (alertTab === 'log') renderAlerts(); }
  function alertLines(sym) {
    const out = [];
    for (const a of serverAlerts) {
      if (!a.enabled || a.expired || a.kind !== 'price' || a.epic !== sym || !Number.isFinite(a.value) || /^moving/.test(a.condition)) continue;
      out.push({ price: a.value, title: `🔔 ${a.name || condLabel(a.condition)}` });
      if (/channel/.test(a.condition) && Number.isFinite(a.value2)) out.push({ price: a.value2, title: '🔔' });
    }
    return out;
  }
  let pushState = 'off';
  const pushLabel = () => (pushState === 'on' ? '📲' : '📵');
  function describe(a) {
    if (a.kind === 'stmn') return `${nameOf(a.epic)} ${IV.label(a.interval)} · STMN ${a.sides === 'buy' ? '+ (buy)' : a.sides === 'sell' ? '− (sell)' : '+ / −'}${a.opts && a.opts.riskUsd ? ' · risk $' + a.opts.riskUsd : ''}`;
    if (a.kind === 'indicator') { const d = IND.BY_ID[a.indicator && a.indicator.id]; const c = a.compare || {}; return `${nameOf(a.epic)} ${IV.label(a.interval)} · ${d ? IND.title(d, a.indicator.params || {}) : a.indicator?.id} ${a.indicator?.output || ''} ${condLabel(a.condition)} ${c.type === 'value' ? c.value : c.type === 'price' ? 'price' : c.output || ''}${a.status && a.status !== 'ok' ? ' · ' + a.status : ''}`; }
    if (a.kind === 'drawing') return `${nameOf(a.epic)} · drawing (${a.geometry && a.geometry.kind}) · ${condLabel(a.condition)}${a.status && a.status !== 'ok' ? ' · ' + a.status : ''}`;
    if (a.kind === 'multi') return a.all.map((c) => `${nameOf(c.epic)} ${condLabel(c.condition)} ${c.value}${c.value2 != null && /channel/.test(c.condition) ? `–${c.value2}` : ''}`).join(' AND ');
    if (a.kind === 'watchlist') return `${a.epics.length} symbols · ${condLabel(a.condition)} ${a.value}${/moving/.test(a.condition) ? ` in ${a.value2}s` : ''}`;
    return `${nameOf(a.epic)} ${a.source || 'mid'} ${condLabel(a.condition)} ${a.value}${a.value2 != null ? (/moving/.test(a.condition) ? ` in ${a.value2}s` : `–${a.value2}`) : ''}`;
  }
  function renderAlerts() {
    const pane = document.querySelector('.sb-pane[data-sb=alerts]');
    const status = (a) => (a.expired ? 'expired' : a.enabled ? 'active' : 'stopped');
    const techStatus = (a) => (!a.enabled ? 'stopped' : findView(a) ? 'active' : 'waiting for chart');
    pane.innerHTML = `<div class="wl-head"><div class="seg"><button data-at="list" class="${alertTab === 'list' ? 'on' : ''}">Alerts</button><button data-at="log" class="${alertTab === 'log' ? 'on' : ''}">Log</button></div><span class="spacer"></span><button class="icon-btn" id="alPush" title="Push notifications to this device">${pushLabel()}</button><button class="icon-btn" id="alNew" title="Create alert">＋</button></div>
      ${alertTab === 'list' ? `<div class="al-list">
        ${streamInfo && streamInfo.unsubscribed && streamInfo.unsubscribed.length ? `<div class="al-warn">Over IG's ${streamInfo.max} streaming subscriptions — not watched: ${esc(streamInfo.unsubscribed.join(', '))}</div>` : ''}
        <div class="ind-h">Server alerts (${serverAlerts.length}/1000) — run while this page is closed</div>
        ${serverAlerts.map((a) => `<div class="al-item ${status(a)}" data-id="${a.id}"><div><b>${esc(a.name || describe(a))}</b><small>${esc(describe(a))}</small><small>${status(a)} · ${esc(a.trigger || 'once')}${a.webhook && a.webhook.url ? ' · webhook' : ''}${a.firedCount ? ` · fired ${a.firedCount}×` : ''}</small></div>
          <span class="al-btns"><button data-act="toggle" title="${a.enabled ? 'Stop' : 'Restart'}">${a.enabled ? '❚❚' : '▶'}</button><button data-act="test" title="Send a test">⚡</button>${a.kind === 'stmn' ? '' : '<button data-act="edit" title="Edit">✎</button>'}<button data-act="del" title="Delete">✕</button></span></div>`).join('') || '<div class="muted pad">No server alerts.</div>'}
        <div class="ind-h">Indicator &amp; drawing alerts (${tech.length}) — run while a chart with that symbol and interval is open</div>
        ${tech.map((a) => `<div class="al-item ${a.enabled ? '' : 'stopped'}" data-tid="${a.id}"><div><b>${esc(a.name)}</b><small>${esc(a.desc)}</small><small>${techStatus(a)}${a.firedCount ? ` · fired ${a.firedCount}×` : ''}</small></div>
          <span class="al-btns"><button data-act="toggle">${a.enabled ? '❚❚' : '▶'}</button><button data-act="del">✕</button></span></div>`).join('') || '<div class="muted pad">None.</div>'}
      </div>` : `<div class="al-list"><div class="al-loghead"><span class="muted">${alertLog.length} events</span><button id="alClearLog">Clear log</button></div>
        ${alertLog.map((e) => `<div class="al-log"><b>${esc(e.name || '')}</b><span class="muted">${esc(new Date(e.at).toLocaleString())}${e.epic ? ' · ' + esc(nameOf(e.epic)) : ''}${e.price != null ? ' @ ' + esc(fmtNum(e.price, 2)) : ''}</span><small>${esc(e.message || '')}</small>${e.webhook ? `<small class="${e.webhook.ok ? 'up' : 'down'}">webhook ${esc(e.webhook.status ?? e.webhook.error ?? (e.webhook.pending ? 'pending' : ''))} (${e.webhook.attempts || 0} attempt${e.webhook.attempts === 1 ? '' : 's'})</small>` : ''}</div>`).join('') || '<div class="muted pad">No alerts have fired yet.</div>'}</div>`}`;
    pane.querySelector('.seg').onclick = (e) => { const b = e.target.closest('[data-at]'); if (!b) return; alertTab = b.dataset.at; if (alertTab === 'log') loadLog(); renderAlerts(); };
    pane.querySelector('#alNew').onclick = () => openAlertDialog({});
    pane.querySelector('#alPush').onclick = async () => {
      const P = window.IGPush;
      if (!P || !P.supported()) return toast('Push notifications are not supported here (needs HTTPS or localhost, and a supporting browser)');
      try { const st = P.state(); if (st === 'on') { await P.disable(); toast('Push notifications off for this device'); } else { await P.enable(); await P.test().catch(() => {}); toast('Push notifications on — a test was sent'); } } catch (e) { toast(`Push: ${e.message}`); }
      pushState = window.IGPush ? window.IGPush.state() : 'unsupported'; renderAlerts();
    };
    const cl = pane.querySelector('#alClearLog'); if (cl) cl.onclick = async () => { await api('/api/alerts/log', { method: 'DELETE' }).catch(() => {}); loadLog(); };
    pane.querySelector('.al-list').onclick = async (e) => {
      const b = e.target.closest('[data-act]'); if (!b) return;
      const it = b.closest('.al-item'), act = b.dataset.act;
      if (it.dataset.tid) {
        const a = tech.find((x) => x.id === it.dataset.tid); if (!a) return;
        if (act === 'toggle') a.enabled = !a.enabled;
        if (act === 'del') tech = tech.filter((x) => x !== a);
        saveTech(); return renderAlerts();
      }
      const a = serverAlerts.find((x) => x.id === it.dataset.id); if (!a) return;
      try {
        if (act === 'toggle') await api(`/api/alerts/${a.id}`, { method: 'PATCH', body: { enabled: !a.enabled } });
        if (act === 'del') await api(`/api/alerts/${a.id}`, { method: 'DELETE' });
        if (act === 'test') { await api(`/api/alerts/${a.id}/test`, { method: 'POST' }); toast('Test alert sent'); }
        if (act === 'edit') return openAlertDialog({ edit: a });
      } catch (err) { toast(`Alert: ${err.message}`); }
      loadAlerts();
    };
  }

  function studyOutputs(v) {
    const out = [];
    for (const st of v.state.studies) { const def = IND.BY_ID[st.id]; if (!def) continue; for (const o of def.outputs || []) out.push({ key: `${st.uid}:${o.k}`, label: `${IND.title(def, st.params)} · ${o.label}` }); }
    return out;
  }
  function lineDrawings(v) {
    const geo = window.IGDraw.alertGeometry;
    return (app.shell.drawings[v.symbol] || []).filter((d) => !d.hidden && (geo ? !!geo(d) : ['trend', 'hline', 'hray'].includes(d.type)));
  }
  function openAlertDialog(opts = {}) {
    const v = active(); if (!v) return;
    const edit = opts.edit;
    const q = quotes[v.symbol] || {};
    const price = opts.price ?? (edit ? edit.value : mid(q) ?? v.basis[v.basis.length - 1]?.close);
    const outs = studyOutputs(v), lines = lineDrawings(v);
    const target = edit ? (edit.kind === 'watchlist' ? 'watchlist' : edit.kind === 'multi' ? 'multi' : 'price') : opts.watchlist ? 'watchlist' : opts.studyUid ? 'study' : 'price';
    const targets = [['price', `Price — ${v.title()}`], ['multi', 'Multi-condition (AND)'], ['watchlist', `Watchlist — ${curList().name}`], ...(outs.length ? [['study', 'Indicator on this chart']] : []), ...(lines.length ? [['drawing', 'Drawing (trend / horizontal line)']] : [])];
    const dec = v.decimals;
    const body = `<form class="ac-form al-form" id="alForm">
      ${app.formField({ k: 'target', label: 'Condition on', type: 'select', options: targets }, target)}
      <div data-show="price watchlist">${app.formField({ k: 'source', label: 'Price source', type: 'select', options: [['mid', 'Mid'], ['bid', 'Bid'], ['offer', 'Ask']] }, edit?.source || 'mid')}</div>
      <div data-show="study">${app.formField({ k: 'output', label: 'Indicator output', type: 'select', options: outs.map((o) => [o.key, o.label]) }, opts.studyUid ? outs.find((o) => o.key.startsWith(opts.studyUid))?.key : outs[0]?.key)}</div>
      <div data-show="drawing">${app.formField({ k: 'drawing', label: 'Drawing', type: 'select', options: lines.map((d) => [d.id, `${d.name || (window.IGDraw.TOOLS[d.tool || d.type] || {}).label || d.type} ${(d.pts || []).slice(0, 3).map((p) => fmtNum(p.p, dec)).join(' → ')}`]) }, lines[0]?.id)}</div>
      ${app.formField({ k: 'condition', label: 'Condition', type: 'select', options: COND }, edit?.condition || 'crossing')}
      <div data-show="study">${app.formField({ k: 'against', label: 'Compare with', type: 'select', options: [['value', 'Value'], ['price', 'Price'], ...outs.map((o) => [o.key, o.label])] }, 'value')}</div>
      <div data-show="study">${app.formField({ k: 'evaluate', label: 'Evaluate', type: 'select', options: [['bar_close', 'Once per bar close'], ['tick', 'On every tick']] }, 'bar_close')}</div>
      <div data-show="drawing">${app.formField({ k: 'dsource', label: 'Price source', type: 'select', options: [['mid', 'Mid'], ['bid', 'Bid'], ['offer', 'Ask']] }, 'mid')}</div>
      ${app.formField({ k: 'value', label: 'Value / lower bound', type: 'number', step: 'any' }, price != null ? Number(Number(price).toFixed(dec)) : '')}
      <div data-show="channel moving">${app.formField({ k: 'value2', label: 'Upper bound / window (s)', type: 'number', step: 'any', tip: 'Channel: upper bound. Moving: time window in seconds.' }, edit?.value2 ?? '')}</div>
      <div data-show="multi">${app.formField({ k: 'multi', label: 'Conditions (one per line)', type: 'text', placeholder: 'MOCK.GOLD mid greater_than 2600; MOCK.BTC mid less_than 90000' }, edit?.all ? edit.all.map((c) => `${c.epic} ${c.source || 'mid'} ${c.condition} ${c.value}${c.value2 != null ? ' ' + c.value2 : ''}`).join('; ') : '')}</div>
      ${app.formField({ k: 'trigger', label: 'Trigger', type: 'select', options: [['once', 'Only once'], ['every_time', 'Every time'], ['once_per_minute', 'Once per minute']] }, edit?.trigger || 'once')}
      ${app.formField({ k: 'expires', label: 'Expires', type: 'select', options: [['', 'Open-ended'], ['1', 'In 1 day'], ['7', 'In 1 week'], ['30', 'In 1 month'], ['61', 'In 2 months']] }, '')}
      ${app.formField({ k: 'name', label: 'Alert name', type: 'text' }, edit?.name || '')}
      ${app.formField({ k: 'message', label: 'Message', type: 'text', placeholder: '{{ticker}} {{condition}} {{value}} at {{price}}', tip: 'Placeholders: {{ticker}} {{market}} {{price}} {{bid}} {{offer}} {{time}} {{condition}} {{value}}' }, edit?.message || '')}
      ${app.formField({ k: 'webhook', label: 'Webhook URL', type: 'text', placeholder: 'https://…', tip: 'The server POSTs the message as JSON when the alert fires.' }, edit?.webhook?.url || '')}
      <div class="al-channels">${app.formField({ k: 'telegram', label: 'Send to Telegram', type: 'bool', tip: 'Needs TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID in .env' }, edit ? edit.telegram !== false : true)}${app.formField({ k: 'email', label: 'Send e-mail', type: 'bool', tip: 'Needs SMTP_HOST, SMTP_USER, SMTP_PASS and ALERT_EMAIL_TO in .env' }, edit ? edit.email !== false : true)}<small class="muted al-ch-status"></small></div>
    </form>`;
    const m = app.modal('alertModal', edit ? 'Edit alert' : 'Create alert', body, `<button data-close>Cancel</button><button class="primary" id="alSave">${edit ? 'Save' : 'Create'}</button>`);
    const form = m.querySelector('#alForm');
    const sync = () => {
      const t = form.target.value, c = form.condition.value;
      form.querySelectorAll('[data-show]').forEach((d) => {
        const tags = d.dataset.show.split(' ');
        const show = tags.includes(t) || (tags.includes('channel') && /channel/.test(c) && t !== 'multi') || (tags.includes('moving') && /moving/.test(c) && t !== 'multi');
        d.classList.toggle('hidden', !show);
      });
      form.querySelector('[name=condition]').closest('label').classList.toggle('hidden', t === 'multi');
      form.querySelector('[name=value]').closest('label').classList.toggle('hidden', t === 'multi' || (t === 'study' && form.against.value !== 'value') || t === 'drawing' || /^moving/.test(c) && false);
    };
    form.addEventListener('change', sync); sync();
    api('/api/notify/channels').then((st) => {
      const el = form.querySelector('.al-ch-status'); if (!el) return;
      const off = ['telegram', 'email'].filter((k) => !st[k]);
      el.innerHTML = (off.length ? esc(off.map((k) => (k === 'telegram' ? 'Telegram' : 'E-mail')).join(' and ') + ' not set up in .env. ') : '') + '<a href="#" data-act="ch-test">Send test</a>';
      el.querySelector('[data-act=ch-test]').onclick = async (e) => { e.preventDefault(); const r = await api('/api/notify/channels/test', { method: 'POST' }).catch((x) => ({ error: x.message })); const res = r.results || {}; toast(Object.keys(res).length ? Object.entries(res).map(([k, x]) => k + ': ' + (x.ok ? 'sent' : x.error)).join(' · ') : 'No channel configured in .env'); };
    }).catch(() => {});
    m.querySelector('#alSave').onclick = async () => {
      const f = Object.fromEntries(new FormData(form).entries());
      const num = (x) => (x === '' || x == null ? null : Number(x));
      const expiresAt = f.expires ? Date.now() + Number(f.expires) * 86400000 : null;
      const webhook = f.webhook ? { url: f.webhook.trim(), enabled: true } : null;
      try {
        if ((f.target === 'study' || f.target === 'drawing') && !IV.isExpr(v.symbol)) {
          const common0 = { name: f.name || undefined, trigger: f.trigger, expiresAt, message: f.message || undefined, webhook, notify: true, telegram: f.telegram === 'on', email: f.email === 'on', condition: f.condition };
          let sbody;
          if (f.target === 'study') {
            const [u, k] = f.output.split(':'), st = v.state.studies.find((x) => x.uid === u);
            let compare;
            if (f.against === 'value') compare = { type: 'value', value: num(f.value), value2: num(f.value2) };
            else if (f.against === 'price') compare = { type: 'price', source: 'mid' };
            else { const [u2, k2] = f.against.split(':'), st2 = v.state.studies.find((x) => x.uid === u2); compare = u2 === u ? { type: 'output', output: k2 } : { type: 'indicator', id: st2.id, params: st2.params, output: k2 }; }
            sbody = { ...common0, kind: 'indicator', epic: v.symbol, interval: st.tf || v.interval, indicator: { id: st.id, params: st.params, output: k }, compare, evaluate: f.evaluate };
          } else {
            const d = (app.shell.drawings[v.symbol] || []).find((x) => x.id === f.drawing);
            const geometry = window.IGDraw.alertGeometry ? window.IGDraw.alertGeometry(d) : null;
            if (geometry) sbody = { ...common0, kind: 'drawing', epic: v.symbol, source: f.dsource, geometry, drawingId: d.id, name: f.name || `${v.title()} · ${(window.IGDraw.TOOLS[d.tool || d.type] || {}).label || d.type}` };
          }
          if (sbody) {
            try {
              await api('/api/alerts', { method: 'POST', body: sbody });
              app.closeModals(); toast('Alert created — runs on the server'); return loadAlerts();
            } catch (err) { console.warn('[alert] server rejected, keeping it in this browser', err.body || err.message); }
          }
        }
        if (f.target === 'study' || f.target === 'drawing') {
          const label = f.target === 'study' ? (outs.find((o) => o.key === f.output) || {}).label : `Drawing ${(lines.find((d) => d.id === f.drawing) || {}).type}`;
          const vs = f.against === 'value' || f.target === 'drawing' ? num(f.value) : null;
          const desc = `${v.title()} ${IV.label(v.interval)} · ${label} ${condLabel(f.condition)} ${f.target === 'drawing' ? 'price' : vs ?? (outs.find((o) => o.key === f.against) || {}).label}`;
          if (!['crossing', 'crossing_up', 'crossing_down', 'greater_than', 'less_than'].includes(f.condition)) return toast('Browser-side alerts support crossing, greater than and less than');
          if (f.against === 'price') f.against = 'value';
          tech.push({ id: uid(), enabled: true, kind: f.target, symbol: v.symbol, interval: v.interval, output: f.output, drawing: f.drawing, against: f.target === 'study' ? f.against : 'value', value: vs, condition: f.condition, trigger: f.trigger, expiresAt, name: f.name || desc, desc, message: f.message, webhook, firedCount: 0 });
          saveTech(); renderAlerts(); app.closeModals(); return toast('Alert created');
        }
        const common = { name: f.name || undefined, trigger: f.trigger, expiresAt, message: f.message || undefined, webhook, notify: true, telegram: f.telegram === 'on', email: f.email === 'on' };
        let body;
        if (f.target === 'multi') {
          const all = f.multi.split(/[;\n]+/).map((s) => s.trim()).filter(Boolean).map((s) => { const [epic, source, condition, value, value2] = s.split(/\s+/); return { epic, source, condition, value: Number(value), value2: value2 != null ? Number(value2) : undefined }; });
          body = { ...common, all };
        } else if (f.target === 'watchlist') body = { ...common, kind: 'watchlist', epics: listItems(curList()).filter((x) => !isSection(x)), source: f.source, condition: f.condition, value: num(f.value), value2: num(f.value2) };
        else body = { ...common, epic: v.symbol, source: f.source, condition: f.condition, value: num(f.value), value2: num(f.value2) };
        if (edit) await api(`/api/alerts/${edit.id}`, { method: 'PATCH', body: { ...body, enabled: true } });
        else await api('/api/alerts', { method: 'POST', body });
        if ('Notification' in window && Notification.permission === 'default') Notification.requestPermission().catch(() => {});
        C.unlockAudio();
        app.closeModals(); toast(edit ? 'Alert updated' : 'Alert created'); loadAlerts();
      } catch (err) { toast(`Alert not saved: ${err.body && err.body.error || err.message}`); }
    };
  }

  // client-side evaluation of indicator / drawing alerts
  const findView = (a) => app.views.find((v) => v.symbol === a.symbol && IV.label(v.interval) === IV.label(a.interval) && !v.rp.on);
  const techPrev = new Map();
  function lineValueAt(d, t) {
    if (d.type === 'hline' || d.type === 'hray') return d.pts[0].p;
    const [a, b] = d.pts; if (!a || !b || a.t === b.t) return null;
    if (!d.extR && !d.extL && (t > Math.max(a.t, b.t) || t < Math.min(a.t, b.t))) return null;
    return a.p + ((b.p - a.p) * (t - a.t)) / (b.t - a.t);
  }
  function evalTech() {
    const now = Date.now();
    for (const a of tech) {
      if (!a.enabled || (a.expiresAt && now > a.expiresAt)) continue;
      const v = findView(a); if (!v || !v.basis.length) continue;
      const i = v.basis.length - 1, bar = v.basis[i];
      let x, y;
      if (a.kind === 'study') {
        const [u, k] = a.output.split(':'), rt = v.rts.get(u); if (!rt) continue;
        x = rt.vals[k] && rt.vals[k][i];
        if (a.against && a.against !== 'value') { const [u2, k2] = a.against.split(':'), rt2 = v.rts.get(u2); y = rt2 && rt2.vals[k2] && rt2.vals[k2][i]; } else y = a.value;
      } else {
        const d = (app.shell.drawings[a.symbol] || []).find((z) => z.id === a.drawing); if (!d) continue;
        x = mid(quotes[a.symbol]) ?? bar.close; y = lineValueAt(d, Math.floor(now / 1000));
      }
      if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
      const prev = techPrev.get(a.id); techPrev.set(a.id, { x, y });
      let hit = false;
      if (a.condition === 'greater_than') hit = x > y && !(prev && prev.x > prev.y);
      else if (a.condition === 'less_than') hit = x < y && !(prev && prev.x < prev.y);
      else if (prev) { const up = prev.x <= prev.y && x > y, dn = prev.x >= prev.y && x < y; hit = a.condition === 'crossing_up' ? up : a.condition === 'crossing_down' ? dn : up || dn; }
      if (!hit) continue;
      if (a.trigger === 'once_per_minute' && a.lastFired && now - a.lastFired < 60000) continue;
      a.lastFired = now; a.firedCount = (a.firedCount || 0) + 1;
      if (a.trigger === 'once') a.enabled = false;
      saveTech();
      const msg = (a.message || `${a.desc}`).replace(/\{\{ticker\}\}/g, a.symbol).replace(/\{\{price\}\}/g, fmtNum(bar.close, v.decimals)).replace(/\{\{value\}\}/g, fmtNum(x, 4)).replace(/\{\{time\}\}/g, new Date().toISOString()).replace(/\{\{condition\}\}/g, condLabel(a.condition));
      api('/api/notify', { method: 'POST', body: { title: a.name, message: msg, webhook: a.webhook && a.webhook.url ? a.webhook : undefined, epic: a.symbol, price: bar.close } })
        .catch(() => { toast(`🔔 ${a.name}: ${msg}`, 'alert'); beep(true); });
      renderAlerts();
    }
  }
  let techT = 0;
  function onTickEval() { if (!tech.length) return; const n = Date.now(); if (n - techT < 500) return; techT = n; evalTech(); }

  async function migrateOldAlerts() {
    const old = store.get('priceAlerts', []);
    if (!old.length) return;
    let okN = 0;
    for (const a of old) {
      if (!a.active) continue;
      try { await api('/api/alerts', { method: 'POST', body: { epic: a.epic, source: a.src === 'offer' ? 'offer' : a.src, condition: a.cond === 'above' ? 'crossing_up' : a.cond === 'below' ? 'crossing_down' : 'crossing', value: a.price, trigger: a.repeat === 'every' ? 'every_time' : 'once', notify: true } }); okN++; } catch { return; }
    }
    store.set('priceAlerts.migrated', old); store.del('priceAlerts');
    if (okN) toast(`Moved ${okN} price alert${okN > 1 ? 's' : ''} to the server (they now run with the page closed)`);
  }

  // ------------------------------------------------------------ Object tree & data window
  let treeT = 0;
  function refreshTree() {
    if (sbOpen !== 'tree') return;
    clearTimeout(treeT); treeT = setTimeout(renderTree, 50);
  }
  function renderTree() {
    const pane = document.querySelector('.sb-pane[data-sb=tree]');
    const v = active(); if (!v) return;
    const ds = v.draw.list ? v.draw.list() : (app.shell.drawings[v.symbol] || []);
    pane.innerHTML = `<div class="wl-head"><b>Object tree</b><span class="spacer"></span><span class="muted">${esc(v.title())} · ${esc(IV.label(v.interval))}</span></div>
      <div class="tree">
        <div class="ind-h">Indicators (${v.state.studies.length})</div>
        ${v.state.studies.map((st) => { const d = IND.BY_ID[st.id]; return `<div class="tree-row ${st.visible ? '' : 'off'}" data-uid="${st.uid}"><span>${esc(d ? IND.title(d, st.params) : st.id)}</span><span class="al-btns"><button data-t="vis">${st.visible ? '◉' : '○'}</button><button data-t="set">⚙</button><button data-t="del">✕</button></span></div>`; }).join('') || '<div class="muted pad">None</div>'}
        <div class="ind-h">Drawings (${ds.length})</div>
        ${ds.map((d) => `<div class="tree-row ${d.hidden || d.groupHidden || d.visibleNow === false ? 'off' : ''}" data-did="${d.id}" title="${d.visibleNow === false ? 'Hidden on this interval' : ''}"><span><i class="flag" style="background:${esc(d.color || '#888')}"></i>${d.group ? `<small class="muted">${esc(d.group)} ›</small> ` : ''}${esc(d.name || d.label || (window.IGDraw.TOOLS[d.type] || {}).label || d.type)}</span><span class="al-btns">${v.draw.setItemHidden ? `<button data-t="hide">${d.hidden ? '○' : '◉'}</button>` : ''}${v.draw.setItemLocked ? `<button data-t="lock">${d.locked ? '🔒' : '🔓'}</button>` : ''}${v.draw.select ? '<button data-t="sel">⌖</button>' : ''}<button data-t="rm">✕</button></span></div>`).join('') || '<div class="muted pad">None</div>'}
      </div>
      <div class="wl-head"><b>Data window</b></div><div class="datawin" id="dataWin"></div>`;
    pane.querySelector('.tree').onclick = (e) => {
      const b = e.target.closest('[data-t]'); if (!b) return;
      const row = b.closest('.tree-row'), t = b.dataset.t;
      if (row.dataset.uid) { if (t === 'vis') v.toggleStudy(row.dataset.uid); if (t === 'del') v.removeStudy(row.dataset.uid); if (t === 'set') app.shell.openStudySettings(v, row.dataset.uid); }
      if (row.dataset.did) {
        const id = row.dataset.did, d = ds.find((x) => x.id === id);
        if (t === 'hide') v.draw.setItemHidden(id, !d.hidden);
        if (t === 'lock') v.draw.setItemLocked(id, !d.locked);
        if (t === 'sel') v.draw.select(id);
        if (t === 'rm') { if (v.draw.remove) v.draw.remove(id); else { app.shell.drawings[v.symbol] = ds.filter((x) => x !== d); app.shell.saveDrawings(); } }
      }
      renderTree();
    };
    renderDataWindow(v);
  }
  function renderDataWindow(v) {
    const box = $('dataWin'); if (!box || !v) return;
    const d = v.dataAt(v.crossIdx);
    if (!d) { box.innerHTML = '<div class="muted pad">No data</div>'; return; }
    box.innerHTML = `<div class="dw-grid">${d.rows.map(([k, val]) => `<span>${esc(k)}</span><span>${esc(val)}</span>`).join('')}</div>`
      + d.groups.map((g) => `<div class="dw-h">${esc(g.title)}</div><div class="dw-grid">${g.rows.map(([k, val, c]) => `<span>${esc(k)}</span><span style="color:${esc(c)}">${esc(val)}</span>`).join('')}</div>`).join('');
  }
  let dwRaf = 0;
  function onCrosshair(v) { if (sbOpen !== 'tree' || v !== active() || dwRaf) return; dwRaf = requestAnimationFrame(() => { dwRaf = 0; renderDataWindow(v); }); }

  // ------------------------------------------------------------ Screener (watchlist symbols, technical fields + rating)
  function techRating(c) {
    const ta = IND.ta, cl = c.map((x) => x.close), n = cl.length - 1, px = cl[n];
    if (n < 30) return null;
    let buy = 0, sell = 0, cnt = 0;
    const vote = (b, s) => { cnt++; if (b) buy++; else if (s) sell++; };
    for (const len of [10, 20, 30, 50, 100, 200]) { if (n < len) continue; const s = ta.sma(cl, len)[n], e = ta.ema(cl, len)[n]; vote(px > s, px < s); vote(px > e, px < e); }
    const maR = cnt ? (buy - sell) / cnt : 0;
    let ob = 0, os = 0, oc = 0;
    const ov = (b, s) => { oc++; if (b) ob++; else if (s) os++; };
    const r = ta.rsi(cl, 14); ov(r[n] < 30 && r[n] > r[n - 1], r[n] > 70 && r[n] < r[n - 1]);
    const e12 = ta.ema(cl, 12), e26 = ta.ema(cl, 26), macd = cl.map((_, i) => e12[i] - e26[i]), sig = ta.ema(macd.map((x) => (Number.isFinite(x) ? x : NaN)), 9); ov(macd[n] > sig[n], macd[n] < sig[n]);
    const mom = px - cl[n - 10]; ov(mom > 0 && mom > cl[n - 1] - cl[n - 11], mom < 0 && mom < cl[n - 1] - cl[n - 11]);
    const hh = ta.highest(c.map((x) => x.high), 14)[n], ll = ta.lowest(c.map((x) => x.low), 14)[n], k = hh > ll ? ((px - ll) / (hh - ll)) * 100 : 50; ov(k < 20, k > 80);
    const oscR = oc ? (ob - os) / oc : 0;
    const all = (maR + oscR) / 2;
    const label = (x) => (x > 0.5 ? 'Strong buy' : x > 0.1 ? 'Buy' : x < -0.5 ? 'Strong sell' : x < -0.1 ? 'Sell' : 'Neutral');
    const atr = ta.atr(c, 14)[n];
    return { rating: all, label: label(all), ma: label(maR), osc: label(oscR), rsi: r[n], atrPct: (atr / px) * 100, sma50: n >= 50 ? ((px / ta.sma(cl, 50)[n]) - 1) * 100 : NaN, perf: ((px / cl[Math.max(0, n - 20)]) - 1) * 100 };
  }
  function mountScreener(el) {
    const S = { rows: [], sort: { k: 'rating', dir: -1 }, interval: store.get('scrIv', '60'), listId: WL.active, filters: {} };
    const COLSX = [['name', 'Symbol'], ['last', 'Last'], ['chgp', 'Chg %'], ['perf', 'Perf 20 bars %'], ['rsi', 'RSI 14'], ['atrPct', 'ATR %'], ['sma50', 'vs SMA50 %'], ['ma', 'MAs'], ['osc', 'Oscillators'], ['label', 'Technical rating']];
    const num = (x, d = 2) => (Number.isFinite(x) ? x.toFixed(d) : '—');
    const render = () => {
      const lists = WL.lists.map((l) => `<option value="${l.id}" ${l.id === S.listId ? 'selected' : ''}>${esc(l.name)}</option>`).join('');
      let rows = S.rows.filter((r) => Object.entries(S.filters).every(([k, f]) => { const v = r[k]; if (f.min !== '' && f.min != null && !(v >= Number(f.min))) return false; if (f.max !== '' && f.max != null && !(v <= Number(f.max))) return false; return true; }));
      const { k, dir } = S.sort;
      rows = rows.sort((a, b) => { const x = a[k === 'label' ? 'rating' : k], y = b[k === 'label' ? 'rating' : k]; return ((x ?? -Infinity) < (y ?? -Infinity) ? -1 : (x ?? -Infinity) > (y ?? -Infinity) ? 1 : 0) * dir; });
      el.innerHTML = `<div class="scr"><div class="scr-bar">
          <label>List <select id="scrList">${lists}</select></label>
          <label>Interval <select id="scrIv">${['5', '15', '60', '240', '1D', '1W'].map((x) => `<option value="${x}" ${x === S.interval ? 'selected' : ''}>${IV.label(x)}</option>`).join('')}</select></label>
          <button id="scrRun" class="primary">Scan</button><button id="scrCsv">Export CSV</button>
          <span class="muted">${S.status || 'Scans the list with 250 bars per symbol (uses IG history allowance; cached by the server).'}</span></div>
        <div class="scr-table"><table><thead><tr>${COLSX.map(([c, l]) => `<th data-k="${c}">${l}${S.sort.k === c ? (S.sort.dir > 0 ? ' ▲' : ' ▼') : ''}</th>`).join('')}</tr>
          <tr class="scr-f">${COLSX.map(([c]) => (['last', 'chgp', 'perf', 'rsi', 'atrPct', 'sma50'].includes(c) ? `<th><input data-f="${c}" data-b="min" placeholder="min" value="${esc(S.filters[c]?.min ?? '')}"><input data-f="${c}" data-b="max" placeholder="max" value="${esc(S.filters[c]?.max ?? '')}"></th>` : '<th></th>')).join('')}</tr></thead>
          <tbody>${rows.map((r) => `<tr data-epic="${esc(r.epic)}"><td>${esc(r.name)}</td><td>${num(r.last)}</td><td class="${r.chgp > 0 ? 'up' : r.chgp < 0 ? 'down' : ''}">${num(r.chgp)}</td><td class="${r.perf > 0 ? 'up' : 'down'}">${num(r.perf)}</td><td>${num(r.rsi, 1)}</td><td>${num(r.atrPct)}</td><td class="${r.sma50 > 0 ? 'up' : 'down'}">${num(r.sma50)}</td><td>${esc(r.ma || '')}</td><td>${esc(r.osc || '')}</td><td class="rt ${/buy/i.test(r.label) ? 'up' : /sell/i.test(r.label) ? 'down' : ''}">${esc(r.label || r.err || '')}</td></tr>`).join('') || `<tr><td colspan="${COLSX.length}" class="muted pad">Press Scan.</td></tr>`}</tbody></table></div></div>`;
      el.querySelector('#scrList').onchange = (e) => { S.listId = e.target.value; };
      el.querySelector('#scrIv').onchange = (e) => { S.interval = e.target.value; store.set('scrIv', S.interval); };
      el.querySelector('#scrRun').onclick = scan;
      el.querySelector('#scrCsv').onclick = () => download('screener.csv', toCSV([COLSX.map((c) => c[1]), ...rows.map((r) => COLSX.map(([c]) => (c === 'name' ? r.name : r[c] ?? '')))]));
      el.querySelector('thead').onclick = (e) => { const th = e.target.closest('th[data-k]'); if (!th) return; const kk = th.dataset.k; S.sort = { k: kk, dir: S.sort.k === kk ? -S.sort.dir : -1 }; render(); };
      el.querySelector('thead').onchange = (e) => { const i = e.target.closest('[data-f]'); if (!i) return; S.filters[i.dataset.f] = { ...(S.filters[i.dataset.f] || {}), [i.dataset.b]: i.value }; render(); };
      el.querySelector('tbody').onclick = (e) => { const tr = e.target.closest('tr[data-epic]'); if (tr && active()) active().setSymbol(tr.dataset.epic); };
    };
    async function scan() {
      const L = WL.lists.find((l) => l.id === S.listId) || curList();
      const epics = L.items.filter((x) => !isSection(x));
      const sp = IV.parse(S.interval), res = IV.baseRes(sp);
      S.rows = []; S.status = `Scanning ${epics.length} symbols…`; render();
      for (const e of epics) {
        const q = quotes[e] || {};
        const row = { epic: e, name: nameOf(e), last: q.bid, chgp: q.changePct };
        try {
          const ratio = Math.max(1, Math.round(sp.sec / C.RES_SEC[res]));
          const r = await api(`/api/history?epic=${encodeURIComponent(e)}&resolution=${res}&max=${Math.min(5000, 250 * ratio)}`);
          app.shell.onAllowance(r.allowance);
          const bars = ratio > 1 && window.IGTypes ? window.IGTypes.aggregate(r.candles, sp) : r.candles;
          Object.assign(row, techRating(bars) || { label: 'not enough data' });
          if (row.last == null) row.last = bars[bars.length - 1]?.close;
        } catch (err) { row.err = err.body?.error || err.message; }
        S.rows.push(row); render();
      }
      S.status = `Scanned ${epics.length} symbols · ${new Date().toLocaleTimeString()}`; render();
    }
    render();
    return { refresh: render, destroy() { el.innerHTML = ''; } };
  }

  // ------------------------------------------------------------ Init / events
  function init({ app: a, status }) {
    app = a;
    const mock = status && status.mode === 'MOCK';
    for (const l of WL.lists) l.items = l.items.filter((e) => isSection(e) || e.startsWith('MOCK.') === !!mock);
    if (WL.lists.every((l) => !l.items.length) && status && status.defaults) { WL.lists[0].items.push(...status.defaults); }
    saveWL();
    wirePanels(); applyPanels();
    syncWlSubs(); renderWatchlist(); renderAlerts();
    loadAlerts().then(migrateOldAlerts);
    if (window.IGMT5) setTimeout(() => window.IGMT5.init(app), 0);
    if (window.IGPush) { const upd = () => { pushState = window.IGPush.state(); renderAlerts(); }; upd(); window.IGPush.ready && window.IGPush.ready.then(upd).catch(() => {}); window.IGPush.onChange && window.IGPush.onChange(upd); }
    loadCalendar(); setInterval(() => loadCalendar(true), 30 * 60000);
    bus.on('theme', applyEvents);
    bus.on('active-changed', () => { if (settings.events) applyEvents(); });
    bus.on('tick', (epic) => { updateWatchRow(epic); if (active() && epic === active().symbol) renderDetailsThrottled(); onTickEval(); });
    bus.on('active-changed', () => { renderWatchlistActive(); renderDetails(); refreshTree(); });
    bus.on('alerts-changed', loadAlerts);
    bus.on('alert', (m) => {
      const ev = m.event || {}, al = m.alert || {};
      const name = al.name || 'Alert';
      let text = String(ev.message || '');
      if (text.startsWith(name)) text = text.slice(name.length).replace(/^\s*[:·|-]\s*/, '');
      toast(`🔔 ${name}\n${text}`, 'alert');
      beep(true);
      if (al.notify !== false) notify(`🔔 ${name}`, text);
      if (alertTab === 'log') loadLog();
    });
    if (bpOpen) mountModule(bpOpen);
  }
  let detT = 0;
  function renderDetailsThrottled() { const n = Date.now(); if (n - detT < 250) return; detT = n; renderDetails(); }
  function renderWatchlistActive() { const cur = active() && active().symbol; document.querySelectorAll('#wlList li[data-epic]').forEach((li) => li.classList.toggle('active', li.dataset.epic === cur)); }

  // ------------------------------------------------------------ Economic calendar & news
  const NEWS = { tab: 'cal', cal: [], news: [], impact: store.get('calImpact', 'hm'), ccy: store.get('calCcy', 'USD'), loaded: 0, err: '' };
  async function loadCalendar(force) {
    if (!force && Date.now() - NEWS.loaded < 10 * 60000 && NEWS.cal.length) return;
    try { const r = await api('/api/calendar'); NEWS.cal = (r.events || []).sort((a, b) => a.time - b.time); NEWS.err = r.error || ''; NEWS.loaded = Date.now(); } catch (e) { NEWS.err = e.message; }
    applyEvents(); if (sbOpen === 'news') renderNews();
  }
  async function loadNews() { try { const r = await api('/api/news?limit=60'); NEWS.news = r.items || []; } catch (e) { NEWS.news = []; NEWS.err = e.message; } if (sbOpen === 'news') renderNews(); }
  const impactOk = (e) => (NEWS.impact === 'all' ? true : NEWS.impact === 'h' ? e.impact === 'High' : e.impact === 'High' || e.impact === 'Medium');
  const ccyOk = (e) => !NEWS.ccy.trim() || NEWS.ccy.toUpperCase().split(/[\s,]+/).filter(Boolean).includes(String(e.currency || e.country || '').toUpperCase());
  function applyEvents() {
    const list = settings.events ? NEWS.cal.filter((e) => (e.impact === 'High' || e.impact === 'Medium') && ccyOk(e)).map((e) => ({ ...e, short: e.currency || '' })) : [];
    if (app) app.views.forEach((v) => v.setEvents(list));
  }
  function renderNews() {
    const pane = document.querySelector('.sb-pane[data-sb=news]');
    const now = Date.now() / 1000;
    const cal = NEWS.cal.filter((e) => impactOk(e) && ccyOk(e));
    const nextIdx = cal.findIndex((e) => e.time >= now);
    const dayKey = (t) => C.fmtDate(t);
    let lastDay = '';
    const col = { High: '#ef5350', Medium: '#ff9800', Low: '#f7b924', Holiday: '#9598a1' };
    pane.innerHTML = '<div class="wl-head"><div class="seg"><button data-nt="cal" class="' + (NEWS.tab === 'cal' ? 'on' : '') + '">Calendar</button><button data-nt="news" class="' + (NEWS.tab === 'news' ? 'on' : '') + '">News</button></div><span class="spacer"></span><button class="icon-btn" id="nwRefresh" title="Refresh">⟳</button></div>'
      + (NEWS.tab === 'cal'
        ? '<div class="cal-filter"><select id="calImp"><option value="h"' + (NEWS.impact === 'h' ? ' selected' : '') + '>High impact</option><option value="hm"' + (NEWS.impact === 'hm' ? ' selected' : '') + '>High + medium</option><option value="all"' + (NEWS.impact === 'all' ? ' selected' : '') + '>All</option></select><input id="calCcy" size="9" placeholder="USD, EUR" value="' + esc(NEWS.ccy) + '" title="Currencies (blank = all)"><label class="muted"><input type="checkbox" id="calOnChart"' + (settings.events ? ' checked' : '') + '> on charts</label></div>'
          + '<div class="cal-list">' + (cal.map((e, i) => { const d = dayKey(e.time); const head = d !== lastDay ? '<div class="cal-day">' + esc(d) + '</div>' : ''; lastDay = d; return head + '<div class="cal-ev' + (e.time < now ? ' past' : '') + (i === nextIdx ? ' next' : '') + '"><span>' + esc(C.dtf({ hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(e.time * 1000))) + '</span><span><i class="imp" style="background:' + (col[e.impact] || '#9598a1') + '"></i>' + esc(e.currency || e.country || '') + '</span><span>' + esc(e.title) + '<small>' + [e.actual != null && e.actual !== '' ? 'Actual ' + esc(e.actual) : '', e.forecast ? 'Fcst ' + esc(e.forecast) : '', e.previous ? 'Prev ' + esc(e.previous) : ''].filter(Boolean).join(' · ') + '</small></span></div>'; }).join('') || '<div class="muted pad">' + (NEWS.err ? 'Calendar unavailable: ' + esc(NEWS.err) : 'No events for this filter.') + '</div>') + '</div>'
        : '<div class="news-list">' + (NEWS.news.map((n) => '<a class="news-it" href="' + esc(n.link) + '" target="_blank" rel="noopener noreferrer"><b>' + esc(n.title) + '</b><small>' + esc(n.source || '') + (n.time ? ' · ' + esc(C.fmtTime(n.time)) : '') + '</small></a>').join('') || '<div class="muted pad">' + (NEWS.err ? 'News unavailable: ' + esc(NEWS.err) : 'No news yet.') + '</div>') + '</div>');
    pane.querySelector('.seg').onclick = (e) => { const b = e.target.closest('[data-nt]'); if (!b) return; NEWS.tab = b.dataset.nt; if (NEWS.tab === 'news' && !NEWS.news.length) loadNews(); renderNews(); };
    pane.querySelector('#nwRefresh').onclick = () => (NEWS.tab === 'cal' ? loadCalendar(true) : loadNews());
    const imp = pane.querySelector('#calImp'); if (imp) imp.onchange = (e) => { NEWS.impact = e.target.value; store.set('calImpact', NEWS.impact); renderNews(); };
    const cc = pane.querySelector('#calCcy'); if (cc) cc.onchange = (e) => { NEWS.ccy = e.target.value; store.set('calCcy', NEWS.ccy); applyEvents(); renderNews(); };
    const oc = pane.querySelector('#calOnChart'); if (oc) oc.onchange = (e) => { settings.events = e.target.checked; C.saveSettings(); applyEvents(); };
  }

  window.IGPanels = {
    init, moveOverlays, alertLines, addToWatchlist, openAlertDialog, refreshTree, onCrosshair,
    refreshWatchlist: () => renderWatchlist(),
    reloadWatchlists: () => { WL = store.get('watchlists', WL); syncWlSubs(); renderWatchlist(); },
    onBarClose: (v) => { if (v === active()) bus.emit('active-changed'); if (tech.length) evalTech(); },
  };
});
