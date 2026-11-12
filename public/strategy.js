/* IG Charts — Strategy Tester + Script Editor (window.IGStrategy).
 * backtest(candles, signals, props) is pure; mount(el, host) builds the UI (host contract: ultimate-spec section C).
 * Script time guard: ctx helpers (series, crossover/crossunder without index, check) abort after 2 s, and the total run
 * time is checked on return. A synchronous user loop that never calls a ctx helper cannot be pre-empted and will freeze
 * the tab — this is a limitation of running scripts on the main thread.
 */
(() => {
  // Loads in the page and inside public/script-worker.js (which aliases window = self); nothing here touches the DOM at load.
  const G = typeof window !== 'undefined' ? window : self;
  const SELF_URL = (typeof document !== 'undefined' && document.currentScript && document.currentScript.src) || '';
  const NA = NaN;
  const ok = Number.isFinite;
  const TIME_LIMIT = 2000;

  // ── TA fallbacks (same semantics as IGInd.ta) ─────────
  function sma(a, n) {
    const out = new Array(a.length).fill(NA);
    let sum = 0, cnt = 0;
    for (let i = 0; i < a.length; i++) {
      if (ok(a[i])) { sum += a[i]; cnt++; }
      if (i >= n && ok(a[i - n])) { sum -= a[i - n]; cnt--; }
      if (i >= n - 1 && cnt === n) out[i] = sum / n;
    }
    return out;
  }
  function smooth(a, n, alpha) {
    const out = new Array(a.length).fill(NA);
    let prev = NA, seen = 0, sum = 0;
    for (let i = 0; i < a.length; i++) {
      const v = a[i];
      if (!ok(v)) continue;
      if (!ok(prev)) { sum += v; seen++; if (seen === n) { prev = sum / n; out[i] = prev; } continue; }
      prev = alpha * v + (1 - alpha) * prev;
      out[i] = prev;
    }
    return out;
  }
  const ema = (a, n) => smooth(a, n, 2 / (n + 1));
  const rma = (a, n) => smooth(a, n, 1 / n);
  function wma(a, n) {
    const out = new Array(a.length).fill(NA), d = (n * (n + 1)) / 2;
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
  const highest = (a, n) => a.map((_, i) => { if (i < n - 1) return NA; let m = -Infinity; for (let k = 0; k < n; k++) m = Math.max(m, a[i - k]); return m; });
  const lowest = (a, n) => a.map((_, i) => { if (i < n - 1) return NA; let m = Infinity; for (let k = 0; k < n; k++) m = Math.min(m, a[i - k]); return m; });
  const atr = (c, n) => rma(c.map((x, i) => (i === 0 ? x.high - x.low : Math.max(x.high - x.low, Math.abs(x.high - c[i - 1].close), Math.abs(x.low - c[i - 1].close)))), n);
  function rsi(a, n) {
    const up = a.map((v, i) => (i === 0 ? NA : Math.max(v - a[i - 1], 0)));
    const dn = a.map((v, i) => (i === 0 ? NA : Math.max(a[i - 1] - v, 0)));
    const ru = rma(up, n), rd = rma(dn, n);
    return ru.map((u, i) => { const d = rd[i]; if (!ok(u) || !ok(d)) return NA; return d === 0 ? 100 : u === 0 ? 0 : 100 - 100 / (1 + u / d); });
  }
  const LOCAL_TA = { sma, ema, rma, wma, stdev, highest, lowest, atr, rsi };

  const isArr = (x) => Array.isArray(x) || ArrayBuffer.isView(x);
  const at = (x, i) => (isArr(x) ? x[i] : x);
  function makeTA(guard) {
    const ig = (G.IGInd && G.IGInd.ta) || {};
    const pick = (k) => (typeof ig[k] === 'function' ? ig[k] : LOCAL_TA[k]);
    const ta = {};
    for (const k of ['sma', 'ema', 'rma', 'wma', 'stdev', 'highest', 'lowest', 'rsi']) ta[k] = pick(k);
    ta.atr = LOCAL_TA.atr;
    const xo = (a, b, i) => { const a0 = at(a, i), b0 = at(b, i), a1 = at(a, i - 1), b1 = at(b, i - 1); return i > 0 && a0 > b0 && a1 <= b1; };
    const xu = (a, b, i) => { const a0 = at(a, i), b0 = at(b, i), a1 = at(a, i - 1), b1 = at(b, i - 1); return i > 0 && a0 < b0 && a1 >= b1; };
    const lenOf = (a, b) => (isArr(a) ? a.length : isArr(b) ? b.length : 0);
    const whole = (f) => (a, b, i) => {
      if (i !== undefined) return f(a, b, i);
      const n = lenOf(a, b), out = new Array(n);
      for (let j = 0; j < n; j++) { if (guard && (j & 1023) === 0) guard(); out[j] = f(a, b, j); }
      return out;
    };
    ta.crossover = whole(xo);
    ta.crossunder = whole(xu);
    ta.cross = whole((a, b, i) => xo(a, b, i) || xu(a, b, i));
    ta.change = (a, len = 1, i) => (i !== undefined ? a[i] - a[i - len] : a.map((v, j) => (j >= len ? v - a[j - len] : NA)));
    ta.nz = (v, d = 0) => (ok(v) ? v : d);
    return ta;
  }

  const edges = (cond) => cond.map((v, i) => !!v && !(i > 0 && cond[i - 1]));
  const falses = (n) => new Array(n).fill(false);
  const col = (c, k) => c.map((x) => x[k]);

  // ── Built-in strategies ───────────────────────────────
  const P = {
    int: (k, label, def, min = 1, max = 1000) => ({ k, label, type: 'int', def, min, max, step: 1 }),
    num: (k, label, def, step = 0.1, min = 0, max) => ({ k, label, type: 'number', def, min, max, step }),
    sel: (k, label, options, def) => ({ k, label, type: 'select', options, def: def || options[0] }),
  };
  const xSeries = (ta, a, b) => ({ long: ta.crossover(a, b), short: ta.crossunder(a, b) });

  function supertrend(c, len, f) {
    const n = c.length, a = atr(c, len), long = falses(n), short = falses(n);
    let trend = 0, fu = NA, fd = NA;
    for (let i = 0; i < n; i++) {
      if (!ok(a[i])) continue;
      const hl = (c[i].high + c[i].low) / 2, up = hl - f * a[i], dn = hl + f * a[i], pc = i > 0 ? c[i - 1].close : c[i].close;
      const nfu = ok(fu) && pc > fu ? Math.max(up, fu) : up;
      const nfd = ok(fd) && pc < fd ? Math.min(dn, fd) : dn;
      let t = trend || 1;
      if (trend === -1 && ok(fd) && c[i].close > fd) t = 1;
      else if (trend === 1 && ok(fu) && c[i].close < fu) t = -1;
      if (trend && t !== trend) (t === 1 ? long : short)[i] = true;
      trend = t; fu = nfu; fd = nfd;
    }
    return { long, short };
  }
  function psar(c, start, inc, max) {
    const n = c.length, long = falses(n), short = falses(n);
    if (n < 2) return { long, short };
    let up = c[1].close >= c[0].close, af = start, ep = up ? c[0].high : c[0].low, sar = up ? c[0].low : c[0].high;
    for (let i = 1; i < n; i++) {
      const x = c[i];
      sar += af * (ep - sar);
      if (up) {
        sar = Math.min(sar, c[i - 1].low, c[Math.max(0, i - 2)].low);
        if (x.low < sar) { up = false; sar = ep; ep = x.low; af = start; short[i] = true; }
        else if (x.high > ep) { ep = x.high; af = Math.min(af + inc, max); }
      } else {
        sar = Math.max(sar, c[i - 1].high, c[Math.max(0, i - 2)].high);
        if (x.high > sar) { up = true; sar = ep; ep = x.high; af = start; long[i] = true; }
        else if (x.low < ep) { ep = x.low; af = Math.min(af + inc, max); }
      }
    }
    return { long, short };
  }
  const prev = (a) => a.map((_, i) => (i > 0 ? a[i - 1] : NA));

  let aiCache = { key: '', list: [] };
  const STRATEGIES = [
    { id: 'ma_cross', name: 'MA Cross', params: [P.sel('maType', 'MA type', ['SMA', 'EMA']), P.int('fast', 'Fast length', 9), P.int('slow', 'Slow length', 21)],
      signals: (c, p, ta) => { const cl = col(c, 'close'), f = p.maType === 'EMA' ? ta.ema : ta.sma; return xSeries(ta, f(cl, p.fast), f(cl, p.slow)); } },
    { id: 'rsi_rev', name: 'RSI Overbought/Oversold', params: [P.int('length', 'RSI length', 14), P.num('os', 'Oversold', 30, 1), P.num('ob', 'Overbought', 70, 1)],
      signals: (c, p, ta) => { const r = ta.rsi(col(c, 'close'), p.length); return { long: ta.crossover(r, p.os), short: ta.crossunder(r, p.ob) }; } },
    { id: 'bb', name: 'Bollinger Bands', params: [P.sel('mode', 'Mode', ['Breakout', 'Mean reversion']), P.int('length', 'Length', 20), P.num('mult', 'StdDev', 2)],
      signals: (c, p, ta) => {
        const cl = col(c, 'close'), m = ta.sma(cl, p.length), d = ta.stdev(cl, p.length);
        const up = m.map((v, i) => v + p.mult * d[i]), lo = m.map((v, i) => v - p.mult * d[i]);
        if (p.mode === 'Breakout') return { long: ta.crossover(cl, up), short: ta.crossunder(cl, lo) };
        return { long: ta.crossover(cl, lo), short: ta.crossunder(cl, up), exitLong: ta.crossover(cl, m), exitShort: ta.crossunder(cl, m) };
      } },
    { id: 'macd', name: 'MACD Signal Cross', params: [P.int('fast', 'Fast length', 12), P.int('slow', 'Slow length', 26), P.int('signal', 'Signal length', 9)],
      signals: (c, p, ta) => { const cl = col(c, 'close'), f = ta.ema(cl, p.fast), s = ta.ema(cl, p.slow), m = f.map((v, i) => v - s[i]); return xSeries(ta, m, ta.ema(m, p.signal)); } },
    { id: 'supertrend', name: 'Supertrend Flip', params: [P.int('length', 'ATR length', 10), P.num('factor', 'Factor', 3)],
      signals: (c, p) => supertrend(c, p.length, p.factor) },
    { id: 'turtle', name: 'Donchian / Turtle Breakout', params: [P.int('entry', 'Entry length', 20), P.int('exit', 'Exit length', 10)],
      signals: (c, p, ta) => {
        const h = col(c, 'high'), l = col(c, 'low'), eh = prev(ta.highest(h, p.entry)), el = prev(ta.lowest(l, p.entry)), xh = prev(ta.highest(h, p.exit)), xl = prev(ta.lowest(l, p.exit));
        return { long: c.map((x, i) => x.high > eh[i]), short: c.map((x, i) => x.low < el[i]), exitLong: c.map((x, i) => x.low < xl[i]), exitShort: c.map((x, i) => x.high > xh[i]) };
      } },
    { id: 'channel', name: 'Channel Breakout', params: [P.int('length', 'Length', 20)],
      signals: (c, p, ta) => { const hh = prev(ta.highest(col(c, 'high'), p.length)), ll = prev(ta.lowest(col(c, 'low'), p.length)); return { long: edges(c.map((x, i) => x.close > hh[i])), short: edges(c.map((x, i) => x.close < ll[i])) }; } },
    { id: 'inside_bar', name: 'Inside Bar Breakout', params: [P.int('hold', 'Exit after bars (0 = off)', 0, 0)],
      signals: (c, p) => {
        const n = c.length, long = falses(n), short = falses(n), exitLong = falses(n), exitShort = falses(n);
        for (let i = 2; i < n; i++) {
          const m = c[i - 2], ib = c[i - 1];
          if (!(ib.high < m.high && ib.low > m.low)) continue;
          if (c[i].close > m.high) long[i] = true; else if (c[i].close < m.low) short[i] = true;
          if (p.hold > 0 && i + p.hold < n) { if (long[i]) exitLong[i + p.hold] = true; if (short[i]) exitShort[i + p.hold] = true; }
        }
        return { long, short, exitLong, exitShort };
      } },
    { id: 'momentum', name: 'Momentum', params: [P.int('length', 'Length', 12)],
      signals: (c, p) => {
        const cl = col(c, 'close'), mom = cl.map((v, i) => (i >= p.length ? v - cl[i - p.length] : NA)), m1 = mom.map((v, i) => (i > 0 ? v - mom[i - 1] : NA));
        return { long: edges(mom.map((v, i) => v > 0 && m1[i] > 0)), short: edges(mom.map((v, i) => v < 0 && m1[i] < 0)) };
      } },
    { id: 'psar', name: 'Parabolic SAR Flip', params: [P.num('start', 'Start', 0.02, 0.01), P.num('inc', 'Increment', 0.02, 0.01), P.num('max', 'Maximum', 0.2, 0.01)],
      signals: (c, p) => psar(c, p.start, p.inc, p.max) },
    { id: 'keltner', name: 'Keltner Breakout', params: [P.int('length', 'Length', 20), P.num('mult', 'Multiplier', 2), P.int('atrLength', 'ATR length', 10)],
      signals: (c, p, ta) => { const cl = col(c, 'close'), m = ta.ema(cl, p.length), a = ta.atr(c, p.atrLength); return { long: ta.crossover(cl, m.map((v, i) => v + p.mult * a[i])), short: ta.crossunder(cl, m.map((v, i) => v - p.mult * a[i])) }; } },
    { id: 'ai_chance', name: 'AI Chance signals', params: [P.int('hold', 'Exit after bars (0 = off)', 0, 0)],
      signals: (c, p, ta, env) => {
        const n = c.length, long = falses(n), short = falses(n), exitLong = falses(n), exitShort = falses(n);
        const host = env && env.host, key = n ? `${n}:${c[0].time}:${c[n - 1].time}:${c[n - 1].close}` : '';
        let list = host && host.aiChance ? host.aiChance(c) : [];
        if (list && typeof list.then === 'function') {
          list.then((r) => { aiCache = { key, list: r || [] }; if (env.rerun) env.rerun(); }, () => {});
          list = aiCache.key === key ? aiCache.list : [];
        }
        const idx = new Map(c.map((x, i) => [x.time, i]));
        for (const s of list || []) {
          let i = idx.get(s.time);
          if (i === undefined) { let lo = 0, hi = n - 1; i = -1; while (lo <= hi) { const m = (lo + hi) >> 1; if (c[m].time <= s.time) { i = m; lo = m + 1; } else hi = m - 1; } }
          if (i < 0) continue;
          const sig = String(s.signal || '').toUpperCase();
          if (sig.includes('BUY')) { long[i] = true; if (p.hold > 0 && i + p.hold < n) exitLong[i + p.hold] = true; }
          else if (sig.includes('SELL')) { short[i] = true; if (p.hold > 0 && i + p.hold < n) exitShort[i + p.hold] = true; }
        }
        return { long, short, exitLong, exitShort };
      } },
  ];

  // ── Backtest engine ───────────────────────────────────
  const DEFAULT_PROPS = {
    capital: 10000, sizeType: 'percent', size: 100, pyramiding: 1, commType: 'percent', commission: 0, slippage: 0,
    fill: 'open', direction: 'both', reverse: true, slType: 'none', sl: 2, tpType: 'none', tp: 4, atrLen: 14, from: 0, to: 0, tfSec: 0,
    magnifier: false, marginLong: 0, marginShort: 0, maxIntradayLossType: 'percent', maxIntradayLoss: 0, maxDDStop: 0, maxConsLossDays: 0,
  };
  const YEAR = 365 * 86400;
  const DAY = 86400;
  const fin = (v) => (ok(v) ? v : null);
  const RISK_RULE = { intraday: 'Max intraday loss', dd: 'Max drawdown stop', days: 'Max consecutive losing days' };

  function testedRange(candles, from, to) {
    const n = candles.length;
    let i0 = 0, i1 = n - 1;
    if (from > 0) while (i0 < n && candles[i0].time < from) i0++;
    if (to > 0) while (i1 >= 0 && candles[i1].time > to) i1--;
    return { i0, i1 };
  }

  // Lower-timeframe bars → [lo, hi) slice per chart bar (two-pointer, O(n + m)). A chart bar is covered only when the
  // sub-bars start at or before its open, so a partially fetched first bar keeps the heuristic.
  function mapSubBars(candles, sub, tfSec) {
    const n = candles.length, m = sub.length, lo = new Int32Array(n), hi = new Int32Array(n);
    let j = 0;
    const first = m ? sub[0].time : Infinity;
    for (let i = 0; i < n; i++) {
      const t = candles[i].time, next = i + 1 < n ? candles[i + 1].time : tfSec > 0 ? t + tfSec : Infinity;
      while (j < m && sub[j].time < t) j++;
      lo[i] = j;
      while (j < m && sub[j].time < next) j++;
      hi[i] = t >= first ? j : lo[i];
    }
    return { lo, hi };
  }

  function backtest(candles, sig, props, opts) {
    const p = { ...DEFAULT_PROPS, ...props };
    const n = candles.length;
    const { i0, i1 } = testedRange(candles, p.from, p.to);
    const L = sig.long || [], S = sig.short || [], XL = sig.exitLong || [], XS = sig.exitShort || [], ST = sig.stop, LM = sig.limit;
    // "orders" mode: explicit fills from a broker emulator (Pine strategies) replace the signal → order logic
    const OR = Array.isArray(sig.orders) ? new Map() : null;
    if (OR) for (const f of sig.orders) { if (!OR.has(f.i)) OR.set(f.i, []); OR.get(f.i).push(f); }
    const allowL = p.direction !== 'short', allowS = p.direction !== 'long';
    const pctComm = p.commType !== 'cash', comm = +p.commission || 0, slip = +p.slippage || 0, cap = +p.capital || 0;
    const pyr = Math.max(1, p.pyramiding | 0);
    const needAtr = (p.slType === 'atr' && p.sl > 0) || (p.tpType === 'atr' && p.tp > 0);
    const A = needAtr ? atr(candles, p.atrLen || 14) : null;
    const pos = [], trades = [], equity = [], buyHold = [];
    let realized = 0, openComm = 0, commPaid = 0, nextId = 1, pending = null, peak = cap, trough = cap, maxDD = 0, maxDDPct = 0, maxRU = 0, maxRUPct = 0;
    const fee = (px, q) => (pctComm ? px * q * comm / 100 : comm);
    const unreal = (px) => { let u = 0; for (const e of pos) u += e.dir * (px - e.entryPrice) * e.qty; return u; };
    const equityAt = (px) => cap + realized + unreal(px) - openComm;

    // magnifier
    const sub = p.magnifier && opts && Array.isArray(opts.sub) && opts.sub.length ? opts.sub : null;
    const SM = sub ? mapSubBars(candles, sub, p.tfSec) : null;
    let magBars = 0, magFallback = 0, magCovered = 0;
    if (SM) for (let i = i0; i <= i1; i++) if (SM.hi[i] > SM.lo[i]) magCovered++;

    // risk rules
    const mL = +p.marginLong || 0, mS = +p.marginShort || 0;
    const ilv = +p.maxIntradayLoss || 0, ddStop = +p.maxDDStop || 0, maxLossDays = Math.max(0, +p.maxConsLossDays | 0);
    const riskOn = ilv > 0 || ddStop > 0 || maxLossDays > 0;
    const risk = { halted: null, events: [], blockedEntries: 0, marginRejected: 0, marginLimited: 0 };
    let blockDay = NaN, curDay = NaN, dayStartEq = cap, lastEq = cap, lossDays = 0;
    const canEnter = (i) => !risk.halted && Math.floor(candles[i].time / DAY) !== blockDay;

    function exit(e, i, px, reason, mag) {
      const f = fee(px, e.qty), move = e.dir * (px - e.entryPrice) * e.qty;
      commPaid += f; openComm -= e.comm;
      const pnl = move - e.comm - f;
      realized += pnl;
      trades.push({
        id: e.id, dir: e.dir > 0 ? 'long' : 'short', entryTime: e.entryTime, entryPrice: e.entryPrice, entryIdx: e.entryIdx, entrySignal: e.signal,
        exitTime: candles[i].time, exitPrice: px, exitIdx: i, qty: e.qty, pnl, pnlPct: (pnl / (e.entryPrice * e.qty)) * 100,
        runup: Math.max(e.runup, move), drawdown: Math.max(e.dd, -move), bars: i - e.entryIdx, exitReason: reason, commission: e.comm + f, magnified: !!mag,
      });
    }
    function closeDir(dir, i, px, reason) {
      const keep = [];
      for (const e of pos) if (e.dir === dir) exit(e, i, px - dir * slip, reason); else keep.push(e);
      pos.length = 0; pos.push(...keep);
    }
    function flatten(i, px, reason) { closeDir(1, i, px, reason); closeDir(-1, i, px, reason); pending = null; }
    function enter(dir, i, px, si, o) {
      if (riskOn && !canEnter(i)) { risk.blockedEntries++; return; }
      const fill = px + dir * (o && o.slip === false ? 0 : slip);
      const eq = equityAt(fill);
      let qty = o && o.qty > 0 ? o.qty : p.sizeType === 'qty' ? +p.size : p.sizeType === 'cash' ? p.size / fill : (eq * p.size) / 100 / fill;
      if (!(qty > 0) || !ok(qty)) return;
      const mr = dir > 0 ? mL : mS;
      if (mr > 0) {
        let used = 0;
        for (const e of pos) used += e.qty * e.entryPrice * ((e.dir > 0 ? mL : mS) / 100);
        let maxQ = (eq - used) / (fill * mr / 100);
        if (p.sizeType === 'qty' && Number.isInteger(+p.size)) maxQ = Math.floor(maxQ + 1e-9);
        if (!(maxQ > 0)) { risk.marginRejected++; return; }
        if (qty > maxQ) { qty = maxQ; risk.marginLimited++; }
      }
      const f = fee(fill, qty); commPaid += f; openComm += f;
      const a = A ? A[si] : NA;
      const lvl = (type, v, sgn) => (!(v > 0) ? NA : type === 'percent' ? fill * (1 + (sgn * v) / 100) : type === 'atr' && ok(a) ? fill + sgn * a * v : NA);
      pos.push({ id: nextId++, key: o && o.key, dir, entryIdx: i, entryTime: candles[i].time, entryPrice: fill, qty, comm: f, stop: o ? NA : lvl(p.slType, p.sl, -dir), tp: o ? NA : lvl(p.tpType, p.tp, dir), runup: 0, dd: 0, signal: o && o.signal ? o.signal : dir > 0 ? 'Long' : 'Short' });
    }
    function act(a, i, px, si) {
      const cur = pos.length ? pos[0].dir : 0;
      if (a.xl && cur > 0) closeDir(1, i, px, 'Exit long');
      if (a.xs && cur < 0) closeDir(-1, i, px, 'Exit short');
      const d = a.l ? 1 : a.s ? -1 : 0;
      if (!d) return;
      if (pos.length && pos[0].dir === -d) { closeDir(-d, i, px, p.reverse ? 'Reverse' : 'Opposite signal'); if (!p.reverse) return; }
      if (pos.length < pyr) enter(d, i, px, si);
    }
    const track = (e, hi, lo) => {
      if (e.dir > 0) { e.runup = Math.max(e.runup, (hi - e.entryPrice) * e.qty); e.dd = Math.max(e.dd, (e.entryPrice - lo) * e.qty); }
      else { e.runup = Math.max(e.runup, (e.entryPrice - lo) * e.qty); e.dd = Math.max(e.dd, (hi - e.entryPrice) * e.qty); }
    };
    // One bar (or sub-bar) where the stop and/or target is touched. A gap through a level fills at the open; when both
    // are inside the range, the path is open → nearer extreme → farther extreme (TradingView's broker-emulator rule;
    // equal distances resolve to the stop).
    function resolve(e, x, s, t, hitS, hitT) {
      const lg = e.dir > 0, o = x.open;
      const stopPx = () => (lg ? (o <= s ? o : s) - slip : (o >= s ? o : s) + slip);
      const tpPx = () => (lg ? (o >= t ? o : t) : (o <= t ? o : t));
      if (hitS && hitT) {
        const gapS = lg ? o <= s : o >= s, gapT = lg ? o >= t : o <= t;
        let stopFirst;
        if (gapS || gapT) stopFirst = gapS;
        else { const highFirst = x.high - o < o - x.low; stopFirst = lg ? !highFirst : highFirst; }
        return stopFirst ? { px: stopPx(), why: 'Stop loss' } : { px: tpPx(), why: 'Take profit' };
      }
      return hitS ? { px: stopPx(), why: 'Stop loss' } : { px: tpPx(), why: 'Take profit' };
    }
    function applyOrder(f, i) {
      if (f.kind === 'entry') { enter(f.dir, i, f.px, i, { qty: f.qty, key: f.key, slip: f.slip !== false, signal: f.comment ? `${f.id} · ${f.comment}` : f.id || (f.dir > 0 ? 'Long' : 'Short') }); return; }
      const k = pos.findIndex((e) => e.key === f.key);
      if (k < 0) return;
      const e = pos[k], px = f.slip ? f.px - e.dir * slip : f.px;
      if (f.qty > 0 && f.qty < e.qty - 1e-9) {
        const part = { ...e, id: nextId++, qty: f.qty, comm: e.comm * (f.qty / e.qty) };
        e.qty -= part.qty; e.comm -= part.comm;
        exit(part, i, px, f.reason || 'Exit');
        return;
      }
      exit(e, i, px, f.reason || 'Exit');
      pos.splice(k, 1);
    }
    function intrabar(i) {
      const c = candles[i], so = ST && i > 0 && ok(ST[i - 1]) ? ST[i - 1] : NA, lo = LM && i > 0 && ok(LM[i - 1]) ? LM[i - 1] : NA;
      for (let k = 0; k < pos.length; k++) {
        const e = pos[k], s = ok(so) ? so : e.stop, t = ok(lo) ? lo : e.tp, lg = e.dir > 0;
        const hitS = ok(s) && (lg ? c.low <= s : c.high >= s), hitT = ok(t) && (lg ? c.high >= t : c.low <= t);
        if (!hitS && !hitT) { track(e, c.high, c.low); continue; }
        let r = null;
        if (SM && SM.hi[i] > SM.lo[i]) {
          for (let j = SM.lo[i]; j < SM.hi[i]; j++) {
            const x = sub[j], hs = ok(s) && (lg ? x.low <= s : x.high >= s), ht = ok(t) && (lg ? x.high >= t : x.low <= t);
            if (hs || ht) { r = resolve(e, x, s, t, hs, ht); r.mag = true; break; }
            track(e, x.high, x.low);
          }
          if (r) magBars++; else magFallback++;
        }
        if (!r) r = resolve(e, c, s, t, hitS, hitT);
        exit(e, i, r.px, r.why, r.mag); pos.splice(k--, 1);
      }
    }
    function dayRoll(i) {
      const d = Math.floor(candles[i].time / DAY);
      if (d === curDay) return;
      if (ok(curDay)) { const pnl = lastEq - dayStartEq; lossDays = pnl < 0 ? lossDays + 1 : 0; }
      curDay = d; dayStartEq = lastEq;
      if (maxLossDays > 0 && lossDays >= maxLossDays && !risk.halted) {
        risk.halted = { rule: RISK_RULE.days, time: candles[i].time, idx: i, detail: `${lossDays} consecutive losing days` };
        risk.events.push(risk.halted);
        flatten(i, candles[i].open, RISK_RULE.days);
      }
    }
    function riskCheck(i) {
      if (risk.halted) return;
      const c = candles[i], eq = equityAt(c.close), d = Math.floor(c.time / DAY);
      if (ilv > 0 && d !== blockDay) {
        const lim = p.maxIntradayLossType === 'cash' ? ilv : (dayStartEq * ilv) / 100;
        if (dayStartEq - eq >= lim) {
          blockDay = d;
          risk.events.push({ rule: RISK_RULE.intraday, time: c.time, idx: i, detail: `day loss ${(dayStartEq - eq).toFixed(2)} ≥ ${lim.toFixed(2)}` });
          flatten(i, c.close, RISK_RULE.intraday);
          return;
        }
      }
      if (ddStop > 0) {
        const pk = Math.max(peak, eq), ddp = pk > 0 ? ((pk - eq) / pk) * 100 : 0;
        if (ddp >= ddStop) {
          risk.halted = { rule: RISK_RULE.dd, time: c.time, idx: i, detail: `drawdown ${ddp.toFixed(2)}% ≥ ${ddStop}%` };
          risk.events.push(risk.halted);
          flatten(i, c.close, RISK_RULE.dd);
        }
      }
    }

    const bh0 = i0 <= i1 ? candles[i0].close : NA, bhQty = cap / bh0;
    for (let i = i0; i <= i1; i++) {
      const c = candles[i];
      if (riskOn) dayRoll(i);
      if (OR) {
        const list = OR.get(i);
        if (list) for (const f of list) applyOrder(f, i);
        for (const e of pos) track(e, c.high, c.low);
        if (riskOn) riskCheck(i);
      } else {
        if (pending) { act(pending.a, i, c.open, pending.si); pending = null; }
        if (pos.length) intrabar(i);
        if (riskOn) riskCheck(i);
        let l = !!L[i], s = !!S[i];
        if (l && s) l = s = false;
        const a = { l: l && allowL, s: s && allowS, xl: !!XL[i] || (s && !allowS), xs: !!XS[i] || (l && !allowL) };
        if (a.l || a.s || a.xl || a.xs) { if (p.fill === 'close') act(a, i, c.close, i); else pending = { a, si: i }; }
      }
      const eq = equityAt(c.close);
      lastEq = eq;
      if (eq > peak) peak = eq;
      if (eq < trough) trough = eq;
      const dd = peak - eq, ddPct = peak > 0 ? (dd / peak) * 100 : 0, ru = eq - trough;
      if (dd > maxDD) maxDD = dd;
      if (ddPct > maxDDPct) maxDDPct = ddPct;
      if (ru > maxRU) { maxRU = ru; maxRUPct = trough > 0 ? (ru / trough) * 100 : 0; }
      equity.push({ time: c.time, equity: eq, drawdown: dd, drawdownPct: ddPct });
      buyHold.push({ time: c.time, equity: cap + (c.close - bh0) * bhQty });
    }

    const last = i1 >= i0 ? candles[i1] : null;
    const openTrades = last ? pos.map((e) => {
      const move = e.dir * (last.close - e.entryPrice) * e.qty, pnl = move - e.comm;
      return { id: e.id, dir: e.dir > 0 ? 'long' : 'short', entryTime: e.entryTime, entryPrice: e.entryPrice, entryIdx: e.entryIdx, entrySignal: e.signal, exitTime: null, exitPrice: last.close, exitIdx: i1, qty: e.qty, pnl, pnlPct: (pnl / (e.entryPrice * e.qty)) * 100, runup: Math.max(e.runup, move), drawdown: Math.max(e.dd, -move), bars: i1 - e.entryIdx, exitReason: 'Open', commission: e.comm, magnified: false };
    }) : [];
    const openPnl = openTrades.reduce((s, t) => s + t.pnl, 0);

    const span = equity.length > 1 ? equity[equity.length - 1].time - equity[0].time : 0;
    const barsPerYear = span > 0 ? ((equity.length - 1) * YEAR) / span : p.tfSec > 0 ? YEAR / p.tfSec : 0;
    let sharpe = null, sortino = null;
    if (equity.length > 2 && barsPerYear > 0) {
      let sum = 0, cnt = 0;
      for (let k = 1; k < equity.length; k++) { const a = equity[k - 1].equity; if (a > 0) { sum += equity[k].equity / a - 1; cnt++; } }
      if (cnt > 1) {
        const mean = sum / cnt;
        let v = 0, dv = 0;
        for (let k = 1; k < equity.length; k++) { const a = equity[k - 1].equity; if (a > 0) { const r = equity[k].equity / a - 1; v += (r - mean) ** 2; if (r < 0) dv += r * r; } }
        const sd = Math.sqrt(v / (cnt - 1)), dsd = Math.sqrt(dv / cnt), k = Math.sqrt(barsPerYear);
        sharpe = sd > 0 ? (mean / sd) * k : null;
        sortino = dsd > 0 ? (mean / dsd) * k : null;
      }
    }
    const endEq = equity.length ? equity[equity.length - 1].equity : cap;
    const cagr = span >= 86400 && cap > 0 && endEq > 0 ? ((endEq / cap) ** (YEAR / span) - 1) * 100 : null;
    const bhRet = last ? (last.close / bh0 - 1) * 100 : 0;

    const all = stats(trades, cap, null), long = stats(trades, cap, 'long'), short = stats(trades, cap, 'short');
    Object.assign(all, { maxDrawdown: maxDD, maxDrawdownPct: maxDDPct, maxRunup: maxRU, maxRunupPct: maxRUPct, sharpe: fin(sharpe), sortino: fin(sortino), cagr: fin(cagr), buyHoldReturn: fin(bhRet), buyHoldProfit: fin((bhRet / 100) * cap), openPnl, commissionTotal: commPaid, finalEquity: endEq });
    long.openPnl = openTrades.filter((t) => t.dir === 'long').reduce((s, t) => s + t.pnl, 0);
    short.openPnl = openTrades.filter((t) => t.dir === 'short').reduce((s, t) => s + t.pnl, 0);
    const magnifier = SM ? { subBars: sub.length, coveredBars: magCovered, magnifiedBars: magBars, fallbackBars: magFallback } : null;
    return { trades, openTrades, equity, buyHold, metrics: { all, long, short }, props: p, range: { from: i0, to: i1, bars: Math.max(0, i1 - i0 + 1) }, magnifier, risk };
  }

  function stats(all, cap, dir) {
    const tr = dir ? all.filter((t) => t.dir === dir) : all;
    let gp = 0, gl = 0, w = 0, l = 0, bars = 0, bw = 0, bl = 0, big = 0, small = 0, bigP = 0, smallP = 0, pctSum = 0, comm = 0;
    let cum = 0, pk = 0, tr0 = 0, dd = 0, ru = 0;
    for (const t of tr) {
      bars += t.bars; pctSum += t.pnlPct; comm += t.commission;
      if (t.pnl > 0) { gp += t.pnl; w++; bw += t.bars; if (t.pnl > big) { big = t.pnl; bigP = t.pnlPct; } }
      else if (t.pnl < 0) { gl -= t.pnl; l++; bl += t.bars; if (t.pnl < small) { small = t.pnl; smallP = t.pnlPct; } }
      cum += t.pnl;
      pk = Math.max(pk, cum); tr0 = Math.min(tr0, cum);
      dd = Math.max(dd, pk - cum); ru = Math.max(ru, cum - tr0);
    }
    const N = tr.length, net = gp - gl, avgW = w ? gp / w : null, avgL = l ? -gl / l : null;
    return {
      netProfit: net, netProfitPct: cap ? (net / cap) * 100 : 0, grossProfit: gp, grossLoss: gl,
      profitFactor: gl > 0 ? gp / gl : null, totalTrades: N, winningTrades: w, losingTrades: l, evenTrades: N - w - l,
      winRate: N ? (w / N) * 100 : 0, avgTrade: N ? net / N : null, avgTradePct: N ? pctSum / N : null,
      avgWin: avgW, avgLoss: avgL, ratioAvgWinLoss: avgW !== null && avgL ? avgW / -avgL : null,
      largestWin: w ? big : null, largestWinPct: w ? bigP : null, largestLoss: l ? small : null, largestLossPct: l ? smallP : null,
      avgBars: N ? bars / N : null, avgBarsWin: w ? bw / w : null, avgBarsLoss: l ? bl / l : null,
      maxDrawdown: dd, maxDrawdownPct: cap ? (dd / cap) * 100 : 0, maxRunup: ru, maxRunupPct: cap ? (ru / cap) * 100 : 0,
      commissionPaid: comm, sharpe: null, sortino: null, cagr: null, buyHoldReturn: null,
    };
  }


  // ── Bar magnifier data (host.fetchBars boundary) ──
  const MAG_MAX = 5000;
  const tfLabel = (a) => {
    const s = (a && a.tfSec) || 0;
    if (!s) return (a && a.tf) || '';
    if (s % 604800 === 0) return `${s / 604800}W`;
    if (s % 86400 === 0) return `${s / 86400}D`;
    if (s % 3600 === 0) return `${s / 3600}h`;
    return s % 60 === 0 ? `${s / 60}m` : `${s}s`;
  };
  // 1-minute sub-bars for intraday charts, 60-minute for daily and above; the request is capped at MAG_MAX bars and,
  // because host.fetchBars returns the most recent bars, a longer range is magnified only for its most recent part.
  function magnifierPlan(a, props) {
    const c = a && a.candles;
    if (!c || !c.length) return null;
    const tf = a.tfSec || 0, subSec = tf >= 86400 ? 3600 : 60, { i0, i1 } = testedRange(c, props.from, props.to);
    if (i1 < i0) return null;
    const need = Math.max(1, Math.ceil((c[i1].time + (tf || subSec) - c[i0].time) / subSec));
    return { subSec, interval: subSec === 60 ? '1' : '60', label: subSec === 60 ? '1m' : '1h', need, max: Math.min(MAG_MAX, need), applicable: tf > subSec, key: `${a.epic}|${subSec}|${c[i0].time}|${c[i1].time}` };
  }
  const BAR_CACHE = new Map();
  function cacheBars(key, rec) { BAR_CACHE.delete(key); BAR_CACHE.set(key, rec); while (BAR_CACHE.size > 8) BAR_CACHE.delete(BAR_CACHE.keys().next().value); }
  // Parse fetched bars once: finite OHLC only, seconds (ms timestamps are converted), ascending, unique times.
  function normalizeBars(raw) {
    const out = [];
    for (const b of Array.isArray(raw) ? raw : []) {
      if (!b) continue;
      let t = +b.time;
      const o = +b.open, h = +b.high, l = +b.low, c = +b.close;
      if (![t, o, h, l, c].every(ok)) continue;
      if (t > 1e11) t = Math.floor(t / 1000);
      out.push({ time: t, open: o, high: Math.max(h, o, c), low: Math.min(l, o, c), close: c, volume: ok(+b.volume) ? +b.volume : 0 });
    }
    out.sort((a, b) => a.time - b.time);
    return out.filter((b, i) => i === 0 || b.time !== out[i - 1].time);
  }

  // ── Optimizer (pure; the UI drives step() in idle slices) ──
  const OPT_HARD_CAP = 5000;
  const OPT_METRICS = [
    { k: 'netProfit', l: 'Net profit', f: (m) => m.netProfit },
    { k: 'profitFactor', l: 'Profit factor', f: (m) => m.profitFactor },
    { k: 'sharpe', l: 'Sharpe ratio', f: (m) => m.sharpe },
    { k: 'sortino', l: 'Sortino ratio', f: (m) => m.sortino },
    { k: 'winRate', l: 'Win rate', f: (m) => m.winRate },
    { k: 'maxDrawdown', l: 'Max drawdown (minimise)', f: (m) => -m.maxDrawdownPct },
    { k: 'npdd', l: 'Net profit / max DD', f: (m) => (m.maxDrawdown > 0 ? m.netProfit / m.maxDrawdown : null) },
  ];
  // Higher is better; null when the combination produced no closed trades or the metric is undefined.
  function optScore(metric, m) {
    if (!m || !m.totalTrades) return null;
    const d = OPT_METRICS.find((x) => x.k === metric) || OPT_METRICS[0], v = d.f(m);
    return ok(v) ? v : null;
  }
  // ranges: [{ k, scope: 'input'|'prop', from, to, step, int? }] → axes of values; combos enumerate with the last axis fastest.
  function optGrid(ranges, maxComb = 500) {
    const max = Math.min(OPT_HARD_CAP, Math.max(1, maxComb | 0));
    if (!ranges || !ranges.length) return { error: 'Select at least one parameter to vary.' };
    const axes = [];
    for (const r of ranges) {
      const from = +r.from, to = +r.to, step = +r.step;
      if (!ok(from) || !ok(to) || !ok(step)) return { error: `${r.label || r.k}: from, to and step must be numbers.` };
      if (step <= 0) return { error: `${r.label || r.k}: step must be > 0.` };
      if (to < from) return { error: `${r.label || r.k}: "to" is below "from".` };
      const cnt = Math.floor((to - from) / step + 1e-9) + 1;
      if (cnt > OPT_HARD_CAP) return { error: `${r.label || r.k}: ${cnt} values exceed the ${OPT_HARD_CAP} hard cap.` };
      const vals = [];
      for (let q = 0; q < cnt; q++) { const v = from + q * step; vals.push(r.int ? Math.round(v) : +v.toFixed(10)); }
      axes.push({ ...r, values: [...new Set(vals)] });
    }
    const total = axes.reduce((s, a) => s * a.values.length, 1);
    if (total > max) return { error: `${total.toLocaleString('en-US')} combinations exceed the maximum of ${max.toLocaleString('en-US')} — widen the steps or raise the maximum (hard cap ${OPT_HARD_CAP}).`, total, axes };
    return { axes, total };
  }
  const OPT_KEEP = ['netProfit', 'netProfitPct', 'totalTrades', 'winRate', 'profitFactor', 'maxDrawdown', 'maxDrawdownPct', 'sharpe', 'sortino'];
  const pickM = (m) => Object.fromEntries(OPT_KEEP.map((k) => [k, m[k]]));
  const rankCmp = (a, b) => (a.score === null ? (b.score === null ? a.idx - b.idx : 1) : b.score === null ? -1 : b.score - a.score || a.idx - b.idx);

  // cfg: { candles, strategy, params, props, ranges, metric, max, walkForward, isPct, ta, env, sub }
  function createOptimizer(cfg) {
    const grid = optGrid(cfg.ranges, cfg.max);
    if (grid.error) return { error: grid.error, total: grid.total || 0 };
    const { axes, total } = grid, C = cfg.candles, ta = cfg.ta || makeTA(), opts = cfg.sub ? { sub: cfg.sub } : undefined;
    const baseProps = { ...DEFAULT_PROPS, ...cfg.props };
    let wf = null;
    if (cfg.walkForward) {
      const { i0, i1 } = testedRange(C, baseProps.from, baseProps.to), len = i1 - i0 + 1, isPct = Math.min(95, Math.max(5, +cfg.isPct || 70));
      const split = i0 + Math.round((len * isPct) / 100);
      if (len < 4 || split - i0 < 2 || i1 - split + 1 < 2) return { error: 'Walk-forward needs at least 2 in-sample and 2 out-of-sample bars.', total };
      wf = { isPct, is: { from: C[i0].time, to: C[split - 1].time }, oos: { from: C[split].time, to: C[i1].time }, splitTime: C[split].time };
    }
    const inAxes = axes.map((a, j) => (a.scope === 'input' ? j : -1)).filter((j) => j >= 0);
    const results = [];
    let idx = 0, lastKey = null, lastSig = null, error = null;
    const q = new Array(axes.length).fill(0);
    function one() {
      const params = { ...cfg.params }, props = { ...baseProps }, values = axes.map((a, j) => a.values[q[j]]);
      axes.forEach((a, j) => { (a.scope === 'input' ? params : props)[a.k] = values[j]; });
      const key = inAxes.map((j) => values[j]).join('|');
      if (key !== lastKey) { lastSig = cfg.strategy.signals(C, params, ta, cfg.env || {}); lastKey = key; }
      const r = { idx, q: q.slice(), values, score: null, m: null, oos: null, mo: null };
      if (wf) {
        const a = backtest(C, lastSig, { ...props, ...wf.is }, opts), b = backtest(C, lastSig, { ...props, ...wf.oos }, opts);
        r.m = pickM(a.metrics.all); r.mo = pickM(b.metrics.all); r.score = optScore(cfg.metric, a.metrics.all); r.oos = optScore(cfg.metric, b.metrics.all);
      } else {
        const a = backtest(C, lastSig, props, opts);
        r.m = pickM(a.metrics.all); r.score = optScore(cfg.metric, a.metrics.all);
      }
      results.push(r);
      idx++;
      for (let j = axes.length - 1; j >= 0; j--) { if (++q[j] < axes[j].values.length) break; q[j] = 0; }
    }
    return {
      axes, total, wf, results, metric: cfg.metric,
      get done() { return idx; },
      get finished() { return idx >= total || !!error; },
      get error() { return error; },
      // Runs combinations until the time budget is spent; returns true when finished.
      step(budgetMs = 12) {
        const t0 = Date.now();
        try { while (idx < total) { one(); if (Date.now() - t0 >= budgetMs) break; } } catch (e) { if (e && e.need) throw e; error = `Combination ${idx + 1}: ${e && e.message}`; }
        return idx >= total || !!error;
      },
      runAll() { while (!this.step(1e9)); return this; },
      ranked() { return results.slice().sort(rankCmp); },
      best() { const r = this.ranked()[0]; return r && r.score !== null ? r : null; },
    };
  }

  // ── XLSX (minimal OOXML package in a STORE-only ZIP) ──
  const CRC_TABLE = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
    return t;
  })();
  function crc32(bytes) {
    let c = 0xffffffff;
    for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 255] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  }
  // files: [{ name, data: string | Uint8Array }] → Uint8Array (no compression, no data descriptors, no ZIP64).
  function zipStore(files, date = new Date()) {
    const enc = new TextEncoder();
    const dt = ((Math.max(1980, date.getFullYear()) - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
    const tm = (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1);
    const parts = [], central = [];
    let off = 0;
    for (const f of files) {
      const name = enc.encode(f.name), data = typeof f.data === 'string' ? enc.encode(f.data) : f.data, crc = crc32(data);
      const h = new DataView(new ArrayBuffer(30));
      h.setUint32(0, 0x04034b50, true); h.setUint16(4, 20, true); h.setUint16(6, 0x0800, true); h.setUint16(8, 0, true);
      h.setUint16(10, tm, true); h.setUint16(12, dt, true); h.setUint32(14, crc, true); h.setUint32(18, data.length, true); h.setUint32(22, data.length, true);
      h.setUint16(26, name.length, true); h.setUint16(28, 0, true);
      const cd = new DataView(new ArrayBuffer(46));
      cd.setUint32(0, 0x02014b50, true); cd.setUint16(4, 20, true); cd.setUint16(6, 20, true); cd.setUint16(8, 0x0800, true); cd.setUint16(10, 0, true);
      cd.setUint16(12, tm, true); cd.setUint16(14, dt, true); cd.setUint32(16, crc, true); cd.setUint32(20, data.length, true); cd.setUint32(24, data.length, true);
      cd.setUint16(28, name.length, true); cd.setUint32(42, off, true);
      parts.push(new Uint8Array(h.buffer), name, data);
      central.push(new Uint8Array(cd.buffer), name);
      off += 30 + name.length + data.length;
    }
    const cdSize = central.reduce((s, b) => s + b.length, 0);
    const end = new DataView(new ArrayBuffer(22));
    end.setUint32(0, 0x06054b50, true); end.setUint16(8, files.length, true); end.setUint16(10, files.length, true); end.setUint32(12, cdSize, true); end.setUint32(16, off, true);
    const all = [...parts, ...central, new Uint8Array(end.buffer)], out = new Uint8Array(all.reduce((s, b) => s + b.length, 0));
    let p = 0;
    for (const b of all) { out.set(b, p); p += b.length; }
    return out;
  }
  const XML_HEAD = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
  const NS_MAIN = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main', NS_REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
  const xesc = (s) => String(s).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f￾￿]/g, '').replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]));
  // Cell styles (cellXfs index): text, bold header, money #,##0.00, percent value (already ×100), UTC date-time, integer, price.
  const XS = { text: 0, bold: 1, money: 2, pct: 3, date: 4, int: 5, price: 6 };
  const colName = (i) => { let s = ''; for (i++; i > 0; i = Math.floor((i - 1) / 26)) s = String.fromCharCode(65 + ((i - 1) % 26)) + s; return s; };
  const STYLES = `${XML_HEAD}<styleSheet xmlns="${NS_MAIN}"><numFmts count="3"><numFmt numFmtId="164" formatCode="0.00&quot;%&quot;"/><numFmt numFmtId="165" formatCode="yyyy-mm-dd hh:mm"/><numFmt numFmtId="166" formatCode="0.00###"/></numFmts>`
    + '<fonts count="2"><font><sz val="11"/><name val="Calibri"/><family val="2"/></font><font><b/><sz val="11"/><name val="Calibri"/><family val="2"/></font></fonts>'
    + '<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>'
    + '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>'
    + '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>'
    + '<cellXfs count="7"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/>'
    + '<xf numFmtId="4" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/><xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>'
    + '<xf numFmtId="165" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/><xf numFmtId="1" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>'
    + '<xf numFmtId="166" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/></cellXfs>'
    + '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>';
  // sheets: [{ name, header: [..], types?: [style key per column], rows: [[cell]], widths?: [..] }]; a cell is
  // null/undefined (blank), a number, a string, or { v, s } to override the column style. 'date' cells take Unix seconds.
  function xlsx(sheets, date) {
    const used = new Set();
    const names = sheets.map((s, i) => {
      let nm = String(s.name || `Sheet${i + 1}`).replace(/[[\]:*?/\\]/g, ' ').slice(0, 31).trim() || `Sheet${i + 1}`;
      while (used.has(nm.toLowerCase())) nm = `${nm.slice(0, 28)} ${i + 1}`;
      used.add(nm.toLowerCase());
      return nm;
    });
    const cellXml = (ref, v, st) => {
      if (v === null || v === undefined || v === '') return '';
      if (typeof v === 'number' || typeof v === 'boolean') {
        let x = +v;
        if (!ok(x)) return '';
        if (st === 'date') x = x / 86400 + 25569;
        const s = XS[st] || 0;
        return `<c r="${ref}"${s ? ` s="${s}"` : ''}><v>${x}</v></c>`;
      }
      const s = st === 'bold' ? 1 : 0;
      return `<c r="${ref}" t="inlineStr"${s ? ` s="${s}"` : ''}><is><t xml:space="preserve">${xesc(v)}</t></is></c>`;
    };
    const sheetXml = (sh) => {
      const rows = [sh.header || [], ...(sh.rows || [])], types = sh.types || [];
      const ncol = rows.reduce((m, r) => Math.max(m, r.length), 0);
      const widths = sh.widths || Array.from({ length: ncol }, (_, j) => Math.min(48, Math.max(8, ...rows.slice(0, 200).map((r) => { const c = r[j]; const v = c && typeof c === 'object' ? c.v : c; return typeof v === 'number' ? 12 : String(v === null || v === undefined ? '' : v).length + 2; }))));
      const body = rows.map((r, i) => {
        const cells = r.map((c, j) => {
          const ref = `${colName(j)}${i + 1}`;
          if (i === 0 && sh.header) return cellXml(ref, c, 'bold');
          return c && typeof c === 'object' ? cellXml(ref, c.v, c.s) : cellXml(ref, c, types[j]);
        }).join('');
        return `<row r="${i + 1}">${cells}</row>`;
      }).join('');
      const dim = ncol ? `A1:${colName(ncol - 1)}${rows.length}` : 'A1';
      return `${XML_HEAD}<worksheet xmlns="${NS_MAIN}" xmlns:r="${NS_REL}"><dimension ref="${dim}"/>`
        + `<sheetViews><sheetView workbookViewId="0"${sh.header ? '><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView>' : '/>'}</sheetViews>`
        + '<sheetFormatPr defaultRowHeight="15"/>'
        + (ncol ? `<cols>${widths.map((w, j) => `<col min="${j + 1}" max="${j + 1}" width="${w}" customWidth="1"/>`).join('')}</cols>` : '')
        + `<sheetData>${body}</sheetData></worksheet>`;
    };
    const files = [
      { name: '[Content_Types].xml', data: `${XML_HEAD}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>${sheets.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('')}<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>` },
      { name: '_rels/.rels', data: `${XML_HEAD}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${NS_REL}/officeDocument" Target="xl/workbook.xml"/></Relationships>` },
      { name: 'xl/workbook.xml', data: `${XML_HEAD}<workbook xmlns="${NS_MAIN}" xmlns:r="${NS_REL}"><bookViews><workbookView/></bookViews><sheets>${names.map((nm, i) => `<sheet name="${xesc(nm)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')}</sheets></workbook>` },
      { name: 'xl/_rels/workbook.xml.rels', data: `${XML_HEAD}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${sheets.map((_, i) => `<Relationship Id="rId${i + 1}" Type="${NS_REL}/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('')}<Relationship Id="rId${sheets.length + 1}" Type="${NS_REL}/styles" Target="styles.xml"/></Relationships>` },
      { name: 'xl/styles.xml', data: STYLES },
      ...sheets.map((sh, i) => ({ name: `xl/worksheets/sheet${i + 1}.xml`, data: sheetXml(sh) })),
    ];
    return zipStore(files, date);
  }

  // ── Script runtime ────────────────────────────────────
  const LINE_OFS = (() => {
    try { new Function('ctx', 'throw new Error("probe")')(); } catch (e) { const m = /<anonymous>:(\d+):\d+/.exec(e.stack || '') || /Function:(\d+):\d+/.exec(e.stack || ''); if (m) return +m[1] - 1; }
    return 2;
  })();
  const fnCache = new Map();
  function compile(code) {
    let f = fnCache.get(code);
    if (!f) {
      f = new Function('ctx', `"use strict";${code}`);
      if (fnCache.size > 50) fnCache.clear();
      fnCache.set(code, f);
    }
    return f;
  }
  function syntaxLine(code) {
    if (typeof document === 'undefined' || !document.head) return null;
    let line = null;
    const h = (e) => { line = e.lineno; e.preventDefault(); };
    window.addEventListener('error', h);
    const s = document.createElement('script');
    s.textContent = `window.__igsProbe = function (ctx) {\n${code}\n};`;
    try { document.head.appendChild(s); } finally { s.remove(); window.removeEventListener('error', h); delete window.__igsProbe; }
    return line ? line - 1 : null;
  }
  function errorLine(e, code) {
    if (e && e.name === 'SyntaxError') return syntaxLine(code);
    for (const m of String((e && e.stack) || '').matchAll(/(?:<anonymous>|Function):(\d+):\d+/g)) {
      const ln = +m[1] - LINE_OFS;
      if (ln >= 1) return ln;
    }
    return null;
  }
  class ScriptError extends Error {
    constructor(msg, line, phase) { super(msg); this.line = line; this.phase = phase; }
  }

  function inputSchema(name, def, o = {}) {
    const base = { k: name, label: o.label || name, def };
    if (typeof def === 'boolean') return { ...base, type: 'bool' };
    if (o.options) return { ...base, type: 'select', options: o.options };
    if (typeof def === 'number') {
      const isInt = Number.isInteger(def) && !(o.step && !Number.isInteger(o.step));
      return { ...base, type: isInt ? 'int' : 'number', min: o.min, max: o.max, step: o.step || (isInt ? 1 : 0.1) };
    }
    if (typeof def === 'string' && /^#[0-9a-f]{6}$/i.test(def)) return { ...base, type: 'color' };
    return { ...base, type: 'text' };
  }

  function runScript(code, kind, candles, values = {}, opts = {}) {
    const n = candles.length, inputs = [], t0 = Date.now(), deadline = t0 + (opts.timeLimit || TIME_LIMIT);
    const guard = () => { if (Date.now() > deadline) throw new ScriptError(`Script exceeded ${(opts.timeLimit || TIME_LIMIT) / 1000} s time limit`, null, 'runtime'); };
    let fn;
    try { fn = compile(code); } catch (e) { throw new ScriptError(e.message, errorLine(e, code), 'compile'); }
    const ta = makeTA(guard);
    ta.highest = ta.highest || highest; ta.lowest = ta.lowest || lowest;
    const ctx = {
      n, bars: candles, time: col(candles, 'time'), open: col(candles, 'open'), high: col(candles, 'high'), low: col(candles, 'low'), close: col(candles, 'close'),
      volume: candles.map((c) => c.volume || 0), hl2: candles.map((c) => (c.high + c.low) / 2), hlc3: candles.map((c) => (c.high + c.low + c.close) / 3),
      ta, tfSec: opts.tfSec || 0, na: NA, isNa: (v) => !ok(v), nz: ta.nz, check: guard,
      crossover: ta.crossover, crossunder: ta.crossunder,
      series(f) { const out = new Array(n); for (let i = 0; i < n; i++) { if ((i & 255) === 0) guard(); out[i] = f(i); } return out; },
      input(name, def, o) {
        if (!inputs.some((x) => x.k === name)) inputs.push(inputSchema(name, def, o));
        const v = values[name];
        if (v === undefined || v === null || v === '') return def;
        if (typeof def === 'number') { const x = +v; return ok(x) ? x : def; }
        if (typeof def === 'boolean') return !!v;
        return v;
      },
    };
    let r;
    try { r = fn(ctx); } catch (e) { throw e instanceof ScriptError ? e : new ScriptError(`${e && e.name ? `${e.name}: ` : ''}${e && e.message}`, errorLine(e, code), 'runtime'); }
    guard();
    if (!r || typeof r !== 'object') throw new ScriptError(kind === 'strategy' ? 'Strategy must return { long, short, exitLong?, exitShort? }' : 'Indicator must return { plots: [...] }', null, 'runtime');
    const ms = Date.now() - t0;
    if (kind === 'strategy') {
      const bool = (a, k, req) => {
        if (a === undefined || a === null) { if (req) throw new ScriptError(`Missing "${k}" array in returned object`, null, 'runtime'); return undefined; }
        if (!isArr(a)) throw new ScriptError(`"${k}" must be an array of booleans (length ${n})`, null, 'runtime');
        return Array.from({ length: n }, (_, i) => !!a[i]);
      };
      const num = (a) => (isArr(a) ? Array.from({ length: n }, (_, i) => +a[i]) : undefined);
      return { signals: { long: bool(r.long, 'long', true), short: bool(r.short, 'short', false) || falses(n), exitLong: bool(r.exitLong, 'exitLong'), exitShort: bool(r.exitShort, 'exitShort'), stop: num(r.stop), limit: num(r.limit) }, inputs, ms };
    }
    if (!Array.isArray(r.plots) || !r.plots.length) throw new ScriptError('Indicator must return { plots: [{ name, values, ... }] }', null, 'runtime');
    const plots = r.plots.map((pl, j) => {
      if (!pl || !isArr(pl.values)) throw new ScriptError(`plots[${j}].values must be an array`, null, 'runtime');
      return { name: pl.name || `Plot ${j + 1}`, values: Array.from({ length: n }, (_, i) => { const v = +pl.values[i]; return ok(v) ? v : NA; }), color: pl.color, pane: pl.pane === 'pane' ? 'pane' : 'overlay', type: pl.type === 'histogram' ? 'histogram' : 'line', width: pl.width || 1 };
    });
    const markers = (Array.isArray(r.markers) ? r.markers : []).map((m) => {
      const t = m.time !== undefined ? m.time : candles[m.i !== undefined ? m.i : m.index] && candles[m.i !== undefined ? m.i : m.index].time;
      return t === undefined ? null : { time: t, position: m.position || 'aboveBar', shape: m.shape || 'circle', color: m.color || '#2962ff', text: m.text || '' };
    }).filter(Boolean).sort((a, b) => a.time - b.time);
    return { plots, markers, inputs, ms };
  }

  const PALETTE = ['#2962ff', '#ff6d00', '#26a69a', '#ef5350', '#ab47bc', '#f7b924', '#4dd0e1', '#8d6e63'];
  const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'script';
  function indicatorDef(script, sample) {
    const id = `script:${slug(script.name)}`;
    return {
      id, name: script.name, short: script.name, kind: sample.plots[0].pane === 'pane' ? 'pane' : 'overlay', category: 'Scripts', script: true,
      params: sample.inputs.filter((x) => x.type !== 'text').map((x) => ({ ...x })),
      outputs: sample.plots.map((pl, j) => ({ k: `p${j}`, label: pl.name, type: pl.type, color: pl.color || PALETTE[j % PALETTE.length], width: pl.width || 1, style: 0 })),
      calc(candles, params, cx) {
        const r = runScript(script.code, 'indicator', candles, params || {}, { tfSec: cx && cx.tfSec });
        const out = {};
        sample.plots.forEach((_, j) => { out[`p${j}`] = r.plots[j] ? r.plots[j].values : new Array(candles.length).fill(NA); });
        if (r.markers.length) out.markers = r.markers;
        return out;
      },
    };
  }

  const TEMPLATES = [
    { name: 'Strategy · MA crossover', kind: 'strategy', code: `// Strategy: moving-average crossover
const fastLen = ctx.input('Fast length', 9, { min: 1 });
const slowLen = ctx.input('Slow length', 21, { min: 1 });
const useEma = ctx.input('Use EMA', false);
const ma = useEma ? ctx.ta.ema : ctx.ta.sma;
const fast = ma(ctx.close, fastLen);
const slow = ma(ctx.close, slowLen);
return {
  long: ctx.ta.crossover(fast, slow),
  short: ctx.ta.crossunder(fast, slow),
};
` },
    { name: 'Strategy · RSI reversal + trend filter', kind: 'strategy', code: `// Strategy: RSI mean reversion, only with the 200 EMA trend
const len = ctx.input('RSI length', 14);
const os = ctx.input('Oversold', 30);
const ob = ctx.input('Overbought', 70);
const trendLen = ctx.input('Trend EMA', 200);
const r = ctx.ta.rsi(ctx.close, len);
const trend = ctx.ta.ema(ctx.close, trendLen);
const long = ctx.series((i) => ctx.ta.crossover(r, os, i) && ctx.close[i] > trend[i]);
const short = ctx.series((i) => ctx.ta.crossunder(r, ob, i) && ctx.close[i] < trend[i]);
return {
  long,
  short,
  exitLong: ctx.ta.crossover(r, 50),
  exitShort: ctx.ta.crossunder(r, 50),
};
` },
    { name: 'Strategy · Bar loop (state)', kind: 'strategy', code: `// Strategy: explicit bar loop with state; call ctx.check() inside long loops
const len = ctx.input('Breakout length', 20);
const hh = ctx.ta.highest(ctx.high, len);
const ll = ctx.ta.lowest(ctx.low, len);
const long = [], short = [];
for (let i = 0; i < ctx.n; i++) {
  if ((i & 255) === 0) ctx.check();
  long[i] = i > 0 && ctx.close[i] > hh[i - 1];
  short[i] = i > 0 && ctx.close[i] < ll[i - 1];
}
return { long, short };
` },
    { name: 'Indicator · MA ribbon (overlay)', kind: 'indicator', code: `// Indicator: EMA ribbon drawn on the price chart
const base = ctx.input('Base length', 10);
const step = ctx.input('Step', 10);
const colors = ['#2962ff', '#7e57c2', '#ab47bc', '#ec407a'];
const plots = colors.map((color, k) => ({
  name: 'EMA ' + (base + k * step),
  values: ctx.ta.ema(ctx.close, base + k * step),
  color,
  pane: 'overlay',
}));
return { plots };
` },
    { name: 'Indicator · Oscillator histogram (pane)', kind: 'indicator', code: `// Indicator: MACD-style histogram in its own pane, with cross markers
const fast = ctx.input('Fast', 12);
const slow = ctx.input('Slow', 26);
const sig = ctx.input('Signal', 9);
const f = ctx.ta.ema(ctx.close, fast), s = ctx.ta.ema(ctx.close, slow);
const macd = ctx.series((i) => f[i] - s[i]);
const signal = ctx.ta.ema(macd, sig);
const hist = ctx.series((i) => macd[i] - signal[i]);
const markers = [];
for (let i = 1; i < ctx.n; i++) {
  if (ctx.ta.crossover(macd, signal, i)) markers.push({ i, position: 'belowBar', shape: 'arrowUp', color: '#26a69a', text: 'X↑' });
  if (ctx.ta.crossunder(macd, signal, i)) markers.push({ i, position: 'aboveBar', shape: 'arrowDown', color: '#ef5350', text: 'X↓' });
}
return {
  plots: [
    { name: 'Hist', values: hist, type: 'histogram', pane: 'pane', color: '#26a69a' },
    { name: 'MACD', values: macd, pane: 'pane', color: '#2962ff' },
    { name: 'Signal', values: signal, pane: 'pane', color: '#ff6d00' },
  ],
  markers,
};
` },
  ];

  // ── Pine scripts (public/pine.js) ─────────────────────
  const SOURCES = ['close', 'open', 'high', 'low', 'hl2', 'hlc3', 'ohlc4', 'hlcc4', 'volume'];
  const isPine = (code) => !!(G.IGPine && G.IGPine.detect(code).isPine);
  const langOf = (sc) => (sc && sc.lang) || (isPine(sc && sc.code) ? 'pine' : 'js');
  // Runs Pine; PineError → ScriptError with line and column.
  function runPine(code, candles, values = {}, opts = {}) {
    if (!G.IGPine) throw new ScriptError('Pine support is not loaded (pine.js missing)', null, 'compile');
    try {
      return G.IGPine.run(code, candles, { values, tfSec: opts.tfSec, props: opts.props, symbol: opts.symbol, decimals: opts.decimals, timeLimit: opts.timeLimit || TIME_LIMIT, onProgress: opts.onProgress, ext: opts.ext || null, libs: opts.libs || null, src: opts.src || null });
    } catch (e) {
      if (e instanceof G.IGPine.PineError) { const se = new ScriptError(e.message, e.line, e.phase); se.col = e.col; if (e.need) se.need = e.need; throw se; }
      throw new ScriptError(`${e && e.name ? `${e.name}: ` : ''}${e && e.message}`, null, 'runtime');
    }
  }

  // ── Jobs: one entry point for the worker and the main-thread fallback (identical results by construction) ──
  // job: { op: 'backtest' | 'compile' | 'optimize', lang: 'builtin' | 'js' | 'pine', key, subKey?, stratId?, code?, kind?, params, values?,
  //        props, tfSec, symbol?, decimals?, timeLimit, ranges?, metric?, max?, walkForward?, isPct? }
  const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());
  function barsToCols(c) {
    const n = c.length, cols = { time: new Float64Array(n), open: new Float64Array(n), high: new Float64Array(n), low: new Float64Array(n), close: new Float64Array(n), volume: new Float64Array(n) };
    for (let i = 0; i < n; i++) { const x = c[i]; cols.time[i] = x.time; cols.open[i] = x.open; cols.high[i] = x.high; cols.low[i] = x.low; cols.close[i] = x.close; cols.volume[i] = x.volume || 0; }
    return cols;
  }
  function colsToBars(k) {
    const n = k.time.length, out = new Array(n);
    for (let i = 0; i < n; i++) out[i] = { time: k.time[i], open: k.open[i], high: k.high[i], low: k.low[i], close: k.close[i], volume: k.volume[i] };
    return out;
  }
  function jobStrategy(job, onProgress) {
    if (job.lang === 'builtin') {
      const st = STRATEGIES.find((x) => x.id === job.stratId);
      if (!st) throw new ScriptError(`Unknown strategy ${job.stratId}`, null, 'compile');
      if (st.id === 'ai_chance') throw new ScriptError('AI Chance signals need the chart and cannot run in the script worker', null, 'runtime');
      return st;
    }
    if (job.lang === 'js') return { id: 'script', params: [], signals: (c, p) => runScript(job.code, 'strategy', c, p, { tfSec: job.tfSec, timeLimit: job.timeLimit }).signals };
    return {
      id: 'pine', params: [],
      signals: (c, p, ta, env) => {
        const r = runPine(job.code, c, p, { tfSec: job.tfSec, props: (env && env.props) || job.props, symbol: job.symbol, decimals: job.decimals, timeLimit: job.timeLimit, onProgress, ext: job.extGet, libs: job.libs });
        if (r.kind !== 'strategy') throw new ScriptError('This Pine script declares indicator() — use strategy() to backtest it', 1, 'compile');
        return G.IGPine.strategySignals(r, c.length);
      },
    };
  }
  // Pine data hooks for a job: ext(symbol, tfSec) → loaded bars of another symbol / lower timeframe (job.ext names the series),
  // 'invalid' for symbols the host could not resolve (job.extBad), null when not loaded yet (→ a 'data' error with err.need).
  function extGetter(job, getBars) {
    const ext = job.ext || {}, bad = new Set(job.extBad || []);
    return (sym, tf) => { const k = `${sym}|${tf}`; if (bad.has(k)) return 'invalid'; return ext[k] ? getBars(ext[k]) : null; };
  }
  function runJob(job, getBars, onProgress) {
    const t0 = now(), c = getBars(job.key);
    if (!c) throw new ScriptError('chart data missing in the script worker', null, 'runtime');
    if (job.lang === 'pine') job = { ...job, extGet: extGetter(job, getBars) };
    if (job.op === 'compile') {
      if (job.lang === 'pine') {
        const src = job.srcs ? (name) => job.srcs[name] || null : null;
        return { pine: runPine(job.code, c, job.values || {}, { tfSec: job.tfSec, props: job.props, symbol: job.symbol, decimals: job.decimals, timeLimit: job.timeLimit, ext: job.extGet, libs: job.libs, src }), ms: now() - t0 };
      }
      return { js: runScript(job.code, job.kind, c, job.values || {}, { tfSec: job.tfSec, timeLimit: job.timeLimit }), ms: now() - t0 };
    }
    const sub = job.subKey ? getBars(job.subKey) : null;
    if (job.op === 'optimize') {
      const st = jobStrategy(job);
      const o = createOptimizer({ candles: c, strategy: st, params: job.params, props: job.props, ranges: job.ranges, metric: job.metric, max: job.max, walkForward: job.walkForward, isPct: job.isPct, env: { props: job.props }, sub });
      if (o.error) return { error: o.error, total: o.total || 0 };
      let sent = 0, last = now();
      while (!o.step(40)) {
        if (onProgress && now() - last > 150) { onProgress({ done: o.done, total: o.total, results: o.results.slice(sent) }); sent = o.results.length; last = now(); }
      }
      return { done: o.done, total: o.total, results: o.results.slice(sent), error: o.error, ms: now() - t0 };
    }
    // backtest
    let sig, inputs = null, extra = {};
    if (job.lang === 'builtin') sig = jobStrategy(job).signals(c, job.params, makeTA(), { props: job.props });
    else if (job.lang === 'js') { const r = runScript(job.code, 'strategy', c, job.params, { tfSec: job.tfSec, timeLimit: job.timeLimit }); sig = r.signals; inputs = r.inputs; }
    else {
      if (onProgress) onProgress({ phase: 'script', done: 0, total: c.length });
      const r = runPine(job.code, c, job.params, { tfSec: job.tfSec, props: job.props, symbol: job.symbol, decimals: job.decimals, timeLimit: job.timeLimit, onProgress: onProgress ? (d, n) => onProgress({ phase: 'script', done: d, total: n }) : null, ext: job.extGet, libs: job.libs });
      if (r.kind !== 'strategy') throw new ScriptError('This Pine script declares indicator() — use strategy() to backtest it', 1, 'compile');
      sig = G.IGPine.strategySignals(r, c.length); inputs = r.inputs;
      extra = { warnings: r.warnings, declProps: r.declProps, pine: true };
    }
    const sigMs = now() - t0;
    if (onProgress) onProgress({ phase: 'backtest', done: c.length, total: c.length });
    const res = backtest(c, sig, { ...job.props, tfSec: job.tfSec }, sub && sub.length ? { sub } : undefined);
    const i = c.length - 1, at = (a) => !!(a && a[i]);
    return { res, inputs, lastSig: { i, long: at(sig.long), short: at(sig.short), exitLong: at(sig.exitLong), exitShort: at(sig.exitShort) }, ms: now() - t0, sigMs, ...extra };
  }

  // ── Pine data for request.security on other symbols / lower timeframes ─────────────────
  // The interpreter is synchronous, so the host runs a Pine job, and when it fails with a 'data' error (err.need = [{ symbol,
  // tfSec }]) it loads those series here on the main thread (/api/history, symbols resolved with /api/search when they are not
  // IG epics), adds them to the job as extra series and runs it again (at most 4 rounds). Needs seen for a script are remembered
  // and preloaded the next time. Loaded series are cached per epic/timeframe for a short time (ttl ≈ the timeframe, 30 s–5 min).
  const PD_RES = [['MONTH', 2592000], ['WEEK', 604800], ['DAY', 86400], ['HOUR_4', 14400], ['HOUR_3', 10800], ['HOUR_2', 7200], ['HOUR', 3600], ['MINUTE_30', 1800], ['MINUTE_15', 900], ['MINUTE_10', 600], ['MINUTE_5', 300], ['MINUTE_3', 180], ['MINUTE_2', 120], ['MINUTE', 60], ['SECOND', 1]];
  const PD_MAX = 30000;
  const isEpic = (s) => /^[A-Z0-9_]+(\.[A-Z0-9_-]+){2,}$/i.test(s);
  function createPineData(api, o = {}) {
    const cache = new Map(), symbols = new Map(), now = o.now || (() => Date.now());
    async function resolve(sym) {
      if (isEpic(sym)) return sym;
      if (symbols.has(sym)) return symbols.get(sym);
      const q = sym.split(':').pop().trim();
      let list = [];
      try { list = (await api(`/api/search?q=${encodeURIComponent(q)}`)) || []; } catch (e) { list = []; }
      const lq = q.toLowerCase(), norm = (x) => String(x || '').toLowerCase().replace(/[^a-z0-9]/g, '');
      const hit = list.find((m) => String(m.epic).toLowerCase() === lq) || list.find((m) => norm(m.name) === norm(q)) || list.find((m) => norm(m.name).startsWith(norm(q))) || list[0];
      // nothing matched by name: try the text itself as an epic (the history request answers 404 when it is not one)
      const epic = hit && hit.epic ? hit.epic : /^[A-Z0-9_.-]+$/i.test(q) ? q : null;
      symbols.set(sym, epic);
      return epic;
    }
    async function series(epic, tfSec, want) {
      const res = PD_RES.find(([, sec]) => tfSec % sec === 0);
      if (!res) throw new Error(`no IG resolution for a ${tfSec}s timeframe`);
      const ratio = tfSec / res[1], max = Math.min(PD_MAX, Math.max(10, Math.ceil(want * ratio)));
      const key = `${epic}|${tfSec}`, hit = cache.get(key), ttl = Math.min(300, Math.max(30, tfSec)) * 1000;
      if (hit && now() - hit.at < ttl && hit.max >= max) return hit.bars;
      const r = await api(`/api/history?epic=${encodeURIComponent(epic)}&resolution=${res[0]}&max=${max}`);
      let bars = normalizeBars(r && r.candles);
      if (ratio > 1 && G.IGPine) bars = G.IGPine._internal.aggregateBars(bars, tfSec).bars;
      cache.set(key, { at: now(), bars, max });
      while (cache.size > 12) cache.delete(cache.keys().next().value);
      return bars;
    }
    // need: [{ symbol, tfSec }], chart: the chart candles (their time span decides how much history to load)
    async function load(need, chart) {
      const ext = {}, bad = [];
      const n = chart ? chart.length : 0, t0 = n ? chart[0].time : 0, t1 = n ? chart[n - 1].time : 0, ctf = n > 1 ? Math.max(1, (t1 - t0) / (n - 1)) : 60;
      for (const nd of need) {
        const k = `${nd.symbol}|${nd.tfSec}`;
        const epic = await resolve(nd.symbol);
        if (!epic) { bad.push(k); continue; }
        // enough bars to cover the chart (+300 bars of warm-up for indicators at the same or a higher timeframe)
        const span = n ? Math.ceil((Date.now() / 1000 - t0 + ctf) / nd.tfSec) : 500;
        const want = span + (nd.tfSec >= ctf ? 300 : 0);
        try { ext[k] = await series(epic, nd.tfSec, want); } catch (e) {
          if (e && (e.status === 404 || e.status === 400)) { bad.push(k); continue; }
          throw new ScriptError(`request.security(): could not load ${nd.symbol} (${G.IGPine ? G.IGPine.tfString(nd.tfSec) : nd.tfSec}): ${(e && e.message) || e}`, null, 'runtime');
        }
        if (!ext[k].length) { delete ext[k]; bad.push(k); }
      }
      return { ext, bad };
    }
    return { load, resolve, cache };
  }
  let PINE_DATA = null;
  const pineData = () => PINE_DATA || (G.IGC && typeof G.IGC.api === 'function' ? (PINE_DATA = createPineData(G.IGC.api)) : null);

  // ── Pine libraries: scripts saved in the editor that declare library("Name") ─────────────────
  let scriptSource = null; // set by mount(): () => saved scripts
  function savedScripts() {
    if (scriptSource) return scriptSource();
    const st = G.IGC && G.IGC.store;
    return (st && st.get('mod.scripts', [])) || [];
  }
  // { Name: code } for the libraries a script imports (transitively), from the saved scripts.
  function pineLibs(code, list = savedScripts()) {
    const P = G.IGPine;
    if (!P || !P.importsOf(code).length) return null;
    const libs = {}, all = (list || []).filter((x) => x && x.code && P.libraryTitle(x.code));
    const add = (name) => {
      if (libs[name] !== undefined) return;
      const lc = name.toLowerCase();
      const sc = all.find((x) => P.libraryTitle(x.code) === name) || all.find((x) => P.libraryTitle(x.code).toLowerCase() === lc) || all.find((x) => String(x.name).toLowerCase() === lc);
      if (!sc) return;
      libs[name] = sc.code;
      for (const i of P.importsOf(sc.code)) add(i.name);
    };
    for (const i of P.importsOf(code)) add(i.name);
    return libs;
  }

  // ── Script host: runs jobs in public/script-worker.js ─────────────────
  // Protocol (main → worker): { type: 'series', key, cols } (typed arrays, transferred), { type: 'patch', key, base, from, cols } (tail
  // update of a live series), { type: 'drop', key }, { type: 'job', id, job }. Worker → main: { type: 'ready' },
  // { type: 'progress', id, data }, { type: 'result', id, ok, result | error: { message, line, col, phase, need? } }.
  // A job that outlives its timeout, or is cancelled, terminates the worker; the next job respawns it and pending jobs are re-sent.
  // Pine jobs: job.libs is filled from the saved libraries; 'data' errors load the requested series and re-run (see above), so
  // opts.ext ({ 'SYMBOL|tfSec': bars }) travels as extra series and job.ext names them.
  // Without Worker support (or if the worker fails to load) jobs run on the main thread through the same runJob().
  const WORKER_URL = SELF_URL ? SELF_URL.replace(/strategy\.js(\?.*)?$/, 'script-worker.js') : '';
  const KEEP_SERIES = 16;
  function createScriptHost(url = WORKER_URL, hopts = {}) {
    let w = null, ready = false, broken = !url || typeof Worker === 'undefined', seq = 0;
    let sent = new Map();
    const jobs = new Map(), streams = new Map(), known = new Map();
    const loader = () => (hopts.data !== undefined ? hopts.data : pineData());
    const keyOf = (c) => { const n = c.length, a = n ? c[n - 1] : null; return n ? `${n}:${c[0].time}:${a.time}:${a.open}:${a.high}:${a.low}:${a.close}:${a.volume || 0}` : '0'; };
    const fail = (rec, e) => { clearTimeout(rec.timer); jobs.delete(rec.id); rec.reject(e); };
    const needKey = (job) => `${job.symbol}|${job.tfSec}|${job.code}`;
    // A 'data' error: load what the script asked for, then dispatch again (same job id, so cancel() keeps working).
    function needData(rec, e) {
      const L = loader();
      if (!(e && e.need && e.need.length && rec.job.lang === 'pine' && L) || (rec.rounds = (rec.rounds || 0) + 1) > 4) return false;
      const k = needKey(rec.job), seen = known.get(k) || [];
      for (const nd of e.need) if (!seen.some((x) => x.symbol === nd.symbol && x.tfSec === nd.tfSec)) seen.push({ symbol: nd.symbol, tfSec: nd.tfSec });
      known.set(k, seen); while (known.size > 50) known.delete(known.keys().next().value);
      load(rec, e.need);
      return true;
    }
    function load(rec, need) {
      rec.loading = true; clearTimeout(rec.timer); jobs.set(rec.id, rec);
      if (rec.opts.onProgress) rec.opts.onProgress({ phase: 'data', need });
      const timeout = new Promise((_, rej) => setTimeout(() => rej(new ScriptError('request.security(): loading other symbols timed out (30 s)', null, 'runtime')), 30000));
      Promise.race([loader().load(need, rec.opts.candles), timeout]).then((got) => {
        rec.loading = false;
        if (!jobs.has(rec.id)) return;
        rec.opts = { ...rec.opts, ext: { ...(rec.opts.ext || {}), ...got.ext } };
        rec.job = { ...rec.job, extBad: [...new Set([...(rec.job.extBad || []), ...got.bad])] };
        dispatch(rec);
      }, (er) => { rec.loading = false; if (jobs.has(rec.id)) fail(rec, er instanceof ScriptError ? er : new ScriptError(String((er && er.message) || er), null, 'runtime')); });
    }
    function runLocal(rec) {
      jobs.set(rec.id, rec); rec.local = true;
      setTimeout(() => {
        if (!jobs.has(rec.id)) return;
        const got = { main: rec.opts.candles, sub: rec.opts.sub }, job = { ...rec.job, key: 'main', subKey: rec.opts.sub ? 'sub' : undefined };
        if (rec.opts.ext) { job.ext = {}; for (const [k, bars] of Object.entries(rec.opts.ext)) { got[`ext:${k}`] = bars; job.ext[k] = `ext:${k}`; } }
        let res;
        try { res = runJob(job, (k) => got[k], rec.opts.onProgress); } catch (e) { if (!needData(rec, e)) fail(rec, e); return; }
        jobs.delete(rec.id); rec.resolve(res);
      }, 0);
    }
    function kill() { if (w) { w.onmessage = null; w.onerror = null; w.terminate(); } w = null; ready = false; sent = new Map(); streams.clear(); }
    function spawn() {
      if (broken) return false;
      try { w = new Worker(url); } catch (e) { broken = true; return false; }
      ready = false; sent = new Map(); streams.clear();
      w.onmessage = (ev) => {
        const m = ev.data || {};
        if (m.type === 'ready') { ready = true; return; }
        const rec = jobs.get(m.id);
        if (!rec || rec.loading) return;
        if (m.type === 'progress') { if (rec.opts.onProgress) rec.opts.onProgress(m.data); return; }
        clearTimeout(rec.timer);
        if (m.ok) { jobs.delete(m.id); rec.resolve(m.result); return; }
        const er = m.error || {}, se = new ScriptError(er.message || 'Script failed', er.line || null, er.phase || 'runtime');
        se.col = er.col || null;
        if (er.need) se.need = er.need;
        if (!needData(rec, se)) fail(rec, se);
      };
      w.onerror = (ev) => {
        if (ev && ev.preventDefault) ev.preventDefault();
        const pending = [...jobs.values()].filter((r) => !r.loading && !r.local);
        for (const r of pending) jobs.delete(r.id);
        const loadFail = !ready;
        kill();
        if (loadFail) { broken = true; for (const rec of pending) { clearTimeout(rec.timer); runLocal(rec); } return; }
        for (const rec of pending) { clearTimeout(rec.timer); rec.reject(new ScriptError(`Script worker crashed: ${(ev && ev.message) || 'unknown error'}`, null, 'runtime')); }
      };
      return true;
    }
    function put(c, stream, pins) {
      const key = keyOf(c);
      pins.add(key);
      if (sent.has(key)) { sent.delete(key); sent.set(key, 1); return key; }
      const prev = stream && streams.get(stream), n = c.length;
      if (prev && sent.has(prev.key) && n >= prev.n && n - prev.n <= 3 && prev.n >= 2 && c[0].time === prev.t0 && c[prev.n - 2].time === prev.tp && c[prev.n - 2].close === prev.cp) {
        const cols = barsToCols(c.slice(prev.n - 1));
        w.postMessage({ type: 'patch', key, base: prev.key, from: prev.n - 1, cols }, Object.values(cols).map((a) => a.buffer));
      } else {
        const cols = barsToCols(c);
        w.postMessage({ type: 'series', key, cols }, Object.values(cols).map((a) => a.buffer));
      }
      sent.set(key, 1);
      for (const k of [...sent.keys()]) { if (sent.size <= KEEP_SERIES) break; if (pins.has(k)) continue; sent.delete(k); w.postMessage({ type: 'drop', key: k }); }
      if (stream && n >= 2) streams.set(stream, { key, n, t0: c[0].time, tp: c[n - 2].time, cp: c[n - 2].close });
      return key;
    }
    function dispatch(rec) {
      if (rec.loading) return;
      if (broken || (!w && !spawn())) { runLocal(rec); return; }
      const pins = new Set();
      const job = { ...rec.job, key: put(rec.opts.candles, rec.opts.stream, pins) };
      if (rec.opts.sub && rec.opts.sub.length) job.subKey = put(rec.opts.sub, null, pins);
      if (rec.opts.ext) { job.ext = {}; for (const [k, bars] of Object.entries(rec.opts.ext)) job.ext[k] = put(bars, null, pins); }
      jobs.set(rec.id, rec);
      w.postMessage({ type: 'job', id: rec.id, job });
      clearTimeout(rec.timer);
      rec.timer = setTimeout(() => {
        if (!jobs.has(rec.id) || rec.loading) return;
        fail(rec, new ScriptError(`Script stopped after the ${+(rec.opts.timeout / 1000).toFixed(1)} s time limit (worker restarted)`, null, 'timeout'));
        restart();
      }, rec.opts.timeout);
    }
    function restart() {
      const pending = [...jobs.values()].filter((r) => !r.loading && !r.local);
      kill();
      for (const rec of pending) dispatch(rec);
    }
    function start(rec) {
      const j = rec.job;
      if (j.lang === 'pine' && j.code && j.libs === undefined) rec.job = { ...j, libs: pineLibs(j.code) };
      const pre = j.lang === 'pine' && loader() ? (known.get(needKey(j)) || []).filter((nd) => !(rec.opts.ext && rec.opts.ext[`${nd.symbol}|${nd.tfSec}`])) : [];
      if (pre.length) load(rec, pre); else dispatch(rec);
    }
    return {
      get mode() { return broken ? 'main thread' : 'worker'; },
      // opts: { candles, sub?, stream?, ext?, timeout (ms), onProgress? } → Promise; the returned promise carries .id for cancel()
      run(job, opts) {
        const rec = { id: ++seq, job, opts: { timeout: 10000, ...opts } };
        const pr = new Promise((resolve, reject) => { rec.resolve = resolve; rec.reject = reject; });
        start(rec);
        pr.id = rec.id;
        return pr;
      },
      cancel(id) {
        const rec = jobs.get(id);
        if (!rec) return false;
        fail(rec, new ScriptError('Cancelled', null, 'cancel'));
        if (!rec.loading && !rec.local) restart();
        return true;
      },
      busy: () => jobs.size,
      destroy() { for (const rec of [...jobs.values()]) fail(rec, new ScriptError('Cancelled', null, 'cancel')); kill(); },
    };
  }

  // ── Script indicators on the chart: computed in a worker, never on the main thread ─────────────────
  // chartview calls def.calc() synchronously on every update. A worker-backed def returns the last worker result for the same
  // symbol / timeframe / inputs at once (re-aligned to the current bars) and schedules a debounced recompute when the bars
  // changed; when it arrives, the charts showing the study are re-rendered (renderStudies 'tail' when only the last bars changed,
  // 'full' otherwise; renderMain when barcolor() colours changed). A failing or runaway script shows an error label and is not
  // retried on every tick: it waits for a new bar or new inputs. def.pineExtras(symbol, tfSec, params) exposes barcolor /
  // plotcandle / table results to pine-render.js.
  let CHART_HOST = null;
  const chartHost = () => CHART_HOST || (CHART_HOST = createScriptHost());
  const IND_TIMEOUT = 10000, IND_LIMIT = 5000, IND_DEBOUNCE = 250;
  const studyKey = (symbol, tfSec, params) => `${symbol || ''}|${tfSec || 0}|${JSON.stringify(params || {})}`;
  const dataSig = (c) => { const n = c.length, a = n ? c[n - 1] : null; return n ? `${n}:${c[0].time}:${a.time}:${a.open}:${a.high}:${a.low}:${a.close}:${a.volume || 0}` : '0'; };
  function studyTfSec(view, st) {
    if (!st.tf || st.tf === view.state.interval) return view.tfSec;
    const sp = G.IGC && G.IGC.iv && G.IGC.iv.parse(st.tf);
    return sp && sp.kind === 'time' ? sp.sec : 60;
  }
  const repaints = new Map();
  function repaint(defId, key, how) {
    const views = (G.IGApp && G.IGApp.views) || [];
    for (const v of views) {
      if (!v || !v.state || !Array.isArray(v.state.studies)) continue;
      if (!v.state.studies.some((st) => st.id === defId && st.visible !== false && studyKey(v.state.symbol, studyTfSec(v, st), st.params) === key)) continue;
      const p = repaints.get(v) || { full: false, main: 0 };
      p.full = p.full || how.full; p.main = Math.max(p.main, how.main);
      if (!repaints.has(v)) {
        repaints.set(v, p);
        const raf = typeof requestAnimationFrame === 'function' ? requestAnimationFrame : (f) => setTimeout(f, 16);
        raf(() => {
          const q = repaints.get(v); repaints.delete(v);
          try {
            if (q.main && typeof v.renderMain === 'function') v.renderMain(q.main === 2);
            if (typeof v.renderStudies === 'function') v.renderStudies(q.full ? 'full' : 'tail');
            if (typeof v.updateLegend === 'function') v.updateLegend();
          } catch (e) { console.warn('[script indicator]', e); }
        });
      }
    }
  }
  // how much changed between two results: { full: values before the last two bars / drawings changed, main: 0 | 1 tail | 2 all }
  function diffOut(a, b, keys) {
    if (!a || !b || a.__n !== b.__n || a.__t0 !== b.__t0) return { full: true, main: 2 };
    const n = b.__n;
    let full = false;
    for (const k of keys) {
      const x = a[k], y = b[k];
      if (!x || !y || x.length !== y.length) { full = true; break; }
      for (let i = 0; i < n - 2; i++) { const p = x[i], q = y[i]; if (p !== q && !(p !== p && q !== q)) { full = true; break; } }
      if (full) break;
    }
    if (!full) full = JSON.stringify([a.markers || null, a.graphics || null, a.colors || null]) !== JSON.stringify([b.markers || null, b.graphics || null, b.colors || null]);
    const ba = a.pine && a.pine.barColors, bb = b.pine && b.pine.barColors;
    let main = 0;
    if (ba || bb) {
      if (!ba || !bb || ba.length !== bb.length) main = 2;
      else { for (let i = 0; i < bb.length; i++) if (ba[i] !== bb[i]) { main = i >= bb.length - 2 ? Math.max(main, 1) : 2; if (main === 2) break; } }
    }
    return { full, main };
  }
  function jsOut(r, n, outs) {
    const out = {};
    outs.forEach((o, j) => { out[o.k] = r.plots[j] ? r.plots[j].values : new Array(n).fill(NA); });
    if (r.markers && r.markers.length) out.markers = r.markers;
    return out;
  }
  function errorOutput(outs, candles, e, lang) {
    const out = {};
    for (const o of outs) out[o.k] = new Array(candles.length).fill(NA);
    const last = candles[candles.length - 1], where = e && e.line ? `line ${e.line}${e.col ? `:${e.col}` : ''}: ` : '';
    if (last) out.graphics = [{ kind: 'label', t: last.time, p: last.close, text: `${lang === 'pine' ? 'Pine' : 'Script'} error: ${where}${(e && e.message) || e}`, color: '#FFFFFF', bg: '#ef5350', align: 'right', base: 'bottom' }];
    return out;
  }
  function workerIndicator(def, script, lang, hostFn = chartHost) {
    const cache = new Map(), outs = def.outputs || [], keys = outs.map((o) => o.k);
    const toOut = (res, n) => {
      if (lang === 'pine') { def.fills = res.pine.fills; return G.IGPine.indicatorOut(res.pine, n); }
      return jsOut(res.js, n, outs);
    };
    function align(e, candles) {
      const n = candles.length, out = e.out, T = e.times, m = T.length;
      if (m === n && T[0] === candles[0].time && T[m - 1] === candles[n - 1].time) return out;
      const sig = `${n}:${candles[0].time}:${m}`;
      if (e.aligned && e.aligned.sig === sig) return e.aligned.out;
      let d = 0;
      const t0 = candles[0].time;
      if (T[0] !== t0) {
        let lo = 0, hi = m - 1, j = -1;
        while (lo <= hi) { const k = (lo + hi) >> 1; if (T[k] === t0) { j = k; break; } if (T[k] < t0) lo = k + 1; else hi = k - 1; }
        if (j >= 0) d = j;
        else { let i = 0; while (i < n && candles[i].time < T[0]) i++; d = i < n && candles[i].time === T[0] ? -i : null; }
      }
      const res = { ...out };
      const shift = (a) => { const r = new Array(n); for (let i = 0; i < n; i++) { const j = d === null ? -1 : i + d; r[i] = j >= 0 && j < m ? a[j] : NA; } return r; };
      for (const k of keys) if (Array.isArray(out[k]) || ArrayBuffer.isView(out[k])) res[k] = shift(out[k]);
      if (out.colors) { res.colors = {}; for (const k of Object.keys(out.colors)) res.colors[k] = shift(out.colors[k]).map((c) => (c === NA || c !== c ? undefined : c)); }
      e.aligned = { sig, out: res };
      return res;
    }
    function schedule(e, ms) { if (e.timer) return; e.timer = setTimeout(() => { e.timer = 0; start(e); }, ms); }
    function start(e) {
      const { candles, params, cx } = e.input, n = candles.length, sig = dataSig(candles);
      if (!n || sig === e.sig || e.busy) return;
      if (e.failSig && e.failSig === `${n}:${candles[0].time}:${JSON.stringify(params)}`) return;
      e.busy = true; e.dirty = false;
      let srcs = null;
      if (lang === 'pine' && typeof cx.src === 'function') {
        for (const p of def.params || []) {
          if (p.type !== 'source') continue;
          const v = params[p.k] !== undefined ? params[p.k] : p.def;
          if (!v || SOURCES.includes(v)) continue;
          const a = cx.src(v);
          if (a && a.length === n) (srcs || (srcs = {}))[v] = Float64Array.from(a, (x) => (x === null || x === undefined ? NA : +x));
        }
      }
      const times = candles.map((b) => b.time);
      const job = { op: 'compile', lang, kind: 'indicator', code: script.code, values: params, tfSec: cx.tfSec, symbol: cx.symbol, decimals: cx.decimals, timeLimit: IND_LIMIT, srcs };
      let next;
      hostFn().run(job, { candles, stream: `ind:${cx.symbol}:${cx.tfSec}`, timeout: IND_TIMEOUT })
        .then((res) => { next = toOut(res, n); e.err = null; e.failSig = null; }, (err) => { next = errorOutput(outs, candles, err, lang); e.err = err; e.failSig = `${n}:${candles[0].time}:${JSON.stringify(params)}`; })
        .then(() => {
          next.__n = n; next.__t0 = candles[0].time;
          const how = diffOut(e.out, next, keys);
          e.out = next; e.times = times; e.aligned = null; e.sig = sig; e.busy = false;
          repaint(def.id, e.key, how);
          if (e.dirty || dataSig(e.input.candles) !== e.sig) schedule(e, IND_DEBOUNCE);
        });
    }
    def.worker = true;
    def.calc = function (candles, params, cx) {
      const n = candles ? candles.length : 0;
      if (!n) return {};
      const key = studyKey(cx && cx.symbol, cx && cx.tfSec, params);
      let e = cache.get(key);
      if (e) { cache.delete(key); cache.set(key, e); } else {
        e = { key, out: null, times: null, sig: null, busy: false, timer: 0 };
        cache.set(key, e);
        while (cache.size > 8) { const k = cache.keys().next().value; clearTimeout(cache.get(k).timer); cache.delete(k); }
      }
      e.input = { candles, params: params || {}, cx: cx || {} };
      if (dataSig(candles) !== e.sig) { if (e.busy) e.dirty = true; else schedule(e, e.out ? IND_DEBOUNCE : 0); }
      return e.out ? align(e, candles) : {};
    };
    // barcolor / plotcandle / table results for pine-render.js (times: the bar times the arrays are indexed by)
    def.pineExtras = (symbol, tfSec, params) => {
      const e = cache.get(studyKey(symbol, tfSec, params));
      return e && e.out && e.out.pine ? { ...e.out.pine, times: e.times } : null;
    };
    def.lastError = (symbol, tfSec, params) => { const e = cache.get(studyKey(symbol, tfSec, params)); return e ? e.err : null; };
    return def;
  }

  // ── Deep backtest data ────────────────────────────────
  const DEEP_MAX = 30000, DEEP_FALLBACK = 5000;
  const dstr = (t) => { if (t === null || t === undefined || t === '') return ''; const x = typeof t === 'number' ? (t > 1e11 ? t : t * 1000) : Date.parse(t); return ok(x) ? new Date(x).toISOString().slice(0, 10) : String(t); };
  // Server `sources` metadata, whatever its exact shape (array of { name|source|id, from|start, to|end, bars|count } or an object).
  function fmtSources(src) {
    if (!src) return '';
    const one = (s, k) => {
      if (typeof s === 'string') return s;
      if (!s || typeof s !== 'object') return String(s);
      const nm = s.name || s.source || s.provider || s.id || k || 'source', a = s.from || s.start || s.first, b = s.to || s.end || s.last, cnt = s.bars || s.count || s.candles;
      return `${nm}${a || b ? ` ${dstr(a)} → ${dstr(b)}` : ''}${ok(+cnt) ? ` (${(+cnt).toLocaleString('en-US')} bars)` : ''}`;
    };
    if (Array.isArray(src)) return src.map((s) => one(s)).join(' + ');
    if (typeof src === 'object') return Object.entries(src).map(([k, v]) => (v && typeof v === 'object' ? one(v, k) : `${k}: ${v}`)).join(' · ');
    return String(src);
  }

  const PT = (name, kind, code) => ({ name: `Pine · ${name}`, kind, lang: 'pine', code });
  TEMPLATES.push(
    PT('EMA cross strategy', 'strategy', `//@version=5
strategy("EMA Cross", overlay=true)
fastLen = input.int(9, "Fast EMA", minval=1)
slowLen = input.int(21, "Slow EMA", minval=1)
fast = ta.ema(close, fastLen)
slow = ta.ema(close, slowLen)
if ta.crossover(fast, slow)
    strategy.entry("Long", strategy.long)
if ta.crossunder(fast, slow)
    strategy.entry("Short", strategy.short)
plot(fast, "Fast", color.orange)
plot(slow, "Slow", color.blue)
`),
    PT('RSI with stop / target', 'strategy', `//@version=5
strategy("RSI reversal", overlay=true)
len = input.int(14, "RSI length")
os = input.float(30, "Oversold")
ob = input.float(70, "Overbought")
slTicks = input.int(500, "Stop (ticks)")
tpTicks = input.int(1000, "Target (ticks)")
r = ta.rsi(close, len)
if ta.crossover(r, os)
    strategy.entry("L", strategy.long)
if ta.crossunder(r, ob)
    strategy.entry("S", strategy.short)
strategy.exit("XL", "L", loss=slTicks, profit=tpTicks)
strategy.exit("XS", "S", loss=slTicks, profit=tpTicks)
`),
    PT('RSI + levels (pane)', 'indicator', `//@version=5
indicator("RSI", overlay=false)
len = input.int(14, "Length", minval=1)
src = input.source(close, "Source")
r = ta.rsi(src, len)
plot(r, "RSI", color=#7E57C2, linewidth=2)
top = hline(70, "Overbought", color=color.gray)
bot = hline(30, "Oversold", color=color.gray)
fill(top, bot, color=color.new(color.purple, 90))
plotshape(ta.crossover(r, 30), "Up", shape.triangleup, location.bottom, color.green)
`),
    PT('Supertrend', 'indicator', `//@version=5
indicator("Supertrend", overlay=true)
atrLen = input.int(10, "ATR length")
factor = input.float(3.0, "Factor", step=0.1)
[st, dir] = ta.supertrend(factor, atrLen)
plot(dir < 0 ? st : na, "Up trend", color.green, style=plot.style_linebr)
plot(dir > 0 ? st : na, "Down trend", color.red, style=plot.style_linebr)
plotshape(ta.change(dir) < 0, "Buy", shape.labelup, location.belowbar, color.green, text="Buy")
plotshape(ta.change(dir) > 0, "Sell", shape.labeldown, location.abovebar, color.red, text="Sell")
`),
    PT('Bollinger Bands + fill', 'indicator', `//@version=5
indicator("BB", overlay=true)
len = input.int(20, "Length")
mult = input.float(2.0, "StdDev")
[basis, upper, lower] = ta.bb(close, len, mult)
plot(basis, "Basis", color.orange)
u = plot(upper, "Upper", color.blue)
l = plot(lower, "Lower", color.blue)
fill(u, l, color=color.new(color.blue, 90))
bgcolor(close > upper ? color.new(color.green, 85) : close < lower ? color.new(color.red, 85) : na)
`),
    PT('Pivot labels + lines', 'indicator', `//@version=5
indicator("Pivots", overlay=true, max_labels_count=200, max_lines_count=50)
left = input.int(5, "Left bars")
right = input.int(5, "Right bars")
ph = ta.pivothigh(high, left, right)
pl = ta.pivotlow(low, left, right)
var line lastHigh = na
if not na(ph)
    label.new(bar_index - right, ph, str.tostring(ph, format.mintick), color=color.red, textcolor=color.white, style=label.style_label_down)
    line.delete(lastHigh)
    lastHigh := line.new(bar_index - right, ph, bar_index, ph, extend=extend.right, color=color.red, style=line.style_dashed)
if not na(pl)
    label.new(bar_index - right, pl, str.tostring(pl, format.mintick), color=color.green, textcolor=color.white, style=label.style_label_up)
`),
    PT('Higher-timeframe EMA', 'indicator', `//@version=5
indicator("HTF EMA", overlay=true)
tf = input.timeframe("60", "Timeframe")
len = input.int(50, "EMA length")
htf = request.security(syminfo.tickerid, tf, ta.ema(close, len))
plot(htf, "HTF EMA", color.yellow, 2)
`),
    PT('Arrays: rolling median', 'indicator', `//@version=5
indicator("Rolling median", overlay=true)
len = input.int(30, "Window")
var window = array.new_float(0)
array.push(window, close)
if array.size(window) > len
    array.shift(window)
med = array.size(window) == len ? array.median(window) : na
plot(med, "Median", color.teal, 2)
`),
  );
  const JS_REF = 'ctx.open/high/low/close/volume/time/hl2/hlc3, ctx.n, ctx.bars<br>ctx.ta.sma/ema/rma/wma/stdev/highest/lowest/atr(bars,n)/rsi<br>ctx.ta.crossover(a,b[,i]) / crossunder / change(a,len[,i])<br>ctx.input(name, default, {min,max,step,options})<br>ctx.series(i => …), ctx.check()<br>Strategy → { long, short, exitLong?, exitShort?, stop?, limit? }<br>Indicator → { plots:[{name, values, color, pane, type}], markers? }<br>Runs in a worker; stopped after the script time limit.';
  const PINE_REF = 'Pine v5 (v4 names accepted): indicator / strategy, input.*, var / varip, x[n], if / for / while / switch, functions, tuples, arrays, math.* / str.* / color.*, ta.* (sma ema rma wma vwma hma rsi macd stoch atr bb kc supertrend pivots sar dmi linreg alma tsi …), plot / plotshape / hline / fill / bgcolor, label / line / box, request.security (chart symbol, higher TF from loaded bars), strategy.entry / exit / close.<br>Not supported: user types, imports, map / matrix, strategy.order — reported with line:column.';

  // ── UI helpers ────────────────────────────────────────
  const esc = (s) => String(s === undefined || s === null ? '' : s).replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]));
  const group = (v, d = 2) => { const s = Math.abs(v).toFixed(d).split('.'); s[0] = s[0].replace(/\B(?=(\d{3})+(?!\d))/g, ','); return s.join('.'); };
  const money = (v) => (v === null || v === undefined || !ok(v) ? '—' : `${v < 0 ? '−' : ''}${group(v)}`);
  const pctf = (v) => (v === null || v === undefined || !ok(v) ? '' : `${v < 0 ? '−' : ''}${group(v)}%`);
  const numf = (v, d = 2) => (v === null || v === undefined || !ok(v) ? '—' : `${v < 0 ? '−' : ''}${group(v, d)}`);
  const cls = (v) => (v > 0 ? 'igs-up' : v < 0 ? 'igs-dn' : '');
  const toDate = (t) => (t > 0 ? new Date(t * 1000).toISOString().slice(0, 10) : '');
  const fromDate = (s) => (s ? Math.floor(Date.parse(`${s}T00:00:00Z`) / 1000) : 0);
  function download(name, text, type = 'text/csv') {
    const url = URL.createObjectURL(new Blob([text], { type }));
    const a = document.createElement('a');
    a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  const csvCell = (v) => { const s = v === null || v === undefined ? '' : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  const csv = (rows) => rows.map((r) => r.map(csvCell).join(',')).join('\n');

  const PROP_SCHEMA = [
    { k: 'capital', label: 'Initial capital', type: 'number', def: 10000, min: 0, step: 100 },
    { k: 'sizeType', label: 'Order size type', type: 'select', options: [{ v: 'percent', l: '% of equity' }, { v: 'qty', l: 'Contracts' }, { v: 'cash', l: 'Cash' }], def: 'percent' },
    { k: 'size', label: 'Order size', type: 'number', def: 100, min: 0, step: 1 },
    { k: 'pyramiding', label: 'Pyramiding', type: 'int', def: 1, min: 1, max: 100, step: 1 },
    { k: 'commType', label: 'Commission type', type: 'select', options: [{ v: 'percent', l: '% of value' }, { v: 'cash', l: 'Cash per order' }], def: 'percent' },
    { k: 'commission', label: 'Commission', type: 'number', def: 0, min: 0, step: 0.01 },
    { k: 'slippage', label: 'Slippage (price)', type: 'number', def: 0, min: 0, step: 0.0001 },
    { k: 'fill', label: 'Process orders on', type: 'select', options: [{ v: 'open', l: 'Next bar open' }, { v: 'close', l: 'Signal bar close' }], def: 'open' },
    { k: 'magnifier', label: 'Bar magnifier', type: 'bool', def: false },
    { k: 'direction', label: 'Direction', type: 'select', options: [{ v: 'both', l: 'Long & short' }, { v: 'long', l: 'Long only' }, { v: 'short', l: 'Short only' }], def: 'both' },
    { k: 'reverse', label: 'Reverse on opposite signal', type: 'bool', def: true },
    { k: 'slType', label: 'Stop loss', type: 'select', options: [{ v: 'none', l: 'Off' }, { v: 'percent', l: '%' }, { v: 'atr', l: 'ATR ×' }], def: 'none' },
    { k: 'sl', label: 'Stop value', type: 'number', def: 2, min: 0, step: 0.1 },
    { k: 'tpType', label: 'Take profit', type: 'select', options: [{ v: 'none', l: 'Off' }, { v: 'percent', l: '%' }, { v: 'atr', l: 'ATR ×' }], def: 'none' },
    { k: 'tp', label: 'Target value', type: 'number', def: 4, min: 0, step: 0.1 },
    { k: 'atrLen', label: 'ATR length', type: 'int', def: 14, min: 1, max: 500, step: 1 },
    { k: 'from', label: 'From date', type: 'time', def: 0 },
    { k: 'to', label: 'To date', type: 'time', def: 0 },
    { k: 'marginLong', label: 'Margin long %', type: 'number', def: 0, min: 0, step: 1, h: 'Risk management · 0 = off' },
    { k: 'marginShort', label: 'Margin short %', type: 'number', def: 0, min: 0, step: 1 },
    { k: 'maxIntradayLossType', label: 'Intraday loss in', type: 'select', options: [{ v: 'percent', l: '% of day start' }, { v: 'cash', l: 'Cash' }], def: 'percent' },
    { k: 'maxIntradayLoss', label: 'Max intraday loss', type: 'number', def: 0, min: 0, step: 0.5 },
    { k: 'maxDDStop', label: 'Max DD stop %', type: 'number', def: 0, min: 0, step: 1 },
    { k: 'maxConsLossDays', label: 'Max losing days', type: 'int', def: 0, min: 0, max: 1000, step: 1 },
  ];
  const defaults = (schema) => Object.fromEntries((schema || []).map((x) => [x.k, x.def]));

  function fieldHTML(f, v) {
    const k = esc(f.k), lab = `<label class="igs-lbl" title="${esc(f.label || f.k)}">${esc(f.label || f.k)}</label>`;
    const attrs = ['min', 'max', 'step'].filter((a) => f[a] !== undefined && f[a] !== null).map((a) => `${a}="${f[a]}"`).join(' ');
    if (f.type === 'bool') return `${lab}<input type="checkbox" data-k="${k}" data-t="bool"${v ? ' checked' : ''}>`;
    if (f.type === 'source') return `${lab}<select data-k="${k}" data-t="select">${SOURCES.map((o) => `<option value="${o}"${o === v ? ' selected' : ''}>${o}</option>`).join('')}</select>`;
    if (f.type === 'select') return `${lab}<select data-k="${k}" data-t="select">${f.options.map((o) => { const ov = typeof o === 'object' ? o.v : o, ol = typeof o === 'object' ? o.l : o; return `<option value="${esc(ov)}"${String(ov) === String(v) ? ' selected' : ''}>${esc(ol)}</option>`; }).join('')}</select>`;
    if (f.type === 'color') return `${lab}<input type="color" data-k="${k}" data-t="color" value="${esc(v)}">`;
    if (f.type === 'time') return `${lab}<input type="date" data-k="${k}" data-t="time" value="${toDate(v)}">`;
    if (f.type === 'int' || f.type === 'number') return `${lab}<input type="number" data-k="${k}" data-t="${f.type}" ${attrs} value="${esc(v)}">`;
    return `${lab}<input type="text" data-k="${k}" data-t="text" value="${esc(v)}">`;
  }
  function readField(el) {
    const t = el.dataset.t;
    if (t === 'bool') return el.checked;
    if (t === 'int') return Math.round(+el.value);
    if (t === 'number') return +el.value;
    if (t === 'time') return fromDate(el.value);
    return el.value;
  }

  const CSS = `
.igs-root { display: flex; flex-direction: column; height: 100%; min-height: 0; background: var(--panel); color: var(--text); font-size: 12.5px; }
.igs-head { display: flex; align-items: center; gap: 4px; padding: 0 8px; height: 36px; border-bottom: 1px solid var(--line); flex: none; }
.igs-tab, .igs-sub { background: none; border: 0; color: var(--muted); padding: 0 10px; height: 100%; cursor: pointer; font: inherit; font-weight: 600; border-bottom: 2px solid transparent; }
.igs-tab:hover, .igs-sub:hover { color: var(--text); }
.igs-tab.on, .igs-sub.on { color: var(--text); border-bottom-color: var(--accent); }
.igs-sp { flex: 1; }
.igs-btn { background: var(--bg); color: var(--text); border: 1px solid var(--line); border-radius: 4px; padding: 0 9px; height: 26px; cursor: pointer; font: inherit; white-space: nowrap; display: inline-flex; align-items: center; gap: 4px; }
.igs-btn:hover { background: var(--hover); }
.igs-btn[hidden] { display: none; }
.igs-btn.pri { background: var(--accent); border-color: var(--accent); color: #fff; }
.igs-btn.on { color: var(--accent); background: var(--accent-soft); border-color: var(--accent); }
.igs-root select, .igs-root input[type=text], .igs-root input[type=number], .igs-root input[type=date] { background: var(--bg); color: var(--text); border: 1px solid var(--line); border-radius: 4px; padding: 0 6px; height: 26px; font: inherit; min-width: 0; outline: none; }
.igs-root select:focus, .igs-root input:focus { border-color: var(--accent); }
.igs-toggle { display: inline-flex; align-items: center; gap: 6px; color: var(--muted); cursor: pointer; user-select: none; padding: 0 6px; }
.igs-toggle i { width: 28px; height: 16px; border-radius: 8px; background: var(--line); position: relative; transition: background .15s; }
.igs-toggle i::after { content: ''; position: absolute; top: 2px; left: 2px; width: 12px; height: 12px; border-radius: 50%; background: #fff; transition: left .15s; }
.igs-toggle.on i { background: var(--accent); }
.igs-toggle.on i::after { left: 14px; }
.igs-body { flex: 1; min-height: 0; display: flex; }
.igs-pane { flex: 1; min-width: 0; min-height: 0; display: flex; }
.igs-form { width: 270px; flex: none; border-right: 1px solid var(--line); overflow: auto; padding: 6px 10px 12px; }
.igs-form h4, .igs-side h4 { margin: 10px 0 6px; font-size: 11px; text-transform: uppercase; letter-spacing: .04em; color: var(--muted); font-weight: 600; }
.igs-grid { display: grid; grid-template-columns: minmax(0, 1fr) 120px; gap: 5px 8px; align-items: center; }
.igs-grid select, .igs-grid input[type=number], .igs-grid input[type=date], .igs-grid input[type=text] { width: 100%; }
.igs-grid input[type=checkbox] { justify-self: start; accent-color: var(--accent); }
.igs-grid input[type=color] { width: 44px; height: 24px; border: 1px solid var(--line); border-radius: 4px; background: var(--bg); padding: 1px; }
.igs-lbl { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; color: var(--text); }
.igs-main { flex: 1; min-width: 0; display: flex; flex-direction: column; min-height: 0; }
.igs-subbar { display: flex; align-items: center; gap: 4px; height: 32px; padding: 0 8px 0 4px; border-bottom: 1px solid var(--line); flex: none; }
.igs-info { color: var(--muted); font-size: 11.5px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; padding: 0 6px; }
.igs-view { flex: 1; min-height: 0; overflow: auto; position: relative; }
.igs-ov { display: flex; flex-direction: column; height: 100%; min-height: 220px; }
.igs-kpis { display: grid; grid-template-columns: repeat(7, minmax(0, 1fr)); border-bottom: 1px solid var(--line); flex: none; }
.igs-kpi { padding: 7px 10px; border-right: 1px solid var(--line); min-width: 0; }
.igs-kpi:last-child { border-right: 0; }
.igs-kpi small { display: block; color: var(--muted); font-size: 11px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.igs-kpi b { font-size: 14px; font-variant-numeric: tabular-nums; white-space: nowrap; }
.igs-kpi em { font-style: normal; font-size: 11px; margin-left: 4px; color: var(--muted); }
.igs-chart { flex: 1; min-height: 120px; position: relative; }
.igs-legend { position: absolute; top: 6px; left: 10px; z-index: 3; display: flex; gap: 12px; font-size: 11px; color: var(--muted); pointer-events: none; }
.igs-legend span::before { content: ''; display: inline-block; width: 10px; height: 3px; margin-right: 5px; vertical-align: middle; background: var(--c); }
.igs-table { width: 100%; border-collapse: collapse; font-variant-numeric: tabular-nums; }
.igs-table th, .igs-table td { padding: 5px 10px; text-align: right; border-bottom: 1px solid var(--line); white-space: nowrap; }
.igs-table th { position: sticky; top: 0; background: var(--panel-2); color: var(--muted); font-weight: 600; z-index: 1; }
.igs-table th:first-child, .igs-table td:first-child { text-align: left; }
.igs-table td small { display: block; color: var(--muted); font-size: 11px; }
.igs-table th[data-s] { cursor: pointer; }
.igs-table th[data-s]:hover { color: var(--text); }
.igs-table th .ar { color: var(--accent); }
.igs-trades tbody tr { cursor: pointer; }
.igs-trades tbody tr.ex td { border-bottom-color: var(--line); }
.igs-trades tbody tr.en td { border-bottom-color: transparent; }
.igs-trades tbody tr:hover td { background: var(--hover); }
.igs-trades tbody tr.sel td { background: var(--accent-soft); }
.igs-trades td.ty, .igs-trades th.l { text-align: left; }
.igs-up { color: var(--up); } .igs-dn { color: var(--down); }
.igs-empty { padding: 24px; color: var(--muted); text-align: center; }
.igs-err { color: var(--down); }
.igs-kv { display: grid; grid-template-columns: max-content 1fr; gap: 4px 24px; padding: 12px 14px; }
.igs-kv div:nth-child(odd) { color: var(--muted); }
.igs-ed { flex: 1; min-width: 0; display: flex; flex-direction: column; min-height: 0; }
.igs-edbar { display: flex; align-items: center; gap: 5px; padding: 5px 8px; border-bottom: 1px solid var(--line); flex: none; flex-wrap: wrap; }
.igs-edbar input[type=text] { width: 150px; }
.igs-edbar .igs-tpl { max-width: 190px; }
.igs-ref { line-height: 1.5; overflow-wrap: anywhere; font-size: 11.5px; }
.igs-edmain { flex: 1; min-height: 0; display: flex; }
.igs-code { flex: 1; min-width: 0; display: flex; background: var(--bg); position: relative; overflow: hidden; }
.igs-gut, .igs-ta { font: 12.5px/18px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; padding: 8px 0; margin: 0; }
.igs-gut { width: 46px; flex: none; text-align: right; color: var(--muted); background: var(--panel-2); border-right: 1px solid var(--line); overflow: hidden; user-select: none; padding-right: 8px; white-space: pre; }
.igs-gut .e { color: #fff; background: var(--down); }
.igs-ta { flex: 1; min-width: 0; resize: none; border: 0; outline: none; background: transparent; color: var(--text); padding-left: 10px; padding-right: 10px; white-space: pre; overflow: auto; tab-size: 2; }
.igs-side { width: 240px; flex: none; border-left: 1px solid var(--line); overflow: auto; padding: 0 10px 10px; }
.igs-side .igs-scripts { display: flex; flex-direction: column; gap: 1px; margin: 0; padding: 0; list-style: none; }
.igs-side .igs-scripts li { display: flex; align-items: center; justify-content: space-between; gap: 6px; padding: 4px 6px; border-radius: 4px; cursor: pointer; }
.igs-side .igs-scripts li:hover { background: var(--hover); }
.igs-side .igs-scripts li.on { background: var(--accent-soft); color: var(--accent); }
.igs-side .igs-scripts li small { color: var(--muted); font-size: 10.5px; text-transform: uppercase; }
.igs-console { height: 92px; flex: none; border-top: 1px solid var(--line); overflow: auto; font: 11.5px/16px ui-monospace, SFMono-Regular, Menlo, monospace; padding: 4px 10px; background: var(--panel-2); }
.igs-console div { white-space: pre-wrap; }
.igs-console .w { color: #f7b924; }
.igs-console .ok { color: var(--up); }
.igs-console .t { color: var(--muted); margin-right: 6px; }
.igs-gh { grid-column: 1 / -1; margin: 8px 0 0 !important; }
.igs-notes { flex: none; padding: 3px 12px; border-bottom: 1px solid var(--line); color: var(--muted); font-size: 11.5px; display: flex; flex-direction: column; gap: 1px; }
.igs-notes:empty { display: none; }
.igs-notes div { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.igs-notes .w { color: #f7b924; }
.igs-notes .e { color: var(--down); }
.igs-mag { display: inline-block; margin-left: 5px; padding: 0 4px; border-radius: 3px; font-size: 10px; line-height: 14px; color: var(--accent); border: 1px solid var(--accent); vertical-align: 1px; }
.igs-toggle.dis { opacity: .5; }
.igs-opt { display: flex; height: 100%; min-height: 0; }
.igs-optcfg { width: 330px; flex: none; overflow: auto; border-right: 1px solid var(--line); padding: 4px 10px 10px; }
.igs-optcfg h4 { margin: 8px 0 5px; font-size: 11px; text-transform: uppercase; letter-spacing: .04em; color: var(--muted); font-weight: 600; }
.igs-rng { width: 100%; border-collapse: collapse; font-variant-numeric: tabular-nums; }
.igs-rng th { color: var(--muted); font-weight: 600; font-size: 11px; text-align: left; padding: 2px 3px; }
.igs-rng td { padding: 2px 3px; }
.igs-rng td:nth-child(2) { max-width: 110px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.igs-rng input[type=number] { width: 58px; height: 24px !important; }
.igs-rng td.cnt { color: var(--muted); text-align: right; min-width: 26px; }
.igs-rng tr.off td:not(:first-child) { opacity: .45; }
.igs-optbar { display: flex; align-items: center; gap: 6px; margin-top: 10px; flex-wrap: wrap; }
.igs-prog { height: 4px; border-radius: 2px; background: var(--line); margin-top: 8px; overflow: hidden; }
.igs-prog i { display: block; height: 100%; width: 0; background: var(--accent); transition: width .1s; }
.igs-optstat { color: var(--muted); font-size: 11.5px; margin-top: 4px; min-height: 16px; }
.igs-warn { color: var(--muted); font-size: 11px; margin-top: 6px; line-height: 1.35; }
.igs-optres { flex: 1; min-width: 0; min-height: 0; display: flex; }
.igs-heat { width: 330px; flex: none; position: relative; border-right: 1px solid var(--line); padding: 6px 8px; overflow: hidden; display: flex; flex-direction: column; }
.igs-heat canvas { flex: 1; min-height: 0; width: 100%; display: block; cursor: crosshair; }
.igs-heat .ttl { font-size: 11px; color: var(--muted); margin-bottom: 4px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.igs-tip { position: absolute; pointer-events: none; z-index: 5; background: var(--panel-2); border: 1px solid var(--line); border-radius: 4px; padding: 4px 7px; font-size: 11px; white-space: nowrap; box-shadow: 0 2px 8px rgba(0,0,0,.3); }
.igs-opttab { flex: 1; min-width: 0; overflow: auto; }
.igs-opttab .igs-table td, .igs-opttab .igs-table th { padding: 4px 6px; }
.igs-opttab tr.best td { background: var(--accent-soft); }
.igs-opttab .igs-btn { height: 22px; padding: 0 7px; }
@media (max-width: 1250px) { .igs-optres { flex-direction: column; } .igs-heat { width: auto; height: 220px; flex: none; border-right: 0; border-bottom: 1px solid var(--line); } }
@media (max-width: 760px) { .igs-form, .igs-side { display: none; } .igs-kpis { grid-template-columns: repeat(3, minmax(0, 1fr)); } }
@media (max-width: 760px) { .igs-opt { flex-direction: column; } .igs-optcfg { width: auto; border-right: 0; } }
`;

  // ── mount ─────────────────────────────────────────────
  function mount(el, host) {
    if (!document.getElementById('igs-style')) {
      const st = document.createElement('style');
      st.id = 'igs-style'; st.textContent = CSS; document.head.appendChild(st);
    }
    const store = host.store || { get: (k, d) => d, set() {} };
    const saved = store.get('strategy', null) || {};
    const S = {
      on: saved.on !== false, tab: saved.tab || 'tester', sub: saved.sub || 'overview', stratId: saved.stratId || 'ma_cross',
      params: saved.params || {}, props: { ...defaults(PROP_SCHEMA), ...(saved.props || {}) }, showForm: saved.showForm !== false,
      sort: { k: 'id', d: -1 }, sel: null, result: null, error: null, schemas: {},
      alerts: !!saved.alerts, alertLast: saved.alertLast || {}, opt: saved.opt || {}, optCfg: { metric: 'netProfit', max: 500, wf: false, isPct: 70, ...(saved.optCfg || {}) }, notes: {},
      ed: { name: saved.edName || '', kind: saved.edKind || 'strategy', lang: saved.edLang || (isPine(saved.edCode) ? 'pine' : 'js'), code: saved.edCode || TEMPLATES[0].code, values: {}, inputs: [], errLine: null },
      timeout: ok(+saved.timeout) && saved.timeout > 0 ? +saved.timeout : 10,
      deep: { mode: 'bars', bars: 20000, from: 0, to: 0, ...(saved.deep || {}) }, deepRes: null, deepRun: null, view: 'quick', busy: null,
    };
    const persist = () => store.set('strategy', { on: S.on, tab: S.tab, sub: S.sub, stratId: S.stratId, params: S.params, props: S.props, showForm: S.showForm, edName: S.ed.name, edKind: S.ed.kind, edLang: S.ed.lang, edCode: S.ed.code, alerts: S.alerts, alertLast: S.alertLast, opt: S.opt, optCfg: S.optCfg, timeout: S.timeout, deep: S.deep });
    const SH = createScriptHost();
    const tmo = () => Math.max(1, S.timeout) * 1000;
    const cur = () => (S.view === 'deep' && S.deepRes) || S.result;
    const scripts = () => (store.get('scripts', []) || []).filter((s) => s && s.name);
    const saveScripts = (list) => store.set('scripts', list);
    scriptSource = scripts;
    const fmtP = (v) => (host.fmt ? host.fmt(v) : numf(v, 4));
    const fmtT = (t) => (host.fmtTime ? host.fmtTime(t) : new Date(t * 1000).toISOString().slice(0, 16).replace('T', ' '));

    el.innerHTML = `<div class="igs-root">
      <div class="igs-head">
        <button class="igs-tab" data-tab="tester">Strategy Tester</button>
        <button class="igs-tab" data-tab="editor">Script Editor</button>
        <span class="igs-sp"></span>
        <span class="igs-hst"></span>
      </div>
      <div class="igs-body">
        <div class="igs-pane" data-p="tester">
          <div class="igs-form"></div>
          <div class="igs-main">
            <div class="igs-subbar">
              <button class="igs-sub" data-sub="overview">Overview</button>
              <button class="igs-sub" data-sub="summary">Performance Summary</button>
              <button class="igs-sub" data-sub="trades">List of Trades</button>
              <button class="igs-sub" data-sub="opt">Optimizer</button>
              <button class="igs-sub" data-sub="props">Properties</button>
              <span class="igs-info"></span>
              <span class="igs-sp"></span>
              <button class="igs-btn" data-act="csv-trades" title="Export list of trades as CSV">Trades CSV</button>
              <button class="igs-btn" data-act="csv-perf" title="Export performance summary as CSV">Performance CSV</button>
              <button class="igs-btn" data-act="xlsx" title="Export trades, performance summary and properties as an Excel workbook">XLSX</button>
            </div>
            <div class="igs-notes"></div>
            <div class="igs-view">
              <div class="igs-ov" data-v="overview"><div class="igs-kpis"></div><div class="igs-chart"><div class="igs-legend"></div></div></div>
              <div data-v="summary"></div>
              <div data-v="trades"></div>
              <div data-v="props"></div>
              <div data-v="opt" class="igs-opt"></div>
              <div class="igs-msg"></div>
            </div>
          </div>
        </div>
        <div class="igs-pane" data-p="editor">
          <div class="igs-ed">
            <div class="igs-edbar">
              <input type="text" class="igs-name" placeholder="Script name" spellcheck="false">
              <select class="igs-lang" title="Script language (Pine is detected from //@version or indicator()/strategy())"><option value="js">JavaScript</option><option value="pine">Pine Script</option></select>
              <select class="igs-kind"><option value="strategy">Strategy</option><option value="indicator">Indicator</option><option value="library">Library (Pine)</option></select>
              <select class="igs-tpl"><option value="">Templates…</option>${TEMPLATES.map((t, i) => `<option value="${i}">${esc(t.name)}</option>`).join('')}</select>
              <button class="igs-btn" data-act="new">New</button>
              <button class="igs-btn" data-act="save" title="Save (Ctrl/⌘+S)">Save</button>
              <button class="igs-btn" data-act="rename">Rename</button>
              <button class="igs-btn" data-act="delete">Delete</button>
              <button class="igs-btn" data-act="export">Export</button>
              <button class="igs-btn" data-act="import">Import</button>
              <input type="file" accept=".js,.pine,.txt,text/javascript" class="igs-file" hidden>
              <span class="igs-sp"></span>
              <button class="igs-btn" data-act="compile" title="Compile & run (Ctrl/⌘+Enter)">Compile</button>
              <button class="igs-btn pri" data-act="apply"></button>
            </div>
            <div class="igs-edmain">
              <div class="igs-code"><pre class="igs-gut"></pre><textarea class="igs-ta" spellcheck="false" autocapitalize="off" autocomplete="off" wrap="off"></textarea></div>
              <div class="igs-side"></div>
            </div>
            <div class="igs-console"></div>
          </div>
        </div>
      </div>
    </div>`;
    const $ = (s) => el.querySelector(s);
    const root = $('.igs-root'), form = $('.igs-form'), view = $('.igs-view'), info = $('.igs-info'), msg = $('.igs-msg'), notesEl = $('.igs-notes'), optEl = $('[data-v="opt"]');
    const ta = $('.igs-ta'), gut = $('.igs-gut'), con = $('.igs-console'), side = $('.igs-side');

    // ── strategies ──
    const scriptStrats = () => scripts().filter((s) => s.kind === 'strategy');
    function getStrategy(id) {
      const b = STRATEGIES.find((s) => s.id === id);
      if (b) return b;
      if (id && id.startsWith('script:')) {
        const sc = scriptStrats().find((s) => `script:${s.name}` === id);
        if (sc) return { id, name: sc.name, script: true, lang: langOf(sc), code: sc.code, params: S.schemas[id] || [] };
      }
      return STRATEGIES[0];
    }
    const jobLang = (st) => (st.script ? st.lang : 'builtin');
    const local = (st) => st.id === 'ai_chance';
    function setSchema(id, inputs) { if (inputs && JSON.stringify(inputs) !== JSON.stringify(S.schemas[id] || [])) { S.schemas[id] = inputs; S.formDirty = true; } }
    const errText = (e) => `${e.message}${e.line ? ` (line ${e.line}${e.col ? `:${e.col}` : ''})` : ''}`;
    const lastSigOf = (ls) => { const o = { long: [], short: [], exitLong: [], exitShort: [] }; if (ls) for (const k of Object.keys(o)) o[k][ls.i] = ls[k]; return o; };
    function syncBusy() { const b = el.querySelector('.igs-hst [data-act="cancel"]'); if (b) { b.hidden = !S.busy; b.title = S.busy ? `Cancel the running ${S.busy.what} (stops the script worker)` : ''; } }
    function renderHeader() {
      const opts = STRATEGIES.map((s) => `<option value="${s.id}">${esc(s.name)}</option>`).join('');
      const sopt = scriptStrats().map((s) => `<option value="script:${esc(s.name)}">${esc(s.name)}${langOf(s) === 'pine' ? ' · Pine' : ''}</option>`).join('');
      $('.igs-hst').innerHTML = S.tab === 'tester'
        ? `<span style="display:inline-flex;gap:5px;align-items:center"><select class="igs-strat" title="Strategy"><optgroup label="Built-in">${opts}</optgroup>${sopt ? `<optgroup label="My scripts">${sopt}</optgroup>` : ''}</select>
           <button class="igs-btn${S.showForm ? ' on' : ''}" data-act="form" title="Show strategy inputs & properties">Settings</button>
           <button class="igs-btn pri" data-act="run">Run</button>
           <button class="igs-btn${S.view === 'deep' ? ' on' : ''}" data-act="${S.view === 'deep' ? 'quick' : 'deep'}" title="${S.view === 'deep' ? 'Showing the deep backtest — click to return to the quick backtest of the chart bars' : 'Backtest on up to 30,000 bars of history (range in Settings → Deep backtest)'}">${S.view === 'deep' ? 'Deep ✕' : 'Deep backtest'}</button>
           <button class="igs-btn" data-act="cancel" hidden>Cancel</button>
           <span class="igs-toggle${S.alerts ? ' on' : ''}${canAlert() ? '' : ' dis'}" data-act="alerts" title="${canAlert() ? 'Send an alert (log, notification, push, webhooks) for each new entry/exit signal on the newest bar' : 'Strategy alerts are unavailable: this build does not provide host.notifyAlert'}"><i></i>Alerts</span>
           <span class="igs-toggle${S.on ? ' on' : ''}" data-act="toggle" title="Turn the tester on/off (off clears chart markers and stops recomputing)"><i></i>${S.on ? 'On' : 'Off'}</span></span>`
        : '';
      const sel = $('.igs-strat');
      if (sel) { sel.value = S.stratId; if (sel.value !== S.stratId) { S.stratId = 'ma_cross'; sel.value = S.stratId; } }
    }
    function renderForm() {
      const st = getStrategy(S.stratId), vals = { ...defaults(st.params), ...(S.params[st.id] || {}) };
      form.style.display = S.showForm ? '' : 'none';
      form.innerHTML = `<h4>Inputs · ${esc(st.name)}</h4><div class="igs-grid" data-f="inp">${st.params.length ? st.params.map((f) => fieldHTML(f, vals[f.k])).join('') : '<span class="muted">No inputs</span><span></span>'}</div>
        <h4>Properties</h4><div class="igs-grid" data-f="prop">${PROP_SCHEMA.map((f) => `${f.h ? `<h4 class="igs-gh">${esc(f.h)}</h4>` : ''}${fieldHTML(f, S.props[f.k])}`).join('')}</div>
        <div style="margin-top:10px;display:flex;gap:6px"><button class="igs-btn" data-act="reset-inputs">Reset inputs</button><button class="igs-btn" data-act="reset-props">Reset properties</button></div>
        <h4>Execution</h4><div class="igs-grid" data-f="exec"><label class="igs-lbl" title="Scripts and backtests run in a Web Worker (${esc(SH.mode)}); a run that takes longer is stopped. Deep backtests get ×6 (at least 60 s).">Script time limit (s)</label><input type="number" data-k="timeout" data-t="number" min="1" max="600" step="1" value="${S.timeout}"></div>
        <h4>Deep backtest</h4><div class="igs-grid" data-f="deep">
          <label class="igs-lbl">Range</label><select data-k="mode" data-t="select"><option value="bars"${S.deep.mode === 'bars' ? ' selected' : ''}>Last N bars</option><option value="dates"${S.deep.mode === 'dates' ? ' selected' : ''}>Date range</option></select>
          ${S.deep.mode === 'dates' ? `<label class="igs-lbl">From</label><input type="date" data-k="from" data-t="time" value="${toDate(S.deep.from)}"><label class="igs-lbl">To (empty = now)</label><input type="date" data-k="to" data-t="time" value="${toDate(S.deep.to)}">`
    : `<label class="igs-lbl" title="Up to ${DEEP_MAX.toLocaleString('en-US')} bars where the server has extended history; ${DEEP_FALLBACK.toLocaleString('en-US')} otherwise">Bars</label><input type="number" data-k="bars" data-t="int" min="100" max="${DEEP_MAX}" step="1000" value="${S.deep.bars}">`}
        </div>
        <div style="margin-top:8px;display:flex;gap:6px;align-items:center"><button class="igs-btn pri" data-act="deep">Run deep backtest</button><span class="igs-deepst muted"></span></div>
        <div class="igs-warn">Fetches the active chart's symbol and interval history, runs the selected strategy over it in the script worker, and shows the period, bar count and data sources. The chart's own bars and the quick backtest are not changed.</div>`;
      S.formDirty = false;
    }
    form.addEventListener('change', (e) => {
      const f = e.target.closest('[data-k]');
      if (!f) return;
      const which = f.closest('[data-f]').dataset.f, v = readField(f);
      if (which === 'exec') { S.timeout = Math.max(1, Math.min(600, +v || 10)); persist(); return; }
      if (which === 'deep') { S.deep[f.dataset.k] = f.dataset.k === 'bars' ? Math.max(100, Math.min(DEEP_MAX, v | 0)) : v; persist(); if (f.dataset.k === 'mode') renderForm(); return; }
      if (which === 'prop') S.props[f.dataset.k] = v;
      else (S.params[S.stratId] = S.params[S.stratId] || {})[f.dataset.k] = v;
      persist(); schedule(60);
      if (S.sub === 'opt') renderOpt();
    });

    // ── chart ──
    let chart = null, sEq = null, sBh = null, sDd = null;
    function themeColors() {
      const t = (host.theme && host.theme()) || {};
      const cs = getComputedStyle(root);
      const v = (n, d) => (cs.getPropertyValue(n) || '').trim() || d;
      return { bg: t.bg || v('--panel', '#151a22'), text: t.text || v('--text', '#d6dbe3'), grid: t.grid || v('--line', '#232a35'), border: t.border || v('--line', '#232a35'), up: t.up || v('--up', '#26a69a'), down: t.down || v('--down', '#ef5350'), accent: t.accent || v('--accent', '#2962ff'), muted: v('--muted', '#7c8696') };
    }
    const alpha = (hex, a) => { const m = /^#([0-9a-f]{6})$/i.exec(hex || ''); if (!m) return hex; const x = parseInt(m[1], 16); return `rgba(${x >> 16},${(x >> 8) & 255},${x & 255},${a})`; };
    function applyTheme() {
      if (!chart) return;
      const t = themeColors();
      chart.applyOptions({ layout: { background: { type: 'solid', color: t.bg }, textColor: t.text, fontSize: 11, attributionLogo: false }, grid: { vertLines: { color: alpha(t.grid, 0.5) || t.grid }, horzLines: { color: alpha(t.grid, 0.5) || t.grid } }, rightPriceScale: { borderColor: t.border }, timeScale: { borderColor: t.border } });
      sEq.applyOptions({ lineColor: t.accent, topColor: alpha(t.accent, 0.22), bottomColor: alpha(t.accent, 0) });
      sBh.applyOptions({ color: t.muted });
      sDd.applyOptions({ color: alpha(t.down, 0.55) });
      $('.igs-legend').innerHTML = `<span style="--c:${t.accent}">Equity</span><span style="--c:${t.muted}">Buy & hold</span><span style="--c:${alpha(t.down, 0.7)}">Drawdown %</span>`;
    }
    function ensureChart() {
      if (chart || !host.LW) return;
      const box = $('.igs-chart');
      chart = host.LW.createChart(box, { autoSize: true, layout: { attributionLogo: false }, rightPriceScale: { scaleMargins: { top: 0.08, bottom: 0.32 } }, timeScale: { timeVisible: true, secondsVisible: false }, crosshair: { mode: 0 }, handleScale: true, handleScroll: true });
      sEq = chart.addAreaSeries({ lineWidth: 2, priceLineVisible: false, lastValueVisible: true, title: '' });
      sBh = chart.addLineSeries({ lineWidth: 1, lineStyle: 2, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false });
      sDd = chart.addHistogramSeries({ priceScaleId: 'dd', priceFormat: { type: 'custom', formatter: (v) => `${v.toFixed(2)}%` }, priceLineVisible: false, lastValueVisible: false });
      chart.priceScale('dd').applyOptions({ scaleMargins: { top: 0.74, bottom: 0 }, visible: false });
      applyTheme();
    }

    // ── run ──
    let timer = 0, ranOnce = false;
    const schedule = (ms = 250) => { clearTimeout(timer); timer = setTimeout(run, ms); };
    const canAlert = () => typeof host.notifyAlert === 'function';
    let runSeq = 0, inflight = null, again = false;
    function run() {
      clearTimeout(timer);
      if (!S.on) return;
      const a = host.active && host.active();
      if (!a || !a.candles || a.candles.length < 2) { S.result = null; S.error = 'No chart data yet.'; renderResults(); return; }
      const st = getStrategy(S.stratId), params = { ...defaults(st.params), ...(S.params[st.id] || {}) };
      if (local(st)) { runLocal(a, st, params); return; }
      if (inflight) { again = true; return; }
      const mg = magnifierBars(a), seq = ++runSeq, t0 = performance.now();
      const job = { op: 'backtest', lang: jobLang(st), stratId: st.id, code: st.code, params, props: { ...S.props, tfSec: a.tfSec }, tfSec: a.tfSec, symbol: a.epic, decimals: a.decimals, timeLimit: tmo() };
      const pr = SH.run(job, { candles: a.candles, sub: mg && mg.bars, stream: `chart:${a.epic}:${a.tfSec}`, timeout: tmo() + 1000 });
      inflight = pr.id; S.busy = { id: pr.id, what: 'backtest' };
      const slow = setTimeout(() => { if (inflight === pr.id) { syncBusy(); if (S.view !== 'deep') info.textContent = `Running ${st.name}… (${SH.mode})`; } }, 250);
      pr.then((out) => {
        if (seq !== runSeq) return;
        if (st.script) setSchema(st.id, out.inputs);
        const res = out.res;
        S.result = { res, active: a, strat: st, params, ms: performance.now() - t0, mag: mg, pine: !!out.pine, worker: SH.mode };
        S.error = null; ranOnce = true;
        noteResult(res, mg); notePine(st, out.warnings);
        if (S.sel && !res.trades.concat(res.openTrades).some((t) => t.id === S.sel)) S.sel = null;
        if (S.formDirty) renderForm();
        checkAlerts(a, st, lastSigOf(out.lastSig), res);
        renderResults(); pushOverlay();
      }, (e) => {
        if (seq !== runSeq) return;
        S.result = null; S.error = e.phase === 'cancel' ? 'Backtest cancelled.' : `${st.name}: ${errText(e)}`;
        renderResults();
        if (host.clearOverlay && S.view !== 'deep') host.clearOverlay('strategy');
      }).finally(() => {
        clearTimeout(slow);
        if (inflight === pr.id) { inflight = null; S.busy = null; syncBusy(); }
        if (again) { again = false; schedule(10); }
      });
    }
    function notePine(st, warnings) {
      const parts = [];
      if (st.lang === 'pine' && (S.props.slType !== 'none' || S.props.tpType !== 'none')) parts.push('the tester stop-loss / take-profit properties do not apply to Pine strategies (use strategy.exit)');
      if (warnings && warnings.length) parts.push(...warnings);
      S.notes.pine = parts.length ? { t: `Pine: ${parts.join(' · ')}`, c: 'w' } : null;
    }
    // ── deep backtest: fetch up to DEEP_MAX bars of the active symbol/interval, run in the worker, show separately ──
    const DEEP_CACHE = new Map();
    async function fetchDeep(a) {
      const C = G.IGC, IV = C && C.iv, RES = C && C.RES_SEC;
      if (!C || !C.api || !IV || !RES) throw new Error('the history API is not available in this build');
      const sp = IV.parse(a.tf);
      if (!sp || sp.kind !== 'time') throw new Error('deep backtests need a time-based interval (not tick, range or price-based bars)');
      const res = IV.baseRes(sp), base = RES[res], ratio = Math.max(1, Math.round(sp.sec / base));
      const cfg = S.deep, dates = cfg.mode === 'dates';
      const to = dates && cfg.to > 0 ? cfg.to + 86399 : Math.floor(Date.now() / 1000), from = dates ? cfg.from : 0;
      if (dates && !(from > 0)) throw new Error('choose a From date for the deep backtest');
      if (dates && from >= to) throw new Error('the From date must be before the To date');
      // The extended-history path of /api/history serves "the latest N bars" (from/to ranges stay capped at 5,000), so a date
      // range fetches the bars from its start up to now and is trimmed here.
      const want = dates ? Math.ceil((to - from) / sp.sec) + 1 : Math.max(100, Math.min(DEEP_MAX, cfg.bars | 0));
      const span = dates ? Math.ceil((Date.now() / 1000 - from) / base) + 1 : Math.ceil(want * ratio);
      const max = Math.min(DEEP_MAX, Math.max(10, span));
      const key = `${a.epic}|${res}|${max}|${dates ? `${from}-${cfg.to}` : 'last'}`, hit = DEEP_CACHE.get(key);
      if (hit && Date.now() - hit.at < 5 * 60000) return hit.data;
      const q = (m) => `/api/history?epic=${encodeURIComponent(a.epic)}&resolution=${res}&max=${m}`;
      const notes = [];
      if (span > DEEP_MAX) notes.push(`the range needs ~${span.toLocaleString('en-US')} ${res} bars; requests are capped at ${DEEP_MAX.toLocaleString('en-US')}`);
      let r;
      try { r = await C.api(q(max)); } catch (e) {
        if (e.status !== 400 || max <= DEEP_FALLBACK) throw e;
        r = await C.api(q(DEEP_FALLBACK));
        notes.push(`the server rejected ${max.toLocaleString('en-US')} bars; fetched its ${DEEP_FALLBACK.toLocaleString('en-US')}-bar maximum`);
      }
      const got = r && Array.isArray(r.candles) ? r.candles.length : 0;
      if (r && r.extError) notes.push(`extended history unavailable (${r.extError})`);
      if (got < max && r && r.maxBars && r.maxBars < max) notes.push(`this symbol is limited to ${(+r.maxBars).toLocaleString('en-US')} bars (no extended-history source)`);
      let bars = normalizeBars(r && r.candles);
      const baseN = bars.length;
      if (ratio > 1) {
        if (!G.IGTypes || typeof G.IGTypes.aggregate !== 'function') throw new Error(`${a.tf} needs aggregation from ${res} bars, which this build does not provide`);
        bars = normalizeBars(G.IGTypes.aggregate(bars, a.tf));
      }
      if (dates) bars = bars.filter((b) => b.time >= from && b.time <= to);
      else if (bars.length > want) bars = bars.slice(-want);
      const data = { bars, want, max, baseN, res, ratio, sources: r && r.sources, notes, dates, from, to };
      DEEP_CACHE.set(key, { at: Date.now(), data });
      while (DEEP_CACHE.size > 2) DEEP_CACHE.delete(DEEP_CACHE.keys().next().value);
      return data;
    }
    function deepStat(t, c = '') {
      const x = el.querySelector('.igs-deepst');
      if (x) { x.textContent = t; x.className = `igs-deepst ${c || 'muted'}`; }
      if (S.deepRun || c === 'igs-err') info.textContent = t;
    }
    async function runDeep() {
      if (S.deepRun) return;
      const a = host.active && host.active(), st = getStrategy(S.stratId);
      if (!a || !a.epic) { deepStat('No active chart.', 'igs-err'); return; }
      if (local(st)) { deepStat(`${st.name} needs the chart's own signals and cannot run as a deep backtest.`, 'igs-err'); return; }
      const params = { ...defaults(st.params), ...(S.params[st.id] || {}) };
      S.deepRun = { t0: performance.now() };
      deepStat('Fetching history…');
      let d;
      try { d = await fetchDeep(a); } catch (e) { S.deepRun = null; deepStat(`History: ${fetchError(e)}`, 'igs-err'); return; }
      const n = d.bars.length;
      if (n < 2) { S.deepRun = null; deepStat('The server returned no bars for that range.', 'igs-err'); return; }
      deepStat(`Running on ${n.toLocaleString('en-US')} bars… (${SH.mode})`);
      const limit = Math.max(60, S.timeout * 6) * 1000;
      const job = { op: 'backtest', lang: jobLang(st), stratId: st.id, code: st.code, params, props: { ...S.props, tfSec: a.tfSec, from: 0, to: 0, magnifier: false }, tfSec: a.tfSec, symbol: a.epic, decimals: a.decimals, timeLimit: limit };
      const t1 = performance.now();
      const pr = SH.run(job, {
        candles: d.bars, timeout: limit + 2000,
        onProgress: (p) => deepStat(p.phase === 'script' ? `Running the Pine script… ${Math.round((100 * p.done) / Math.max(1, p.total))}% of ${n.toLocaleString('en-US')} bars` : 'Computing results…'),
      });
      S.busy = { id: pr.id, what: 'deep backtest' }; syncBusy();
      try {
        const out = await pr, res = out.res;
        if (st.script) setSchema(st.id, out.inputs);
        const first = d.bars[0].time, last = d.bars[n - 1].time, warn = d.notes.slice();
        if (!d.dates && n < d.want) warn.push(`requested ${d.want.toLocaleString('en-US')} bars, received ${n.toLocaleString('en-US')} — older history is not available for this symbol`);
        if (d.dates && first > d.from + 7 * a.tfSec) warn.push(`history starts ${fmtT(first)}, after the requested From date`);
        const src = fmtSources(d.sources);
        const summary = `${n.toLocaleString('en-US')} bars · ${fmtT(first)} → ${fmtT(last)}${d.ratio > 1 ? ` · aggregated from ${d.baseN.toLocaleString('en-US')} ${d.res} bars` : ''}${warn.length ? ` · ${warn.join('; ')}` : ''}`;
        S.deepRes = { res, active: { name: a.name, epic: a.epic, tf: a.tf, tfSec: a.tfSec, decimals: a.decimals, candles: d.bars }, strat: st, params, ms: performance.now() - t1, deep: { summary, sources: src, bars: n, from: first, to: last }, worker: SH.mode };
        S.notes.deep = { t: `Deep backtest · ${summary} · sources: ${src || 'IG (no source metadata returned)'} · bar magnifier off`, c: warn.length ? 'w' : '' };
        S.notes.deepPine = st.lang === 'pine' && out.warnings && out.warnings.length ? { t: `Pine: ${out.warnings.join(' · ')}`, c: 'w' } : null;
        const keep = [S.notes.risk, S.notes.mag];
        noteResult(res, null);
        S.notes.deepRisk = S.notes.risk; [S.notes.risk, S.notes.mag] = keep;
        S.view = 'deep'; S.sel = null;
        if (S.sub === 'opt') setSub('overview');
        renderHeader(); if (S.formDirty) renderForm(); renderResults(); pushOverlay();
        S.deepRun = null;
        deepStat(`Done · ${n.toLocaleString('en-US')} bars in ${((performance.now() - t1) / 1000).toFixed(1)} s`);
      } catch (e) {
        deepStat(e.phase === 'cancel' ? 'Deep backtest cancelled.' : `Deep backtest: ${errText(e)}`, e.phase === 'cancel' ? '' : 'igs-err');
      } finally {
        S.deepRun = null;
        if (S.busy && S.busy.id === pr.id) { S.busy = null; syncBusy(); }
      }
    }
    // AI Chance signals come from the chart (host.aiChance), so this one runs on the main thread.
    function runLocal(a, st, params) {
      const t0 = performance.now();
      S.notes.pine = null;
      let sig;
      try { sig = st.signals(a.candles, params, makeTA(), { host, active: a, rerun: () => schedule(10) }); }
      catch (e) { S.result = null; S.error = `${st.name}: ${e.message}${e.line ? ` (line ${e.line})` : ''}`; renderResults(); if (host.clearOverlay) host.clearOverlay('strategy'); return; }
      const mg = magnifierBars(a);
      const res = backtest(a.candles, sig, { ...S.props, tfSec: a.tfSec }, mg && mg.bars ? { sub: mg.bars } : undefined);
      S.result = { res, active: a, strat: st, params, ms: performance.now() - t0, mag: mg };
      S.error = null; ranOnce = true;
      noteResult(res, mg);
      if (S.sel && !res.trades.concat(res.openTrades).some((t) => t.id === S.sel)) S.sel = null;
      if (S.formDirty) renderForm();
      checkAlerts(a, st, sig, res);
      renderResults(); pushOverlay();
    }

    // ── bar magnifier: fetch + cache lower-timeframe bars per (epic, interval, tested range) ──
    const fetchError = (e) => (e && e.body && e.body.error === 'historical-data-allowance' ? 'the IG historical-data allowance is exhausted (try again later)' : (e && e.message) || String(e));
    function magnifierBars(a) {
      S.notes.mag = null;
      if (!S.props.magnifier) return null;
      const say = (t, c = 'w') => { S.notes.mag = { t: `Bar magnifier: ${t}`, c }; };
      if (typeof host.fetchBars !== 'function') { say('unavailable — this build does not provide host.fetchBars; using the open → high/low heuristic.'); return null; }
      const plan = magnifierPlan(a, S.props);
      if (!plan) return null;
      if (!plan.applicable) { say(`the chart timeframe is already ${plan.label} or finer — nothing to magnify.`, ''); return null; }
      const ent = BAR_CACHE.get(plan.key);
      if (ent && ent.status === 'ok') return { plan, bars: ent.bars };
      if (ent && ent.status === 'loading') { say(`loading ${plan.label} bars… (heuristic results shown meanwhile)`, ''); return { plan, bars: null }; }
      if (ent && ent.status === 'error' && Date.now() - ent.at < 60000) { say(`could not load ${plan.label} bars — ${ent.error}. Using the heuristic.`, 'e'); return { plan, bars: null }; }
      const rec = { status: 'loading', at: Date.now() };
      cacheBars(plan.key, rec);
      Promise.resolve().then(() => host.fetchBars(a.epic, plan.interval, plan.max)).then(
        (raw) => { rec.status = 'ok'; rec.bars = normalizeBars(raw); },
        (e) => { rec.status = 'error'; rec.error = fetchError(e); rec.at = Date.now(); },
      ).then(() => { if (S.on) schedule(10); });
      say(`loading ${plan.label} bars… (heuristic results shown meanwhile)`, '');
      return { plan, bars: null };
    }
    function noteResult(res, mg) {
      const m = res.magnifier;
      if (m && mg && mg.plan) {
        const pl = mg.plan, b = res.range.bars, cut = m.coveredBars < b;
        const why = pl.need > pl.max ? `the range needs ~${pl.need.toLocaleString('en-US')} ${pl.label} bars, capped at ${pl.max.toLocaleString('en-US')}` : `${pl.label} history is shorter than the range`;
        S.notes.mag = !m.coveredBars
          ? { t: `Bar magnifier · ${pl.label}: the ${m.subBars.toLocaleString('en-US')} fetched bars do not overlap the tested range — heuristic used for every bar.`, c: 'w' }
          : { t: `Bar magnifier · ${pl.label}: ${cut ? `only the most recent ${m.coveredBars.toLocaleString('en-US')} of ${b.toLocaleString('en-US')} bars are magnified (${why})` : `all ${b.toLocaleString('en-US')} bars covered`} · ${m.magnifiedBars} stop/target bar(s) resolved on sub-bars${m.fallbackBars ? `, ${m.fallbackBars} fell back to the heuristic (sub-bars never reached the level)` : ''}.`, c: cut ? 'w' : '' };
      }
      const r = res.risk, out = [];
      if (r.halted) out.push({ t: `Trading halted by "${r.halted.rule}" on ${fmtT(r.halted.time)} (${r.halted.detail}) — positions flattened, no further entries.`, c: 'e' });
      const days = r.events.filter((x) => x.rule === RISK_RULE.intraday);
      if (days.length) out.push({ t: `Max intraday loss hit on ${days.length} day(s), last ${fmtT(days[days.length - 1].time)} — flattened and blocked entries for the rest of each UTC day.`, c: 'w' });
      if (r.marginRejected || r.marginLimited) out.push({ t: `Margin: ${r.marginRejected} entr${r.marginRejected === 1 ? 'y' : 'ies'} rejected, ${r.marginLimited} reduced for insufficient equity.`, c: 'w' });
      if (r.blockedEntries && !r.halted && !days.length) out.push({ t: `${r.blockedEntries} entries blocked by risk rules.`, c: 'w' });
      S.notes.risk = out;
    }
    function renderNotes() {
      const deep = S.view === 'deep' && S.deepRes;
      const list = deep ? [S.notes.deep, S.notes.deepPine, ...(S.notes.deepRisk || [])].filter(Boolean)
        : [S.notes.mag, S.notes.pine, ...(S.result || S.sub === 'opt' ? S.notes.risk || [] : []), S.notes.alert].filter(Boolean);
      notesEl.innerHTML = list.map((x) => `<div class="${x.c || ''}" title="${esc(x.t)}">${esc(x.t)}</div>`).join('');
    }

    // ── strategy alerts: once per new signal on the newest bar ──
    function checkAlerts(a, st, sig, res) {
      if (!S.alerts) { S.notes.alert = null; return; }
      if (!canAlert()) { S.notes.alert = { t: 'Strategy alerts are on, but this build does not provide host.notifyAlert — no alerts will be sent.', c: 'w' }; return; }
      const c = a.candles, i = c.length - 1, bar = c[i], p = res.props;
      if (res.range.to !== i) { S.notes.alert = { t: 'Strategy alerts: the "To date" excludes the newest bar — no alerts while it is set.', c: 'w' }; return; }
      const allowL = p.direction !== 'short', allowS = p.direction !== 'long';
      let l = !!(sig.long && sig.long[i]), s = !!(sig.short && sig.short[i]);
      if (l && s) l = s = false;
      const px = (v) => (host.fmt ? host.fmt(v) : numf(v, a.decimals || 4)), ev = [];
      if (l && allowL) ev.push(['LONG entry', bar.close]);
      if (s && allowS) ev.push(['SHORT entry', bar.close]);
      if ((sig.exitLong && sig.exitLong[i]) || (s && !allowS)) ev.push(['LONG exit', bar.close]);
      if ((sig.exitShort && sig.exitShort[i]) || (l && !allowL)) ev.push(['SHORT exit', bar.close]);
      for (const t of res.trades) if (t.exitIdx === i && !/^(Exit|Reverse|Opposite)/.test(t.exitReason)) ev.push([`${t.dir.toUpperCase()} exit (${t.exitReason})`, t.exitPrice]);
      const key = `${st.id}|${a.epic}|${a.tfSec}`, seen = S.alertLast[key], kinds = ev.map((x) => x[0]);
      if (!seen) {
        S.alertLast[key] = { time: bar.time, kinds };
        S.notes.alert = { t: `Strategy alerts armed for ${st.name} · ${a.epic} ${tfLabel(a)} — new signals from the next update on are sent.`, c: '' };
        trimAlerts(); persist(); return;
      }
      const fresh = seen.time === bar.time ? ev.filter((x) => !seen.kinds.includes(x[0])) : bar.time > seen.time ? ev : [];
      if (bar.time > seen.time) S.alertLast[key] = { time: bar.time, kinds: [] };
      if (!fresh.length) { if (bar.time > seen.time) persist(); return; }
      const rec = S.alertLast[key], title = `${st.name} · ${a.epic || a.name || ''} ${tfLabel(a)}`;
      for (const [kind, price] of fresh) {
        rec.kinds.push(kind);
        const message = `${title}: ${kind} at ${px(price)}`;
        S.notes.alert = { t: `Last alert: ${message}`, c: '' };
        Promise.resolve().then(() => host.notifyAlert(title, message)).catch((e) => {
          S.notes.alert = { t: `Strategy alert failed: ${(e && e.message) || e}`, c: 'e' };
          renderNotes();
          if (host.notify) host.notify(`Strategy alert failed: ${(e && e.message) || e}`);
        });
      }
      persist();
    }
    function trimAlerts() { const ks = Object.keys(S.alertLast); for (const k of ks.slice(0, Math.max(0, ks.length - 50))) delete S.alertLast[k]; }

    function pushOverlay() {
      const R0 = cur();
      if (!host.setOverlay || !R0) return;
      const { res } = R0, t = themeColors(), markers = [], lines = [];
      const a = host.active && host.active(), t0 = a && a.candles && a.candles.length ? a.candles[0].time : -Infinity;
      for (const tr of res.trades.concat(res.openTrades)) {
        if (R0 !== S.result && tr.entryTime < t0 && (tr.exitTime === null || tr.exitTime < t0)) continue;
        const L = tr.dir === 'long', hi = tr.id === S.sel;
        markers.push({ time: tr.entryTime, position: L ? 'belowBar' : 'aboveBar', shape: L ? 'arrowUp' : 'arrowDown', color: hi ? t.accent : L ? t.up : t.down, text: `${L ? 'L' : 'S'} ${tr.id}` });
        if (tr.exitTime !== null) markers.push({ time: tr.exitTime, position: L ? 'aboveBar' : 'belowBar', shape: 'circle', color: hi ? t.accent : '#9598a1', text: '×', size: 0.6 });
        if (hi) {
          lines.push({ id: `e${tr.id}`, price: tr.entryPrice, color: t.accent, title: `#${tr.id} entry`, style: 2, draggable: false });
          lines.push({ id: `x${tr.id}`, price: tr.exitPrice, color: tr.pnl >= 0 ? t.up : t.down, title: `#${tr.id} ${tr.exitTime === null ? 'open' : 'exit'}`, style: 2, draggable: false });
        }
      }
      markers.sort((a, b) => a.time - b.time);
      host.setOverlay('strategy', { markers, lines });
    }

    function renderResults() {
      const r = cur(), opt = S.sub === 'opt';
      for (const v of view.querySelectorAll('[data-v]')) v.style.display = (opt ? v.dataset.v === 'opt' : r && v.dataset.v === S.sub) ? '' : 'none';
      msg.innerHTML = r || opt ? '' : `<div class="igs-empty${S.error && S.error !== 'No chart data yet.' ? ' igs-err' : ''}">${esc(S.on ? S.error || 'Press Run to backtest.' : 'Strategy tester is off. Turn it on to backtest the active chart.')}</div>`;
      info.textContent = r ? `${r.deep ? 'Deep backtest · ' : ''}${r.strat.name} · ${r.active.name || r.active.epic || ''} ${r.active.tf || ''} · ${r.res.range.bars.toLocaleString('en-US')} bars${r.deep && r.res.range.bars ? ` · ${fmtT(r.res.equity[0].time)} → ${fmtT(r.res.equity[r.res.equity.length - 1].time)}` : ''} · ${r.ms.toFixed(0)} ms${r.worker ? ` (${r.worker})` : ''}` : '';
      renderNotes();
      if (opt) { renderOpt(); return; }
      if (!r) return;
      if (S.sub === 'overview') renderOverview();
      else if (S.sub === 'summary') renderSummary();
      else if (S.sub === 'trades') renderTrades();
      else renderProps();
    }
    function renderOverview() {
      const { res } = cur(), m = res.metrics.all;
      const k = (label, val, sub, c) => `<div class="igs-kpi"><small>${label}</small><b class="${c || ''}">${val}</b>${sub ? `<em>${sub}</em>` : ''}</div>`;
      $('.igs-kpis').innerHTML = [
        k('Net profit', money(m.netProfit), pctf(m.netProfitPct), cls(m.netProfit)),
        k('Total closed trades', m.totalTrades),
        k('Percent profitable', pctf(m.winRate) || '0%', `${m.winningTrades}/${m.totalTrades}`),
        k('Profit factor', numf(m.profitFactor, 3)),
        k('Max drawdown', money(m.maxDrawdown), pctf(m.maxDrawdownPct), 'igs-dn'),
        k('Avg trade', money(m.avgTrade), pctf(m.avgTradePct), cls(m.avgTrade)),
        k('Avg # bars in trades', numf(m.avgBars, 0)),
      ].join('');
      ensureChart();
      if (!chart) return;
      sEq.setData(res.equity.map((x) => ({ time: x.time, value: x.equity })));
      sBh.setData(res.buyHold.map((x) => ({ time: x.time, value: x.equity })));
      sDd.setData(res.equity.map((x) => ({ time: x.time, value: -x.drawdownPct })));
      chart.timeScale().fitContent();
    }
    const SUMMARY = [
      ['Net profit', 'netProfit', 'm', 'netProfitPct'], ['Gross profit', 'grossProfit', 'm'], ['Gross loss', 'grossLoss', 'm'],
      ['Max run-up', 'maxRunup', 'm', 'maxRunupPct'], ['Max drawdown', 'maxDrawdown', 'm', 'maxDrawdownPct'],
      ['Buy & hold return', 'buyHoldProfit', 'm', 'buyHoldReturn'], ['Sharpe ratio', 'sharpe', 'n3'], ['Sortino ratio', 'sortino', 'n3'],
      ['CAGR', 'cagr', 'p'], ['Profit factor', 'profitFactor', 'n3'], ['Commission paid', 'commissionPaid', 'm'], ['Open P&L', 'openPnl', 'm'],
      ['Total closed trades', 'totalTrades', 'i'], ['Number winning trades', 'winningTrades', 'i'], ['Number losing trades', 'losingTrades', 'i'],
      ['Percent profitable', 'winRate', 'p'], ['Avg trade', 'avgTrade', 'm', 'avgTradePct'], ['Avg winning trade', 'avgWin', 'm'], ['Avg losing trade', 'avgLoss', 'm'],
      ['Ratio avg win / avg loss', 'ratioAvgWinLoss', 'n3'], ['Largest winning trade', 'largestWin', 'm', 'largestWinPct'], ['Largest losing trade', 'largestLoss', 'm', 'largestLossPct'],
      ['Avg # bars in trades', 'avgBars', 'n0'], ['Avg # bars in winning trades', 'avgBarsWin', 'n0'], ['Avg # bars in losing trades', 'avgBarsLoss', 'n0'],
    ];
    function cell(m, [, k, t, pk]) {
      const v = m[k];
      if (v === null || v === undefined) return '<td class="muted">—</td>';
      const c = t === 'm' && /net|avgTrade|openPnl|buyHold/.test(k) ? cls(v) : '';
      const main = t === 'm' ? money(v) : t === 'p' ? pctf(v) : t === 'i' ? String(v) : numf(v, t === 'n0' ? 0 : 3);
      return `<td class="${c}">${main}${pk && m[pk] !== null && m[pk] !== undefined ? `<small>${pctf(m[pk])}</small>` : ''}</td>`;
    }
    function renderSummary() {
      const { all, long, short } = cur().res.metrics;
      view.querySelector('[data-v="summary"]').innerHTML = `<table class="igs-table"><thead><tr><th>Title</th><th>All</th><th>Long</th><th>Short</th></tr></thead><tbody>${SUMMARY.map((row) => `<tr><td>${row[0]}</td>${cell(all, row)}${cell(long, row)}${cell(short, row)}</tr>`).join('')}</tbody></table>`;
    }
    const SORTS = { id: (t) => t.id, dir: (t) => t.dir, time: (t) => t.entryTime, price: (t) => t.entryPrice, qty: (t) => t.qty, pnl: (t) => t.pnl, cum: (t) => t.cum, runup: (t) => t.runup, drawdown: (t) => t.drawdown, bars: (t) => t.bars };
    function tradeRows() {
      const { res } = cur();
      let cum = 0;
      const list = res.trades.map((t) => ({ ...t, cum: (cum += t.pnl) })).concat(res.openTrades.map((t) => ({ ...t, cum: cum + t.pnl })));
      const f = SORTS[S.sort.k] || SORTS.id;
      return list.sort((a, b) => { const x = f(a), y = f(b); return (x < y ? -1 : x > y ? 1 : a.id - b.id) * S.sort.d; });
    }
    function renderTrades() {
      const box = view.querySelector('[data-v="trades"]'), rows = tradeRows();
      if (!rows.length) { box.innerHTML = '<div class="igs-empty">No trades in the tested range.</div>'; return; }
      const th = (k, l, c = '') => `<th data-s="${k}" class="${c}">${l}${S.sort.k === k ? `<span class="ar"> ${S.sort.d > 0 ? '▲' : '▼'}</span>` : ''}</th>`;
      const MAX = 2000, shown = rows.slice(0, MAX);
      box.innerHTML = `<table class="igs-table igs-trades"><thead><tr>${th('id', 'Trade #')}${th('dir', 'Type', 'l')}<th class="l">Signal</th>${th('time', 'Date / time')}${th('price', 'Price')}${th('qty', 'Contracts')}${th('pnl', 'Profit')}${th('cum', 'Cum. profit')}${th('runup', 'Run-up')}${th('drawdown', 'Drawdown')}${th('bars', 'Bars')}</tr></thead><tbody>${shown.map((t) => {
        const sel = t.id === S.sel ? ' sel' : '', L = t.dir === 'long', open = t.exitTime === null;
        return `<tr class="ex${sel}" data-id="${t.id}"><td rowspan="2">${t.id}</td><td class="ty">Exit ${L ? 'long' : 'short'}</td><td style="text-align:left">${esc(t.exitReason)}${t.magnified ? '<span class="igs-mag" title="Exit resolved on lower-timeframe bars (bar magnifier)">M</span>' : ''}</td><td>${open ? 'Open' : esc(fmtT(t.exitTime))}</td><td>${esc(fmtP(t.exitPrice))}</td><td rowspan="2">${numf(t.qty, t.qty < 10 ? 4 : 2)}</td><td rowspan="2" class="${cls(t.pnl)}">${money(t.pnl)}<small>${pctf(t.pnlPct)}</small></td><td rowspan="2" class="${cls(t.cum)}">${money(t.cum)}</td><td rowspan="2">${money(t.runup)}</td><td rowspan="2">${money(-t.drawdown)}</td><td rowspan="2">${t.bars}</td></tr>
          <tr class="en${sel}" data-id="${t.id}"><td class="ty ${L ? 'igs-up' : 'igs-dn'}">Entry ${L ? 'long' : 'short'}</td><td style="text-align:left">${esc(t.entrySignal)}</td><td>${esc(fmtT(t.entryTime))}</td><td>${esc(fmtP(t.entryPrice))}</td></tr>`;
      }).join('')}</tbody></table>${rows.length > MAX ? `<div class="igs-empty">Showing ${MAX} of ${rows.length} trades — export CSV for the full list.</div>` : ''}`;
    }
    function propRows() {
      const R0 = cur(), { res, active: a, strat, params } = R0, p = res.props, r = res.risk, m = res.magnifier, dp = R0.deep;
      const lab = (k, v) => { const f = PROP_SCHEMA.find((x) => x.k === k); const o = f && f.options && f.options.find((x) => x.v === v); return o ? o.l : v; };
      const off = (v, f) => (v > 0 ? f(v) : 'Off');
      return [
        ['Strategy', strat.name], ['Symbol', `${a.name || ''} ${a.epic ? `(${a.epic})` : ''}`], ['Timeframe', a.tf || `${a.tfSec || '?'}s`],
        ['Range', res.range.bars ? `${fmtT(res.equity[0].time)} → ${fmtT(res.equity[res.equity.length - 1].time)} (${res.range.bars} bars)` : '—'],
        ...(dp ? [['Deep backtest data', dp.summary], ['Data sources', dp.sources || 'IG (no source metadata returned)']] : []),
        ...(strat.lang === 'pine' ? [['Engine', 'Pine broker emulator → tester (fills replayed)']] : []),
        ...strat.params.map((f) => [`Input · ${f.label || f.k}`, String(params[f.k])]),
        ['Initial capital', money(p.capital)], ['Order size', `${p.size} ${lab('sizeType', p.sizeType)}`], ['Pyramiding', p.pyramiding],
        ['Commission', p.commType === 'cash' ? `${p.commission} per order` : `${p.commission}%`], ['Slippage', p.slippage], ['Process orders on', lab('fill', p.fill)],
        ['Direction', lab('direction', p.direction)], ['Reverse on opposite', p.reverse ? 'Yes' : 'No'],
        ['Stop loss', p.slType === 'none' ? 'Off' : `${p.sl}${p.slType === 'percent' ? '%' : ` × ATR(${p.atrLen})`}`],
        ['Take profit', p.tpType === 'none' ? 'Off' : `${p.tp}${p.tpType === 'percent' ? '%' : ` × ATR(${p.atrLen})`}`],
        ['Bar magnifier', !p.magnifier ? 'Off' : m ? `On · ${m.coveredBars} of ${res.range.bars} bars covered by ${m.subBars} sub-bars · ${m.magnifiedBars} resolved, ${m.fallbackBars} heuristic fallback` : `On · not applied (${(S.notes.mag && S.notes.mag.t) || 'no sub-bars'})`],
        ['Margin long / short', `${off(p.marginLong, (v) => `${v}%`)} / ${off(p.marginShort, (v) => `${v}%`)}${r.marginRejected || r.marginLimited ? ` · ${r.marginRejected} rejected, ${r.marginLimited} reduced` : ''}`],
        ['Max intraday loss', off(p.maxIntradayLoss, (v) => (p.maxIntradayLossType === 'cash' ? money(v) : `${v}% of day-start equity`))],
        ['Max drawdown stop', off(p.maxDDStop, (v) => `${v}% of peak equity`)],
        ['Max consecutive losing days', off(p.maxConsLossDays, String)],
        ['Risk status', r.halted ? `Halted by ${r.halted.rule} on ${fmtT(r.halted.time)} (${r.halted.detail})` : r.events.length ? `${r.events.length} intraday-loss stop(s)` : 'No rule triggered'],
      ];
    }
    function renderProps() {
      view.querySelector('[data-v="props"]').innerHTML = `<div class="igs-kv">${propRows().map(([k, v]) => `<div>${esc(k)}</div><div>${esc(v)}</div>`).join('')}</div>`;
    }
    view.addEventListener('click', (e) => {
      const th = e.target.closest('th[data-s]');
      if (th) { const k = th.dataset.s; S.sort = { k, d: S.sort.k === k ? -S.sort.d : k === 'id' ? -1 : 1 }; renderTrades(); return; }
      const tr = e.target.closest('tr[data-id]');
      if (!tr || !cur()) return;
      const id = +tr.dataset.id;
      S.sel = S.sel === id ? null : id;
      for (const row of view.querySelectorAll('tr[data-id]')) row.classList.toggle('sel', +row.dataset.id === S.sel);
      pushOverlay();
      const t = S.sel && cur().res.trades.concat(cur().res.openTrades).find((x) => x.id === id);
      if (t && host.notify) host.notify(`Trade #${t.id} ${t.dir} · ${fmtT(t.entryTime)} @ ${fmtP(t.entryPrice)} → ${t.exitTime === null ? 'open' : `${fmtT(t.exitTime)} @ ${fmtP(t.exitPrice)}`} · ${money(t.pnl)} (${pctf(t.pnlPct)})`);
    });

    // Raw trade rows (exit row then entry row per trade), shared by the CSV and XLSX exports.
    const TRADE_HEAD = ['Trade #', 'Type', 'Signal', 'Date/Time', 'Price', 'Contracts', 'Profit', 'Profit %', 'Cum. Profit', 'Run-up', 'Drawdown', 'Bars'];
    function tradeExportRows() {
      const { res } = cur(), rows = [];
      let cum = 0;
      for (const t of res.trades.concat(res.openTrades)) {
        cum += t.pnl;
        const L = t.dir === 'long', tail = [t.qty, t.pnl, t.pnlPct, cum, t.runup, -t.drawdown, t.bars];
        rows.push([t.id, `Exit ${L ? 'Long' : 'Short'}`, t.exitReason, t.exitTime, t.exitPrice, ...tail, t.magnified ? 'Yes' : '']);
        rows.push([t.id, `Entry ${L ? 'Long' : 'Short'}`, t.entrySignal, t.entryTime, t.entryPrice, ...tail, '']);
      }
      return rows;
    }
    function exportTrades() {
      if (!cur()) return;
      const { active: a } = cur();
      const rows = tradeExportRows().map((r) => [r[0], r[1], r[2], r[3] === null ? '' : fmtT(r[3]), r[4], r[5], ...r.slice(6, 11).map((v) => v.toFixed(2)), r[11]]);
      download(`${slug(cur().strat.name)}_${slug(a.epic || a.name || 'chart')}${cur().deep ? '_deep' : ''}_trades.csv`, csv([TRADE_HEAD, ...rows]));
    }
    function exportPerf() {
      if (!cur()) return;
      const { all, long, short } = cur().res.metrics;
      const rows = [['Metric', 'All', 'Long', 'Short']];
      for (const [label, k, , pk] of SUMMARY) {
        rows.push([label, all[k], long[k], short[k]].map((v) => (typeof v === 'number' ? +v.toFixed(6) : v === null ? '' : v)));
        if (pk) rows.push([`${label} %`, all[pk], long[pk], short[pk]].map((v) => (typeof v === 'number' ? +v.toFixed(6) : v === null ? '' : v)));
      }
      download(`${slug(cur().strat.name)}${cur().deep ? '_deep' : ''}_performance.csv`, csv(rows));
    }
    function workbook() {
      const { res } = cur(), { all, long, short } = res.metrics;
      const style = { m: 'money', p: 'pct', i: 'int', n0: 'price', n3: 'price' };
      const perf = [];
      for (const [label, k, t, pk] of SUMMARY) {
        perf.push([label, ...[all, long, short].map((m) => ({ v: m[k], s: style[t] }))]);
        if (pk) perf.push([`${label} %`, ...[all, long, short].map((m) => ({ v: m[pk], s: 'pct' }))]);
      }
      const props = propRows().map(([k, v]) => [k, typeof v === 'number' ? v : String(v)]);
      for (const ev of res.risk.events) props.push([`Risk event · ${ev.rule}`, `${fmtT(ev.time)} — ${ev.detail}`]);
      return xlsx([
        { name: 'List of Trades', header: [...TRADE_HEAD, 'Magnified exit'], types: ['int', 'text', 'text', 'date', 'price', 'price', 'money', 'pct', 'money', 'money', 'money', 'int', 'text'], rows: tradeExportRows() },
        { name: 'Performance Summary', header: ['Metric', 'All', 'Long', 'Short'], rows: perf, widths: [32, 16, 16, 16] },
        { name: 'Properties', header: ['Property', 'Value'], rows: props, widths: [32, 80] },
      ]);
    }
    function exportXlsx() {
      if (!cur()) return;
      const a = cur().active;
      download(`${slug(cur().strat.name)}_${slug(a.epic || a.name || 'chart')}${cur().deep ? '_deep' : ''}_report.xlsx`, workbook(), 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    }

    // ── optimizer UI ──
    let optRun = null, optSig = '', optSort = { k: 'rank', d: 1 }, optPaint = 0;
    const later = (f) => (typeof requestIdleCallback === 'function' ? requestIdleCallback(f, { timeout: 50 }) : setTimeout(f, 0));
    const metricDef = (k) => OPT_METRICS.find((x) => x.k === k) || OPT_METRICS[0];
    const fmtScore = (metric, v) => (v === null || v === undefined ? '—' : metric === 'netProfit' ? money(v) : metric === 'winRate' ? pctf(v) : metric === 'maxDrawdown' ? pctf(-v) : numf(v, 3));
    function optCandidates(st) {
      const vals = { ...defaults(st.params), ...(S.params[st.id] || {}) };
      const list = st.params.filter((f) => f.type === 'int' || f.type === 'number').map((f) => ({ key: `i:${f.k}`, k: f.k, scope: 'input', label: f.label || f.k, int: f.type === 'int', cur: +vals[f.k], min: f.min }));
      for (const [k, label, tk, name] of [['sl', 'Stop loss value', 'slType', 'Stop loss'], ['tp', 'Take profit value', 'tpType', 'Take profit']]) {
        list.push({ key: `p:${k}`, k, scope: 'prop', label, int: false, cur: +S.props[k], min: 0, disabled: S.props[tk] === 'none' ? `${name} is Off — choose % or ATR in Properties to optimise it` : '' });
      }
      return list;
    }
    function rowDefaults(c) {
      const v = ok(c.cur) ? c.cur : 1;
      if (c.int) { const from = Math.max(ok(+c.min) ? +c.min : 1, Math.round(v * 0.5)), to = Math.max(from + 1, Math.round(v * 1.5)); return { on: false, from, to, step: Math.max(1, Math.round((to - from) / 10)) }; }
      const from = +(v * 0.5).toPrecision(3), to = +(v * 1.5).toPrecision(3);
      return { on: false, from, to, step: +((to - from) / 10).toPrecision(2) || 0.1 };
    }
    const optRows = (st) => (S.opt[st.id] = S.opt[st.id] || {});
    const rowCount = (r) => { const n = Math.floor((r.to - r.from) / r.step + 1e-9) + 1; return r.step > 0 && n > 0 ? n : 0; };
    function optTotal(st) {
      const rows = optRows(st);
      let total = 1, any = false;
      for (const c of optCandidates(st)) { const r = rows[c.key]; if (r && r.on && !c.disabled) { total *= rowCount(r); any = true; } }
      return any ? total : 0;
    }
    function renderOpt(force) {
      const st = getStrategy(S.stratId), cands = optCandidates(st), rows = optRows(st);
      const sig = JSON.stringify([st.id, cands.map((c) => [c.key, c.disabled])]);
      if (!force && sig === optSig && optEl.firstChild) { paintOpt(); return; }
      optSig = sig;
      for (const c of cands) if (!rows[c.key]) rows[c.key] = rowDefaults(c);
      const cf = S.optCfg, running = optRun && !optRun.finished && !optRun.stopped;
      optEl.innerHTML = `<div class="igs-optcfg">
          <h4>Parameters · ${esc(st.name)}</h4>
          <table class="igs-rng"><thead><tr><th></th><th>Parameter</th><th>From</th><th>To</th><th>Step</th><th style="text-align:right">#</th></tr></thead><tbody>${cands.map((c) => {
            const r = rows[c.key], dis = !!c.disabled;
            return `<tr data-key="${esc(c.key)}" class="${r.on && !dis ? '' : 'off'}"${dis ? ` title="${esc(c.disabled)}"` : ''}><td><input type="checkbox" data-o="on"${r.on && !dis ? ' checked' : ''}${dis ? ' disabled' : ''}></td><td title="${esc(c.label)}">${esc(c.label)}</td>${['from', 'to', 'step'].map((k) => `<td><input type="number" step="any" data-o="${k}" value="${esc(r[k])}"${dis ? ' disabled' : ''}></td>`).join('')}<td class="cnt">${dis ? '—' : rowCount(r)}</td></tr>`;
          }).join('')}</tbody></table>
          <h4>Settings</h4>
          <div class="igs-grid">
            <label class="igs-lbl">Objective</label><select data-c="metric">${OPT_METRICS.map((m) => `<option value="${m.k}"${m.k === cf.metric ? ' selected' : ''}>${esc(m.l)}</option>`).join('')}</select>
            <label class="igs-lbl" title="Default 500, hard cap ${OPT_HARD_CAP}">Max combinations</label><input type="number" data-c="max" min="1" max="${OPT_HARD_CAP}" step="1" value="${cf.max}">
            <label class="igs-lbl" title="Rank on the first part of the range, then score the rest out of sample">Walk-forward split</label><input type="checkbox" data-c="wf"${cf.wf ? ' checked' : ''}>
            <label class="igs-lbl">In-sample %</label><input type="number" data-c="isPct" min="5" max="95" step="5" value="${cf.isPct}"${cf.wf ? '' : ' disabled'}>
          </div>
          <div class="igs-optbar"><button class="igs-btn pri" data-act="opt-run"${running ? ' disabled' : ''}>Run optimization</button><button class="igs-btn" data-act="opt-stop"${running ? '' : ' disabled'}>Stop</button><span class="igs-optcnt muted"></span></div>
          <div class="igs-prog"><i></i></div>
          <div class="igs-optstat"></div>
          <div class="igs-warn">Optimised scores are fitted to past data and usually overstate future results — favour broad stable regions and check out-of-sample.</div>
        </div>
        <div class="igs-optres"><div class="igs-heat" hidden><div class="ttl"></div><canvas></canvas><div class="igs-tip" hidden></div></div><div class="igs-opttab"></div></div>`;
      bindHeat();
      updateOptCount();
      paintOpt();
    }
    function updateOptCount() {
      const st = getStrategy(S.stratId), n = optTotal(st), max = Math.min(OPT_HARD_CAP, Math.max(1, S.optCfg.max | 0)), el2 = optEl.querySelector('.igs-optcnt');
      if (el2) { el2.textContent = n ? `${n.toLocaleString('en-US')} combination${n === 1 ? '' : 's'}${n > max ? ` — over the max of ${max.toLocaleString('en-US')}` : ''}` : 'no parameters selected'; el2.className = `igs-optcnt ${n > max ? 'igs-err' : 'muted'}`; }
    }
    optEl.addEventListener('input', (e) => {
      const t = e.target, tr = t.closest('tr[data-key]');
      if (tr && t.dataset.o) {
        const r = optRows(getStrategy(S.stratId))[tr.dataset.key];
        if (t.dataset.o === 'on') { r.on = t.checked; tr.classList.toggle('off', !t.checked); } else if (t.value !== '' && ok(+t.value)) r[t.dataset.o] = +t.value;
        tr.querySelector('.cnt').textContent = rowCount(r);
      } else if (t.dataset.c) {
        const k = t.dataset.c;
        S.optCfg[k] = k === 'wf' ? t.checked : k === 'metric' ? t.value : +t.value;
        if (k === 'wf') { const ip = optEl.querySelector('[data-c="isPct"]'); if (ip) ip.disabled = !t.checked; }
      } else return;
      updateOptCount(); persist();
    });
    optEl.addEventListener('change', (e) => { if (e.target.dataset.c === 'metric') { S.optCfg.metric = e.target.value; persist(); } });
    function optStat(text, c = '') { const s = optEl.querySelector('.igs-optstat'); if (s) { s.textContent = text; s.className = `igs-optstat ${c}`; } }
    function startOpt() {
      if (optRun && !optRun.finished && !optRun.stopped) return;
      const a = host.active && host.active();
      if (!a || !a.candles || a.candles.length < 2) { optStat('No chart data yet.', 'igs-err'); return; }
      const st = getStrategy(S.stratId), params = { ...defaults(st.params), ...(S.params[st.id] || {}) }, rows = optRows(st);
      const ranges = optCandidates(st).filter((c) => !c.disabled && rows[c.key] && rows[c.key].on).map((c) => ({ k: c.k, scope: c.scope, label: c.label, int: c.int, from: rows[c.key].from, to: rows[c.key].to, step: rows[c.key].step }));
      const mg = S.props.magnifier ? magnifierBars(a) : null;
      const cfg = { candles: a.candles, params, props: { ...S.props, tfSec: a.tfSec }, ranges, metric: S.optCfg.metric, max: S.optCfg.max, walkForward: S.optCfg.wf, isPct: S.optCfg.isPct, sub: mg && mg.bars };
      const meta = { stratId: st.id, stratName: st.name, t0: performance.now(), stopped: false, magnified: !!(mg && mg.bars), where: `${a.name || a.epic || ''} ${tfLabel(a)}` };
      optSort = { k: 'rank', d: 1 };
      if (local(st)) {
        const o = createOptimizer({ ...cfg, strategy: st, env: { host, active: a } });
        if (o.error) { optStat(o.error, 'igs-err'); return; }
        optRun = Object.assign(o, meta);
        setOptButtons(true);
        later(tickOpt);
        return;
      }
      // grid / walk-forward validation is pure and cheap: do it here, run the combinations in the script worker
      const probe = createOptimizer({ ...cfg, strategy: { signals: () => ({}) } });
      if (probe.error) { optStat(probe.error, 'igs-err'); return; }
      const ro = optRun = {
        ...meta, axes: probe.axes, total: probe.total, wf: probe.wf, metric: cfg.metric, results: [], done: 0, finished: false, error: null, remote: true,
        ranked() { return this.results.slice().sort(rankCmp); },
        best() { const r = this.ranked()[0]; return r && r.score !== null ? r : null; },
      };
      const job = { op: 'optimize', lang: jobLang(st), stratId: st.id, code: st.code, params, props: cfg.props, ranges, metric: cfg.metric, max: cfg.max, walkForward: cfg.walkForward, isPct: cfg.isPct, tfSec: a.tfSec, symbol: a.epic, decimals: a.decimals, timeLimit: tmo() };
      const pr = SH.run(job, {
        candles: a.candles, sub: cfg.sub, stream: `chart:${a.epic}:${a.tfSec}`, timeout: Math.max(600000, tmo() * 60),
        onProgress: (d) => { if (optRun !== ro) return; ro.results.push(...(d.results || [])); ro.done = d.done; tickRemote(ro); },
      });
      ro.jobId = pr.id; S.busy = { id: pr.id, what: 'optimization' }; syncBusy();
      setOptButtons(true);
      optStat(`Testing 0 / ${ro.total.toLocaleString('en-US')} combinations… (${SH.mode})`);
      pr.then((out) => {
        if (optRun !== ro) return;
        ro.results.push(...(out.results || [])); ro.done = out.done || ro.done; ro.error = out.error || null; ro.finished = true;
      }, (e) => {
        if (optRun !== ro) return;
        if (e.phase === 'cancel') ro.stopped = true; else { ro.error = errText(e); ro.finished = true; }
      }).finally(() => { if (S.busy && S.busy.id === pr.id) { S.busy = null; syncBusy(); } if (optRun === ro) { setOptButtons(false); paintOpt(); } });
    }
    function tickRemote(o) {
      const bar = optEl.querySelector('.igs-prog i');
      if (bar) bar.style.width = `${(o.done / o.total) * 100}%`;
      optStat(`Testing ${o.done.toLocaleString('en-US')} / ${o.total.toLocaleString('en-US')} combinations… (${SH.mode})`);
      if (performance.now() - optPaint > 500) paintOpt();
    }
    function setOptButtons(running) {
      const r = optEl.querySelector('[data-act="opt-run"]'), s = optEl.querySelector('[data-act="opt-stop"]');
      if (r) r.disabled = running;
      if (s) s.disabled = !running;
    }
    function tickOpt() {
      const o = optRun;
      if (!o || o.stopped) return;
      const done = o.step(12);
      const bar = optEl.querySelector('.igs-prog i');
      if (bar) bar.style.width = `${(o.done / o.total) * 100}%`;
      if (done) { setOptButtons(false); paintOpt(); return; }
      optStat(`Testing ${o.done.toLocaleString('en-US')} / ${o.total.toLocaleString('en-US')} combinations…`);
      if (performance.now() - optPaint > 500) paintOpt();
      later(tickOpt);
    }
    function stopOpt() {
      if (!optRun || optRun.finished) return;
      if (optRun.remote && optRun.jobId) { SH.cancel(optRun.jobId); return; }
      optRun.stopped = true; setOptButtons(false); paintOpt();
    }
    function optDesc(o, r) { return o.axes.map((ax, j) => `${ax.label} ${r.values[j]}`).join(', '); }
    function paintOpt() {
      optPaint = performance.now();
      const o = optRun, tab = optEl.querySelector('.igs-opttab'), heat = optEl.querySelector('.igs-heat');
      if (!tab) return;
      if (!o || o.stratId !== S.stratId) { heat.hidden = true; tab.innerHTML = '<div class="igs-empty">Tick the parameters to vary, set from / to / step, then Run optimization.</div>'; return; }
      const bar = optEl.querySelector('.igs-prog i');
      if (bar) bar.style.width = `${(o.done / o.total) * 100}%`;
      const ranked = o.ranked(), best = ranked[0] && ranked[0].score !== null ? ranked[0] : null, md = metricDef(o.metric);
      const secs = ((performance.now() - o.t0) / 1000).toFixed(1);
      if (o.error) optStat(o.error, 'igs-err');
      else if (o.finished || o.stopped) optStat(`${o.stopped && !o.finished ? `Stopped at ${o.done.toLocaleString('en-US')} / ${o.total.toLocaleString('en-US')}` : `${o.total.toLocaleString('en-US')} combinations`} in ${secs} s · ${o.where}${o.magnified ? ' · magnified' : ''}${best ? ` · best ${md.l}: ${fmtScore(o.metric, best.score)}${o.wf ? ` (out-of-sample ${fmtScore(o.metric, best.oos)})` : ''} at ${optDesc(o, best)}` : ' · no combination produced closed trades'}`);
      const S2 = {
        rank: (r) => ranked.indexOf(r), score: (r) => r.score, oos: (r) => r.oos, net: (r) => r.m.netProfit, trades: (r) => r.m.totalTrades, win: (r) => r.m.winRate,
        pf: (r) => r.m.profitFactor, dd: (r) => r.m.maxDrawdownPct, sharpe: (r) => r.m.sharpe,
      };
      o.axes.forEach((_, j) => { S2[`v${j}`] = (r) => r.values[j]; });
      const top = ranked.slice(0, 100), rank = new Map(top.map((r, i) => [r, i + 1])), f = S2[optSort.k] || S2.rank;
      if (optSort.k !== 'rank') top.sort((a, b) => { const x = f(a), y = f(b); if (x === null && y === null) return rank.get(a) - rank.get(b); if (x === null) return 1; if (y === null) return -1; return (x < y ? -1 : x > y ? 1 : rank.get(a) - rank.get(b)) * optSort.d; });
      const dupNet = o.metric === 'netProfit' && !o.wf;
      const th = (k, l) => `<th data-os="${k}">${esc(l)}${optSort.k === k ? `<span class="ar"> ${optSort.d > 0 ? '▲' : '▼'}</span>` : ''}</th>`;
      tab.innerHTML = !ranked.length ? '<div class="igs-empty">Running…</div>' : `<table class="igs-table"><thead><tr>${th('rank', '#')}${o.axes.map((ax, j) => th(`v${j}`, ax.label)).join('')}${th('score', o.wf ? `${md.l} (IS)` : md.l)}${o.wf ? th('oos', `${md.l} (OOS)`) : ''}${dupNet ? '' : th('net', 'Net profit')}${th('trades', 'Trades')}${th('win', 'Win %')}${th('pf', 'PF')}${th('dd', 'Max DD %')}${th('sharpe', 'Sharpe')}<th></th></tr></thead><tbody>${top.map((r) => `<tr class="${r === best ? 'best' : ''}"><td>${rank.get(r)}</td>${r.values.map((v) => `<td>${esc(v)}</td>`).join('')}<td class="${o.metric === 'netProfit' ? cls(r.score) : ''}">${fmtScore(o.metric, r.score)}</td>${o.wf ? `<td>${fmtScore(o.metric, r.oos)}</td>` : ''}${dupNet ? '' : `<td class="${cls(r.m.netProfit)}">${money(r.m.netProfit)}</td>`}<td>${r.m.totalTrades}</td><td>${pctf(r.m.winRate) || '0%'}</td><td>${numf(r.m.profitFactor, 3)}</td><td>${pctf(r.m.maxDrawdownPct) || '0%'}</td><td>${numf(r.m.sharpe, 2)}</td><td><button class="igs-btn" data-act="opt-apply" data-idx="${r.idx}">Apply</button></td></tr>`).join('')}</tbody></table>${ranked.length > 100 ? `<div class="igs-empty">Top 100 of ${ranked.length.toLocaleString('en-US')} by ${esc(md.l)}.</div>` : ''}`;
      heat.hidden = o.axes.length !== 2;
      if (!heat.hidden) drawHeat();
    }
    optEl.addEventListener('click', (e) => {
      const th = e.target.closest('th[data-os]');
      if (!th) return;
      const k = th.dataset.os;
      optSort = { k, d: optSort.k === k ? -optSort.d : k === 'rank' || k === 'dd' || /^v\d/.test(k) ? 1 : -1 };
      paintOpt();
    });
    function applyOpt(idx) {
      const o = optRun, r = o && o.results[idx];
      if (!r) return;
      S.stratId = o.stratId;
      const pr = (S.params[o.stratId] = { ...(S.params[o.stratId] || {}) });
      o.axes.forEach((ax, j) => { if (ax.scope === 'input') pr[ax.k] = r.values[j]; else S.props[ax.k] = r.values[j]; });
      persist(); renderHeader(); renderForm();
      if (host.notify) host.notify(`Applied ${o.stratName}: ${optDesc(o, r)}`);
      if (!S.on) setOn(true);
      setSub('overview'); run();
    }
    // heatmap: x = first varied parameter, y = second (increasing upwards); colour = objective score
    let heatGeo = null;
    function drawHeat() {
      const o = optRun, cv = optEl.querySelector('.igs-heat canvas'), ttl = optEl.querySelector('.igs-heat .ttl');
      if (!o || !cv) return;
      const [ax, ay] = o.axes, md = metricDef(o.metric), t = themeColors();
      ttl.textContent = `${md.l} · x ${ax.label} · y ${ay.label}`;
      ttl.title = 'Hover a cell for details; click it to apply those values';
      const dpr = (typeof window !== 'undefined' && window.devicePixelRatio) || 1, W = cv.clientWidth, H = cv.clientHeight;
      if (!W || !H) return;
      cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr);
      const g = cv.getContext('2d');
      g.setTransform(dpr, 0, 0, dpr, 0, 0); g.clearRect(0, 0, W, H);
      g.font = '10px ui-monospace, SFMono-Regular, Menlo, monospace';
      const labW = Math.min(60, 8 + Math.max(...ay.values.map((v) => g.measureText(String(v)).width)));
      const ml = labW, mr = 52, mt = 2, mb = 16, nx = ax.values.length, ny = ay.values.length, cw = (W - ml - mr) / nx, ch = (H - mt - mb) / ny;
      const grid = new Map(o.results.map((r) => [r.q[0] * ny + r.q[1], r]));
      const sc = o.results.map((r) => r.score).filter((v) => v !== null), lo = sc.length ? Math.min(...sc) : 0, hi = sc.length ? Math.max(...sc) : 0;
      const div = lo < 0 && hi > 0, best = o.best();
      const color = (v) => {
        if (div) return v >= 0 ? alpha(t.up, 0.15 + 0.85 * (v / hi)) : alpha(t.down, 0.15 + 0.85 * (v / lo));
        const k = hi > lo ? (v - lo) / (hi - lo) : 1;
        return alpha(t.accent, 0.1 + 0.9 * k);
      };
      for (let i = 0; i < nx; i++) for (let j = 0; j < ny; j++) {
        const r = grid.get(i * ny + j), x = ml + i * cw, y = mt + (ny - 1 - j) * ch;
        if (!r) continue;
        g.fillStyle = r.score === null ? alpha(t.grid, 0.6) : color(r.score);
        g.fillRect(x + 0.5, y + 0.5, Math.max(1, cw - 1), Math.max(1, ch - 1));
      }
      if (best) { const x = ml + best.q[0] * cw, y = mt + (ny - 1 - best.q[1]) * ch; g.strokeStyle = t.text; g.lineWidth = 1.5; g.strokeRect(x + 1, y + 1, Math.max(1, cw - 2), Math.max(1, ch - 2)); }
      g.fillStyle = t.muted; g.textBaseline = 'middle'; g.textAlign = 'right';
      const ey = Math.max(1, Math.ceil(ny / Math.max(1, Math.floor((H - mt - mb) / 14))));
      for (let j = 0; j < ny; j += ey) g.fillText(String(ay.values[j]), ml - 4, mt + (ny - 1 - j + 0.5) * ch);
      g.textAlign = 'center'; g.textBaseline = 'top';
      const ex = Math.max(1, Math.ceil(nx / Math.max(1, Math.floor((W - ml - mr) / 34))));
      for (let i = 0; i < nx; i += ex) g.fillText(String(ax.values[i]), ml + (i + 0.5) * cw, H - mb + 3);
      // colour scale
      const sx = W - mr + 10, sh = H - mt - mb;
      for (let k = 0; k < sh; k++) { const v = hi - ((hi - lo) * k) / Math.max(1, sh - 1); g.fillStyle = sc.length ? color(v) : alpha(t.grid, 0.6); g.fillRect(sx, mt + k, 8, 1); }
      g.fillStyle = t.muted; g.textAlign = 'left'; g.textBaseline = 'top';
      const short = (v) => (Math.abs(v) >= 1000 ? `${(v / 1000).toFixed(1)}k` : Math.abs(v) >= 100 ? v.toFixed(0) : v.toFixed(2));
      const show = (v) => (o.metric === 'maxDrawdown' ? `${short(-v)}%` : short(v));
      if (sc.length) { g.fillText(show(hi), sx + 10, mt); g.textBaseline = 'bottom'; g.fillText(show(lo), sx + 10, mt + sh); }
      heatGeo = { ml, mt, cw, ch, nx, ny, grid };
    }
    function bindHeat() {
      const cv = optEl.querySelector('.igs-heat canvas'), tip = optEl.querySelector('.igs-tip'), box = optEl.querySelector('.igs-heat');
      if (!cv) return;
      const at = (e) => {
        if (!heatGeo || !optRun) return null;
        const b = cv.getBoundingClientRect(), x = e.clientX - b.left, y = e.clientY - b.top, i = Math.floor((x - heatGeo.ml) / heatGeo.cw), j = heatGeo.ny - 1 - Math.floor((y - heatGeo.mt) / heatGeo.ch);
        return i >= 0 && i < heatGeo.nx && j >= 0 && j < heatGeo.ny ? heatGeo.grid.get(i * heatGeo.ny + j) || null : null;
      };
      cv.addEventListener('mousemove', (e) => {
        const r = at(e), o = optRun;
        if (!r) { tip.hidden = true; return; }
        const md = metricDef(o.metric);
        tip.innerHTML = `<b>${esc(optDesc(o, r))}</b><br>${esc(md.l)}: ${fmtScore(o.metric, r.score)}${o.wf ? ` · OOS ${fmtScore(o.metric, r.oos)}` : ''}<br>Net ${money(r.m.netProfit)} · ${r.m.totalTrades} trades · DD ${pctf(r.m.maxDrawdownPct) || '0%'}<br><span class="muted">Click to apply</span>`;
        tip.hidden = false;
        const bb = box.getBoundingClientRect(), tw = tip.offsetWidth, x = e.clientX - bb.left + 12;
        tip.style.left = `${Math.min(x, bb.width - tw - 4)}px`;
        tip.style.top = `${Math.max(2, e.clientY - bb.top - tip.offsetHeight - 8)}px`;
      });
      cv.addEventListener('mouseleave', () => { tip.hidden = true; });
      cv.addEventListener('click', (e) => { const r = at(e); if (r) applyOpt(r.idx); });
    }

    // ── editor ──
    const log = (text, kind = '') => {
      const d = document.createElement('div');
      d.className = kind;
      d.innerHTML = `<span class="t">${new Date().toTimeString().slice(0, 8)}</span>${esc(text)}`;
      con.appendChild(d);
      while (con.childNodes.length > 200) con.firstChild.remove();
      con.scrollTop = con.scrollHeight;
    };
    function renderGutter() {
      const n = ta.value.split('\n').length;
      let s = '';
      for (let i = 1; i <= n; i++) s += i === S.ed.errLine ? `<span class="e">${i}</span>\n` : `${i}\n`;
      gut.innerHTML = s;
      gut.scrollTop = ta.scrollTop;
    }
    function renderEditorBar() {
      $('.igs-name').value = S.ed.name;
      $('.igs-kind').value = S.ed.kind;
      $('.igs-lang').value = S.ed.lang;
      const k = $('.igs-kind');
      k.disabled = S.ed.lang === 'pine';
      k.title = S.ed.lang === 'pine' ? 'Pine scripts declare their kind with indicator(), strategy() or library()' : '';
      $('[data-act="apply"]').textContent = S.ed.kind === 'strategy' ? 'Use in Tester' : S.ed.kind === 'library' ? 'Save library' : 'Add to chart';
    }
    // Pine: language and kind follow the code (//@version, indicator()/strategy()).
    function detectLang(quiet) {
      const d = G.IGPine ? G.IGPine.detect(ta.value) : { isPine: false };
      let changed = false;
      if (d.isPine && S.ed.lang !== 'pine') { S.ed.lang = 'pine'; changed = true; if (!quiet) log('Detected Pine Script'); }
      if (S.ed.lang === 'pine' && d.isPine && S.ed.kind !== d.kind) { S.ed.kind = d.kind; changed = true; }
      if (changed) { renderEditorBar(); renderSide(); persist(); }
    }
    function renderSide() {
      const list = scripts();
      const vals = S.ed.values;
      side.innerHTML = `<h4>Inputs</h4><div class="igs-grid" data-f="ed">${S.ed.inputs.length ? S.ed.inputs.map((f) => fieldHTML(f, vals[f.k] !== undefined ? vals[f.k] : f.def)).join('') : '<span class="muted">Compile to collect ctx.input() fields</span><span></span>'}</div>
        <h4>Saved scripts</h4>${list.length ? `<ul class="igs-scripts">${list.map((s) => `<li data-open="${esc(s.name)}" class="${s.name === S.ed.name ? 'on' : ''}"><span>${esc(s.name)}</span><small>${s.kind === 'indicator' ? 'ind' : s.kind === 'library' ? 'lib' : 'strat'}</small></li>`).join('')}</ul>` : '<div class="muted">None yet</div>'}
        <h4>Reference</h4><div class="muted igs-ref">${S.ed.lang === 'pine' ? PINE_REF : JS_REF}</div>`;
    }
    side.addEventListener('change', (e) => { const f = e.target.closest('[data-k]'); if (f) { S.ed.values[f.dataset.k] = readField(f); compileRun(true); } });
    side.addEventListener('click', (e) => { const li = e.target.closest('[data-open]'); if (li) openScript(li.dataset.open); });
    function setCode(code) { ta.value = code; S.ed.code = code; S.ed.errLine = null; renderGutter(); persist(); }
    function openScript(name) {
      const s = scripts().find((x) => x.name === name);
      if (!s) return;
      S.ed.name = s.name; S.ed.kind = s.kind; S.ed.lang = langOf(s); S.ed.values = { ...(s.values || {}) }; S.ed.inputs = [];
      setCode(s.code); renderEditorBar(); renderSide(); log(`Opened "${s.name}"`);
    }
    // Compiles and runs the editor script on the chart bars in the script worker; resolves to the run result or null.
    let compileSeq = 0;
    function compileRun(quiet) {
      S.ed.code = ta.value;
      const a = host.active && host.active();
      const candles = a && a.candles && a.candles.length ? a.candles : [{ time: 0, open: 1, high: 1, low: 1, close: 1, volume: 0 }];
      const lang = S.ed.lang, kind = S.ed.kind, code = S.ed.code, seq = ++compileSeq;
      S.ed.errLine = null;
      const job = { op: 'compile', lang, kind, code, values: S.ed.values, props: { ...S.props, tfSec: a && a.tfSec }, tfSec: a && a.tfSec, symbol: a && a.epic, decimals: a && a.decimals, timeLimit: tmo() };
      const pr = SH.run(job, { candles, stream: a ? `chart:${a.epic}:${a.tfSec}` : null, timeout: tmo() + 1000 });
      const slow = setTimeout(() => { if (seq === compileSeq) log(`Running… (${SH.mode}; stops after ${S.timeout} s)`); }, 400);
      return pr.then((out) => {
        if (seq !== compileSeq) return null;
        const n = a && a.candles ? a.candles.length : 0, ms = out.ms.toFixed(0);
        let r;
        if (lang === 'pine') {
          r = out.pine;
          if (S.ed.kind !== r.kind) { S.ed.kind = r.kind; renderEditorBar(); }
          for (const w of r.warnings || []) log(`Warning: ${w}`, 'w');
          if (r.kind === 'strategy') {
            const fills = r.orders || [];
            log(`Compiled OK · Pine v${r.version || '?'} strategy "${r.decl.title}" · ${n} bars · ${ms} ms · ${fills.filter((f) => f.kind === 'entry').length} entries, ${(r.trades || []).length} closed trades · ${r.plots.length} plot(s)`, 'ok');
          } else {
            log(`Compiled OK · Pine v${r.version || '?'} ${r.kind === 'library' ? 'library' : 'indicator'} "${r.decl.title}" (${r.decl.overlay ? 'overlay' : 'pane'}) · ${n} bars · ${ms} ms · ${r.plots.length} plot(s), ${r.hlines.length} hline(s), ${r.fills.length} fill(s), ${r.markers.length} marker(s), ${r.graphics.length} drawing(s)${(r.candles || []).length ? `, ${r.candles.length} OHLC series` : ''}${(r.tables || []).length ? `, ${r.tables.length} table(s)` : ''}${r.barColors ? ', bar colours' : ''}${r.alerts.length ? ` · alertconditions: ${r.alerts.map((x) => `${x.title} ×${x.count}`).join(', ')}` : ''}`, 'ok');
          }
          for (const l of (r.logs || []).slice(-5)) log(`log.${l}`);
        } else {
          r = out.js;
          if (kind === 'strategy') {
            const cnt = (x) => (x ? x.reduce((t, v) => t + (v ? 1 : 0), 0) : 0), g = r.signals;
            log(`Compiled OK · ${n} bars · ${ms} ms · long ${cnt(g.long)}, short ${cnt(g.short)}, exitLong ${cnt(g.exitLong)}, exitShort ${cnt(g.exitShort)} signals`, 'ok');
          } else log(`Compiled OK · ${n} bars · ${ms} ms · ${r.plots.length} plot(s): ${r.plots.map((p) => `${p.name} [${p.pane}/${p.type}]`).join(', ')} · ${r.markers.length} marker(s)`, 'ok');
        }
        const changed = JSON.stringify(r.inputs) !== JSON.stringify(S.ed.inputs);
        S.ed.inputs = r.inputs;
        if (changed || !quiet) renderSide();
        renderGutter();
        return r;
      }, (e) => {
        if (seq !== compileSeq) return null;
        S.ed.errLine = e.line || null;
        const what = e.phase === 'compile' ? 'Compile error' : e.phase === 'timeout' ? 'Stopped' : e.phase === 'cancel' ? 'Cancelled' : 'Runtime error';
        log(`${what}${e.line ? ` (line ${e.line}${e.col ? `:${e.col}` : ''})` : ''}: ${e.message}`, 'igs-err');
        renderGutter();
        return null;
      }).finally(() => clearTimeout(slow));
    }
    function saveScript(silent) {
      const name = ($('.igs-name').value || '').trim();
      if (!name) { log('Enter a script name before saving.', 'w'); $('.igs-name').focus(); return false; }
      S.ed.name = name; S.ed.code = ta.value;
      const list = scripts(), i = list.findIndex((s) => s.name === name), rec = { name, kind: S.ed.kind, lang: S.ed.lang, code: S.ed.code, values: S.ed.values, updated: Date.now() };
      if (i >= 0) list[i] = rec; else list.push(rec);
      saveScripts(list); persist(); renderSide(); renderHeader();
      if (!silent) log(`Saved "${name}"`, 'ok');
      return true;
    }
    async function applyScript() {
      const r = await compileRun();
      if (!r || !saveScript(true)) return;
      if (S.ed.kind === 'strategy') {
        S.stratId = `script:${S.ed.name}`;
        S.schemas[S.stratId] = r.inputs;
        S.params[S.stratId] = { ...S.ed.values };
        if (S.ed.lang === 'pine') applyDeclProps(r.declProps);
        setTab('tester'); renderHeader(); renderForm(); run();
        return;
      }
      if (S.ed.kind === 'library') {
        log(`Saved library "${S.ed.name}" — use it from other scripts with: import user/${G.IGPine.libraryTitle(S.ed.code) || S.ed.name}/1 as ${(G.IGPine.libraryTitle(S.ed.code) || S.ed.name).replace(/\W/g, '')}`, 'ok');
        return;
      }
      const ind = host.ind || G.IGInd;
      if (!ind || typeof ind.register !== 'function') { log('Cannot add to chart: IGInd.register is not available in this build.', 'igs-err'); return; }
      const sc0 = { name: S.ed.name, code: S.ed.code };
      const def = workerIndicator(S.ed.lang === 'pine' ? G.IGPine.indicatorDef(sc0, r) : indicatorDef(sc0, r), sc0, S.ed.lang);
      try {
        if (typeof ind.unregister === 'function' && ind.BY_ID && ind.BY_ID[def.id]) ind.unregister(def.id);
        ind.register(def);
        if (host.addStudy) host.addStudy(def.id);
        log(`Added "${S.ed.name}" to chart as ${def.id} (${def.kind}, ${def.outputs.length} output(s)) — it recalculates in a background worker`, 'ok');
      } catch (e) { log(`Add to chart failed: ${e.message}`, 'igs-err'); }
    }
    // strategy() arguments → tester properties (only those the script sets), like TradingView's Properties tab
    function applyDeclProps(dp) {
      if (!dp || !Object.keys(dp).length) return;
      const a = host.active && host.active(), next = { ...dp };
      if (next.slippageTicks !== undefined) { const dec = a && Number.isInteger(a.decimals) ? a.decimals : 2; next.slippage = +(next.slippageTicks * 10 ** -dec).toFixed(dec + 2); delete next.slippageTicks; }
      if (next.sizeType && !['percent', 'qty', 'cash'].includes(next.sizeType)) delete next.sizeType;
      Object.assign(S.props, next);
      persist();
      log(`Applied strategy() properties to the tester: ${Object.entries(next).map(([k, v]) => `${k}=${v}`).join(', ')}`, 'ok');
    }
    // Saved indicator scripts: a sample run in the worker fixes their outputs, then they are registered for the chart.
    function registerSavedIndicators() {
      const ind = host.ind || G.IGInd;
      if (!ind || typeof ind.register !== 'function') return;
      const a = host.active && host.active(), candles = a && a.candles && a.candles.length ? a.candles : [{ time: 0, open: 1, high: 1, low: 1, close: 1, volume: 0 }];
      for (const sc of scripts().filter((x) => x.kind === 'indicator')) {
        const id = `script:${slug(sc.name)}`, lang = langOf(sc);
        if (ind.BY_ID && ind.BY_ID[id]) continue;
        SH.run({ op: 'compile', lang, kind: 'indicator', code: sc.code, values: sc.values || {}, tfSec: a && a.tfSec, symbol: a && a.epic, decimals: a && a.decimals, timeLimit: tmo() }, { candles, stream: a ? `chart:${a.epic}:${a.tfSec}` : null, timeout: tmo() + 1000 })
          .then((out) => {
            if (ind.BY_ID && ind.BY_ID[id]) return;
            ind.register(workerIndicator(lang === 'pine' ? G.IGPine.indicatorDef(sc, out.pine) : indicatorDef(sc, out.js), sc, lang));
          }, () => { /* broken saved script stays editable */ });
      }
    }
    ta.addEventListener('input', () => { S.ed.code = ta.value; renderGutter(); clearTimeout(S.persistT); S.persistT = setTimeout(() => { detectLang(); persist(); }, 400); });
    ta.addEventListener('scroll', () => { gut.scrollTop = ta.scrollTop; });
    ta.addEventListener('keydown', (e) => {
      const mod = e.metaKey || e.ctrlKey;
      if (mod && e.key === 'Enter') { e.preventDefault(); compileRun(); return; }
      if (mod && (e.key === 's' || e.key === 'S')) { e.preventDefault(); saveScript(); return; }
      const v = ta.value, s = ta.selectionStart, en = ta.selectionEnd;
      if (e.key === 'Tab') {
        e.preventDefault();
        const ls = v.lastIndexOf('\n', s - 1) + 1;
        if (s === en && !e.shiftKey) { ta.setRangeText('  ', s, en, 'end'); }
        else {
          const block = v.slice(ls, en), lines = block.split('\n');
          const out = lines.map((l) => (e.shiftKey ? l.replace(/^ {1,2}/, '') : `  ${l}`)).join('\n');
          ta.setRangeText(out, ls, en, 'select');
          if (s === en) ta.setSelectionRange(Math.max(ls, s - (block.length - out.length)), Math.max(ls, s - (block.length - out.length)));
        }
        ta.dispatchEvent(new Event('input'));
      } else if (e.key === 'Enter' && !mod) {
        e.preventDefault();
        const ls = v.lastIndexOf('\n', s - 1) + 1, ind = /^\s*/.exec(v.slice(ls, s))[0], extra = /[{[(]\s*$/.test(v.slice(ls, s)) ? '  ' : '';
        ta.setRangeText(`\n${ind}${extra}`, s, en, 'end');
        ta.dispatchEvent(new Event('input'));
      }
    });
    $('.igs-name').addEventListener('change', (e) => { S.ed.name = e.target.value.trim(); persist(); });
    $('.igs-kind').addEventListener('change', (e) => { S.ed.kind = e.target.value; renderEditorBar(); persist(); });
    $('.igs-lang').addEventListener('change', (e) => { S.ed.lang = e.target.value; if (S.ed.lang === 'pine') detectLang(true); renderEditorBar(); renderSide(); persist(); });
    $('.igs-tpl').addEventListener('change', (e) => {
      const t = TEMPLATES[+e.target.value];
      e.target.value = '';
      if (!t) return;
      S.ed.kind = t.kind; S.ed.lang = t.lang || 'js'; S.ed.values = {}; S.ed.inputs = [];
      setCode(t.code); renderEditorBar(); renderSide(); log(`Loaded template "${t.name}"`);
    });
    $('.igs-file').addEventListener('change', async (e) => {
      const f = e.target.files && e.target.files[0];
      e.target.value = '';
      if (!f) return;
      const text = await f.text();
      const nm = /^\/\/\s*@name\s+(.+)$/m.exec(text), kd = /^\/\/\s*@kind\s+(strategy|indicator)/m.exec(text);
      const code = text.replace(/^\/\/\s*@(name|kind)\b.*\n?/gm, '');
      const pd = G.IGPine ? G.IGPine.detect(code) : { isPine: false };
      S.ed.name = nm ? nm[1].trim() : f.name.replace(/\.(js|txt|pine)$/i, '');
      S.ed.lang = pd.isPine || /\.pine$/i.test(f.name) ? 'pine' : 'js';
      S.ed.kind = S.ed.lang === 'pine' ? pd.kind : kd ? kd[1] : /plots\s*:/.test(code) ? 'indicator' : 'strategy';
      S.ed.values = {}; S.ed.inputs = [];
      setCode(code); renderEditorBar(); saveScript(true); log(`Imported "${S.ed.name}" (${S.ed.kind})`, 'ok');
    });

    // ── tabs, actions ──
    function setTab(t) {
      S.tab = t;
      for (const b of el.querySelectorAll('.igs-tab')) b.classList.toggle('on', b.dataset.tab === t);
      for (const p of el.querySelectorAll('.igs-pane')) p.style.display = p.dataset.p === t ? '' : 'none';
      renderHeader(); persist();
      if (t === 'tester' && S.on && !ranOnce) schedule(0);
    }
    function setSub(s) {
      S.sub = s;
      for (const b of el.querySelectorAll('.igs-sub')) b.classList.toggle('on', b.dataset.sub === s);
      persist(); renderResults();
    }
    function setOn(on) {
      S.on = on; persist(); renderHeader();
      if (on) run();
      else { clearTimeout(timer); S.result = null; ranOnce = false; if (host.clearOverlay) host.clearOverlay('strategy'); renderResults(); }
    }
    function setAlerts(on) {
      if (on && !canAlert()) { S.alerts = false; S.notes.alert = { t: 'Strategy alerts are unavailable: this build does not provide host.notifyAlert.', c: 'w' }; renderNotes(); if (host.notify) host.notify('Strategy alerts are unavailable in this build (host.notifyAlert missing).'); return; }
      S.alerts = on;
      if (on) { const st = getStrategy(S.stratId), a = host.active && host.active(); if (a) delete S.alertLast[`${st.id}|${a.epic}|${a.tfSec}`]; }
      else S.notes.alert = null;
      persist(); renderHeader();
      if (on && !S.on) setOn(true); else if (on) run(); else renderNotes();
    }
    el.addEventListener('click', (e) => {
      const t = e.target.closest('[data-tab]');
      if (t) { setTab(t.dataset.tab); return; }
      const sb = e.target.closest('[data-sub]');
      if (sb) { setSub(sb.dataset.sub); return; }
      const b = e.target.closest('[data-act]');
      if (!b) return;
      const act = b.dataset.act;
      if (act === 'run') { if (S.view === 'deep') { S.view = 'quick'; renderHeader(); } if (!S.on) setOn(true); else run(); }
      else if (act === 'deep') runDeep();
      else if (act === 'quick') { S.view = 'quick'; renderHeader(); renderResults(); pushOverlay(); }
      else if (act === 'cancel') { if (S.busy) SH.cancel(S.busy.id); }
      else if (act === 'toggle') setOn(!S.on);
      else if (act === 'form') { S.showForm = !S.showForm; persist(); renderHeader(); renderForm(); }
      else if (act === 'reset-inputs') { delete S.params[S.stratId]; persist(); renderForm(); schedule(0); }
      else if (act === 'reset-props') { S.props = defaults(PROP_SCHEMA); persist(); renderForm(); schedule(0); }
      else if (act === 'csv-trades') exportTrades();
      else if (act === 'csv-perf') exportPerf();
      else if (act === 'xlsx') exportXlsx();
      else if (act === 'alerts') setAlerts(!S.alerts);
      else if (act === 'opt-run') startOpt();
      else if (act === 'opt-stop') stopOpt();
      else if (act === 'opt-apply') applyOpt(+b.dataset.idx);
      else if (act === 'new') { const t = TEMPLATES.find((x) => (x.lang || 'js') === S.ed.lang && x.kind === S.ed.kind) || TEMPLATES[0]; S.ed.name = ''; S.ed.values = {}; S.ed.inputs = []; S.ed.lang = t.lang || 'js'; S.ed.kind = t.kind; setCode(t.code); renderEditorBar(); renderSide(); }
      else if (act === 'save') saveScript();
      else if (act === 'compile') compileRun();
      else if (act === 'apply') applyScript();
      else if (act === 'export') {
        const name = S.ed.name || 'script';
        if (S.ed.lang === 'pine') download(`${slug(name)}.pine`, ta.value, 'text/plain');
        else download(`${slug(name)}.js`, `// @name ${name}\n// @kind ${S.ed.kind}\n${ta.value}`, 'text/javascript');
      } else if (act === 'import') $('.igs-file').click();
      else if (act === 'rename') {
        const old = S.ed.name, list = scripts(), rec = list.find((s) => s.name === old);
        if (!rec) { log('Save the script before renaming it.', 'w'); return; }
        const nn = (window.prompt('Rename script', old) || '').trim();
        if (!nn || nn === old) return;
        if (list.some((s) => s.name === nn)) { log(`A script named "${nn}" already exists.`, 'w'); return; }
        rec.name = nn; saveScripts(list);
        if (S.stratId === `script:${old}`) { S.stratId = `script:${nn}`; S.params[S.stratId] = S.params[`script:${old}`]; delete S.params[`script:${old}`]; }
        S.ed.name = nn; persist(); renderEditorBar(); renderSide(); renderHeader(); log(`Renamed "${old}" → "${nn}"`, 'ok');
      } else if (act === 'delete') {
        const name = S.ed.name;
        if (!scripts().some((s) => s.name === name)) { log('This script is not saved.', 'w'); return; }
        if (!window.confirm(`Delete script "${name}"?`)) return;
        saveScripts(scripts().filter((s) => s.name !== name));
        if (S.stratId === `script:${name}`) { S.stratId = 'ma_cross'; renderForm(); schedule(0); }
        S.ed.name = ''; persist(); renderEditorBar(); renderSide(); renderHeader(); log(`Deleted "${name}"`);
      }
    });
    el.addEventListener('change', (e) => {
      if (!e.target.classList.contains('igs-strat')) return;
      S.stratId = e.target.value; S.sel = null; persist(); renderForm(); schedule(0);
      if (S.sub === 'opt') renderOpt();
    });

    const unsub = host.onChange ? host.onChange(() => { if (S.on && (S.alerts || (S.tab === 'tester' && el.offsetParent !== null))) schedule(250); else ranOnce = false; }) : null;

    ta.value = S.ed.code;
    renderEditorBar(); renderGutter(); renderSide(); registerSavedIndicators();
    renderForm(); setSub(S.sub); setTab(S.tab);
    if (S.on && S.tab === 'tester') schedule(0);

    return {
      refresh() { applyTheme(); if (S.on) run(); },
      destroy() {
        clearTimeout(timer); clearTimeout(S.persistT);
        if (optRun) optRun.stopped = true;
        if (typeof unsub === 'function') unsub();
        if (host.clearOverlay) host.clearOverlay('strategy');
        if (chart) { chart.remove(); chart = null; }
        SH.destroy();
        el.innerHTML = '';
      },
    };
  }

  G.IGStrategy = {
    mount, backtest, runScript, runPine, compile, makeTA, indicatorDef, STRATEGIES, TEMPLATES, DEFAULT_PROPS, PROP_SCHEMA, TIME_LIMIT,
    testedRange, magnifierPlan, normalizeBars, optGrid, optScore, createOptimizer, OPT_METRICS, OPT_HARD_CAP, xlsx, zipStore, crc32,
    runJob, barsToCols, colsToBars, createScriptHost, fmtSources, DEEP_MAX, createPineData, pineLibs, workerIndicator, studyKey,
  };
})();
