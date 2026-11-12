/* IG Charts — Hotlists: top gainers / losers, most volatile, gaps and unusual tick volume over the watchlists plus a curated IG universe.
   Self-mounting sidebar pane. Uses live quotes where streamed and a few cached daily / hourly bars per symbol (IG history allowance is 10,000 points a week). */
(function () {
  'use strict';
  const C = window.IGC;
  if (!C) return;

  // Curated IG universe, resolved once through /api/search (epics differ by account type and region) and cached for 30 days.
  const UNIVERSE = [
    ['FX', 'EUR/USD', /^EUR\/USD/i], ['FX', 'GBP/USD', /^GBP\/USD/i], ['FX', 'USD/JPY', /^USD\/JPY/i], ['FX', 'AUD/USD', /^AUD\/USD/i],
    ['FX', 'USD/CAD', /^USD\/CAD/i], ['FX', 'USD/CHF', /^USD\/CHF/i], ['FX', 'NZD/USD', /^NZD\/USD/i], ['FX', 'EUR/JPY', /^EUR\/JPY/i],
    ['FX', 'GBP/JPY', /^GBP\/JPY/i], ['FX', 'EUR/GBP', /^EUR\/GBP/i],
    ['Metals', 'Spot Gold', /spot gold/i], ['Metals', 'Spot Silver', /spot silver/i],
    ['Indices', 'US 500', /^US 500/i], ['Indices', 'US Tech 100', /^US Tech 100/i], ['Indices', 'Wall Street', /^Wall Street/i],
    ['Indices', 'Germany 40', /^Germany 40/i], ['Indices', 'FTSE 100', /^FTSE 100/i], ['Indices', 'Japan 225', /^Japan 225/i],
    ['Indices', 'Hong Kong HS50', /^Hong Kong/i], ['Indices', 'Australia 200', /^Australia 200/i],
    ['Crypto', 'Bitcoin', /^bitcoin/i], ['Crypto', 'Ether', /^ether/i],
    ['Commodities', 'US Crude', /us crude/i], ['Commodities', 'Brent Crude', /brent/i], ['Commodities', 'Natural Gas', /natural gas/i], ['Commodities', 'Copper', /copper/i],
  ];
  const LISTS = [
    ['gainers', 'Top gainers'], ['losers', 'Top losers'], ['volatile', 'Most volatile'], ['gapup', 'Gap up'], ['gapdown', 'Gap down'], ['volume', 'Unusual volume'],
  ];
  const GROUPS = ['All', 'Watchlist', 'FX', 'Metals', 'Indices', 'Crypto', 'Commodities'];
  const K_PREF = 'hotlists.prefs', K_RES = 'hotlists.resolved', K_BARS = 'hotlists.bars';
  const RESOLVE_TTL = 30 * 86400000, DAY_MAX = 15, HOUR_MAX = 26, MIN_ALLOWANCE = 300;

  const CSS = `
.hl { display: flex; flex-direction: column; min-height: 0; height: 100%; font-size: 12px; font-variant-numeric: tabular-nums; }
.hl-bar { display: flex; flex-wrap: wrap; gap: 4px; padding: 6px 10px; border-bottom: 1px solid var(--line); }
.hl-bar select { background: var(--bg); color: var(--text); border: 1px solid var(--line); border-radius: 4px; padding: 3px 4px; font: inherit; min-width: 0; }
.hl-bar button { background: var(--panel-2); border: 1px solid var(--line); color: var(--text); border-radius: 4px; padding: 3px 8px; cursor: pointer; font: inherit; }
.hl-bar button:hover { background: var(--hover); }
.hl-bar label { display: inline-flex; align-items: center; gap: 4px; color: var(--muted); }
.hl-tabs { display: flex; flex-wrap: wrap; gap: 3px; padding: 6px 10px 4px; }
.hl-tabs button { background: none; border: 1px solid var(--line); color: var(--muted); border-radius: 12px; padding: 2px 9px; cursor: pointer; font: inherit; font-size: 11px; }
.hl-tabs button.on { color: var(--accent); border-color: var(--accent); background: var(--accent-soft); }
.hl-status { padding: 2px 10px 6px; color: var(--muted); font-size: 11px; min-height: 14px; }
.hl-status .warn { color: var(--down); }
.hl-table { flex: 1; min-height: 0; overflow: auto; }
.hl table { width: 100%; border-collapse: collapse; }
.hl th { position: sticky; top: 0; background: var(--panel); color: var(--muted); font-weight: 500; text-align: right; padding: 4px 8px; border-bottom: 1px solid var(--line); white-space: nowrap; }
.hl td { text-align: right; padding: 4px 8px; border-bottom: 1px solid var(--line); white-space: nowrap; }
.hl th:first-child, .hl td:first-child { text-align: left; }
.hl table { table-layout: fixed; } .hl th:not(:first-child), .hl td:not(:first-child) { width: 86px; }
.hl td:first-child { overflow: hidden; text-overflow: ellipsis; }
.hl td:first-child .sub { padding-left: 11px; }
.hl .hl-ref { background: none; border: 0; color: var(--muted); cursor: pointer; font-size: 15px; padding: 0 4px; border-radius: 4px; } .hl .hl-ref:hover { color: var(--text); background: var(--hover); }
.hl tbody tr { cursor: pointer; } .hl tbody tr:hover td { background: var(--hover); }
.hl tr.cur td { background: var(--accent-soft); }
.hl td .sub { display: block; color: var(--muted); font-size: 10.5px; }
.hl .lv { display: inline-block; width: 6px; height: 6px; border-radius: 3px; margin-right: 5px; background: var(--muted); vertical-align: middle; } .hl .lv.on { background: var(--up); }
.hl .up { color: var(--up); } .hl .down { color: var(--down); }
.hl-empty { color: var(--muted); padding: 18px 10px; text-align: center; }
.hl-foot { padding: 6px 10px; color: var(--muted); font-size: 10.5px; border-top: 1px solid var(--line); line-height: 1.4; }
`;

  const esc = C.esc || ((s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])));
  const fin = (x) => typeof x === 'number' && Number.isFinite(x);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const sget = (k, d) => { try { return C.store.get(k, d); } catch { return d; } };
  const sset = (k, v) => { try { C.store.set(k, v); } catch {} };
  const fmtP = (v) => (fin(v) ? (C.fmtNum ? C.fmtNum(v, Math.abs(v) < 10 ? 4 : 2) : v.toFixed(2)) : '—');
  const pctTxt = (v, sign = true) => (fin(v) ? `${sign && v > 0 ? '+' : ''}${v.toFixed(2)}%` : '—');
  const dirCls = (v) => (fin(v) ? (v > 0 ? 'up' : v < 0 ? 'down' : '') : '');
  const ago = (ms) => { const m = Math.round((Date.now() - ms) / 60000); return m < 1 ? 'just now' : m < 60 ? `${m} min ago` : `${Math.round(m / 60)} h ago`; };

  const S = {
    prefs: Object.assign({ list: 'gainers', group: 'All', vol: 'atr', barsTtl: 60, auto: true, curated: true }, sget(K_PREF, {}) || {}),
    resolved: sget(K_RES, {}) || {},
    bars: sget(K_BARS, {}) || {},
    pane: null, root: null, visible: false, busy: false, status: '', warn: '', allowance: null, timer: null, renderT: null, dirty: false, abort: false,
  };
  const savePrefs = () => sset(K_PREF, S.prefs);
  const saveBars = () => {
    const now = Date.now();
    for (const [k, v] of Object.entries(S.bars)) if (!v || now - v.at > 7 * 86400000) delete S.bars[k];
    sset(K_BARS, S.bars);
  };

  // ── universe ──────────────────────────────────────────
  function watchlistEpics() {
    const WL = sget('watchlists', null), out = [];
    if (WL && Array.isArray(WL.lists)) for (const l of WL.lists) for (const x of l.items || []) if (typeof x === 'string' && x && !x.startsWith('###')) out.push(x);
    return [...new Set(out)];
  }
  function universe() {
    const map = new Map();
    for (const e of watchlistEpics()) map.set(e, { epic: e, groups: new Set(['Watchlist']) });
    if (S.prefs.curated) for (const [g, term] of UNIVERSE) {
      const r = S.resolved[term];
      if (!r || !r.epic) continue;
      const it = map.get(r.epic) || { epic: r.epic, groups: new Set() };
      it.groups.add(g); if (!C.names[r.epic] && r.name) C.setName(r.epic, r.name);
      if (r.snap) it.snap = r.snap;
      map.set(r.epic, it);
    }
    return [...map.values()];
  }
  async function resolveUniverse() {
    const now = Date.now(), todo = UNIVERSE.filter(([, term]) => !S.resolved[term] || now - S.resolved[term].at > RESOLVE_TTL);
    let n = 0;
    for (const [, term, re] of todo) {
      if (S.abort) return;
      setStatus(`Finding IG markets… ${++n}/${todo.length}`);
      try {
        const list = await C.api(`/api/search?q=${encodeURIComponent(term)}`);
        const cash = (m) => m.expiry === '-' || m.expiry === 'DFB';
        const best = (list || []).find((m) => re.test(m.name) && cash(m)) || (list || []).find((m) => re.test(m.name));
        S.resolved[term] = { at: now, epic: best ? best.epic : null, name: best ? best.name : null,
          snap: best && fin(best.bid) ? { bid: best.bid, offer: best.offer, changePct: fin(best.changePct) ? best.changePct : null, at: now } : null };
      } catch (e) {
        if (e.status === 401 || e.status === 403) { S.warn = 'Market search unavailable (not logged in)'; return; }
        S.resolved[term] = { at: now - RESOLVE_TTL + 3600000, epic: null }; // retry in an hour
      }
      sset(K_RES, S.resolved);
      await sleep(S.mock ? 0 : 1100); // stay well inside IG's non-trading request limit
    }
  }

  // ── bars (client cache in front of the server's own history cache) ──
  const cacheKey = (epic, res) => `${epic}|${res}`;
  const fresh = (epic, res) => { const c = S.bars[cacheKey(epic, res)]; return c && Date.now() - c.at < S.prefs.barsTtl * 60000 ? c : null; };
  async function loadBars(epics, res, max, force) {
    const need = epics.filter((e) => force || !fresh(e, res));
    let n = 0, cost = 0;
    for (const e of need) {
      if (S.abort) break;
      if (S.allowance && fin(S.allowance.remaining) && S.allowance.remaining < MIN_ALLOWANCE) { S.warn = `IG history allowance low (${S.allowance.remaining} pts left): using cached bars`; break; }
      setStatus(`Loading ${res === 'DAY' ? 'daily' : 'hourly'} bars… ${++n}/${need.length}`);
      try {
        const r = await C.api(`/api/history?epic=${encodeURIComponent(e)}&resolution=${res}&max=${max}&ext=0`);
        if (r.allowance) {
          const before = S.allowance && S.allowance.remaining;
          S.allowance = r.allowance;
          if (fin(before) && fin(r.allowance.remaining)) cost += Math.max(0, before - r.allowance.remaining);
          window.IGApp && window.IGApp.shell && window.IGApp.shell.onAllowance && window.IGApp.shell.onAllowance(r.allowance);
        }
        S.bars[cacheKey(e, res)] = { at: Date.now(), candles: (r.candles || []).slice(-max).map((c) => ({ time: c.time, open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume })) };
      } catch (err) {
        if (err.status === 429) { S.warn = 'IG history allowance exhausted: using cached bars'; break; }
        if (err.status === 404) S.bars[cacheKey(e, res)] = { at: Date.now(), candles: [], err: 'no data' };
        else S.bars[cacheKey(e, res)] = { at: Date.now() - S.prefs.barsTtl * 60000 + 120000, candles: (S.bars[cacheKey(e, res)] || {}).candles || [], err: err.message };
      }
      await sleep(150);
    }
    saveBars();
    return cost;
  }

  // ── metrics ───────────────────────────────────────────
  function quoteOf(epic, snap) {
    const q = C.quotes[epic] || (S.serverQuotes || {})[epic];
    if (q && fin(q.bid) && fin(q.offer)) return { ...q, live: true };
    if (snap && fin(snap.bid)) return { ...snap, live: false };
    return null;
  }
  function metrics(it) {
    const d = (S.bars[cacheKey(it.epic, 'DAY')] || {}).candles || [], h = (S.bars[cacheKey(it.epic, 'HOUR')] || {}).candles || [];
    const q = quoteOf(it.epic, it.snap), m = { epic: it.epic, name: C.nameOf(it.epic), groups: it.groups, live: !!(q && q.live), barsAt: (S.bars[cacheKey(it.epic, 'DAY')] || {}).at };
    const cur = d[d.length - 1], prev = d[d.length - 2];
    m.last = q ? (q.bid + q.offer) / 2 : cur ? cur.close : null;
    m.chgPct = q && fin(q.changePct) ? q.changePct : prev && fin(m.last) ? ((m.last - prev.close) / prev.close) * 100 : null;
    if (cur && prev && prev.close) {
      const hi = Math.max(cur.high, q && fin(q.high) ? q.high : -Infinity, fin(m.last) ? m.last : -Infinity);
      const lo = Math.min(cur.low, q && fin(q.low) ? q.low : Infinity, fin(m.last) ? m.last : Infinity);
      m.rangePct = ((hi - lo) / prev.close) * 100;
      m.gapPct = ((cur.open - prev.close) / prev.close) * 100;
      const prior = d.slice(-11, -1).map((c) => c.volume).filter((v) => v > 0);
      if (prior.length >= 3 && cur.volume > 0) m.dayRvol = cur.volume / (prior.reduce((a, b) => a + b, 0) / prior.length);
    }
    if (d.length >= 3) {
      const tr = [];
      for (let i = Math.max(1, d.length - 14); i < d.length; i++) tr.push(Math.max(d[i].high, d[i - 1].close) - Math.min(d[i].low, d[i - 1].close));
      const atr = tr.reduce((a, b) => a + b, 0) / tr.length;
      if (fin(m.last) && m.last) { m.atr = atr; m.atrPct = (atr / m.last) * 100; }
    }
    // Unusual volume: the last completed hourly bar against the average of the 24 bars before it (bars with ticks only).
    if (h.length >= 6) {
      const nowSec = Date.now() / 1000, done = h.filter((c) => c.time + 3600 <= nowSec + 1), last = done[done.length - 1];
      const base = done.slice(-25, -1).map((c) => c.volume).filter((v) => v > 0);
      if (last && base.length >= 5 && last.volume > 0) { m.rvol = last.volume / (base.reduce((a, b) => a + b, 0) / base.length); m.rvolT = last.time; }
    }
    return m;
  }
  function ranked(list, group, vol) {
    const its = universe().filter((it) => group === 'All' || it.groups.has(group)).map(metrics);
    const by = (k, dir, keep) => its.filter((m) => fin(m[k]) && (!keep || keep(m[k]))).sort((a, b) => (a[k] - b[k]) * dir);
    switch (list) {
      case 'gainers': return { rows: by('chgPct', -1, (v) => v > 0), key: 'chgPct', its };
      case 'losers': return { rows: by('chgPct', 1, (v) => v < 0), key: 'chgPct', its };
      case 'volatile': return { rows: by(vol === 'range' ? 'rangePct' : 'atrPct', -1), key: vol === 'range' ? 'rangePct' : 'atrPct', its };
      case 'gapup': return { rows: by('gapPct', -1, (v) => v > 0), key: 'gapPct', its };
      case 'gapdown': return { rows: by('gapPct', 1, (v) => v < 0), key: 'gapPct', its };
      case 'volume': return { rows: by('rvol', -1), key: 'rvol', its };
      default: return { rows: [], key: 'chgPct', its };
    }
  }

  // ── refresh ───────────────────────────────────────────
  function setStatus(t) { S.status = t; if (S.root) { const el = S.root.querySelector('.hl-status'); if (el) el.innerHTML = statusHtml(); } }
  function statusHtml() { return `${esc(S.status)}${S.warn ? ` <span class="warn">${esc(S.warn)}</span>` : ''}`; }
  async function refresh(force) {
    if (S.busy) return;
    S.busy = true; S.warn = ''; S.abort = false;
    try {
      if (S.mock == null) { try { const st = await C.api('/api/status'); S.mock = st.mode === 'MOCK'; if (st.allowance && fin(st.allowance.remaining)) S.allowance = st.allowance; } catch { S.mock = false; } }
      if (S.prefs.curated) await resolveUniverse();
      const epics = universe().map((x) => x.epic);
      try {
        S.serverQuotes = (await C.api(`/api/quotes?epics=${encodeURIComponent(epics.join(','))}`)) || {};
      } catch { S.serverQuotes = {}; }
      let cost = await loadBars(epics, 'DAY', DAY_MAX, force);
      if (S.prefs.list === 'volume') cost += await loadBars(epics, 'HOUR', HOUR_MAX, force);
      S.lastRun = Date.now();
      setStatus(`${epics.length} symbols · bars ${S.prefs.barsTtl >= 60 ? S.prefs.barsTtl / 60 + ' h' : S.prefs.barsTtl + ' min'} cache${cost ? ` · used ${cost} history pts` : ''}${S.allowance && fin(S.allowance.remaining) ? ` · ${S.allowance.remaining.toLocaleString()} pts left` : ''}`);
    } catch (e) { S.warn = e.message; setStatus(''); }
    finally { S.busy = false; render(); }
  }

  // ── UI ────────────────────────────────────────────────
  function render() {
    if (!S.root) return;
    const p = S.prefs, { rows, key, its } = ranked(p.list, p.group, p.vol), cur = window.IGApp && window.IGApp.active && window.IGApp.active.symbol;
    const head = { chgPct: 'Chg %', atrPct: 'ATR(14) %', rangePct: 'Day range %', gapPct: 'Gap %', rvol: 'Rel. vol' }[key];
    const val = (m) => (key === 'rvol' ? (fin(m.rvol) ? `${m.rvol.toFixed(2)}×` : '—') : pctTxt(m[key], key === 'chgPct' || key === 'gapPct'));
    const sub = (m) => (key === 'rvol' ? (m.rvolT ? `${new Date(m.rvolT * 1000).toISOString().slice(11, 16)} UTC` : '') : key === 'atrPct' && fin(m.atr) ? fmtP(m.atr) : key === 'gapPct' && fin(m.chgPct) ? `chg ${pctTxt(m.chgPct)}` : '');
    const missing = its.filter((m) => !fin(m[key])).length;
    S.root.querySelector('.hl-tabs').innerHTML = LISTS.map(([k, l]) => `<button data-list="${k}" class="${k === p.list ? 'on' : ''}">${l}</button>`).join('');
    S.root.querySelector('[data-p=group]').value = p.group;
    S.root.querySelector('[data-p=vol]').style.display = p.list === 'volatile' ? '' : 'none';
    S.root.querySelector('.hl-status').innerHTML = statusHtml();
    S.root.querySelector('.hl-table').innerHTML = rows.length
      ? `<table><thead><tr><th>Symbol</th>${key === 'chgPct' ? '' : '<th>Chg %</th>'}<th>${head}</th></tr></thead><tbody>${rows.slice(0, 50).map((m) => `<tr data-epic="${esc(m.epic)}" class="${m.epic === cur ? 'cur' : ''}" title="${esc(m.name)} · ${esc(m.epic)}${m.barsAt ? ' · bars ' + ago(m.barsAt) : ''}">
          <td><i class="lv ${m.live ? 'on' : ''}" title="${m.live ? 'Live streamed quote' : 'Delayed: last bar close / search snapshot'}"></i>${esc(m.name)}<span class="sub">${fmtP(m.last)}</span></td>${key === 'chgPct' ? '' : `<td class="${dirCls(m.chgPct)}">${pctTxt(m.chgPct)}</td>`}
          <td class="${key === 'chgPct' || key === 'gapPct' ? dirCls(m[key]) : ''}">${val(m)}${sub(m) ? `<span class="sub">${esc(sub(m))}</span>` : ''}</td></tr>`).join('')}</tbody></table>`
      : `<div class="hl-empty">${S.busy ? 'Loading…' : its.length ? `No symbols match${missing ? ` (${missing} without data yet)` : ''}.` : 'No symbols: add some to a watchlist or enable the IG universe.'}</div>`;
  }
  function scheduleRender() { if (S.renderT || !S.visible) return; S.renderT = setTimeout(() => { S.renderT = null; render(); }, 1500); }

  function build(pane) {
    pane.innerHTML = `<div class="hl">
      <div class="wl-head"><span>Hotlists</span><span style="flex:1"></span><button class="hl-ref" data-a="refresh" title="Refresh now (re-fetches bars: uses IG history allowance)">⟳</button></div>
      <div class="hl-tabs"></div>
      <div class="hl-bar">
        <select data-p="group" title="Universe">${GROUPS.map((g) => `<option value="${g}">${g === 'All' ? 'All symbols' : g}</option>`).join('')}</select>
        <select data-p="vol" title="Volatility measure"><option value="atr">ATR(14) %</option><option value="range">Day range %</option></select>
        <select data-p="barsTtl" title="How long fetched bars are reused before re-fetching">${[15, 30, 60, 240].map((m) => `<option value="${m}" ${+S.prefs.barsTtl === m ? 'selected' : ''}>Bars: ${m >= 60 ? m / 60 + ' h' : m + ' min'}</option>`).join('')}</select>
        <label title="Re-rank on live ticks and re-fetch bars when the cache expires, while this pane is open"><input type="checkbox" data-p="auto" ${S.prefs.auto ? 'checked' : ''}>Auto</label>
        <label title="Include curated IG FX, metals, indices, crypto and commodities"><input type="checkbox" data-p="curated" ${S.prefs.curated ? 'checked' : ''}>IG universe</label>
      </div>
      <div class="hl-status"></div>
      <div class="hl-table"></div>
      <div class="hl-foot">Click a row to open it on the active chart. Change % uses the streamed IG day change when available, else the last two daily bars. Volume is IG tick volume.</div>
    </div>`;
    S.root = pane.firstElementChild;
    S.root.querySelector('[data-p=vol]').value = S.prefs.vol;
    S.root.addEventListener('click', (e) => {
      const t = e.target.closest('[data-list]');
      if (t) { S.prefs.list = t.dataset.list; savePrefs(); render(); if (S.prefs.list === 'volume') refresh(); return; }
      if (e.target.closest('[data-a=refresh]')) return refresh(true);
      const tr = e.target.closest('tr[data-epic]');
      const v = window.IGApp && window.IGApp.active;
      if (tr && v) { v.setSymbol(tr.dataset.epic); setTimeout(render, 100); }
    });
    S.root.addEventListener('change', (e) => {
      const k = e.target.dataset.p; if (!k) return;
      S.prefs[k] = e.target.type === 'checkbox' ? e.target.checked : k === 'barsTtl' ? +e.target.value : e.target.value;
      savePrefs(); render();
      if (k === 'curated' || k === 'barsTtl' || k === 'auto') refresh();
    });
  }

  function setVisible(on) {
    if (on === S.visible) return;
    S.visible = on;
    clearInterval(S.timer); S.timer = null;
    if (!on) return;
    render();
    if (!S.lastRun || Date.now() - S.lastRun > S.prefs.barsTtl * 60000) refresh();
    S.timer = setInterval(() => {
      if (!S.prefs.auto) return;
      if (Date.now() - (S.lastRun || 0) > S.prefs.barsTtl * 60000) refresh(); else render();
    }, 30000);
  }

  function mount() {
    const sidebar = document.getElementById('sidebar'), btns = document.getElementById('sidebtns');
    if (!sidebar || !btns || sidebar.querySelector('.sb-pane[data-sb=hotlists]')) return;
    if (!document.getElementById('hl-style')) { const s = document.createElement('style'); s.id = 'hl-style'; s.textContent = CSS; document.head.appendChild(s); }
    const pane = document.createElement('div');
    pane.className = 'sb-pane'; pane.dataset.sb = 'hotlists';
    pane.classList.toggle('hidden', sget('sbOpen', 'watchlist') !== 'hotlists');
    sidebar.appendChild(pane);
    const b = document.createElement('button');
    b.dataset.sb = 'hotlists'; b.title = 'Hotlists: top gainers, losers, volatility, gaps, unusual volume';
    b.innerHTML = '<svg class="ico" viewBox="0 0 18 18"><path d="M9 2c.5 3 4 4.5 4 8.5A4 4 0 015 10.5C5 8 6.5 7 7 5c1 1.5 1.5 2.5 1.5 3.5C9.5 7 9.5 4.5 9 2z" /></svg>';
    const sep = btns.querySelector('.lt-sep');
    btns.insertBefore(b, sep || null);
    b.classList.toggle('active', !pane.classList.contains('hidden'));
    if (!pane.classList.contains('hidden')) document.getElementById('layout')?.classList.remove('sb-closed');
    build(pane);
    // panels.js toggles the .hidden class on every .sb-pane when a side button is clicked
    new MutationObserver(() => setVisible(!pane.classList.contains('hidden'))).observe(pane, { attributes: true, attributeFilter: ['class'] });
    C.bus.on('tick', (epic) => { if (S.visible && S.prefs.auto) scheduleRender(); });
    C.bus.on('active-changed', () => { if (S.visible) scheduleRender(); });
    setVisible(!pane.classList.contains('hidden'));
  }

  window.IGHotlists = { refresh: () => refresh(true), get state() { return S; }, metrics, ranked, UNIVERSE };
  const start = () => C.ready.then(() => { const go = () => (document.getElementById('sidebtns') ? mount() : setTimeout(go, 200)); go(); });
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();
})();
