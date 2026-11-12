/* IG Charts — indicator library (window.IGInd).
 * Def: { id, name, short, kind: 'overlay'|'pane'|'volume', category, params[], outputs[], levels?, range?, fills?, calc(candles, params, ctx) }
 * ctx = { src(name) → number[], tfSec, symbol, decimals }; when absent a built-in src is used.
 * calc returns { [outputKey]: number[] (NaN = gap), colors?, markers?, graphics? }.
 * Volume is IG tick volume (count of price updates), not traded volume.
 */
(() => {
  const NA = NaN;
  const ok = Number.isFinite;
  const nan = (n) => new Array(n).fill(NA);
  const DAY = 86400;
  const UP = '#26a69a', DN = '#ef5350';

  function baseSrc(c) {
    const cache = {};
    return (s) => {
      if (cache[s]) return cache[s];
      let f;
      switch (s) {
        case 'open': f = (x) => x.open; break;
        case 'high': f = (x) => x.high; break;
        case 'low': f = (x) => x.low; break;
        case 'hl2': f = (x) => (x.high + x.low) / 2; break;
        case 'hlc3': f = (x) => (x.high + x.low + x.close) / 3; break;
        case 'ohlc4': f = (x) => (x.open + x.high + x.low + x.close) / 4; break;
        case 'volume': f = (x) => x.volume || 0; break;
        default: f = (x) => x.close;
      }
      return (cache[s] = c.map(f));
    };
  }
  // Indicator-on-indicator: a source may be 'study:<uid>:<outputKey>', resolved from ctx.studySeries
  // ({ [uid]: { name, outputs: { [key]: number[] | Float64Array aligned 1:1 with candles } } }).
  // A missing source falls back to close and records a warning (collected by IGInd.run).
  let warnSink = null;
  const parseStudySrc = (s) => { const m = typeof s === 'string' ? /^study:([^:]+):(.+)$/.exec(s) : null; return m ? { uid: m[1], key: m[2] } : null; };
  const getSrc = (c, ctx) => {
    const b = baseSrc(c), ext = ctx && typeof ctx.src === 'function' ? ctx.src : null, series = ctx && ctx.studySeries;
    return (s) => {
      const ref = parseStudySrc(s);
      if (ref && series) {
        const st = series[ref.uid], a = st && st.outputs && st.outputs[ref.key];
        if (a && a.length === c.length) return Array.from(a, (v) => (v == null ? NaN : +v));
        if (warnSink) warnSink.add(`Source ${st ? `${st.name || ref.uid} → ${ref.key}` : ref.uid} is unavailable; using close`);
        return b('close');
      }
      if (ext) { const a = ext(s); if (a && a.length === c.length) return a; }
      if (ref && warnSink) warnSink.add(`Source study ${ref.uid} is unavailable; using close`);
      return b(s);
    };
  };
  const cols = (c) => ({ o: c.map((x) => x.open), h: c.map((x) => x.high), l: c.map((x) => x.low), cl: c.map((x) => x.close), v: c.map((x) => x.volume || 0) });
  function tfOf(c, ctx) {
    if (ctx && ctx.tfSec > 0) return ctx.tfSec;
    const d = [];
    for (let i = 1; i < Math.min(c.length, 101); i++) { const x = c[i].time - c[i - 1].time; if (x > 0) d.push(x); }
    if (!d.length) return 60;
    d.sort((a, b) => a - b);
    return d[d.length >> 1];
  }
  function fmtP(ctx, c, p) {
    let d = ctx && Number.isInteger(ctx.decimals) ? ctx.decimals : null;
    if (d === null) { const ref = Math.abs(c.length ? c[c.length - 1].close : p); d = ref >= 1000 ? 1 : ref >= 100 ? 2 : ref >= 10 ? 3 : 5; }
    return ok(p) ? p.toFixed(d) : '';
  }

  // ── ta helpers ─────────────────────────────────────────
  function sma(a, n) {
    const out = nan(a.length);
    let sum = 0, cnt = 0;
    for (let i = 0; i < a.length; i++) {
      if (ok(a[i])) { sum += a[i]; cnt++; }
      if (i >= n && ok(a[i - n])) { sum -= a[i - n]; cnt--; }
      if (i >= n - 1 && cnt === n) out[i] = sum / n;
    }
    return out;
  }
  const rsum = (a, n) => sma(a, n).map((v) => v * n);
  // EMA/RMA seeded with the SMA of the first n valid values (Pine semantics)
  function smooth(a, n, alpha) {
    const out = nan(a.length);
    let prev = NA, seen = 0, sum = 0;
    for (let i = 0; i < a.length; i++) {
      const v = a[i];
      if (!ok(v)) continue;
      if (!ok(prev)) {
        sum += v; seen++;
        if (seen === n) { prev = sum / n; out[i] = prev; }
        continue;
      }
      prev = alpha * v + (1 - alpha) * prev;
      out[i] = prev;
    }
    return out;
  }
  const ema = (a, n) => smooth(a, n, 2 / (n + 1));
  const rma = (a, n) => smooth(a, n, 1 / n);
  function wma(a, n) {
    const out = nan(a.length), d = (n * (n + 1)) / 2;
    for (let i = n - 1; i < a.length; i++) {
      let s = 0, good = true;
      for (let k = 0; k < n; k++) { const v = a[i - k]; if (!ok(v)) { good = false; break; } s += v * (n - k); }
      if (good) out[i] = s / d;
    }
    return out;
  }
  function stdev(a, n) {
    const m = sma(a, n);
    return a.map((_, i) => {
      if (!ok(m[i])) return NA;
      let acc = 0;
      for (let k = 0; k < n; k++) acc += (a[i - k] - m[i]) ** 2;
      return Math.sqrt(acc / n);
    });
  }
  function highest(a, n) {
    const out = nan(a.length);
    for (let i = n - 1; i < a.length; i++) { let m = -Infinity; for (let k = 0; k < n; k++) m = Math.max(m, a[i - k]); out[i] = m; }
    return out;
  }
  function lowest(a, n) {
    const out = nan(a.length);
    for (let i = n - 1; i < a.length; i++) { let m = Infinity; for (let k = 0; k < n; k++) m = Math.min(m, a[i - k]); out[i] = m; }
    return out;
  }
  const tr = (c) => c.map((x, i) => (i === 0 ? x.high - x.low : Math.max(x.high - x.low, Math.abs(x.high - c[i - 1].close), Math.abs(x.low - c[i - 1].close))));
  const atr = (c, n) => rma(tr(c), n);
  const change = (a, n = 1) => a.map((v, i) => (i >= n ? v - a[i - n] : NA));
  const roc = (a, n) => a.map((v, i) => (i >= n && a[i - n] ? (100 * (v - a[i - n])) / a[i - n] : NA));
  function rsi(a, n) {
    const up = a.map((v, i) => (i === 0 ? NA : Math.max(v - a[i - 1], 0)));
    const dn = a.map((v, i) => (i === 0 ? NA : Math.max(a[i - 1] - v, 0)));
    const ru = rma(up, n), rd = rma(dn, n);
    return ru.map((u, i) => { const d = rd[i]; if (!ok(u) || !ok(d)) return NA; return d === 0 ? 100 : u === 0 ? 0 : 100 - 100 / (1 + u / d); });
  }
  function linreg(a, n, off = 0) {
    const out = nan(a.length), sx = (n * (n - 1)) / 2, sxx = ((n - 1) * n * (2 * n - 1)) / 6, den = n * sxx - sx * sx;
    for (let i = n - 1; i < a.length; i++) {
      let sy = 0, sxy = 0, good = true;
      for (let k = 0; k < n; k++) { const v = a[i - n + 1 + k]; if (!ok(v)) { good = false; break; } sy += v; sxy += k * v; }
      if (!good) continue;
      const slope = den ? (n * sxy - sx * sy) / den : 0, icpt = (sy - slope * sx) / n;
      out[i] = icpt + slope * (n - 1 - off);
    }
    return out;
  }
  const swma = (a) => a.map((v, i) => (i >= 3 ? (a[i - 3] + 2 * a[i - 2] + 2 * a[i - 1] + v) / 6 : NA));
  const cum = (a) => { let s = 0; return a.map((v) => (s += ok(v) ? v : 0)); };
  function percentrank(a, n) {
    const out = nan(a.length);
    for (let i = n; i < a.length; i++) {
      if (!ok(a[i])) continue;
      let cnt = 0, good = true;
      for (let k = 1; k <= n; k++) { const v = a[i - k]; if (!ok(v)) { good = false; break; } if (v <= a[i]) cnt++; }
      if (good) out[i] = (100 * cnt) / n;
    }
    return out;
  }
  const sub = (a, b) => a.map((v, i) => v - b[i]);
  const tsiRaw = (s, short, long) => { const pc = change(s); const n = ema(ema(pc, long), short), d = ema(ema(pc.map(Math.abs), long), short); return n.map((v, i) => (d[i] ? v / d[i] : NA)); };
  function alma(a, n, off, sigma) {
    const out = nan(a.length), m = off * (n - 1), s = n / sigma, w = [];
    let norm = 0;
    for (let k = 0; k < n; k++) { w[k] = Math.exp(-((k - m) ** 2) / (2 * s * s)); norm += w[k]; }
    for (let i = n - 1; i < a.length; i++) {
      let sum = 0, good = true;
      for (let k = 0; k < n; k++) { const v = a[i - n + 1 + k]; if (!ok(v)) { good = false; break; } sum += v * w[k]; }
      if (good) out[i] = sum / norm;
    }
    return out;
  }
  const hma = (a, n) => wma(sub(wma(a, Math.max(1, Math.floor(n / 2))).map((v) => 2 * v), wma(a, n)), Math.max(1, Math.floor(Math.sqrt(n))));
  const vwmaF = (a, v, n) => { const pv = sma(a.map((x, i) => x * v[i]), n), vv = sma(v, n); return pv.map((x, i) => (vv[i] ? x / vv[i] : NA)); };
  const MA_TYPES = ['SMA', 'EMA', 'SMMA (RMA)', 'WMA', 'VWMA', 'HMA'];
  const maBy = (type, a, n, vol) => (type === 'EMA' ? ema(a, n) : type === 'WMA' ? wma(a, n) : type === 'SMMA (RMA)' || type === 'RMA' ? rma(a, n) : type === 'HMA' ? hma(a, n) : type === 'VWMA' && vol ? vwmaF(a, vol, n) : sma(a, n));

  // ── periods / profiles / swings ─────────────────────────
  const PERIODS = ['Day', 'Week', 'Month', 'Year'];
  const periodKey = (t, per) => {
    if (per === 'Day') return Math.floor(t / DAY);
    if (per === 'Week') return Math.floor((t / DAY + 3) / 7);
    const d = new Date(t * 1000);
    return per === 'Month' ? d.getUTCFullYear() * 12 + d.getUTCMonth() : d.getUTCFullYear();
  };
  const periodEnd = (k, per) => (per === 'Day' ? (k + 1) * DAY : per === 'Week' ? (7 * k + 4) * DAY : per === 'Month' ? Date.UTC(Math.floor((k + 1) / 12), (k + 1) % 12, 1) / 1000 : Date.UTC(k + 1, 0, 1) / 1000);
  function groups(c, keyOf) {
    const g = [];
    for (let i = 0; i < c.length; i++) {
      const x = c[i], k = keyOf(x.time), last = g[g.length - 1];
      if (!last || last.key !== k) { g.push({ key: k, i0: i, i1: i, open: NA, high: NA, low: NA, close: NA }); }
      const cur = g[g.length - 1];
      cur.i1 = i;
      // bars with non-finite prices keep their slot but never poison the period's OHLC
      if (ok(x.open) && !ok(cur.open)) cur.open = x.open;
      if (ok(x.high)) cur.high = ok(cur.high) ? Math.max(cur.high, x.high) : x.high;
      if (ok(x.low)) cur.low = ok(cur.low) ? Math.min(cur.low, x.low) : x.low;
      if (ok(x.close)) cur.close = x.close;
    }
    return g;
  }
  function valueArea(tot, poc, pct) {
    const total = tot.reduce((s, v) => s + v, 0), target = total * pct;
    let a = poc, b = poc, acc = tot[poc];
    while (acc < target && (a > 0 || b < tot.length - 1)) {
      const above = b < tot.length - 1 ? tot[b + 1] : -1, below = a > 0 ? tot[a - 1] : -1;
      if (above >= below) acc += tot[++b]; else acc += tot[--a];
    }
    return [a, b];
  }
  function rangeOf(c, i0, i1) {
    let lo = Infinity, hi = -Infinity;
    for (let i = i0; i <= i1; i++) { if (c[i].low < lo) lo = c[i].low; if (c[i].high > hi) hi = c[i].high; }
    if (!(hi > lo)) { const e = Math.abs(lo) * 1e-4 || 1e-4; lo -= e; hi += e; }
    return [lo, hi];
  }
  function volProfile(c, i0, i1, rows, vaPct) {
    const [lo, hi] = rangeOf(c, i0, i1), step = (hi - lo) / rows, up = new Array(rows).fill(0), dn = new Array(rows).fill(0);
    let total = 0;
    for (let i = i0; i <= i1; i++) total += c[i].volume > 0 ? c[i].volume : 0;
    const clamp = (r) => Math.min(rows - 1, Math.max(0, r));
    for (let i = i0; i <= i1; i++) {
      const x = c[i], v = total ? (x.volume > 0 ? x.volume : 0) : 1;
      if (!v) continue;
      const tgt = x.close >= x.open ? up : dn, r0 = clamp(Math.floor((x.low - lo) / step)), r1 = clamp(Math.floor((x.high - lo) / step));
      if (r0 === r1 || !(x.high > x.low)) { tgt[r0] += v; continue; }
      for (let r = r0; r <= r1; r++) {
        const ov = Math.min(x.high, lo + (r + 1) * step) - Math.max(x.low, lo + r * step);
        if (ov > 0) tgt[r] += (v * ov) / (x.high - x.low);
      }
    }
    const tot = up.map((u, r) => u + dn[r]);
    let poc = 0;
    tot.forEach((v, r) => { if (v > tot[poc]) poc = r; });
    const [a, b] = valueArea(tot, poc, vaPct);
    return { rows: tot.map((_, r) => ({ p0: lo + r * step, p1: lo + (r + 1) * step, up: up[r], down: dn[r] })), poc: lo + (poc + 0.5) * step, vah: lo + (b + 1) * step, val: lo + a * step };
  }
  const TPO_CH = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
  function tpoProfile(c, i0, i1, rows, vaPct, t0, perSec) {
    const [lo, hi] = rangeOf(c, i0, i1), step = (hi - lo) / rows, letters = Array.from({ length: rows }, () => []), last = new Array(rows).fill(-1);
    const clamp = (r) => Math.min(rows - 1, Math.max(0, r));
    for (let i = i0; i <= i1; i++) {
      const x = c[i], per = Math.max(0, Math.floor((x.time - t0) / perSec)), ch = TPO_CH[per % TPO_CH.length];
      const r0 = clamp(Math.floor((x.low - lo) / step)), r1 = clamp(Math.ceil((x.high - lo) / step) - 1);
      for (let r = r0; r <= Math.max(r0, r1); r++) if (last[r] !== per) { letters[r].push(ch); last[r] = per; }
    }
    const tot = letters.map((l) => l.length);
    let poc = 0;
    tot.forEach((v, r) => { if (v > tot[poc]) poc = r; });
    const [a, b] = valueArea(tot, poc, vaPct);
    return { rows: letters.map((l, r) => ({ p0: lo + r * step, p1: lo + (r + 1) * step, letters: l.join('') })), poc: lo + (poc + 0.5) * step, vah: lo + (b + 1) * step, val: lo + a * step };
  }
  // alternating swing pivots (ZigZag-style); type 1 = high, -1 = low
  function swings(c, depth, devPct = 0) {
    const n = c.length, z = [];
    const push = (q) => {
      const last = z[z.length - 1];
      if (!last) { z.push(q); return; }
      if (q.type === last.type) { if ((q.type === 1 && q.p > last.p) || (q.type === -1 && q.p < last.p)) z[z.length - 1] = q; return; }
      if (q.i === last.i) return;
      if (devPct > 0 && (Math.abs(q.p - last.p) / Math.abs(last.p)) * 100 < devPct) return;
      z.push(q);
    };
    for (let i = depth; i < n - depth; i++) {
      const h = c[i].high, l = c[i].low;
      if (!ok(h) || !ok(l)) continue;
      let isH = true, isL = true;
      for (let k = 1; k <= depth && (isH || isL); k++) {
        if (c[i - k].high > h || c[i + k].high >= h) isH = false;
        if (c[i - k].low < l || c[i + k].low <= l) isL = false;
      }
      if (isH) push({ i, t: c[i].time, p: h, type: 1 });
      if (isL) push({ i, t: c[i].time, p: l, type: -1 });
    }
    return z;
  }

  // ── param / output factories ────────────────────────────
  const SOURCES = ['close', 'open', 'high', 'low', 'hl2', 'hlc3', 'ohlc4', 'volume'];
  const P = {
    len: (d, label = 'Length') => ({ k: 'length', label, type: 'int', def: d, min: 1, max: 1000 }),
    src: (d = 'close', k = 'source', label = 'Source') => ({ k, label, type: 'source', def: d }),
    num: (k, label, d, step = 0.1, min = 0) => ({ k, label, type: 'number', def: d, step, min }),
    int: (k, label, d, min = 1, max = 1000) => ({ k, label, type: 'int', def: d, min, max }),
    bool: (k, label, d = true) => ({ k, label, type: 'bool', def: d }),
    sel: (k, label, options, d = options[0]) => ({ k, label, type: 'select', options, def: d }),
    color: (k, label, d) => ({ k, label, type: 'color', def: d }),
    time: (k, label) => ({ k, label, type: 'time', def: 0 }),
    ma: (d = 'SMA', k = 'maType', label = 'MA Type') => ({ k, label, type: 'select', options: MA_TYPES, def: d }),
  };
  const line = (k, label, color, extra = {}) => ({ k, label, color, type: 'line', width: 1, style: 0, ...extra });
  const hist = (k, label, color = UP, extra = {}) => ({ k, label, type: 'histogram', color, colorDown: DN, ...extra });
  const updown = (a) => a.map((v) => (v >= 0 ? 'up' : 'down'));
  const rising = (a) => a.map((v, i) => (i && v >= a[i - 1] ? 'up' : 'down'));
  const lastT = (c) => (c.length ? c[c.length - 1].time : 0);
  const anchorIdx = (c, t) => { if (!t) return 0; for (let i = 0; i < c.length; i++) if (c[i].time >= t) return i; return c.length; };

  const MA = (id, name, short, color, len, fn, cat = 'Moving averages', extraParams = []) => ({
    id, name, short, kind: 'overlay', category: cat, params: [P.len(len), P.src(), ...extraParams], outputs: [line('v', short, color)],
    calc: (c, p, ctx) => ({ v: fn(getSrc(c, ctx)(p.source), p, c, ctx) }),
  });

  function bands(m, d, mult) { return { upper: m.map((v, i) => v + mult * d[i]), lower: m.map((v, i) => v - mult * d[i]) }; }

  // ── pivot points ────────────────────────────────────────
  function pivotLevels(type, H, L, C, O, Ocur) {
    const R = H - L;
    if (type === 'Fibonacci') { const P0 = (H + L + C) / 3; return { P: P0, R1: P0 + 0.382 * R, R2: P0 + 0.618 * R, R3: P0 + R, S1: P0 - 0.382 * R, S2: P0 - 0.618 * R, S3: P0 - R }; }
    if (type === 'Woodie') { const P0 = (H + L + 2 * Ocur) / 4, R3 = H + 2 * (P0 - L), S3 = L - 2 * (H - P0); return { P: P0, R1: 2 * P0 - L, R2: P0 + R, R3, R4: R3 + R, S1: 2 * P0 - H, S2: P0 - R, S3, S4: S3 - R }; }
    if (type === 'Classic') { const P0 = (H + L + C) / 3; return { P: P0, R1: 2 * P0 - L, R2: P0 + R, R3: P0 + 2 * R, R4: P0 + 3 * R, S1: 2 * P0 - H, S2: P0 - R, S3: P0 - 2 * R, S4: P0 - 3 * R }; }
    if (type === 'DM') { const X = C < O ? H + 2 * L + C : C > O ? 2 * H + L + C : H + L + 2 * C; return { P: X / 4, R1: X / 2 - L, S1: X / 2 - H }; }
    if (type === 'Camarilla') {
      const P0 = (H + L + C) / 3, k = 1.1 * R, R4 = C + k / 2, R3 = C + k / 4, S4 = C - k / 2, S3 = C - k / 4;
      return { P: P0, R1: C + k / 12, R2: C + k / 6, R3, R4, R5: R4 + 1.168 * (R4 - R3), S1: C - k / 12, S2: C - k / 6, S3, S4, S5: S4 - 1.168 * (S3 - S4) };
    }
    const P0 = (H + L + C) / 3;
    return { P: P0, R1: 2 * P0 - L, S1: 2 * P0 - H, R2: P0 + R, S2: P0 - R, R3: 2 * P0 + (H - 2 * L), S3: 2 * P0 - (2 * H - L), R4: 3 * P0 + (H - 3 * L), S4: 3 * P0 - (3 * H - L), R5: 4 * P0 + (H - 4 * L), S5: 4 * P0 - (4 * H - L) };
  }
  const autoPeriod = (tf) => (tf <= 900 ? 'Day' : tf < DAY ? 'Week' : tf < 7 * DAY ? 'Month' : 'Year');

  // ── candlestick patterns ────────────────────────────────
  const CANDLE_PATTERNS = [
    ['doji', 'Doji'], ['hammer', 'Hammer'], ['invHammer', 'Inverted Hammer'], ['hangingMan', 'Hanging Man'], ['shootingStar', 'Shooting Star'],
    ['bullEngulfing', 'Bullish Engulfing'], ['bearEngulfing', 'Bearish Engulfing'], ['harami', 'Harami (bull/bear)'], ['piercing', 'Piercing Line'],
    ['darkCloud', 'Dark Cloud Cover'], ['morningStar', 'Morning Star'], ['eveningStar', 'Evening Star'], ['threeSoldiers', 'Three White Soldiers'],
    ['threeCrows', 'Three Black Crows'], ['tweezer', 'Tweezer Top/Bottom'], ['marubozu', 'Marubozu'],
  ];
  function candlePatterns(c, p) {
    const n = c.length, body = c.map((x) => Math.abs(x.close - x.open)), avgB = ema(body, 14), ma = p.trendLength > 0 ? sma(c.map((x) => x.close), p.trendLength) : null;
    const markers = [];
    for (let i = 0; i < n; i++) {
      const x = c[i], r = x.high - x.low;
      if (!(r > 0)) continue;
      const b = body[i], top = Math.max(x.open, x.close), bot = Math.min(x.open, x.close), uS = x.high - top, lS = bot - x.low;
      const ab = i && ok(avgB[i - 1]) ? avgB[i - 1] : b, cBull = x.close > x.open, cBear = x.close < x.open;
      const upT = ma ? i > 0 && ok(ma[i - 1]) && c[i - 1].close > ma[i - 1] : true, dnT = ma ? i > 0 && ok(ma[i - 1]) && c[i - 1].close < ma[i - 1] : true;
      const bull = [], bear = [], neu = [];
      const doji = b <= 0.05 * r;
      if (p.doji && doji) neu.push('D');
      const hamShape = !doji && lS >= 2 * b && uS <= 0.1 * r, invShape = !doji && uS >= 2 * b && lS <= 0.1 * r;
      if (p.hammer && hamShape && dnT) bull.push('H');
      if (p.hangingMan && hamShape && upT) bear.push('HM');
      if (p.invHammer && invShape && dnT) bull.push('IH');
      if (p.shootingStar && invShape && upT) bear.push('SS');
      if (p.marubozu && b >= 0.9 * r && b > ab) (cBull ? bull : bear).push('M');
      if (i >= 1) {
        const q = c[i - 1], pb = body[i - 1], pBull = q.close > q.open, pBear = q.close < q.open, mid = (q.open + q.close) / 2, pr = q.high - q.low;
        if (p.bullEngulfing && dnT && pBear && cBull && x.close >= q.open && x.open <= q.close && b > pb) bull.push('BE');
        if (p.bearEngulfing && upT && pBull && cBear && x.close <= q.open && x.open >= q.close && b > pb) bear.push('BE');
        if (p.harami && dnT && pBear && pb > ab && cBull && top <= q.open && bot >= q.close && b < pb) bull.push('Hr');
        if (p.harami && upT && pBull && pb > ab && cBear && top <= q.close && bot >= q.open && b < pb) bear.push('Hr');
        if (p.piercing && dnT && pBear && pb > ab && cBull && x.open < q.close && x.close > mid && x.close < q.open) bull.push('P');
        if (p.darkCloud && upT && pBull && pb > ab && cBear && x.open > q.close && x.close < mid && x.close > q.open) bear.push('DC');
        const tol = 0.05 * Math.max(r, pr);
        if (p.tweezer && dnT && pBear && cBull && Math.abs(x.low - q.low) <= tol) bull.push('TB');
        if (p.tweezer && upT && pBull && cBear && Math.abs(x.high - q.high) <= tol) bear.push('TT');
      }
      if (i >= 2) {
        const a = c[i - 2], m = c[i - 1], ba = body[i - 2], bm = body[i - 1], amid = (a.open + a.close) / 2, mt = Math.max(m.open, m.close), mb = Math.min(m.open, m.close);
        if (p.morningStar && dnT && a.close < a.open && ba > ab && bm < 0.5 * ba && mt < amid && cBull && x.close > amid) bull.push('MS');
        if (p.eveningStar && upT && a.close > a.open && ba > ab && bm < 0.5 * ba && mb > amid && cBear && x.close < amid) bear.push('ES');
        const three = (dir) => [a, m, x].every((y, k) => {
          const by = body[i - 2 + k], sh = dir > 0 ? y.high - y.close : y.close - y.low;
          if (dir * (y.close - y.open) <= 0 || by < 0.5 * ab || sh > 0.3 * by) return false;
          if (!k) return true;
          const pv = [a, m][k - 1];
          return dir > 0 ? y.close > pv.close && y.open > pv.open && y.open <= pv.close : y.close < pv.close && y.open < pv.open && y.open >= pv.close;
        });
        if (p.threeSoldiers && three(1)) bull.push('3WS');
        if (p.threeCrows && three(-1)) bear.push('3BC');
      }
      if (bull.length) markers.push({ time: x.time, position: 'belowBar', shape: 'arrowUp', color: UP, text: bull.join(' ') });
      if (bear.length) markers.push({ time: x.time, position: 'aboveBar', shape: 'arrowDown', color: DN, text: bear.join(' ') });
      if (neu.length) markers.push({ time: x.time, position: 'aboveBar', shape: 'circle', color: '#787b86', text: neu.join(' ') });
    }
    return markers;
  }

  // ── chart patterns ──────────────────────────────────────
  function chartPatterns(c, p) {
    const z = swings(c, p.depth), a14 = atr(c, 14), found = [], tol = p.tolerance;
    const T = (i) => c[i].time, minH = (i) => (ok(a14[i]) ? p.minAtr * a14[i] : 0);
    const BULL = UP, BEAR = DN, NEU = '#2962ff';
    const mk = (name, color, g, at) => ({ name, color, g: [...g, { kind: 'label', t: at.t, p: at.p, text: name, color: '#ffffff', bg: color, align: 'center', base: at.base }] });
    const seg = (q1, q2, color, style = 0) => ({ kind: 'line', t1: q1.t, p1: q1.p, t2: q2.t, p2: q2.p, color, width: 2, style, extend: 'none' });
    function hs(j) {
      const [s1, n1, hd, n2, s2] = z.slice(j - 4, j + 1), d = s1.type;
      const neckOut = d === 1 ? Math.max(n1.p, n2.p) : Math.min(n1.p, n2.p), h = d * (hd.p - (d === 1 ? Math.min(n1.p, n2.p) : Math.max(n1.p, n2.p)));
      if (!(h > minH(hd.i)) || d * (hd.p - s1.p) <= 0.1 * h || d * (hd.p - s2.p) <= 0.1 * h) return null;
      const inner = d === 1 ? Math.min(s1.p, s2.p) : Math.max(s1.p, s2.p);
      if (Math.abs(s1.p - s2.p) > tol * h || d * (inner - neckOut) <= 0) return null;
      const col = d === 1 ? BEAR : BULL, name = d === 1 ? 'Head & Shoulders' : 'Inv. Head & Shoulders';
      const sl = (n2.p - n1.p) / (n2.i - n1.i), neckAt = (i) => n1.p + sl * (i - n1.i);
      return mk(name, col, [seg(s1, n1, col), seg(n1, hd, col), seg(hd, n2, col), seg(n2, s2, col), { kind: 'line', t1: T(s1.i), p1: neckAt(s1.i), t2: T(s2.i), p2: neckAt(s2.i), color: col, width: 1, style: 1, extend: 'none' }], { t: hd.t, p: hd.p, base: d === 1 ? 'bottom' : 'top' });
    }
    function dbl(j) {
      const [x1, m, x2] = z.slice(j - 2, j + 1), d = x1.type, h = d === 1 ? Math.min(x1.p, x2.p) - m.p : m.p - Math.max(x1.p, x2.p);
      if (!(h > minH(x2.i)) || Math.abs(x1.p - x2.p) > tol * h) return null;
      const col = d === 1 ? BEAR : BULL;
      return mk(d === 1 ? 'Double Top' : 'Double Bottom', col, [seg(x1, m, col), seg(m, x2, col), { kind: 'line', t1: x1.t, p1: m.p, t2: x2.t, p2: m.p, color: col, width: 1, style: 1, extend: 'none' }],
        { t: m.t, p: d === 1 ? Math.max(x1.p, x2.p) : Math.min(x1.p, x2.p), base: d === 1 ? 'bottom' : 'top' });
    }
    function trend(j) {
      const w = z.slice(j - 3, j + 1), hs2 = w.filter((q) => q.type === 1), ls2 = w.filter((q) => q.type === -1);
      if (hs2.length !== 2 || ls2.length !== 2) return null;
      const i0 = w[0].i, i1 = w[3].i;
      const at = (pa, pb, i) => pa.p + ((pb.p - pa.p) / (pb.i - pa.i)) * (i - pa.i);
      const hS = at(hs2[0], hs2[1], i0), hE = at(hs2[0], hs2[1], i1), lS = at(ls2[0], ls2[1], i0), lE = at(ls2[0], ls2[1], i1);
      const ws = hS - lS, we = hE - lE, avg = (ws + we) / 2;
      if (!(ws > 0 && we > 0) || !(avg > minH(i1))) return null;
      const dh = hE - hS, dl = lE - lS, flatH = Math.abs(dh) < 0.15 * avg, flatL = Math.abs(dl) < 0.15 * avg;
      let name = null, col = NEU, fam = null;
      if (we < 0.7 * ws) {
        if (flatH && dl > 0) { name = 'Ascending Triangle'; col = BULL; fam = 'triangles'; }
        else if (flatL && dh < 0) { name = 'Descending Triangle'; col = BEAR; fam = 'triangles'; }
        else if (dh < 0 && dl > 0) { name = 'Symmetric Triangle'; fam = 'triangles'; }
        else if (dh > 0 && dl > 0) { name = 'Rising Wedge'; col = BEAR; fam = 'wedges'; }
        else if (dh < 0 && dl < 0) { name = 'Falling Wedge'; col = BULL; fam = 'wedges'; }
      } else if (Math.abs(dh - dl) < 0.2 * avg) {
        const m = (dh + dl) / 2;
        fam = 'channels';
        if (Math.abs(m) < 0.15 * avg) name = 'Horizontal Channel';
        else if (m > 0) { name = 'Channel Up'; col = BULL; } else { name = 'Channel Down'; col = BEAR; }
      }
      if (!name || !p[fam]) return null;
      return mk(name, col, [
        { kind: 'line', t1: T(i0), p1: hS, t2: T(i1), p2: hE, color: col, width: 2, style: 0, extend: 'none' },
        { kind: 'line', t1: T(i0), p1: lS, t2: T(i1), p2: lE, color: col, width: 2, style: 0, extend: 'none' },
      ], { t: T(i1), p: hE, base: 'bottom' });
    }
    let minStart = 0;
    for (let j = 2; j < z.length; j++) {
      let m = null;
      if (p.headShoulders && j >= 4 && j - 4 >= minStart) m = hs(j);
      if (!m && p.doubles && j - 2 >= minStart) m = dbl(j);
      if (!m && j >= 3 && j - 3 >= minStart) m = trend(j);
      if (m) { found.push(m); minStart = j; }
    }
    return found.slice(-p.maxPatterns).flatMap((f) => f.g);
  }

  // ── extended ta helpers ─────────────────────────────────
  const tip = (param, text) => ({ ...param, tip: text });
  const shift = (a, k) => a.map((_, i) => (i - k >= 0 ? a[i - k] : NA));
  const rsumP = (a, n) => rsum(a.map((v) => (ok(v) ? v : NA)), n);
  const mkUp = (t, text, color = UP) => ({ time: t, position: 'belowBar', shape: 'arrowUp', color, text });
  const mkDn = (t, text, color = DN) => ({ time: t, position: 'aboveBar', shape: 'arrowDown', color, text });
  const crossUp = (a, b, i) => i > 0 && ok(a[i]) && ok(b[i]) && ok(a[i - 1]) && ok(b[i - 1]) && a[i - 1] <= b[i - 1] && a[i] > b[i];
  const crossDn = (a, b, i) => crossUp(b, a, i);
  // run a recursive filter over the valid (finite) samples only, then scatter back so NaN gaps stay aligned
  function onValid(s, fn) {
    const idx = [], v = [];
    for (let i = 0; i < s.length; i++) if (ok(s[i])) { idx.push(i); v.push(s[i]); }
    const r = fn(v), scatter = (arr) => { const out = nan(s.length); for (let k = 0; k < idx.length; k++) out[idx[k]] = arr[k]; return out; };
    if (Array.isArray(r)) return scatter(r);
    const o = {};
    for (const k of Object.keys(r)) o[k] = scatter(r[k]);
    return o;
  }
  function lrSlope(a, n) {
    const out = nan(a.length), sx = (n * (n - 1)) / 2, sxx = ((n - 1) * n * (2 * n - 1)) / 6, den = n * sxx - sx * sx;
    if (!den) return out;
    for (let i = n - 1; i < a.length; i++) {
      let sy = 0, sxy = 0, good = true;
      for (let k = 0; k < n; k++) { const v = a[i - n + 1 + k]; if (!ok(v)) { good = false; break; } sy += v; sxy += k * v; }
      if (good) out[i] = (n * sxy - sx * sy) / den;
    }
    return out;
  }
  const trima = (a, n) => sma(sma(a, Math.ceil(n / 2)), Math.floor(n / 2) + 1);
  // Tillson T3: generalized DEMA applied six times with volume factor b
  function t3(a, n, b) {
    const e1 = ema(a, n), e2 = ema(e1, n), e3 = ema(e2, n), e4 = ema(e3, n), e5 = ema(e4, n), e6 = ema(e5, n);
    const c1 = -(b ** 3), c2 = 3 * b * b + 3 * b ** 3, c3 = -6 * b * b - 3 * b - 3 * b ** 3, c4 = 1 + 3 * b + b ** 3 + 3 * b * b;
    return e6.map((v, i) => c1 * v + c2 * e5[i] + c3 * e4[i] + c4 * e3[i]);
  }
  // Ehlers 2-pole Super Smoother
  function superSmoother(a, n) {
    return onValid(a, (x) => {
      const a1 = Math.exp((-1.414 * Math.PI) / n), c2 = 2 * a1 * Math.cos((1.414 * Math.PI) / n), c3 = -a1 * a1, c1 = 1 - c2 - c3, f = new Array(x.length);
      for (let i = 0; i < x.length; i++) f[i] = i < 2 ? x[i] : (c1 * (x[i] + x[i - 1])) / 2 + c2 * f[i - 1] + c3 * f[i - 2];
      return f;
    });
  }
  // Ehlers 2-pole high-pass filter (Cycle Analytics for Traders)
  function highPass2(x, period) {
    const w = (0.707 * 2 * Math.PI) / period, a1 = (Math.cos(w) + Math.sin(w) - 1) / Math.cos(w), hp = new Array(x.length).fill(0);
    for (let i = 2; i < x.length; i++) hp[i] = (1 - a1 / 2) ** 2 * (x[i] - 2 * x[i - 1] + x[i - 2]) + 2 * (1 - a1) * hp[i - 1] - (1 - a1) ** 2 * hp[i - 2];
    return hp;
  }
  function superTrend(c, atrLength, factor) {
    const a = atr(c, atrLength), out = nan(c.length), dir = new Array(c.length).fill(0);
    let pu = NA, pl = NA, pst = NA;
    for (let i = 0; i < c.length; i++) {
      const x = c[i];
      if (!ok(a[i])) { pu = NA; pl = NA; pst = NA; continue; }
      const hl2 = (x.high + x.low) / 2, pc = i ? c[i - 1].close : NA;
      let ub = hl2 + factor * a[i], lb = hl2 - factor * a[i];
      const ppl = ok(pl) ? pl : 0, ppu = ok(pu) ? pu : 0;
      lb = lb > ppl || pc < ppl ? lb : ppl;
      ub = ub < ppu || pc > ppu ? ub : ppu;
      let d;
      if (!ok(a[i - 1])) d = 1;
      else if (pst === pu) d = x.close > ub ? -1 : 1;
      else d = x.close < lb ? 1 : -1;
      const st = d === -1 ? lb : ub;
      out[i] = st; dir[i] = d === -1 ? 1 : -1;
      pu = ub; pl = lb; pst = st;
    }
    return { v: out, dir };
  }
  function dmi(c, diLength, adxSmoothing) {
    const up = c.map((x, i) => (i ? x.high - c[i - 1].high : NA)), dn = c.map((x, i) => (i ? c[i - 1].low - x.low : NA));
    const pdm = up.map((u, i) => (!ok(u) ? NA : u > dn[i] && u > 0 ? u : 0)), mdm = dn.map((d, i) => (!ok(d) ? NA : d > up[i] && d > 0 ? d : 0));
    const trn = c.map((x, i) => (i ? Math.max(x.high - x.low, Math.abs(x.high - c[i - 1].close), Math.abs(x.low - c[i - 1].close)) : NA));
    const fixnan = (a) => { let last = NA; return a.map((v) => (ok(v) ? (last = v) : last)); };
    const t = rma(trn, diLength);
    const plus = fixnan(rma(pdm, diLength).map((v, i) => (100 * v) / t[i])), minus = fixnan(rma(mdm, diLength).map((v, i) => (100 * v) / t[i]));
    const dx = plus.map((v, i) => { if (!ok(v) || !ok(minus[i])) return NA; const sum = v + minus[i]; return Math.abs(v - minus[i]) / (sum === 0 ? 1 : sum); });
    return { adx: rma(dx, adxSmoothing).map((v) => (ok(v) ? 100 * v : NA)), plus, minus };
  }
  // Williams Alligator lines (SMMA of median price, shifted forward)
  function alligator(c, p) {
    const m = c.map((x) => (x.high + x.low) / 2);
    return { jaw: shift(rma(m, p.jawLength), p.jawOffset), teeth: shift(rma(m, p.teethLength), p.teethOffset), lips: shift(rma(m, p.lipsLength), p.lipsOffset) };
  }
  const ALLIGATOR_PARAMS = [P.int('jawLength', 'Jaw Length', 13), P.int('teethLength', 'Teeth Length', 8), P.int('lipsLength', 'Lips Length', 5), P.int('jawOffset', 'Jaw Offset', 8, 0), P.int('teethOffset', 'Teeth Offset', 5, 0), P.int('lipsOffset', 'Lips Offset', 3, 0)];
  // pivot indexes: strictly beyond the right side, not exceeded on the left (same tie rule as swings())
  function pivotIdx(a, L, R, high) {
    const out = [];
    for (let i = L; i < a.length - R; i++) {
      const v = a[i];
      if (!ok(v)) continue;
      let is = true;
      for (let k = 1; k <= L && is; k++) { const u = a[i - k]; if (!ok(u) || (high ? u > v : u < v)) is = false; }
      for (let k = 1; k <= R && is; k++) { const u = a[i + k]; if (!ok(u) || (high ? u >= v : u <= v)) is = false; }
      if (is) out.push(i);
    }
    return out;
  }
  // regular / hidden divergences between price pivots and an oscillator's pivots; graphics are in the oscillator pane's scale
  function divergences(c, osc, p) {
    const g = [], lo = c.map((x) => x.low), hi = c.map((x) => x.high);
    const draw = (a, b, color, text, top) => {
      g.push({ kind: 'line', t1: c[a].time, p1: osc[a], t2: c[b].time, p2: osc[b], color, width: 2, style: 0, extend: 'none' });
      g.push({ kind: 'label', t: c[b].time, p: osc[b], text, color: '#ffffff', bg: color, align: 'center', base: top ? 'top' : 'bottom' });
    };
    const scan = (idx, isLow) => {
      for (let k = 1; k < idx.length; k++) {
        const a = idx[k - 1], b = idx[k], gap = b - a;
        if (gap < p.rangeMin || gap > p.rangeMax) continue;
        const pa = isLow ? lo[a] : hi[a], pb = isLow ? lo[b] : hi[b];
        if (isLow) {
          if (p.regular && osc[b] > osc[a] && pb < pa) draw(a, b, UP, 'Bull', true);
          else if (p.hidden && osc[b] < osc[a] && pb > pa) draw(a, b, 'rgba(38,166,154,0.6)', 'H Bull', true);
        } else if (p.regular && osc[b] < osc[a] && pb > pa) draw(a, b, DN, 'Bear', false);
        else if (p.hidden && osc[b] > osc[a] && pb < pa) draw(a, b, 'rgba(239,83,80,0.6)', 'H Bear', false);
      }
    };
    scan(pivotIdx(osc, p.lbL, p.lbR, false), true);
    scan(pivotIdx(osc, p.lbL, p.lbR, true), false);
    return g;
  }
  const DIV_PARAMS = [tip(P.int('lbR', 'Pivot lookback right', 5), 'A pivot is drawn once lbR bars confirm it (TradingView divergence semantics)'), P.int('lbL', 'Pivot lookback left', 5), P.int('rangeMin', 'Min bars between pivots', 5), P.int('rangeMax', 'Max bars between pivots', 60), P.bool('regular', 'Regular divergences', true), P.bool('hidden', 'Hidden divergences', false)];
  // market-structure breaks from confirmed pivots (a pivot becomes usable depth bars after it forms — no lookahead)
  function structureEvents(c, depth) {
    const n = c.length, h = c.map((x) => x.high), l = c.map((x) => x.low), ph = new Set(pivotIdx(h, depth, depth, true)), pl = new Set(pivotIdx(l, depth, depth, false)), ev = [];
    let sh = null, sl = null, trend = 0;
    for (let i = 0; i < n; i++) {
      const j = i - depth;
      if (j >= 0 && ph.has(j)) sh = { i: j, p: h[j], broken: false };
      if (j >= 0 && pl.has(j)) sl = { i: j, p: l[j], broken: false };
      if (sh && !sh.broken && c[i].close > sh.p) { ev.push({ dir: 1, type: trend === -1 ? 'CHoCH' : 'BOS', pivot: sh, i }); sh.broken = true; trend = 1; }
      if (sl && !sl.broken && c[i].close < sl.p) { ev.push({ dir: -1, type: trend === 1 ? 'CHoCH' : 'BOS', pivot: sl, i }); sl.broken = true; trend = -1; }
    }
    return ev;
  }
  // Projection Bands (Widner): max/min over the window of price projected forward along its regression slope
  function projBands(c, n) {
    const h = c.map((x) => x.high), l = c.map((x) => x.low), sH = lrSlope(h, n), sL = lrSlope(l, n), upper = nan(c.length), lower = nan(c.length);
    for (let i = n - 1; i < c.length; i++) {
      if (!ok(sH[i]) || !ok(sL[i])) continue;
      let u = -Infinity, d = Infinity;
      for (let k = 0; k < n; k++) { u = Math.max(u, h[i - k] + k * sH[i]); d = Math.min(d, l[i - k] + k * sL[i]); }
      upper[i] = u; lower[i] = d;
    }
    return { upper, lower };
  }
  // rolling central moments of a series (population)
  function moments(a, n) {
    const m = sma(a, n), s = nan(a.length), k = nan(a.length);
    for (let i = n - 1; i < a.length; i++) {
      if (!ok(m[i])) continue;
      let m2 = 0, m3 = 0, m4 = 0;
      for (let j = 0; j < n; j++) { const d = a[i - j] - m[i]; m2 += d * d; m3 += d * d * d; m4 += d * d * d * d; }
      m2 /= n; m3 /= n; m4 /= n;
      if (m2 > 0) { s[i] = m3 / m2 ** 1.5; k[i] = m4 / (m2 * m2) - 3; }
    }
    return { skew: s, kurt: k };
  }
  const logRet = (s) => s.map((v, i) => (i && v > 0 && s[i - 1] > 0 ? Math.log(v / s[i - 1]) : NA));
  // daily-UTC session windows; start/end in UTC hours, wraps over midnight when end <= start
  function sessionWindows(c, startH, endH) {
    const off = startH * 3600, len = ((((endH - startH) % 24) + 24) % 24 || 24) * 3600, S = new Map();
    for (let i = 0; i < c.length; i++) {
      const x = c[i], idx = Math.floor((x.time - off) / DAY), s0 = idx * DAY + off;
      if (x.time - s0 >= len) continue;
      let s = S.get(idx);
      if (!s) S.set(idx, (s = { s0, s1: s0 + len, h: -Infinity, l: Infinity, i0: i, i1: i }));
      if (ok(x.high)) s.h = Math.max(s.h, x.high);
      if (ok(x.low)) s.l = Math.min(s.l, x.low);
      s.i1 = i;
    }
    return [...S.values()].filter((s) => ok(s.h) && ok(s.l));
  }
  const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

  // ══ Library expansion (TradingView built-ins & community-famous studies) ══
  // ── helpers ────────────────────────────────────────────
  const hlc3Of = (c) => c.map((x) => (x.high + x.low + x.close) / 3);
  const volOf = (c) => c.map((x) => x.volume || 0);
  const perYear = (c, ctx, periods) => (periods > 0 ? periods : (365 * DAY) / tfOf(c, ctx));
  const PERIODS_PARAM = () => tip(P.int('periods', 'Periods per year (0 = 365 days / bar size)', 0, 0, 1000000), 'Annualisation factor; 0 derives it from the bar size in calendar time');
  // window-wise apply fn(values[], i) over the last n finite values; NaN if any is missing
  function rolling(a, n, fn) {
    const out = nan(a.length), w = new Array(n);
    for (let i = n - 1; i < a.length; i++) {
      let good = true;
      for (let k = 0; k < n; k++) { const v = a[i - n + 1 + k]; if (!ok(v)) { good = false; break; } w[k] = v; }
      if (good) out[i] = fn(w, i);
    }
    return out;
  }
  const flatTol = (m) => 1e-12 * Math.max(1, Math.abs(m));
  // Pearson correlation over n bars (two-pass, NaN when either side is flat)
  function corr(a, b, n) {
    const out = nan(a.length);
    for (let i = n - 1; i < a.length; i++) {
      let sa = 0, sb = 0, good = true;
      for (let k = 0; k < n; k++) { const x = a[i - k], y = b[i - k]; if (!ok(x) || !ok(y)) { good = false; break; } sa += x; sb += y; }
      if (!good) continue;
      const ma = sa / n, mb = sb / n;
      let va = 0, vb = 0, cv = 0;
      for (let k = 0; k < n; k++) { const dx = a[i - k] - ma, dy = b[i - k] - mb; va += dx * dx; vb += dy * dy; cv += dx * dy; }
      if (Math.sqrt(va / n) <= flatTol(ma) || Math.sqrt(vb / n) <= flatTol(mb)) continue;
      out[i] = Math.max(-1, Math.min(1, cv / Math.sqrt(va * vb)));
    }
    return out;
  }
  // rolling least-squares fit of src against bar position (x = 0 oldest … n-1 newest)
  function lrStats(a, n) {
    const N = a.length, slope = nan(N), end = nan(N), r2 = nan(N), se = nan(N), sx = (n * (n - 1)) / 2, sxx = ((n - 1) * n * (2 * n - 1)) / 6, den = n * sxx - sx * sx;
    if (n < 2 || !den) return { slope, end, r2, se };
    for (let i = n - 1; i < N; i++) {
      let sy = 0, sxy = 0, good = true;
      for (let k = 0; k < n; k++) { const v = a[i - n + 1 + k]; if (!ok(v)) { good = false; break; } sy += v; sxy += k * v; }
      if (!good) continue;
      const b = (n * sxy - sx * sy) / den, a0 = (sy - b * sx) / n, my = sy / n;
      let ssr = 0, sst = 0;
      for (let k = 0; k < n; k++) { const v = a[i - n + 1 + k]; ssr += (v - a0 - b * k) ** 2; sst += (v - my) ** 2; }
      slope[i] = b; end[i] = a0 + b * (n - 1);
      se[i] = n > 2 ? Math.sqrt(ssr / (n - 2)) : 0;
      r2[i] = Math.sqrt(sst / n) > flatTol(my) ? Math.max(0, Math.min(1, 1 - ssr / sst)) : NA;
    }
    return { slope, end, r2, se };
  }
  const cciF = (s, n) => { const m = sma(s, n); return s.map((v, i) => { if (!ok(m[i])) return NA; let md = 0; for (let k = 0; k < n; k++) md += Math.abs(s[i - k] - m[i]); md /= n; return md ? (v - m[i]) / (0.015 * md) : 0; }); };
  const median = (w) => { const s = [...w].sort((x, y) => x - y), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
  // TradingView ta.percentile_linear_interpolation
  const pctLinear = (w, pct) => { const s = [...w].sort((x, y) => x - y), r = (pct / 100) * (s.length - 1), lo = Math.floor(r), hi = Math.ceil(r); return s[lo] + (s[hi] - s[lo]) * (r - lo); };
  // Ehlers four-element Laguerre filter state
  function laguerre4(a, g) {
    return onValid(a, (x) => {
      const L0 = [], L1 = [], L2 = [], L3 = [];
      for (let i = 0; i < x.length; i++) {
        const p0 = i ? L0[i - 1] : x[i], p1 = i ? L1[i - 1] : x[i], p2 = i ? L2[i - 1] : x[i], p3 = i ? L3[i - 1] : x[i];
        L0[i] = (1 - g) * x[i] + g * p0; L1[i] = -g * L0[i] + p0 + g * p1; L2[i] = -g * L1[i] + p1 + g * p2; L3[i] = -g * L2[i] + p2 + g * p3;
      }
      return { L0, L1, L2, L3 };
    });
  }
  // Ehlers Gaussian filter, 1–4 poles
  function gaussian(a, period, poles) {
    const N = Math.max(1, Math.min(4, poles)), beta = (1 - Math.cos((2 * Math.PI) / period)) / (2 ** (1 / N) - 1), al = -beta + Math.sqrt(beta * beta + 2 * beta), q = 1 - al;
    const C = [[], [1], [2, -1], [3, -3, 1], [4, -6, 4, -1]][N].map((k, j) => k * q ** (j + 1));
    return onValid(a, (x) => {
      const f = [];
      for (let i = 0; i < x.length; i++) {
        if (i < N) { f[i] = x[i]; continue; }
        let v = al ** N * x[i];
        for (let j = 0; j < N; j++) v += C[j] * f[i - 1 - j];
        f[i] = v;
      }
      return f;
    });
  }
  function butterworth2(a, period) {
    const a1 = Math.exp((-1.414 * Math.PI) / period), b1 = 2 * a1 * Math.cos((1.414 * Math.PI) / period), c2 = b1, c3 = -a1 * a1, c1 = (1 - b1 + a1 * a1) / 4;
    return onValid(a, (x) => { const f = []; for (let i = 0; i < x.length; i++) f[i] = i < 2 ? x[i] : c1 * (x[i] + 2 * x[i - 1] + x[i - 2]) + c2 * f[i - 1] + c3 * f[i - 2]; return f; });
  }
  const aroonUD = (c, L) => {
    const n = c.length, up = nan(n), down = nan(n);
    for (let i = L; i < n; i++) {
      let hi = i, lo = i;
      for (let k = i - L; k <= i; k++) { if (c[k].high >= c[hi].high) hi = k; if (c[k].low <= c[lo].low) lo = k; }
      up[i] = (100 * (L - (i - hi))) / L; down[i] = (100 * (L - (i - lo))) / L;
    }
    return { up, down };
  };
  // Dorsey Relative Volatility Index (shared by RVI and Inertia)
  function relVolIdx(s, stdLength, length) {
    const sd = stdev(s, stdLength), ch = change(s);
    const u = ema(sd.map((v, i) => (ok(v) && ok(ch[i]) ? (ch[i] > 0 ? v : 0) : NA)), length), d = ema(sd.map((v, i) => (ok(v) && ok(ch[i]) ? (ch[i] <= 0 ? v : 0) : NA)), length);
    return u.map((x, i) => (x + d[i] ? (100 * x) / (x + d[i]) : ok(x) ? 50 : NA));
  }
  // Wilder Swing Index per bar; T only rescales (FX has no exchange limit move)
  function swingIndex(c, limit) {
    return c.map((x, i) => {
      if (!i) return 0;
      const q = c[i - 1], ahc = Math.abs(x.high - q.close), alc = Math.abs(x.low - q.close), ahl = x.high - x.low, oc = Math.abs(q.close - q.open), K = Math.max(ahc, alc);
      const R = ahc >= Math.max(alc, ahl) ? ahc - 0.5 * alc + 0.25 * oc : alc >= Math.max(ahc, ahl) ? alc - 0.5 * ahc + 0.25 * oc : ahl + 0.25 * oc;
      const scale = limit > 0 ? K / limit : 1;
      return R ? ((50 * (x.close - q.close + 0.5 * (x.close - x.open) + 0.25 * (q.close - q.open))) / R) * scale : 0;
    });
  }
  const sessionKey = (reset) => (t) => {
    if (reset === 'None') return 0;
    if (reset === 'UTC day') return Math.floor(t / DAY);
    if (reset === 'Week') return Math.floor((t / DAY + 3) / 7);
    const d = new Date(t * 1000);
    return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
  };
  // Ichimoku mid-lines and leading spans as of each bar (spans displaced forward by disp)
  function ichiLines(c, p) {
    const h = c.map((x) => x.high), l = c.map((x) => x.low), mid = (k) => { const H = highest(h, k), L = lowest(l, k); return H.map((v, i) => (v + L[i]) / 2); };
    const conv = mid(p.conv), base = mid(p.base), B0 = mid(p.spanB), A0 = conv.map((v, i) => (v + base[i]) / 2), sh = Math.max(0, p.disp);
    return { conv, base, spanA: shift(A0, sh), spanB: shift(B0, sh) };
  }
  const ICHI_PARAMS = [P.int('conv', 'Conversion Line Length', 9), P.int('base', 'Base Line Length', 26), P.int('spanB', 'Leading Span B Length', 52), P.int('disp', 'Displacement', 26, 0)];
  const nice = (x) => { if (!(x > 0)) return 1; const e = 10 ** Math.floor(Math.log10(x)), f = x / e; return (f < 1.5 ? 1 : f < 3.5 ? 2 : f < 7.5 ? 5 : 10) * e; };
  const hline = (t1, t2, price, color, style = 0, extend = 'none', width = 1) => ({ kind: 'line', t1, p1: price, t2, p2: price, color, width, style, extend });
  const tlabel = (t, price, text, color, align = 'left', base = 'bottom') => ({ kind: 'label', t, p: price, text, color, bg: 'transparent', align, base });

  // ── TradingView "Candlestick Patterns" rules (built-in "All Candlestick Patterns" definitions) ──
  function cpBase(c, rule) {
    const n = c.length, O = c.map((x) => x.open), H = c.map((x) => x.high), L = c.map((x) => x.low), C = c.map((x) => x.close);
    const bHi = C.map((v, i) => Math.max(v, O[i])), bLo = C.map((v, i) => Math.min(v, O[i])), body = bHi.map((v, i) => v - bLo[i]), avg = ema(body, 14);
    const up = H.map((v, i) => v - bHi[i]), dn = L.map((v, i) => bLo[i] - v), range = H.map((v, i) => v - L[i]);
    const s50 = sma(C, 50), s200 = rule === 'SMA50, SMA200' ? sma(C, 200) : null;
    const B = {
      n, O, H, L, C, bHi, bLo, body, up, dn, range, mid: body.map((v, i) => v / 2 + bLo[i]),
      small: body.map((v, i) => v < avg[i]), long: body.map((v, i) => v > avg[i]), avg,
      white: C.map((v, i) => O[i] < v), black: C.map((v, i) => O[i] > v),
      hasUp: up.map((v, i) => v > 0.05 * body[i]), hasDn: dn.map((v, i) => v > 0.05 * body[i]),
      dojiBody: body.map((v, i) => range[i] > 0 && v <= range[i] * 0.05),
      upT: C.map((v, i) => (rule === 'No detection' ? true : s200 ? v > s50[i] && s50[i] > s200[i] : v > s50[i])),
      dnT: C.map((v, i) => (rule === 'No detection' ? true : s200 ? v < s50[i] && s50[i] < s200[i] : v < s50[i])),
    };
    const sEq = up.map((u, i) => { const d = dn[i]; return u === d || ((Math.abs(u - d) / d) * 100 < 100 && (Math.abs(d - u) / u) * 100 < 100); });
    B.doji = B.dojiBody.map((v, i) => v && sEq[i]);
    B.maruW = C.map((_, i) => B.white[i] && B.long[i] && up[i] <= 0.05 * body[i] && dn[i] <= 0.05 * body[i]);
    B.maruB = C.map((_, i) => B.black[i] && B.long[i] && up[i] <= 0.05 * body[i] && dn[i] <= 0.05 * body[i]);
    B.hammerOK = C.map((_, i) => B.small[i] && body[i] > 0 && bLo[i] > (H[i] + L[i]) / 2 && dn[i] >= 2 * body[i] && !B.hasUp[i]);
    B.starOK = C.map((_, i) => B.small[i] && body[i] > 0 && bHi[i] < (H[i] + L[i]) / 2 && up[i] >= 2 * body[i] && !B.hasDn[i]);
    return B;
  }
  // [key, name, label, direction, lookback, predicate(B, i)]
  const CP = [
    ['abandonedBabyBear', 'Abandoned Baby - Bearish', 'AB', -1, 2, (b, i) => b.upT[i - 2] && b.white[i - 2] && b.dojiBody[i - 1] && b.H[i - 2] < b.L[i - 1] && b.black[i] && b.L[i - 1] > b.H[i]],
    ['abandonedBabyBull', 'Abandoned Baby - Bullish', 'AB', 1, 2, (b, i) => b.dnT[i - 2] && b.black[i - 2] && b.dojiBody[i - 1] && b.L[i - 2] > b.H[i - 1] && b.white[i] && b.H[i - 1] < b.L[i]],
    ['darkCloudCover', 'Dark Cloud Cover - Bearish', 'DCC', -1, 1, (b, i) => b.upT[i - 1] && b.white[i - 1] && b.long[i - 1] && b.black[i] && b.O[i] >= b.H[i - 1] && b.C[i] < b.mid[i - 1] && b.C[i] > b.O[i - 1]],
    ['doji', 'Doji', 'D', 0, 0, (b, i) => b.doji[i] && !(b.dojiBody[i] && b.up[i] <= b.body[i]) && !(b.dojiBody[i] && b.dn[i] <= b.body[i])],
    ['dojiStarBear', 'Doji Star - Bearish', 'DS', -1, 1, (b, i) => b.upT[i] && b.white[i - 1] && b.long[i - 1] && b.dojiBody[i] && b.bLo[i] > b.bHi[i - 1]],
    ['dojiStarBull', 'Doji Star - Bullish', 'DS', 1, 1, (b, i) => b.dnT[i] && b.black[i - 1] && b.long[i - 1] && b.dojiBody[i] && b.bHi[i] < b.bLo[i - 1]],
    ['downsideTasuki', 'Downside Tasuki Gap - Bearish', 'DTG', -1, 2, (b, i) => b.long[i - 2] && b.small[i - 1] && b.dnT[i] && b.black[i - 2] && b.bHi[i - 1] < b.bLo[i - 2] && b.black[i - 1] && b.white[i] && b.bHi[i] <= b.bLo[i - 2] && b.bHi[i] >= b.bHi[i - 1]],
    ['dragonflyDoji', 'Dragonfly Doji - Bullish', 'DD', 1, 0, (b, i) => b.dojiBody[i] && b.up[i] <= b.body[i]],
    ['engulfingBear', 'Engulfing - Bearish', 'BE', -1, 1, (b, i) => b.upT[i] && b.black[i] && b.long[i] && b.white[i - 1] && b.small[i - 1] && b.C[i] <= b.O[i - 1] && b.O[i] >= b.C[i - 1] && (b.C[i] < b.O[i - 1] || b.O[i] > b.C[i - 1])],
    ['engulfingBull', 'Engulfing - Bullish', 'BE', 1, 1, (b, i) => b.dnT[i] && b.white[i] && b.long[i] && b.black[i - 1] && b.small[i - 1] && b.C[i] >= b.O[i - 1] && b.O[i] <= b.C[i - 1] && (b.C[i] > b.O[i - 1] || b.O[i] < b.C[i - 1])],
    ['eveningDojiStar', 'Evening Doji Star - Bearish', 'EDS', -1, 2, (b, i) => b.long[i - 2] && b.dojiBody[i - 1] && b.long[i] && b.upT[i] && b.white[i - 2] && b.bLo[i - 1] > b.bHi[i - 2] && b.black[i] && b.bLo[i] <= b.mid[i - 2] && b.bLo[i] > b.bLo[i - 2] && b.bLo[i - 1] > b.bHi[i]],
    ['eveningStar', 'Evening Star - Bearish', 'ES', -1, 2, (b, i) => b.long[i - 2] && b.small[i - 1] && b.long[i] && b.upT[i] && b.white[i - 2] && b.bLo[i - 1] > b.bHi[i - 2] && b.black[i] && b.bLo[i] <= b.mid[i - 2] && b.bLo[i] > b.bLo[i - 2] && b.bLo[i - 1] > b.bHi[i]],
    ['fallingThreeMethods', 'Falling Three Methods - Bearish', 'FTM', -1, 4, (b, i) => b.dnT[i - 4] && b.long[i - 4] && b.black[i - 4] && [3, 2, 1].every((k) => b.small[i - k] && b.white[i - k] && b.O[i - k] > b.L[i - 4] && b.C[i - k] < b.H[i - 4]) && b.long[i] && b.black[i] && b.C[i] < b.C[i - 4]],
    ['fallingWindow', 'Falling Window - Bearish', 'FW', -1, 1, (b, i) => b.dnT[i - 1] && b.range[i] !== 0 && b.range[i - 1] !== 0 && b.H[i] < b.L[i - 1]],
    ['gravestoneDoji', 'Gravestone Doji - Bearish', 'GD', -1, 0, (b, i) => b.dojiBody[i] && b.dn[i] <= b.body[i]],
    ['hammer', 'Hammer - Bullish', 'H', 1, 0, (b, i) => b.dnT[i] && b.hammerOK[i]],
    ['hangingMan', 'Hanging Man - Bearish', 'HM', -1, 0, (b, i) => b.upT[i] && b.hammerOK[i]],
    ['haramiBear', 'Harami - Bearish', 'BH', -1, 1, (b, i) => b.long[i - 1] && b.white[i - 1] && b.upT[i - 1] && b.black[i] && b.small[i] && b.H[i] <= b.bHi[i - 1] && b.L[i] >= b.bLo[i - 1]],
    ['haramiBull', 'Harami - Bullish', 'BH', 1, 1, (b, i) => b.long[i - 1] && b.black[i - 1] && b.dnT[i - 1] && b.white[i] && b.small[i] && b.H[i] <= b.bHi[i - 1] && b.L[i] >= b.bLo[i - 1]],
    ['haramiCrossBear', 'Harami Cross - Bearish', 'HC', -1, 1, (b, i) => b.long[i - 1] && b.white[i - 1] && b.upT[i - 1] && b.dojiBody[i] && b.H[i] <= b.bHi[i - 1] && b.L[i] >= b.bLo[i - 1]],
    ['haramiCrossBull', 'Harami Cross - Bullish', 'HC', 1, 1, (b, i) => b.long[i - 1] && b.black[i - 1] && b.dnT[i - 1] && b.dojiBody[i] && b.H[i] <= b.bHi[i - 1] && b.L[i] >= b.bLo[i - 1]],
    ['invertedHammer', 'Inverted Hammer - Bullish', 'IH', 1, 0, (b, i) => b.dnT[i] && b.starOK[i]],
    ['kickingBear', 'Kicking - Bearish', 'K', -1, 1, (b, i) => b.maruW[i - 1] && b.maruB[i] && b.L[i - 1] > b.H[i]],
    ['kickingBull', 'Kicking - Bullish', 'K', 1, 1, (b, i) => b.maruB[i - 1] && b.maruW[i] && b.H[i - 1] < b.L[i]],
    ['longLowerShadow', 'Long Lower Shadow - Bullish', 'LLS', 1, 0, (b, i) => b.dn[i] > b.range[i] * 0.75],
    ['longUpperShadow', 'Long Upper Shadow - Bearish', 'LUS', -1, 0, (b, i) => b.up[i] > b.range[i] * 0.75],
    ['marubozuBlack', 'Marubozu Black - Bearish', 'MB', -1, 0, (b, i) => b.maruB[i]],
    ['marubozuWhite', 'Marubozu White - Bullish', 'MW', 1, 0, (b, i) => b.maruW[i]],
    ['morningDojiStar', 'Morning Doji Star - Bullish', 'MDS', 1, 2, (b, i) => b.long[i - 2] && b.dojiBody[i - 1] && b.long[i] && b.dnT[i] && b.black[i - 2] && b.bHi[i - 1] < b.bLo[i - 2] && b.white[i] && b.bHi[i] >= b.mid[i - 2] && b.bHi[i] < b.bHi[i - 2] && b.bHi[i - 1] < b.bLo[i]],
    ['morningStar', 'Morning Star - Bullish', 'MS', 1, 2, (b, i) => b.long[i - 2] && b.small[i - 1] && b.long[i] && b.dnT[i] && b.black[i - 2] && b.bHi[i - 1] < b.bLo[i - 2] && b.white[i] && b.bHi[i] >= b.mid[i - 2] && b.bHi[i] < b.bHi[i - 2] && b.bHi[i - 1] < b.bLo[i]],
    ['onNeck', 'On Neck - Bearish', 'ON', -1, 1, (b, i) => b.dnT[i] && b.black[i - 1] && b.long[i - 1] && b.white[i] && b.O[i] < b.C[i - 1] && b.small[i] && b.range[i] !== 0 && Math.abs(b.C[i] - b.L[i - 1]) <= b.avg[i] * 0.05],
    ['piercing', 'Piercing - Bullish', 'P', 1, 1, (b, i) => b.dnT[i - 1] && b.black[i - 1] && b.long[i - 1] && b.white[i] && b.O[i] <= b.L[i - 1] && b.C[i] > b.mid[i - 1] && b.C[i] < b.O[i - 1]],
    ['risingThreeMethods', 'Rising Three Methods - Bullish', 'RTM', 1, 4, (b, i) => b.upT[i - 4] && b.long[i - 4] && b.white[i - 4] && [3, 2, 1].every((k) => b.small[i - k] && b.black[i - k] && b.O[i - k] < b.H[i - 4] && b.C[i - k] > b.L[i - 4]) && b.long[i] && b.white[i] && b.C[i] > b.C[i - 4]],
    ['risingWindow', 'Rising Window - Bullish', 'RW', 1, 1, (b, i) => b.upT[i - 1] && b.range[i] !== 0 && b.range[i - 1] !== 0 && b.L[i] > b.H[i - 1]],
    ['shootingStar', 'Shooting Star - Bearish', 'SS', -1, 0, (b, i) => b.upT[i] && b.starOK[i]],
    ['spinningTopBlack', 'Spinning Top Black', 'STB', 0, 0, (b, i) => b.dn[i] >= b.range[i] * 0.34 && b.up[i] >= b.range[i] * 0.34 && !b.dojiBody[i] && b.black[i]],
    ['spinningTopWhite', 'Spinning Top White', 'STW', 0, 0, (b, i) => b.dn[i] >= b.range[i] * 0.34 && b.up[i] >= b.range[i] * 0.34 && !b.dojiBody[i] && b.white[i]],
    ['threeBlackCrows', 'Three Black Crows - Bearish', '3BC', -1, 2, (b, i) => [0, 1, 2].every((k) => b.long[i - k] && b.black[i - k] && b.range[i - k] * 0.05 > b.dn[i - k]) && b.C[i] < b.C[i - 1] && b.C[i - 1] < b.C[i - 2] && b.O[i] > b.C[i - 1] && b.O[i] < b.O[i - 1] && b.O[i - 1] > b.C[i - 2] && b.O[i - 1] < b.O[i - 2]],
    ['threeWhiteSoldiers', 'Three White Soldiers - Bullish', '3WS', 1, 2, (b, i) => [0, 1, 2].every((k) => b.long[i - k] && b.white[i - k] && b.range[i - k] * 0.05 > b.up[i - k]) && b.C[i] > b.C[i - 1] && b.C[i - 1] > b.C[i - 2] && b.O[i] < b.C[i - 1] && b.O[i] > b.O[i - 1] && b.O[i - 1] < b.C[i - 2] && b.O[i - 1] > b.O[i - 2]],
    ['triStarBear', 'Tri-Star - Bearish', '3S', -1, 2, (b, i) => b.doji[i - 2] && b.doji[i - 1] && b.doji[i] && b.upT[i - 2] && b.bHi[i - 2] < b.bLo[i - 1] && b.bLo[i - 1] > b.bHi[i]],
    ['triStarBull', 'Tri-Star - Bullish', '3S', 1, 2, (b, i) => b.doji[i - 2] && b.doji[i - 1] && b.doji[i] && b.dnT[i - 2] && b.bLo[i - 2] > b.bHi[i - 1] && b.bHi[i - 1] < b.bLo[i]],
    ['tweezerBottom', 'Tweezer Bottom - Bullish', 'TB', 1, 1, (b, i) => b.dnT[i - 1] && (!b.dojiBody[i] || (b.hasUp[i] && b.hasDn[i])) && Math.abs(b.L[i] - b.L[i - 1]) <= b.avg[i] * 0.05 && b.black[i - 1] && b.white[i] && b.long[i - 1]],
    ['tweezerTop', 'Tweezer Top - Bearish', 'TT', -1, 1, (b, i) => b.upT[i - 1] && (!b.dojiBody[i] || (b.hasUp[i] && b.hasDn[i])) && Math.abs(b.H[i] - b.H[i - 1]) <= b.avg[i] * 0.05 && b.white[i - 1] && b.black[i] && b.long[i - 1]],
    ['upsideTasuki', 'Upside Tasuki Gap - Bullish', 'UTG', 1, 2, (b, i) => b.long[i - 2] && b.small[i - 1] && b.upT[i] && b.white[i - 2] && b.bLo[i - 1] > b.bHi[i - 2] && b.white[i - 1] && b.black[i] && b.bLo[i] >= b.bHi[i - 2] && b.bLo[i] <= b.bLo[i - 1]],
  ];
  const CP_TREND = () => tip(P.sel('trend', 'Detect trend based on', ['SMA50', 'SMA50, SMA200', 'No detection']), 'TradingView rule: up trend = close above SMA50 (and SMA50 above SMA200 when selected)');
  function cpMarkers(c, rule, pats) {
    const b = cpBase(c, rule), markers = [];
    for (let i = 0; i < b.n; i++) {
      const bull = [], bear = [], neu = [];
      for (const [, , lab, dir, back, f] of pats) if (i >= back && f(b, i)) (dir > 0 ? bull : dir < 0 ? bear : neu).push(lab);
      const t = c[i].time;
      if (bull.length) markers.push({ time: t, position: 'belowBar', shape: 'arrowUp', color: UP, text: bull.join(' ') });
      if (bear.length) markers.push({ time: t, position: 'aboveBar', shape: 'arrowDown', color: DN, text: bear.join(' ') });
      if (neu.length) markers.push({ time: t, position: 'aboveBar', shape: 'circle', color: '#787b86', text: neu.join(' ') });
    }
    return markers;
  }
  // Murrey Math frame (classic MQL "Murrey_Math_Line_X" octave selection)
  function murreyFrame(v1, v2) {
    if (!(v2 > v1)) return null;
    const T = [[250000, 25000, 100000], [25000, 2500, 10000], [2500, 250, 1000], [250, 25, 100], [25, 12.5, 12.5], [12.5, 6.25, 12.5], [6.25, 3.125, 6.25], [3.125, 1.5625, 3.125], [1.5625, 0.390625, 1.5625], [0.390625, 0, 0.1953125]];
    const row = T.find(([hi, lo]) => v2 <= hi && v2 > lo), fractal = row ? row[2] : 10 ** Math.ceil(Math.log10(v2)), range = v2 - v1;
    const sum = Math.floor(Math.log(fractal / range) / Math.LN2), octave = fractal * 0.5 ** sum, mn = Math.floor(v1 / octave) * octave, mx = mn + octave > v2 ? mn + octave : mn + 2 * octave, d = mx - mn;
    const x2 = v1 >= (3 * d) / 16 + mn && v2 <= (9 * d) / 16 + mn ? mn + d / 2 : 0;
    const x1 = v1 >= mn - d / 8 && v2 <= (5 * d) / 8 + mn && !x2 ? mn + d / 2 : 0;
    const x4 = v1 >= mn + (7 * d) / 16 && v2 <= (13 * d) / 16 + mn ? mn + (3 * d) / 4 : 0;
    const x5 = v1 >= mn + (3 * d) / 8 && v2 <= (9 * d) / 8 + mn && !x4 ? mx : 0;
    const x3 = v1 >= mn + d / 8 && v2 <= (7 * d) / 8 + mn && !x1 && !x2 && !x4 && !x5 ? mn + (3 * d) / 4 : 0;
    const x6 = x1 + x2 + x3 + x4 + x5 === 0 ? mx : 0, fH = x1 + x2 + x3 + x4 + x5 + x6;
    const y1 = x1 > 0 ? mn : 0, y2 = x2 > 0 ? mn + d / 4 : 0, y3 = x3 > 0 ? mn + d / 4 : 0, y4 = x4 > 0 ? mn + d / 2 : 0, y5 = x5 > 0 ? mn + d / 2 : 0;
    const y6 = fH > 0 && y1 + y2 + y3 + y4 + y5 === 0 ? mn : 0, fL = y1 + y2 + y3 + y4 + y5 + y6;
    return ok(fH) && ok(fL) && fH > fL ? { lo: fL, step: (fH - fL) / 8 } : null;
  }


  const VP_COLORS = { up: 'rgba(38,166,154,0.55)', down: 'rgba(239,83,80,0.55)', poc: '#ffeb3b', va: 'rgba(41,98,255,0.35)' };

  const DEFS = [
    // ── Moving averages ──────────────────────────────────
    MA('sma', 'Moving Average Simple', 'SMA', '#f7b924', 20, (s, p) => sma(s, p.length)),
    MA('ema', 'Moving Average Exponential', 'EMA', '#c77dff', 50, (s, p) => ema(s, p.length)),
    MA('wma', 'Moving Average Weighted', 'WMA', '#4dd0e1', 9, (s, p) => wma(s, p.length)),
    MA('hma', 'Hull Moving Average', 'HMA', '#00bcd4', 9, (s, p) => hma(s, p.length)),
    MA('dema', 'Double EMA', 'DEMA', '#43a047', 9, (s, p) => { const e = ema(s, p.length), ee = ema(e, p.length); return e.map((v, i) => 2 * v - ee[i]); }),
    MA('tema', 'Triple EMA', 'TEMA', '#26c6da', 9, (s, p) => { const e = ema(s, p.length), ee = ema(e, p.length), eee = ema(ee, p.length); return e.map((v, i) => 3 * (v - ee[i]) + eee[i]); }),
    MA('alma', 'Arnaud Legoux Moving Average', 'ALMA', '#2196f3', 9, (s, p) => alma(s, p.length, p.offset, p.sigma), 'Moving averages', [P.num('offset', 'Offset', 0.85, 0.01), P.num('sigma', 'Sigma', 6, 0.5, 0.1)]),
    MA('kama', 'Kaufman Adaptive Moving Average', 'KAMA', '#ab47bc', 10, (s, p) => {
      const out = nan(s.length), fa = 2 / (p.fast + 1), sa = 2 / (p.slow + 1), n = p.length;
      let prev = NA, vol = 0;
      for (let i = 1; i < s.length; i++) {
        const d = Math.abs(s[i] - s[i - 1]);
        vol += ok(d) ? d : 0;
        if (i > n) { const d0 = Math.abs(s[i - n] - s[i - n - 1]); vol -= ok(d0) ? d0 : 0; }
        if (i < n || !ok(s[i]) || !ok(s[i - n])) continue;
        const er = vol > 1e-12 ? Math.abs(s[i] - s[i - n]) / vol : 0, sc = (er * (fa - sa) + sa) ** 2;
        prev = ok(prev) ? prev + sc * (s[i] - prev) : s[i];
        out[i] = prev;
      }
      return out;
    }, 'Moving averages', [P.int('fast', 'Fast Length', 2), P.int('slow', 'Slow Length', 30)]),
    MA('vwma', 'Volume Weighted Moving Average (tick volume)', 'VWMA', '#ff7043', 20, (s, p, c) => vwmaF(s, c.map((x) => x.volume || 0), p.length)),
    MA('smma', 'Smoothed Moving Average', 'SMMA', '#8d6e63', 7, (s, p) => rma(s, p.length)),
    MA('lsma', 'Least Squares Moving Average', 'LSMA', '#ec407a', 25, (s, p) => linreg(s, p.length, p.offset), 'Moving averages', [P.int('offset', 'Offset', 0, 0)]),
    MA('mgd', 'McGinley Dynamic', 'McGinley', '#ffca28', 14, (s, p) => {
      const e = ema(s, p.length), out = nan(s.length);
      let mg = NA;
      for (let i = 0; i < s.length; i++) {
        if (!ok(s[i])) continue;
        if (!ok(mg)) { mg = e[i]; out[i] = mg; continue; }
        const r = s[i] / mg, d = p.length * r ** 4;
        mg = ok(d) && d ? mg + (s[i] - mg) / d : mg;
        out[i] = mg;
      }
      return out;
    }),
    { id: 'ribbon', name: 'Moving Average Ribbon', short: 'MA Ribbon', kind: 'overlay', category: 'Moving averages',
      params: [P.src(), P.ma('EMA'), P.int('len1', 'MA #1', 20), P.int('len2', 'MA #2', 50), P.int('len3', 'MA #3', 100), P.int('len4', 'MA #4', 200)],
      outputs: [line('ma1', 'MA #1', '#f6c309'), line('ma2', 'MA #2', '#fb9800'), line('ma3', 'MA #3', '#fb6500'), line('ma4', 'MA #4', '#f60c0c')],
      calc: (c, p, ctx) => { const s = getSrc(c, ctx)(p.source), v = c.map((x) => x.volume || 0); return { ma1: maBy(p.maType, s, p.len1, v), ma2: maBy(p.maType, s, p.len2, v), ma3: maBy(p.maType, s, p.len3, v), ma4: maBy(p.maType, s, p.len4, v) }; } },
    { id: 'macross', name: 'MA Cross', short: 'MA Cross', kind: 'overlay', category: 'Moving averages',
      params: [P.src(), P.ma('SMA'), P.int('fast', 'Fast Length', 9), P.int('slow', 'Slow Length', 21)],
      outputs: [line('fast', 'Fast', '#43a047'), line('slow', 'Slow', '#ef5350')],
      calc: (c, p, ctx) => {
        const s = getSrc(c, ctx)(p.source), v = c.map((x) => x.volume || 0), f = maBy(p.maType, s, p.fast, v), sl = maBy(p.maType, s, p.slow, v), markers = [];
        for (let i = 1; i < c.length; i++) {
          if (![f[i], sl[i], f[i - 1], sl[i - 1]].every(ok)) continue;
          if (f[i - 1] <= sl[i - 1] && f[i] > sl[i]) markers.push({ time: c[i].time, position: 'belowBar', shape: 'arrowUp', color: UP, text: 'Cross' });
          else if (f[i - 1] >= sl[i - 1] && f[i] < sl[i]) markers.push({ time: c[i].time, position: 'aboveBar', shape: 'arrowDown', color: DN, text: 'Cross' });
        }
        return { fast: f, slow: sl, markers };
      } },

    // ── Bands & channels ─────────────────────────────────
    { id: 'bb', name: 'Bollinger Bands', short: 'BB', kind: 'overlay', category: 'Bands & channels', params: [P.len(20), P.src(), P.num('mult', 'StdDev', 2)],
      outputs: [line('basis', 'Basis', '#ff6d00'), line('upper', 'Upper', '#2962ff'), line('lower', 'Lower', '#2962ff')], fills: [{ a: 'upper', b: 'lower', color: 'rgba(33,150,243,0.08)' }],
      calc: (c, p, ctx) => { const s = getSrc(c, ctx)(p.source), m = sma(s, p.length); return { basis: m, ...bands(m, stdev(s, p.length), p.mult) }; } },
    { id: 'kc', name: 'Keltner Channels', short: 'KC', kind: 'overlay', category: 'Bands & channels', params: [P.len(20), P.num('mult', 'Multiplier', 2), P.int('atrLength', 'ATR Length', 10), P.src()],
      outputs: [line('basis', 'Basis', '#2962ff'), line('upper', 'Upper', '#2962ff'), line('lower', 'Lower', '#2962ff')], fills: [{ a: 'upper', b: 'lower', color: 'rgba(33,150,243,0.06)' }],
      calc: (c, p, ctx) => { const m = ema(getSrc(c, ctx)(p.source), p.length); return { basis: m, ...bands(m, atr(c, p.atrLength), p.mult) }; } },
    { id: 'dc', name: 'Donchian Channels', short: 'DC', kind: 'overlay', category: 'Bands & channels', params: [P.len(20)],
      outputs: [line('upper', 'Upper', '#2962ff'), line('basis', 'Basis', '#ff6d00'), line('lower', 'Lower', '#2962ff')], fills: [{ a: 'upper', b: 'lower', color: 'rgba(33,150,243,0.06)' }],
      calc: (c, p) => { const h = highest(c.map((x) => x.high), p.length), l = lowest(c.map((x) => x.low), p.length); return { upper: h, lower: l, basis: h.map((v, i) => (v + l[i]) / 2) }; } },
    { id: 'env', name: 'Envelopes', short: 'Env', kind: 'overlay', category: 'Bands & channels', params: [P.len(20), P.src(), P.num('percent', 'Percent', 0.5, 0.05), P.bool('exponential', 'Exponential', false)],
      outputs: [line('basis', 'Basis', '#ff6d00'), line('upper', 'Upper', '#2962ff'), line('lower', 'Lower', '#2962ff')], fills: [{ a: 'upper', b: 'lower', color: 'rgba(33,150,243,0.06)' }],
      calc: (c, p, ctx) => { const s = getSrc(c, ctx)(p.source), m = p.exponential ? ema(s, p.length) : sma(s, p.length), k = p.percent / 100; return { basis: m, upper: m.map((v) => v * (1 + k)), lower: m.map((v) => v * (1 - k)) }; } },
    { id: 'lrc', name: 'Linear Regression Channel', short: 'LinReg', kind: 'overlay', category: 'Bands & channels',
      params: [P.int('length', 'Length (bars)', 100, 2, 5000), P.src(), P.num('dev', 'Deviation', 2), P.bool('extend', 'Extend right', true), P.color('color', 'Color', '#2962ff')], outputs: [],
      calc: (c, p, ctx) => {
        const s = getSrc(c, ctx)(p.source), n = c.length, len = Math.min(p.length, n), i0 = n - len;
        if (len < 2) return { graphics: [] };
        let sx = 0, sy = 0, sxy = 0, sxx = 0, m = 0;
        for (let k = 0; k < len; k++) { const v = s[i0 + k]; if (!ok(v)) continue; sx += k; sy += v; sxy += k * v; sxx += k * k; m++; }
        if (m < 2) return { graphics: [] };
        const slope = (m * sxy - sx * sy) / (m * sxx - sx * sx || 1), b = (sy - slope * sx) / m;
        let dev = 0;
        for (let k = 0; k < len; k++) { const v = s[i0 + k]; if (ok(v)) dev += (v - (b + slope * k)) ** 2; }
        dev = Math.sqrt(dev / m) * p.dev;
        const y0 = b, y1 = b + slope * (len - 1), t1 = c[i0].time, t2 = c[n - 1].time, ext = p.extend ? 'right' : 'none';
        const L = (o, style, width) => ({ kind: 'line', t1, p1: y0 + o, t2, p2: y1 + o, color: p.color, width, style, extend: ext });
        return { graphics: [L(0, 1, 1), L(dev, 0, 1), L(-dev, 0, 1), { kind: 'polyline', pts: [{ t: t1, p: y0 + dev }, { t: t2, p: y1 + dev }, { t: t2, p: y1 - dev }, { t: t1, p: y0 - dev }], color: 'transparent', width: 0, style: 0, fill: 'rgba(41,98,255,0.08)' }] };
      } },

    // ── Trend ────────────────────────────────────────────
    { id: 'st', name: 'Supertrend', short: 'Supertrend', kind: 'overlay', category: 'Trend', params: [P.int('atrLength', 'ATR Length', 10), P.num('factor', 'Factor', 3)],
      outputs: [line('v', 'Supertrend', UP, { width: 2, colorDown: DN })],
      calc: (c, p) => { const r = superTrend(c, p.atrLength, p.factor); return { v: r.v, colors: { v: r.dir.map((x) => (x === -1 ? 'down' : 'up')) } }; } },
    { id: 'psar', name: 'Parabolic SAR', short: 'SAR', kind: 'overlay', category: 'Trend', params: [P.num('start', 'Start', 0.02, 0.01), P.num('inc', 'Increment', 0.02, 0.01), P.num('max', 'Max', 0.2, 0.01)],
      outputs: [line('v', 'SAR', '#2196f3', { dots: true })],
      calc: (c, p) => {
        const out = nan(c.length);
        if (c.length < 2) return { v: out };
        let result = NA, maxMin = NA, acc = NA, below = false;
        for (let i = 1; i < c.length; i++) {
          const x = c[i];
          let first = false;
          if (i === 1) {
            if (x.close > c[0].close) { below = true; maxMin = x.high; result = c[0].low; } else { below = false; maxMin = x.low; result = c[0].high; }
            first = true; acc = p.start;
          }
          result = result + acc * (maxMin - result);
          if (below) { if (result > x.low) { first = true; below = false; result = Math.max(x.high, maxMin); maxMin = x.low; acc = p.start; } }
          else if (result < x.high) { first = true; below = true; result = Math.min(x.low, maxMin); maxMin = x.high; acc = p.start; }
          if (!first) {
            if (below) { if (x.high > maxMin) { maxMin = x.high; acc = Math.min(acc + p.inc, p.max); } }
            else if (x.low < maxMin) { maxMin = x.low; acc = Math.min(acc + p.inc, p.max); }
          }
          if (below) { result = Math.min(result, c[i - 1].low); if (i > 1) result = Math.min(result, c[i - 2].low); }
          else { result = Math.max(result, c[i - 1].high); if (i > 1) result = Math.max(result, c[i - 2].high); }
          out[i] = result;
        }
        return { v: out };
      } },
    { id: 'ichimoku', name: 'Ichimoku Cloud', short: 'Ichimoku', kind: 'overlay', category: 'Trend',
      params: [P.int('conv', 'Conversion Line Length', 9), P.int('base', 'Base Line Length', 26), P.int('spanB', 'Leading Span B Length', 52), P.int('disp', 'Lagging Span / Displacement', 26)],
      outputs: [line('conv', 'Conversion Line', '#2962ff'), line('base', 'Base Line', '#b71c1c'), line('lag', 'Lagging Span', '#43a047'), line('spanA', 'Leading Span A', '#a5d6a7'), line('spanB', 'Leading Span B', '#ef9a9a')],
      calc: (c, p, ctx) => {
        const n = c.length, h = c.map((x) => x.high), l = c.map((x) => x.low), mid = (k) => { const H = highest(h, k), L = lowest(l, k); return H.map((v, i) => (v + L[i]) / 2); };
        const conv = mid(p.conv), base = mid(p.base), B0 = mid(p.spanB), A0 = conv.map((v, i) => (v + base[i]) / 2), sh = Math.max(0, p.disp), lsh = Math.max(0, p.disp - 1), tf = tfOf(c, ctx);
        const spanA = nan(n), spanB = nan(n), lag = nan(n);
        for (let i = 0; i < n; i++) { if (i - sh >= 0) { spanA[i] = A0[i - sh]; spanB[i] = B0[i - sh]; } if (i + lsh < n) lag[i] = c[i + lsh].close; }
        const T = (pos) => (pos < n ? c[pos].time : c[n - 1].time + (pos - n + 1) * tf), graphics = [];
        let run = null;
        const close = () => { if (run && run.a.length > 1) graphics.push({ kind: 'polyline', pts: [...run.a, ...run.b.reverse()], color: 'transparent', width: 0, style: 0, fill: run.up ? 'rgba(67,160,71,0.18)' : 'rgba(244,67,54,0.18)' }); run = null; };
        let prev = null;
        for (let j = 0; j < n; j++) {
          const a = A0[j], b = B0[j];
          if (!ok(a) || !ok(b)) { close(); prev = null; continue; }
          const t = T(j + sh), up = a >= b;
          if (run && run.up !== up && prev) {
            const d0 = prev.a - prev.b, d1 = a - b, f = d0 / (d0 - d1 || 1), tc = prev.t + f * (t - prev.t), pc = prev.a + f * (a - prev.a);
            run.a.push({ t: tc, p: pc }); run.b.push({ t: tc, p: pc }); close();
            run = { up, a: [{ t: tc, p: pc }], b: [{ t: tc, p: pc }] };
          }
          if (!run) run = { up, a: [], b: [] };
          run.a.push({ t, p: a }); run.b.push({ t, p: b });
          prev = { t, a, b };
        }
        close();
        const fa = [], fb = [];
        for (let j = Math.max(0, n - 1 - sh); j < n; j++) if (ok(A0[j]) && ok(B0[j])) { fa.push({ t: T(j + sh), p: A0[j] }); fb.push({ t: T(j + sh), p: B0[j] }); }
        if (fa.length > 1) graphics.push({ kind: 'polyline', pts: fa, color: '#a5d6a7', width: 1, style: 0 }, { kind: 'polyline', pts: fb, color: '#ef9a9a', width: 1, style: 0 });
        return { conv, base, lag, spanA, spanB, graphics };
      } },
    { id: 'chandelier', name: 'Chandelier Exit', short: 'CE', kind: 'overlay', category: 'Trend', params: [P.int('length', 'ATR Period', 22), P.num('mult', 'ATR Multiplier', 3), P.bool('useClose', 'Use close for extremums', true)],
      outputs: [line('long', 'Long Stop', UP, { width: 2 }), line('short', 'Short Stop', DN, { width: 2 })],
      calc: (c, p) => {
        const n = c.length, a = atr(c, p.length), H = highest(p.useClose ? c.map((x) => x.close) : c.map((x) => x.high), p.length), L = lowest(p.useClose ? c.map((x) => x.close) : c.map((x) => x.low), p.length);
        const long = nan(n), short = nan(n), markers = [];
        let ls = NA, ss = NA, dir = 1;
        for (let i = 0; i < n; i++) {
          if (!ok(a[i]) || !ok(H[i]) || !ok(L[i])) continue;
          let l = H[i] - p.mult * a[i], s = L[i] + p.mult * a[i];
          const lp = ok(ls) ? ls : l, sp = ok(ss) ? ss : s, pc = i ? c[i - 1].close : c[i].close;
          if (pc > lp) l = Math.max(l, lp);
          if (pc < sp) s = Math.min(s, sp);
          const nd = c[i].close > sp ? 1 : c[i].close < lp ? -1 : dir;
          if (nd !== dir && ok(ls)) markers.push(nd === 1 ? { time: c[i].time, position: 'belowBar', shape: 'arrowUp', color: UP, text: 'Buy' } : { time: c[i].time, position: 'aboveBar', shape: 'arrowDown', color: DN, text: 'Sell' });
          dir = nd; ls = l; ss = s;
          if (dir === 1) long[i] = l; else short[i] = s;
        }
        return { long, short, markers };
      } },
    { id: 'zigzag', name: 'ZigZag', short: 'ZigZag', kind: 'overlay', category: 'Trend',
      params: [P.int('depth', 'Pivot legs (depth)', 10), P.num('deviation', 'Price deviation for reversals (%)', 0, 0.05), P.bool('extendLast', 'Extend to last bar', true), P.bool('labels', 'Show labels', true), P.color('color', 'Color', '#2962ff')], outputs: [],
      calc: (c, p, ctx) => {
        const z = swings(c, p.depth, p.deviation), n = c.length;
        if (!z.length) return { graphics: [] };
        const pts = z.map((q) => ({ t: q.t, p: q.p }));
        const last = z[z.length - 1];
        if (p.extendLast && last.i < n - 1) {
          let bi = last.i + 1;
          for (let i = last.i + 1; i < n; i++) if (last.type === 1 ? c[i].low < c[bi].low : c[i].high > c[bi].high) bi = i;
          pts.push({ t: c[bi].time, p: last.type === 1 ? c[bi].low : c[bi].high });
        }
        const g = [{ kind: 'polyline', pts, color: p.color, width: 2, style: 0 }];
        if (p.labels) z.forEach((q, k) => {
          const pv = k >= 2 ? z[k - 2] : null, tag = q.type === 1 ? (pv && q.p < pv.p ? 'LH' : 'HH') : pv && q.p > pv.p ? 'HL' : 'LL';
          g.push({ kind: 'label', t: q.t, p: q.p, text: `${pv ? tag : q.type === 1 ? 'H' : 'L'} ${fmtP(ctx, c, q.p)}`, color: q.type === 1 ? DN : UP, bg: 'transparent', align: 'center', base: q.type === 1 ? 'bottom' : 'top' });
        });
        return { graphics: g };
      } },
    { id: 'adx', name: 'Directional Movement (ADX / DMI)', short: 'DMI', kind: 'pane', category: 'Trend', params: [P.int('diLength', 'DI Length', 14), P.int('adxSmoothing', 'ADX Smoothing', 14)],
      outputs: [line('adx', 'ADX', '#ff6d00', { width: 2 }), line('plus', '+DI', '#2962ff'), line('minus', '-DI', '#ef5350')], levels: [25],
      calc: (c, p) => dmi(c, p.diLength, p.adxSmoothing) },
    { id: 'aroon', name: 'Aroon', short: 'Aroon', kind: 'pane', category: 'Trend', params: [P.len(14)], outputs: [line('up', 'Aroon Up', '#ff6d00'), line('down', 'Aroon Down', '#2962ff')], range: [0, 100], levels: [70, 30],
      calc: (c, p) => {
        const n = c.length, L = p.length, up = nan(n), down = nan(n);
        for (let i = L; i < n; i++) {
          let hi = i, lo = i;
          for (let k = i - L; k <= i; k++) { if (c[k].high >= c[hi].high) hi = k; if (c[k].low <= c[lo].low) lo = k; }
          up[i] = (100 * (L - (i - hi))) / L; down[i] = (100 * (L - (i - lo))) / L;
        }
        return { up, down };
      } },
    { id: 'vortex', name: 'Vortex Indicator', short: 'VI', kind: 'pane', category: 'Trend', params: [P.len(14)], outputs: [line('plus', 'VI +', '#2962ff'), line('minus', 'VI -', '#ef5350')], levels: [1],
      calc: (c, p) => {
        const vp = c.map((x, i) => (i ? Math.abs(x.high - c[i - 1].low) : NA)), vm = c.map((x, i) => (i ? Math.abs(x.low - c[i - 1].high) : NA)), t = rsum(tr(c).map((v, i) => (i ? v : NA)), p.length);
        const sp = rsum(vp, p.length), sm = rsum(vm, p.length);
        return { plus: sp.map((v, i) => v / t[i]), minus: sm.map((v, i) => v / t[i]) };
      } },
    { id: 'chop', name: 'Choppiness Index', short: 'CHOP', kind: 'pane', category: 'Trend', params: [P.len(14)], outputs: [line('v', 'CHOP', '#2962ff')], levels: [61.8, 50, 38.2], range: [0, 100],
      calc: (c, p) => { const s = rsum(tr(c), p.length), H = highest(c.map((x) => x.high), p.length), L = lowest(c.map((x) => x.low), p.length); return { v: s.map((v, i) => (H[i] > L[i] ? (100 * Math.log10(v / (H[i] - L[i]))) / Math.log10(p.length) : NA)) }; } },

    // ── Volume (tick volume) ─────────────────────────────
    { id: 'vol', name: 'Volume (IG tick volume)', short: 'Vol', kind: 'volume', category: 'Volume', params: [P.int('maLength', 'MA Length (0 = off)', 20, 0)],
      outputs: [hist('v', 'Vol'), line('ma', 'MA', '#2962ff')],
      calc: (c, p) => ({ v: c.map((x) => x.volume || 0), ma: p.maLength > 0 ? sma(c.map((x) => x.volume || 0), p.maLength) : nan(c.length), colors: { v: c.map((x) => (x.close >= x.open ? 'up' : 'down')) } }) },
    { id: 'vwap', name: 'VWAP (daily session, tick volume)', short: 'VWAP', kind: 'overlay', category: 'Volume', params: [P.src('hlc3'), P.sel('reset', 'Session reset', ['Local day', 'UTC day', 'Week'], 'Local day')],
      outputs: [line('v', 'VWAP', '#2196f3', { width: 2 })],
      calc: (c, p, ctx) => {
        const s = getSrc(c, ctx)(p.source), out = nan(c.length);
        const key = sessionKey(p.reset);
        let k0 = null, pv = 0, vv = 0;
        c.forEach((x, i) => { const k = key(x.time); if (k !== k0) { k0 = k; pv = 0; vv = 0; } if (!ok(s[i])) return; const v = x.volume || 1; pv += s[i] * v; vv += v; out[i] = pv / vv; });
        return { v: out };
      } },
    { id: 'avwap', name: 'Anchored VWAP (tick volume)', short: 'AVWAP', kind: 'overlay', category: 'Volume', params: [P.time('anchor', 'Anchor time (0 = first bar)'), P.src('hlc3'), P.num('mult', 'Band StdDev', 1)],
      outputs: [line('v', 'AVWAP', '#2196f3', { width: 2 }), line('upper', 'Upper Band', '#4caf50', { style: 1 }), line('lower', 'Lower Band', '#4caf50', { style: 1 })], fills: [{ a: 'upper', b: 'lower', color: 'rgba(76,175,80,0.06)' }],
      calc: (c, p, ctx) => {
        const s = getSrc(c, ctx)(p.source), n = c.length, v = nan(n), upper = nan(n), lower = nan(n);
        let pv = 0, vv = 0, p2 = 0;
        for (let i = anchorIdx(c, p.anchor); i < n; i++) {
          if (!ok(s[i])) continue;
          const w = c[i].volume || 1;
          pv += s[i] * w; vv += w; p2 += s[i] * s[i] * w;
          const m = pv / vv, sd = Math.sqrt(Math.max(0, p2 / vv - m * m));
          v[i] = m; upper[i] = m + p.mult * sd; lower[i] = m - p.mult * sd;
        }
        return { v, upper, lower };
      } },
    { id: 'obv', name: 'On Balance Volume (tick volume)', short: 'OBV', kind: 'pane', category: 'Volume', params: [], outputs: [line('v', 'OBV', '#2196f3')],
      calc: (c) => { let o = 0; return { v: c.map((x, i) => { if (i) o += x.close > c[i - 1].close ? x.volume || 0 : x.close < c[i - 1].close ? -(x.volume || 0) : 0; return o; }) }; } },
    { id: 'mfi', name: 'Money Flow Index (tick volume)', short: 'MFI', kind: 'pane', category: 'Volume', params: [P.len(14), P.src('hlc3')], outputs: [line('v', 'MF', '#7e57c2')], levels: [80, 50, 20], range: [0, 100],
      calc: (c, p, ctx) => {
        const s = getSrc(c, ctx)(p.source), ch = change(s);
        const u = rsum(s.map((v, i) => (ok(ch[i]) ? (ch[i] <= 0 ? 0 : v * (c[i].volume || 0)) : NA)), p.length), d = rsum(s.map((v, i) => (ok(ch[i]) ? (ch[i] >= 0 ? 0 : v * (c[i].volume || 0)) : NA)), p.length);
        return { v: u.map((x, i) => (!ok(x) ? NA : d[i] === 0 ? 100 : 100 - 100 / (1 + x / d[i]))) };
      } },
    { id: 'cmf', name: 'Chaikin Money Flow (tick volume)', short: 'CMF', kind: 'pane', category: 'Volume', params: [P.len(20)], outputs: [line('v', 'CMF', '#43a047')], levels: [0],
      calc: (c, p) => { const mf = rsum(c.map((x) => (x.high > x.low ? ((2 * x.close - x.low - x.high) / (x.high - x.low)) * (x.volume || 0) : 0)), p.length), vv = rsum(c.map((x) => x.volume || 0), p.length); return { v: mf.map((x, i) => (vv[i] ? x / vv[i] : 0)) }; } },
    { id: 'ad', name: 'Accumulation/Distribution (tick volume)', short: 'Accum/Dist', kind: 'pane', category: 'Volume', params: [], outputs: [line('v', 'A/D', '#999915')],
      calc: (c) => ({ v: cum(c.map((x) => (x.high > x.low ? ((2 * x.close - x.low - x.high) / (x.high - x.low)) * (x.volume || 0) : 0))) }) },
    { id: 'chaikinosc', name: 'Chaikin Oscillator (tick volume)', short: 'Chaikin Osc', kind: 'pane', category: 'Volume', params: [P.int('fast', 'Fast Length', 3), P.int('slow', 'Slow Length', 10)], outputs: [line('v', 'Chaikin Osc', '#ec407a')], levels: [0],
      calc: (c, p) => { const ad = cum(c.map((x) => (x.high > x.low ? ((2 * x.close - x.low - x.high) / (x.high - x.low)) * (x.volume || 0) : 0))); return { v: sub(ema(ad, p.fast), ema(ad, p.slow)) }; } },
    { id: 'efi', name: 'Elder Force Index (tick volume)', short: 'EFI', kind: 'pane', category: 'Volume', params: [P.len(13), P.src()], outputs: [line('v', 'EFI', '#f44336')], levels: [0],
      calc: (c, p, ctx) => ({ v: ema(change(getSrc(c, ctx)(p.source)).map((v, i) => v * (c[i].volume || 0)), p.length) }) },
    { id: 'eom', name: 'Ease of Movement (tick volume)', short: 'EOM', kind: 'pane', category: 'Volume', params: [P.len(14), P.num('divisor', 'Divisor', 10000, 100, 1)], outputs: [line('v', 'EOM', '#43a047')], levels: [0],
      calc: (c, p) => { const hl2 = c.map((x) => (x.high + x.low) / 2), ch = change(hl2); return { v: sma(c.map((x, i) => (x.volume ? (p.divisor * ch[i] * (x.high - x.low)) / x.volume : ok(ch[i]) ? 0 : NA)), p.length) }; } },
    { id: 'vo', name: 'Volume Oscillator (tick volume)', short: 'Vol Osc', kind: 'pane', category: 'Volume', params: [P.int('short', 'Short Length', 5), P.int('long', 'Long Length', 10)], outputs: [line('v', 'Vol Osc', '#2962ff')], levels: [0],
      calc: (c, p) => { const v = c.map((x) => x.volume || 0), s = ema(v, p.short), l = ema(v, p.long); return { v: s.map((x, i) => (l[i] ? (100 * (x - l[i])) / l[i] : NA)) }; } },
    { id: 'netvol', name: 'Net Volume (tick volume)', short: 'Net Vol', kind: 'pane', category: 'Volume', params: [P.src()], outputs: [hist('v', 'Net Volume')], levels: [0],
      calc: (c, p, ctx) => { const s = getSrc(c, ctx)(p.source), v = c.map((x, i) => (i && ok(s[i]) && ok(s[i - 1]) ? (s[i] > s[i - 1] ? 1 : s[i] < s[i - 1] ? -1 : 0) * (x.volume || 0) : NA)); return { v, colors: { v: updown(v) } }; } },
    { id: 'pvt', name: 'Price Volume Trend (tick volume)', short: 'PVT', kind: 'pane', category: 'Volume', params: [P.src()], outputs: [line('v', 'PVT', '#2962ff')],
      calc: (c, p, ctx) => { const s = getSrc(c, ctx)(p.source); return { v: cum(s.map((v, i) => (i && s[i - 1] ? ((v - s[i - 1]) / s[i - 1]) * (c[i].volume || 0) : NA))) }; } },
    { id: 'klinger', name: 'Klinger Oscillator (tick volume)', short: 'KVO', kind: 'pane', category: 'Volume', params: [P.int('fast', 'Fast Length', 34), P.int('slow', 'Slow Length', 55), P.int('signal', 'Signal Length', 13)],
      outputs: [line('kvo', 'KVO', '#2962ff'), line('sig', 'Signal', '#43a047')], levels: [0],
      calc: (c, p) => { const h = change(c.map((x) => (x.high + x.low + x.close) / 3)), sv = c.map((x, i) => (ok(h[i]) ? (h[i] >= 0 ? 1 : -1) * (x.volume || 0) : NA)), kvo = sub(ema(sv, p.fast), ema(sv, p.slow)); return { kvo, sig: ema(kvo, p.signal) }; } },

    // ── Oscillators ──────────────────────────────────────
    { id: 'rsi', name: 'Relative Strength Index', short: 'RSI', kind: 'pane', category: 'Oscillators', params: [P.len(14), P.src(), P.int('maLength', 'MA Length (0 = off)', 14, 0)],
      outputs: [line('v', 'RSI', '#7e57c2', { width: 2 }), line('ma', 'MA', '#f7b924')], levels: [70, 50, 30], range: [0, 100],
      calc: (c, p, ctx) => { const r = rsi(getSrc(c, ctx)(p.source), p.length); return { v: r, ma: p.maLength > 0 ? sma(r, p.maLength) : nan(c.length) }; } },
    { id: 'macd', name: 'MACD', short: 'MACD', kind: 'pane', category: 'Oscillators', params: [P.int('fast', 'Fast Length', 12), P.int('slow', 'Slow Length', 26), P.int('signal', 'Signal Length', 9), P.src()],
      outputs: [hist('hist', 'Histogram'), line('macd', 'MACD', '#2962ff'), line('sig', 'Signal', '#ff6d00')], levels: [0],
      calc: (c, p, ctx) => { const s = getSrc(c, ctx)(p.source), m = sub(ema(s, p.fast), ema(s, p.slow)), sg = ema(m, p.signal), h = sub(m, sg); return { macd: m, sig: sg, hist: h, colors: { hist: updown(h) } }; } },
    { id: 'stoch', name: 'Stochastic', short: 'Stoch', kind: 'pane', category: 'Oscillators', params: [P.int('k', '%K Length', 14), P.int('kSmooth', '%K Smoothing', 3), P.int('d', '%D Smoothing', 3)],
      outputs: [line('k', '%K', '#2962ff'), line('d', '%D', '#ff6d00')], levels: [80, 20], range: [0, 100],
      calc: (c, p) => {
        const h = highest(c.map((x) => x.high), p.k), l = lowest(c.map((x) => x.low), p.k);
        const raw = c.map((x, i) => (h[i] - l[i] ? (100 * (x.close - l[i])) / (h[i] - l[i]) : NA));
        const k = sma(raw, p.kSmooth); return { k, d: sma(k, p.d) };
      } },
    { id: 'stochrsi', name: 'Stochastic RSI', short: 'Stoch RSI', kind: 'pane', category: 'Oscillators', params: [P.int('k', 'K', 3), P.int('d', 'D', 3), P.int('rsiLength', 'RSI Length', 14), P.int('stochLength', 'Stochastic Length', 14), P.src()],
      outputs: [line('k', 'K', '#2962ff'), line('d', 'D', '#ff6d00')], levels: [80, 20], range: [0, 100],
      calc: (c, p, ctx) => {
        const r = rsi(getSrc(c, ctx)(p.source), p.rsiLength), h = highest(r, p.stochLength), l = lowest(r, p.stochLength);
        const raw = r.map((v, i) => (h[i] - l[i] ? (100 * (v - l[i])) / (h[i] - l[i]) : NA));
        const k = sma(raw, p.k); return { k, d: sma(k, p.d) };
      } },
    { id: 'cci', name: 'Commodity Channel Index', short: 'CCI', kind: 'pane', category: 'Oscillators', params: [P.len(20), P.src('hlc3')], outputs: [line('v', 'CCI', '#2196f3')], levels: [100, 0, -100],
      calc: (c, p, ctx) => {
        const s = getSrc(c, ctx)(p.source), m = sma(s, p.length);
        return { v: s.map((v, i) => { if (!ok(m[i])) return NA; let md = 0; for (let k = 0; k < p.length; k++) md += Math.abs(s[i - k] - m[i]); md /= p.length; return md ? (v - m[i]) / (0.015 * md) : 0; }) };
      } },
    { id: 'wpr', name: 'Williams %R', short: '%R', kind: 'pane', category: 'Oscillators', params: [P.len(14)], outputs: [line('v', '%R', '#7e57c2')], levels: [-20, -80], range: [-100, 0],
      calc: (c, p) => { const h = highest(c.map((x) => x.high), p.length), l = lowest(c.map((x) => x.low), p.length); return { v: c.map((x, i) => (h[i] - l[i] ? (-100 * (h[i] - x.close)) / (h[i] - l[i]) : NA)) }; } },
    { id: 'mom', name: 'Momentum', short: 'Mom', kind: 'pane', category: 'Oscillators', params: [P.len(10), P.src()], outputs: [line('v', 'Mom', '#2196f3')], levels: [0],
      calc: (c, p, ctx) => ({ v: change(getSrc(c, ctx)(p.source), p.length) }) },
    { id: 'roc', name: 'Rate Of Change', short: 'ROC', kind: 'pane', category: 'Oscillators', params: [P.len(9), P.src()], outputs: [line('v', 'ROC', '#2962ff')], levels: [0],
      calc: (c, p, ctx) => ({ v: roc(getSrc(c, ctx)(p.source), p.length) }) },
    { id: 'ao', name: 'Awesome Oscillator', short: 'AO', kind: 'pane', category: 'Oscillators', params: [P.int('fast', 'Fast Length', 5), P.int('slow', 'Slow Length', 34)], outputs: [hist('v', 'AO')], levels: [0],
      calc: (c, p) => { const m = c.map((x) => (x.high + x.low) / 2), v = sub(sma(m, p.fast), sma(m, p.slow)); return { v, colors: { v: rising(v) } }; } },
    { id: 'ac', name: 'Accelerator Oscillator', short: 'AC', kind: 'pane', category: 'Oscillators', params: [P.int('fast', 'Fast Length', 5), P.int('slow', 'Slow Length', 34), P.int('signal', 'Signal Length', 5)], outputs: [hist('v', 'AC')], levels: [0],
      calc: (c, p) => { const m = c.map((x) => (x.high + x.low) / 2), ao = sub(sma(m, p.fast), sma(m, p.slow)), v = sub(ao, sma(ao, p.signal)); return { v, colors: { v: rising(v) } }; } },
    { id: 'uo', name: 'Ultimate Oscillator', short: 'UO', kind: 'pane', category: 'Oscillators', params: [P.int('fast', 'Fast Length', 7), P.int('mid', 'Middle Length', 14), P.int('slow', 'Slow Length', 28)], outputs: [line('v', 'UO', '#f44336')], levels: [70, 50, 30], range: [0, 100],
      calc: (c, p) => {
        const bp = c.map((x, i) => (i ? x.close - Math.min(x.low, c[i - 1].close) : NA)), t = c.map((x, i) => (i ? Math.max(x.high, c[i - 1].close) - Math.min(x.low, c[i - 1].close) : NA));
        const av = (n) => { const a = rsum(bp, n), b = rsum(t, n); return a.map((v, i) => (b[i] ? v / b[i] : 0)); };
        const a1 = av(p.fast), a2 = av(p.mid), a3 = av(p.slow);
        return { v: a1.map((v, i) => (100 * (4 * v + 2 * a2[i] + a3[i])) / 7) };
      } },
    { id: 'trix', name: 'TRIX', short: 'TRIX', kind: 'pane', category: 'Oscillators', params: [P.len(18), P.src()], outputs: [line('v', 'TRIX', '#f44336')], levels: [0],
      calc: (c, p, ctx) => { const s = getSrc(c, ctx)(p.source).map((v) => (v > 0 ? Math.log(v) : NA)), e = ema(ema(ema(s, p.length), p.length), p.length); return { v: change(e).map((v) => v * 10000) }; } },
    { id: 'tsi', name: 'True Strength Index', short: 'TSI', kind: 'pane', category: 'Oscillators', params: [P.int('long', 'Long Length', 25), P.int('short', 'Short Length', 13), P.int('signal', 'Signal Length', 13), P.src()],
      outputs: [line('v', 'TSI', '#2962ff'), line('sig', 'Signal', '#e91e63')], levels: [0],
      calc: (c, p, ctx) => { const v = tsiRaw(getSrc(c, ctx)(p.source), p.short, p.long).map((x) => 100 * x); return { v, sig: ema(v, p.signal) }; } },
    { id: 'kst', name: 'Know Sure Thing', short: 'KST', kind: 'pane', category: 'Oscillators',
      params: [P.int('roc1', 'ROC Length #1', 10), P.int('roc2', 'ROC Length #2', 15), P.int('roc3', 'ROC Length #3', 20), P.int('roc4', 'ROC Length #4', 30), P.int('sma1', 'SMA Length #1', 10), P.int('sma2', 'SMA Length #2', 10), P.int('sma3', 'SMA Length #3', 10), P.int('sma4', 'SMA Length #4', 15), P.int('signal', 'Signal Length', 9), P.src()],
      outputs: [line('v', 'KST', '#089981'), line('sig', 'Signal', '#f23645')], levels: [0],
      calc: (c, p, ctx) => {
        const s = getSrc(c, ctx)(p.source), r = [1, 2, 3, 4].map((k) => sma(roc(s, p['roc' + k]), p['sma' + k])), v = r[0].map((x, i) => x + 2 * r[1][i] + 3 * r[2][i] + 4 * r[3][i]);
        return { v, sig: sma(v, p.signal) };
      } },
    { id: 'coppock', name: 'Coppock Curve', short: 'Coppock', kind: 'pane', category: 'Oscillators', params: [P.int('wma', 'WMA Length', 10), P.int('long', 'Long RoC Length', 14), P.int('short', 'Short RoC Length', 11), P.src()], outputs: [line('v', 'Coppock', '#2962ff')], levels: [0],
      calc: (c, p, ctx) => { const s = getSrc(c, ctx)(p.source), a = roc(s, p.long), b = roc(s, p.short); return { v: wma(a.map((v, i) => v + b[i]), p.wma) }; } },
    { id: 'dpo', name: 'Detrended Price Oscillator', short: 'DPO', kind: 'pane', category: 'Oscillators', params: [P.len(21), P.src()], outputs: [line('v', 'DPO', '#43a047')], levels: [0],
      calc: (c, p, ctx) => { const s = getSrc(c, ctx)(p.source), m = sma(s, p.length), bb = Math.floor(p.length / 2) + 1; return { v: s.map((v, i) => (i >= bb ? v - m[i - bb] : NA)) }; } },
    { id: 'rvi', name: 'Relative Vigor Index', short: 'RVGI', kind: 'pane', category: 'Oscillators', params: [P.len(10)], outputs: [line('v', 'RVGI', '#008000'), line('sig', 'Signal', '#ff0000')], levels: [0],
      calc: (c, p) => { const a = rsum(swma(c.map((x) => x.close - x.open)), p.length), b = rsum(swma(c.map((x) => x.high - x.low)), p.length), v = a.map((x, i) => (b[i] ? x / b[i] : 0)); return { v, sig: swma(v) }; } },
    { id: 'smii', name: 'SMI Ergodic Indicator/Oscillator', short: 'SMII', kind: 'pane', category: 'Oscillators', params: [P.int('long', 'Long Length', 20), P.int('short', 'Short Length', 5), P.int('signal', 'Signal Line Length', 5), P.src()],
      outputs: [hist('osc', 'Oscillator'), line('smi', 'SMI', '#2962ff'), line('sig', 'Signal', '#ff6d00')], levels: [0],
      calc: (c, p, ctx) => { const smi = tsiRaw(getSrc(c, ctx)(p.source), p.short, p.long), sig = ema(smi, p.signal), osc = sub(smi, sig); return { smi, sig, osc, colors: { osc: updown(osc) } }; } },
    { id: 'crsi', name: 'Connors RSI', short: 'CRSI', kind: 'pane', category: 'Oscillators', params: [P.int('rsiLength', 'RSI Length', 3), P.int('streakLength', 'UpDown Length', 2), P.int('rankLength', 'ROC Length', 100), P.src()],
      outputs: [line('v', 'CRSI', '#2962ff')], levels: [70, 50, 30], range: [0, 100],
      calc: (c, p, ctx) => {
        const s = getSrc(c, ctx)(p.source);
        let st = 0;
        const streak = s.map((v, i) => { if (!i || !ok(v) || !ok(s[i - 1])) return (st = 0); st = v > s[i - 1] ? Math.max(st, 0) + 1 : v < s[i - 1] ? Math.min(st, 0) - 1 : 0; return st; });
        const a = rsi(s, p.rsiLength), b = rsi(streak, p.streakLength), r = percentrank(roc(s, 1), p.rankLength);
        return { v: a.map((v, i) => (v + b[i] + r[i]) / 3) };
      } },
    { id: 'fisher', name: 'Fisher Transform', short: 'Fisher', kind: 'pane', category: 'Oscillators', params: [P.len(9)], outputs: [line('v', 'Fisher', '#2962ff'), line('trig', 'Trigger', '#ff6d00')], levels: [1.5, 0.75, 0, -0.75, -1.5],
      calc: (c, p) => {
        const m = c.map((x) => (x.high + x.low) / 2), H = highest(m, p.length), L = lowest(m, p.length), v = nan(c.length), trig = nan(c.length);
        let val = 0, f = 0;
        for (let i = 0; i < c.length; i++) {
          if (!ok(H[i])) continue;
          const r = H[i] - L[i];
          val = 0.66 * (r > 0 ? (m[i] - L[i]) / r - 0.5 : 0) + 0.67 * val;
          val = Math.max(-0.999, Math.min(0.999, val));
          trig[i] = f;
          f = 0.5 * Math.log((1 + val) / (1 - val)) + 0.5 * f;
          v[i] = f;
        }
        return { v, trig };
      } },
    { id: 'sqz', name: 'Squeeze Momentum (LazyBear)', short: 'SQZMOM', kind: 'pane', category: 'Oscillators',
      params: [P.int('bbLength', 'BB Length', 20), P.num('bbMult', 'BB MultFactor', 2), P.int('kcLength', 'KC Length', 20), P.num('kcMult', 'KC MultFactor', 1.5), P.bool('useTR', 'Use TrueRange (KC)', true)],
      outputs: [hist('v', 'Momentum', '#00e676'), line('sqz', 'Squeeze', '#2962ff', { dots: true, width: 2 })], levels: [0],
      calc: (c, p) => {
        const cl = c.map((x) => x.close), h = c.map((x) => x.high), l = c.map((x) => x.low);
        const basis = sma(cl, p.bbLength), dev = stdev(cl, p.bbLength), ma = sma(cl, p.kcLength), rg = sma(p.useTR ? tr(c) : c.map((x) => x.high - x.low), p.kcLength);
        const H = highest(h, p.kcLength), L = lowest(l, p.kcLength), val = linreg(cl.map((v, i) => v - ((H[i] + L[i]) / 2 + ma[i]) / 2), p.kcLength, 0);
        const sqz = c.map((_, i) => (ok(basis[i]) && ok(rg[i]) ? 0 : NA)), sc = c.map((_, i) => {
          const ub = basis[i] + p.bbMult * dev[i], lb = basis[i] - p.bbMult * dev[i], uk = ma[i] + p.kcMult * rg[i], lk = ma[i] - p.kcMult * rg[i];
          return lb > lk && ub < uk ? '#ff9800' : lb < lk && ub > uk ? '#787b86' : '#2962ff';
        });
        const vc = val.map((v, i) => { const pv = i && ok(val[i - 1]) ? val[i - 1] : 0; return v > 0 ? (v > pv ? '#00e676' : '#008000') : v < pv ? '#ff1744' : '#800000'; });
        return { v: val, sqz, colors: { v: vc, sqz: sc } };
      } },
    { id: 'ppo', name: 'Percentage Price Oscillator', short: 'PPO', kind: 'pane', category: 'Oscillators', params: [P.int('fast', 'Fast Length', 12), P.int('slow', 'Slow Length', 26), P.int('signal', 'Signal Length', 9), P.src()],
      outputs: [hist('hist', 'Histogram'), line('v', 'PPO', '#2962ff'), line('sig', 'Signal', '#ff6d00')], levels: [0],
      calc: (c, p, ctx) => { const s = getSrc(c, ctx)(p.source), f = ema(s, p.fast), sl = ema(s, p.slow), v = f.map((x, i) => (sl[i] ? (100 * (x - sl[i])) / sl[i] : NA)), sig = ema(v, p.signal), h = sub(v, sig); return { v, sig, hist: h, colors: { hist: updown(h) } }; } },
    { id: 'bop', name: 'Balance of Power', short: 'BOP', kind: 'pane', category: 'Oscillators', params: [P.int('smooth', 'Smoothing (1 = off)', 1)], outputs: [line('v', 'BOP', '#f44336')], levels: [0], range: [-1, 1],
      calc: (c, p) => { const v = c.map((x) => (x.high > x.low ? (x.close - x.open) / (x.high - x.low) : 0)); return { v: p.smooth > 1 ? sma(v, p.smooth) : v }; } },
    { id: 'elderray', name: 'Elder Ray (Bull/Bear Power)', short: 'Elder Ray', kind: 'pane', category: 'Oscillators', params: [P.len(13)], outputs: [hist('bull', 'Bull Power', UP), hist('bear', 'Bear Power', DN)], levels: [0],
      calc: (c, p) => { const e = ema(c.map((x) => x.close), p.length), bull = c.map((x, i) => x.high - e[i]), bear = c.map((x, i) => x.low - e[i]); return { bull, bear, colors: { bull: updown(bull), bear: updown(bear) } }; } },
    { id: 'cmo', name: 'Chande Momentum Oscillator', short: 'ChandeMO', kind: 'pane', category: 'Oscillators', params: [P.len(9), P.src()], outputs: [line('v', 'ChandeMO', '#2962ff')], levels: [50, 0, -50], range: [-100, 100],
      calc: (c, p, ctx) => { const m = change(getSrc(c, ctx)(p.source)), a = rsum(m.map((v) => (ok(v) ? (v >= 0 ? v : 0) : NA)), p.length), b = rsum(m.map((v) => (ok(v) ? (v >= 0 ? 0 : -v) : NA)), p.length); return { v: a.map((x, i) => (x + b[i] ? (100 * (x - b[i])) / (x + b[i]) : 0)) }; } },

    // ── Volatility ───────────────────────────────────────
    { id: 'atr', name: 'Average True Range', short: 'ATR', kind: 'pane', category: 'Volatility', params: [P.len(14)], outputs: [line('v', 'ATR', '#ef5350')],
      calc: (c, p) => ({ v: atr(c, p.length) }) },
    { id: 'bbpct', name: 'Bollinger Bands %B', short: '%B', kind: 'pane', category: 'Volatility', params: [P.len(20), P.src(), P.num('mult', 'StdDev', 2)], outputs: [line('v', '%B', '#26a69a')], levels: [1, 0.5, 0],
      calc: (c, p, ctx) => { const s = getSrc(c, ctx)(p.source), m = sma(s, p.length), d = stdev(s, p.length); return { v: s.map((v, i) => (d[i] ? (v - (m[i] - p.mult * d[i])) / (2 * p.mult * d[i]) : NA)) }; } },
    { id: 'bbw', name: 'Bollinger BandWidth', short: 'BBW', kind: 'pane', category: 'Volatility', params: [P.len(20), P.src(), P.num('mult', 'StdDev', 2)], outputs: [line('v', 'BBW', '#2962ff')],
      calc: (c, p, ctx) => { const s = getSrc(c, ctx)(p.source), m = sma(s, p.length), d = stdev(s, p.length); return { v: m.map((v, i) => (v ? (2 * p.mult * d[i]) / v : NA)) }; } },
    { id: 'hv', name: 'Historical Volatility', short: 'HV', kind: 'pane', category: 'Volatility', params: [P.len(10), P.int('annual', 'Annual periods', 365)], outputs: [line('v', 'HV', '#2962ff')],
      calc: (c, p, ctx) => { const cl = c.map((x) => x.close), per = tfOf(c, ctx) >= 7 * DAY ? 7 : 1, k = 100 * Math.sqrt(p.annual / per); return { v: stdev(cl.map((v, i) => (i && cl[i - 1] > 0 && v > 0 ? Math.log(v / cl[i - 1]) : NA)), p.length).map((v) => v * k) }; } },
    { id: 'stdev', name: 'Standard Deviation', short: 'StdDev', kind: 'pane', category: 'Volatility', params: [P.len(20), P.src()], outputs: [line('v', 'StdDev', '#2962ff')],
      calc: (c, p, ctx) => ({ v: stdev(getSrc(c, ctx)(p.source), p.length) }) },
    { id: 'massi', name: 'Mass Index', short: 'Mass Index', kind: 'pane', category: 'Volatility', params: [P.len(10, 'Sum Length'), P.int('emaLength', 'EMA Length', 9)], outputs: [line('v', 'Mass Index', '#2962ff')], levels: [27, 26.5],
      calc: (c, p) => { const e1 = ema(c.map((x) => x.high - x.low), p.emaLength), e2 = ema(e1, p.emaLength); return { v: rsum(e1.map((v, i) => (e2[i] ? v / e2[i] : NA)), p.length) }; } },
    { id: 'adr', name: 'Average Day Range', short: 'ADR', kind: 'pane', category: 'Volatility', params: [P.len(14, 'Days')], outputs: [line('v', 'ADR', '#2962ff')],
      calc: (c, p) => {
        const g = groups(c, (t) => Math.floor(t / DAY)), out = nan(c.length);
        let sum = 0;
        g.forEach((d, k) => {
          if (k) { sum += g[k - 1].high - g[k - 1].low; if (k > p.length) sum -= g[k - 1 - p.length].high - g[k - 1 - p.length].low; }
          const cnt = Math.min(k, p.length);
          let hi = -Infinity, lo = Infinity;
          for (let i = d.i0; i <= d.i1; i++) { hi = Math.max(hi, c[i].high); lo = Math.min(lo, c[i].low); out[i] = cnt ? sum / cnt : hi - lo; }
        });
        return { v: out };
      } },

    // ── Support/resistance ───────────────────────────────
    { id: 'pivots', name: 'Pivot Points Standard', short: 'Pivots', kind: 'overlay', category: 'Support/resistance',
      params: [P.sel('type', 'Type', ['Traditional', 'Fibonacci', 'Woodie', 'Classic', 'DM', 'Camarilla']), P.sel('timeframe', 'Pivots Timeframe', ['Auto', ...PERIODS]), P.int('count', 'Number of Pivots Back', 15, 1, 200), P.bool('labels', 'Show Labels', true), P.bool('prices', 'Show Prices', true)], outputs: [],
      calc: (c, p, ctx) => {
        const per = p.timeframe === 'Auto' ? autoPeriod(tfOf(c, ctx)) : p.timeframe, g = groups(c, (t) => periodKey(t, per)), graphics = [];
        for (let k = Math.max(1, g.length - p.count); k < g.length; k++) {
          const pr = g[k - 1], cur = g[k], lv = pivotLevels(p.type, pr.high, pr.low, pr.close, pr.open, cur.open);
          const t1 = c[cur.i0].time, t2 = k + 1 < g.length ? c[g[k + 1].i0].time : Math.max(periodEnd(cur.key, per), lastT(c));
          for (const [name, price] of Object.entries(lv)) {
            if (!ok(price)) continue;
            const col = name === 'P' ? '#ff9800' : name[0] === 'R' ? '#ef5350' : '#26a69a';
            graphics.push({ kind: 'line', t1, p1: price, t2, p2: price, color: col, width: 1, style: 0, extend: 'none' });
            if (p.labels || p.prices) graphics.push({ kind: 'label', t: t1, p: price, text: [p.labels ? name : '', p.prices ? `(${fmtP(ctx, c, price)})` : ''].filter(Boolean).join(' '), color: col, bg: 'transparent', align: 'left', base: 'bottom' });
          }
        }
        return { graphics };
      } },
    { id: 'pdhl', name: 'Previous Day/Week High-Low', short: 'PDH/PDL', kind: 'overlay', category: 'Support/resistance',
      params: [P.bool('day', 'Previous day', true), P.bool('week', 'Previous week', true), P.int('count', 'Periods back', 10, 1, 200), P.color('dayColor', 'Day color', '#ff9800'), P.color('weekColor', 'Week color', '#2962ff')], outputs: [],
      calc: (c, p) => {
        const graphics = [];
        const draw = (per, col, hiName, loName) => {
          const g = groups(c, (t) => periodKey(t, per));
          for (let k = Math.max(1, g.length - p.count); k < g.length; k++) {
            const pr = g[k - 1], t1 = c[g[k].i0].time, last = k === g.length - 1, t2 = last ? lastT(c) : c[g[k + 1].i0].time;
            for (const [price, name] of [[pr.high, hiName], [pr.low, loName]]) {
              graphics.push({ kind: 'line', t1, p1: price, t2, p2: price, color: col, width: 1, style: per === 'Week' ? 1 : 0, extend: last ? 'right' : 'none' });
              if (last) graphics.push({ kind: 'label', t: t2, p: price, text: name, color: col, bg: 'transparent', align: 'left', base: 'middle' });
            }
          }
        };
        if (p.day) draw('Day', p.dayColor, 'PDH', 'PDL');
        if (p.week) draw('Week', p.weekColor, 'PWH', 'PWL');
        return { graphics };
      } },
    { id: 'orb', name: 'Session / Opening Range', short: 'ORB', kind: 'overlay', category: 'Support/resistance',
      params: [P.int('startHour', 'Session start hour (UTC)', 8, 0, 23), P.int('startMinute', 'Session start minute', 0, 0, 59), P.int('orMinutes', 'Opening range (minutes)', 30, 1, 1440), P.num('sessionHours', 'Session length (hours)', 8.5, 0.5, 0.5), P.int('count', 'Sessions back', 10, 1, 200), P.bool('session', 'Show session high/low box', true)], outputs: [],
      calc: (c, p) => {
        const off = p.startHour * 3600 + p.startMinute * 60, sLen = Math.min(DAY, p.sessionHours * 3600), orLen = p.orMinutes * 60, S = new Map();
        for (const x of c) {
          const idx = Math.floor((x.time - off) / DAY), s0 = idx * DAY + off, d = x.time - s0;
          if (d >= sLen || !ok(x.high) || !ok(x.low)) continue;
          let s = S.get(idx);
          if (!s) S.set(idx, (s = { s0, oh: -Infinity, ol: Infinity, h: -Infinity, l: Infinity }));
          if (d < orLen) { s.oh = Math.max(s.oh, x.high); s.ol = Math.min(s.ol, x.low); }
          s.h = Math.max(s.h, x.high); s.l = Math.min(s.l, x.low);
        }
        const graphics = [];
        for (const s of [...S.values()].slice(-p.count)) {
          const orEnd = s.s0 + orLen, sEnd = s.s0 + sLen;
          if (p.session) graphics.push({ kind: 'box', t1: s.s0, p1: s.h, t2: sEnd, p2: s.l, color: 'rgba(120,123,134,0.6)', fill: 'rgba(120,123,134,0.05)' });
          if (!ok(s.oh)) continue;
          graphics.push({ kind: 'box', t1: s.s0, p1: s.oh, t2: Math.min(orEnd, sEnd), p2: s.ol, color: '#2962ff', fill: 'rgba(41,98,255,0.15)', text: 'OR', textColor: '#2962ff' });
          if (orEnd < sEnd) graphics.push(
            { kind: 'line', t1: orEnd, p1: s.oh, t2: sEnd, p2: s.oh, color: '#26a69a', width: 1, style: 1, extend: 'none', label: 'ORH' },
            { kind: 'line', t1: orEnd, p1: s.ol, t2: sEnd, p2: s.ol, color: '#ef5350', width: 1, style: 1, extend: 'none', label: 'ORL' });
        }
        return { graphics };
      } },
    { id: 'fractals', name: 'Williams Fractals', short: 'Fractals', kind: 'overlay', category: 'Support/resistance', params: [P.int('periods', 'Periods', 2)], outputs: [],
      calc: (c, p) => {
        const n = p.periods, markers = [];
        for (let i = n; i < c.length - n; i++) {
          let up = true, dn = true;
          for (let k = 1; k <= n; k++) { if (!(c[i].high > c[i - k].high && c[i].high > c[i + k].high)) up = false; if (!(c[i].low < c[i - k].low && c[i].low < c[i + k].low)) dn = false; }
          if (up) markers.push({ time: c[i].time, position: 'aboveBar', shape: 'arrowDown', color: DN, text: '' });
          if (dn) markers.push({ time: c[i].time, position: 'belowBar', shape: 'arrowUp', color: UP, text: '' });
        }
        return { markers };
      } },
    { id: 'autofib', name: 'Auto Fib Retracement', short: 'Auto Fib', kind: 'overlay', category: 'Support/resistance',
      params: [P.int('lookback', 'Lookback (bars)', 300, 10, 5000), P.int('depth', 'Pivot depth', 10), P.bool('reverse', 'Reverse', false), P.bool('extensions', 'Show 1.272 / 1.618', false), P.bool('extendRight', 'Extend right', true), P.bool('prices', 'Show prices', true)], outputs: [],
      calc: (c, p, ctx) => {
        const n = c.length;
        if (n < 2) return { graphics: [] };
        const i0 = Math.max(0, n - p.lookback), z = swings(c, p.depth).filter((q) => q.i >= i0);
        let hi = null, lo = null;
        for (const q of z) { if (q.type === 1 && (!hi || q.p > hi.p)) hi = q; if (q.type === -1 && (!lo || q.p < lo.p)) lo = q; }
        if (!hi || !lo) {
          let a = i0, b = i0;
          for (let i = i0; i < n; i++) { if (c[i].high > c[a].high) a = i; if (c[i].low < c[b].low) b = i; }
          hi = { i: a, t: c[a].time, p: c[a].high }; lo = { i: b, t: c[b].time, p: c[b].low };
        }
        if (!(hi.p > lo.p)) return { graphics: [] };
        const upLeg = lo.i <= hi.i !== p.reverse, start = lo.i <= hi.i ? lo : hi, end = lo.i <= hi.i ? hi : lo, R = hi.p - lo.p;
        const LV = [[0, '#787b86'], [0.236, '#f44336'], [0.382, '#81c784'], [0.5, '#4caf50'], [0.618, '#009688'], [0.786, '#64b5f6'], [1, '#787b86'], ...(p.extensions ? [[1.272, '#2962ff'], [1.618, '#9c27b0']] : [])];
        const g = [{ kind: 'line', t1: start.t, p1: start.p, t2: end.t, p2: end.p, color: '#787b86', width: 1, style: 1, extend: 'none' }];
        for (const [r, col] of LV) {
          const price = upLeg ? hi.p - r * R : lo.p + r * R;
          g.push({ kind: 'line', t1: start.t, p1: price, t2: lastT(c), p2: price, color: col, width: 1, style: 0, extend: p.extendRight ? 'right' : 'none' });
          g.push({ kind: 'label', t: start.t, p: price, text: p.prices ? `${r} (${fmtP(ctx, c, price)})` : String(r), color: col, bg: 'transparent', align: 'right', base: 'middle' });
        }
        return { graphics: g };
      } },

    // ── Patterns ─────────────────────────────────────────
    { id: 'candles', name: 'Candlestick Pattern Recognition', short: 'Candle Patterns', kind: 'overlay', category: 'Patterns',
      params: [P.int('trendLength', 'Trend SMA length (0 = no trend filter)', 50, 0), ...CANDLE_PATTERNS.map(([k, label]) => P.bool(k, label, true))], outputs: [],
      calc: (c, p) => ({ markers: candlePatterns(c, p) }) },
    { id: 'chartpatterns', name: 'Auto Chart Patterns', short: 'Chart Patterns', kind: 'overlay', category: 'Patterns',
      params: [P.int('depth', 'Pivot depth', 5), P.num('tolerance', 'Level tolerance (fraction of height)', 0.15, 0.01), P.num('minAtr', 'Min height (ATR multiples)', 1.5, 0.1), P.int('maxPatterns', 'Max patterns shown', 10, 1, 200),
        P.bool('doubles', 'Double top/bottom', true), P.bool('headShoulders', 'Head & shoulders (and inverse)', true), P.bool('triangles', 'Triangles', true), P.bool('wedges', 'Wedges', true), P.bool('channels', 'Channels', true)], outputs: [],
      calc: (c, p) => ({ graphics: chartPatterns(c, p) }) },

    // ── Profiles ─────────────────────────────────────────
    { id: 'vpfr', name: 'Volume Profile Fixed Range (tick volume)', short: 'FRVP', kind: 'overlay', category: 'Profiles',
      params: [P.time('start', 'Start time (0 = last N bars)'), P.time('end', 'End time (0 = last bar)'), P.int('bars', 'Bars (when start = 0)', 150, 2, 5000), P.int('rows', 'Rows', 24, 2, 500), P.int('va', 'Value Area %', 70, 1, 100), P.num('width', 'Width (% of range)', 30, 1, 1)], outputs: [],
      calc: (c, p) => {
        const n = c.length;
        if (!n) return { graphics: [] };
        let i1 = n - 1;
        if (p.end) { i1 = anchorIdx(c, p.end + 1) - 1; if (i1 < 0) return { graphics: [] }; }
        const i0 = p.start ? anchorIdx(c, p.start) : Math.max(0, i1 - p.bars + 1);
        if (i0 > i1) return { graphics: [] };
        const pr = volProfile(c, i0, i1, p.rows, p.va / 100);
        return { graphics: [{ kind: 'hprofile', t0: c[i0].time, t1: i1 === n - 1 ? null : c[i1].time, ...pr, widthPct: p.width / 100, anchor: 'left', colors: VP_COLORS }] };
      } },
    { id: 'vpvr', name: 'Volume Profile (last N bars, tick volume)', short: 'VPVR', kind: 'overlay', category: 'Profiles',
      params: [P.int('bars', 'Bars', 300, 2, 5000), P.int('rows', 'Rows', 24, 2, 500), P.int('va', 'Value Area %', 70, 1, 100), P.num('width', 'Width (% of pane)', 25, 1, 1)], outputs: [],
      calc: (c, p) => {
        const n = c.length;
        if (!n) return { graphics: [] };
        const i0 = Math.max(0, n - p.bars), pr = volProfile(c, i0, n - 1, p.rows, p.va / 100);
        return { graphics: [{ kind: 'hprofile', t0: c[i0].time, t1: null, ...pr, widthPct: p.width / 100, anchor: 'right', colors: VP_COLORS }] };
      } },
    { id: 'svp', name: 'Session Volume Profile (tick volume)', short: 'SVP', kind: 'overlay', category: 'Profiles',
      params: [P.sel('session', 'Session', ['Day', 'Week']), P.int('rows', 'Rows', 24, 2, 500), P.int('va', 'Value Area %', 70, 1, 100), P.int('count', 'Sessions back', 10, 1, 200), P.num('width', 'Width (% of session)', 60, 1, 1)], outputs: [],
      calc: (c, p) => {
        const g = groups(c, (t) => periodKey(t, p.session)), n = c.length;
        return { graphics: g.slice(-p.count).map((s) => ({ kind: 'hprofile', t0: c[s.i0].time, t1: s.i1 === n - 1 ? null : c[s.i1].time, ...volProfile(c, s.i0, s.i1, p.rows, p.va / 100), widthPct: p.width / 100, anchor: 'left', colors: VP_COLORS })) };
      } },
    { id: 'tpo', name: 'Time Price Opportunity (TPO)', short: 'TPO', kind: 'overlay', category: 'Profiles',
      params: [P.int('periodMinutes', 'Letter period (minutes)', 30, 1, 1440), P.int('rows', 'Rows', 24, 2, 500), P.int('va', 'Value Area %', 70, 1, 100), P.int('count', 'Sessions back', 5, 1, 100), P.color('color', 'Color', '#2962ff')], outputs: [],
      calc: (c, p) => {
        const g = groups(c, (t) => Math.floor(t / DAY)), n = c.length;
        return { graphics: g.slice(-p.count).map((s) => ({ kind: 'tpo', t0: c[s.i0].time, t1: s.i1 === n - 1 ? null : c[s.i1].time, ...tpoProfile(c, s.i0, s.i1, p.rows, p.va / 100, s.key * DAY, p.periodMinutes * 60), color: p.color })) };
      } },

    // ══ Extended library ═════════════════════════════════
    // ── Moving averages ──────────────────────────────────
    MA('zlema', 'Zero Lag EMA', 'ZLEMA', '#00e5ff', 21, (s, p) => { const lag = Math.floor((p.length - 1) / 2); return ema(s.map((v, i) => (i >= lag ? 2 * v - s[i - lag] : NA)), p.length); }),
    MA('t3', 'Tillson T3 Moving Average', 'T3', '#ff4081', 5, (s, p) => t3(s, p.length, p.vfactor), 'Moving averages', [tip(P.num('vfactor', 'Volume factor', 0.7, 0.05), 'Tillson T3: six cascaded EMAs combined with volume factor b')]),
    MA('vidya', 'Variable Index Dynamic Average', 'VIDYA', '#7c4dff', 9, (s, p) => {
      const out = nan(s.length), n = p.length, m = change(s), a = 2 / (n + 1), u = rsumP(m.map((v) => (ok(v) ? Math.max(v, 0) : NA)), n), d = rsumP(m.map((v) => (ok(v) ? Math.max(-v, 0) : NA)), n);
      let prev = NA;
      for (let i = 0; i < s.length; i++) {
        if (!ok(u[i]) || !ok(s[i])) continue;
        const k = u[i] + d[i] ? Math.abs((u[i] - d[i]) / (u[i] + d[i])) : 0;
        prev = ok(prev) ? s[i] * a * k + prev * (1 - a * k) : s[i];
        out[i] = prev;
      }
      return out;
    }),
    MA('frama', 'Fractal Adaptive Moving Average (Ehlers)', 'FRAMA', '#ffab40', 16, (s, p, c) => {
      const N = Math.max(2, p.length + (p.length % 2)), h2 = N / 2, out = nan(s.length);
      let f = NA;
      for (let i = 0; i < s.length; i++) {
        if (!ok(s[i])) continue;
        if (i < N - 1) continue;
        if (!ok(f)) { f = s[i]; out[i] = f; continue; }
        let h1 = -Infinity, l1 = Infinity, hh = -Infinity, ll = Infinity;
        for (let k = 0; k < h2; k++) { h1 = Math.max(h1, c[i - k].high); l1 = Math.min(l1, c[i - k].low); hh = Math.max(hh, c[i - h2 - k].high); ll = Math.min(ll, c[i - h2 - k].low); }
        const n1 = (h1 - l1) / h2, n2 = (hh - ll) / h2, n3 = (Math.max(h1, hh) - Math.min(l1, ll)) / N;
        const D = n1 > 0 && n2 > 0 && n3 > 0 ? (Math.log(n1 + n2) - Math.log(n3)) / Math.LN2 : 1, al = Math.min(1, Math.max(0.01, Math.exp(-4.6 * (D - 1))));
        f = al * s[i] + (1 - al) * f;
        out[i] = f;
      }
      return out;
    }, 'Moving averages', []),
    MA('jma', 'JMA-style smoother (approximation)', 'JMA~', '#18ffff', 7, (s, p) => onValid(s, (x) => {
      const pr = p.phase < -100 ? 0.5 : p.phase > 100 ? 2.5 : p.phase / 100 + 1.5, beta = (0.45 * (p.length - 1)) / (0.45 * (p.length - 1) + 2), al = beta ** p.power, out = new Array(x.length);
      let e0 = x[0], e1 = 0, e2 = 0, j = x[0];
      for (let i = 0; i < x.length; i++) {
        e0 = (1 - al) * x[i] + al * e0; e1 = (x[i] - e0) * (1 - beta) + beta * e1; e2 = (e0 + pr * e1 - j) * (1 - al) ** 2 + al * al * e2; j = e2 + j;
        out[i] = j;
      }
      return out;
    }), 'Moving averages', [tip(P.num('phase', 'Phase (-100..100)', 50, 1, -100), 'Public-domain Jurik approximation; not the proprietary JMA'), P.num('power', 'Power', 2, 0.5, 0.5)]),
    { id: 'gmma', name: 'Guppy Multiple Moving Average', short: 'GMMA', kind: 'overlay', category: 'Moving averages', params: [P.src()],
      outputs: [3, 5, 8, 10, 12, 15].map((n) => line('s' + n, 'Short ' + n, '#26c6da')).concat([30, 35, 40, 45, 50, 60].map((n) => line('l' + n, 'Long ' + n, '#ef5350'))),
      calc: (c, p, ctx) => { const s = getSrc(c, ctx)(p.source), o = {}; [3, 5, 8, 10, 12, 15].forEach((n) => (o['s' + n] = ema(s, n))); [30, 35, 40, 45, 50, 60].forEach((n) => (o['l' + n] = ema(s, n))); return o; } },
    { id: 'rainbow', name: 'Rainbow Moving Average', short: 'Rainbow', kind: 'overlay', category: 'Moving averages', params: [tip(P.len(2), 'Widner: ten recursive SMAs, each of the previous one'), P.src()],
      outputs: ['#f44336', '#ff5722', '#ff9800', '#ffc107', '#ffeb3b', '#cddc39', '#8bc34a', '#4caf50', '#00bcd4', '#2196f3'].map((col, k) => line('r' + (k + 1), 'MA ' + (k + 1), col)),
      calc: (c, p, ctx) => { let s = getSrc(c, ctx)(p.source); const o = {}; for (let k = 1; k <= 10; k++) o['r' + k] = s = sma(s, p.length); return o; } },
    { id: 'tmacross', name: 'Triple MA Cross', short: '3MA Cross', kind: 'overlay', category: 'Moving averages',
      params: [P.src(), P.ma('EMA'), P.int('fast', 'Fast Length', 9), P.int('mid', 'Medium Length', 21), P.int('slow', 'Slow Length', 50)],
      outputs: [line('fast', 'Fast', '#43a047'), line('mid', 'Medium', '#ffb300'), line('slow', 'Slow', '#ef5350')],
      calc: (c, p, ctx) => {
        const s = getSrc(c, ctx)(p.source), v = c.map((x) => x.volume || 0), f = maBy(p.maType, s, p.fast, v), m = maBy(p.maType, s, p.mid, v), sl = maBy(p.maType, s, p.slow, v), markers = [];
        let st = 0;
        for (let i = 0; i < c.length; i++) {
          if (![f[i], m[i], sl[i]].every(ok)) continue;
          const ns = f[i] > m[i] && m[i] > sl[i] ? 1 : f[i] < m[i] && m[i] < sl[i] ? -1 : 0;
          if (ns && ns !== st) markers.push(ns === 1 ? mkUp(c[i].time, 'Bull') : mkDn(c[i].time, 'Bear'));
          st = ns || st;
        }
        return { fast: f, mid: m, slow: sl, markers };
      } },
    MA('trima', 'Triangular Moving Average', 'TRIMA', '#9575cd', 20, (s, p) => trima(s, p.length)),
    { id: 'hullsuite', name: 'Hull Suite', short: 'Hull Suite', kind: 'overlay', category: 'Moving averages', params: [P.src(), P.sel('mode', 'Hull variation', ['Hma', 'Ehma', 'Thma']), P.len(55)],
      outputs: [line('mhull', 'MHULL', UP, { width: 2 }), line('shull', 'SHULL', UP)], fills: [{ a: 'mhull', b: 'shull', color: 'rgba(120,123,134,0.2)' }],
      calc: (c, p, ctx) => {
        const s = getSrc(c, ctx)(p.source), n = p.length, f = Math.floor;
        const h = p.mode === 'Ehma' ? ema(sub(ema(s, Math.max(1, f(n / 2))).map((v) => 2 * v), ema(s, n)), Math.max(1, f(Math.sqrt(n))))
          : p.mode === 'Thma' ? (() => { const L = Math.max(1, f(n / 2)), a = wma(s, Math.max(1, f(L / 3))), b = wma(s, Math.max(1, f(L / 2))), d = wma(s, L); return wma(a.map((v, i) => 3 * v - b[i] - d[i]), L); })()
          : hma(s, n);
        const sh = shift(h, 2), col = h.map((v, i) => (v > sh[i] ? 'up' : 'down'));
        return { mhull: h, shull: sh, colors: { mhull: col, shull: col } };
      } },
    { id: 'mama', name: 'MESA Adaptive Moving Average (MAMA / FAMA)', short: 'MAMA', kind: 'overlay', category: 'Moving averages',
      params: [P.src('hl2'), tip(P.num('fast', 'Fast Limit', 0.5, 0.01, 0.01), 'Ehlers MESA: Hilbert-transform phase rate sets the EMA alpha'), P.num('slow', 'Slow Limit', 0.05, 0.01, 0.001)],
      outputs: [line('mama', 'MAMA', '#00e676', { width: 2 }), line('fama', 'FAMA', '#ff1744')],
      calc: (c, p, ctx) => onValid(getSrc(c, ctx)(p.source), (x) => {
        const n = x.length, z = () => new Array(n).fill(0), sm = z(), det = z(), q1 = z(), i1 = z(), i2 = z(), q2 = z(), re = z(), im = z(), per = z(), ph = z(), mama = new Array(n).fill(NA), fama = new Array(n).fill(NA);
        const hil = (a, i) => 0.0962 * a[i] + 0.5769 * a[i - 2] - 0.5769 * a[i - 4] - 0.0962 * a[i - 6];
        let m = x[0], f = x[0];
        for (let i = 0; i < n; i++) {
          if (i < 6) { m = f = x[i]; if (i >= 3) sm[i] = (4 * x[i] + 3 * x[i - 1] + 2 * x[i - 2] + x[i - 3]) / 10; continue; }
          sm[i] = (4 * x[i] + 3 * x[i - 1] + 2 * x[i - 2] + x[i - 3]) / 10;
          const adj = 0.075 * per[i - 1] + 0.54;
          det[i] = hil(sm, i) * adj; q1[i] = hil(det, i) * adj; i1[i] = det[i - 3];
          const jI = hil(i1, i) * adj, jQ = hil(q1, i) * adj;
          i2[i] = 0.2 * (i1[i] - jQ) + 0.8 * i2[i - 1]; q2[i] = 0.2 * (q1[i] + jI) + 0.8 * q2[i - 1];
          re[i] = 0.2 * (i2[i] * i2[i - 1] + q2[i] * q2[i - 1]) + 0.8 * re[i - 1]; im[i] = 0.2 * (i2[i] * q2[i - 1] - q2[i] * i2[i - 1]) + 0.8 * im[i - 1];
          let P0 = im[i] !== 0 && re[i] !== 0 ? (2 * Math.PI) / Math.atan(im[i] / re[i]) : per[i - 1];
          if (per[i - 1] > 0) P0 = Math.min(Math.max(P0, 0.67 * per[i - 1]), 1.5 * per[i - 1]);
          P0 = Math.min(Math.max(P0, 6), 50);
          per[i] = 0.2 * P0 + 0.8 * per[i - 1];
          ph[i] = i1[i] !== 0 ? (Math.atan(q1[i] / i1[i]) * 180) / Math.PI : 0;
          const dp = Math.max(1, ph[i - 1] - ph[i]), al = Math.min(p.fast, Math.max(p.slow, p.fast / dp));
          m = al * x[i] + (1 - al) * m; f = 0.5 * al * m + (1 - 0.5 * al) * f;
          if (i >= 10) { mama[i] = m; fama[i] = f; }
        }
        return { mama, fama };
      }) },
    MA('ssf', 'Ehlers Super Smoother', 'SSF', '#ffd740', 10, (s, p) => superSmoother(s, p.length)),
    { id: 'itrend', name: 'Ehlers Instantaneous Trendline', short: 'iTrend', kind: 'overlay', category: 'Moving averages', params: [P.src('hl2'), tip(P.num('alpha', 'Alpha', 0.07, 0.01, 0.01), 'Ehlers, Cybernetic Analysis ch. 2')],
      outputs: [line('it', 'iTrend', '#29b6f6', { width: 2 }), line('trig', 'Trigger', '#ef5350')],
      calc: (c, p, ctx) => onValid(getSrc(c, ctx)(p.source), (x) => {
        const a = p.alpha, it = new Array(x.length), trig = new Array(x.length);
        for (let i = 0; i < x.length; i++) {
          it[i] = i < 7 ? (i < 2 ? x[i] : (x[i] + 2 * x[i - 1] + x[i - 2]) / 4)
            : (a - (a * a) / 4) * x[i] + 0.5 * a * a * x[i - 1] - (a - 0.75 * a * a) * x[i - 2] + 2 * (1 - a) * it[i - 1] - (1 - a) ** 2 * it[i - 2];
          trig[i] = i >= 2 ? 2 * it[i] - it[i - 2] : NA;
        }
        return { it, trig };
      }) },
    MA('decycler', 'Ehlers Simple Decycler', 'Decycler', '#ba68c8', 125, (s, p) => onValid(s, (x) => { const hp = highPass2(x, p.length); return x.map((v, i) => v - hp[i]); })),
    { id: 'haov', name: 'Smoothed Heikin Ashi (overlay)', short: 'Smoothed HA', kind: 'overlay', category: 'Moving averages', params: [P.int('len1', 'Pre-smoothing EMA', 10), P.int('len2', 'Post-smoothing EMA', 10)],
      outputs: [line('open', 'HA Open', UP), line('close', 'HA Close', UP, { width: 2 })], fills: [{ a: 'open', b: 'close', color: 'rgba(120,123,134,0.18)' }],
      calc: (c, p) => {
        const e = (f) => ema(c.map(f), p.len1), o = e((x) => x.open), h = e((x) => x.high), l = e((x) => x.low), cl = e((x) => x.close), n = c.length, hc = nan(n), ho = nan(n);
        for (let i = 0; i < n; i++) {
          if (!ok(o[i])) continue;
          hc[i] = (o[i] + h[i] + l[i] + cl[i]) / 4;
          ho[i] = ok(ho[i - 1]) ? (ho[i - 1] + hc[i - 1]) / 2 : (o[i] + cl[i]) / 2;
        }
        const so = ema(ho, p.len2), sc = ema(hc, p.len2), col = sc.map((v, i) => (v >= so[i] ? 'up' : 'down'));
        return { open: so, close: sc, colors: { open: col, close: col } };
      } },
    { id: 'medprice', name: 'Median Price', short: 'MedPrice', kind: 'overlay', category: 'Trend', params: [], outputs: [line('v', '(H+L)/2', '#ffb74d')], calc: (c) => ({ v: c.map((x) => (x.high + x.low) / 2) }) },
    { id: 'typprice', name: 'Typical Price', short: 'TypPrice', kind: 'overlay', category: 'Trend', params: [], outputs: [line('v', '(H+L+C)/3', '#4fc3f7')], calc: (c) => ({ v: c.map((x) => (x.high + x.low + x.close) / 3) }) },
    { id: 'wclose', name: 'Weighted Close', short: 'WClose', kind: 'overlay', category: 'Trend', params: [], outputs: [line('v', '(H+L+2C)/4', '#aed581')], calc: (c) => ({ v: c.map((x) => (x.high + x.low + 2 * x.close) / 4) }) },

    // ── Trend ────────────────────────────────────────────
    { id: 'rangefilter', name: 'Range Filter', short: 'Range Filter', kind: 'overlay', category: 'Trend', params: [P.src(), tip(P.int('period', 'Sampling Period', 100), 'DonovanWall range filter: EMA-smoothed average bar move × multiplier'), P.num('mult', 'Range Multiplier', 3)],
      outputs: [line('filt', 'Filter', UP, { width: 2 }), line('hi', 'High Target', 'rgba(38,166,154,0.6)', { style: 2 }), line('lo', 'Low Target', 'rgba(239,83,80,0.6)', { style: 2 })],
      calc: (c, p, ctx) => {
        const s = getSrc(c, ctx)(p.source), n = c.length, rng = ema(ema(change(s).map(Math.abs), p.period), 2 * p.period - 1).map((v) => v * p.mult);
        const filt = nan(n), hi = nan(n), lo = nan(n), col = new Array(n).fill('up'), markers = [];
        let f = NA, dir = 0;
        for (let i = 0; i < n; i++) {
          if (!ok(rng[i]) || !ok(s[i])) continue;
          const x = s[i], r = rng[i], pf = ok(f) ? f : x;
          f = x > pf ? (x - r < pf ? pf : x - r) : x + r > pf ? pf : x + r;
          const nd = f > pf ? 1 : f < pf ? -1 : dir;
          if (nd && nd !== dir && dir) markers.push(nd === 1 ? mkUp(c[i].time, 'Buy') : mkDn(c[i].time, 'Sell'));
          dir = nd;
          filt[i] = f; hi[i] = f + r; lo[i] = f - r; col[i] = dir === -1 ? 'down' : 'up';
        }
        return { filt, hi, lo, colors: { filt: col }, markers };
      } },
    { id: 'stmulti', name: 'Supertrend Multi (3×)', short: 'ST×3', kind: 'overlay', category: 'Trend',
      params: [P.int('atr1', 'ATR #1', 10), P.num('f1', 'Factor #1', 1), P.int('atr2', 'ATR #2', 11), P.num('f2', 'Factor #2', 2), P.int('atr3', 'ATR #3', 12), P.num('f3', 'Factor #3', 3)],
      outputs: [line('st1', 'ST #1', UP, { colorDown: DN }), line('st2', 'ST #2', UP, { colorDown: DN }), line('st3', 'ST #3', UP, { width: 2, colorDown: DN })],
      calc: (c, p) => {
        const o = { colors: {} }, markers = [], dirs = [];
        [1, 2, 3].forEach((k) => { const r = superTrend(c, p['atr' + k], p['f' + k]); o['st' + k] = r.v; o.colors['st' + k] = r.dir.map((d) => (d === -1 ? 'down' : 'up')); dirs.push(r.dir); });
        let agree = 0;
        for (let i = 0; i < c.length; i++) {
          const s = dirs[0][i] + dirs[1][i] + dirs[2][i], a = s === 3 ? 1 : s === -3 ? -1 : 0;
          if (a && a !== agree && agree) markers.push(a === 1 ? mkUp(c[i].time, '3×Up') : mkDn(c[i].time, '3×Dn'));
          if (a) agree = a;
        }
        return { ...o, markers };
      } },
    { id: 'atrts', name: 'ATR Trailing Stop', short: 'ATR TS', kind: 'overlay', category: 'Trend', params: [P.int('length', 'ATR Period', 14), P.num('mult', 'ATR Multiplier', 3)],
      outputs: [line('v', 'Trailing Stop', UP, { width: 2, colorDown: DN })],
      calc: (c, p) => {
        const a = atr(c, p.length), n = c.length, v = nan(n), col = new Array(n).fill('up'), markers = [];
        let ts = NA;
        for (let i = 0; i < n; i++) {
          if (!ok(a[i])) continue;
          const x = c[i].close, px = i ? c[i - 1].close : x, loss = p.mult * a[i], pt = ts;
          ts = !ok(pt) ? x - loss : x > pt && px > pt ? Math.max(pt, x - loss) : x < pt && px < pt ? Math.min(pt, x + loss) : x > pt ? x - loss : x + loss;
          if (ok(pt)) { if (px <= pt && x > pt) markers.push(mkUp(c[i].time, 'Buy')); else if (px >= pt && x < pt) markers.push(mkDn(c[i].time, 'Sell')); }
          v[i] = ts; col[i] = x >= ts ? 'up' : 'down';
        }
        return { v, colors: { v: col }, markers };
      } },
    { id: 'volstop', name: 'Volatility Stop', short: 'VStop', kind: 'overlay', category: 'Trend', params: [P.len(20), P.src(), P.num('mult', 'Multiplier', 2)],
      outputs: [line('v', 'VStop', UP, { dots: true, colorDown: DN })],
      calc: (c, p, ctx) => {
        const s = getSrc(c, ctx)(p.source), a = atr(c, p.length), n = c.length, v = nan(n), col = new Array(n).fill('up');
        let mx = NA, mn = NA, stop = NA, up = true;
        for (let i = 0; i < n; i++) {
          if (!ok(a[i]) || !ok(s[i])) continue;
          const m = a[i] * p.mult, x = s[i];
          if (!ok(stop)) { mx = mn = x; stop = x - m; up = true; }
          mx = Math.max(mx, x); mn = Math.min(mn, x);
          stop = up ? Math.max(stop, mx - m) : Math.min(stop, mn + m);
          const nu = x - stop >= 0;
          if (nu !== up) { mx = mn = x; stop = nu ? mx - m : mn + m; up = nu; }
          v[i] = stop; col[i] = up ? 'up' : 'down';
        }
        return { v, colors: { v: col } };
      } },
    { id: 'alligator', name: 'Williams Alligator', short: 'Alligator', kind: 'overlay', category: 'Trend', params: ALLIGATOR_PARAMS,
      outputs: [line('jaw', 'Jaw', '#2962ff'), line('teeth', 'Teeth', '#e91e63'), line('lips', 'Lips', '#66bb6a')], calc: (c, p) => alligator(c, p) },
    { id: 'lrslope', name: 'Linear Regression Slope', short: 'LR Slope', kind: 'pane', category: 'Trend', params: [P.len(14), P.src()], outputs: [hist('v', 'Slope')], levels: [0],
      calc: (c, p, ctx) => { const v = lrSlope(getSrc(c, ctx)(p.source), Math.max(2, p.length)); return { v, colors: { v: updown(v) } }; } },
    { id: 'vhf', name: 'Vertical Horizontal Filter', short: 'VHF', kind: 'pane', category: 'Trend', params: [P.len(28), P.src()], outputs: [line('v', 'VHF', '#ff9800')],
      calc: (c, p, ctx) => { const s = getSrc(c, ctx)(p.source), H = highest(s, p.length), L = lowest(s, p.length), d = rsumP(change(s).map(Math.abs), p.length); return { v: H.map((h, i) => (d[i] ? (h - L[i]) / d[i] : NA)) }; } },
    { id: 'rwi', name: 'Random Walk Index', short: 'RWI', kind: 'pane', category: 'Trend', params: [P.len(14)], outputs: [line('hi', 'RWI High', '#26a69a'), line('lo', 'RWI Low', '#ef5350')], levels: [1],
      calc: (c, p) => {
        const n = p.length, a = atr(c, n), k = Math.sqrt(n);
        return { hi: c.map((x, i) => (i >= n && a[i] ? (x.high - c[i - n].low) / (a[i] * k) : NA)), lo: c.map((x, i) => (i >= n && a[i] ? (c[i - n].high - x.low) / (a[i] * k) : NA)) };
      } },
    { id: 'tii', name: 'Trend Intensity Index', short: 'TII', kind: 'pane', category: 'Trend', params: [tip(P.int('major', 'Major (SMA) Length', 60), 'M.H. Pee: share of positive deviations from the SMA over the minor window'), P.int('minor', 'Minor Length', 30), P.int('signal', 'Signal Length', 9), P.src()],
      outputs: [line('v', 'TII', '#00bcd4'), line('sig', 'Signal', '#ff9800')], levels: [80, 50, 20], range: [0, 100],
      calc: (c, p, ctx) => {
        const s = getSrc(c, ctx)(p.source), m = sma(s, p.major), d = s.map((v, i) => v - m[i]), pos = rsumP(d.map((v) => (ok(v) ? Math.max(v, 0) : NA)), p.minor), neg = rsumP(d.map((v) => (ok(v) ? Math.max(-v, 0) : NA)), p.minor);
        const v = pos.map((x, i) => (x + neg[i] ? (100 * x) / (x + neg[i]) : ok(x) ? 50 : NA));
        return { v, sig: ema(v, p.signal) };
      } },
    { id: 'adxi', name: 'Average Directional Index', short: 'ADX', kind: 'pane', category: 'Trend', params: [P.int('adxSmoothing', 'ADX Smoothing', 14), P.int('diLength', 'DI Length', 14)], outputs: [line('v', 'ADX', '#ff6d00', { width: 2 })], levels: [25],
      calc: (c, p) => ({ v: dmi(c, p.diLength, p.adxSmoothing).adx }) },
    { id: 'dicross', name: 'ADX DI Cross signals', short: 'DI Cross', kind: 'overlay', category: 'Trend', params: [P.int('diLength', 'DI Length', 14), P.int('adxSmoothing', 'ADX Smoothing', 14), P.num('minAdx', 'Min ADX (0 = off)', 20, 1)], outputs: [],
      calc: (c, p) => {
        const d = dmi(c, p.diLength, p.adxSmoothing), markers = [];
        for (let i = 1; i < c.length; i++) {
          if (p.minAdx > 0 && !(d.adx[i] >= p.minAdx)) continue;
          if (crossUp(d.plus, d.minus, i)) markers.push(mkUp(c[i].time, '+DI'));
          else if (crossDn(d.plus, d.minus, i)) markers.push(mkDn(c[i].time, '-DI'));
        }
        return { markers };
      } },
    { id: 'elderimpulse', name: 'Elder Impulse System', short: 'Impulse', kind: 'overlay', category: 'Trend', params: [P.int('emaLength', 'EMA Length', 13), P.int('fast', 'MACD Fast', 12), P.int('slow', 'MACD Slow', 26), P.int('signal', 'MACD Signal', 9)],
      outputs: [line('ema', 'Impulse EMA', '#2962ff', { width: 3 })],
      calc: (c, p) => {
        const cl = c.map((x) => x.close), e = ema(cl, p.emaLength), m = sub(ema(cl, p.fast), ema(cl, p.slow)), h = sub(m, ema(m, p.signal));
        const col = e.map((v, i) => { if (!i) return '#2962ff'; const er = v > e[i - 1], ef = v < e[i - 1], hr = h[i] > h[i - 1], hf = h[i] < h[i - 1]; return er && hr ? UP : ef && hf ? DN : '#2962ff'; });
        return { ema: e, colors: { ema: col } };
      } },
    { id: 'safezone', name: 'Elder SafeZone Stops', short: 'SafeZone', kind: 'overlay', category: 'Trend', params: [P.int('length', 'Lookback', 10), P.num('coef', 'Coefficient', 2.5), P.int('stick', 'Stickiness (bars)', 3)],
      outputs: [line('long', 'Long Stop', UP, { style: 2 }), line('short', 'Short Stop', DN, { style: 2 })],
      calc: (c, p) => {
        const n = c.length, dp = c.map((x, i) => (i ? (x.low < c[i - 1].low ? c[i - 1].low - x.low : 0) : NA)), up = c.map((x, i) => (i ? (x.high > c[i - 1].high ? x.high - c[i - 1].high : 0) : NA));
        const sD = rsum(dp, p.length), cD = rsum(dp.map((v) => (ok(v) ? (v > 0 ? 1 : 0) : NA)), p.length), sU = rsum(up, p.length), cU = rsum(up.map((v) => (ok(v) ? (v > 0 ? 1 : 0) : NA)), p.length);
        const lr = c.map((x, i) => (i && ok(sD[i]) ? c[i - 1].low - p.coef * (cD[i] ? sD[i] / cD[i] : 0) : NA)), sr = c.map((x, i) => (i && ok(sU[i]) ? c[i - 1].high + p.coef * (cU[i] ? sU[i] / cU[i] : 0) : NA));
        return { long: highest(lr, p.stick), short: lowest(sr, p.stick) };
      } },
    { id: 'ckstop', name: 'Chande Kroll Stop', short: 'CK Stop', kind: 'overlay', category: 'Trend', params: [P.int('p', 'ATR Length (p)', 10), P.num('x', 'ATR Coefficient (x)', 1), P.int('q', 'Stop Length (q)', 9)],
      outputs: [line('stopLong', 'Stop Long', UP), line('stopShort', 'Stop Short', DN)],
      calc: (c, p) => {
        const a = atr(c, p.p), H = highest(c.map((x) => x.high), p.p), L = lowest(c.map((x) => x.low), p.p);
        return { stopShort: highest(H.map((v, i) => v - p.x * a[i]), p.q), stopLong: lowest(L.map((v, i) => v + p.x * a[i]), p.q) };
      } },
    { id: 'asi', name: 'Accumulative Swing Index', short: 'ASI', kind: 'pane', category: 'Trend', params: [tip(P.num('limit', 'Limit move T (0 = unscaled)', 0, 0.0001), "Wilder's Swing Index; T only rescales the index (FX has no exchange limit move)")], outputs: [line('v', 'ASI', '#2962ff')], levels: [0],
      calc: (c, p) => ({ v: cum(swingIndex(c, p.limit)) }) },
    { id: 'er', name: 'Kaufman Efficiency Ratio', short: 'ER', kind: 'pane', category: 'Trend', params: [P.len(10), P.src()], outputs: [line('v', 'ER', '#ab47bc')], range: [0, 1], levels: [0.5],
      calc: (c, p, ctx) => { const s = getSrc(c, ctx)(p.source), d = rsumP(change(s).map(Math.abs), p.length); return { v: s.map((v, i) => (i >= p.length && ok(d[i]) ? (d[i] ? Math.abs(v - s[i - p.length]) / d[i] : 0) : NA)) }; } },

    // ── Bands & channels ─────────────────────────────────
    { id: 'atrbands', name: 'ATR Bands', short: 'ATR Bands', kind: 'overlay', category: 'Bands & channels', params: [P.int('length', 'ATR Length', 14), P.num('mult', 'Multiplier', 2), P.src()],
      outputs: [line('upper', 'Upper', '#26a69a'), line('lower', 'Lower', '#ef5350')], fills: [{ a: 'upper', b: 'lower', color: 'rgba(120,123,134,0.06)' }],
      calc: (c, p, ctx) => { const s = getSrc(c, ctx)(p.source), a = atr(c, p.length); return { upper: s.map((v, i) => v + p.mult * a[i]), lower: s.map((v, i) => v - p.mult * a[i]) }; } },
    { id: 'fcb', name: 'Fractal Chaos Bands', short: 'FCB', kind: 'overlay', category: 'Bands & channels', params: [tip(P.int('periods', 'Fractal periods', 2), 'Levels update only once the fractal is confirmed (no lookahead)')],
      outputs: [line('upper', 'Upper', '#2962ff'), line('lower', 'Lower', '#2962ff')], fills: [{ a: 'upper', b: 'lower', color: 'rgba(41,98,255,0.05)' }],
      calc: (c, p) => {
        const n = p.periods, ph = new Set(pivotIdx(c.map((x) => x.high), n, n, true)), pl = new Set(pivotIdx(c.map((x) => x.low), n, n, false)), upper = nan(c.length), lower = nan(c.length);
        let u = NA, l = NA;
        for (let i = 0; i < c.length; i++) { const j = i - n; if (ph.has(j)) u = c[j].high; if (pl.has(j)) l = c[j].low; upper[i] = u; lower[i] = l; }
        return { upper, lower };
      } },
    { id: 'pricechannel', name: 'Price Channel', short: 'PC', kind: 'overlay', category: 'Bands & channels', params: [P.len(20), tip(P.int('offset', 'Offset (bars)', 1, 0, 100), 'Donchian extremes of the bars before the current one (breakout reference)')],
      outputs: [line('upper', 'Upper', '#f44336'), line('basis', 'Center', '#2962ff', { style: 2 }), line('lower', 'Lower', '#4caf50')],
      calc: (c, p) => { const h = shift(highest(c.map((x) => x.high), p.length), p.offset), l = shift(lowest(c.map((x) => x.low), p.length), p.offset); return { upper: h, lower: l, basis: h.map((v, i) => (v + l[i]) / 2) }; } },
    { id: 'seb', name: 'Standard Error Bands', short: 'SEB', kind: 'overlay', category: 'Bands & channels', params: [P.len(21), P.src(), P.num('mult', 'Std errors', 2), P.int('smooth', 'Smoothing', 3)],
      outputs: [line('basis', 'Regression', '#ff6d00'), line('upper', 'Upper', '#2962ff'), line('lower', 'Lower', '#2962ff')], fills: [{ a: 'upper', b: 'lower', color: 'rgba(41,98,255,0.06)' }],
      calc: (c, p, ctx) => {
        const s = getSrc(c, ctx)(p.source), n = Math.max(3, p.length), lr = linreg(s, n), sl = lrSlope(s, n), se = nan(c.length);
        for (let i = n - 1; i < c.length; i++) {
          if (!ok(lr[i])) continue;
          let e = 0;
          for (let k = 0; k < n; k++) e += (s[i - k] - (lr[i] - sl[i] * k)) ** 2;
          se[i] = Math.sqrt(e / (n - 2));
        }
        const b = sma(lr, p.smooth), d = sma(se, p.smooth);
        return { basis: b, upper: b.map((v, i) => v + p.mult * d[i]), lower: b.map((v, i) => v - p.mult * d[i]) };
      } },
    { id: 'dbb', name: 'Double Bollinger Bands', short: 'DBB', kind: 'overlay', category: 'Bands & channels', params: [P.len(20), P.src(), P.num('inner', 'Inner StdDev', 1), P.num('outer', 'Outer StdDev', 2)],
      outputs: [line('basis', 'Basis', '#ff6d00'), line('upper2', 'Upper 2σ', '#26a69a'), line('upper1', 'Upper 1σ', '#26a69a', { style: 2 }), line('lower1', 'Lower 1σ', '#ef5350', { style: 2 }), line('lower2', 'Lower 2σ', '#ef5350')],
      fills: [{ a: 'upper2', b: 'upper1', color: 'rgba(38,166,154,0.1)' }, { a: 'lower1', b: 'lower2', color: 'rgba(239,83,80,0.1)' }],
      calc: (c, p, ctx) => { const s = getSrc(c, ctx)(p.source), m = sma(s, p.length), d = stdev(s, p.length), a = bands(m, d, p.inner), b = bands(m, d, p.outer); return { basis: m, upper1: a.upper, lower1: a.lower, upper2: b.upper, lower2: b.lower }; } },
    { id: 'starc', name: 'STARC Bands', short: 'STARC', kind: 'overlay', category: 'Bands & channels', params: [P.int('length', 'SMA Length', 6), P.int('atrLength', 'ATR Length', 15), P.num('mult', 'ATR Multiplier', 2)],
      outputs: [line('basis', 'Basis', '#ff6d00'), line('upper', 'Upper', '#2962ff'), line('lower', 'Lower', '#2962ff')], fills: [{ a: 'upper', b: 'lower', color: 'rgba(41,98,255,0.05)' }],
      calc: (c, p) => { const m = sma(c.map((x) => x.close), p.length); return { basis: m, ...bands(m, atr(c, p.atrLength), p.mult) }; } },
    { id: 'projbands', name: 'Projection Bands', short: 'Proj Bands', kind: 'overlay', category: 'Bands & channels', params: [tip(P.len(14), 'Widner: highs/lows projected forward along their linear-regression slope')],
      outputs: [line('upper', 'Upper', '#2962ff'), line('lower', 'Lower', '#2962ff')], fills: [{ a: 'upper', b: 'lower', color: 'rgba(41,98,255,0.05)' }],
      calc: (c, p) => projBands(c, Math.max(2, p.length)) },

    // ── Volatility ───────────────────────────────────────
    { id: 'dcw', name: 'Donchian Channel Width', short: 'DCW', kind: 'pane', category: 'Volatility', params: [P.len(20)], outputs: [line('v', 'Width %', '#2962ff')],
      calc: (c, p) => { const h = highest(c.map((x) => x.high), p.length), l = lowest(c.map((x) => x.low), p.length); return { v: h.map((v, i) => (v + l[i] ? (200 * (v - l[i])) / (v + l[i]) : NA)) }; } },
    { id: 'kcw', name: 'Keltner Channel Width', short: 'KCW', kind: 'pane', category: 'Volatility', params: [P.len(20), P.num('mult', 'Multiplier', 2), P.int('atrLength', 'ATR Length', 10), P.src()], outputs: [line('v', 'KCW', '#2962ff')],
      calc: (c, p, ctx) => { const m = ema(getSrc(c, ctx)(p.source), p.length), a = atr(c, p.atrLength); return { v: m.map((v, i) => (v ? (2 * p.mult * a[i]) / v : NA)) }; } },
    { id: 'ulcer', name: 'Ulcer Index', short: 'UI', kind: 'pane', category: 'Volatility', params: [P.len(14), P.src()], outputs: [line('v', 'Ulcer', '#ef5350')],
      calc: (c, p, ctx) => { const s = getSrc(c, ctx)(p.source), H = highest(s, p.length), dd = s.map((v, i) => (H[i] ? (100 * (v - H[i])) / H[i] : NA)); return { v: sma(dd.map((v) => v * v), p.length).map(Math.sqrt) }; } },
    { id: 'relvol', name: 'Relative Volatility Index', short: 'RVI', kind: 'pane', category: 'Volatility', params: [tip(P.int('stdLength', 'StdDev Length', 10), 'Dorsey: RSI-style ratio of up-move vs down-move standard deviation'), P.int('length', 'Smoothing Length', 14), P.src()],
      outputs: [line('v', 'RVI', '#7e57c2')], levels: [80, 50, 20], range: [0, 100],
      calc: (c, p, ctx) => ({ v: relVolIdx(getSrc(c, ctx)(p.source), p.stdLength, p.length) }) },
    { id: 'chvol', name: 'Chaikin Volatility', short: 'ChVol', kind: 'pane', category: 'Volatility', params: [P.int('length', 'EMA Length', 10), P.int('rocLength', 'ROC Length', 10)], outputs: [line('v', 'ChVol', '#ff9800')], levels: [0],
      calc: (c, p) => ({ v: roc(ema(c.map((x) => x.high - x.low), p.length), p.rocLength) }) },
    { id: 'atrp', name: 'Average True Range Percent (Normalized ATR)', short: 'ATR%', kind: 'pane', category: 'Volatility', params: [P.len(14)], outputs: [line('v', 'ATR %', '#ef5350')],
      calc: (c, p) => { const a = atr(c, p.length); return { v: a.map((v, i) => (c[i].close ? (100 * v) / c[i].close : NA)) }; } },
    { id: 'truerange', name: 'True Range', short: 'TR', kind: 'pane', category: 'Volatility', params: [], outputs: [hist('v', 'TR', '#ef5350')], calc: (c) => ({ v: tr(c) }) },
    { id: 'wvf', name: 'Williams VIX Fix', short: 'WVF', kind: 'pane', category: 'Volatility',
      params: [P.int('pd', 'Lookback (highest close)', 22), P.int('bbl', 'BB Length', 20), P.num('mult', 'BB StdDev', 2), P.int('lb', 'Percentile Lookback', 50), P.num('ph', 'Highest Percentile', 0.85, 0.01)],
      outputs: [hist('v', 'WVF', '#787b86'), line('upper', 'Upper Band', '#2962ff', { style: 2 }), line('rangeHigh', 'Range High', '#ff9800', { style: 2 })],
      calc: (c, p) => {
        const H = highest(c.map((x) => x.close), p.pd), v = c.map((x, i) => (H[i] ? (100 * (H[i] - x.low)) / H[i] : NA)), m = sma(v, p.bbl), sd = stdev(v, p.bbl), upper = m.map((x, i) => x + p.mult * sd[i]);
        const rh = highest(v, p.lb).map((x) => x * p.ph), col = v.map((x, i) => (x >= upper[i] || x >= rh[i] ? '#00e676' : '#787b86'));
        return { v, upper, rangeHigh: rh, colors: { v: col } };
      } },
    { id: 'skew', name: 'Historical Skewness (log returns)', short: 'Skew', kind: 'pane', category: 'Volatility', params: [P.len(30), P.src()], outputs: [line('v', 'Skew', '#26c6da')], levels: [0],
      calc: (c, p, ctx) => ({ v: moments(logRet(getSrc(c, ctx)(p.source)), Math.max(3, p.length)).skew }) },
    { id: 'kurt', name: 'Historical Excess Kurtosis (log returns)', short: 'Kurt', kind: 'pane', category: 'Volatility', params: [P.len(30), P.src()], outputs: [line('v', 'Kurtosis', '#ab47bc')], levels: [0],
      calc: (c, p, ctx) => ({ v: moments(logRet(getSrc(c, ctx)(p.source)), Math.max(4, p.length)).kurt }) },

    // ── Oscillators ──────────────────────────────────────
    { id: 'gator', name: 'Gator Oscillator', short: 'Gator', kind: 'pane', category: 'Oscillators', params: ALLIGATOR_PARAMS, outputs: [hist('upper', 'Upper'), hist('lower', 'Lower')], levels: [0],
      calc: (c, p) => {
        const a = alligator(c, p), upper = a.jaw.map((v, i) => Math.abs(v - a.teeth[i])), lower = a.teeth.map((v, i) => -Math.abs(v - a.lips[i]));
        const col = (x) => x.map((v, i) => (i && Math.abs(v) > Math.abs(x[i - 1]) ? 'up' : 'down'));
        return { upper, lower, colors: { upper: col(upper), lower: col(lower) } };
      } },
    { id: 'projosc', name: 'Projection Oscillator', short: 'Proj Osc', kind: 'pane', category: 'Oscillators', params: [P.len(14), P.int('signal', 'Signal Length', 3)], outputs: [line('v', 'PO', '#2962ff'), line('sig', 'Signal', '#ff6d00')], levels: [80, 50, 20], range: [0, 100],
      calc: (c, p) => { const b = projBands(c, Math.max(2, p.length)), v = c.map((x, i) => (b.upper[i] > b.lower[i] ? (100 * (x.close - b.lower[i])) / (b.upper[i] - b.lower[i]) : NA)); return { v, sig: ema(v, p.signal) }; } },
    { id: 'stc', name: 'Schaff Trend Cycle', short: 'STC', kind: 'pane', category: 'Oscillators', params: [P.int('fast', 'Fast Length', 23), P.int('slow', 'Slow Length', 50), P.int('cycle', 'Cycle Length', 10), P.num('factor', 'Factor', 0.5, 0.05), P.src()],
      outputs: [line('v', 'STC', '#e91e63', { width: 2 })], levels: [75, 25], range: [0, 100],
      calc: (c, p, ctx) => {
        const s = getSrc(c, ctx)(p.source), m = sub(ema(s, p.fast), ema(s, p.slow));
        const stage = (x) => {
          const L = lowest(x, p.cycle), H = highest(x, p.cycle), out = nan(x.length);
          let f = 0, pf = NA;
          for (let i = 0; i < x.length; i++) {
            if (!ok(L[i])) continue;
            const r = H[i] - L[i];
            f = r > 0 ? ((x[i] - L[i]) / r) * 100 : f;
            pf = ok(pf) ? pf + p.factor * (f - pf) : f;
            out[i] = pf;
          }
          return out;
        };
        return { v: stage(stage(m)) };
      } },
    { id: 'smi', name: 'Stochastic Momentum Index', short: 'SMI', kind: 'pane', category: 'Oscillators', params: [tip(P.int('k', '%K Length', 10), 'Blau: close vs range midpoint, double-EMA smoothed'), P.int('d', '%D Length', 3), P.int('signal', 'EMA Length', 3)],
      outputs: [line('v', 'SMI', '#2962ff'), line('sig', 'Signal', '#ff6d00')], levels: [40, 0, -40], range: [-100, 100],
      calc: (c, p) => {
        const H = highest(c.map((x) => x.high), p.k), L = lowest(c.map((x) => x.low), p.k), ee = (a) => ema(ema(a, p.d), p.d);
        const rel = ee(c.map((x, i) => x.close - (H[i] + L[i]) / 2)), rng = ee(H.map((v, i) => v - L[i])), v = rel.map((x, i) => (rng[i] ? (200 * x) / rng[i] : ok(x) ? 0 : NA));
        return { v, sig: ema(v, p.signal) };
      } },
    { id: 'qstick', name: 'Qstick', short: 'Qstick', kind: 'pane', category: 'Oscillators', params: [P.len(8)], outputs: [hist('v', 'Qstick')], levels: [0],
      calc: (c, p) => { const v = sma(c.map((x) => x.close - x.open), p.length); return { v, colors: { v: updown(v) } }; } },
    { id: 'rmi', name: 'Relative Momentum Index', short: 'RMI', kind: 'pane', category: 'Oscillators', params: [P.len(14), tip(P.int('momentum', 'Momentum (lag)', 5), 'Altman: RSI of n-bar momentum instead of 1-bar change'), P.src()],
      outputs: [line('v', 'RMI', '#7e57c2')], levels: [70, 50, 30], range: [0, 100],
      calc: (c, p, ctx) => {
        const s = getSrc(c, ctx)(p.source), m = change(s, p.momentum), u = rma(m.map((v) => (ok(v) ? Math.max(v, 0) : NA)), p.length), d = rma(m.map((v) => (ok(v) ? Math.max(-v, 0) : NA)), p.length);
        return { v: u.map((x, i) => (!ok(x) || !ok(d[i]) ? NA : d[i] === 0 ? 100 : 100 - 100 / (1 + x / d[i]))) };
      } },
    { id: 'stochfast', name: 'Stochastic Fast', short: 'Stoch Fast', kind: 'pane', category: 'Oscillators', params: [P.int('k', '%K Length', 14), P.int('d', '%D Smoothing', 3)], outputs: [line('k', '%K', '#2962ff'), line('d', '%D', '#ff6d00')], levels: [80, 20], range: [0, 100],
      calc: (c, p) => { const h = highest(c.map((x) => x.high), p.k), l = lowest(c.map((x) => x.low), p.k), k = c.map((x, i) => (h[i] - l[i] ? (100 * (x.close - l[i])) / (h[i] - l[i]) : NA)); return { k, d: sma(k, p.d) }; } },
    { id: 'apo', name: 'Absolute Price Oscillator', short: 'APO', kind: 'pane', category: 'Oscillators', params: [P.int('fast', 'Fast Length', 10), P.int('slow', 'Slow Length', 21), P.sel('maType', 'MA Type', ['EMA', 'SMA']), P.src()], outputs: [hist('v', 'APO')], levels: [0],
      calc: (c, p, ctx) => { const s = getSrc(c, ctx)(p.source), v = sub(maBy(p.maType, s, p.fast), maBy(p.maType, s, p.slow)); return { v, colors: { v: updown(v) } }; } },
    { id: 'rocr', name: 'Rate of Change Ratio', short: 'ROCR', kind: 'pane', category: 'Oscillators', params: [P.len(10), P.src()], outputs: [line('v', 'ROCR', '#2962ff')], levels: [1],
      calc: (c, p, ctx) => { const s = getSrc(c, ctx)(p.source); return { v: s.map((v, i) => (i >= p.length && s[i - p.length] ? v / s[i - p.length] : NA)) }; } },
    { id: 'rsidiv', name: 'RSI Divergence', short: 'RSI Div', kind: 'pane', category: 'Oscillators', params: [P.len(14), P.src(), ...DIV_PARAMS], outputs: [line('v', 'RSI', '#7e57c2')], levels: [70, 50, 30], range: [0, 100],
      calc: (c, p, ctx) => { const v = rsi(getSrc(c, ctx)(p.source), p.length); return { v, graphics: divergences(c, v, p) }; } },
    { id: 'macddiv', name: 'MACD Divergence', short: 'MACD Div', kind: 'pane', category: 'Oscillators',
      params: [P.int('fast', 'Fast Length', 12), P.int('slow', 'Slow Length', 26), P.int('signal', 'Signal Length', 9), P.src(), P.sel('on', 'Divergence on', ['MACD', 'Histogram']), ...DIV_PARAMS],
      outputs: [hist('hist', 'Histogram'), line('macd', 'MACD', '#2962ff'), line('sig', 'Signal', '#ff6d00')], levels: [0],
      calc: (c, p, ctx) => { const s = getSrc(c, ctx)(p.source), m = sub(ema(s, p.fast), ema(s, p.slow)), sg = ema(m, p.signal), h = sub(m, sg); return { macd: m, sig: sg, hist: h, colors: { hist: updown(h) }, graphics: divergences(c, p.on === 'Histogram' ? h : m, p) }; } },
    { id: 'cybercycle', name: 'Ehlers Cyber Cycle', short: 'Cyber Cycle', kind: 'pane', category: 'Oscillators', params: [P.src('hl2'), P.num('alpha', 'Alpha', 0.07, 0.01, 0.01)], outputs: [line('v', 'Cycle', '#26c6da'), line('trig', 'Trigger', '#ef5350')], levels: [0],
      calc: (c, p, ctx) => onValid(getSrc(c, ctx)(p.source), (x) => {
        const a = p.alpha, sm = x.map((v, i) => (i >= 3 ? (v + 2 * x[i - 1] + 2 * x[i - 2] + x[i - 3]) / 6 : v)), cy = new Array(x.length).fill(0), trig = new Array(x.length).fill(NA);
        for (let i = 2; i < x.length; i++) cy[i] = i < 7 ? (x[i] - 2 * x[i - 1] + x[i - 2]) / 4 : (1 - 0.5 * a) ** 2 * (sm[i] - 2 * sm[i - 1] + sm[i - 2]) + 2 * (1 - a) * cy[i - 1] - (1 - a) ** 2 * cy[i - 2];
        for (let i = 1; i < x.length; i++) trig[i] = cy[i - 1];
        return { v: cy.map((v, i) => (i < 2 ? NA : v)), trig };
      }) },
    { id: 'roofing', name: 'Ehlers Roofing Filter', short: 'Roofing', kind: 'pane', category: 'Oscillators', params: [P.src(), P.int('hp', 'High-pass period', 48), P.int('ss', 'Super Smoother period', 10)], outputs: [line('v', 'Roofing', '#ff9800'), line('trig', 'Trigger', '#2962ff', { style: 2 })], levels: [0],
      calc: (c, p, ctx) => { const v = onValid(getSrc(c, ctx)(p.source), (x) => highPass2(x, p.hp)); const f = superSmoother(v, p.ss); return { v: f, trig: shift(f, 2) }; } },
    { id: 'ifrsi', name: 'Inverse Fisher Transform RSI', short: 'IFT RSI', kind: 'pane', category: 'Oscillators', params: [P.int('rsiLength', 'RSI Length', 5), P.int('wmaLength', 'WMA Length', 9), P.src()], outputs: [line('v', 'IFT', '#e91e63')], levels: [0.5, 0, -0.5], range: [-1, 1],
      calc: (c, p, ctx) => ({ v: wma(rsi(getSrc(c, ctx)(p.source), p.rsiLength).map((r) => 0.1 * (r - 50)), p.wmaLength).map((x) => Math.tanh(x)) }) },
    { id: 'imi', name: 'Intraday Momentum Index', short: 'IMI', kind: 'pane', category: 'Oscillators', params: [P.len(14)], outputs: [line('v', 'IMI', '#26a69a')], levels: [70, 50, 30], range: [0, 100],
      calc: (c, p) => { const g = rsum(c.map((x) => Math.max(x.close - x.open, 0)), p.length), l = rsum(c.map((x) => Math.max(x.open - x.close, 0)), p.length); return { v: g.map((v, i) => (v + l[i] ? (100 * v) / (v + l[i]) : ok(v) ? 50 : NA)) }; } },
    { id: 'cog', name: 'Center of Gravity (Ehlers)', short: 'COG', kind: 'pane', category: 'Oscillators', params: [P.len(10), P.src('hl2')], outputs: [line('v', 'COG', '#2962ff'), line('trig', 'Trigger', '#ef5350')],
      calc: (c, p, ctx) => {
        const s = getSrc(c, ctx)(p.source), n = p.length, v = nan(s.length);
        for (let i = n - 1; i < s.length; i++) {
          let num = 0, den = 0, good = true;
          for (let k = 0; k < n; k++) { const x = s[i - k]; if (!ok(x)) { good = false; break; } num += (k + 1) * x; den += x; }
          if (good && den) v[i] = -num / den + (n + 1) / 2;
        }
        return { v, trig: shift(v, 1) };
      } },
    { id: 'pmo', name: 'Price Momentum Oscillator (DecisionPoint)', short: 'PMO', kind: 'pane', category: 'Oscillators', params: [tip(P.int('len1', 'First smoothing', 35), 'Custom smoothing with alpha = 2/length (not 2/(length+1))'), P.int('len2', 'Second smoothing', 20), P.int('signal', 'Signal Length', 10), P.src()],
      outputs: [line('v', 'PMO', '#2962ff'), line('sig', 'Signal', '#ff6d00')], levels: [0],
      calc: (c, p, ctx) => { const r = roc(getSrc(c, ctx)(p.source), 1), v = smooth(smooth(r, p.len1, 2 / p.len1).map((x) => 10 * x), p.len2, 2 / p.len2); return { v, sig: ema(v, p.signal) }; } },
    { id: 'zscore', name: 'Z-Score', short: 'Z', kind: 'pane', category: 'Oscillators', params: [P.len(20), P.src()], outputs: [line('v', 'Z-Score', '#26c6da')], levels: [2, 0, -2],
      calc: (c, p, ctx) => { const s = getSrc(c, ctx)(p.source), m = sma(s, p.length), d = stdev(s, p.length); return { v: s.map((v, i) => (d[i] ? (v - m[i]) / d[i] : ok(d[i]) ? 0 : NA)) }; } },
    { id: 'pctrank', name: 'Percent Rank', short: '%Rank', kind: 'pane', category: 'Oscillators', params: [P.len(100), P.src()], outputs: [line('v', 'Percent Rank', '#ab47bc')], levels: [80, 50, 20], range: [0, 100],
      calc: (c, p, ctx) => ({ v: percentrank(getSrc(c, ctx)(p.source), p.length) }) },
    { id: 'sharpe', name: 'Rolling Sharpe Ratio', short: 'Sharpe', kind: 'pane', category: 'Oscillators', params: [P.len(100), P.src(), tip(P.int('periods', 'Periods per year (0 = 365 days / bar size)', 0, 0, 1000000), 'Mean / stdev of log returns × √periods; risk-free rate 0')],
      outputs: [line('v', 'Sharpe', '#26a69a')], levels: [0],
      calc: (c, p, ctx) => {
        const r = logRet(getSrc(c, ctx)(p.source)), m = sma(r, p.length), d = stdev(r, p.length), per = p.periods > 0 ? p.periods : (365 * DAY) / tfOf(c, ctx), k = Math.sqrt(per);
        return { v: m.map((x, i) => (d[i] ? (x / d[i]) * k : NA)) };
      } },
    { id: 'autocorr', name: 'Autocorrelation', short: 'AutoCorr', kind: 'pane', category: 'Oscillators', params: [P.len(50), P.int('lag', 'Lag', 1), P.bool('returns', 'Use returns (not price level)', true), P.src()],
      outputs: [line('v', 'r(lag)', '#ff9800')], levels: [0], range: [-1, 1],
      calc: (c, p, ctx) => {
        const s0 = getSrc(c, ctx)(p.source), s = p.returns ? logRet(s0) : s0, n = p.length, L = p.lag, v = nan(s.length);
        for (let i = n - 1 + L; i < s.length; i++) {
          let sx = 0, sy = 0, sxx = 0, syy = 0, sxy = 0, good = true;
          for (let k = 0; k < n; k++) { const x = s[i - k], y = s[i - k - L]; if (!ok(x) || !ok(y)) { good = false; break; } sx += x; sy += y; sxx += x * x; syy += y * y; sxy += x * y; }
          const den = Math.sqrt((n * sxx - sx * sx) * (n * syy - sy * sy));
          if (good) v[i] = den > 0 ? (n * sxy - sx * sy) / den : 0;
        }
        return { v };
      } },

    // ── Volume (tick volume) ─────────────────────────────
    { id: 'wad', name: 'Williams Accumulation/Distribution', short: 'WAD', kind: 'pane', category: 'Volume', params: [], outputs: [line('v', 'WAD', '#ffb300')],
      calc: (c) => ({ v: cum(c.map((x, i) => { if (!i) return 0; const pc = c[i - 1].close; return x.close > pc ? x.close - Math.min(x.low, pc) : x.close < pc ? x.close - Math.max(x.high, pc) : 0; })) }) },
    { id: 'pvi', name: 'Positive Volume Index (tick volume)', short: 'PVI', kind: 'pane', category: 'Volume', params: [P.int('signal', 'EMA Length', 255)], outputs: [line('v', 'PVI', '#26a69a'), line('sig', 'EMA', '#ff6d00')],
      calc: (c, p) => { let x = 1000; const v = c.map((b, i) => { if (i && (b.volume || 0) > (c[i - 1].volume || 0) && c[i - 1].close) x *= b.close / c[i - 1].close; return x; }); return { v, sig: ema(v, p.signal) }; } },
    { id: 'nvi', name: 'Negative Volume Index (tick volume)', short: 'NVI', kind: 'pane', category: 'Volume', params: [P.int('signal', 'EMA Length', 255)], outputs: [line('v', 'NVI', '#ef5350'), line('sig', 'EMA', '#ff6d00')],
      calc: (c, p) => { let x = 1000; const v = c.map((b, i) => { if (i && (b.volume || 0) < (c[i - 1].volume || 0) && c[i - 1].close) x *= b.close / c[i - 1].close; return x; }); return { v, sig: ema(v, p.signal) }; } },
    { id: 'vwmacd', name: 'Volume-Weighted MACD (tick volume)', short: 'VW-MACD', kind: 'pane', category: 'Volume', params: [P.int('fast', 'Fast Length', 12), P.int('slow', 'Slow Length', 26), P.int('signal', 'Signal Length', 9), P.src()],
      outputs: [hist('hist', 'Histogram'), line('macd', 'VW-MACD', '#2962ff'), line('sig', 'Signal', '#ff6d00')], levels: [0],
      calc: (c, p, ctx) => { const s = getSrc(c, ctx)(p.source), vol = c.map((x) => x.volume || 0), m = sub(vwmaF(s, vol, p.fast), vwmaF(s, vol, p.slow)), sg = ema(m, p.signal), h = sub(m, sg); return { macd: m, sig: sg, hist: h, colors: { hist: updown(h) } }; } },
    { id: 'vroc', name: 'Volume Rate of Change (tick volume)', short: 'VROC', kind: 'pane', category: 'Volume', params: [P.len(14)], outputs: [line('v', 'VROC', '#2962ff')], levels: [0],
      calc: (c, p) => ({ v: roc(c.map((x) => x.volume || 0), p.length) }) },
    { id: 'rvol', name: 'Relative Volume (tick volume)', short: 'RVOL', kind: 'pane', category: 'Volume', params: [P.len(20), P.num('threshold', 'Highlight above', 2, 0.1)], outputs: [hist('v', 'RVOL', '#787b86')], levels: [1],
      calc: (c, p) => { const vol = c.map((x) => x.volume || 0), m = sma(vol, p.length), v = vol.map((x, i) => (m[i] ? x / m[i] : NA)); return { v, colors: { v: v.map((x, i) => (x >= p.threshold ? (c[i].close >= c[i].open ? UP : DN) : '#787b86')) } }; } },
    { id: 'vzo', name: 'Volume Zone Oscillator (tick volume)', short: 'VZO', kind: 'pane', category: 'Volume', params: [P.len(14)], outputs: [line('v', 'VZO', '#26c6da')], levels: [60, 40, 0, -40, -60],
      calc: (c, p) => { const vp = ema(c.map((x, i) => (i ? Math.sign(x.close - c[i - 1].close) * (x.volume || 0) : NA)), p.length), tv = ema(c.map((x, i) => (i ? x.volume || 0 : NA)), p.length); return { v: vp.map((x, i) => (tv[i] ? (100 * x) / tv[i] : ok(x) ? 0 : NA)) }; } },

    // ── Support/resistance ───────────────────────────────
    { id: 'pivothl', name: 'Pivot Points High Low', short: 'Pivots HL', kind: 'overlay', category: 'Support/resistance', params: [P.int('left', 'Left bars', 10), P.int('right', 'Right bars', 10), P.bool('prices', 'Show prices', true)], outputs: [],
      calc: (c, p, ctx) => {
        const g = [], H = pivotIdx(c.map((x) => x.high), p.left, p.right, true), L = pivotIdx(c.map((x) => x.low), p.left, p.right, false);
        for (const i of H) g.push({ kind: 'label', t: c[i].time, p: c[i].high, text: p.prices ? fmtP(ctx, c, c[i].high) : 'H', color: DN, bg: 'transparent', align: 'center', base: 'bottom' });
        for (const i of L) g.push({ kind: 'label', t: c[i].time, p: c[i].low, text: p.prices ? fmtP(ctx, c, c[i].low) : 'L', color: UP, bg: 'transparent', align: 'center', base: 'top' });
        return { graphics: g };
      } },
    { id: 'srzones', name: 'Support & Resistance Zones (auto)', short: 'S/R Zones', kind: 'overlay', category: 'Support/resistance',
      params: [P.int('lookback', 'Lookback (bars)', 500, 20, 5000), P.int('depth', 'Pivot depth', 8), tip(P.num('width', 'Zone width (ATR multiples)', 0.5, 0.05), 'Swing pivots clustered when within this many ATR(14) of each other'), P.int('minTouches', 'Min touches', 2), P.int('maxZones', 'Max zones', 8, 1, 50)], outputs: [],
      calc: (c, p) => {
        const n = c.length;
        if (n < 2) return { graphics: [] };
        const i0 = Math.max(0, n - p.lookback), a = atr(c, 14), w = (ok(a[n - 1]) ? a[n - 1] : c[n - 1].high - c[n - 1].low) * p.width, last = c[n - 1].close;
        const pts = pivotIdx(c.map((x) => x.high), p.depth, p.depth, true).map((i) => ({ i, p: c[i].high })).concat(pivotIdx(c.map((x) => x.low), p.depth, p.depth, false).map((i) => ({ i, p: c[i].low }))).filter((q) => q.i >= i0).sort((x, y) => x.p - y.p);
        const zones = [];
        for (const q of pts) {
          const z = zones[zones.length - 1];
          if (z && q.p - z.lo <= w) { z.hi = q.p; z.n++; z.i0 = Math.min(z.i0, q.i); } else zones.push({ lo: q.p, hi: q.p, n: 1, i0: q.i });
        }
        const keep = zones.filter((z) => z.n >= p.minTouches).sort((x, y) => y.n - x.n || x.lo - y.lo).slice(0, p.maxZones);
        return { graphics: keep.map((z) => {
          const pad = Math.max(0, (w - (z.hi - z.lo)) / 2), res = (z.hi + z.lo) / 2 > last, col = res ? DN : UP;
          return { kind: 'box', t1: c[z.i0].time, p1: z.hi + pad, t2: lastT(c), p2: z.lo - pad, color: col, fill: res ? 'rgba(239,83,80,0.12)' : 'rgba(38,166,154,0.12)', text: `${res ? 'R' : 'S'} ×${z.n}`, textColor: col };
        }) };
      } },
    { id: 'sdzones', name: 'Supply & Demand Zones (heuristic)', short: 'S/D Zones', kind: 'overlay', category: 'Support/resistance',
      params: [tip(P.num('impulse', 'Impulse body (ATR multiples)', 1.5, 0.1), 'Base candle before a strong-bodied impulse candle; ends when price closes through it'), P.num('base', 'Max base body (ATR multiples)', 0.6, 0.05), P.int('maxZones', 'Max zones', 10, 1, 100), P.bool('showMitigated', 'Show mitigated zones', false)], outputs: [],
      calc: (c, p) => {
        const n = c.length, a = atr(c, 14), zones = [];
        for (let i = 15; i < n; i++) {
          const x = c[i], q = c[i - 1], A = a[i - 1];
          if (!ok(A) || !(Math.abs(x.close - x.open) >= p.impulse * A) || !(Math.abs(q.close - q.open) <= p.base * A)) continue;
          zones.push({ dem: x.close > x.open, i: i - 1, hi: q.high, lo: q.low, end: null });
        }
        for (const z of zones) for (let j = z.i + 2; j < n; j++) if (z.dem ? c[j].close < z.lo : c[j].close > z.hi) { z.end = j; break; }
        return { graphics: zones.filter((z) => p.showMitigated || z.end === null).slice(-p.maxZones).map((z) => ({
          kind: 'box', t1: c[z.i].time, p1: z.hi, t2: z.end === null ? lastT(c) : c[z.end].time, p2: z.lo, color: z.dem ? UP : DN, fill: z.dem ? 'rgba(38,166,154,0.15)' : 'rgba(239,83,80,0.15)', text: z.dem ? 'Demand' : 'Supply', textColor: z.dem ? UP : DN })) };
      } },
    { id: 'structure', name: 'Market Structure (BOS / CHoCH)', short: 'Structure', kind: 'overlay', category: 'Support/resistance', params: [tip(P.int('depth', 'Swing depth', 5), 'Swings confirmed after depth bars; BOS = break with trend, CHoCH = break against it'), P.int('maxEvents', 'Max events shown', 30, 1, 500)], outputs: [],
      calc: (c, p) => {
        const g = [];
        for (const e of structureEvents(c, p.depth).slice(-p.maxEvents)) {
          const col = e.dir === 1 ? UP : DN, t1 = c[e.pivot.i].time, t2 = c[e.i].time;
          g.push({ kind: 'line', t1, p1: e.pivot.p, t2, p2: e.pivot.p, color: col, width: 1, style: e.type === 'BOS' ? 1 : 0, extend: 'none' });
          g.push({ kind: 'label', t: Math.round((t1 + t2) / 2), p: e.pivot.p, text: e.type, color: col, bg: 'transparent', align: 'center', base: e.dir === 1 ? 'bottom' : 'top' });
        }
        return { graphics: g };
      } },
    { id: 'fvg', name: 'Fair Value Gaps', short: 'FVG', kind: 'overlay', category: 'Support/resistance', params: [P.num('minAtr', 'Min gap (ATR multiples)', 0, 0.05), P.int('maxGaps', 'Max gaps shown', 20, 1, 500), P.bool('showFilled', 'Show filled gaps', false)], outputs: [],
      calc: (c, p) => {
        const n = c.length, a = atr(c, 14), all = [];
        let active = [];
        for (let i = 2; i < n; i++) {
          const x = c[i];
          active = active.filter((g) => { if (g.bull ? x.low <= g.lo : x.high >= g.hi) { g.end = i; return false; } return true; });
          const min = ok(a[i]) ? p.minAtr * a[i] : 0;
          if (x.low > c[i - 2].high && x.low - c[i - 2].high >= min) { const g = { bull: true, i: i - 2, hi: x.low, lo: c[i - 2].high, end: null }; all.push(g); active.push(g); }
          else if (x.high < c[i - 2].low && c[i - 2].low - x.high >= min) { const g = { bull: false, i: i - 2, hi: c[i - 2].low, lo: x.high, end: null }; all.push(g); active.push(g); }
        }
        return { graphics: all.filter((g) => p.showFilled || g.end === null).slice(-p.maxGaps).map((g) => ({
          kind: 'box', t1: c[g.i].time, p1: g.hi, t2: g.end === null ? lastT(c) : c[g.end].time, p2: g.lo, color: g.bull ? 'rgba(38,166,154,0.7)' : 'rgba(239,83,80,0.7)', fill: g.bull ? 'rgba(38,166,154,0.18)' : 'rgba(239,83,80,0.18)', text: 'FVG', textColor: g.bull ? UP : DN })) };
      } },
    { id: 'ob', name: 'Order Blocks (heuristic)', short: 'Order Blocks', kind: 'overlay', category: 'Support/resistance', params: [tip(P.int('depth', 'Swing depth', 5), 'Last opposite candle before a structure break; ends when price closes through it'), P.int('maxBlocks', 'Max blocks', 10, 1, 100), P.bool('showMitigated', 'Show mitigated blocks', false)], outputs: [],
      calc: (c, p) => {
        const n = c.length, blocks = [];
        for (const e of structureEvents(c, p.depth)) {
          let k = -1;
          for (let j = e.i - 1; j >= e.pivot.i; j--) if (e.dir === 1 ? c[j].close < c[j].open : c[j].close > c[j].open) { k = j; break; }
          if (k < 0) continue;
          const b = { bull: e.dir === 1, i: k, hi: c[k].high, lo: c[k].low, end: null };
          for (let j = e.i + 1; j < n; j++) if (b.bull ? c[j].close < b.lo : c[j].close > b.hi) { b.end = j; break; }
          blocks.push(b);
        }
        return { graphics: blocks.filter((b) => p.showMitigated || b.end === null).slice(-p.maxBlocks).map((b) => ({
          kind: 'box', t1: c[b.i].time, p1: b.hi, t2: b.end === null ? lastT(c) : c[b.end].time, p2: b.lo, color: b.bull ? '#26a69a' : '#ef5350', fill: b.bull ? 'rgba(38,166,154,0.2)' : 'rgba(239,83,80,0.2)', text: b.bull ? 'Bull OB' : 'Bear OB', textColor: b.bull ? UP : DN })) };
      } },
    { id: 'sessions', name: 'Trading Sessions (Asia / London / New York)', short: 'Sessions', kind: 'overlay', category: 'Support/resistance',
      params: [P.bool('asia', 'Asia', true), tip(P.int('asiaStart', 'Asia start (UTC hour)', 0, 0, 23), 'All session hours are UTC; adjust for daylight saving as needed'), P.int('asiaEnd', 'Asia end (UTC hour)', 9, 0, 23),
        P.bool('london', 'London', true), P.int('londonStart', 'London start (UTC hour)', 8, 0, 23), P.int('londonEnd', 'London end (UTC hour)', 17, 0, 23),
        P.bool('ny', 'New York', true), P.int('nyStart', 'New York start (UTC hour)', 13, 0, 23), P.int('nyEnd', 'New York end (UTC hour)', 22, 0, 23), P.int('count', 'Days back', 10, 1, 200)], outputs: [],
      calc: (c, p) => {
        const g = [], S = [['asia', 'Asia', '#ab47bc', 'rgba(171,71,188,0.08)'], ['london', 'London', '#2962ff', 'rgba(41,98,255,0.08)'], ['ny', 'New York', '#ff9800', 'rgba(255,152,0,0.08)']];
        for (const [k, name, col, fill] of S) {
          if (!p[k]) continue;
          for (const s of sessionWindows(c, p[k + 'Start'], p[k + 'End']).slice(-p.count)) g.push({ kind: 'box', t1: s.s0, p1: s.h, t2: s.s1, p2: s.l, color: col, fill, text: name, textColor: col });
        }
        return { graphics: g };
      } },

    // ── Patterns ─────────────────────────────────────────
    { id: 'insideoutside', name: 'Inside / Outside Bars', short: 'In/Out Bars', kind: 'overlay', category: 'Patterns', params: [P.bool('inside', 'Inside bars', true), P.bool('outside', 'Outside bars', true)], outputs: [],
      calc: (c, p) => {
        const markers = [];
        for (let i = 1; i < c.length; i++) {
          const x = c[i], q = c[i - 1];
          if (p.inside && x.high < q.high && x.low > q.low) markers.push({ time: x.time, position: 'aboveBar', shape: 'circle', color: '#ff9800', text: 'IB' });
          else if (p.outside && x.high > q.high && x.low < q.low) markers.push({ time: x.time, position: 'aboveBar', shape: 'square', color: '#2962ff', text: 'OB' });
        }
        return { markers };
      } },
    { id: 'nr7', name: 'Narrow Range (NR4 / NR7)', short: 'NR', kind: 'overlay', category: 'Patterns', params: [P.int('length', 'Bars (4 = NR4, 7 = NR7)', 7, 2, 100)], outputs: [],
      calc: (c, p) => {
        const r = c.map((x) => x.high - x.low), m = lowest(r, p.length), markers = [];
        for (let i = p.length; i < c.length; i++) if (r[i] === m[i] && r[i] < r[i - 1]) markers.push({ time: c[i].time, position: 'belowBar', shape: 'circle', color: '#ffeb3b', text: 'NR' + p.length });
        return { markers };
      } },
    { id: 'seasonality', name: 'Day-of-Week Seasonality (UTC)', short: 'DoW Season', kind: 'pane', category: 'Patterns', params: [tip(P.bool('labels', 'Show weekday labels', true), 'Mean UTC-day % return per weekday from completed prior days only (causal)')], outputs: [hist('v', 'Avg return %')], levels: [0],
      calc: (c, p, ctx) => {
        const g = groups(c, (t) => Math.floor(t / DAY)), v = nan(c.length), sum = new Array(7).fill(0), cnt = new Array(7).fill(0);
        for (let k = 0; k < g.length; k++) {
          const d = g[k], wd = new Date(d.key * DAY * 1000).getUTCDay();
          for (let i = d.i0; i <= d.i1; i++) v[i] = cnt[wd] ? sum[wd] / cnt[wd] : NA;
          const prev = k ? g[k - 1].close : d.open;
          if (prev && ok(d.close)) { sum[wd] += (100 * (d.close - prev)) / prev; cnt[wd]++; }
        }
        const graphics = [];
        if (p.labels && c.length) {
          const tf = tfOf(c, ctx), t0 = lastT(c);
          let j = 0;
          for (let wd = 1; wd <= 7; wd++) {
            const w = wd % 7;
            if (!cnt[w]) continue;
            const m = sum[w] / cnt[w];
            graphics.push({ kind: 'label', t: t0 + (2 + 6 * j++) * tf, p: m, text: `${WEEKDAYS[w]} ${m >= 0 ? '+' : ''}${m.toFixed(3)}% (n=${cnt[w]})`, color: '#ffffff', bg: m >= 0 ? UP : DN, align: 'left', base: 'middle' });
          }
        }
        return { v, colors: { v: updown(v) }, graphics };
      } },
  ];

  const EXTRA = [
    // ── Moving averages ──────────────────────────────────
    MA('evwma', 'Elastic Volume Weighted Moving Average (tick volume)', 'EVWMA', '#ff8a65', 20, (s, p, c) => {
      const v = volOf(c), vs = rsum(v, p.length), out = nan(s.length);
      let prev = NA;
      for (let i = 0; i < s.length; i++) {
        if (!ok(vs[i]) || !ok(s[i])) continue;
        prev = !ok(prev) || vs[i] <= 0 ? (ok(prev) ? prev : s[i]) : ((vs[i] - v[i]) * prev) / vs[i] + (v[i] * s[i]) / vs[i];
        out[i] = prev;
      }
      return out;
    }),
    { id: 'swma', name: 'Symmetrically Weighted Moving Average', short: 'SWMA', kind: 'overlay', category: 'Moving averages', params: [tip(P.src(), 'TradingView ta.swma: fixed 4-bar weights 1/6, 2/6, 2/6, 1/6')], outputs: [line('v', 'SWMA', '#9575cd')],
      calc: (c, p, ctx) => ({ v: swma(getSrc(c, ctx)(p.source)) }) },
    MA('sinwma', 'Sine Weighted Moving Average', 'SinWMA', '#4db6ac', 21, (s, p) => {
      const n = p.length, w = Array.from({ length: n }, (_, k) => Math.sin((Math.PI * (k + 1)) / (n + 1))), tot = w.reduce((a, b) => a + b, 0);
      return rolling(s, n, (x) => x.reduce((a, v, k) => a + v * w[k], 0) / tot);
    }),
    MA('ehma', 'Exponential Hull Moving Average', 'EHMA', '#00acc1', 20, (s, p) => ema(sub(ema(s, Math.max(1, Math.floor(p.length / 2))).map((v) => 2 * v), ema(s, p.length)), Math.max(1, Math.round(Math.sqrt(p.length))))),
    MA('thma', 'Triple Hull Moving Average', 'THMA', '#0097a7', 20, (s, p) => {
      const n = p.length, a = wma(s, Math.max(1, Math.floor(n / 3))), b = wma(s, Math.max(1, Math.floor(n / 2))), d = wma(s, n);
      return wma(a.map((v, i) => 3 * v - b[i] - d[i]), n);
    }),
    MA('median', 'Moving Median', 'Median', '#ffd54f', 20, (s, p) => rolling(s, p.length, median)),
    MA('gma', 'Geometric Mean Moving Average', 'GMA', '#a1887f', 20, (s, p) => sma(s.map((v) => (v > 0 ? Math.log(v) : NA)), p.length).map(Math.exp)),
    { id: 'laguerre', name: 'Ehlers Laguerre Filter', short: 'Laguerre', kind: 'overlay', category: 'Moving averages', params: [P.src('hl2'), tip(P.num('gamma', 'Gamma (damping)', 0.8, 0.05), '0 = no smoothing, closer to 1 = smoother/slower')],
      outputs: [line('v', 'Laguerre', '#ffb74d', { width: 2 })],
      calc: (c, p, ctx) => { const g = Math.min(0.99, Math.max(0, p.gamma)), L = laguerre4(getSrc(c, ctx)(p.source), g); return { v: L.L0.map((v, i) => (v + 2 * L.L1[i] + 2 * L.L2[i] + L.L3[i]) / 6) }; } },
    MA('gauss', 'Ehlers Gaussian Filter', 'Gaussian', '#81c784', 14, (s, p) => gaussian(s, Math.max(2, p.length), p.poles), 'Moving averages', [P.int('poles', 'Poles (1-4)', 4, 1, 4)]),
    MA('butter', 'Ehlers Butterworth Filter (2-pole)', 'Butterworth', '#64b5f6', 20, (s, p) => butterworth2(s, Math.max(2, p.length))),

    // ── Trend ────────────────────────────────────────────
    { id: 'aroonosc', name: 'Aroon Oscillator', short: 'Aroon Osc', kind: 'pane', category: 'Trend', params: [P.len(14)], outputs: [hist('v', 'Aroon Osc')], levels: [50, 0, -50], range: [-100, 100],
      calc: (c, p) => { const a = aroonUD(c, p.length), v = sub(a.up, a.down); return { v, colors: { v: updown(v) } }; } },
    { id: 'adxr', name: 'Average Directional Movement Rating (ADXR)', short: 'ADXR', kind: 'pane', category: 'Trend', params: [P.int('diLength', 'DI Length', 14), P.int('adxSmoothing', 'ADX Smoothing', 14), tip(P.int('rating', 'Rating period', 14, 2), 'ADXR = (ADX + ADX[period-1]) / 2 (TA-Lib convention)')],
      outputs: [line('adxr', 'ADXR', '#ff6d00', { width: 2 }), line('adx', 'ADX', '#2962ff')], levels: [25],
      calc: (c, p) => { const { adx } = dmi(c, p.diLength, p.adxSmoothing), lag = p.rating - 1; return { adx, adxr: adx.map((v, i) => (i >= lag ? (v + adx[i - lag]) / 2 : NA)) }; } },
    { id: 'tsindex', name: 'Trend Strength Index', short: 'TSI(trend)', kind: 'pane', category: 'Trend', params: [tip(P.len(14), 'Pearson correlation of the source with bar index (TradingView built-in)'), P.src()], outputs: [line('v', 'Trend Strength', '#2962ff')], levels: [0.5, 0, -0.5], range: [-1, 1],
      calc: (c, p, ctx) => ({ v: corr(getSrc(c, ctx)(p.source), c.map((_, i) => i), Math.max(2, p.length)) }) },
    { id: 'ssl', name: 'SSL Channel', short: 'SSL', kind: 'overlay', category: 'Trend', params: [P.len(10)], outputs: [line('up', 'SSL Up', UP, { width: 2 }), line('down', 'SSL Down', DN, { width: 2 })],
      calc: (c, p) => {
        const sh = sma(c.map((x) => x.high), p.length), sl = sma(c.map((x) => x.low), p.length), up = nan(c.length), down = nan(c.length), markers = [];
        let hlv = 0;
        for (let i = 0; i < c.length; i++) {
          if (!ok(sh[i])) continue;
          const prev = hlv;
          hlv = c[i].close > sh[i] ? 1 : c[i].close < sl[i] ? -1 : hlv;
          down[i] = hlv < 0 ? sh[i] : sl[i]; up[i] = hlv < 0 ? sl[i] : sh[i];
          if (prev && hlv !== prev) markers.push(hlv > 0 ? mkUp(c[i].time, 'SSL') : mkDn(c[i].time, 'SSL'));
        }
        return { up, down, markers };
      } },
    { id: 'halftrend', name: 'HalfTrend', short: 'HalfTrend', kind: 'overlay', category: 'Trend', params: [tip(P.int('amplitude', 'Amplitude', 2), 'everget HalfTrend; arrows need 100 bars of ATR'), P.num('channelDeviation', 'Channel Deviation', 2), P.bool('arrows', 'Show arrows', true)],
      outputs: [line('v', 'HalfTrend', '#2962ff', { width: 2, colorDown: DN })],
      calc: (c, p) => {
        const n = c.length, A = p.amplitude, a2 = atr(c, 100).map((v) => v / 2), hp = highest(c.map((x) => x.high), A), lp = lowest(c.map((x) => x.low), A), hma_ = sma(c.map((x) => x.high), A), lma = sma(c.map((x) => x.low), A);
        const v = nan(n), col = new Array(n).fill('up'), markers = [];
        if (n < A) return { v, colors: { v: col }, markers };
        let trend = 0, next = 0, maxLow = c[Math.max(0, A - 2)].low, minHigh = c[Math.max(0, A - 2)].high, up = 0, down = 0, prevTrend = null;
        for (let i = A - 1; i < n; i++) {
          const x = c[i], pl = i ? c[i - 1].low : x.low, ph = i ? c[i - 1].high : x.high;
          if (next === 1) { maxLow = Math.max(lp[i], maxLow); if (hma_[i] < maxLow && x.close < pl) { trend = 1; next = 0; minHigh = hp[i]; } }
          else { minHigh = Math.min(hp[i], minHigh); if (lma[i] > minHigh && x.close > ph) { trend = 0; next = 1; maxLow = lp[i]; } }
          if (trend === 0) {
            if (prevTrend !== null && prevTrend !== 0) { up = down; if (p.arrows && ok(a2[i])) markers.push(mkUp(x.time, 'Buy')); }
            else up = Math.max(maxLow, up);
          } else if (prevTrend !== null && prevTrend !== 1) { down = up; if (p.arrows && ok(a2[i])) markers.push(mkDn(x.time, 'Sell')); }
          else down = Math.min(minHigh, down);
          prevTrend = trend;
          v[i] = trend === 0 ? up : down; col[i] = trend === 0 ? 'up' : 'down';
        }
        return { v, colors: { v: col }, markers };
      } },
    { id: 'gannhilo', name: 'Gann HiLo Activator', short: 'HiLo', kind: 'overlay', category: 'Trend', params: [P.len(3)], outputs: [line('v', 'HiLo', UP, { width: 2, colorDown: DN })],
      calc: (c, p) => {
        const sh = sma(c.map((x) => x.high), p.length), sl = sma(c.map((x) => x.low), p.length), v = nan(c.length), col = new Array(c.length).fill('up');
        let d = 0;
        for (let i = 1; i < c.length; i++) {
          if (!ok(sh[i - 1])) continue;
          d = c[i].close > sh[i - 1] ? 1 : c[i].close < sl[i - 1] ? -1 : d;
          if (!d) continue;
          v[i] = d < 0 ? sh[i] : sl[i]; col[i] = d < 0 ? 'down' : 'up';
        }
        return { v, colors: { v: col } };
      } },
    { id: 'pfe', name: 'Polarized Fractal Efficiency', short: 'PFE', kind: 'pane', category: 'Trend', params: [tip(P.len(10), 'Hannula PFE with % price changes so the price/time mix is scale-free'), P.int('smooth', 'EMA Smoothing', 5), P.src()],
      outputs: [line('v', 'PFE', '#26a69a')], levels: [50, 0, -50], range: [-100, 100],
      calc: (c, p, ctx) => {
        const s = getSrc(c, ctx)(p.source), n = p.length, step = s.map((v, i) => (i && s[i - 1] ? Math.sqrt((100 * (v / s[i - 1] - 1)) ** 2 + 1) : NA)), path = rsumP(step, n);
        return { v: ema(s.map((v, i) => { if (i < n || !ok(path[i]) || !s[i - n]) return NA; const r = 100 * (v / s[i - n] - 1), d = (Math.sqrt(r * r + n * n) / path[i]) * 100; return r > 0 ? d : -d; }), p.smooth) };
      } },
    { id: 'trendflex', name: 'Ehlers Trendflex', short: 'Trendflex', kind: 'pane', category: 'Trend', params: [P.len(20), P.src()], outputs: [line('v', 'Trendflex', '#ff9800')], levels: [0],
      calc: (c, p, ctx) => ({ v: onValid(getSrc(c, ctx)(p.source), (x) => {
        const n = p.length, f = superSmoother(x, Math.max(2, n / 2)), out = new Array(x.length).fill(NA);
        let ms = 0;
        for (let i = n; i < x.length; i++) { let s = 0; for (let k = 1; k <= n; k++) s += f[i] - f[i - k]; s /= n; ms = 0.04 * s * s + 0.96 * ms; out[i] = ms > 0 ? s / Math.sqrt(ms) : 0; }
        return out;
      }) }) },
    { id: 'reflex', name: 'Ehlers Reflex', short: 'Reflex', kind: 'pane', category: 'Trend', params: [P.len(20), P.src()], outputs: [line('v', 'Reflex', '#ab47bc')], levels: [0],
      calc: (c, p, ctx) => ({ v: onValid(getSrc(c, ctx)(p.source), (x) => {
        const n = p.length, f = superSmoother(x, Math.max(2, n / 2)), out = new Array(x.length).fill(NA);
        let ms = 0;
        for (let i = n; i < x.length; i++) { const sl = (f[i - n] - f[i]) / n; let s = 0; for (let k = 1; k <= n; k++) s += f[i] + k * sl - f[i - k]; s /= n; ms = 0.04 * s * s + 0.96 * ms; out[i] = ms > 0 ? s / Math.sqrt(ms) : 0; }
        return out;
      }) }) },
    { id: 'chopzone', name: 'Chop Zone', short: 'Chop Zone', kind: 'pane', category: 'Trend', params: [tip(P.int('periods', 'Range periods', 30), 'TradingView Chop Zone: colours the EMA(34) angle normalised by the 30-bar range')], outputs: [hist('v', 'Chop Zone', '#fdd835')],
      calc: (c, p) => {
        const e = ema(c.map((x) => x.close), 34), H = highest(c.map((x) => x.high), p.periods), L = lowest(c.map((x) => x.low), p.periods);
        const v = nan(c.length), col = new Array(c.length).fill('#fdd835');
        for (let i = 1; i < c.length; i++) {
          if (!ok(e[i - 1]) || !ok(H[i]) || !(H[i] > L[i])) continue;
          const avg = (c[i].high + c[i].low + c[i].close) / 3, span = (25 / (H[i] - L[i])) * L[i], y2 = ((e[i - 1] - e[i]) / avg) * span, hyp = Math.sqrt(1 + y2 * y2);
          const ang1 = Math.round((180 * Math.acos(1 / hyp)) / Math.PI), a = y2 > 0 ? -ang1 : ang1;
          v[i] = 1;
          col[i] = a >= 5 ? '#26c6da' : a >= 3.57 ? '#43a047' : a >= 2.14 ? '#a5d6a7' : a >= 0.71 ? '#009688' : a <= -5 ? '#d50000' : a <= -3.57 ? '#e91e63' : a <= -2.14 ? '#ff6d00' : a <= -0.71 ? '#ffb74d' : '#fdd835';
        }
        return { v, colors: { v: col } };
      } },
    { id: 'ichitk', name: 'Ichimoku TK Cross Signals', short: 'TK Cross', kind: 'overlay', category: 'Trend', params: [...ICHI_PARAMS],
      outputs: [line('conv', 'Tenkan-sen', '#2962ff'), line('base', 'Kijun-sen', '#b71c1c')],
      calc: (c, p) => {
        const { conv, base, spanA, spanB } = ichiLines(c, p), markers = [];
        for (let i = 1; i < c.length; i++) {
          const up = crossUp(conv, base, i), dn = crossDn(conv, base, i);
          if (!up && !dn) continue;
          const top = Math.max(spanA[i], spanB[i]), bot = Math.min(spanA[i], spanB[i]), k = base[i];
          const pos = !ok(top) ? '' : k > top ? (up ? 'strong' : 'weak') : k < bot ? (up ? 'weak' : 'strong') : 'neutral';
          markers.push(up ? mkUp(c[i].time, `TK ${pos}`.trim()) : mkDn(c[i].time, `TK ${pos}`.trim()));
        }
        return { conv, base, markers };
      } },
    { id: 'ichikumo', name: 'Ichimoku Kumo Breakout', short: 'Kumo', kind: 'overlay', category: 'Trend', params: [...ICHI_PARAMS],
      outputs: [line('spanA', 'Senkou Span A', '#a5d6a7'), line('spanB', 'Senkou Span B', '#ef9a9a')], fills: [{ a: 'spanA', b: 'spanB', color: 'rgba(120,123,134,0.12)' }],
      calc: (c, p) => {
        const { spanA, spanB } = ichiLines(c, p), markers = [];
        let side = 0;
        for (let i = 0; i < c.length; i++) {
          if (!ok(spanA[i]) || !ok(spanB[i])) continue;
          const top = Math.max(spanA[i], spanB[i]), bot = Math.min(spanA[i], spanB[i]), s = c[i].close > top ? 1 : c[i].close < bot ? -1 : 0;
          if (s && side && side !== s) { if (s > 0) markers.push(mkUp(c[i].time, 'Kumo ↑')); else markers.push(mkDn(c[i].time, 'Kumo ↓')); }
          if (s) side = s;
        }
        return { spanA, spanB, markers };
      } },

    // ── Oscillators ──────────────────────────────────────
    { id: 'wavetrend', name: 'WaveTrend Oscillator (LazyBear)', short: 'WT', kind: 'pane', category: 'Oscillators', params: [P.int('n1', 'Channel Length', 10), P.int('n2', 'Average Length', 21), P.src('hlc3')],
      outputs: [hist('diff', 'WT1-WT2', 'rgba(41,98,255,0.5)'), line('wt1', 'WT1', '#26a69a'), line('wt2', 'WT2', '#ef5350', { style: 2 })], levels: [60, 53, 0, -53, -60],
      calc: (c, p, ctx) => {
        const ap = getSrc(c, ctx)(p.source), esa = ema(ap, p.n1), d = ema(ap.map((v, i) => Math.abs(v - esa[i])), p.n1), ci = ap.map((v, i) => (d[i] ? (v - esa[i]) / (0.015 * d[i]) : ok(d[i]) ? 0 : NA));
        const wt1 = ema(ci, p.n2), wt2 = sma(wt1, 4), diff = sub(wt1, wt2), markers = [];
        for (let i = 1; i < c.length; i++) { if (crossUp(wt1, wt2, i) && wt1[i] < -53) markers.push(mkUp(c[i].time, 'WT')); else if (crossDn(wt1, wt2, i) && wt1[i] > 53) markers.push(mkDn(c[i].time, 'WT')); }
        return { wt1, wt2, diff, markers };
      } },
    { id: 'qqe', name: 'QQE (Quantitative Qualitative Estimation)', short: 'QQE', kind: 'pane', category: 'Oscillators', params: [P.int('rsiLength', 'RSI Length', 14), P.int('sf', 'RSI Smoothing', 5), P.num('qqe', 'Fast QQE Factor', 4.236, 0.001), P.src()],
      outputs: [line('rsiMa', 'RSI MA', '#2962ff', { width: 2 }), line('tl', 'Fast ATR RSI TL', '#ff9800')], levels: [70, 50, 30],
      calc: (c, p, ctx) => {
        const wp = p.rsiLength * 2 - 1, rm = ema(rsi(getSrc(c, ctx)(p.source), p.rsiLength), p.sf), ar = rm.map((v, i) => (i ? Math.abs(rm[i - 1] - v) : NA)), dar = ema(ema(ar, wp), wp).map((v) => v * p.qqe);
        const n = c.length, tl = nan(n), lbA = nan(n), sbA = nan(n), at = (a, i) => (i >= 0 ? a[i] : NA);
        const crossAny = (a1, b1, a0, b0) => ok(a1) && ok(b1) && ok(a0) && ok(b0) && ((a0 > b0 && a1 <= b1) || (a0 < b0 && a1 >= b1));
        let trend = 1;
        for (let i = 1; i < n; i++) {
          if (!ok(dar[i]) || !ok(rm[i]) || !ok(rm[i - 1])) continue;
          const r = rm[i], r1 = rm[i - 1], plb = lbA[i - 1], psb = sbA[i - 1];
          lbA[i] = ok(plb) && r1 > plb && r > plb ? Math.max(plb, r - dar[i]) : r - dar[i];
          sbA[i] = ok(psb) && r1 < psb && r < psb ? Math.min(psb, r + dar[i]) : r + dar[i];
          if (crossAny(r1, at(sbA, i - 2), r, psb)) trend = 1;
          else if (crossAny(at(lbA, i - 2), r1, plb, r)) trend = -1;
          tl[i] = trend === 1 ? lbA[i] : sbA[i];
        }
        return { rsiMa: rm, tl };
      } },
    { id: 'impulsemacd', name: 'Impulse MACD (LazyBear)', short: 'ImpMACD', kind: 'pane', category: 'Oscillators', params: [P.int('length', 'MA Length', 34), P.int('signal', 'Signal Length', 9)],
      outputs: [hist('md', 'ImpulseMACD', '#2962ff'), hist('sh', 'ImpulseHisto', '#2196f3'), line('sb', 'Signal', '#800000')], levels: [0],
      calc: (c, p) => {
        const src = hlc3Of(c), hi = rma(c.map((x) => x.high), p.length), lo = rma(c.map((x) => x.low), p.length), e1 = ema(src, p.length), e2 = ema(e1, p.length), mi = e1.map((v, i) => 2 * v - e2[i]);
        const md = mi.map((m, i) => (!ok(m) || !ok(hi[i]) ? NA : m > hi[i] ? m - hi[i] : m < lo[i] ? m - lo[i] : 0)), sb = sma(md, p.signal), sh = sub(md, sb);
        const col = src.map((s, i) => (s > mi[i] ? (s > hi[i] ? '#00e676' : '#008000') : s < lo[i] ? '#ff1744' : '#ff9800'));
        return { md, sb, sh, colors: { md: col } };
      } },
    { id: 'cfo', name: 'Chande Forecast Oscillator', short: 'CFO', kind: 'pane', category: 'Oscillators', params: [P.len(14), P.src()], outputs: [line('v', 'CFO', '#2962ff')], levels: [0],
      calc: (c, p, ctx) => { const s = getSrc(c, ctx)(p.source), f = linreg(s, Math.max(2, p.length), 0); return { v: s.map((v, i) => (v ? (100 * (v - f[i])) / v : NA)) }; } },
    { id: 'dymi', name: 'Dynamic Momentum Index (Chande)', short: 'DYMI', kind: 'pane', category: 'Oscillators', params: [tip(P.int('base', 'Base RSI period', 14), 'Period = base / (stdev5 / SMA10(stdev5)), clamped to [min,max]; RSI of simple sums (Cutler form)'), P.int('minLen', 'Min period', 5), P.int('maxLen', 'Max period', 30), P.src()],
      outputs: [line('v', 'DYMI', '#7e57c2')], levels: [70, 50, 30], range: [0, 100],
      calc: (c, p, ctx) => {
        const s = getSrc(c, ctx)(p.source), sd = stdev(s, 5), asd = sma(sd, 10), ch = change(s), lo = Math.min(p.minLen, p.maxLen), hi = Math.max(p.minLen, p.maxLen);
        return { v: s.map((_, i) => {
          if (!ok(sd[i]) || !ok(asd[i])) return NA;
          const td = Math.max(lo, Math.min(hi, asd[i] > 0 && sd[i] > 0 ? Math.round((p.base * asd[i]) / sd[i]) : hi));
          if (i < td) return NA;
          let u = 0, d = 0;
          for (let k = 0; k < td; k++) { const x = ch[i - k]; if (!ok(x)) return NA; if (x > 0) u += x; else d -= x; }
          return u + d ? (100 * u) / (u + d) : 50;
        }) };
      } },
    { id: 'derivosc', name: 'Derivative Oscillator', short: 'DerivOsc', kind: 'pane', category: 'Oscillators', params: [P.int('rsiLength', 'RSI Length', 14), P.int('ema1', 'EMA #1', 5), P.int('ema2', 'EMA #2', 3), P.int('signal', 'SMA Signal', 9), P.src()],
      outputs: [hist('v', 'Derivative Osc')], levels: [0],
      calc: (c, p, ctx) => { const s = ema(ema(rsi(getSrc(c, ctx)(p.source), p.rsiLength), p.ema1), p.ema2), v = sub(s, sma(s, p.signal)); return { v, colors: { v: updown(v) } }; } },
    { id: 'dss', name: 'Double Smoothed Stochastic (Bressert)', short: 'DSS', kind: 'pane', category: 'Oscillators', params: [P.int('length', 'Stochastic Length', 10), P.int('smooth', 'EMA Length', 9)],
      outputs: [line('v', 'DSS', '#2962ff', { width: 2 }), line('trig', 'Trigger (prev)', '#ff6d00', { style: 2 })], levels: [80, 50, 20], range: [0, 100],
      calc: (c, p) => {
        const n = p.length, H = highest(c.map((x) => x.high), n), L = lowest(c.map((x) => x.low), n), st = (v, h, l) => (ok(h) && h > l ? (100 * (v - l)) / (h - l) : ok(h) ? 50 : NA);
        const x1 = ema(c.map((x, i) => st(x.close, H[i], L[i])), p.smooth), h2 = highest(x1, n), l2 = lowest(x1, n), v = ema(x1.map((x, i) => st(x, h2[i], l2[i])), p.smooth);
        return { v, trig: shift(v, 1) };
      } },
    { id: 'laguerrersi', name: 'Laguerre RSI (Ehlers)', short: 'LagRSI', kind: 'pane', category: 'Oscillators', params: [P.num('gamma', 'Gamma', 0.5, 0.05), P.src()], outputs: [line('v', 'Laguerre RSI', '#e91e63', { width: 2 })], levels: [0.8, 0.5, 0.2], range: [0, 1],
      calc: (c, p, ctx) => {
        const L = laguerre4(getSrc(c, ctx)(p.source), Math.min(0.99, Math.max(0, p.gamma))), v = nan(c.length);
        let prev = 0.5;
        for (let i = 0; i < c.length; i++) {
          const a = [L.L0[i], L.L1[i], L.L2[i], L.L3[i]];
          if (!a.every(ok)) continue;
          let cu = 0, cd = 0;
          for (let k = 0; k < 3; k++) { const d = a[k] - a[k + 1]; if (d >= 0) cu += d; else cd -= d; }
          prev = cu + cd > 1e-12 * Math.abs(a[0]) ? cu / (cu + cd) : prev;
          v[i] = prev;
        }
        return { v };
      } },
    { id: 'kdj', name: 'KDJ', short: 'KDJ', kind: 'pane', category: 'Oscillators', params: [P.int('length', 'RSV Length', 9), P.int('m1', 'K Smoothing', 3), P.int('m2', 'D Smoothing', 3)],
      outputs: [line('k', 'K', '#2962ff'), line('d', 'D', '#ff6d00'), line('j', 'J', '#ab47bc')], levels: [80, 50, 20],
      calc: (c, p) => {
        const H = highest(c.map((x) => x.high), p.length), L = lowest(c.map((x) => x.low), p.length), n = c.length, k = nan(n), d = nan(n), j = nan(n);
        let K = 50, D = 50;
        for (let i = 0; i < n; i++) {
          if (!ok(H[i]) || !ok(c[i].close)) continue;
          if (H[i] > L[i]) { const rsv = (100 * (c[i].close - L[i])) / (H[i] - L[i]); K = ((p.m1 - 1) * K + rsv) / p.m1; D = ((p.m2 - 1) * D + K) / p.m2; }
          k[i] = K; d[i] = D; j[i] = 3 * K - 2 * D;
        }
        return { k, d, j };
      } },
    { id: 'ewo', name: 'Elliott Wave Oscillator', short: 'EWO', kind: 'pane', category: 'Oscillators', params: [P.int('fast', 'Fast SMA', 5), P.int('slow', 'Slow SMA', 35), P.bool('percent', 'Show as % of price', false), P.src('hl2')],
      outputs: [hist('v', 'EWO')], levels: [0],
      calc: (c, p, ctx) => { const s = getSrc(c, ctx)(p.source), v = sub(sma(s, p.fast), sma(s, p.slow)).map((x, i) => (p.percent ? (s[i] ? (100 * x) / s[i] : NA) : x)); return { v, colors: { v: updown(v) } }; } },
    { id: 'psy', name: 'Psychological Line', short: 'PSY', kind: 'pane', category: 'Oscillators', params: [P.len(12), P.src()], outputs: [line('v', 'PSY', '#ff9800')], levels: [75, 50, 25], range: [0, 100],
      calc: (c, p, ctx) => { const s = getSrc(c, ctx)(p.source); return { v: sma(s.map((v, i) => (i && ok(v) && ok(s[i - 1]) ? (v > s[i - 1] ? 100 : 0) : NA)), p.length) }; } },
    { id: 'demarker', name: 'DeMarker', short: 'DeM', kind: 'pane', category: 'Oscillators', params: [P.len(14)], outputs: [line('v', 'DeMarker', '#26a69a')], levels: [0.7, 0.5, 0.3], range: [0, 1],
      calc: (c, p) => {
        const mx = sma(c.map((x, i) => (i ? Math.max(x.high - c[i - 1].high, 0) : NA)), p.length), mn = sma(c.map((x, i) => (i ? Math.max(c[i - 1].low - x.low, 0) : NA)), p.length);
        return { v: mx.map((v, i) => (v + mn[i] > 0 ? v / (v + mn[i]) : ok(v) ? 0.5 : NA)) };
      } },
    { id: 'pgo', name: 'Pretty Good Oscillator', short: 'PGO', kind: 'pane', category: 'Oscillators', params: [P.len(14)], outputs: [line('v', 'PGO', '#2962ff')], levels: [3, 0, -3],
      calc: (c, p) => { const cl = c.map((x) => x.close), m = sma(cl, p.length), a = ema(tr(c), p.length); return { v: cl.map((v, i) => (a[i] ? (v - m[i]) / a[i] : ok(a[i]) ? 0 : NA)) }; } },
    { id: 'woodiescci', name: "Woodies CCI", short: 'Woodies CCI', kind: 'pane', category: 'Oscillators', params: [P.int('cciLength', 'CCI Length', 14), P.int('turboLength', 'Turbo CCI Length', 6), P.src('hlc3')],
      outputs: [hist('hist', 'CCI Histogram', '#26a69a'), line('cci', 'CCI', '#2962ff'), line('turbo', 'Turbo CCI', '#ff9800')], levels: [200, 100, 0, -100, -200],
      calc: (c, p, ctx) => {
        const s = getSrc(c, ctx)(p.source), cci = cciF(s, p.cciLength), turbo = cciF(s, p.turboLength);
        const col = cci.map((_, i) => { if (i < 5) return '#787b86'; const w = [1, 2, 3, 4, 5].map((k) => cci[i - k]); return w.every((v) => v > 0) ? 'up' : w.every((v) => v < 0) ? 'down' : '#787b86'; });
        return { hist: cci, cci, turbo, colors: { hist: col } };
      } },
    { id: 'disparity', name: 'Disparity Index', short: 'DI%', kind: 'pane', category: 'Oscillators', params: [P.len(14), P.ma('EMA'), P.src()], outputs: [line('v', 'Disparity %', '#2962ff')], levels: [0],
      calc: (c, p, ctx) => { const s = getSrc(c, ctx)(p.source), m = maBy(p.maType, s, p.length, volOf(c)); return { v: s.map((v, i) => (m[i] ? (100 * (v - m[i])) / m[i] : NA)) }; } },
    { id: 'inertia', name: 'Inertia Indicator', short: 'Inertia', kind: 'pane', category: 'Oscillators', params: [tip(P.int('length', 'Regression Length', 20), 'Dorsey: least-squares smoothing of the Relative Volatility Index'), P.int('rviLength', 'RVI StdDev Length', 10), P.int('rviSmooth', 'RVI Smoothing', 14), P.src()],
      outputs: [line('v', 'Inertia', '#ab47bc')], levels: [50],
      calc: (c, p, ctx) => ({ v: linreg(relVolIdx(getSrc(c, ctx)(p.source), p.rviLength, p.rviSmooth), Math.max(2, p.length), 0) }) },
    { id: 'swingidx', name: 'Swing Index', short: 'SI', kind: 'pane', category: 'Oscillators', params: [tip(P.num('limit', 'Limit move T (0 = unscaled)', 0, 0.0001), "Wilder's per-bar Swing Index (ASI is its running sum)")], outputs: [hist('v', 'SI')], levels: [0],
      calc: (c, p) => { const v = swingIndex(c, p.limit); return { v, colors: { v: updown(v) } }; } },
    { id: 'decyclerosc', name: 'Ehlers Decycler Oscillator', short: 'DecOsc', kind: 'pane', category: 'Oscillators', params: [P.int('fast', 'Fast HP Period', 30), P.num('kFast', 'Fast K', 1, 0.1), P.int('slow', 'Slow HP Period', 60), P.num('kSlow', 'Slow K', 1.2, 0.1), P.src()],
      outputs: [line('fast', 'Fast', '#26a69a'), line('slow', 'Slow', '#ef5350')], levels: [0],
      calc: (c, p, ctx) => {
        const s = getSrc(c, ctx)(p.source), osc = (P0, K) => onValid(s, (x) => { const hp = highPass2(x, Math.max(2, P0)), dec = x.map((v, i) => v - hp[i]), o = highPass2(dec, Math.max(2, 0.5 * P0)); return o.map((v, i) => (x[i] ? (100 * K * v) / x[i] : NA)); });
        return { fast: osc(p.fast, p.kFast), slow: osc(p.slow, p.kSlow) };
      } },
    { id: 'macdv', name: 'MACD-V (Volatility Normalised MACD)', short: 'MACD-V', kind: 'pane', category: 'Oscillators', params: [P.int('fast', 'Fast Length', 12), P.int('slow', 'Slow Length', 26), P.int('atrLength', 'ATR Length', 26), P.int('signal', 'Signal Length', 9)],
      outputs: [hist('hist', 'Histogram'), line('v', 'MACD-V', '#2962ff'), line('sig', 'Signal', '#ff6d00')], levels: [150, 50, 0, -50, -150],
      calc: (c, p) => { const cl = c.map((x) => x.close), a = atr(c, p.atrLength), v = sub(ema(cl, p.fast), ema(cl, p.slow)).map((x, i) => (a[i] ? (100 * x) / a[i] : NA)), sig = ema(v, p.signal), h = sub(v, sig); return { v, sig, hist: h, colors: { hist: updown(h) } }; } },
    { id: 'pzo', name: 'Price Zone Oscillator', short: 'PZO', kind: 'pane', category: 'Oscillators', params: [P.len(14)], outputs: [line('v', 'PZO', '#ff9800')], levels: [60, 40, 0, -40, -60], range: [-100, 100],
      calc: (c, p) => { const cl = c.map((x) => x.close), r = ema(cl.map((v, i) => (i ? Math.sign(v - cl[i - 1]) * v : NA)), p.length), e = ema(cl.map((v, i) => (i ? v : NA)), p.length); return { v: r.map((v, i) => (e[i] ? (100 * v) / e[i] : NA)) }; } },
    { id: 'sinewave', name: 'Ehlers Even Better Sinewave', short: 'EBSW', kind: 'pane', category: 'Oscillators', params: [P.int('duration', 'High-pass Duration', 40, 2), P.int('ssf', 'Super Smoother Length', 10, 2), P.src()],
      outputs: [line('v', 'Sinewave', '#2962ff', { width: 2 })], levels: [0.85, 0, -0.85], range: [-1, 1],
      calc: (c, p, ctx) => ({ v: onValid(getSrc(c, ctx)(p.source), (x) => {
        const w = (2 * Math.PI) / p.duration, a1 = (1 - Math.sin(w)) / Math.cos(w), hp = new Array(x.length).fill(0);
        for (let i = 1; i < x.length; i++) hp[i] = 0.5 * (1 + a1) * (x[i] - x[i - 1]) + a1 * hp[i - 1];
        const f = superSmoother(hp, p.ssf), out = new Array(x.length).fill(NA);
        for (let i = 2; i < x.length; i++) { const wave = (f[i] + f[i - 1] + f[i - 2]) / 3, pwr = (f[i] ** 2 + f[i - 1] ** 2 + f[i - 2] ** 2) / 3; out[i] = pwr > 0 ? Math.max(-1, Math.min(1, wave / Math.sqrt(pwr))) : 0; }
        return out;
      }) }) },

    // ── Volatility ───────────────────────────────────────
    { id: 'parkinson', name: 'Parkinson Volatility', short: 'Parkinson', kind: 'pane', category: 'Volatility', params: [P.len(20), PERIODS_PARAM()], outputs: [line('v', 'Parkinson σ %', '#2962ff')],
      calc: (c, p, ctx) => { const k = 100 * Math.sqrt(perYear(c, ctx, p.periods)); return { v: sma(c.map((x) => (x.high > 0 && x.low > 0 ? Math.log(x.high / x.low) ** 2 : NA)), p.length).map((v) => Math.sqrt(v / (4 * Math.LN2)) * k) }; } },
    { id: 'garmanklass', name: 'Garman-Klass Volatility', short: 'GK Vol', kind: 'pane', category: 'Volatility', params: [P.len(20), PERIODS_PARAM()], outputs: [line('v', 'GK σ %', '#26a69a')],
      calc: (c, p, ctx) => { const k = 100 * Math.sqrt(perYear(c, ctx, p.periods)); return { v: sma(c.map((x) => (x.high > 0 && x.low > 0 && x.open > 0 && x.close > 0 ? 0.5 * Math.log(x.high / x.low) ** 2 - (2 * Math.LN2 - 1) * Math.log(x.close / x.open) ** 2 : NA)), p.length).map((v) => Math.sqrt(Math.max(0, v)) * k) }; } },
    { id: 'rogerssatchell', name: 'Rogers-Satchell Volatility', short: 'RS Vol', kind: 'pane', category: 'Volatility', params: [P.len(20), PERIODS_PARAM()], outputs: [line('v', 'RS σ %', '#ff9800')],
      calc: (c, p, ctx) => { const k = 100 * Math.sqrt(perYear(c, ctx, p.periods)); return { v: sma(c.map((x) => (x.high > 0 && x.low > 0 && x.open > 0 && x.close > 0 ? Math.log(x.high / x.close) * Math.log(x.high / x.open) + Math.log(x.low / x.close) * Math.log(x.low / x.open) : NA)), p.length).map((v) => Math.sqrt(Math.max(0, v)) * k) }; } },
    { id: 'yangzhang', name: 'Yang-Zhang Volatility', short: 'YZ Vol', kind: 'pane', category: 'Volatility', params: [P.len(20, 'Length (≥ 2)'), PERIODS_PARAM()], outputs: [line('v', 'YZ σ %', '#ab47bc')],
      calc: (c, p, ctx) => {
        const n = Math.max(2, p.length), k = 0.34 / (1.34 + (n + 1) / (n - 1)), ann = 100 * Math.sqrt(perYear(c, ctx, p.periods));
        const lo = c.map((x, i) => (i && x.open > 0 && c[i - 1].close > 0 ? Math.log(x.open / c[i - 1].close) : NA)), lc = c.map((x) => (x.open > 0 && x.close > 0 ? Math.log(x.close / x.open) : NA));
        const rs = sma(c.map((x) => (x.high > 0 && x.low > 0 && x.open > 0 && x.close > 0 ? Math.log(x.high / x.close) * Math.log(x.high / x.open) + Math.log(x.low / x.close) * Math.log(x.low / x.open) : NA)), n);
        const svar = (a) => stdev(a, n).map((s) => (s * s * n) / (n - 1)), vo = svar(lo), vc = svar(lc);
        return { v: vo.map((v, i) => Math.sqrt(Math.max(0, v + k * vc[i] + (1 - k) * rs[i])) * ann) };
      } },
    { id: 'gapo', name: 'Gopalakrishnan Range Index', short: 'GAPO', kind: 'pane', category: 'Volatility', params: [P.len(5)], outputs: [line('v', 'GAPO', '#ef5350')],
      calc: (c, p) => { const n = Math.max(2, p.length), H = highest(c.map((x) => x.high), n), L = lowest(c.map((x) => x.low), n); return { v: H.map((h, i) => (h > L[i] ? Math.log(h - L[i]) / Math.log(n) : NA)) }; } },
    { id: 'thermo', name: 'Elder Market Thermometer', short: 'Thermo', kind: 'pane', category: 'Volatility', params: [P.int('length', 'EMA Length', 22), P.num('mult', 'Explosive multiple', 3, 0.5)],
      outputs: [hist('v', 'Temperature', '#26a69a'), line('ema', 'EMA', '#ff9800')],
      calc: (c, p) => {
        const v = c.map((x, i) => (!i ? NA : x.high < c[i - 1].high && x.low > c[i - 1].low ? 0 : Math.max(x.high - c[i - 1].high, c[i - 1].low - x.low, 0))), e = ema(v, p.length);
        return { v, ema: e, colors: { v: v.map((x, i) => (ok(e[i]) && x > p.mult * e[i] ? '#ff1744' : ok(e[i]) && x > e[i] ? '#ff9800' : '#26a69a')) } };
      } },
    { id: 'volratio', name: 'Volatility Ratio', short: 'VR', kind: 'pane', category: 'Volatility', params: [tip(P.len(14), 'True range ÷ Wilder ATR(length) of the previous bar')], outputs: [hist('v', 'VR', '#ff9800')], levels: [2, 1],
      calc: (c, p) => { const t = tr(c), a = atr(c, p.length); return { v: t.map((x, i) => (i && a[i - 1] ? x / a[i - 1] : NA)) }; } },

    // ── Statistics ───────────────────────────────────────
    { id: 'corr', name: 'Correlation Coefficient', short: 'Corr', kind: 'pane', category: 'Statistics',
      params: [P.len(20), P.src('close', 'source', 'Source A'), tip(P.src('volume', 'source2', 'Source B'), 'Any price field or another indicator output on this chart'), P.int('lag', 'Lag of B (bars)', 0, 0), P.bool('returns', 'Correlate changes (not levels)', false)],
      outputs: [line('v', 'Correlation', '#2962ff')], levels: [0.5, 0, -0.5], range: [-1, 1],
      calc: (c, p, ctx) => { const S = getSrc(c, ctx), d = (a) => (p.returns ? change(a) : a), a = d(S(p.source)), b = shift(d(S(p.source2)), p.lag); return { v: corr(a, b, Math.max(2, p.length)) }; } },
    { id: 'rsq', name: 'R-Squared (coefficient of determination)', short: 'R²', kind: 'pane', category: 'Statistics', params: [P.len(20), P.src()], outputs: [line('v', 'R²', '#26a69a')], levels: [0.7, 0.3], range: [0, 1],
      calc: (c, p, ctx) => ({ v: lrStats(getSrc(c, ctx)(p.source), Math.max(3, p.length)).r2 }) },
    { id: 'stderr', name: 'Standard Error (regression)', short: 'StdErr', kind: 'pane', category: 'Statistics', params: [P.len(20), P.src()], outputs: [line('v', 'Std Error', '#ef5350')],
      calc: (c, p, ctx) => ({ v: lrStats(getSrc(c, ctx)(p.source), Math.max(3, p.length)).se }) },
    { id: 'tsf', name: 'Time Series Forecast', short: 'TSF', kind: 'overlay', category: 'Statistics', params: [P.len(14), P.src(), tip(P.int('ahead', 'Bars ahead', 1, 0, 100), 'Least-squares line extrapolated this many bars beyond the current bar')], outputs: [line('v', 'TSF', '#ff4081')],
      calc: (c, p, ctx) => ({ v: linreg(getSrc(c, ctx)(p.source), Math.max(2, p.length), -p.ahead) }) },
    { id: 'variance', name: 'Variance', short: 'Var', kind: 'pane', category: 'Statistics', params: [P.len(20), P.src(), P.bool('sample', 'Sample (n-1) instead of population', false)], outputs: [line('v', 'Variance', '#2962ff')],
      calc: (c, p, ctx) => { const n = p.length; return { v: stdev(getSrc(c, ctx)(p.source), n).map((s) => (p.sample && n > 1 ? (s * s * n) / (n - 1) : s * s)) }; } },
    { id: 'cv', name: 'Coefficient of Variation', short: 'CV%', kind: 'pane', category: 'Statistics', params: [P.len(20), P.src()], outputs: [line('v', 'CV %', '#ab47bc')],
      calc: (c, p, ctx) => { const s = getSrc(c, ctx)(p.source), m = sma(s, p.length), d = stdev(s, p.length); return { v: d.map((x, i) => (m[i] ? (100 * x) / Math.abs(m[i]) : NA)) }; } },
    { id: 'mad', name: 'Mean Absolute Deviation', short: 'MAD', kind: 'pane', category: 'Statistics', params: [P.len(20), P.src()], outputs: [line('v', 'MAD', '#ff9800')],
      calc: (c, p, ctx) => ({ v: rolling(getSrc(c, ctx)(p.source), p.length, (w) => { const m = w.reduce((a, b) => a + b, 0) / w.length; return w.reduce((a, b) => a + Math.abs(b - m), 0) / w.length; }) }) },
    { id: 'percentile', name: 'Rolling Percentile', short: 'Pctl', kind: 'overlay', category: 'Statistics', params: [P.len(50), P.src(), tip(P.num('pct', 'Percentile', 50, 1, 0), 'Linear interpolation (TradingView ta.percentile_linear_interpolation)'), P.bool('band', 'Also plot 100-p band', true)],
      outputs: [line('v', 'Percentile', '#ffca28'), line('w', 'Mirror', '#ffca28', { style: 2 })],
      calc: (c, p, ctx) => { const s = getSrc(c, ctx)(p.source), q = Math.max(0, Math.min(100, p.pct)); return { v: rolling(s, p.length, (w) => pctLinear(w, q)), w: p.band ? rolling(s, p.length, (w) => pctLinear(w, 100 - q)) : nan(c.length) }; } },
    { id: 'drawdown', name: 'Drawdown', short: 'DD%', kind: 'pane', category: 'Statistics', params: [tip(P.int('lookback', 'Peak lookback (0 = all loaded bars)', 0, 0, 100000), 'Percent below the running peak; max line = deepest drawdown so far')], outputs: [hist('v', 'Drawdown %', DN), line('max', 'Max Drawdown %', '#787b86')], levels: [0],
      calc: (c, p) => {
        const cl = c.map((x) => x.close), pk = p.lookback > 0 ? highest(c.map((x) => x.high), p.lookback) : (() => { let m = -Infinity; return c.map((x) => (ok(x.high) ? (m = Math.max(m, x.high)) : ok(m) && m > -Infinity ? m : NA)); })();
        let worst = 0;
        const v = cl.map((x, i) => (pk[i] > 0 && ok(x) ? Math.min(0, (100 * (x - pk[i])) / pk[i]) : NA)), max = v.map((x) => (ok(x) ? (worst = Math.min(worst, x)) : NA));
        return { v, max };
      } },
    { id: 'sortino', name: 'Rolling Sortino Ratio', short: 'Sortino', kind: 'pane', category: 'Statistics', params: [P.len(100), P.src(), PERIODS_PARAM()], outputs: [line('v', 'Sortino', '#26a69a')], levels: [0],
      calc: (c, p, ctx) => {
        const r = logRet(getSrc(c, ctx)(p.source)), m = sma(r, p.length), dd = sma(r.map((x) => (ok(x) ? Math.min(0, x) ** 2 : NA)), p.length), k = Math.sqrt(perYear(c, ctx, p.periods));
        return { v: m.map((x, i) => (dd[i] > 0 ? (x / Math.sqrt(dd[i])) * k : NA)) };
      } },
    { id: 'hurst', name: 'Hurst Exponent (rolling R/S)', short: 'Hurst', kind: 'pane', category: 'Statistics', params: [tip(P.int('length', 'Window (≥ 32)', 100, 32, 5000), 'Rescaled-range slope over sub-windows n, n/2, n/4, n/8 of log returns; 0.5 ≈ random walk'), P.src()],
      outputs: [line('v', 'Hurst', '#ff9800')], levels: [0.5], range: [0, 1],
      calc: (c, p, ctx) => {
        const n = Math.max(32, p.length), sizes = [n, n >> 1, n >> 2, n >> 3];
        const rs = (w, a, b) => { let m = 0; for (let k = a; k < b; k++) m += w[k]; m /= b - a; let cumd = 0, hi = 0, lo = 0, ss = 0; for (let k = a; k < b; k++) { const d = w[k] - m; cumd += d; hi = Math.max(hi, cumd); lo = Math.min(lo, cumd); ss += d * d; } const sd = Math.sqrt(ss / (b - a)); return sd > 0 ? (hi - lo) / sd : NA; };
        return { v: rolling(logRet(getSrc(c, ctx)(p.source)), n, (w) => {
          const xs = [], ys = [];
          for (const s of sizes) { let acc = 0, cnt = 0; for (let a = 0; a + s <= n; a += s) { const r = rs(w, a, a + s); if (ok(r) && r > 0) { acc += r; cnt++; } } if (cnt) { xs.push(Math.log(s)); ys.push(Math.log(acc / cnt)); } }
          if (xs.length < 2) return NA;
          const mx = xs.reduce((a, b) => a + b, 0) / xs.length, my = ys.reduce((a, b) => a + b, 0) / ys.length;
          let sxy = 0, sxx = 0;
          xs.forEach((x, k) => { sxy += (x - mx) * (ys[k] - my); sxx += (x - mx) ** 2; });
          return sxx ? sxy / sxx : NA;
        }) };
      } },

    // ── Volume (tick volume) ─────────────────────────────
    { id: 'vwapbands', name: 'VWAP with Std-Dev Bands (tick volume)', short: 'VWAP±σ', kind: 'overlay', category: 'Volume',
      params: [P.src('hlc3'), P.sel('reset', 'Session reset', ['Local day', 'UTC day', 'Week'], 'Local day'), P.num('m1', 'Band #1 multiplier', 1, 0.1), P.num('m2', 'Band #2 multiplier', 2, 0.1), P.num('m3', 'Band #3 multiplier (0 = off)', 3, 0.1)],
      outputs: [line('v', 'VWAP', '#2196f3', { width: 2 }), line('u1', 'Upper #1', '#4caf50'), line('l1', 'Lower #1', '#4caf50'), line('u2', 'Upper #2', '#808000'), line('l2', 'Lower #2', '#808000'), line('u3', 'Upper #3', '#00897b'), line('l3', 'Lower #3', '#00897b')],
      fills: [{ a: 'u1', b: 'l1', color: 'rgba(76,175,80,0.06)' }],
      calc: (c, p, ctx) => {
        const s = getSrc(c, ctx)(p.source), key = sessionKey(p.reset), n = c.length, o = { v: nan(n), u1: nan(n), l1: nan(n), u2: nan(n), l2: nan(n), u3: nan(n), l3: nan(n) };
        let k0 = null, pv = 0, vv = 0, pv2 = 0;
        for (let i = 0; i < n; i++) {
          const k = key(c[i].time);
          if (k !== k0) { k0 = k; pv = vv = pv2 = 0; }
          if (!ok(s[i])) continue;
          const v = c[i].volume || 1;
          pv += s[i] * v; vv += v; pv2 += s[i] * s[i] * v;
          const m = pv / vv, sd = Math.sqrt(Math.max(0, pv2 / vv - m * m));
          o.v[i] = m;
          [[p.m1, 'u1', 'l1'], [p.m2, 'u2', 'l2'], [p.m3, 'u3', 'l3']].forEach(([mult, u, l]) => { if (mult > 0) { o[u][i] = m + mult * sd; o[l][i] = m - mult * sd; } });
        }
        return o;
      } },
    { id: 'rvwap', name: 'Rolling VWAP (time window, tick volume)', short: 'RVWAP', kind: 'overlay', category: 'Volume', params: [P.src('hlc3'), tip(P.num('hours', 'Window (hours)', 24, 0.25, 0.01), 'Bars whose time is within the trailing window are included'), P.num('mult', 'Band StdDev (0 = off)', 0, 0.1)],
      outputs: [line('v', 'Rolling VWAP', '#00bcd4', { width: 2 }), line('upper', 'Upper', '#00bcd4', { style: 2 }), line('lower', 'Lower', '#00bcd4', { style: 2 })],
      calc: (c, p, ctx) => {
        const s = getSrc(c, ctx)(p.source), n = c.length, win = p.hours * 3600, v = nan(n), upper = nan(n), lower = nan(n);
        let j = 0, pv = 0, vv = 0, pv2 = 0;
        const w = (i) => (ok(s[i]) ? c[i].volume || 1 : 0), val = (i) => (ok(s[i]) ? s[i] : 0);
        for (let i = 0; i < n; i++) {
          pv += val(i) * w(i); vv += w(i); pv2 += val(i) * val(i) * w(i);
          while (j < i && c[j].time <= c[i].time - win) { pv -= val(j) * w(j); vv -= w(j); pv2 -= val(j) * val(j) * w(j); j++; }
          if (!(vv > 0) || !ok(s[i])) continue;
          const m = pv / vv;
          v[i] = m;
          if (p.mult > 0) { const sd = Math.sqrt(Math.max(0, pv2 / vv - m * m)); upper[i] = m + p.mult * sd; lower[i] = m - p.mult * sd; }
        }
        return { v, upper, lower };
      } },
    { id: 'updownvol', name: 'Up/Down Volume (estimated, tick volume)', short: 'Up/Down Vol', kind: 'pane', category: 'Volume', params: [tip(P.bool('vsPrev', 'Direction vs previous close (else vs open)', false), 'IG has no trade-side data: each bar\'s tick volume is assigned to the candle direction')],
      outputs: [hist('up', 'Up Volume', UP), hist('down', 'Down Volume', DN), line('delta', 'Delta', '#2962ff')], levels: [0],
      calc: (c, p) => {
        const d = c.map((x, i) => Math.sign(x.close - (p.vsPrev ? (i ? c[i - 1].close : x.open) : x.open))), up = c.map((x, i) => (d[i] > 0 ? x.volume || 0 : 0)), down = c.map((x, i) => (d[i] < 0 ? -(x.volume || 0) : 0));
        return { up, down, delta: up.map((u, i) => u + down[i]), colors: { up: up.map(() => 'up'), down: down.map(() => 'down') } };
      } },
    { id: 'cvd', name: 'Cumulative Volume Delta (estimated, tick volume)', short: 'CVD~', kind: 'pane', category: 'Volume',
      params: [tip(P.sel('method', 'Delta estimate', ['Candle direction', 'Close location in range']), 'Approximation from OHLC + tick volume; true CVD needs trade-side data IG does not provide'), P.sel('reset', 'Reset', ['None', 'Local day', 'UTC day', 'Week'], 'Local day')],
      outputs: [line('v', 'CVD', '#26a69a', { width: 2, colorDown: DN })], levels: [0],
      calc: (c, p) => {
        const key = sessionKey(p.reset);
        let k0 = null, acc = 0;
        const v = c.map((x) => {
          const k = key(x.time);
          if (k !== k0) { k0 = k; acc = 0; }
          const vol = x.volume || 0, r = x.high - x.low;
          const d = p.method === 'Candle direction' ? Math.sign(x.close - x.open) * vol : r > 0 ? (vol * (2 * x.close - x.high - x.low)) / r : 0;
          if (ok(d)) acc += d;
          return acc;
        });
        return { v, colors: { v: v.map((x) => (x >= 0 ? 'up' : 'down')) } };
      } },
    { id: 'tvi', name: 'Trade Volume Index (tick volume)', short: 'TVI', kind: 'pane', category: 'Volume', params: [tip(P.num('mtv', 'Minimum tick value (0 = 1 price tick)', 0, 0.00001), 'Direction persists while the close-to-close change is within ±MTV')],
      outputs: [line('v', 'TVI', '#2962ff')],
      calc: (c, p, ctx) => {
        const mtv = p.mtv > 0 ? p.mtv : ctx && Number.isInteger(ctx.decimals) ? 10 ** -ctx.decimals : 0;
        let dir = 1, acc = 0;
        return { v: c.map((x, i) => { if (!i) return 0; const ch = x.close - c[i - 1].close; if (ch > mtv) dir = 1; else if (ch < -mtv) dir = -1; if (ok(ch)) acc += dir * (x.volume || 0); return acc; }) };
      } },
    { id: 'twiggs', name: 'Twiggs Money Flow (tick volume)', short: 'TMF', kind: 'pane', category: 'Volume', params: [P.len(21)], outputs: [line('v', 'TMF', '#26a69a', { colorDown: DN })], levels: [0], range: [-1, 1],
      calc: (c, p) => {
        const ad = c.map((x, i) => { if (!i) return NA; const th = Math.max(x.high, c[i - 1].close), tl = Math.min(x.low, c[i - 1].close), r = th - tl; return r > 0 ? ((x.volume || 0) * (2 * x.close - th - tl)) / r : 0; });
        const a = rma(ad, p.length), vv = rma(c.map((x, i) => (i ? x.volume || 0 : NA)), p.length), v = a.map((x, i) => (vv[i] > 0 ? x / vv[i] : NA));
        return { v, colors: { v: updown(v) } };
      } },
    { id: 'vfi', name: 'Volume Flow Indicator (tick volume)', short: 'VFI', kind: 'pane', category: 'Volume',
      params: [tip(P.int('length', 'VFI Length', 130), 'Katsanos VFI as published by LazyBear'), P.num('coef', 'Coef', 0.2, 0.05), P.num('vcoef', 'Max Volume Cutoff', 2.5, 0.1), P.int('signal', 'Signal Length', 5), P.bool('smooth', 'Smooth VFI (SMA 3)', false)],
      outputs: [hist('d', 'Histogram', '#90a4ae'), line('v', 'VFI', '#2962ff', { width: 2 }), line('sig', 'Signal', '#ff9800')], levels: [0],
      calc: (c, p) => {
        const typ = hlc3Of(c), inter = typ.map((v, i) => (i && v > 0 && typ[i - 1] > 0 ? Math.log(v) - Math.log(typ[i - 1]) : NA)), vint = stdev(inter, 30), vol = volOf(c), vave = shift(sma(vol, p.length), 1);
        const vcp = c.map((x, i) => { if (!ok(vave[i]) || !ok(vint[i])) return NA; const cut = p.coef * vint[i] * x.close, vc = Math.min(vol[i], vave[i] * p.vcoef), mf = typ[i] - typ[i - 1]; return mf > cut ? vc : mf < -cut ? -vc : 0; });
        const raw = rsum(vcp, p.length).map((v, i) => (vave[i] > 0 ? v / vave[i] : NA)), v = p.smooth ? sma(raw, 3) : raw, sig = ema(v, p.signal);
        return { v, sig, d: sub(v, sig) };
      } },
    { id: 'bwmfi', name: 'Market Facilitation Index (Bill Williams, tick volume)', short: 'BW MFI', kind: 'pane', category: 'Volume', params: [], outputs: [hist('v', 'MFI', '#26a69a')],
      calc: (c) => {
        const v = c.map((x) => (x.volume > 0 ? (x.high - x.low) / x.volume : NA));
        const col = c.map((x, i) => { if (!i || !ok(v[i]) || !ok(v[i - 1])) return '#787b86'; const mu = v[i] > v[i - 1], vu = x.volume > c[i - 1].volume; return mu && vu ? '#26a69a' : !mu && !vu ? '#8d6e63' : mu ? '#2962ff' : '#e91e63'; });
        return { v, colors: { v: col } };
      } },
    { id: 'vpci', name: 'Volume Price Confirmation Indicator (tick volume)', short: 'VPCI', kind: 'pane', category: 'Volume', params: [P.int('short', 'Short Length', 5), P.int('long', 'Long Length', 20), P.int('signal', 'Signal Length', 8)],
      outputs: [line('v', 'VPCI', '#2962ff'), line('sig', 'Signal', '#ff9800')], levels: [0],
      calc: (c, p) => {
        const cl = c.map((x) => x.close), vol = volOf(c), vwL = vwmaF(cl, vol, p.long), vwS = vwmaF(cl, vol, p.short), sL = sma(cl, p.long), sS = sma(cl, p.short), vS = sma(vol, p.short), vL = sma(vol, p.long);
        const v = cl.map((_, i) => (sS[i] && vL[i] ? (vwL[i] - sL[i]) * (vwS[i] / sS[i]) * (vS[i] / vL[i]) : NA));
        return { v, sig: vwmaF(v, vol, p.signal) };
      } },

    // ── Breadth (single-symbol proxies built from this market's own bars) ──
    { id: 'updownratio', name: 'Up/Down Bar Ratio (breadth proxy)', short: 'Up/Down %', kind: 'pane', category: 'Breadth', params: [tip(P.len(20), 'Share of up closes among up+down closes over the window (single-symbol advance/decline proxy)')],
      outputs: [line('v', 'Up %', '#26a69a')], levels: [70, 50, 30], range: [0, 100],
      calc: (c, p) => { const d = c.map((x, i) => (i ? Math.sign(x.close - c[i - 1].close) : NA)), u = rsumP(d.map((x) => (ok(x) ? +(x > 0) : NA)), p.length), w = rsumP(d.map((x) => (ok(x) ? +(x < 0) : NA)), p.length); return { v: u.map((x, i) => (x + w[i] ? (100 * x) / (x + w[i]) : ok(x) ? 50 : NA)) }; } },
    { id: 'adbars', name: 'Advance/Decline Line of Bars (breadth proxy)', short: 'A/D Bars', kind: 'pane', category: 'Breadth', params: [P.int('maLength', 'MA Length (0 = off)', 20, 0)], outputs: [line('v', 'A/D', '#2962ff'), line('ma', 'MA', '#ff9800')],
      calc: (c, p) => { const v = cum(c.map((x, i) => (i ? Math.sign(x.close - c[i - 1].close) : 0))); return { v, ma: p.maLength > 0 ? sma(v, p.maLength) : nan(c.length) }; } },
    { id: 'mcclellan', name: 'McClellan Oscillator (bar breadth proxy)', short: 'McClellan~', kind: 'pane', category: 'Breadth', params: [tip(P.int('fast', 'Fast EMA', 19), 'Net advances = +1 / -1 per up / down close of this market; true McClellan needs exchange breadth'), P.int('slow', 'Slow EMA', 39)],
      outputs: [hist('v', 'Oscillator'), line('sum', 'Summation (scaled /10)', '#787b86')], levels: [0],
      calc: (c, p) => { const net = c.map((x, i) => (i ? Math.sign(x.close - c[i - 1].close) : NA)), v = sub(ema(net, p.fast), ema(net, p.slow)), s = cum(v).map((x, i) => (ok(v[i]) ? x / 10 : NA)); return { v, sum: s, colors: { v: updown(v) } }; } },
    { id: 'mabreadth', name: 'Percent Above Moving Averages (breadth proxy)', short: '% > MAs', kind: 'pane', category: 'Breadth', params: [P.ma('SMA'), P.src(), tip(P.int('l1', 'Length #1', 5), 'Share of the listed moving averages the source is above')].concat([10, 20, 50, 100, 200].map((d, k) => P.int('l' + (k + 2), `Length #${k + 2} (0 = off)`, d, 0))),
      outputs: [line('v', '% above', '#26a69a')], levels: [80, 50, 20], range: [0, 100],
      calc: (c, p, ctx) => {
        const s = getSrc(c, ctx)(p.source), vol = volOf(c), mas = [1, 2, 3, 4, 5, 6].map((k) => p['l' + k]).filter((n) => n > 0).map((n) => maBy(p.maType, s, n, vol));
        return { v: s.map((x, i) => { let a = 0, t = 0; for (const m of mas) if (ok(m[i]) && ok(x)) { t++; if (x > m[i]) a++; } return t ? (100 * a) / t : NA; }) };
      } },
    { id: 'hlindex', name: 'New Highs-Lows Index (breadth proxy)', short: 'HL Index', kind: 'pane', category: 'Breadth', params: [P.int('lookback', 'New high/low lookback', 20), P.int('window', 'Count window', 20), P.int('smooth', 'SMA smoothing', 10)],
      outputs: [line('v', 'Record High %', '#2962ff')], levels: [70, 50, 30], range: [0, 100],
      calc: (c, p) => {
        const H = highest(c.map((x) => x.high), p.lookback), L = lowest(c.map((x) => x.low), p.lookback);
        const nh = rsumP(c.map((x, i) => (ok(H[i]) ? +(x.high >= H[i]) : NA)), p.window), nl = rsumP(c.map((x, i) => (ok(L[i]) ? +(x.low <= L[i]) : NA)), p.window);
        return { v: sma(nh.map((h, i) => (h + nl[i] ? (100 * h) / (h + nl[i]) : ok(h) ? 50 : NA)), p.smooth) };
      } },

    // ── Bands & channels ─────────────────────────────────
    { id: 'mac', name: 'Moving Average Channel', short: 'MAC', kind: 'overlay', category: 'Bands & channels', params: [P.int('upperLength', 'Upper Length', 20), P.int('lowerLength', 'Lower Length', 20), P.int('upperOffset', 'Upper Offset', 0, 0), P.int('lowerOffset', 'Lower Offset', 0, 0)],
      outputs: [line('upper', 'Upper', '#2962ff'), line('lower', 'Lower', '#ef5350')], fills: [{ a: 'upper', b: 'lower', color: 'rgba(41,98,255,0.06)' }],
      calc: (c, p) => ({ upper: shift(sma(c.map((x) => x.high), p.upperLength), p.upperOffset), lower: shift(sma(c.map((x) => x.low), p.lowerLength), p.lowerOffset) }) },
    { id: 'accbands', name: 'Acceleration Bands (Headley)', short: 'AccBands', kind: 'overlay', category: 'Bands & channels', params: [P.len(20), tip(P.num('factor', 'Width factor', 4, 0.1), 'Upper = SMA(high × (1 + factor × (H−L)/(H+L)))')],
      outputs: [line('upper', 'Upper', '#26a69a'), line('mid', 'Middle', '#ff9800'), line('lower', 'Lower', '#ef5350')], fills: [{ a: 'upper', b: 'lower', color: 'rgba(38,166,154,0.05)' }],
      calc: (c, p) => {
        const w = c.map((x) => (x.high + x.low ? (x.high - x.low) / (x.high + x.low) : 0));
        return { upper: sma(c.map((x, i) => x.high * (1 + p.factor * w[i])), p.length), mid: sma(c.map((x) => x.close), p.length), lower: sma(c.map((x, i) => x.low * (1 - p.factor * w[i])), p.length) };
      } },
    { id: 'fibbb', name: 'Fibonacci Bollinger Bands', short: 'Fib BB', kind: 'overlay', category: 'Bands & channels', params: [P.len(200), P.src('hlc3'), P.num('mult', 'StdDev multiplier', 3, 0.1), tip(P.sel('basis', 'Basis', ['VWMA (tick volume)', 'SMA']), 'VWMA falls back to SMA on bars with no volume')],
      outputs: [line('basis', 'Basis', '#ff9800', { width: 2 }), ...[1, 0.764, 0.618, 0.5, 0.382, 0.236].flatMap((r, k) => [line('u' + k, `Upper ${r}`, k ? '#ef9a9a' : '#ef5350'), line('l' + k, `Lower ${r}`, k ? '#a5d6a7' : '#26a69a')])],
      fills: [{ a: 'u0', b: 'l0', color: 'rgba(120,123,134,0.05)' }],
      calc: (c, p, ctx) => {
        const s = getSrc(c, ctx)(p.source), sm = sma(s, p.length), vw = p.basis === 'SMA' ? sm : vwmaF(s, volOf(c), p.length), m = vw.map((v, i) => (ok(v) ? v : sm[i])), d = stdev(s, p.length).map((v) => v * p.mult), o = { basis: m };
        [1, 0.764, 0.618, 0.5, 0.382, 0.236].forEach((r, k) => { o['u' + k] = m.map((v, i) => v + r * d[i]); o['l' + k] = m.map((v, i) => v - r * d[i]); });
        return o;
      } },
    { id: 'nwe', name: 'Nadaraya-Watson Envelope (causal)', short: 'NW Env', kind: 'overlay', category: 'Bands & channels',
      params: [tip(P.num('h', 'Bandwidth', 8, 0.5, 0.5), 'Endpoint (non-repainting) Gaussian kernel regression; kernel truncated where weights < 1e-10'), P.num('mult', 'MAE multiplier', 3, 0.1), tip(P.int('maeLength', 'MAE length', 100, 2, 5000), 'LuxAlgo uses 499; shorter default suits IG history limits'), P.src()],
      outputs: [line('mid', 'Estimate', '#787b86'), line('upper', 'Upper', '#26a69a', { width: 2 }), line('lower', 'Lower', '#ef5350', { width: 2 })],
      calc: (c, p, ctx) => {
        const s = getSrc(c, ctx)(p.source), h = Math.max(0.5, p.h), W = Math.max(2, Math.min(500, Math.ceil(h * Math.sqrt(2 * Math.log(1e10))) + 1)), w = Array.from({ length: W }, (_, j) => Math.exp(-(j * j) / (2 * h * h))), tw = w.reduce((a, b) => a + b, 0);
        const mid = rolling(s, W, (x) => { let acc = 0; for (let j = 0; j < W; j++) acc += x[W - 1 - j] * w[j]; return acc / tw; }), mae = sma(s.map((v, i) => Math.abs(v - mid[i])), p.maeLength).map((v) => v * p.mult);
        const markers = [];
        for (let i = 1; i < c.length; i++) { const u = mid[i] + mae[i], l = mid[i] - mae[i]; if (!ok(u)) continue; if (s[i - 1] <= mid[i - 1] + mae[i - 1] && s[i] > u) markers.push(mkDn(c[i].time, '▼')); else if (s[i - 1] >= mid[i - 1] - mae[i - 1] && s[i] < l) markers.push(mkUp(c[i].time, '▲')); }
        return { mid, upper: mid.map((v, i) => v + mae[i]), lower: mid.map((v, i) => v - mae[i]), markers };
      } },

    // ── Support/resistance ───────────────────────────────
    { id: 'hl52', name: '52 Week High/Low', short: '52W H/L', kind: 'overlay', category: 'Support/resistance', params: [tip(P.int('weeks', 'Weeks', 52, 1, 520), 'Trailing calendar window; uses whatever history is loaded when shorter'), P.bool('labels', 'Show labels', true)],
      outputs: [line('hi', '52W High', '#26a69a', { style: 2 }), line('lo', '52W Low', '#ef5350', { style: 2 })],
      calc: (c, p, ctx) => {
        const n = c.length, win = p.weeks * 7 * DAY, hi = nan(n), lo = nan(n), qh = [], ql = [];
        for (let i = 0, j = 0; i < n; i++) {
          while (j < i && c[j].time <= c[i].time - win) j++;
          if (ok(c[i].high)) { while (qh.length && c[qh[qh.length - 1]].high <= c[i].high) qh.pop(); qh.push(i); }
          if (ok(c[i].low)) { while (ql.length && c[ql[ql.length - 1]].low >= c[i].low) ql.pop(); ql.push(i); }
          while (qh.length && qh[0] < j) qh.shift();
          while (ql.length && ql[0] < j) ql.shift();
          if (qh.length) hi[i] = c[qh[0]].high;
          if (ql.length) lo[i] = c[ql[0]].low;
        }
        const graphics = [];
        if (p.labels && n && ok(hi[n - 1]) && ok(lo[n - 1])) { const t = c[n - 1].time; graphics.push(tlabel(t, hi[n - 1], `${p.weeks}W H ${fmtP(ctx, c, hi[n - 1])}`, '#26a69a', 'right'), tlabel(t, lo[n - 1], `${p.weeks}W L ${fmtP(ctx, c, lo[n - 1])}`, '#ef5350', 'right', 'top')); }
        return { hi, lo, graphics };
      } },
    { id: 'popen', name: 'Period Open / Previous Close Levels', short: 'Period Open', kind: 'overlay', category: 'Support/resistance',
      params: [P.sel('period', 'Period', PERIODS), P.int('count', 'Periods back', 10, 1, 200), P.bool('prevClose', 'Previous period close', true), P.bool('labels', 'Show labels', true), P.color('color', 'Open color', '#ff9800'), P.color('closeColor', 'Prev close color', '#787b86')], outputs: [],
      calc: (c, p, ctx) => {
        const g = groups(c, (t) => periodKey(t, p.period)), graphics = [], tag = p.period[0];
        for (let k = Math.max(0, g.length - p.count); k < g.length; k++) {
          const cur = g[k], t1 = c[cur.i0].time, t2 = k + 1 < g.length ? c[g[k + 1].i0].time : Math.max(periodEnd(cur.key, p.period), lastT(c));
          if (ok(cur.open)) { graphics.push(hline(t1, t2, cur.open, p.color)); if (p.labels) graphics.push(tlabel(t1, cur.open, `${tag}O ${fmtP(ctx, c, cur.open)}`, p.color)); }
          if (p.prevClose && k && ok(g[k - 1].close)) { graphics.push(hline(t1, t2, g[k - 1].close, p.closeColor, 2)); if (p.labels) graphics.push(tlabel(t1, g[k - 1].close, `P${tag}C ${fmtP(ctx, c, g[k - 1].close)}`, p.closeColor, 'left', 'top')); }
        }
        return { graphics };
      } },
    { id: 'roundnum', name: 'Round Numbers (psychological levels)', short: 'Round #', kind: 'overlay', category: 'Support/resistance',
      params: [tip(P.num('step', 'Step (0 = auto)', 0, 0.0001), 'Auto picks a 1-2-5 step giving ~6 levels across the last 200 bars'), P.bool('half', 'Half-step levels', true), P.int('maxLevels', 'Max levels', 30, 2, 200), P.color('color', 'Color', '#9598a1')], outputs: [],
      calc: (c, p, ctx) => {
        const n = c.length;
        if (!n) return { graphics: [] };
        let lo = Infinity, hi = -Infinity;
        for (let i = Math.max(0, n - 200); i < n; i++) { if (ok(c[i].low)) lo = Math.min(lo, c[i].low); if (ok(c[i].high)) hi = Math.max(hi, c[i].high); }
        if (!ok(lo) || !ok(hi)) return { graphics: [] };
        const R = hi - lo || Math.abs(hi) * 0.01 || 1, step = p.step > 0 ? p.step : nice(R / 6), sub_ = p.half ? step / 2 : step, a = Math.floor((lo - R / 2) / sub_), b = Math.ceil((hi + R / 2) / sub_), graphics = [], t1 = c[Math.max(0, n - 200)].time, t2 = lastT(c);
        if (b - a > p.maxLevels * 4) return { graphics: [] };
        const mid = (a + b) / 2;
        for (let k = a; k <= b; k++) {
          if (Math.abs(k - mid) > p.maxLevels / 2) continue;
          const price = k * sub_, major = !p.half || k % 2 === 0;
          graphics.push(hline(t1, t2, price, p.color, major ? 0 : 2, 'both', 1));
          if (major) graphics.push(tlabel(t2, price, fmtP(ctx, c, price), p.color, 'right'));
        }
        return { graphics };
      } },
    { id: 'murrey', name: 'Murrey Math Lines', short: 'Murrey', kind: 'overlay', category: 'Support/resistance', params: [tip(P.int('lookback', 'Frame lookback (bars)', 64, 8, 5000), 'Classic MQL Murrey_Math_Line_X octave selection over the lookback high/low'), P.bool('labels', 'Show labels', true), P.bool('extremes', 'Show ±1/8, ±2/8 extremes', true)], outputs: [],
      calc: (c, p, ctx) => {
        const n = c.length;
        if (n < 2) return { graphics: [] };
        const i0 = Math.max(0, n - p.lookback);
        let v1 = Infinity, v2 = -Infinity;
        for (let i = i0; i < n; i++) { if (ok(c[i].low)) v1 = Math.min(v1, c[i].low); if (ok(c[i].high)) v2 = Math.max(v2, c[i].high); }
        const f = murreyFrame(v1, v2);
        if (!f) return { graphics: [] };
        const NAMES = ['-2/8', '-1/8', '0/8 Ultimate Support', '1/8 Weak, Stall & Reverse', '2/8 Pivot, Reverse', '3/8 Bottom of Trading Range', '4/8 Major S/R', '5/8 Top of Trading Range', '6/8 Pivot, Reverse', '7/8 Weak, Stall & Reverse', '8/8 Ultimate Resistance', '+1/8', '+2/8'];
        const COLS = ['#d50000', '#ff6d00', '#2962ff', '#ffd600', '#d500f9', '#00c853', '#2962ff', '#00c853', '#d500f9', '#ffd600', '#2962ff', '#ff6d00', '#d50000'];
        const t1 = c[i0].time, t2 = lastT(c), graphics = [];
        for (let k = 0; k < 13; k++) {
          if (!p.extremes && (k < 2 || k > 10)) continue;
          const price = f.lo + (k - 2) * f.step;
          graphics.push(hline(t1, t2, price, COLS[k], k === 6 ? 0 : 2, 'right', k === 6 || k === 2 || k === 10 ? 2 : 1));
          if (p.labels) graphics.push(tlabel(t1, price, `${NAMES[k]} (${fmtP(ctx, c, price)})`, COLS[k]));
        }
        return { graphics };
      } },
    { id: 'tirone', name: 'Tirone Levels', short: 'Tirone', kind: 'overlay', category: 'Support/resistance', params: [P.len(20), P.sel('method', 'Method', ['Midpoint', 'Mean'])],
      outputs: [line('eh', 'Extreme High', '#d50000', { style: 2 }), line('rh', 'Top / Regular High', '#ef5350'), line('mid', 'Center / Mean', '#ff9800'), line('rl', 'Bottom / Regular Low', '#26a69a'), line('el', 'Extreme Low', '#00c853', { style: 2 })],
      calc: (c, p) => {
        const H = highest(c.map((x) => x.high), p.length), L = lowest(c.map((x) => x.low), p.length), n = c.length;
        if (p.method === 'Midpoint') return { eh: nan(n), el: nan(n), rh: H.map((h, i) => h - (h - L[i]) / 3), mid: H.map((h, i) => L[i] + (h - L[i]) / 2), rl: H.map((h, i) => L[i] + (h - L[i]) / 3) };
        const A = H.map((h, i) => (h + L[i] + c[i].close) / 3);
        return { eh: A.map((a, i) => a + (H[i] - L[i])), rh: A.map((a, i) => 2 * a - L[i]), mid: A, rl: A.map((a, i) => 2 * a - H[i]), el: A.map((a, i) => a - (H[i] - L[i])) };
      } },
    { id: 'autofibext', name: 'Auto Fib Extension', short: 'Auto Fib Ext', kind: 'overlay', category: 'Support/resistance',
      params: [tip(P.int('depth', 'Pivot depth', 10), 'Trend-based extension from the last three confirmed ZigZag swings A → B → C'), P.bool('extendRight', 'Extend right', true), P.bool('prices', 'Show prices', true)], outputs: [],
      calc: (c, p, ctx) => {
        const z = swings(c, p.depth);
        if (z.length < 3) return { graphics: [] };
        const [A, B, C] = z.slice(-3), move = B.p - A.p, graphics = [{ kind: 'polyline', pts: [A, B, C].map((q) => ({ t: q.t, p: q.p })), color: '#787b86', width: 1, style: 2 }];
        const LV = [[0, '#787b86'], [0.236, '#f44336'], [0.382, '#81c784'], [0.5, '#4caf50'], [0.618, '#009688'], [0.786, '#64b5f6'], [1, '#787b86'], [1.272, '#2962ff'], [1.618, '#9c27b0'], [2, '#e91e63'], [2.618, '#ff9800']];
        for (const [r, col] of LV) {
          const price = C.p + r * move;
          graphics.push(hline(C.t, lastT(c), price, col, 0, p.extendRight ? 'right' : 'none'));
          graphics.push({ kind: 'label', t: C.t, p: price, text: p.prices ? `${r} (${fmtP(ctx, c, price)})` : String(r), color: col, bg: 'transparent', align: 'right', base: 'middle' });
        }
        return { graphics };
      } },

    // ── Patterns ─────────────────────────────────────────
    { id: 'gaps', name: 'Gaps', short: 'Gaps', kind: 'overlay', category: 'Patterns', params: [P.int('maxGaps', 'Max number of gaps', 15, 1, 500), tip(P.num('minPct', 'Min gap size (%)', 0, 0.01), 'A gap up opens a box from the prior high to the current low (TradingView Gaps)'), P.bool('partial', 'Close gaps partially', true), P.bool('keepFilled', 'Keep filled gaps', false)], outputs: [],
      calc: (c, p) => {
        const live = [], done = [];
        for (let i = 1; i < c.length; i++) {
          const x = c[i], q = c[i - 1];
          for (let k = live.length - 1; k >= 0; k--) {
            const g = live[k];
            if (g.up ? x.low <= g.lo : x.high >= g.hi) { g.end = i; live.splice(k, 1); done.push(g); continue; }
            if (p.partial) { if (g.up) g.hi = Math.min(g.hi, x.low); else g.lo = Math.max(g.lo, x.high); }
          }
          const up = x.low > q.high, dn = x.high < q.low;
          if ((up || dn) && (100 * (up ? x.low - q.high : q.low - x.high)) / Math.abs(q.close || 1) >= p.minPct) live.push({ i, up, hi: up ? x.low : q.low, lo: up ? q.high : x.high, end: null });
        }
        const all = [...(p.keepFilled ? done : []), ...live].sort((a, b) => a.i - b.i).slice(-p.maxGaps);
        return { graphics: all.filter((g) => ok(g.hi) && ok(g.lo)).map((g) => ({ kind: 'box', t1: c[g.i - 1].time, p1: g.hi, t2: g.end === null ? lastT(c) : c[g.end].time, p2: g.lo, color: g.up ? UP : DN, fill: g.up ? 'rgba(38,166,154,0.15)' : 'rgba(239,83,80,0.15)' })) };
      } },

    // ── Candlestick patterns (TradingView definitions) ───
    { id: 'cp_all', name: 'All Candlestick Patterns (TradingView rules)', short: 'All Patterns', kind: 'overlay', category: 'Candlestick patterns', params: [CP_TREND(), ...CP.map(([k, name]) => P.bool(k, name, true))], outputs: [],
      calc: (c, p) => ({ markers: cpMarkers(c, p.trend, CP.filter(([k]) => p[k])) }) },
    ...CP.map((pat) => ({ id: 'cp_' + pat[0], name: pat[1], short: pat[1].replace(/ - (Bullish|Bearish)$/, ''), kind: 'overlay', category: 'Candlestick patterns', params: [CP_TREND()], outputs: [],
      calc: (c, p) => ({ markers: cpMarkers(c, p.trend, [pat]) }) })),
  ];
  DEFS.push(...EXTRA);

  const BY_ID = Object.fromEntries(DEFS.map((d) => [d.id, d]));
  function register(def) {
    if (!def || typeof def.id !== 'string' || typeof def.calc !== 'function') throw new Error('register: def needs id and calc');
    def.params = def.params || []; def.outputs = def.outputs || []; def.category = def.category || 'Trend'; def.kind = def.kind || 'pane';
    const i = DEFS.findIndex((d) => d.id === def.id);
    if (i >= 0) DEFS[i] = def; else DEFS.push(def);
    BY_ID[def.id] = def;
    return def;
  }
  function unregister(id) {
    const i = DEFS.findIndex((d) => d.id === id);
    if (i >= 0) DEFS.splice(i, 1);
    delete BY_ID[id];
  }
  const defaults = (def) => Object.fromEntries(def.params.map((p) => [p.k, p.def]));
  const title = (def, params) => {
    const vals = def.params.filter((p) => p.type === 'int' || p.type === 'number' || p.type === 'source').map((p) => {
      const v = params[p.k];
      return p.type === 'source' && typeof v === 'string' && v.startsWith('study:') ? v.split(':').pop() : v;
    });
    return `${def.short}${vals.length ? ' ' + vals.join(' ') : ''}`;
  };

  function heikinAshi(c) {
    const out = [];
    c.forEach((x, i) => {
      const close = (x.open + x.high + x.low + x.close) / 4;
      const open = i ? (out[i - 1].open + out[i - 1].close) / 2 : (x.open + x.close) / 2;
      out.push({ time: x.time, open, high: Math.max(x.high, open, close), low: Math.min(x.low, open, close), close });
    });
    return out;
  }

  const CATEGORIES = ['Moving averages', 'Trend', 'Oscillators', 'Volatility', 'Volume', 'Bands & channels', 'Support/resistance', 'Patterns', 'Candlestick patterns', 'Statistics', 'Profiles', 'Breadth'];
  const SOURCE_LABELS = { close: 'Close', open: 'Open', high: 'High', low: 'Low', hl2: 'HL2', hlc3: 'HLC3', ohlc4: 'OHLC4', volume: 'Volume (tick)' };
  // uids a study reads through 'study:<uid>:<key>' source params
  function dependencies(params, def) {
    const keys = def ? (def.params || []).filter((q) => q.type === 'source').map((q) => q.k) : Object.keys(params || {});
    const out = new Set();
    for (const k of keys) { const r = parseStudySrc(params && params[k]); if (r) out.add(r.uid); }
    return [...out];
  }
  // built-in sources + every other study's outputs; studies that (transitively) read selfUid are excluded to prevent cycles
  function sourceOptions(ctx, selfUid) {
    const opts = SOURCES.map((s) => ({ value: s, label: SOURCE_LABELS[s] || s })), series = (ctx && ctx.studySeries) || {};
    const depsOf = (uid) => { const st = series[uid]; return (st && (st.deps || (st.params ? dependencies(st.params) : []))) || []; };
    const reaches = (uid, seen = new Set()) => { if (uid === selfUid) return true; if (seen.has(uid)) return false; seen.add(uid); return depsOf(uid).some((d) => reaches(d, seen)); };
    for (const [uid, st] of Object.entries(series)) {
      if (!st || !st.outputs || (selfUid != null && reaches(uid))) continue;
      for (const key of Object.keys(st.outputs)) opts.push({ value: `study:${uid}:${key}`, label: `${st.name || uid}: ${(st.labels && st.labels[key]) || key}`, study: uid });
    }
    return opts;
  }
  // run a definition and collect source-resolution warnings: returns calc output plus out.warnings (string[])
  function run(def, candles, params, ctx) {
    const prev = warnSink, sink = (warnSink = new Set());
    try {
      const out = def.calc(candles, params, ctx) || {};
      out.warnings = [...sink];
      return out;
    } finally { warnSink = prev; }
  }
  window.IGInd = {
    DEFS, BY_ID, CATEGORIES, defaults, title, heikinAshi, register, unregister, src: baseSrc, SOURCES, sourceOptions, dependencies, run, parseStudySrc,
    ta: { sma, ema, rma, wma, hma, alma, atr, tr, rsi, stdev, highest, lowest, linreg, change, roc, cum, swma, percentrank, maBy, volProfile, tpoProfile, swings,
      trima, t3, superSmoother, lrSlope, superTrend, dmi, pivotIdx, onValid },
  };
})();
