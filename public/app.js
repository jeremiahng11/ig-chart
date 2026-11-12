/* IG Charts — application shell: multi-chart layouts, toolbar, dialogs, keyboard, boot. */
window.IGC.ready.then(() => {
  Object.assign(window.IGC.settings, window.IGC.store.get('settings', {}));
  Object.assign(window.IGC.names, window.IGC.store.get('names', {}));

  const C = window.IGC;
  const { $, esc, uid, store, settings, T, api, bus, nameOf, quotes, toast, download, fmtTime } = C;
  const IND = window.IGInd, AC = window.AIChance, TY = window.IGTypes || {}, IV = C.iv;

  // ------------------------------------------------------------ Modals
  function modal(id, title, body, foot = '', cls = '') {
    let m = $(id);
    if (!m) {
      m = document.createElement('div');
      m.id = id; m.className = 'modal hidden';
      m.addEventListener('mousedown', (e) => { if (e.target === m) m.classList.add('hidden'); });
      m.addEventListener('click', (e) => { if (e.target.closest('[data-close]')) m.classList.add('hidden'); });
      $('modals').appendChild(m);
    }
    m.innerHTML = `<div class="modal-card ${cls}"><div class="modal-head"><b>${title}</b><button class="x" data-close>✕</button></div><div class="modal-body">${body}</div>${foot ? `<div class="modal-foot">${foot}</div>` : ''}</div>`;
    m.classList.remove('hidden');
    return m;
  }
  const closeModals = () => { let any = false; document.querySelectorAll('.modal:not(.hidden)').forEach((m) => { m.classList.add('hidden'); any = true; }); return any; };
  const anyModal = () => !!document.querySelector('.modal:not(.hidden)');
  function formField(x, v) {
    const tip = x.tip ? `<small>${esc(x.tip)}</small>` : '';
    let input;
    if (x.type === 'bool') input = `<input type="checkbox" name="${esc(x.k)}" ${v ? 'checked' : ''}>`;
    else if (x.type === 'number' || x.type === 'int') input = `<input type="number" name="${esc(x.k)}" value="${esc(v)}" step="${x.step ?? (x.type === 'int' ? 1 : 'any')}" ${x.min != null ? `min="${x.min}"` : ''} ${x.max != null ? `max="${x.max}"` : ''}>`;
    else if (x.type === 'color') input = `<input type="color" name="${esc(x.k)}" value="${esc(v)}">`;
    else if (x.type === 'time') { const d = v ? new Date(v * 1000) : new Date(); const loc = new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16); input = `<input type="datetime-local" name="${esc(x.k)}" value="${loc}">`; }
    else if (x.type === 'text') input = `<input type="text" name="${esc(x.k)}" value="${esc(v ?? '')}" placeholder="${esc(x.placeholder || '')}">`;
    else input = `<select name="${esc(x.k)}">${(x.options || []).map((op) => { const [val, lab] = Array.isArray(op) ? op : [op, op]; return `<option value="${esc(val)}" ${String(v) === String(val) ? 'selected' : ''}>${esc(lab)}</option>`; }).join('')}</select>`;
    return `<label><span>${esc(x.label || x.k)}${tip}</span>${input}</label>`;
  }
  const readField = (x, el) => (x.type === 'bool' ? el.checked : x.type === 'number' || x.type === 'int' ? Number(el.value) : x.type === 'time' ? Math.floor(new Date(el.value).getTime() / 1000) : el.value);

  // ------------------------------------------------------------ AI Chance (shared options + signal log)
  const acOpts = { ...(AC ? AC.DEFAULTS : {}), ...store.get('ac', {}) };
  let acLog = store.get('acLog', []);

  // ------------------------------------------------------------ Drawings (shared by every chart that shows the same market)
  function migrateTrendlines() {
    const old = store.get('trendlines', {}), out = {};
    for (const [k, list] of Object.entries(old)) out[k] = list.map((L) => ({ id: L.id, type: 'trend', color: L.color || '#2962ff', width: 1.75, style: 0, extR: !!L.ext, pts: [{ t: L.t1, p: L.p1 }, { t: L.t2, p: L.p2 }] }));
    return out;
  }
  const drawings = store.get('drawings', null) || migrateTrendlines();
  let drawSaveT;
  const saveDrawings = () => { clearTimeout(drawSaveT); drawSaveT = setTimeout(() => store.set('drawings', drawings), 300); };

  // ------------------------------------------------------------ Layouts
  const GRIDS = {
    '1': { c: 1, r: 1 }, '2h': { c: 2, r: 1 }, '2v': { c: 1, r: 2 }, '3h': { c: 3, r: 1 }, '3v': { c: 1, r: 3 }, '3l': { c: 2, r: 2, n: 3, span: true },
    '4': { c: 2, r: 2 }, '4h': { c: 4, r: 1 }, '4v': { c: 1, r: 4 }, '6': { c: 3, r: 2 }, '8': { c: 4, r: 2 }, '9': { c: 3, r: 3 }, '12': { c: 4, r: 3 }, '16': { c: 4, r: 4 },
  };
  const gridN = (g) => GRIDS[g].n || GRIDS[g].c * GRIDS[g].r;
  const gridIcon = (g) => {
    const G = GRIDS[g], w = 16 / G.c, h = 14 / G.r;
    let s = '';
    for (let r = 0; r < G.r; r++) for (let c = 0; c < G.c; c++) { if (G.span && c === 0 && r === 1) continue; s += `<rect x="${1 + c * w}" y="${2 + r * h}" width="${w - 1}" height="${(G.span && c === 0 ? 2 * h : h) - 1}" rx="1"/>`; }
    return `<svg class="ico" viewBox="0 0 18 18">${s}</svg>`;
  };
  const TF_MAP = { MINUTE: '1', MINUTE_5: '5', MINUTE_15: '15', MINUTE_30: '30', HOUR: '60', HOUR_4: '240', DAY: '1D', WEEK: '1W' };
  function defaultLayout() {
    const v = { symbol: store.get('epic', null), interval: TF_MAP[store.get('tf', 'MINUTE_5')] || '5', type: store.get('type', 'candles'), studies: store.get('studies', null) || [{ id: 'vol' }, { id: 'sma', params: { length: 20 } }], ac: !!acOpts.enabled, compares: [] };
    return { id: uid(), name: 'My layout', grid: '1', views: [v], sync: { symbol: false, interval: false, crosshair: true, time: false }, active: 0 };
  }
  let layouts = store.get('layouts', null);
  if (!Array.isArray(layouts) || !layouts.length) layouts = [defaultLayout()];
  const hashLayout = (location.hash.match(/layout=([\w-]+)/) || [])[1];
  let L = layouts.find((x) => x.id === (hashLayout || store.get('activeLayout'))) || layouts[0];
  let views = [], active = null;
  let saveT;
  // one undo stack for chart changes (indicators, type, interval, side, scale…) and drawings
  const hist = { undo: [], redo: [], snaps: new Map(), muted: false };
  function recordStates() {
    if (hist.muted) return;
    for (const v of views) {
      const s = JSON.stringify(v.serialize()), prev = hist.snaps.get(v);
      if (prev === undefined) { hist.snaps.set(v, s); continue; }
      if (prev !== s) { hist.undo.push({ kind: 'state', v, before: prev, after: s }); hist.redo = []; hist.snaps.set(v, s); if (hist.undo.length > 200) hist.undo.shift(); }
    }
  }
  function recordDraw(v) { if (hist.muted) return; hist.undo.push({ kind: 'draw', v }); hist.redo = []; if (hist.undo.length > 200) hist.undo.shift(); }
  function undoRedo(from, to) {
    while (hist[from].length) {
      const e = hist[from].pop();
      if (!views.includes(e.v)) continue;
      hist.muted = true;
      try {
        if (e.kind === 'draw') { if (!(from === 'undo' ? e.v.draw.undo() : e.v.draw.redo())) continue; }
        else { e.v.restoreState(JSON.parse(from === 'undo' ? e.before : e.after)); hist.snaps.set(e.v, from === 'undo' ? e.before : e.after); }
      } finally { setTimeout(() => { hist.muted = false; }, 0); }
      hist[to].push(e);
      setActive(e.v); refreshToolbar();
      return true;
    }
    return false;
  }
  const persist = () => {
    clearTimeout(saveT);
    saveT = setTimeout(() => {
      L.views = views.map((v) => v.serialize()).concat(L.views.slice(views.length));
      L.active = Math.max(0, views.indexOf(active));
      store.set('layouts', layouts); store.set('activeLayout', L.id);
      recordStates();
    }, 250);
  };

  // ------------------------------------------------------------ Shell callbacks for ChartView
  let rangeSyncing = false, crossSyncing = false;
  const linkChannel = 'BroadcastChannel' in window ? new BroadcastChannel('igc-link') : null;
  const LINK_COLORS = ['', '#ef5350', '#26a69a', '#2962ff', '#f7b924', '#c77dff'];
  const shell = {
    get drawings() { return drawings; },
    saveDrawings,
    magnetStrong: false,
    activate(v) { if (active !== v) setActive(v); },
    persist,
    onRange(v) {
      if (!L.sync.time || rangeSyncing || v !== active) return;
      rangeSyncing = true;
      const tr = v.visibleTimeRange();
      requestAnimationFrame(() => { for (const o of views) if (o !== v) o.setVisibleTimeRange(tr); rangeSyncing = false; });
    },
    onCrosshair(v, t) {
      window.IGPanels && window.IGPanels.onCrosshair(v);
      if (!L.sync.crosshair || crossSyncing || views.length < 2) return;
      crossSyncing = true;
      for (const o of views) if (o !== v) o.showCrosshairAt(t);
      crossSyncing = false;
    },
    onSymbolChanged(v) {
      if (L.sync.symbol) for (const o of views) if (o !== v) o.setSymbol(v.symbol, true);
      // tab group with "Link symbol": the other layouts in the group open on the same symbol
      if (v === active && L.group && tabGroups[L.group] && tabGroups[L.group].link) { for (const y of layouts) if (y !== L && y.group === L.group && y.views && y.views[0]) y.views[0].symbol = v.symbol; store.set('layouts', layouts); }
      if (v.state.link) { for (const o of views) if (o !== v && o.state.link === v.state.link) o.setSymbol(v.symbol, true); linkChannel && linkChannel.postMessage({ link: v.state.link, symbol: v.symbol }); }
      if (v === active) refreshToolbar();
      bus.emit('active-changed');
    },
    onIntervalChanged(v) {
      if (L.sync.interval) for (const o of views) if (o !== v) o.setInterval(v.interval, { silent: true });
      if (v === active) refreshToolbar();
    },
    onLoaded(v) { if (v === active) { refreshToolbar(); bus.emit('active-changed'); } },
    onSymbolMeta(v) { if (v === active) refreshToolbar(); window.IGPanels && window.IGPanels.refreshWatchlist(); },
    onStudiesChanged(v) { persist(); if (v === active) bus.emit('studies-changed'); window.IGPanels && window.IGPanels.refreshTree(); },
    onDrawingsChanged(v) { recordDraw(v); window.IGPanels && window.IGPanels.refreshTree(); },
    openStudyAlert: (v, u) => { setActive(v); window.IGPanels.openAlertDialog({ studyUid: u }); },
    onZoomed() { if (tgl.zoom) { tgl.zoom = false; views.forEach((o) => o.setZoomTool(false)); renderToolButtons(active && active.draw.tool); } },
    onToolChange(v, t) { renderToolButtons(t); },
    openSearch(v, mode = 'symbol') { setActive(v); openSearch(mode); },
    openStudySettings: (v, u) => { setActive(v); openStudySettings(v, u); },
    openAlert: (v, price) => { setActive(v); window.IGPanels.openAlertDialog({ price }); },
    alertLines: (sym) => (window.IGPanels ? window.IGPanels.alertLines(sym) : []),
    acOpts: () => acOpts,
    acLog: () => acLog,
    onACSignals(v, fired) {
      for (const a of fired) acLog.unshift({ at: Date.now(), epic: v.symbol, tf: v.interval, payload: a.payload });
      acLog = acLog.slice(0, 100); store.set('acLog', acLog);
      const text = fired.map((a) => (AC.describeAlert ? AC.describeAlert(a.payload) : a.payload.signal)).join('\n\n');
      const title = `AI Chance · ${v.title()} ${IV.label(v.interval)}`;
      C.beep(true);
      views.forEach((o) => o.state.ac && o.acRenderLog());
      api('/api/notify', { method: 'POST', body: { title, message: text, epic: v.symbol, price: fired[0].payload.price } }).catch(() => { toast(`${title}\n${text}`, 'alert'); });
    },
    onAutoScale(v) { if (v === active) refreshToolbar(); },
    onReplayState(v) { if (v === active) $('replayBtn').classList.toggle('active', v.rp.on || v.rp.picking); },
    onAllowance(a) { if (a && a.remaining != null) $('allowance').textContent = `History: ${a.remaining.toLocaleString()} / ${a.total?.toLocaleString() ?? '?'} pts`; },
    onBarClose(v) { window.IGPanels && window.IGPanels.onBarClose(v); },
  };
  linkChannel && (linkChannel.onmessage = (e) => { const { link, symbol } = e.data || {}; if (link) for (const o of views) if (o.state.link === link) o.setSymbol(symbol, true); });

  function mountLayout(next) {
    if (next && next.closed) next.closed = false;
    views.forEach((v) => v.destroy());
    views = []; active = null;
    L = next;
    L.sync = { symbol: false, interval: false, crosshair: true, time: false, ...(L.sync || {}) };
    store.set('activeLayout', L.id);
    const grid = $('grid'), G = GRIDS[L.grid] || GRIDS['1'];
    grid.innerHTML = '';
    grid.style.gridTemplateColumns = `repeat(${G.c}, minmax(0, 1fr))`;
    grid.style.gridTemplateRows = `repeat(${G.r}, minmax(0, 1fr))`;
    grid.classList.toggle('multi', gridN(L.grid) > 1);
    const n = gridN(L.grid);
    for (let i = 0; i < n; i++) {
      const cell = document.createElement('div');
      cell.className = 'cell';
      if (G.span && i === 0) cell.style.gridRow = 'span 2';
      grid.appendChild(cell);
      const base = L.views[i] || { ...(L.views[0] || {}), studies: [{ id: 'vol' }], compares: [], ac: false, link: 0 };
      const acAll = store.get('acAll', null);
      if (acAll !== null) base.ac = acAll;
      views.push(new C.ChartView(cell, base, shell));
    }
    setActive(views[Math.min(L.active || 0, views.length - 1)]);
    renderTabs(); refreshToolbar(); applyToolToggles();
    applyDeepLink();
    persist();
  }
  // Deep links: ?symbol=EPIC&interval=5&type=candles&scale=log&ac=1 (or the same keys in the #hash) open that chart once.
  let deepLinkDone = false;
  function applyDeepLink() {
    if (deepLinkDone || !active) return; deepLinkDone = true;
    const q = new URLSearchParams(location.search);
    new URLSearchParams(location.hash.slice(1)).forEach((v, k) => { if (!q.has(k)) q.set(k, v); });
    const sym = q.get('symbol') || q.get('epic'), iv = q.get('interval') || q.get('tf'), type = q.get('type'), scale = q.get('scale'), ac = q.get('ac');
    if (!sym && !iv && !type && !scale && ac == null) return;
    if (sym) active.setSymbol(sym);
    if (iv && !active.setInterval(iv)) toast('Link: unknown interval ' + iv);
    if (type) active.setType(type);
    if (scale && ['normal', 'log', 'percent', 'indexed'].includes(scale) && active.state.scale !== scale) active.setScale(scale);
    if (ac != null && !!+ac !== !!active.state.ac) active.setAC(!!+ac);
    history.replaceState(null, '', location.pathname + (location.hash.match(/layout=[\w-]+/) ? '#' + location.hash.match(/layout=[\w-]+/)[0] : ''));
    refreshToolbar();
  }
  function chartLink(v = active) {
    const q = new URLSearchParams({ symbol: v.state.symbol, interval: v.interval, type: v.state.type || 'candles' });
    if (v.state.scale && v.state.scale !== 'normal') q.set('scale', v.state.scale);
    if (v.state.ac) q.set('ac', '1');
    return location.origin + location.pathname + '?' + q;
  }
  function setActive(v) {
    const prev = active;
    active = v;
    views.forEach((o) => o.root.parentElement.classList.toggle('active', o === v));
    if (prev && prev !== v && window.IGPanels) window.IGPanels.moveOverlays(prev, v);
    refreshToolbar();
    persist();
    bus.emit('active-changed');
    window.IGPanels && window.IGPanels.refreshTree();
  }
  const IGApp = (window.IGApp = { get views() { return views; }, get active() { return active; }, get layout() { return L; }, modal, formField, readField, closeModals, persist, setActive, openSearch: (mode) => openSearch(mode), shell });

  // ------------------------------------------------------------ Tabs (saved layouts)
  // Tab groups: { [name]: { color, collapsed, link } }; a layout joins a group with layout.group = name.
  let tabGroups = store.get('tabGroups', {}) || {};
  const GROUP_COLORS = ['#2962ff', '#26a69a', '#ff9800', '#e91e63', '#9c27b0', '#00bcd4', '#8bc34a', '#f44336'];
  const saveGroups = () => store.set('tabGroups', tabGroups);
  const openTabs = () => layouts.filter((x) => !x.closed || x === L);
  // A layout follows its active chart's symbol until the user renames it (legacy custom names count as renamed).
  const isNamed = (x) => (x.named !== undefined ? !!x.named : !/^(Layout( \d+)?|Imported)$/.test(x.name || ''));
  function layoutTitle(x) {
    if (isNamed(x)) return x.name;
    if (x === L && active) return active.title() || x.name;
    const v = (x.views || [])[x.active || 0] || (x.views || [])[0];
    return (v && v.symbol && nameOf(v.symbol)) || x.name;
  }
  function tabHtml(x) {
    const g = x.group && tabGroups[x.group];
    return `<div class="tab${x === L ? ' on' : ''}" data-id="${x.id}" draggable="true" title="Double-click to rename · right-click for options"${g ? ` style="box-shadow: inset 0 -2px 0 ${g.color}"` : ''}><span>${esc(layoutTitle(x))}</span><small>${esc(x.grid === '1' ? '' : gridN(x.grid) + ' charts')}</small>${openTabs().length > 1 ? '<button data-act="close" title="Close tab (reopen with ⌘⇧T)">✕</button>' : ''}</div>`;
  }
  function renderTabs() {
    const seen = new Set(); let html = '';
    for (const x of openTabs()) {
      if (x.group && tabGroups[x.group]) {
        if (seen.has(x.group)) continue; seen.add(x.group);
        const g = tabGroups[x.group], members = openTabs().filter((y) => y.group === x.group);
        html += `<div class="tab-group" data-group="${esc(x.group)}" style="--gc:${g.color}" title="Click to ${g.collapsed ? 'expand' : 'collapse'} · right-click for group options">${esc(x.group)}${g.link ? ' 🔗' : ''}${g.collapsed ? ` <small>${members.length}</small>` : ''}</div>`;
        if (!g.collapsed || members.includes(L)) html += members.filter((y) => !g.collapsed || y === L).map(tabHtml).join('');
      } else html += tabHtml(x);
    }
    $('tabbar').innerHTML = html
      + `<button class="tab-add" data-act="new" title="New layout (max 10)">＋</button><div class="spacer"></div><button class="tab-add" data-act="window" title="Open this layout in a new window (multi-monitor)">⧉</button>`;
    $('layoutName').textContent = layoutTitle(L);
  }
  $('tabbar').addEventListener('click', (e) => {
    const act = e.target.closest('[data-act]')?.dataset.act, tab = e.target.closest('.tab');
    if (act === 'new') return newLayout();
    if (act === 'window') { persist(); setTimeout(() => window.open(`${location.pathname}#layout=${L.id}`, '_blank', 'popup,width=1400,height=900'), 300); return; }
    if (act === 'close' && tab) { closeTab(layouts.find((y) => y.id === tab.dataset.id)); return; }
    const gc = e.target.closest('.tab-group');
    if (gc) { const g = tabGroups[gc.dataset.group]; if (g) { g.collapsed = !g.collapsed; saveGroups(); renderTabs(); } return; }
    if (tab && tab.dataset.id !== L.id) { persist(); setTimeout(() => mountLayout(layouts.find((y) => y.id === tab.dataset.id)), 260); }
  });
  $('tabbar').addEventListener('dblclick', (e) => { const tab = e.target.closest('.tab'); if (tab) renameLayout(layouts.find((y) => y.id === tab.dataset.id)); });
  const closedStack = [];
  function closeTab(x) {
    if (!x) return;
    if (openTabs().length < 2) return toast('Keep at least one tab open');
    persist(); x.closed = true; closedStack.push(x.id); store.set('layouts', layouts);
    if (x === L) { const next = openTabs().find((y) => y !== x); setTimeout(() => mountLayout(next), 200); } else renderTabs();
    toast(`Closed "${layoutTitle(x)}" · ⌘⇧T to reopen`);
  }
  function reopenTab(x) {
    x = x || layouts.find((y) => y.id === closedStack.pop() && y.closed) || layouts.filter((y) => y.closed).pop();
    if (!x) return toast('No closed tabs');
    x.closed = false; store.set('layouts', layouts); persist(); setTimeout(() => mountLayout(x), 200);
  }
  function deleteLayout(x) {
    if (!x || !confirm(`Delete layout "${layoutTitle(x)}" permanently?`)) return;
    if (layouts.length < 2) return toast('Keep at least one layout');
    layouts = layouts.filter((y) => y !== x); store.set('layouts', layouts);
    if (x === L) mountLayout(openTabs()[0] || layouts[0]); else renderTabs();
  }
  function setGroup(x, name) {
    if (!name) { delete x.group; }
    else { if (!tabGroups[name]) tabGroups[name] = { color: GROUP_COLORS[Object.keys(tabGroups).length % GROUP_COLORS.length], collapsed: false, link: false }; x.group = name; }
    for (const k of Object.keys(tabGroups)) if (!layouts.some((y) => y.group === k)) delete tabGroups[k];
    // keep group members next to each other
    if (name) { const first = layouts.findIndex((y) => y.group === name && y !== x); if (first >= 0) { layouts.splice(layouts.indexOf(x), 1); layouts.splice(layouts.indexOf(layouts.filter((y) => y.group === name).pop()) + 1, 0, x); } }
    saveGroups(); store.set('layouts', layouts); renderTabs();
  }
  // right-click menu for tabs and group chips
  $('tabbar').addEventListener('contextmenu', (e) => {
    const tab = e.target.closest('.tab'), gc = e.target.closest('.tab-group');
    if (!tab && !gc) return;
    e.preventDefault();
    let m = $('tabMenu'); if (!m) { m = document.createElement('div'); m.id = 'tabMenu'; m.className = 'dd-menu hidden'; document.body.appendChild(m); }
    if (tab) {
      const x = layouts.find((y) => y.id === tab.dataset.id), groups = Object.keys(tabGroups);
      m.innerHTML = `<button data-t="rename">Rename…</button><button data-t="dup">Duplicate</button><button data-t="window">Open in new window</button><div class="dd-sep"></div><div class="dd-h">Tab group</div>${groups.map((g) => `<button data-t="group" data-g="${esc(g)}" class="${x.group === g ? 'active' : ''}"><span style="color:${tabGroups[g].color}">●</span> ${esc(g)}</button>`).join('')}<button data-t="newgroup">New group…</button>${x.group ? '<button data-t="ungroup">Remove from group</button>' : ''}<div class="dd-sep"></div><button data-t="close">Close tab</button><button data-t="others">Close other tabs</button><button data-t="reopen">Reopen closed tab ⌘⇧T</button><button data-t="delete" class="danger">Delete layout…</button>`;
      m.onclick = (ev) => {
        const b = ev.target.closest('button'); if (!b) return; hideMenus();
        const t = b.dataset.t;
        if (t === 'rename') renameLayout(x);
        if (t === 'dup') { if (x !== L) { persist(); mountLayout(x); } setTimeout(() => newLayout(true), 300); }
        if (t === 'window') { persist(); setTimeout(() => window.open(`${location.pathname}#layout=${x.id}`, '_blank', 'popup,width=1400,height=900'), 300); }
        if (t === 'group') setGroup(x, b.dataset.g);
        if (t === 'newgroup') { const n = (prompt('Group name', 'Group ' + (groups.length + 1)) || '').trim().slice(0, 30); if (n) setGroup(x, n); }
        if (t === 'ungroup') setGroup(x, null);
        if (t === 'close') closeTab(x);
        if (t === 'others') { persist(); for (const y of layouts) if (y !== x) y.closed = true; x.closed = false; store.set('layouts', layouts); if (x !== L) setTimeout(() => mountLayout(x), 200); else renderTabs(); }
        if (t === 'reopen') reopenTab();
        if (t === 'delete') deleteLayout(x);
      };
    } else {
      const name = gc.dataset.group, g = tabGroups[name];
      m.innerHTML = `<button data-t="link">${g.link ? '☑' : '☐'} Link symbol across this group</button><button data-t="rename">Rename group…</button><div class="dd-h">Colour</div><div class="tg-colors">${GROUP_COLORS.map((c) => `<button data-t="color" data-c="${c}" style="background:${c}" title="${c}"></button>`).join('')}</div><div class="dd-sep"></div><button data-t="closeall">Close group</button><button data-t="ungroup">Ungroup</button>`;
      m.onclick = (ev) => {
        const b = ev.target.closest('button'); if (!b) return; hideMenus();
        const t = b.dataset.t, members = layouts.filter((y) => y.group === name);
        if (t === 'link') { g.link = !g.link; saveGroups(); renderTabs(); }
        if (t === 'color') { g.color = b.dataset.c; saveGroups(); renderTabs(); }
        if (t === 'rename') { const n = (prompt('Group name', name) || '').trim().slice(0, 30); if (n && n !== name && !tabGroups[n]) { tabGroups[n] = g; delete tabGroups[name]; members.forEach((y) => (y.group = n)); saveGroups(); store.set('layouts', layouts); renderTabs(); } }
        if (t === 'ungroup') { members.forEach((y) => delete y.group); delete tabGroups[name]; saveGroups(); store.set('layouts', layouts); renderTabs(); }
        if (t === 'closeall') { const keep = openTabs().filter((y) => y.group !== name); if (!keep.length) return toast('Keep at least one tab open'); persist(); members.forEach((y) => { y.closed = true; closedStack.push(y.id); }); store.set('layouts', layouts); if (members.includes(L)) setTimeout(() => mountLayout(keep[0]), 200); else renderTabs(); }
      };
    }
    m.style.left = e.clientX + 'px'; m.style.top = e.clientY + 'px'; m.style.position = 'fixed';
    toggleMenu('tabMenu', true);
  });
  // drag to reorder tabs
  let dragId = null;
  $('tabbar').addEventListener('dragstart', (e) => { const tab = e.target.closest('.tab'); if (!tab) return; dragId = tab.dataset.id; e.dataTransfer.effectAllowed = 'move'; });
  $('tabbar').addEventListener('dragover', (e) => { if (dragId) { e.preventDefault(); } });
  $('tabbar').addEventListener('drop', (e) => {
    e.preventDefault(); const tab = e.target.closest('.tab'); if (!dragId || !tab || tab.dataset.id === dragId) return (dragId = null);
    const a = layouts.find((y) => y.id === dragId), b = layouts.find((y) => y.id === tab.dataset.id);
    layouts.splice(layouts.indexOf(a), 1);
    const r = tab.getBoundingClientRect(), after = e.clientX > r.left + r.width / 2;
    layouts.splice(layouts.indexOf(b) + (after ? 1 : 0), 0, a);
    if (b.group !== a.group) { if (b.group) a.group = b.group; else delete a.group; }
    dragId = null; store.set('layouts', layouts); renderTabs();
  });
  function newLayout(copy) {
    if (layouts.length >= 10) return toast('Up to 10 saved layouts');
    persist();
    const src = copy ? JSON.parse(JSON.stringify(L)) : { grid: '1', views: [{ ...active.serialize(), studies: [{ id: 'vol' }], compares: [], ac: store.get('acAll', false) }], sync: { ...L.sync } };
    const x = { ...src, id: uid(), name: copy ? `${layoutTitle(L)} (copy)` : `Layout ${layouts.length + 1}`, named: copy && isNamed(L), active: 0 };
    layouts.push(x); store.set('layouts', layouts);
    setTimeout(() => mountLayout(x), 260);
  }
  function renameLayout(x) {
    if (!x) return;
    const m = modal('renameModal', 'Rename layout', `<form class="ac-form" id="renameForm">${formField({ k: 'name', label: 'Name (leave empty to follow the chart symbol)', type: 'text' }, isNamed(x) ? x.name : '')}</form>`, '<button data-close>Cancel</button><button class="primary" id="renameOk">Save</button>', 'small');
    const go = (e) => { e && e.preventDefault(); const nv = m.querySelector('[name=name]').value.trim(); x.named = !!nv; if (nv) x.name = nv; store.set('layouts', layouts); renderTabs(); closeModals(); };
    m.querySelector('#renameOk').onclick = go; m.querySelector('form').onsubmit = go;
    setTimeout(() => m.querySelector('[name=name]').select(), 0);
  }
  $('layoutsBtn').onclick = () => {
    const menu = $('layoutsMenu');
    menu.innerHTML = `<div class="dd-h">Layouts</div>${layouts.map((x) => `<button data-id="${x.id}" class="${x === L ? 'active' : ''}">${esc(layoutTitle(x))} <small class="muted">${gridN(x.grid)} chart${gridN(x.grid) > 1 ? 's' : ''}${x.closed ? ' · closed' : ''}</small></button>`).join('')}
      <div class="dd-sep"></div><button data-act="rename">Rename…</button><button data-act="copy">Make a copy</button><button data-act="new">New layout</button>
      <button data-act="export">Export layout file</button><button data-act="import">Import layout file…</button>
      <div class="dd-sep"></div><div class="dd-h">Sync in layout</div>
      ${[['symbol', 'Symbol'], ['interval', 'Interval'], ['crosshair', 'Crosshair'], ['time', 'Time / scroll']].map(([k, l]) => `<button data-sync="${k}" class="${L.sync[k] ? 'active' : ''}">${L.sync[k] ? '☑' : '☐'} ${l}</button>`).join('')}`;
    toggleMenu('layoutsMenu');
  };
  $('layoutsMenu').onclick = (e) => {
    const b = e.target.closest('button'); if (!b) return;
    if (b.dataset.id && b.dataset.id !== L.id) { persist(); hideMenus(); setTimeout(() => mountLayout(layouts.find((y) => y.id === b.dataset.id)), 260); return; }
    if (b.dataset.sync) { L.sync[b.dataset.sync] = !L.sync[b.dataset.sync]; persist(); $('layoutsBtn').onclick(); toggleMenu('layoutsMenu', true); return; }
    hideMenus();
    const act = b.dataset.act;
    if (act === 'rename') renameLayout(L);
    if (act === 'copy') newLayout(true);
    if (act === 'new') newLayout(false);
    if (act === 'export') { persist(); setTimeout(() => download(`${layoutTitle(L).replace(/[^\w.-]+/g, '_')}.igchart.json`, JSON.stringify({ layout: L, drawings: Object.fromEntries(Object.entries(drawings).filter(([k]) => L.views.some((v) => v.symbol === k))) }, null, 1), 'application/json'), 300); }
    if (act === 'import') {
      const inp = document.createElement('input'); inp.type = 'file'; inp.accept = '.json';
      inp.onchange = async () => {
        try {
          const j = JSON.parse(await inp.files[0].text());
          const x = { ...j.layout, id: uid(), name: `${j.layout.name || 'Imported'}` };
          for (const [k, list] of Object.entries(j.drawings || {})) drawings[k] = [...(drawings[k] || []), ...list.filter((d) => !(drawings[k] || []).some((e) => e.id === d.id))];
          saveDrawings(); layouts.push(x); store.set('layouts', layouts); mountLayout(x);
        } catch (err) { toast(`Import failed: ${err.message}`); }
      };
      inp.click();
    }
  };

  // ------------------------------------------------------------ Grid picker
  $('gridMenu').innerHTML = `<div class="dd-h">Charts in this layout</div><div class="grid-picks">${Object.keys(GRIDS).map((g) => `<button data-grid="${g}" title="${gridN(g)} chart${gridN(g) > 1 ? 's' : ''}">${gridIcon(g)}</button>`).join('')}</div>`;
  $('gridBtn').onclick = () => toggleMenu('gridMenu');
  $('gridMenu').onclick = (e) => {
    const b = e.target.closest('[data-grid]'); if (!b) return;
    hideMenus();
    L.views = views.map((v) => v.serialize()).concat(L.views.slice(views.length));
    L.grid = b.dataset.grid; L.active = Math.min(views.indexOf(active), gridN(L.grid) - 1);
    mountLayout(L);
  };

  // ------------------------------------------------------------ Dropdown helpers
  function hideMenus(except) { document.querySelectorAll('.dd-menu').forEach((m) => { if (m.id !== except) m.classList.add('hidden'); }); }
  function toggleMenu(id, keep) { hideMenus(id); const m = $(id); if (keep) m.classList.remove('hidden'); else m.classList.toggle('hidden'); }
  document.addEventListener('mousedown', (e) => { if (!e.target.closest('.dd')) hideMenus(); if (!e.target.closest('.lefttools')) document.querySelectorAll('.lt-fly').forEach((f) => f.classList.add('hidden')); });

  // ------------------------------------------------------------ Intervals
  const IV_GROUPS = [
    ['Seconds', ['1S', '5S', '10S', '15S', '30S', '45S']],
    ['Minutes', ['1', '2', '3', '5', '10', '15', '30', '45']],
    ['Hours', ['60', '120', '180', '240']],
    ['Days', ['1D', '1W', '1M', '3M', '6M', '12M']],
    ['Ticks', ['1T', '10T', '100T', '1000T']],
    ['Ranges', ['1R', '10R', '100R', '1000R']],
  ];
  let ivFavs = store.get('ivFavs', ['1', '5', '15', '60', '240', '1D', '1W']);
  let ivCustom = store.get('ivCustom', []);
  function renderIvFav() {
    const cur = active ? active.interval : '';
    $('ivFav').innerHTML = ivFavs.map((x) => `<button data-iv="${esc(x)}" class="${IV.parse(x) && IV.label(x) === IV.label(cur) ? 'active' : ''}">${esc(IV.label(x))}</button>`).join('')
      + (cur && !ivFavs.some((x) => IV.label(x) === IV.label(cur)) ? `<button class="active" data-iv="${esc(cur)}">${esc(IV.label(cur))}</button>` : '');
  }
  function renderIvMenu() {
    const groups = [...IV_GROUPS, ...(ivCustom.length ? [['Custom', ivCustom]] : [])];
    $('ivMenu').innerHTML = `<form id="ivCustomForm" class="iv-custom"><input placeholder="Custom: 7, 90, 2H, 3D, 500T, 25R" id="ivCustomIn"><button>Add</button></form>` + groups.map(([h, list]) => `<div class="dd-h">${h}</div><div class="iv-row">${list.map((x) => `<span class="iv-item"><button data-iv="${esc(x)}" class="${active && IV.label(x) === IV.label(active.interval) ? 'active' : ''}">${esc(IV.label(x))}</button><button class="star${ivFavs.includes(x) ? ' on' : ''}" data-fav="${esc(x)}" title="Add to favourites">★</button></span>`).join('')}</div>`).join('')
      + '<div class="dd-note muted">Seconds use IG 1-second history. Tick and range bars are built from 1-minute history and live ticks (IG has no tick history).</div>';
    $('ivCustomForm').onsubmit = (e) => {
      e.preventDefault();
      const v = $('ivCustomIn').value.trim();
      if (!IV.parse(v)) return toast('Try 7, 90, 2H, 3D, 2W, 3M, 500T or 25R');
      if (!ivCustom.includes(v)) { ivCustom.push(v); store.set('ivCustom', ivCustom); }
      setIv(v); hideMenus();
    };
  }
  function setIv(x, opts) { if (!active) return; if (!active.setInterval(x, opts)) toast('Unknown interval'); renderIvFav(); }
  $('ivFav').onclick = (e) => { const b = e.target.closest('[data-iv]'); if (b) setIv(b.dataset.iv); };
  $('ivBtn').onclick = () => { renderIvMenu(); toggleMenu('ivMenu'); };
  $('ivMenu').onclick = (e) => {
    const f = e.target.closest('[data-fav]');
    if (f) { const x = f.dataset.fav; ivFavs = ivFavs.includes(x) ? ivFavs.filter((y) => y !== x) : [...ivFavs, x]; store.set('ivFavs', ivFavs); renderIvMenu(); renderIvFav(); return; }
    const b = e.target.closest('[data-iv]'); if (b) { setIv(b.dataset.iv); hideMenus(); }
  };

  // ------------------------------------------------------------ Chart types
  const CHART_TYPES = TY.CHART_TYPES || [{ id: 'candles', label: 'Candles', group: 'Standard', icon: 'M5 3v12M4 6h2v6H4zM12 2v13M11 5h2v7h-2z', opts: [] }];
  function renderTypeMenu() {
    const groups = [...new Set(CHART_TYPES.map((t) => t.group))];
    $('typeMenu').innerHTML = groups.map((g) => `<div class="dd-h">${esc(g)}</div>${CHART_TYPES.filter((t) => t.group === g).map((t) => `<div class="dd-row"><button data-type="${t.id}" class="${active && active.state.type === t.id ? 'active' : ''}"><svg class="ico" viewBox="0 0 18 18"><path d="${t.icon}"/></svg>${esc(t.label)}</button>${(t.opts || []).length ? `<button class="dd-gear" data-typeset="${t.id}" title="${esc(t.label)} settings">⚙</button>` : ''}</div>`).join('')}`).join('');
  }
  $('typeBtn').onclick = () => { renderTypeMenu(); toggleMenu('typeMenu'); };
  $('sideMenu').innerHTML = '<div class="dd-h">Price data</div><button data-side="mid">Mid (bid/ask average)</button><button data-side="bid">Bid</button><button data-side="ask">Ask</button>';
  $('sideBtn').onclick = () => toggleMenu('sideMenu');
  $('sideMenu').onclick = (e) => { const b = e.target.closest('[data-side]'); if (!b || !active) return; hideMenus(); active.setSide(b.dataset.side); refreshToolbar(); };
  $('typeMenu').onclick = (e) => {
    const s = e.target.closest('[data-typeset]');
    if (s) { hideMenus(); return openTypeSettings(s.dataset.typeset); }
    const b = e.target.closest('[data-type]'); if (!b || !active) return;
    hideMenus(); active.setType(b.dataset.type); refreshToolbar();
  };
  function openTypeSettings(id) {
    const t = CHART_TYPES.find((x) => x.id === id); if (!t || !active) return;
    const cur = { ...(TY.defaults ? TY.defaults(id) : {}), ...((active.state.typeOpts || {})[id] || {}) };
    const m = modal('typeModal', `${esc(t.label)} settings`, `<form class="ac-form">${t.opts.map((o) => formField({ ...o, type: o.type === 'select' || o.options ? 'select' : o.type }, cur[o.k] ?? o.def)).join('')}</form>`, '<button data-close class="primary">Done</button>', 'small');
    m.querySelector('form').addEventListener('input', (e) => { const o = t.opts.find((x) => x.k === e.target.name); if (!o) return; cur[o.k] = readField(o, e.target); active.setType(id, { ...cur }); refreshToolbar(); });
  }

  // ------------------------------------------------------------ Toolbar state
  function refreshToolbar() {
    if (!active) return;
    $('symName').textContent = active.title() || 'Symbol';
    if (!isNamed(L)) renderTabs();
    document.title = `${active.title() || 'IG Charts'} · ${IV.label(active.interval)} · IG Charts`;
    const t = CHART_TYPES.find((x) => x.id === active.state.type) || CHART_TYPES[0];
    $('typeBtn').innerHTML = `<svg class="ico" viewBox="0 0 18 18"><path d="${t.icon}"/></svg>`;
    $('typeBtn').title = `Chart type: ${t.label}`;
    $('gridBtn').innerHTML = gridIcon(L.grid);
    $('acToggle').classList.toggle('active', !!active.state.ac);
    $('replayBtn').classList.toggle('active', active.rp.on || active.rp.picking);
    document.querySelectorAll('#scaleGroup [data-scale]').forEach((b) => b.classList.toggle('active', b.dataset.scale === 'lock' ? !!active.state.lockRatio : b.dataset.scale === 'priceonly' ? !!active.state.scalePriceOnly : b.dataset.scale === 'invert' ? !!active.state.invert : b.dataset.scale === 'auto' ? active.isAutoScale() : b.dataset.scale === active.state.scale));
    document.querySelectorAll('#sideMenu [data-side]').forEach((b) => b.classList.toggle('active', b.dataset.side === (active.state.side || 'mid')));
    $('sideBtn').textContent = { mid: 'Mid', bid: 'Bid', ask: 'Ask' }[active.state.side || 'mid'];
    renderIvFav();
  }

  // ------------------------------------------------------------ Symbol search (symbol / compare / watchlist modes)
  let searchMode = 'symbol', searchTimer, searchSel = -1;
  function openSearch(mode = 'symbol', prefill = '') {
    searchMode = mode;
    const title = { symbol: 'Symbol search', compare: 'Compare symbol', watchlist: 'Add to watchlist', alert: 'Alert symbol' }[mode] || 'Symbol search';
    const m = modal('searchModal', title, `<div class="ind-search"><input id="searchIn" placeholder="Name, epic, or a formula like MOCK.GOLD/MOCK.BTC*100" autocomplete="off" spellcheck="false"></div><div id="searchList" class="ind-list"></div>`, '', 'search-card');
    const inp = m.querySelector('#searchIn');
    inp.value = prefill;
    inp.oninput = () => runSearch(inp.value.trim());
    inp.onkeydown = (e) => {
      const items = [...m.querySelectorAll('.ind-item')];
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); searchSel = (searchSel + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % Math.max(1, items.length); items.forEach((x, i) => x.classList.toggle('sel', i === searchSel)); }
      if (e.key === 'Enter') { e.preventDefault(); (items[searchSel] || items[0])?.click(); }
    };
    m.querySelector('#searchList').onclick = (e) => { const it = e.target.closest('.ind-item[data-epic]'); if (it) pickSymbol(it.dataset.epic, it.dataset.name); };
    runSearch(prefill);
    setTimeout(() => { inp.focus(); inp.setSelectionRange(inp.value.length, inp.value.length); }, 0);
  }
  function runSearch(q) {
    clearTimeout(searchTimer);
    const box = $('searchList');
    searchSel = -1;
    const recent = store.get('recentSymbols', []);
    if (q.length < 2) { box.innerHTML = recent.length ? `<div class="ind-h">Recent</div>${recent.map((e) => `<div class="ind-item" data-epic="${esc(e)}"><span>${esc(nameOf(e))}</span><small>${esc(e)}</small></div>`).join('')}` : '<div class="ind-h">Type at least 2 characters</div>'; return; }
    let head = '';
    if (IV.isExpr(q)) { try { IV.compileExpr(q); head = `<div class="ind-h">Spread / formula chart</div><div class="ind-item" data-epic="${esc(q.replace(/\s+/g, ''))}"><span>${esc(q)}</span><small>formula</small></div>`; } catch (e) { head = `<div class="ind-h">${esc(e.message)}</div>`; } box.innerHTML = head; return; }
    box.innerHTML = '<div class="ind-h">Searching…</div>';
    searchTimer = setTimeout(async () => {
      try {
        const list = await api(`/api/search?q=${encodeURIComponent(q)}`);
        box.innerHTML = (list.length ? '' : '<div class="ind-h">No markets found</div>') + list.slice(0, 40).map((m) => `<div class="ind-item" data-epic="${esc(m.epic)}" data-name="${esc(m.name)}"><span>${esc(m.name)}${m.expiry && m.expiry !== '-' ? ` <small>(${esc(m.expiry)})</small>` : ''}</span><small>${esc(m.type || '')} · ${esc(m.epic)}</small></div>`).join('');
      } catch (err) { box.innerHTML = `<div class="ind-h">${esc(err.message)}</div>`; }
    }, 250);
  }
  function pickSymbol(epic, name) {
    if (name) C.setName(epic, name);
    closeModals();
    if (!IV.isExpr(epic)) { const rec = [epic, ...store.get('recentSymbols', []).filter((e) => e !== epic)].slice(0, 12); store.set('recentSymbols', rec); }
    if (searchMode === 'compare') return active.addCompare(epic);
    if (searchMode === 'watchlist') return window.IGPanels.addToWatchlist(epic);
    if (!IV.isExpr(epic)) window.IGPanels.addToWatchlist(epic, true);
    active.setSymbol(epic);
    refreshToolbar();
  }
  $('symBtn').onclick = () => openSearch('symbol');
  $('cmpBtn').onclick = () => openSearch('compare');

  // ------------------------------------------------------------ Indicators dialog, templates, settings
  let indCat = 'All';
  let indFavs = store.get('indFavs', []);
  function openIndicators() {
    const cats = ['Favorites', 'All', ...[...new Set(IND.DEFS.map((d) => d.category || 'Other'))].sort()];
    const m = modal('indModal', 'Indicators, metrics & strategies', `<div class="ind-wrap"><div class="ind-cats" id="indCats">${cats.map((c) => `<button data-cat="${esc(c)}" class="${c === indCat ? 'active' : ''}">${esc(c)}</button>`).join('')}<div class="ind-cats-note muted">${IND.DEFS.length} built-in · up to 50 per chart</div></div>
      <div class="ind-main"><div class="ind-search"><input id="indSearch" placeholder="Search" autocomplete="off"></div><div id="indList" class="ind-list"></div></div></div>`, '', 'wide');
    m.querySelector('#indCats').onclick = (e) => { const b = e.target.closest('[data-cat]'); if (!b) return; indCat = b.dataset.cat; m.querySelectorAll('#indCats [data-cat]').forEach((x) => x.classList.toggle('active', x === b)); renderIndList(); };
    m.querySelector('#indSearch').oninput = renderIndList;
    m.querySelector('#indList').onclick = (e) => {
      const fav = e.target.closest('[data-fav]');
      if (fav) { const id = fav.dataset.fav; indFavs = indFavs.includes(id) ? indFavs.filter((x) => x !== id) : [...indFavs, id]; store.set('indFavs', indFavs); return renderIndList(); }
      const on = e.target.closest('.ind-item.on');
      if (on) { if (e.target.dataset.act === 'del') { active.removeStudy(on.dataset.uid); renderIndList(); } if (e.target.dataset.act === 'set') { closeModals(); openStudySettings(active, on.dataset.uid); } return; }
      const it = e.target.closest('.ind-item[data-id]');
      if (it && active.addStudy(it.dataset.id)) { toast(`Added ${IND.BY_ID[it.dataset.id].name}`); renderIndList(); }
    };
    renderIndList();
    setTimeout(() => m.querySelector('#indSearch').focus(), 0);
  }
  function renderIndList() {
    const q = ($('indSearch')?.value || '').trim().toLowerCase();
    const match = (d) => (!q || d.name.toLowerCase().includes(q) || (d.short || '').toLowerCase().includes(q)) && (indCat === 'All' || q || (indCat === 'Favorites' ? indFavs.includes(d.id) : (d.category || 'Other') === indCat));
    const onChart = active.state.studies.map((s) => { const d = IND.BY_ID[s.id]; return d ? `<div class="ind-item on" data-uid="${s.uid}"><span>${esc(IND.title(d, s.params))}${s.tf ? ` <small>${esc(IV.label(s.tf))}</small>` : ''}</span><small>${esc(d.name)}</small><button data-act="set">⚙</button><button data-act="del">✕</button></div>` : ''; }).join('');
    const items = IND.DEFS.filter(match);
    $('indList').innerHTML = (onChart && !q ? `<div class="ind-h">On this chart (${active.state.studies.length}/50)</div>${onChart}` : '')
      + `<div class="ind-h">${esc(q ? 'Results' : indCat)}</div>`
      + (items.length ? items.map((d) => `<div class="ind-item" data-id="${esc(d.id)}"><button class="star${indFavs.includes(d.id) ? ' on' : ''}" data-fav="${esc(d.id)}" title="Favourite">★</button><span>${esc(d.name)}</span><small>${esc(d.category || '')} · ${d.kind === 'pane' ? 'pane' : 'on chart'}</small></div>`).join('') : '<div class="muted ind-empty">Nothing here yet.</div>');
  }
  $('indBtn').onclick = openIndicators;

  function openStudySettings(v, u) {
    const st = v.state.studies.find((s) => s.uid === u); if (!st) return;
    const def = IND.BY_ID[st.id]; if (!def) return;
    const params = def.params.map((p) => {
      if (p.type === 'source') return formField({ ...p, type: 'select', options: v.sourceOptions(u) }, st.params[p.k]);
      return formField(p, st.params[p.k]);
    }).join('');
    const tfOpts = [['', 'Chart'], ...['1', '5', '15', '30', '60', '240', '1D', '1W', '1M'].map((x) => [x, IV.label(x)])];
    const styles = (def.outputs || []).map((o) => `<label><span>${esc(o.label)}</span><span class="style-row"><input type="color" name="color:${esc(o.k)}" value="${esc(v.outColor(st, o))}">${o.type !== 'histogram' ? `<select name="width:${esc(o.k)}">${[1, 2, 3, 4].map((w) => `<option ${w === v.outWidth(st, o) ? 'selected' : ''}>${w}</option>`).join('')}</select>` : ''}</span></label>`).join('');
    const m = modal('studyModal', esc(def.name), `<form class="ac-form" id="studyForm">${params ? `<fieldset><legend>Inputs</legend>${params}</fieldset>` : ''}
      <fieldset><legend>Timeframe</legend>${formField({ k: '__tf', label: 'Calculate on', type: 'select', options: tfOpts, tip: 'Multi-timeframe: compute on a higher interval and step it onto this chart.' }, st.tf || '')}</fieldset>
      <fieldset><legend>Style</legend>${styles}</fieldset></form>`, '<button id="studyDefaults">Defaults</button><button id="studyAlert">Add alert…</button><button data-close class="primary">Done</button>');
    m.querySelector('#studyForm').addEventListener('input', (e) => {
      const name = e.target.name;
      if (name === '__tf') return v.updateStudy(u, { tf: e.target.value });
      if (name.startsWith('color:') || name.startsWith('width:')) {
        const [kind, k] = name.split(':');
        st.styles[k] = { ...(st.styles[k] || {}), [kind]: kind === 'width' ? Number(e.target.value) : e.target.value };
        return v.updateStudy(u, { styles: st.styles });
      }
      const p = def.params.find((x) => x.k === name); if (!p) return;
      let val = readField(p.type === 'source' ? { ...p, type: 'select' } : p, e.target);
      if (p.type === 'int') val = Math.max(p.min ?? 0, Math.min(p.max ?? 1e6, Math.round(val) || p.def));
      v.updateStudy(u, { params: { ...st.params, [name]: val } });
    });
    m.querySelector('#studyDefaults').onclick = () => { v.updateStudy(u, { params: IND.defaults(def), styles: {}, tf: '' }); openStudySettings(v, u); };
    m.querySelector('#studyAlert').onclick = () => { closeModals(); window.IGPanels.openAlertDialog({ studyUid: u }); };
  }

  // indicator templates
  const tplList = () => store.get('indTemplates', []);
  $('tplBtn').onclick = () => {
    const list = tplList();
    $('tplMenu').innerHTML = `<button data-act="save">Save current indicators as template…</button><div class="dd-sep"></div>${list.length ? list.map((t, i) => `<div class="dd-row"><button data-apply="${i}">${esc(t.name)} <small class="muted">${t.studies.length}</small></button><button class="dd-gear" data-del="${i}" title="Delete">✕</button></div>`).join('') : '<div class="dd-note muted">No templates yet</div>'}`;
    toggleMenu('tplMenu');
  };
  $('tplMenu').onclick = (e) => {
    const b = e.target.closest('button'); if (!b) return;
    const list = tplList();
    if (b.dataset.del) { list.splice(Number(b.dataset.del), 1); store.set('indTemplates', list); $('tplBtn').onclick(); toggleMenu('tplMenu', true); return; }
    hideMenus();
    if (b.dataset.apply) { const t = list[Number(b.dataset.apply)]; active.clearStudies(); for (const s of t.studies) { const st = active.addStudy(s.id, s.params, { tf: s.tf }); if (st && s.styles) active.updateStudy(st.uid, { styles: s.styles }); } toast(`Applied template "${t.name}"`); return; }
    if (b.dataset.act === 'save') {
      const m = modal('tplModal', 'Save indicator template', `<form class="ac-form">${formField({ k: 'name', label: 'Template name', type: 'text' }, '')}</form>`, '<button data-close>Cancel</button><button class="primary" id="tplOk">Save</button>', 'small');
      const go = (ev) => { ev && ev.preventDefault(); const name = m.querySelector('[name=name]').value.trim(); if (!name) return; list.push({ name, studies: active.state.studies.map(({ id, params, styles, tf }) => ({ id, params, styles, tf })) }); store.set('indTemplates', list); closeModals(); toast('Template saved'); };
      m.querySelector('#tplOk').onclick = go; m.querySelector('form').onsubmit = go;
      setTimeout(() => m.querySelector('[name=name]').focus(), 0);
    }
  };

  // ------------------------------------------------------------ AI Chance settings
  const AUTO = (vals) => ['Auto', ...vals];
  const AC_SCHEMA = [
    { group: '⚙️ Symbol & Auto Settings', fields: [
      { k: 'symbolMode', label: 'Symbol Mode', options: ['Auto', 'Metals (XAUUSD)', 'Crypto (BTCUSD)'], tip: 'Auto detects BTC/ETH/XRP as Crypto, everything else as Metals.' },
      { k: 'cooldown', label: 'Enter Cooldown', options: AUTO(['3', '5', '8', '10', '15', '20']), tip: 'Auto = 25min scaled to chart TF.' },
      { k: 'expire', label: 'Confirm Expire', options: AUTO(['5', '10', '15', '20', '30']), tip: 'Auto = 50min scaled to chart TF.' },
      { k: 'swBars', label: 'Sideways Lookback', options: AUTO(['6', '8', '12', '16', '20', '24']), tip: 'Auto = 1 hour scaled to chart TF.' },
      { k: 'tlTimeout', label: 'TL Timeout', options: AUTO(['10', '15', '20', '25', '30', '40']), tip: 'Auto = 100min scaled to chart TF.' },
      { k: 'tpAtr', label: 'Short Trade TP ATR', options: AUTO(['0.5', '0.75', '1.0', '1.25', '1.5', '2.0']), tip: 'Auto = 1.0x Metals / 1.5x Crypto.' },
      { k: 'slAtr', label: 'Short Trade SL ATR', options: AUTO(['0.25', '0.5', '0.75', '1.0', '1.25']), tip: 'Auto = 0.75x Metals / 0.5x Crypto.' },
      { k: 'htf1', label: 'HTF 1', options: AUTO(['5', '15', '60', '240']), tip: 'Auto = 15m for all symbols.', htf: true },
      { k: 'htf2', label: 'HTF 2', options: AUTO(['15', '60', '240', 'D']), tip: 'Auto = 1h Metals / 4h Crypto.', htf: true },
      { k: 'sessionTz', label: 'Session timezone', options: ['Auto', 'America/New_York', 'UTC', 'Europe/London', 'Asia/Singapore', 'Local'], tip: 'Day reset for C1/C2/VWAP. Auto = New York for Metals, UTC for Crypto.' },
    ] },
    { group: 'General', fields: [{ k: 'momentumThresh', label: 'Momentum Threshold', type: 'number', step: 0.1 }] },
    { group: 'Display', fields: [{ k: 'showSideways', label: 'Show Sideways Label', type: 'bool' }, { k: 'showPl', label: 'Show PL EMA(25)', type: 'bool' }, { k: 'showA5', label: 'Show A5 TMA(open,50)', type: 'bool' }, { k: 'showC1', label: 'Show C1 Session SMA', type: 'bool' }, { k: 'showC2', label: 'Show C2 Session SMA hlc3', type: 'bool' }] },
    { group: 'Show / hide (reduce clutter)', fields: [
      { k: 'showCards', label: 'Bias / projection cards', type: 'bool' },
      { k: 'showUml', label: 'UML band (grey upper / lower, green-red middle)', type: 'bool', tip: 'Centered TMA bands; defaults match TAD Market Navigator. The newest bars repaint as new bars arrive (centered average). Settings in the UML Band group below.' },
      { k: 'showUmlAsOf', label: 'STMN trigger band (dotted orange)', type: 'bool', tip: 'The as-of-bar band STMN actually fires on. It differs from the drawn UML band on past bars because the drawn band uses future bars. Hiding it does not change the signals.' },
      { k: 'showTma', label: 'TMA bands (grey envelope around A5)', type: 'bool', tip: 'The Pine script only shows these in the data window; turn on to draw them.' },
      { k: 'showAcExtras', label: 'Data window & signals boxes', type: 'bool' },
      { k: 'showAcLines', label: 'TL / TP / SL price lines', type: 'bool' },
      { k: 'acLabelSize', label: 'Label size', options: ['Small', 'Tiny'] },
      { k: 'lblPeak', label: 'Peak labels', type: 'bool' },
      { k: 'lblBreakout', label: 'Breakout labels', type: 'bool' },
      { k: 'lblA5cross', label: 'A5 BUY / SELL Bias labels', type: 'bool' },
      { k: 'lblChance', label: 'Chance / Watch labels', type: 'bool' },
      { k: 'lblConfirm', label: 'BUY ✓ / SELL ✓ confirm labels', type: 'bool' },
      { k: 'lblTmn', label: 'TMN labels', type: 'bool' },
      { k: 'lblReady', label: 'TL Watch labels', type: 'bool' },
      { k: 'lblOutcome', label: '✓ / ✗ outcome labels', type: 'bool' },
      { k: 'lblQuick', label: 'Quick trade labels', type: 'bool' },
    ] },
    { group: 'STMN · Risk box · Stats', fields: [
      { k: 'showStmn', label: 'Show STMN labels', type: 'bool', tip: 'Close beyond the outer UML band (as of that bar), at most once per hour per side.' },
      { k: 'stmnBand', label: 'STMN trigger band', options: ['as-of-bar', 'drawn'], tip: 'as-of-bar = the band as it stood when the bar closed (TAD behaviour; labels never move). drawn = the repainting centered band you see on the chart: labels line up with it but can appear/disappear on recent bars as new bars arrive.' },
      { k: 'showStmnBox', label: 'Show STMN risk box', type: 'bool' },
      { k: 'riskUsd', label: 'Risk per trade ($)', type: 'number', step: 5, min: 1, max: 100000, tip: 'Lots = risk ÷ (stop distance × contract size from Paper Trading → Account).' },
      { k: 'stmnStopAtr', label: 'Stop distance (× ATR 14)', type: 'number', step: 0.1, min: 0.1, max: 10 },
      { k: 'showStats', label: 'Show stats table', type: 'bool' },
      { k: 'statsWin', label: 'Count a win at', options: ['TP1', 'TP2', 'TP3'] },
      { k: 'statsDays', label: 'Stats window (days)', type: 'number', step: 1, min: 1, max: 365, tip: 'Counts setups in the last N days. Needs that much history: use the Load button in the table. Gold, silver, FX and crypto load up to 30,000 bars (older bars from Dukascopy / Bitstamp); other markets are limited to the 5,000 bars IG returns.' },
    ] },
    { group: 'UML Band (Upper / Middle / Lower)', fields: [
      { k: 'umlPrice', label: 'Price', options: ['weighted', 'close', 'typical', 'median', 'open'], tip: 'weighted = (high + low + 2 × close) / 4' },
      { k: 'umlHalf', label: 'Half length', type: 'number', step: 1, min: 2, max: 500 },
      { k: 'umlAtrPeriod', label: 'Range period (SMA of true range)', type: 'number', step: 1, min: 2, max: 2000 },
      { k: 'umlAtrShift', label: 'Range shift (bars back)', type: 'number', step: 1, min: 0, max: 200 },
      { k: 'umlBandMult', label: 'Band multiplier', type: 'number', step: 0.1, min: 0.1, max: 20 },
    ] },
    { group: 'Trade Mode', fields: [{ k: 'tradeMode', label: 'Trade Mode', options: ['Trend', 'Short Trade', 'Both'] }, { k: 'shortRsiThreshold', label: 'Short Trade RSI Threshold', type: 'number', step: 1, min: 20, max: 50 }, { k: 'fixQuickCooldown', label: 'Fix Quick Trade cooldown', type: 'bool', tip: 'In the Pine script QUICK BUY/SELL can never fire. Tick to let it fire.' }] },
  ];
  // AI Chance is one switch for every chart in every layout; new charts follow it.
  $('acToggle').onclick = () => {
    if (!active) return;
    const on = !active.state.ac;
    store.set('acAll', on);
    for (const x of layouts) for (const v of x.views || []) v.ac = on;
    store.set('layouts', layouts);
    views.forEach((v) => { if (!!v.state.ac !== on) v.setAC(on); });
    refreshToolbar();
  };
  $('acSettingsBtn').onclick = () => {
    const m = modal('acModal', 'AI Chance v1.3 — settings', `<form class="ac-form">${AC_SCHEMA.map((g) => `<fieldset><legend>${esc(g.group)}</legend>${g.fields.map((x) => formField(x, acOpts[x.k])).join('')}</fieldset>`).join('')}</form>`, '<button id="acReset">Reset to defaults</button><button data-close class="primary">Done</button>');
    m.querySelector('form').addEventListener('change', async (e) => {
      const f = AC_SCHEMA.flatMap((g) => g.fields).find((x) => x.k === e.target.name); if (!f) return;
      acOpts[f.k] = readField(f, e.target); store.set('ac', acOpts);
      for (const v of views.filter((o) => o.state.ac)) { if (f.htf || f.k === 'symbolMode') await v.acLoadHtf(); v.acRun(); }
    });
    m.querySelector('#acReset').onclick = () => { Object.assign(acOpts, AC.DEFAULTS); store.set('ac', acOpts); $('acSettingsBtn').onclick(); views.forEach((v) => v.state.ac && v.acRun()); };
  };

  // ------------------------------------------------------------ Drawing toolbar (built from IGDraw.TOOLS metadata)
  const DRAW = window.IGDraw;
  const GROUPS = [
    { id: 'cursor', label: 'Cursors', icon: 'M9 2v14M2 9h14' },
    { id: 'trend', label: 'Trend line tools' }, { id: 'fib', label: 'Gann and Fibonacci tools' }, { id: 'patterns', label: 'Patterns' },
    { id: 'forecast', label: 'Forecasting and measurement tools' }, { id: 'shapes', label: 'Geometric shapes' }, { id: 'annotation', label: 'Annotation tools' },
  ];
  const FALLBACK_GROUP = { trend: 'trend', ray: 'trend', extended: 'trend', arrow: 'shapes', hline: 'trend', hray: 'trend', vline: 'trend', cross: 'trend', channel: 'trend', rect: 'shapes', brush: 'shapes', fib: 'fib', measure: 'forecast', long: 'forecast', short: 'forecast', text: 'annotation' };
  const FALLBACK_ICON = 'M3.5 14.5l11-11';
  const toolsIn = (g) => Object.entries(DRAW.TOOLS).filter(([id, t]) => (t.group || FALLBACK_GROUP[id]) === g);
  const toolLast = store.get('toolLast', {});
  const svg = (d) => `<svg class="ico" viewBox="0 0 18 18"><path d="${d || FALLBACK_ICON}"/></svg>`;
  const tgl = { magnet: false, stay: false, lock: false, hide: false, zoom: false };
  const CURSORS = [['cross', 'Cross', 'M9 2v14M2 9h14'], ['dot', 'Dot', 'M9 7.5a1.5 1.5 0 110 3 1.5 1.5 0 010-3z'], ['arrow', 'Arrow', 'M4 2l10 7-4.5 1 2.5 5-2 1-2.5-5L4 14z'], ['demo', 'Demonstration', 'M3 13c2-6 5-8 7-6s3 2 5-3']];
  let cursorMode = store.get('cursorMode', 'cross');
  function buildTools() {
    const nav = $('drawTools');
    nav.innerHTML = GROUPS.map((g) => {
      if (g.id === 'cursor') {
        const extra = toolsIn('cursor');
        const cur = CURSORS.find((c) => c[0] === cursorMode) || CURSORS[0];
        return `<div class="lt-group" data-g="cursor"><button class="lt-btn" data-tool="cursor" title="${cur[1]} (Esc)">${svg(cur[2])}</button><button class="lt-more" data-group="cursor" title="Cursors">›</button><div class="lt-fly hidden" data-fly="cursor"><div class="fly-title">Cursors</div>${CURSORS.map(([k, l, ic]) => `<button data-cursor="${k}" class="${k === cursorMode ? 'active' : ''}">${svg(ic)}<span>${l}</span></button>`).join('')}${extra.map(([id, t]) => `<button data-tool="${id}">${svg(t.icon)}<span>${esc(t.label)}</span></button>`).join('')}</div></div>
          <button class="lt-btn" data-opt="zoom" title="Zoom in: drag across the chart (right-click to zoom out)">${svg('M7.5 3a4.5 4.5 0 110 9 4.5 4.5 0 010-9zM11 11l4.5 4.5M5.5 7.5h4M7.5 5.5v4')}</button>`;
      }
      const tools = toolsIn(g.id);
      if (!tools.length) return '';
      const cur = tools.find(([id]) => id === toolLast[g.id]) || tools[0];
      const subs = [...new Set(tools.map(([, t]) => t.sub || ''))];
      const fly = subs.map((s) => `${s ? `<div class="fly-h">${esc(s)}</div>` : ''}${tools.filter(([, t]) => (t.sub || '') === s).map(([id, t]) => `<button data-tool="${id}">${svg(t.icon)}<span>${esc(t.label)}</span></button>`).join('')}`).join('');
      return `<div class="lt-group" data-g="${g.id}"><button class="lt-btn" data-tool="${cur[0]}" title="${esc(cur[1].label)}">${svg(cur[1].icon)}</button><button class="lt-more" data-group="${g.id}" title="${esc(g.label)}">›</button><div class="lt-fly hidden" data-fly="${g.id}"><div class="fly-title">${esc(g.label)}</div>${fly}</div></div>`;
    }).join('') + `<i class="lt-sep"></i>
      <button class="lt-btn" data-opt="magnet" title="Magnet: snap to OHLC (right-click for strong magnet; hold ⌘/Ctrl while drawing)">${svg('M5 3v6a4 4 0 008 0V3M5 6h3M10 6h3')}</button>
      <button class="lt-btn" data-opt="stay" title="Keep drawing">${svg('M3 15l1-4 8-8 3 3-8 8zM10 5l3 3')}</button>
      <button class="lt-btn" data-opt="lock" title="Lock all drawings">${svg('M5.5 8V6a3.5 3.5 0 017 0v2M4 8h10v8H4z')}</button>
      <button class="lt-btn" data-opt="hide" title="Hide all drawings">${svg('M1.5 9S4.5 4 9 4s7.5 5 7.5 5-3 5-7.5 5S1.5 9 1.5 9zM9 7a2 2 0 100 4 2 2 0 000-4z')}</button>
      <button class="lt-btn" data-opt="trash" title="Remove drawings / indicators">${svg('M3 5h12M7 5V3h4v2M5 5l1 11h6l1-11')}</button>
      <div class="lt-fly hidden" data-fly="trash"><button data-rm="drawings">Remove drawings on this market</button><button data-rm="studies">Remove indicators on this chart</button><button data-rm="all">Remove drawings &amp; indicators</button></div>`;
    renderToolButtons(active && active.draw.tool);
  }
  function renderToolButtons(cur) {
    document.querySelectorAll('#drawTools .lt-btn[data-tool]').forEach((b) => b.classList.toggle('active', (cur || 'cursor') === b.dataset.tool));
    document.querySelectorAll('#drawTools .lt-fly [data-tool]').forEach((b) => b.classList.toggle('active', cur === b.dataset.tool));
    document.querySelectorAll('#drawTools [data-opt]').forEach((b) => b.classList.toggle('active', !!tgl[b.dataset.opt]));
    const m = $('drawTools').querySelector('[data-opt=magnet]'); if (m) m.classList.toggle('strong', shell.magnetStrong);
  }
  function applyToolToggles() {
    for (const v of views) { v.draw.setMagnet(tgl.magnet); v.draw.setStay(tgl.stay); v.draw.setLockAll(tgl.lock); v.draw.setHidden(tgl.hide); v.setZoomTool(tgl.zoom); v.setCursor(cursorMode); }
    renderToolButtons(active && active.draw.tool);
  }
  function pickTool(t) {
    if (!active) return;
    if (!t || t === 'cursor') { views.forEach((v) => v.draw.setTool(null)); return renderToolButtons(null); }
    const g = DRAW.TOOLS[t] && (DRAW.TOOLS[t].group || FALLBACK_GROUP[t]);
    if (g && toolLast[g] !== t) { toolLast[g] = t; store.set('toolLast', toolLast); buildTools(); }
    active.draw.setTool(active.draw.tool === t ? null : t);
  }
  $('drawTools').addEventListener('click', (e) => {
    const cb = e.target.closest('[data-cursor]');
    if (cb) { cursorMode = cb.dataset.cursor; store.set('cursorMode', cursorMode); document.querySelectorAll('.lt-fly').forEach((f) => f.classList.add('hidden')); views.forEach((v) => v.draw.setTool(null)); buildTools(); applyToolToggles(); return; }
    const more = e.target.closest('.lt-more');
    if (more) {
      const fly = document.querySelector(`[data-fly="${more.dataset.group}"]`);
      document.querySelectorAll('.lt-fly').forEach((f) => { if (f !== fly) f.classList.add('hidden'); });
      fly.classList.toggle('hidden');
      const r = more.getBoundingClientRect(); fly.style.top = Math.min(r.top - 8, window.innerHeight - fly.offsetHeight - 8) + 'px';
      return;
    }
    const rm = e.target.closest('[data-rm]');
    if (rm) {
      document.querySelectorAll('.lt-fly').forEach((f) => f.classList.add('hidden'));
      if (rm.dataset.rm !== 'studies') active.draw.clear();
      if (rm.dataset.rm !== 'drawings') active.clearStudies();
      return toast('Removed — undo drawings with ⌘Z');
    }
    const tb = e.target.closest('[data-tool]');
    if (tb) { document.querySelectorAll('.lt-fly').forEach((f) => f.classList.add('hidden')); return pickTool(tb.dataset.tool); }
    const ob = e.target.closest('[data-opt]');
    if (!ob) return;
    if (ob.dataset.opt === 'trash') { const fly = document.querySelector('[data-fly=trash]'); fly.classList.toggle('hidden'); const r = ob.getBoundingClientRect(); fly.style.top = Math.min(r.top - 8, window.innerHeight - 140) + 'px'; return; }
    tgl[ob.dataset.opt] = !tgl[ob.dataset.opt];
    applyToolToggles();
  });
  $('drawTools').addEventListener('contextmenu', (e) => {
    if (e.target.closest('[data-opt=zoom]')) { e.preventDefault(); active && active.zoomOut(); return; } const b = e.target.closest('[data-opt=magnet]'); if (!b) return; e.preventDefault(); shell.magnetStrong = !shell.magnetStrong; tgl.magnet = true; applyToolToggles(); toast(shell.magnetStrong ? 'Strong magnet' : 'Weak magnet'); });
  $('undoBtn').onclick = () => { if (!undoRedo('undo', 'redo')) toast('Nothing to undo'); };
  $('redoBtn').onclick = () => { if (!undoRedo('redo', 'undo')) toast('Nothing to redo'); };

  // ------------------------------------------------------------ Bottom bar
  const RANGES = [['1D', '1', 86400], ['5D', '5', 5 * 86400], ['1M', '30', 30 * 86400], ['3M', '60', 91 * 86400], ['6M', '120', 182 * 86400], ['YTD', '1D', 0], ['1Y', '1D', 365 * 86400], ['5Y', '1W', 5 * 365 * 86400], ['All', '1M', 40 * 365 * 86400]];
  $('rangeGroup').innerHTML = RANGES.map(([k, x]) => `<button data-range="${k}" title="${k} in ${IV.label(x)} bars">${k}</button>`).join('');
  $('rangeGroup').onclick = (e) => {
    const b = e.target.closest('[data-range]'); if (!b || !active) return;
    const [, x, span0] = RANGES.find((r) => r[0] === b.dataset.range);
    const span = span0 || (Date.now() / 1000 - Date.UTC(new Date().getUTCFullYear(), 0, 1) / 1000);
    const sec = IV.parse(x).sec, bars = Math.min(30000, Math.ceil(span / sec) + 20);
    const capped = Math.min(bars, Math.max(settings.maxBars, 1500));
    if (capped < bars) toast(`Loading ${capped} bars (limit set in Settings → Bars to load)`);
    setIv(x, { span, bars: capped });
  };
  $('rtBtn').onclick = () => active && active.chart.timeScale().scrollToRealTime();
  $('gotoBtn').onclick = () => {
    const m = modal('gotoModal', 'Go to', `<form class="ac-form">${formField({ k: 'at', label: 'Date and time', type: 'time' }, Math.floor(Date.now() / 1000) - 86400)}</form>`, '<button data-close>Cancel</button><button class="primary" id="gotoOk">Go to</button>', 'small');
    const go = (e) => { e && e.preventDefault(); const t = readField({ type: 'time' }, m.querySelector('[name=at]')); closeModals(); if (Number.isFinite(t)) active.goTo(t); };
    m.querySelector('#gotoOk').onclick = go; m.querySelector('form').onsubmit = go;
  };
  document.querySelectorAll('#scaleGroup [data-scale]').forEach((b) => b.onclick = () => {
    if (!active) return;
    if (b.dataset.scale === 'invert') { active.setInvert(!active.state.invert); return refreshToolbar(); }
    if (b.dataset.scale === 'auto') return active.autoFit();
    if (b.dataset.scale === 'lock') { active.setLockRatio(!active.state.lockRatio); return refreshToolbar(); }
    if (b.dataset.scale === 'priceonly') { active.setScalePriceOnly(!active.state.scalePriceOnly); return refreshToolbar(); }
    active.setScale(b.dataset.scale); refreshToolbar();
  });
  function tickClock() {
    $('clock').textContent = `${C.dtf({ hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).format(new Date())} ${settings.tz === 'Local' ? 'Local' : settings.tz.replace(/^.*\//, '').replace('_', ' ')}`;
    views.forEach((v) => v.countdown());
  }
  setInterval(tickClock, 1000);

  // ------------------------------------------------------------ Settings, theme, snapshot, export
  const TZS = ['Local', 'UTC', 'America/New_York', 'America/Chicago', 'Europe/London', 'Europe/Berlin', 'Asia/Dubai', 'Asia/Singapore', 'Asia/Hong_Kong', 'Asia/Tokyo', 'Australia/Sydney'];
  const SETTINGS_SCHEMA = [
    { group: 'Appearance', fields: [
      { k: 'theme', label: 'Theme', options: [['dark', 'Dark'], ['light', 'Light']] }, { k: 'up', label: 'Up colour', type: 'color' }, { k: 'down', label: 'Down colour', type: 'color' },
      { k: 'grid', label: 'Grid lines', options: [['both', 'Vert & horz'], ['vert', 'Vertical'], ['horz', 'Horizontal'], ['none', 'None']] }, { k: 'watermark', label: 'Symbol watermark', type: 'bool' },
    ] },
    { group: 'Behaviour', fields: [
      { k: 'crosshair', label: 'Crosshair', options: [['normal', 'Free'], ['magnet', 'Magnet (snap to close)']] }, { k: 'bidAsk', label: 'Bid / ask price lines', type: 'bool' },
      { k: 'countdown', label: 'Countdown to bar close', type: 'bool' }, { k: 'sound', label: 'Alert sounds', type: 'bool' },
      { k: 'sessionBreaks', label: 'Session breaks', type: 'bool', tip: 'Dashed line at each new trading day (in the chosen timezone).' },
      { k: 'events', label: 'Economic events on chart', type: 'bool', tip: 'High / medium impact calendar events as markers.' },
      { k: 'tz', label: 'Timezone', options: TZS, tip: 'Axis labels, legend and clock. Bars themselves are UTC.' },
      { k: 'maxBars', label: 'Bars to load', type: 'int', min: 100, max: 30000, tip: 'IG gives up to 5,000 bars (uses the weekly allowance of 10,000 points). For gold, silver, FX and crypto, up to 30,000 bars: the recent day comes from IG and older bars from a free source (Dukascopy / Bitstamp), aligned to IG prices.' },
    ] },
  ];
  function applyTheme() { document.documentElement.dataset.theme = settings.theme; C.clearFmtCache(); views.forEach((v) => v.applyTheme()); bus.emit('theme'); }
  $('settingsBtn').onclick = $('clock').onclick = () => {
    const m = modal('settingsModal', 'Chart settings', `<form class="ac-form">${SETTINGS_SCHEMA.map((g) => `<fieldset><legend>${g.group}</legend>${g.fields.map((x) => formField(x, settings[x.k])).join('')}</fieldset>`).join('')}</form>`, '<button id="settingsReset">Reset</button><button data-close class="primary">Done</button>');
    m.querySelector('form').addEventListener('change', (e) => {
      const f = SETTINGS_SCHEMA.flatMap((g) => g.fields).find((x) => x.k === e.target.name); if (!f) return;
      settings[f.k] = readField(f, e.target); C.saveSettings(); applyTheme(); tickClock();
    });
    m.querySelector('#settingsReset').onclick = () => { Object.assign(settings, C.SETTINGS_DEFAULTS); C.saveSettings(); applyTheme(); $('settingsBtn').onclick(); };
  };
  $('themeBtn').onclick = () => { settings.theme = settings.theme === 'dark' ? 'light' : 'dark'; C.saveSettings(); applyTheme(); };
  $('fsBtn').onclick = () => { if (document.fullscreenElement) document.exitFullscreen(); else document.documentElement.requestFullscreen?.().catch(() => {}); };

  function snapshotCanvas(all) {
    const list = all ? views : [active];
    const shots = list.map((v) => ({ v, c: v.snapshot(), r: v.root.parentElement.getBoundingClientRect() }));
    const dpr = window.devicePixelRatio || 1, head = Math.round(28 * dpr);
    let W, H;
    const g0 = $('grid').getBoundingClientRect();
    if (all) { W = Math.round(g0.width * dpr); H = Math.round(g0.height * dpr) + head; } else { W = shots[0].c.width; H = shots[0].c.height + head; }
    const out = document.createElement('canvas'); out.width = W; out.height = H;
    const g = out.getContext('2d');
    g.fillStyle = T().bg; g.fillRect(0, 0, W, H);
    g.fillStyle = settings.theme === 'light' ? '#131722' : '#d6dbe3'; g.font = `${Math.round(13 * dpr)}px -apple-system, sans-serif`; g.textBaseline = 'middle';
    const v = active, last = v.basis[v.basis.length - 1];
    g.fillText(`${v.title()} · ${IV.label(v.interval)} · IG   ${last ? `O ${v.fmt(last.open)}  H ${v.fmt(last.high)}  L ${v.fmt(last.low)}  C ${v.fmt(last.close)}` : ''}   ${new Date().toLocaleString()}`, 10 * dpr, head / 2);
    for (const s of shots) {
      const x = all ? Math.round((s.r.left - g0.left) * dpr) : 0, y = head + (all ? Math.round((s.r.top - g0.top) * dpr) : 0);
      g.drawImage(s.c, x, y);
    }
    return out;
  }
  const snapName = (ext) => `${(active.title() || 'chart').replace(/[^\w.-]+/g, '_')}_${IV.label(active.interval)}_${new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-')}.${ext}`;
  $('shotMenu').innerHTML = '<button data-shot="png">Download chart image</button><button data-shot="all">Download all charts (layout)</button><button data-shot="copy">Copy chart image</button><button data-shot="link">Copy link to this chart</button><div class="dd-sep"></div><button data-shot="csv">Export chart data (CSV)…</button>';
  $('shotBtn').onclick = () => toggleMenu('shotMenu');
  $('shotMenu').onclick = async (e) => {
    const b = e.target.closest('[data-shot]'); if (!b) return;
    hideMenus();
    const k = b.dataset.shot;
    if (k === 'png' || k === 'all') { download(snapName('png'), snapshotCanvas(k === 'all').toDataURL('image/png')); toast('Snapshot saved'); }
    if (k === 'copy') { snapshotCanvas(false).toBlob(async (blob) => { try { await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]); toast('Chart image copied'); } catch { toast('Clipboard not available here'); } }); }
    if (k === 'link') { try { await navigator.clipboard.writeText(chartLink()); toast('Chart link copied'); } catch { prompt('Chart link', chartLink()); } }
    if (k === 'csv') { download(snapName('csv'), active.exportCSV()); toast('Chart data exported (OHLCV + every indicator output)'); }
  };

  // ------------------------------------------------------------ Help
  const HELP = [
    ['Symbol search', 'start typing a name, or ⌘K'], ['Change interval', 'type 1 · 5 · 45 · 2H · 1D · 3M · 100T · 10R, then Enter'], ['Indicators', '/'],
    ['Trend line · Horizontal line / ray · Vertical · Cross', '⌥T · ⌥H / ⌥J · ⌥V · ⌥C'], ['Fib retracement · Rectangle', '⌥F · ⌥⇧R'], ['Measure', '⇧ + drag'],
    ['Magnet while drawing', 'hold ⌘ / Ctrl'], ['Delete selected drawing', 'Del / ⌫'], ['Undo / redo', '⌘Z / ⇧⌘Z'],
    ['Create alert', '⌥A · ⌥ + click a price'], ['Reset chart view', '⌥R'], ['Snapshot', '⌥S'], ['Fullscreen', '⇧F'],
    ['Next / previous chart in layout', '⌥] / ⌥['], ['Replay: step / play-pause', '⇧→ / ⇧↓'], ['Cancel / deselect', 'Esc'], ['This help', '?'],
  ];
  $('helpBtn').onclick = () => modal('helpModal', 'Keyboard shortcuts', `<div class="help-grid">${HELP.map(([a, b]) => `<span>${a}</span><kbd>${b}</kbd>`).join('')}</div><p class="muted pad">Charts are drawn with <a href="https://www.tradingview.com/lightweight-charts/" target="_blank" rel="noopener noreferrer">TradingView Lightweight Charts™</a> (Apache 2.0). Market data from IG.</p>`);

  // ------------------------------------------------------------ Keyboard
  const ivIn = { buf: '', t: null, el: null };
  function ivType(ch) {
    if (!ivIn.el) { ivIn.el = document.createElement('div'); ivIn.el.className = 'tf-input'; ivIn.el.innerHTML = '<small>Change interval</small><b></b>'; document.body.appendChild(ivIn.el); }
    ivIn.buf = (ivIn.buf + ch).toUpperCase().slice(0, 6);
    ivIn.el.querySelector('b').textContent = ivIn.buf; ivIn.el.classList.remove('hidden');
    clearTimeout(ivIn.t); ivIn.t = setTimeout(ivCommit, 2500);
  }
  function ivCommit() {
    clearTimeout(ivIn.t);
    let s = ivIn.buf; ivIn.buf = ''; ivIn.el && ivIn.el.classList.add('hidden');
    if (/^\d+M$/.test(s)) s = s.slice(0, -1) + 'M';
    if (IV.parse(s)) setIv(s); else toast('Try 1, 5, 45, 2H, 1D, 1W, 3M, 100T or 10R');
  }
  document.addEventListener('keydown', (e) => {
    if (/^(INPUT|SELECT|TEXTAREA)$/.test(e.target.tagName) || e.target.isContentEditable) return;
    if (e.target.closest && e.target.closest('.bpanel')) return;
    if (anyModal()) { if (e.key === 'Escape') closeModals(); return; }
    if (!active) return;
    const mod = e.metaKey || e.ctrlKey;
    if (mod && e.shiftKey && e.code === 'KeyT') { e.preventDefault(); return reopenTab(); }
    if (ivIn.buf) {
      if (e.key === 'Enter') { e.preventDefault(); return ivCommit(); }
      if (e.key === 'Escape') { ivIn.buf = ''; ivIn.el.classList.add('hidden'); return; }
      if (e.key === 'Backspace') { ivIn.buf = ivIn.buf.slice(0, -1); ivIn.el.querySelector('b').textContent = ivIn.buf; if (!ivIn.buf) ivIn.el.classList.add('hidden'); return; }
      if (/^[0-9SHDWMTRshdwtr]$/.test(e.key)) { e.preventDefault(); return ivType(e.key === 'm' ? 'M' : e.key); }
    }
    if (e.key === 'Escape') { if (active.rp.picking) return active.replayStop(); hideMenus(); views.forEach((v) => v.draw.cancel()); renderToolButtons(null); return; }
    if (mod && e.code === 'KeyZ') { e.preventDefault(); if (e.shiftKey) undoRedo('redo', 'undo'); else undoRedo('undo', 'redo'); return; }
    if (mod && e.code === 'KeyY') { e.preventDefault(); undoRedo('redo', 'undo'); return; }
    if (mod && e.code === 'KeyC' && active.draw.copy && (active.draw.selectedIds ? active.draw.selectedIds().length : active.draw.selected)) { e.preventDefault(); const n = active.draw.copy(); toast(`Copied ${n || 1} drawing${n > 1 ? 's' : ''}`); return; }
    if (mod && e.code === 'KeyA' && active.draw.selectAll) { e.preventDefault(); active.draw.selectAll(); return; }
    if (mod && e.code === 'KeyV' && active.draw.paste) { e.preventDefault(); active.draw.paste(); return; }
    if (mod && e.code === 'KeyK') { e.preventDefault(); return openSearch('symbol'); }
    if (mod) return;
    if (e.altKey) {
      if (e.code === 'BracketRight' || e.code === 'BracketLeft') { e.preventDefault(); const i = views.indexOf(active); return setActive(views[(i + (e.code === 'BracketRight' ? 1 : views.length - 1)) % views.length]); }
      if (e.code === 'KeyR' && e.shiftKey) { e.preventDefault(); return pickTool('rect'); }
      const tool = { KeyT: 'trend', KeyH: 'hline', KeyJ: 'hray', KeyV: 'vline', KeyC: 'cross', KeyF: 'fib' }[e.code];
      if (tool) { e.preventDefault(); return pickTool(tool); }
      if (e.code === 'KeyR') { e.preventDefault(); return active.resetView(); }
      if (e.code === 'KeyA') { e.preventDefault(); const q = quotes[active.symbol]; return window.IGPanels.openAlertDialog({ price: q?.bid ?? active.basis[active.basis.length - 1]?.close }); }
      if (e.code === 'KeyS') { e.preventDefault(); download(snapName('png'), snapshotCanvas(false).toDataURL('image/png')); return toast('Snapshot saved'); }
      return;
    }
    if ((e.key === 'Delete' || e.key === 'Backspace') && active.draw.deleteSelected()) { e.preventDefault(); return; }
    if (e.shiftKey && e.key === 'ArrowRight' && active.rp.on) { e.preventDefault(); active.replayPause(); return active.replayStep(); }
    if (e.shiftKey && e.key === 'ArrowDown' && active.rp.on) { e.preventDefault(); return active.replayPlay(); }
    if (e.shiftKey && e.code === 'KeyF') { e.preventDefault(); return $('fsBtn').click(); }
    if (e.key === '/') { e.preventDefault(); return openIndicators(); }
    if (e.key === '?') { e.preventDefault(); return $('helpBtn').click(); }
    if (/^[0-9]$/.test(e.key)) { e.preventDefault(); return ivType(e.key); }
    if (/^[a-zA-Z]$/.test(e.key) && !e.shiftKey) { e.preventDefault(); return openSearch('symbol', e.key); }
  });

  $('replayBtn').onclick = () => { active.replayPick(); refreshToolbar(); };
  $('alertBtn').onclick = () => window.IGPanels.openAlertDialog({});

  // ------------------------------------------------------------ Live data routing
  bus.on('tick', (epic, q) => { for (const v of views) if (v.involves(epic)) v.onTick(epic, q); });
  bus.on('status', (s) => {
    const ok = /CONNECTED:(WS|HTTP)-STREAMING|MOCK/.test(s);
    $('streamDot').className = 'dot ' + (ok ? 'ok' : /DISCONNECTED|error|failed|server/.test(s) ? 'bad' : '');
    $('streamText').textContent = ok ? 'live' : String(s).toLowerCase();
  });
  bus.on('reconnect', () => views.forEach((v) => { const last = v.candles[v.candles.length - 1]; if (!v.rp.on && (!last || Date.now() / 1000 - last.time > 2 * v.tfSec)) v.load(); }));
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') bus.emit('reconnect'); });

  // ------------------------------------------------------------ Boot
  (async () => {
    applyTheme();
    let status = {};
    try { status = await api('/api/status'); } catch {}
    $('modeBadge').textContent = status.mode || '?';
    if (status.stream) bus.emit('status', status.stream);
    shell.onAllowance(status.allowance);
    C.connect();
    if ('serviceWorker' in navigator && location.protocol !== 'file:') navigator.serviceWorker.register('/sw.js').catch(() => {});
    bus.on('state-remote', (key) => {
      if (key === 'drawings') { Object.assign(drawings, store.get('drawings', {})); for (const k of Object.keys(drawings)) if (!(k in store.get('drawings', {}))) delete drawings[k]; return; }
      if (key === 'settings') { Object.assign(settings, store.get('settings', {})); applyTheme(); return; }
      if (key === 'watchlists') { window.IGPanels.reloadWatchlists && window.IGPanels.reloadWatchlists(); return; }
      if (key === 'layouts') {
        const t = document.createElement('div');
        t.className = 'toast-item sync'; t.textContent = 'Layouts changed on another device — click to load them';
        t.onclick = () => location.reload();
        ($('toasts') || document.body).prepend(t); setTimeout(() => t.remove(), 15000);
      }
    });
    window.IGPanels.init({ status, app: IGApp });
    const mock = status.mode === 'MOCK';
    for (const x of layouts) for (const v of x.views) {
      if (v.symbol && !IV.isExpr(v.symbol) && v.symbol.startsWith('MOCK.') !== mock) v.symbol = null;
      if (!v.symbol) v.symbol = (status.defaults || [])[0] || null;
    }
    mountLayout(L);
    buildTools(); tickClock();
    if (!active.symbol) active.msg(status.stream === 'login-failed' ? 'IG login failed — check your .env credentials and server logs.' : 'Search for a market to start charting.');
  })();
});
