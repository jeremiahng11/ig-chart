/* IG Charts — Pine visuals that the indicator contract cannot express (window.IGPineRender).
 *
 * Worker-backed script indicators (strategy.js workerIndicator) expose def.pineExtras(symbol, tfSec, params) →
 * { barColors, candles, tables, times }. This module draws them on every ChartView of window.IGApp without touching chartview's
 * own layers:
 *  - plotcandle() / plotbar(): a canvas under the study layer of the study's pane, culled to the visible bars; prices map through
 *    the study's (transparent) "<title> H" output series so pane and overlay scales both work.
 *  - table.*: an HTML overlay anchored to the pane's plot area (9 positions; the table's state after the last bar).
 *  - barcolor(): barColors(view, bars) returns per-bar colours for chartview's main candle series (see the hook in toSeriesData).
 *  - polyline.new(): straight or curved (Catmull-Rom spline through the points) paths, optionally closed / filled.
 *  - fill(..., top_value, bottom_value, top_color, bottom_color): per-bar vertical gradients between two plots / hlines.
 * One requestAnimationFrame loop; it redraws a canvas only when the visible range, size, scale or data changed.
 */
(() => {
  'use strict';
  const G = window;
  const ok = Number.isFinite;
  const SIZE = { auto: 12, tiny: 8, small: 10, normal: 12, large: 16, huge: 22 };
  const POS = ['top_left', 'top_center', 'top_right', 'middle_left', 'middle_center', 'middle_right', 'bottom_left', 'bottom_center', 'bottom_right'];
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  const IND = () => G.IGInd;
  function tfOf(view, st) {
    if (!st.tf || st.tf === view.state.interval) return view.tfSec;
    const sp = G.IGC && G.IGC.iv && G.IGC.iv.parse(st.tf);
    return sp && sp.kind === 'time' ? sp.sec : 60;
  }
  // [{ st, def, rt, x: extras }] for the visible worker-backed Pine studies of a view
  function studies(view) {
    const out = [], ind = IND();
    if (!ind || !view || !view.state || !view.rts) return out;
    for (const st of view.state.studies || []) {
      if (st.visible === false) continue;
      const def = ind.BY_ID[st.id];
      if (!def || typeof def.pineExtras !== 'function') continue;
      const x = def.pineExtras(view.state.symbol, tfOf(view, st), st.params);
      if (x) out.push({ st, def, rt: view.rts.get(st.uid), x });
    }
    return out;
  }
  // index into x.times of the bar containing time t (latest bar starting at or before t), or -1
  function at(times, t) {
    let lo = 0, hi = times.length - 1, r = -1;
    while (lo <= hi) { const m = (lo + hi) >> 1; if (times[m] <= t) { r = m; lo = m + 1; } else hi = m - 1; }
    return r;
  }

  // ── barcolor ──────────────────────────────────────────
  // Per-bar colours for `bars` (the main series' bars), or null. The last study with barcolor() wins where several set one.
  function barColors(view, bars) {
    if (!bars || !bars.length) return null;
    let res = null;
    for (const s of studies(view)) {
      const bc = s.x.barColors, T = s.x.times;
      if (!bc || !T) continue;
      if (!res) res = new Array(bars.length).fill(null);
      const exact = T.length === bars.length && T[0] === bars[0].time && T[T.length - 1] === bars[bars.length - 1].time;
      for (let i = 0; i < bars.length; i++) {
        const j = exact ? i : at(T, bars[i].time);
        const c = j >= 0 && (exact || T[j] === bars[i].time || s.st.tf) ? bc[j] : null;
        if (c) res[i] = c;
      }
    }
    return res;
  }

  // ── per-pane layers ───────────────────────────────────
  const layers = new WeakMap(); // pane element → { canvas, tables, sig, tsig }
  function layerOf(el) {
    let L = layers.get(el);
    if (L && L.canvas.isConnected) return L;
    const canvas = document.createElement('canvas');
    canvas.className = 'pine-layer';
    canvas.style.cssText = 'position:absolute;left:0;top:0;pointer-events:none;z-index:1';
    const tables = document.createElement('div');
    tables.className = 'pine-tables';
    tables.style.cssText = 'position:absolute;left:0;top:0;pointer-events:none;z-index:3;display:grid;grid-template-columns:1fr 1fr 1fr;grid-template-rows:1fr 1fr 1fr;padding:6px;box-sizing:border-box';
    tables.innerHTML = POS.map((p) => `<div data-pos="${p}" style="display:flex;flex-direction:column;gap:4px;align-items:${/left/.test(p) ? 'flex-start' : /right/.test(p) ? 'flex-end' : 'center'};justify-content:${/^top/.test(p) ? 'flex-start' : /^bottom/.test(p) ? 'flex-end' : 'center'};min-width:0;min-height:0"></div>`).join('');
    const ref = el.querySelector('.study-layer');
    el.insertBefore(canvas, ref || null);
    el.appendChild(tables);
    L = { canvas, tables, sig: '', tsig: '' };
    layers.set(el, L);
    return L;
  }

  function tableHTML(t, pw, ph) {
    const span = new Map(), covered = new Set();
    for (const m of t.merges || []) {
      span.set(m.r0 * t.cols + m.c0, { cs: m.c1 - m.c0 + 1, rs: m.r1 - m.r0 + 1 });
      for (let r = m.r0; r <= m.r1; r++) for (let c = m.c0; c <= m.c1; c++) if (r !== m.r0 || c !== m.c0) covered.add(r * t.cols + c);
    }
    const cells = new Map((t.cells || []).map((x) => [x.r * t.cols + x.c, x]));
    const bw = t.borderW > 0 && t.border ? `${t.borderW}px solid ${t.border}` : 'none';
    let h = `<table style="border-collapse:collapse;${t.bg ? `background:${t.bg};` : ''}${t.frameW > 0 && t.frame ? `outline:${t.frameW}px solid ${t.frame};outline-offset:-${t.frameW}px;` : ''}font:12px -apple-system,BlinkMacSystemFont,sans-serif;max-width:${pw}px">`;
    for (let r = 0; r < t.rows; r++) {
      let row = '';
      for (let c = 0; c < t.cols; c++) {
        const k = r * t.cols + c;
        if (covered.has(k)) continue;
        const x = cells.get(k), sp = span.get(k);
        const st = [`border:${bw}`, 'padding:2px 6px', 'white-space:pre'];
        if (x) {
          if (x.bg) st.push(`background:${x.bg}`);
          st.push(`color:${x.tc || 'transparent'}`, `text-align:${x.halign === 'left' ? 'left' : x.halign === 'right' ? 'right' : 'center'}`, `vertical-align:${x.valign === 'top' ? 'top' : x.valign === 'bottom' ? 'bottom' : 'middle'}`);
          st.push(`font-size:${typeof x.size === 'number' ? x.size : SIZE[x.size] || 12}px`);
          if (x.mono) st.push('font-family:ui-monospace,Menlo,monospace');
          if (x.width > 0) st.push(`width:${Math.round((x.width / 100) * pw)}px`);
          if (x.height > 0) st.push(`height:${Math.round((x.height / 100) * ph)}px`);
        }
        row += `<td${sp ? ` colspan="${sp.cs}" rowspan="${sp.rs}"` : ''}${x && x.tooltip ? ` title="${esc(x.tooltip)}"` : ''} style="${st.join(';')}">${x ? esc(x.text).replace(/\n/g, '<br>') : ''}</td>`;
      }
      h += `<tr>${row}</tr>`;
    }
    return `${h}</table>`;
  }

  function drawCandles(g, view, chart, list, pw, ph) {
    const ts = chart.timeScale(), vr = ts.getVisibleLogicalRange(), basis = view.basis || [];
    if (!vr || !basis.length) return;
    const i0 = Math.max(0, Math.floor(vr.from) - 1), i1 = Math.min(basis.length - 1, Math.ceil(vr.to) + 1);
    const bs = ts.options().barSpacing || 6, bw = Math.max(1, Math.round(bs * 0.7)), half = bw / 2;
    for (const { s, c } of list) {
      const series = s.rt.series[`${c.k}h`] || s.rt.series[`${c.k}c`];
      if (!series) continue;
      const T = s.x.times;
      for (let i = i0; i <= i1; i++) {
        const j = at(T, basis[i].time);
        if (j < 0) continue;
        const o = c.o[j], h = c.h[j], l = c.l[j], cl = c.c[j];
        if (!ok(o) || !ok(h) || !ok(l) || !ok(cl)) continue;
        const x = ts.logicalToCoordinate(i);
        if (x == null || x < -bs || x > pw + bs) continue;
        const yo = series.priceToCoordinate(o), yh = series.priceToCoordinate(h), yl = series.priceToCoordinate(l), yc = series.priceToCoordinate(cl);
        if (yo == null || yh == null || yl == null || yc == null) continue;
        const col = c.color[j] || '#2196F3';
        const xr = Math.round(x) + 0.5;
        if (c.kind === 'bar') {
          g.strokeStyle = col; g.lineWidth = 1; g.beginPath();
          g.moveTo(xr, yh); g.lineTo(xr, yl);
          g.moveTo(xr - Math.max(2, half), yo); g.lineTo(xr, yo);
          g.moveTo(xr, yc); g.lineTo(xr + Math.max(2, half), yc);
          g.stroke();
          continue;
        }
        g.strokeStyle = (c.wick && c.wick[j]) || col; g.lineWidth = 1;
        g.beginPath(); g.moveTo(xr, yh); g.lineTo(xr, yl); g.stroke();
        const top = Math.min(yo, yc), hgt = Math.max(1, Math.abs(yc - yo));
        g.fillStyle = col; g.fillRect(Math.round(x - half), top, bw, hgt);
        const bc = c.border && c.border[j];
        if (bc && bc !== col && bw > 2) { g.strokeStyle = bc; g.strokeRect(Math.round(x - half) + 0.5, top + 0.5, bw - 1, Math.max(0, hgt - 1)); }
      }
    }
  }

  // prices of a study map to y through one of its own series (same price scale), else the main series on the main pane
  function yMapper(view, s, main, key) {
    const series = (key && s.rt.series[key]) || (main ? view.overlay : null) || Object.values(s.rt.series || {})[0];
    return series ? (p) => series.priceToCoordinate(p) : null;
  }
  const DASH = [[], [6, 4], [2, 3]];
  // Catmull-Rom spline through pts (pixel space) as cubic Béziers; closed curves wrap around.
  function splinePath(g, pts, closed) {
    const n = pts.length, P = (k) => (closed ? pts[(k + n) % n] : pts[Math.max(0, Math.min(n - 1, k))]);
    g.moveTo(pts[0].x, pts[0].y);
    for (let k = 0; k < (closed ? n : n - 1); k++) {
      const p0 = P(k - 1), p1 = P(k), p2 = P(k + 1), p3 = P(k + 2);
      g.bezierCurveTo(p1.x + (p2.x - p0.x) / 6, p1.y + (p2.y - p0.y) / 6, p2.x - (p3.x - p1.x) / 6, p2.y - (p3.y - p1.y) / 6, p2.x, p2.y);
    }
    if (closed) g.closePath();
  }
  function drawPolylines(g, view, chart, list) {
    for (const { s, main, pl } of list) {
      const Y = yMapper(view, s, main);
      if (!Y) continue;
      const pts = [];
      for (const q of pl.pts) {
        const l = view.timeToLogical(q.t), x = l == null ? null : view.logicalToX(l, chart), y = Y(q.p);
        if (x != null && y != null) pts.push({ x, y });
      }
      if (pts.length < 2) continue;
      const path = () => {
        g.beginPath();
        if (pl.curved && pts.length > 2) splinePath(g, pts, pl.closed);
        else { pts.forEach((p, k) => (k ? g.lineTo(p.x, p.y) : g.moveTo(p.x, p.y))); if (pl.closed) g.closePath(); }
      };
      if (pl.fill) { path(); g.fillStyle = pl.fill; g.fill(); }
      if (pl.color) { path(); g.strokeStyle = pl.color; g.lineWidth = pl.width || 1; g.setLineDash(DASH[pl.style] || []); g.stroke(); g.setLineDash([]); }
    }
  }
  function drawGradients(g, view, chart, list) {
    const ts = chart.timeScale(), vr = ts.getVisibleLogicalRange(), basis = view.basis || [];
    if (!vr || !basis.length) return;
    const i0 = Math.max(0, Math.floor(vr.from) - 1), i1 = Math.min(basis.length - 1, Math.ceil(vr.to) + 1);
    for (const { s, main, gf } of list) {
      const Y = yMapper(view, s, main, gf.ka), T = s.x.times;
      if (!Y) continue;
      let prev = null;
      for (let i = i0; i <= i1; i++) {
        const j = at(T, basis[i].time), x = ts.logicalToCoordinate(i);
        const cur = j >= 0 && x != null && ok(gf.a[j]) && ok(gf.b[j]) && ok(gf.top[j]) && ok(gf.bot[j]) ? { x, ya: Y(gf.a[j]), yb: Y(gf.b[j]), yt: Y(gf.top[j]), yl: Y(gf.bot[j]), j } : null;
        if (cur && (cur.ya == null || cur.yb == null || cur.yt == null || cur.yl == null)) { prev = null; continue; }
        if (prev && cur && (gf.tc[j] || gf.bc[j])) {
          // the segment between two bars takes the gradient of its right bar (TradingView colours a fill per bar)
          const gr = g.createLinearGradient(0, cur.yt, 0, cur.yt === cur.yl ? cur.yl + 1 : cur.yl);
          gr.addColorStop(0, gf.tc[j] || 'rgba(0,0,0,0)'); gr.addColorStop(1, gf.bc[j] || 'rgba(0,0,0,0)');
          g.fillStyle = gr;
          g.beginPath(); g.moveTo(prev.x, prev.ya); g.lineTo(cur.x, cur.ya); g.lineTo(cur.x, cur.yb); g.lineTo(prev.x, prev.yb); g.closePath(); g.fill();
        }
        prev = cur;
      }
    }
  }
  const ids = new WeakMap();
  let idSeq = 0;
  const idOf = (o) => { if (!o) return 0; let k = ids.get(o); if (!k) ids.set(o, (k = ++idSeq)); return k; };

  // ── frame loop ────────────────────────────────────────
  function renderView(view) {
    const all = studies(view);
    const byPane = new Map(); // pane element → { chart, items: [] }
    const mainEl = view.q && view.q('.pane.main');
    for (const s of all) {
      if (!s.rt) continue;
      const pane = s.rt.pane, el = pane ? pane.canvas && pane.canvas.parentElement : mainEl;
      if (!el) continue;
      if (!byPane.has(el)) byPane.set(el, { chart: pane ? pane.chart : view.chart, main: !pane, items: [] });
      byPane.get(el).items.push(s);
    }
    // panes that had layers but no longer show anything are cleared
    const els = [mainEl, ...(view.panes || []).map((p) => p.canvas && p.canvas.parentElement)].filter(Boolean);
    for (const el of els) {
      const L = layers.get(el);
      if (!L) continue;
      if (!byPane.has(el)) {
        if (L.sig) { L.canvas.getContext('2d').clearRect(0, 0, L.canvas.width, L.canvas.height); L.sig = ''; }
        if (L.tsig) { for (const d of L.tables.children) d.innerHTML = ''; L.tsig = ''; }
      }
    }
    for (const [el, P] of byPane) {
      const L = layerOf(el), chart = P.chart;
      const W = el.clientWidth, H = el.clientHeight;
      let pw = W, ph = H;
      try { pw = W - chart.priceScale('right').width(); ph = H - (chart.timeScale().options().visible ? chart.timeScale().height() : 0); } catch (e) { /* chart not laid out yet */ }
      // tables
      const tables = P.items.flatMap((s) => s.x.tables || []);
      const tsig = `${pw}x${ph}:${JSON.stringify(tables)}`;
      if (tsig !== L.tsig) {
        L.tsig = tsig;
        L.tables.style.width = `${Math.max(0, pw)}px`; L.tables.style.height = `${Math.max(0, ph)}px`;
        const slots = {};
        for (const t of tables) (slots[POS.includes(t.position) ? t.position : 'top_right'] ||= []).push(tableHTML(t, pw, ph));
        for (const d of L.tables.children) d.innerHTML = (slots[d.dataset.pos] || []).join('');
      }
      // candles
      const list = [], plist = [], glist = [];
      for (const s of P.items) {
        for (const c of s.x.candles || []) list.push({ s, c });
        for (const pl of s.x.polylines || []) plist.push({ s, main: P.main, pl });
        for (const gf of s.x.gradFills || []) glist.push({ s, main: P.main, gf });
      }
      const dpr = window.devicePixelRatio || 1;
      let sig = '';
      if (list.length || plist.length || glist.length) {
        const vr = chart.timeScale().getVisibleLogicalRange(), s0 = list.length ? list[0].s.rt.series[`${list[0].c.k}h`] : null;
        const y1 = s0 ? s0.priceToCoordinate(list[0].c.h.find(ok) || 0) : 0;
        const ym = plist.length || glist.length ? P.items.map((x) => { const Y = yMapper(view, x, P.main); return Y ? `${Y(1)}/${Y(100)}` : ''; }).join(',') : '';
        sig = `${W}x${H}@${dpr}:${vr ? `${vr.from.toFixed(3)},${vr.to.toFixed(3)}` : ''}:${chart.timeScale().options().barSpacing}:${y1}:${ym}:${view.basis ? view.basis.length : 0}:${list.map((x) => x.s.x.times.length + (x.s.x.times[0] || 0) + x.c.c[x.c.c.length - 1]).join(',')}:${P.items.map((x) => `${idOf(x.x.polylines)}.${idOf(x.x.gradFills)}`).join(',')}`;
      }
      if (sig === L.sig) continue;
      L.sig = sig;
      const cv = L.canvas;
      if (cv.width !== Math.round(W * dpr) || cv.height !== Math.round(H * dpr)) { cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr); cv.style.width = `${W}px`; cv.style.height = `${H}px`; }
      const g = cv.getContext('2d');
      g.setTransform(dpr, 0, 0, dpr, 0, 0); g.clearRect(0, 0, W, H);
      if (!list.length && !plist.length && !glist.length) continue;
      g.save(); g.beginPath(); g.rect(0, 0, pw, ph); g.clip();
      try {
        if (glist.length) drawGradients(g, view, chart, glist);
        if (list.length) drawCandles(g, view, chart, list, pw, ph);
        if (plist.length) drawPolylines(g, view, chart, plist);
      } catch (e) { console.warn('[pine-render]', e); }
      g.restore();
    }
  }
  function frame() {
    requestAnimationFrame(frame);
    const app = G.IGApp;
    if (!app || !app.views) return;
    for (const v of app.views) { try { renderView(v); } catch (e) { /* a view mid-rebuild */ } }
  }
  if (typeof requestAnimationFrame === 'function' && typeof document !== 'undefined') requestAnimationFrame(frame);

  G.IGPineRender = { barColors, studies, tableHTML, _internal: { splinePath, drawPolylines, drawGradients } };
})();
