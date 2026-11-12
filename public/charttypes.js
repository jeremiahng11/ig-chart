/* IG Charts — chart types and intervals (window.IGTypes). Pure transforms: no DOM, no dependencies.
 * Price-based outputs carry `srcTime` (the real source time); `time` is a synthetic, strictly increasing
 * value required by Lightweight Charts (max(srcTime, previous time + 1)).
 */
(() => {
  const ok = Number.isFinite;
  const EPS = 1e-9;
  const rnd = (v) => Math.round(v * 1e10) / 1e10;
  const UP = '#26a69a', DOWN = '#ef5350';

  // ---------- intervals ----------
  const UNIT_SEC = { S: 1, m: 60, H: 3600, D: 86400, W: 604800, M: 2592000 };

  function parseInterval(str) {
    if (str && typeof str === 'object') return str.kind ? str : null;
    const s = String(str == null ? '' : str).trim();
    let m;
    if ((m = /^(\d+(?:\.\d+)?)\s*R$/i.exec(s))) {
      const size = +m[1];
      return size > 0 ? { kind: 'range', size } : null;
    }
    if ((m = /^(\d+)\s*T$/i.exec(s))) {
      const n = +m[1];
      return n > 0 ? { kind: 'ticks', n } : null;
    }
    if ((m = /^(\d*)\s*([SsmHhDdWwMYy]?)$/.exec(s)) && (m[1] || m[2])) {
      let n = m[1] ? +m[1] : 1;
      let u = m[2] || 'm';
      if (!(n > 0)) return null;
      if (u === 's') u = 'S';
      else if (u === 'h') u = 'H';
      else if (u === 'd') u = 'D';
      else if (u === 'w') u = 'W';
      else if (u === 'Y' || u === 'y') { u = 'M'; n *= 12; }
      if (u === 'm' && n % 60 === 0) { u = 'H'; n /= 60; }
      if (u === 'S' && n % 60 === 0) { u = 'm'; n /= 60; if (n % 60 === 0) { u = 'H'; n /= 60; } }
      if (u === 'H' && n % 24 === 0) { u = 'D'; n /= 24; }
      return { kind: 'time', unit: u, n, sec: n * UNIT_SEC[u] };
    }
    return null;
  }

  function label(spec) {
    const p = parseInterval(spec);
    if (!p) return '';
    if (p.kind === 'ticks') return p.n + 'T';
    if (p.kind === 'range') return p.size + 'R';
    return p.n + p.unit;
  }

  const RES_SEC = {
    SECOND: 1, MINUTE: 60, MINUTE_2: 120, MINUTE_3: 180, MINUTE_5: 300, MINUTE_10: 600, MINUTE_15: 900,
    MINUTE_30: 1800, HOUR: 3600, HOUR_2: 7200, HOUR_3: 10800, HOUR_4: 14400, DAY: 86400, WEEK: 604800, MONTH: 2592000,
  };
  const ALL_RES = Object.keys(RES_SEC);

  // → { resolution, sec, factor?, exact, note? }
  function baseResolution(spec, available = ALL_RES) {
    const p = parseInterval(spec);
    const av = (available || ALL_RES).filter((r) => r in RES_SEC);
    if (!p || !av.length) return null;
    const has = (r) => av.includes(r);
    const pick = (r, extra = {}) => ({ resolution: r, sec: RES_SEC[r], exact: true, ...extra });
    if (p.kind !== 'time') {
      const r = has('SECOND') ? 'SECOND' : has('MINUTE') ? 'MINUTE' : av.slice().sort((a, b) => RES_SEC[a] - RES_SEC[b])[0];
      return pick(r, {
        exact: false,
        note: p.kind === 'ticks'
          ? `IG has no tick history: history is approximated by grouping ${r} bars until their tick volume reaches ${p.n}; live bars come from the tick stream.`
          : `IG has no tick history: history range bars are approximated from ${r} OHLC paths; live bars come from the tick stream.`,
      });
    }
    if (p.unit === 'M') {
      if (has('MONTH')) return pick('MONTH', { factor: p.n });
      if (has('DAY')) return pick('DAY', { note: 'MONTH unavailable; months built from DAY bars.' });
    }
    if (p.unit === 'W') {
      if (has('WEEK')) return pick('WEEK', { factor: p.n });
      if (has('DAY')) return pick('DAY', { factor: p.n * 7 });
    }
    const intraday = av.filter((r) => RES_SEC[r] <= 86400 && r !== 'WEEK' && r !== 'MONTH');
    let best = null;
    for (const r of intraday) {
      const s = RES_SEC[r];
      if (s <= p.sec && p.sec % s === 0 && (!best || s > RES_SEC[best])) best = r;
    }
    if (best) return pick(best, { factor: p.sec / RES_SEC[best] });
    const smallest = av.slice().sort((a, b) => RES_SEC[a] - RES_SEC[b])[0];
    return pick(smallest, { exact: false, note: `No available resolution divides ${label(p)}; using ${smallest}.` });
  }

  // ---------- time zone offsets (seconds east of UTC) ----------
  const tzCache = new Map();
  function offsetFn(tz) {
    if (tz == null || tz === 'UTC' || tz === 0) return null;
    if (typeof tz === 'number') { const o = tz * 60; return () => o; }
    let fmt;
    try {
      fmt = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric' });
    } catch (e) { return null; }
    let cache = tzCache.get(tz);
    if (!cache) { cache = new Map(); tzCache.set(tz, cache); }
    return (t) => {
      const h = Math.floor(t / 900);
      let o = cache.get(h);
      if (o === undefined) {
        const parts = {};
        for (const x of fmt.formatToParts(new Date(h * 900000))) parts[x.type] = x.value;
        const local = Date.UTC(+parts.year, parts.month - 1, +parts.day, +parts.hour % 24, +parts.minute, +parts.second) / 1000;
        o = local - h * 900;
        if (cache.size > 50000) cache.clear();
        cache.set(h, o);
      }
      return o;
    };
  }

  const MONDAY0 = 4 * 86400;
  function localBucket(lt, p) {
    if (p.unit === 'M') {
      const d = new Date(lt * 1000);
      const idx = d.getUTCFullYear() * 12 + d.getUTCMonth();
      const b = Math.floor(idx / p.n) * p.n;
      return Date.UTC(Math.floor(b / 12), b % 12, 1) / 1000;
    }
    if (p.unit === 'W') return Math.floor((lt - MONDAY0) / p.sec) * p.sec + MONDAY0;
    return Math.floor(lt / p.sec) * p.sec;
  }
  function bucketer(p, tz) {
    const off = offsetFn(tz);
    if (!off) return (t) => localBucket(t, p);
    return (t) => {
      const lb = localBucket(t + off(t), p);
      return lb - off(lb - off(t));
    };
  }

  function clean(bars) {
    const out = [];
    let prev = -Infinity;
    for (const b of bars || []) {
      if (!b || !ok(b.time) || !ok(b.open) || !ok(b.high) || !ok(b.low) || !ok(b.close) || b.time <= prev) continue;
      out.push(b);
      prev = b.time;
    }
    return out;
  }

  const vol = (b) => (ok(b.volume) ? b.volume : 0);

  function aggregate(bars, spec, opts = {}) {
    const p = parseInterval(spec);
    const src = clean(bars);
    if (!p) return src.slice();
    if (p.kind === 'range') return rangeBars(src, p.size);
    if (p.kind === 'ticks') return groupByVolume(src, p.n);
    const key = bucketer(p, opts.tz);
    const out = [];
    let cur = null;
    for (const b of src) {
      const k = key(b.time);
      if (cur && k <= cur.time) {
        if (b.high > cur.high) cur.high = b.high;
        if (b.low < cur.low) cur.low = b.low;
        cur.close = b.close;
        cur.volume += vol(b);
      } else {
        cur = { time: k, open: b.open, high: b.high, low: b.low, close: b.close, volume: vol(b) };
        out.push(cur);
      }
    }
    return out;
  }

  function groupByVolume(src, n) {
    const out = [];
    let cur = null;
    for (const b of src) {
      if (!cur) cur = { time: b.time, open: b.open, high: b.high, low: b.low, close: b.close, volume: 0 };
      else {
        if (b.high > cur.high) cur.high = b.high;
        if (b.low < cur.low) cur.low = b.low;
        cur.close = b.close;
      }
      cur.volume += vol(b) || 1;
      if (cur.volume >= n) { out.push(cur); cur = null; }
    }
    if (cur) out.push(cur);
    return out;
  }

  // ---------- unique time assignment ----------
  function stamp(arr) {
    let prev = -Infinity;
    for (const x of arr) {
      x.time = x.srcTime > prev ? x.srcTime : prev + 1;
      prev = x.time;
    }
    return arr;
  }

  // ---------- range bars ----------
  function rangeState(size) { return { size, cur: null, done: [] }; }
  function rangeStep(st, price, t, vol = 0) {
    const R = st.size;
    let c = st.cur;
    if (!c) {
      st.cur = { srcTime: t, open: price, high: price, low: price, close: price, volume: vol };
      return;
    }
    c.volume += vol;
    for (;;) {
      if (price > c.low + R + EPS) {
        c.high = rnd(c.low + R); c.close = c.high;
        st.done.push(c);
        c = st.cur = { srcTime: t, open: c.close, high: c.close, low: c.close, close: c.close, volume: 0 };
      } else if (price < c.high - R - EPS) {
        c.low = rnd(c.high - R); c.close = c.low;
        st.done.push(c);
        c = st.cur = { srcTime: t, open: c.close, high: c.close, low: c.close, close: c.close, volume: 0 };
      } else {
        if (price > c.high) c.high = price;
        if (price < c.low) c.low = price;
        c.close = price;
        return;
      }
    }
  }
  const path = (b) => (b.close >= b.open ? [b.open, b.low, b.high, b.close] : [b.open, b.high, b.low, b.close]);

  function rangeBars(src, size) {
    if (!(size > 0)) return [];
    const st = rangeState(size);
    for (const b of src) {
      const pts = path(b);
      const v = vol(b) / 4;
      for (const p of pts) rangeStep(st, p, b.time, v);
    }
    const out = st.done.slice();
    if (st.cur) out.push(st.cur);
    return stamp(out);
  }

  // ---------- live ticks ----------
  const tickPrice = (k) => (ok(k.price) ? k.price : ok(k.bid) && ok(k.offer) ? (k.bid + k.offer) / 2 : ok(k.bid) ? k.bid : k.offer);

  function createTickAggregator(spec, init) {
    const p = parseInterval(spec);
    if (!p) throw new Error('bad interval: ' + spec);
    const st = init && init.state ? init.state : init && init.kind ? init : null;
    const state = st || { kind: p.kind, spec: p, bars: [], count: 0, range: p.kind === 'range' ? rangeState(p.size) : null };
    if (!st) {
      const prev = Array.isArray(init) ? init : init && Array.isArray(init.prevBars) ? init.prevBars : [];
      state.bars = clean(prev).map((b) => ({ ...b }));
      const last = state.bars[state.bars.length - 1];
      if (p.kind === 'ticks' && last) state.count = Math.min(vol(last), p.n);
      if (p.kind === 'range' && last) {
        state.bars.pop();
        state.range.cur = { srcTime: last.srcTime != null ? last.srcTime : last.time, open: last.open, high: last.high, low: last.low, close: last.close, volume: vol(last) };
        state.lastTime = state.bars.length ? state.bars[state.bars.length - 1].time : -Infinity;
        state.range.cur.time = Math.max(last.time, state.lastTime + 1);
        state.bars.push(state.range.cur);
      }
    }
    const key = p.kind === 'time' ? bucketer(p, init && init.tz) : null;
    const nextTime = (t) => {
      const last = state.bars[state.bars.length - 1];
      return last && t <= last.time ? last.time + 1 : t;
    };

    function push(tick) {
      const price = tickPrice(tick);
      if (!ok(price) || !ok(tick.t)) return { bar: null, isNew: false, changed: [] };
      const ts = Math.floor(tick.t / 1000);
      const bars = state.bars;
      let last = bars[bars.length - 1];
      if (p.kind === 'time') {
        const k = key(ts);
        if (last && k <= last.time) {
          if (price > last.high) last.high = price;
          if (price < last.low) last.low = price;
          last.close = price;
          last.volume = vol(last) + 1;
          return { bar: last, isNew: false, changed: [last] };
        }
        last = { time: k, open: price, high: price, low: price, close: price, volume: 1 };
        bars.push(last);
        return { bar: last, isNew: true, changed: [last] };
      }
      if (p.kind === 'ticks') {
        if (last && state.count < p.n) {
          if (price > last.high) last.high = price;
          if (price < last.low) last.low = price;
          last.close = price;
          last.volume = vol(last) + 1;
          state.count++;
          return { bar: last, isNew: false, changed: [last] };
        }
        last = { time: nextTime(ts), srcTime: ts, open: price, high: price, low: price, close: price, volume: 1 };
        state.count = 1;
        bars.push(last);
        return { bar: last, isNew: true, changed: [last] };
      }
      const r = state.range;
      const prevCur = r.cur;
      rangeStep(r, price, ts, 1);
      const added = r.done.splice(0);
      if (!prevCur) {
        r.cur.time = nextTime(ts);
        bars.push(r.cur);
        return { bar: r.cur, isNew: true, changed: [r.cur] };
      }
      if (!added.length) return { bar: r.cur, isNew: false, changed: [r.cur] };
      const changed = added.slice();
      for (let i = 1; i < added.length; i++) { added[i].time = nextTime(added[i].srcTime); bars.push(added[i]); }
      r.cur.time = nextTime(r.cur.srcTime);
      bars.push(r.cur);
      changed.push(r.cur);
      return { bar: r.cur, isNew: true, changed };
    }

    return { push, bars: () => state.bars, state };
  }

  function fromTicks(ticks, spec, prev) {
    const agg = createTickAggregator(spec, prev);
    for (const k of ticks || []) agg.push(k);
    return { bars: agg.bars(), state: agg.state };
  }

  // ---------- helpers ----------
  function atrSeries(bars, len = 14) {
    const out = new Array(bars.length).fill(NaN);
    let sum = 0, prev = NaN;
    for (let i = 0; i < bars.length; i++) {
      const b = bars[i];
      const tr = i ? Math.max(b.high - b.low, Math.abs(b.high - bars[i - 1].close), Math.abs(b.low - bars[i - 1].close)) : b.high - b.low;
      if (i < len) { sum += tr; if (i === len - 1) out[i] = prev = sum / len; } else out[i] = prev = (prev * (len - 1) + tr) / len;
    }
    return out;
  }
  function renkoBoxFromAtr(bars, len = 14) {
    const src = clean(bars);
    if (!src.length) return NaN;
    const a = atrSeries(src, len);
    let v = a[a.length - 1];
    if (!ok(v)) { let s = 0; for (let i = 0; i < src.length; i++) s += src[i].high - src[i].low; v = s / src.length; }
    if (!(v > 0)) v = Math.abs(src[src.length - 1].close) * 0.001 || 1;
    return +v.toPrecision(3);
  }
  function resolveSize(bars, type, value, atrLength) {
    if (type !== 'atr' && value > 0) return +value;
    return renkoBoxFromAtr(bars, atrLength || 14);
  }

  function hexA(c, a) {
    const m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(c || '');
    if (!m) return c;
    let h = m[1];
    if (h.length === 3) h = h.replace(/./g, '$&$&');
    const n = parseInt(h, 16);
    return `rgba(${n >> 16},${(n >> 8) & 255},${n & 255},${+a.toFixed(3)})`;
  }

  const ohlc = (b) => ({ time: b.time, open: b.open, high: b.high, low: b.low, close: b.close, volume: vol(b) });
  const point = (b, v) => ({ time: b.time, value: v });

  // ---------- price-based engines ----------
  function renko(src, o) {
    const box = resolveSize(src, o.boxType, o.box, o.atrLength);
    const out = [];
    if (!src.length || !(box > 0)) return { out, box };
    const wicks = o.wicks !== false;
    const useHL = o.source === 'hl';
    let H = Math.round(src[0].close / box), L = H;
    let mn = src[0].close, mx = mn, v = 0;
    const brick = (op, cl, t) => {
      const open = rnd(op * box), close = rnd(cl * box);
      const up = cl > op;
      const b = { srcTime: t, open, close, high: up ? close : open, low: up ? open : close, volume: v, color: up ? o.up : o.down };
      if (wicks) { if (up) b.low = Math.min(b.low, mn); else b.high = Math.max(b.high, mx); }
      out.push(b);
      v = 0;
      mn = mx = close;
    };
    const feed = (p, t) => {
      if (p < mn) mn = p;
      if (p > mx) mx = p;
      const q = p / box;
      while (q >= H + 1 - EPS) { brick(H, H + 1, t); L = H; H += 1; if (p < mn) mn = p; if (p > mx) mx = p; }
      while (q <= L - 1 + EPS) { brick(L, L - 1, t); H = L; L -= 1; if (p < mn) mn = p; if (p > mx) mx = p; }
    };
    for (const b of src) {
      v += vol(b);
      if (useHL) for (const p of path(b)) feed(p, b.time);
      else feed(b.close, b.time);
    }
    return { out: stamp(out), box };
  }

  function lineBreak(src, o) {
    const N = Math.max(1, o.lines | 0 || 3);
    const lines = [];
    if (!src.length) return lines;
    const ref = src[0].close;
    let v = 0;
    const add = (open, close, t) => {
      lines.push({ srcTime: t, open, close, high: Math.max(open, close), low: Math.min(open, close), volume: v, color: close > open ? o.up : o.down });
      v = 0;
    };
    for (const b of src) {
      v += vol(b);
      const p = b.close;
      if (!lines.length) { if (p !== ref) add(ref, p, b.time); continue; }
      const last = lines[lines.length - 1];
      const up = last.close > last.open;
      const k = Math.max(0, lines.length - N);
      let hi = -Infinity, lo = Infinity;
      for (let i = k; i < lines.length; i++) { if (lines[i].high > hi) hi = lines[i].high; if (lines[i].low < lo) lo = lines[i].low; }
      if (up) {
        if (p > last.close) add(last.close, p, b.time);
        else if (p < lo) add(last.open, p, b.time);
      } else if (p < last.close) add(last.close, p, b.time);
      else if (p > hi) add(last.open, p, b.time);
    }
    return stamp(lines);
  }

  function kagi(src, o) {
    const type = o.reversalType || 'atr';
    const rev = type === 'atr' ? renkoBoxFromAtr(src, o.atrLength) : +o.reversal;
    const pts = [];
    if (!src.length || !(rev > 0)) return { pts, rev };
    const amt = (p) => (type === 'percent' ? Math.abs(p) * rev / 100 : rev);
    const yang = { color: o.up, width: 3, kind: 'yang' }, yin = { color: o.down, width: 1, kind: 'yin' };
    const start = src[0].close;
    pts.push({ srcTime: src[0].time, value: start });
    let dir = 0, ext = start, state = null, shoulder = NaN, waist = NaN;
    const setStyle = (pt) => { pt.color = state.color; pt.width = state.width; pt.kind = state.kind; };
    for (let i = 1; i < src.length; i++) {
      const p = src[i].close, t = src[i].time;
      if (dir === 0) {
        if (Math.abs(p - start) >= amt(start) - EPS) {
          dir = p > start ? 1 : -1;
          state = dir > 0 ? yang : yin;
          setStyle(pts[0]);
          ext = p;
          pts.push({ srcTime: t, value: p });
          setStyle(pts[1]);
        }
        continue;
      }
      const last = pts[pts.length - 1];
      if ((dir > 0 && p > ext) || (dir < 0 && p < ext)) {
        ext = p; last.value = p; last.srcTime = t;
      } else if (Math.abs(ext - p) >= amt(ext) - EPS) {
        if (dir > 0) shoulder = ext; else waist = ext;
        dir = -dir; ext = p;
        pts.push({ srcTime: t, value: p });
      } else continue;
      const cur = pts[pts.length - 1];
      if (dir > 0 && ok(shoulder) && cur.value > shoulder) state = yang;
      else if (dir < 0 && ok(waist) && cur.value < waist) state = yin;
      setStyle(cur);
    }
    if (!state) { state = yang; setStyle(pts[0]); }
    return { pts: stamp(pts), rev };
  }

  function pnf(src, o) {
    const box = resolveSize(src, o.boxType, o.box, o.atrLength);
    const rev = Math.max(1, o.reversal | 0 || 3);
    const cols = [];
    if (!src.length || !(box > 0)) return { cols, box, rev };
    const useHL = o.source === 'hl';
    const idx = (p) => Math.floor(p / box + EPS);
    const ref = idx(src[0].close);
    let v = 0;
    const feed = (p, t) => {
      const f = idx(p);
      const c = cols[cols.length - 1];
      if (!c) {
        if (f > ref) cols.push({ x: 'X', lo: ref, hi: f, srcTime: t, volume: v });
        else if (f < ref) cols.push({ x: 'O', lo: f, hi: ref, srcTime: t, volume: v });
        else return;
        v = 0;
        return;
      }
      if (c.x === 'X') {
        if (f > c.hi) { c.hi = f; c.volume += v; v = 0; } else if (f <= c.hi - rev) { cols.push({ x: 'O', lo: f, hi: c.hi - 1, srcTime: t, volume: v }); v = 0; }
      } else if (f < c.lo) { c.lo = f; c.volume += v; v = 0; } else if (f >= c.lo + rev) { cols.push({ x: 'X', lo: c.lo + 1, hi: f, srcTime: t, volume: v }); v = 0; }
    };
    for (const b of src) {
      v += vol(b);
      if (useHL) {
        const c = cols[cols.length - 1];
        const seq = !c ? path(b) : c.x === 'X' ? [b.high, b.low] : [b.low, b.high];
        for (const p of seq) feed(p, b.time);
      } else feed(b.close, b.time);
    }
    if (cols.length) cols[cols.length - 1].volume += v;
    stamp(cols);
    return { cols, box, rev };
  }

  // ---------- chart types ----------
  const I = {
    bars: 'M5 3v12M3 6h2M5 12h2M12 4v11M10 7h2M12 12h2',
    candles: 'M5 2v3M5 13v3M3 5h4v8H3zM13 4v3M13 12v3M11 7h4v5h-4z',
    hollow: 'M5 2v3M5 13v3M3 5h4v8H3zM13 4v3M13 12v3M11 7h4v5h-4zM3 9h4',
    volume_candles: 'M4 3v3M4 12v3M3 6h2v6H3zM12 2v3M12 13v3M9 5h6v8H9z',
    line: 'M2 13l4-5 4 3 6-7',
    line_markers: 'M2 13l4-5 4 3 6-7M5 8a1 1 0 1 0 2 0a1 1 0 1 0-2 0M9 11a1 1 0 1 0 2 0a1 1 0 1 0-2 0',
    step: 'M2 13h4V8h4v3h4V5h2',
    area: 'M2 13l4-5 4 3 6-7v12H2z',
    hlc_area: 'M2 8l4-3 4 2 6-4M2 14l4-3 4 2 6-4M2 11l4-3 4 2 6-4',
    baseline: 'M2 9h14M2 12l3-6 4 7 4-9 3 5',
    columns: 'M3 16V9M7 16V5M11 16v-5M15 16V3',
    high_low: 'M4 4h3v10H4zM11 2h3v9h-3z',
    heikin: 'M5 2v2M5 14v2M3 4h4v10H3zM13 3v3M13 13v2M11 6h4v7h-4zM3 11h4',
    renko: 'M2 16h4v-4H2zM6 12h4V8H6zM10 8h4V4h-4z',
    line_break: 'M2 16h3v-6H2zM5 10h3V3H5zM8 5h3v7H8zM11 12h3V6h-3z',
    kagi: 'M3 16V7h4v6h3V3h4v8',
    pnf: 'M3 3l3 3M6 3L3 6M3 8l3 3M6 8l-3 3M3 13l3 3M6 13l-3 3M11 6.5a1.5 1.5 0 1 0 3 0a1.5 1.5 0 1 0-3 0M11 11.5a1.5 1.5 0 1 0 3 0a1.5 1.5 0 1 0-3 0',
    range: 'M3 3h3v6H3zM7 9h3v6H7zM11 3h3v6h-3z',
    volume_footprint: 'M3 3h12v12H3zM9 3v12M3 7h12M3 11h12',
    tpo: 'M3 4h3M3 7h7M3 10h11M3 13h6M3 16h3',
    session_volume_profile: 'M2 2v14M16 3h-4M16 6H8M16 9H5M16 12H9M16 15h-3',
  };
  const P = {
    boxType: { k: 'boxType', label: 'Box size assignment', type: 'select', options: ['atr', 'fixed'], def: 'atr' },
    atrLength: { k: 'atrLength', label: 'ATR length', type: 'int', def: 14 },
    box: { k: 'box', label: 'Box size', type: 'number', def: 1 },
    hl: { k: 'source', label: 'Source', type: 'select', options: ['close', 'hl'], def: 'close' },
  };
  const CHART_TYPES = [
    ['bars', 'Bars', 'Standard'], ['candles', 'Candles', 'Standard'], ['hollow', 'Hollow candles', 'Standard'],
    ['volume_candles', 'Volume candles', 'Volume'], ['line', 'Line', 'Standard'], ['line_markers', 'Line with markers', 'Standard'],
    ['step', 'Step line', 'Standard'], ['area', 'Area', 'Standard'], ['hlc_area', 'HLC area', 'Standard'],
    ['baseline', 'Baseline', 'Standard', [{ k: 'basePct', label: 'Base level (%)', type: 'int', def: 50 }]],
    ['columns', 'Columns', 'Standard'], ['high_low', 'High-low', 'Standard'], ['heikin', 'Heikin Ashi', 'Standard'],
    ['renko', 'Renko', 'Price-based', [P.boxType, P.atrLength, P.box, P.hl, { k: 'wicks', label: 'Wicks', type: 'bool', def: true }]],
    ['line_break', 'Line break', 'Price-based', [{ k: 'lines', label: 'Number of lines', type: 'int', def: 3 }]],
    ['kagi', 'Kagi', 'Price-based', [{ k: 'reversalType', label: 'Reversal assignment', type: 'select', options: ['atr', 'fixed', 'percent'], def: 'atr' }, P.atrLength, { k: 'reversal', label: 'Reversal amount', type: 'number', def: 1 }]],
    ['pnf', 'Point & figure', 'Price-based', [P.boxType, P.atrLength, P.box, { k: 'reversal', label: 'Reversal (boxes)', type: 'int', def: 3 }, P.hl]],
    ['range', 'Range', 'Price-based', [{ k: 'sizeType', label: 'Range assignment', type: 'select', options: ['atr', 'fixed'], def: 'atr' }, P.atrLength, { k: 'size', label: 'Range size', type: 'number', def: 1 }]],
    ['volume_footprint', 'Volume footprint', 'Profile', [{ k: 'rowSize', label: 'Row size (0 = auto)', type: 'number', def: 0 }]],
    ['tpo', 'Time price opportunity', 'Profile', [{ k: 'rowSize', label: 'Row size (0 = auto)', type: 'number', def: 0 }, { k: 'session', label: 'Session', type: 'select', options: ['Day', 'Week'], def: 'Day' }]],
    ['session_volume_profile', 'Session volume profile', 'Profile', [{ k: 'rows', label: 'Rows', type: 'int', def: 24 }, { k: 'valueArea', label: 'Value area (%)', type: 'int', def: 70 }, { k: 'session', label: 'Session', type: 'select', options: ['Day', 'Week'], def: 'Day' }]],
  ].map(([id, lbl, group, opts = []]) => ({
    id, label: lbl, group, priceBased: group === 'Price-based', opts,
    colors: [{ k: 'up', label: 'Up color', type: 'color', def: UP }, { k: 'down', label: 'Down color', type: 'color', def: DOWN }],
    icon: I[id],
  }));
  const BY_ID = Object.fromEntries(CHART_TYPES.map((t) => [t.id, t]));
  const ALIAS = { svp: 'session_volume_profile', footprint: 'volume_footprint', heikin_ashi: 'heikin', point_figure: 'pnf', hollow_candles: 'hollow' };

  function defaults(id) {
    const t = BY_ID[ALIAS[id] || id];
    const o = { up: UP, down: DOWN };
    if (t) for (const p of t.opts) o[p.k] = p.def;
    return o;
  }

  function transform(type, bars, opts = {}) {
    const id = ALIAS[type] || type;
    const o = { ...defaults(id), ...opts };
    const src = clean(bars);
    const up = o.up, down = o.down;
    const dirColor = (b, i) => (b.close >= (i ? src[i - 1].close : b.open) ? up : down);
    switch (id) {
      case 'bars':
        return { bars: src.map(ohlc), series: 'bars', options: { upColor: up, downColor: down, thinBars: false } };
      case 'candles':
        return { bars: src.map(ohlc), series: 'candles', options: { upColor: up, downColor: down, borderUpColor: up, borderDownColor: down, wickUpColor: up, wickDownColor: down } };
      case 'hollow':
        return {
          bars: src.map((b, i) => {
            const c = dirColor(b, i);
            return { ...ohlc(b), color: b.close > b.open ? 'rgba(0,0,0,0)' : c, borderColor: c, wickColor: c };
          }),
          series: 'candles', options: { borderVisible: true, wickVisible: true },
        };
      case 'volume_candles': {
        const vs = src.map(vol).sort((a, b) => a - b);
        const n = vs.length;
        const rank = (v) => { let lo = 0, hi = n; while (lo < hi) { const m = (lo + hi) >> 1; if (vs[m] <= v) lo = m + 1; else hi = m; } return n > 1 ? (lo - 1) / (n - 1) : 1; };
        return {
          bars: src.map((b) => {
            const a = 0.2 + 0.8 * Math.max(0, rank(vol(b)));
            const c = hexA(b.close >= b.open ? up : down, a);
            return { ...ohlc(b), color: c, borderColor: c, wickColor: c };
          }),
          series: 'candles',
          note: 'Lightweight Charts cannot vary candle width; volume is shown as body opacity by volume percentile (IG volume is tick volume).',
        };
      }
      case 'line':
        return { bars: src.map((b) => point(b, b.close)), series: 'line', options: { color: o.color || '#2962ff', lineWidth: 2 } };
      case 'line_markers':
        return { bars: src.map((b) => point(b, b.close)), series: 'line', options: { color: o.color || '#2962ff', lineWidth: 2, pointMarkersVisible: true } };
      case 'step':
        return { bars: src.map((b) => point(b, b.close)), series: 'line', options: { color: o.color || '#2962ff', lineWidth: 2, lineType: 1 } };
      case 'area':
        return { bars: src.map((b) => point(b, b.close)), series: 'area', options: { lineColor: o.color || '#2962ff', topColor: 'rgba(41,98,255,0.35)', bottomColor: 'rgba(41,98,255,0.02)', lineWidth: 2 } };
      case 'hlc_area':
        return {
          bars: src.map((b) => point(b, b.close)), series: 'line', options: { color: o.color || '#2962ff', lineWidth: 2 },
          extra: { high: src.map((b) => point(b, b.high)), low: src.map((b) => point(b, b.low)), upFill: hexA(up, 0.2), downFill: hexA(down, 0.2) },
          note: 'Draw the band: fill high→close with upFill and close→low with downFill.',
        };
      case 'baseline': {
        let mn = Infinity, mx = -Infinity;
        for (const b of src) { if (b.low < mn) mn = b.low; if (b.high > mx) mx = b.high; }
        const base = src.length ? rnd(mn + (mx - mn) * (o.basePct / 100)) : 0;
        return {
          bars: src.map((b) => point(b, b.close)), series: 'baseline',
          options: { baseValue: { type: 'price', price: base }, topLineColor: up, bottomLineColor: down, topFillColor1: hexA(up, 0.28), topFillColor2: hexA(up, 0.05), bottomFillColor1: hexA(down, 0.05), bottomFillColor2: hexA(down, 0.28) },
          meta: { base },
        };
      }
      case 'columns': {
        let mn = Infinity;
        for (const b of src) if (b.close < mn) mn = b.close;
        return {
          bars: src.map((b, i) => ({ time: b.time, value: b.close, color: hexA(dirColor(b, i), 0.7) })),
          series: 'histogram', options: { base: src.length ? mn : 0 },
          note: 'Histogram base is set to the lowest close so columns are visible on a price scale.',
        };
      }
      case 'high_low':
        return {
          bars: src.map((b) => {
            const c = b.close >= b.open ? up : down;
            return { time: b.time, open: b.low, high: b.high, low: b.low, close: b.high, volume: vol(b), color: c, borderColor: c, wickColor: c };
          }),
          series: 'candles', options: { wickVisible: false },
        };
      case 'heikin': {
        const out = [];
        for (let i = 0; i < src.length; i++) {
          const x = src[i];
          const close = (x.open + x.high + x.low + x.close) / 4;
          const open = i ? (out[i - 1].open + out[i - 1].close) / 2 : (x.open + x.close) / 2;
          out.push({ time: x.time, open, high: Math.max(x.high, open, close), low: Math.min(x.low, open, close), close, volume: vol(x) });
        }
        return { bars: out, series: 'candles', options: { upColor: up, downColor: down, borderUpColor: up, borderDownColor: down, wickUpColor: up, wickDownColor: down } };
      }
      case 'renko': {
        const { out, box } = renko(src, o);
        for (const b of out) { b.borderColor = b.color; b.wickColor = b.color; }
        return { bars: out, series: 'candles', priceBased: true, meta: { box }, note: `Renko box ${box}` };
      }
      case 'line_break': {
        const out = lineBreak(src, o);
        for (const b of out) { b.borderColor = b.color; b.wickColor = b.color; }
        return { bars: out, series: 'candles', priceBased: true, options: { wickVisible: false }, meta: { lines: o.lines } };
      }
      case 'kagi': {
        const { pts, rev } = kagi(src, o);
        return {
          bars: pts, series: 'line', priceBased: true, options: { lineType: 1, lineWidth: 2, color: up },
          meta: { reversal: rev, reversalType: o.reversalType },
          note: 'Per-point color marks yang/yin; `width` is a thickness hint (Lightweight Charts lines have one width per series).',
        };
      }
      case 'pnf': {
        const { cols, box, rev } = pnf(src, o);
        const bars2 = cols.map((c) => {
          const lo = rnd(c.lo * box), hi = rnd((c.hi + 1) * box), x = c.x === 'X';
          const color = x ? up : down;
          return { time: c.time, srcTime: c.srcTime, open: x ? lo : hi, close: x ? hi : lo, high: hi, low: lo, volume: c.volume, color, borderColor: color, wickColor: color };
        });
        const columns = cols.map((c) => {
          const boxes = [];
          for (let k = c.lo; k <= c.hi; k++) boxes.push(rnd(k * box));
          return { time: c.time, srcTime: c.srcTime, x: c.x, boxes };
        });
        return { bars: bars2, series: 'candles', priceBased: true, options: { wickVisible: false }, columns, meta: { box, reversal: rev }, note: 'Each box spans [price, price + box]; draw X/O glyphs from `columns` if desired.' };
      }
      case 'range': {
        const size = o.sizeType === 'fixed' && o.size > 0 ? +o.size : renkoBoxFromAtr(src, o.atrLength);
        const out = rangeBars(src, size);
        for (const b of out) { const c = b.close >= b.open ? up : down; b.color = c; b.borderColor = c; b.wickColor = c; }
        return { bars: out, series: 'candles', priceBased: true, meta: { size }, note: 'Range bars approximated from OHLC paths (open→low→high→close on up bars, open→high→low→close on down bars).' };
      }
      case 'volume_footprint':
      case 'tpo':
      case 'session_volume_profile': {
        const overlay = id === 'volume_footprint' ? 'footprint' : id === 'tpo' ? 'tpo' : 'svp';
        return {
          bars: src.map(ohlc), series: 'candles', overlay,
          options: { upColor: up, downColor: down, borderUpColor: up, borderDownColor: down, wickUpColor: up, wickDownColor: down },
          note: 'IG provides tick volume only: footprint/profile volume must be distributed across each bar\'s range by the overlay renderer.',
        };
      }
      default:
        return null;
    }
  }

  window.IGTypes = {
    CHART_TYPES, BY_ID, RES_SEC, defaults, transform,
    parseInterval, label, baseResolution, aggregate, fromTicks, createTickAggregator,
    renkoBoxFromAtr, atrSeries, clean,
  };
})();
