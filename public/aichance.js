/* AI Chance v1.3 — JavaScript port of the Pine Script indicator (see /pine).
 *
 * Runs bar-by-bar over the chart candles with Pine semantics:
 *  - na is NaN (comparisons with na are false, arithmetic propagates na)
 *  - `var` state persists across bars; series history is read with s(arr, i, k) == arr[i-k]
 *  - ta.* calls made inside `if` blocks keep their own history (CondATR), like Pine
 *  - labels are capped at 50 (Pine's default max_labels_count), oldest removed first
 *  - request.security(..., lookahead_off): confirmed HTF values on history, developing on the last bar
 * The whole series is recomputed on every update, which matches what TradingView shows after a reload.
 */
(() => {
  const NA = NaN;
  const isNa = (x) => x === undefined || x === null || Number.isNaN(x);
  const s = (arr, i, k = 0) => (i - k >= 0 ? arr[i - k] : NA);
  const b = (arr, i, k = 0) => (i - k >= 0 ? !!arr[i - k] : false);
  const round = (x, d = 0) => { const f = 10 ** d; return Math.round(x * f) / f; };
  const fmt2 = (x) => (isNa(x) ? 'NaN' : Number(x).toFixed(2));
  const num = (x) => (isNa(x) ? 'NaN' : String(x));

  // ── Pine colors (v5 palette) ────────────────────────────
  const PALETTE = {
    red: '#FF5252', green: '#4CAF50', orange: '#FF9800', purple: '#9C27B0', blue: '#2196F3',
    teal: '#00897B', tan: '#B8956A', maroon: '#880E4F', navy: '#311B92', fuchsia: '#E040FB', gray: '#787B86', white: '#FFFFFF',
  };
  const col = (name, t = 0) => ({ name, t });
  const rgba = (c) => {
    if (!c) return 'transparent';
    const h = PALETTE[c.name] || '#888888';
    const r = parseInt(h.slice(1, 3), 16), g = parseInt(h.slice(3, 5), 16), bl = parseInt(h.slice(5, 7), 16);
    return `rgba(${r},${g},${bl},${(1 - c.t / 100).toFixed(2)})`;
  };

  // ── ta.* on full arrays ─────────────────────────────────
  function smaArr(src, n) {
    const out = new Array(src.length).fill(NA);
    let sum = 0, nas = 0;
    for (let i = 0; i < src.length; i++) {
      const v = src[i];
      if (isNa(v)) nas++; else sum += v;
      if (i >= n) { const o = src[i - n]; if (isNa(o)) nas--; else sum -= o; }
      if (i >= n - 1 && nas === 0) out[i] = sum / n;
    }
    return out;
  }
  function smoothArr(src, n, alpha) {
    const seed = smaArr(src, n);
    const out = new Array(src.length).fill(NA);
    let prev = NA;
    for (let i = 0; i < src.length; i++) {
      const v = isNa(prev) ? seed[i] : alpha * src[i] + (1 - alpha) * prev;
      out[i] = v; prev = v;
    }
    return out;
  }
  const emaArr = (src, n) => smoothArr(src, n, 2 / (n + 1));
  const rmaArr = (src, n) => smoothArr(src, n, 1 / n);
  function stdevArr(src, n) {
    const m = smaArr(src, n);
    return src.map((_, i) => {
      if (isNa(m[i])) return NA;
      let acc = 0;
      for (let k = 0; k < n; k++) acc += (src[i - k] - m[i]) ** 2;
      return Math.sqrt(acc / n);
    });
  }
  function highestArr(src, n) {
    return src.map((_, i) => { if (i < n - 1) return NA; let m = -Infinity; for (let k = 0; k < n; k++) m = Math.max(m, src[i - k]); return m; });
  }
  function lowestArr(src, n) {
    return src.map((_, i) => { if (i < n - 1) return NA; let m = Infinity; for (let k = 0; k < n; k++) m = Math.min(m, src[i - k]); return m; });
  }
  const trAt = (H, L, C, i) => (i === 0 ? H[i] - L[i] : Math.max(H[i] - L[i], Math.abs(H[i] - C[i - 1]), Math.abs(L[i] - C[i - 1])));
  function atrArr(H, L, C, n) { return rmaArr(H.map((_, i) => trAt(H, L, C, i)), n); }
  function rsiArr(C, n) {
    const up = C.map((c, i) => (i === 0 ? NA : Math.max(c - C[i - 1], 0)));
    const dn = C.map((c, i) => (i === 0 ? NA : Math.max(C[i - 1] - c, 0)));
    const ru = rmaArr(up, n), rd = rmaArr(dn, n);
    return ru.map((u, i) => { const d = rd[i]; if (isNa(u) || isNa(d)) return NA; return d === 0 ? 100 : u === 0 ? 0 : 100 - 100 / (1 + u / d); });
  }

  // ta.atr(14) called inside an `if` block: only advances on bars where the block runs
  class CondATR {
    constructor(H, L, C, n) { Object.assign(this, { H, L, C, n, hist: [], prev: NA }); }
    next(i) {
      const tr = trAt(this.H, this.L, this.C, i);
      this.hist.push(tr);
      let v;
      if (isNa(this.prev)) {
        if (this.hist.length < this.n) v = NA;
        else { const w = this.hist.slice(-this.n); v = w.some(isNa) ? NA : w.reduce((a, x) => a + x, 0) / this.n; }
      } else v = (1 / this.n) * tr + (1 - 1 / this.n) * this.prev;
      this.prev = v;
      return v;
    }
  }

  // ── Labels (Pine label.* with max_labels_count = 50) ────
  class Labels {
    constructor(max = 50) { this.all = []; this.max = max; }
    add(o) {
      const l = { ...o, alive: true };
      this.all.push(l);
      const alive = this.all.filter((x) => x.alive);
      if (alive.length > this.max) alive[0].alive = false;
      return l;
    }
    del(l) { if (l) l.alive = false; }
    live() { return this.all.filter((x) => x.alive); }
  }

  // ── Session day key (Pine dayofmonth + month*100 in exchange timezone) ──
  const dtfCache = new Map();
  function dayKey(t, tz) {
    const d = new Date(t * 1000);
    if (tz === 'UTC') return d.getUTCDate() + (d.getUTCMonth() + 1) * 100;
    if (!tz) return d.getDate() + (d.getMonth() + 1) * 100;
    let f = dtfCache.get(tz);
    if (!f) { f = new Intl.DateTimeFormat('en-US', { timeZone: tz, month: 'numeric', day: 'numeric' }); dtfCache.set(tz, f); }
    const p = f.formatToParts(d);
    return Number(p.find((x) => x.type === 'day').value) + Number(p.find((x) => x.type === 'month').value) * 100;
  }

  // ── Higher timeframe series (request.security, lookahead_off) ──
  const HTF_RES = { 5: 'MINUTE_5', 15: 'MINUTE_15', 60: 'HOUR', 240: 'HOUR_4', D: 'DAY' };
  const RES_SEC = { MINUTE: 60, MINUTE_5: 300, MINUTE_15: 900, MINUTE_30: 1800, HOUR: 3600, HOUR_4: 14400, DAY: 86400, WEEK: 604800 };

  function htfSeries(htfCandles, chart, htfSec, chartSec) {
    const n = chart.length;
    const out = { ema: new Array(n).fill(NA), ema1: new Array(n).fill(NA), close: new Array(n).fill(NA) };
    const src = htfCandles || [];
    const offset = src.length ? ((src[src.length - 1].time % htfSec) + htfSec) % htfSec : 0;
    const map = new Map(src.map((x) => [x.time, x.close]));
    if (chartSec < htfSec) for (const x of chart) map.set(Math.floor((x.time - offset) / htfSec) * htfSec + offset, x.close);
    else if (chartSec === htfSec) for (const x of chart) map.set(x.time, x.close);
    const times = [...map.keys()].sort((a, z) => a - z);
    if (!times.length) return out;
    const closes = times.map((t) => map.get(t));
    const ema = emaArr(closes, 25);
    let j = -1;
    for (let i = 0; i < n; i++) {
      const closeT = chart[i].time + chartSec;
      while (j + 1 < times.length && times[j + 1] + htfSec <= closeT) j++;
      let k = j;
      if (i === n - 1) { k = j; while (k + 1 < times.length && times[k + 1] < closeT) k++; } // developing HTF bar
      if (k >= 0) { out.ema[i] = ema[k]; out.ema1[i] = k > 0 ? ema[k - 1] : NA; out.close[i] = closes[k]; }
    }
    return out;
  }

  const DEFAULTS = {
    enabled: true,
    symbolMode: 'Auto', cooldown: 'Auto', expire: 'Auto', swBars: 'Auto', tlTimeout: 'Auto',
    tpAtr: 'Auto', slAtr: 'Auto', htf1: 'Auto', htf2: 'Auto',
    momentumThresh: 0.5,
    showSideways: true, showPl: true, showA5: true, showC1: false, showC2: false, showTma: false,
    showCards: true, showAcExtras: true, showAcLines: true, acLabelSize: 'Small',
    lblPeak: true, lblBreakout: true, lblA5cross: true, lblChance: true, lblConfirm: true, lblTmn: true, lblReady: true, lblOutcome: true, lblQuick: true,
    showStmn: true, stmnBand: "as-of-bar", showUmlAsOf: true, showStmnBox: true, riskUsd: 50, stmnStopAtr: 1.5, showStats: true, statsWin: 'TP1', statsDays: 30,
    showUml: true, umlPrice: 'weighted', umlHalf: 56, umlAtrPeriod: 110, umlAtrShift: 10, umlBandMult: 2.5,
    tradeMode: 'Trend', shortRsiThreshold: 35,
    sessionTz: 'Auto',
    fixQuickCooldown: false,
  };

  function resolve(opts, ctx) {
    const o = { ...DEFAULTS, ...opts };
    const tfMins = Math.max(1, ctx.tfSec / 60);
    const bp = (m) => Math.max(1, Math.round(m / tfMins));
    const symAuto = /BTC|BITCOIN|ETH|XRP|RIPPLE/i.test(ctx.ticker || '') ? 'Crypto' : 'Metals';
    const isCrypto = o.symbolMode === 'Auto' ? symAuto === 'Crypto' : o.symbolMode === 'Crypto (BTCUSD)';
    const pick = (v, auto, parse) => (v === 'Auto' ? auto : parse(v));
    const htf1 = o.htf1 === 'Auto' ? '15' : o.htf1;
    const htf2 = o.htf2 === 'Auto' ? (isCrypto ? '240' : '60') : o.htf2;
    return {
      o, isCrypto, tfMins,
      enterCooldown: pick(o.cooldown, bp(25), (v) => parseInt(v, 10)),
      confirmExpire: pick(o.expire, bp(50), (v) => parseInt(v, 10)),
      swBars: pick(o.swBars, bp(60), (v) => parseInt(v, 10)),
      tlTimeout: pick(o.tlTimeout, bp(100), (v) => parseInt(v, 10)),
      tpAtr: pick(o.tpAtr, isCrypto ? 1.5 : 1.0, parseFloat),
      slAtr: pick(o.slAtr, isCrypto ? 0.5 : 0.75, parseFloat),
      htf1, htf2, htf1Res: HTF_RES[htf1], htf2Res: HTF_RES[htf2],
      rsiThresh: isCrypto ? Math.max(o.shortRsiThreshold, 40) : o.shortRsiThreshold,
      tz: o.sessionTz === 'Auto' ? (isCrypto ? 'UTC' : 'America/New_York') : o.sessionTz === 'Local' ? null : o.sessionTz,
    };
  }

  /**
   * candles: [{time, open, high, low, close, volume}] ascending
   * htfData: { [IG resolution]: candles }
   * ctx: { tfSec, ticker, confirmLast }  confirmLast → treat the last bar as closed (bar-close alerts)
   */
  function compute(candles, htfData, opts, ctx) {
    const R = resolve(opts, ctx);
    const { o } = R;
    const n = candles.length;
    const res = { plots: { pl: [], a5: [], c1: [], c2: [], tmaU: [], tmaL: [], umlU: [], umlM: [], umlL: [], umlUA: [], umlLA: [] }, labels: [], panel: {}, alerts: [], lines: {}, data: {}, resolved: R };
    if (!n) return res;

    const T = candles.map((x) => x.time);
    const O = candles.map((x) => x.open), H = candles.map((x) => x.high), L = candles.map((x) => x.low), C = candles.map((x) => x.close);
    const V = candles.map((x) => x.volume || 0);
    const HLC3 = candles.map((x) => (x.high + x.low + x.close) / 3);

    // ── CORE LINES ──
    const pl = emaArr(C, 25);
    const a5 = smaArr(smaArr(O, 26), 26); // tma(open, 50): h = 50/2+1 = 26

    // ── RSI / BB / ATR / VOL ──
    const rsi14 = rsiArr(C, 14);
    const bbBasis = smaArr(C, 20), bbDev = stdevArr(C, 20);
    const bbUpper = bbBasis.map((m, i) => m + 2 * bbDev[i]), bbLower = bbBasis.map((m, i) => m - 2 * bbDev[i]);
    const atr = atrArr(H, L, C, 14), atr200 = atrArr(H, L, C, 200);
    const volSma = smaArr(V, 20);

    // ── TMA bands / TAD thresholds ──
    const tmaUpper = a5.map((v, i) => v + atr[i] * 1.5), tmaLower = a5.map((v, i) => v - atr[i] * 1.5);
    const tadBuy = tmaLower.map((v, i) => (v + a5[i]) / 2), tadSell = tmaUpper.map((v, i) => (a5[i] + v) / 2);
    // UML band (Upper / Middle / Lower): centered triangular moving average ("TMA centered bands").
    // Middle[i] = Σ_{j=-h..h} (h+1-|j|)·price[i+j] / Σ weights, truncated at the newest bar, so the last h bars repaint as new bars arrive.
    // Half-width = mult × SMA(true range, atrPeriod) taken atrShift bars back. Defaults reproduce TAD Market Navigator's band values.
    const umlH = Math.max(1, Math.round(+o.umlHalf || 56)), umlAP = Math.max(1, Math.round(+o.umlAtrPeriod || 110)), umlSh = Math.max(0, Math.round(+o.umlAtrShift || 0)), umlK = +o.umlBandMult || 2.5;
    const umlPx = { weighted: H.map((h, i) => (h + L[i] + 2 * C[i]) / 4), close: C, typical: H.map((h, i) => (h + L[i] + C[i]) / 3), median: H.map((h, i) => (h + L[i]) / 2), open: O }[o.umlPrice] || C;
    const umlMid = umlPx.map((_, i) => { let s = 0, w = 0; for (let j = -umlH; j <= umlH; j++) { const k = i + j; if (k < 0 || k >= n) continue; const wt = umlH + 1 - Math.abs(j); s += wt * umlPx[k]; w += wt; } return s / w; });
    const umlTrSma = smaArr(H.map((_, i) => trAt(H, L, C, i)), umlAP);
    const umlRange = umlTrSma.map((_, i) => (i - umlSh >= 0 ? umlTrSma[i - umlSh] : NA));
    const umlUp = umlMid.map((m, i) => m + umlK * umlRange[i]), umlLo = umlMid.map((m, i) => m - umlK * umlRange[i]);
    // as-of-bar band (what a script sees on each bar: no future bars) — used for STMN signals and the entry box
    const umlMidC = umlPx.map((_, i) => { let s2 = 0, w = 0; for (let j = -umlH; j <= 0; j++) { const k = i + j; if (k < 0) continue; const wt = umlH + 1 + j; s2 += wt * umlPx[k]; w += wt; } return s2 / w; });
    const umlUpA = umlMidC.map((m, i) => m + umlK * umlRange[i]), umlLoA = umlMidC.map((m, i) => m - umlK * umlRange[i]);
    // STMN trigger band: as-of-bar (TAD; fixed once the bar closes) or the drawn centered band (labels repaint as new bars arrive).
    const drawnTrig = o.stmnBand === "drawn", umlUpC = drawnTrig ? umlUp : umlUpA, umlLoC = drawnTrig ? umlLo : umlLoA;

    // ── Session SMA C1/C2 + VWAP (reset on day change) ──
    const c1 = new Array(n), c2 = new Array(n), vwap = new Array(n);
    { let cs = 0, cc = 0, hs = 0, hc = 0, vs = 0, vv = 0, cd = null;
      for (let i = 0; i < n; i++) {
        const d = dayKey(T[i], R.tz);
        if (cd === null || d !== cd) { cs = C[i]; cc = 1; hs = HLC3[i]; hc = 1; vs = HLC3[i] * V[i]; vv = V[i]; cd = d; }
        else { cs += C[i]; cc += 1; hs += HLC3[i]; hc += 1; vs += HLC3[i] * V[i]; vv += V[i]; }
        c1[i] = cs / cc; c2[i] = hs / hc; vwap[i] = vv > 0 ? vs / vv : NA;
      }
    }

    // ── HTF ──
    const h1 = htfSeries(htfData[R.htf1Res], candles, RES_SEC[R.htf1Res], ctx.tfSec);
    const h2 = htfSeries(htfData[R.htf2Res], candles, RES_SEC[R.htf2Res], ctx.tfSec);

    // ── Sideways (global-scope series) ──
    const swHigh = highestArr(H, R.swBars), swLow = lowestArr(L, R.swBars);

    // per-bar boolean series needed with history offsets
    const stmnBear = [], stmnBull = [], atTmaUp = [], atTmaLo = [], atBbUp = [], atBbLo = [], belowEma = [], aboveEma = [], a5Touch = [];

    const labels = new Labels(50);
    const condAtrConfirm = new CondATR(H, L, C, 14);
    const condAtrReady = new CondATR(H, L, C, 14);
    const condAtrQBuy = new CondATR(H, L, C, 14);
    const condAtrQSell = new CondATR(H, L, C, 14);

    // ── var state ──
    let a5_trend = 0, ema_trend = 0;
    let last_enter_bar = NA, last_chance_bar = NA;
    let ready_lbl = null, ready_fired = false;
    let last_peak_level = NA, last_peak_dir = 0, last_peak_bar = NA, last_peak_lbl = null;
    let breakout_alerted = false, breakout_lbl = null, breakout_bar = NA, breakout_dir = 0;
    let confirm_lbl = null, confirm_bar = NA, confirm_dir = 0;
    let tmn_lbl = null, a5cross_lbl = null, a5cross_bar = NA;
    let prox_lbl = null, last_prox_bar = NA, prox_fire_bar = NA;
    let chance_lbl = null;
    let last_tmn = NA, counter_tmn_active = false, counter_tmn_bar = NA;
    let tmn_outcome_bar = NA, tmn_outcome_dir = 0, tmn_outcome_ref = NA;
    let tl_fixed = NA, tl_fixed_atr = NA, tl_fixed_bar = NA, tl_fixed_dir = 0, tl_inval_level = NA;
    let tl_draw = null;
    let st_lbl = null, st_lines = null;
    let do_nothing_reason = '', do_nothing_watch = '', do_nothing_active = false;
    let prev_bias_dir = '', prev_proj_dir = '', prev_do_nothing = false, prev_stmn_bear = false, prev_stmn_bull = false;
    let lastStmnB = -1e9, lastStmnU = -1e9, stmnBox = null;
    const stmnLbls = [], tmnSetups = [], stmnSetups = [];
    const stmnCd = Math.max(1, Math.round(3600 / ctx.tfSec));
    let panel = {};

    for (let i = 0; i < n; i++) {
      const isLast = i === n - 1;
      const isConfirmed = !isLast || !!ctx.confirmLast;
      const open = O[i], high = H[i], low = L[i], close = C[i], volume = V[i];
      const A = atr[i];

      // ── A5 ROC & TOUCH ──
      const a5_roc = a5[i] - s(a5, i, 1), a5_roc_prev = s(a5, i, 1) - s(a5, i, 2);
      const a5_bend_up = a5_roc_prev < 0 && a5_roc >= 0;
      const a5_bend_down = a5_roc_prev > 0 && a5_roc <= 0;
      const a5_touches = a5[i] >= low && a5[i] <= high;
      a5Touch[i] = a5_touches;

      const a5_rising = a5[i] > s(a5, i, 1) && s(a5, i, 1) > s(a5, i, 2);
      const a5_falling = a5[i] < s(a5, i, 1) && s(a5, i, 1) < s(a5, i, 2);
      a5_trend = a5_rising ? 1 : a5_falling ? -1 : a5_trend;

      const a5_cross_up = a5[i] >= low && a5[i] <= high && s(a5, i, 1) < s(L, i, 1);
      const a5_cross_down = a5[i] >= low && a5[i] <= high && s(a5, i, 1) > s(H, i, 1);

      // ── EMA DIRECTION & BIAS ──
      const ema_rising = pl[i] > s(pl, i, 1) && s(pl, i, 1) > s(pl, i, 2);
      const ema_falling = pl[i] < s(pl, i, 1) && s(pl, i, 1) < s(pl, i, 2);
      ema_trend = ema_rising ? 1 : ema_falling ? -1 : ema_trend;
      const price_above_ema = close > pl[i], price_below_ema = close < pl[i];
      aboveEma[i] = price_above_ema; belowEma[i] = price_below_ema;

      const gap = (k) => Math.abs(s(a5, i, k) - s(pl, i, k));
      const a5_ema_widening = gap(0) > gap(1) && gap(1) > gap(2);
      const _struct_bear = a5[i] > pl[i] && (ema_falling || ema_trend === -1) && price_below_ema;
      const _struct_bull = a5[i] < pl[i] && (ema_rising || ema_trend === 1) && price_above_ema;
      const bias_bear = (a5[i] > pl[i] && a5_ema_widening) || _struct_bear;
      const bias_bull = (a5[i] < pl[i] && a5_ema_widening) || _struct_bull;

      // ── BB / VWAP ──
      const bb_expansion = bbDev[i] > s(bbDev, i, 5) * 1.15;
      const price_at_bb_upper = high >= bbUpper[i] * 0.999, price_at_bb_lower = low <= bbLower[i] * 1.001;
      atBbUp[i] = price_at_bb_upper; atBbLo[i] = price_at_bb_lower;
      const vwap_val = vwap[i];
      const price_above_vwap = close > vwap_val;
      const vwap_extended = Math.abs(close - vwap_val) > A * 2.0;

      // ── CANDLESTICK PATTERNS ──
      const _body = Math.abs(close - open);
      const _bull_body = close > open, _bear_body = close < open;
      const bull_engulf = _bull_body && close > s(H, i, 1) && open < s(L, i, 1);
      const bear_engulf = _bear_body && close < s(L, i, 1) && open > s(H, i, 1);
      const _upper_wick = high - Math.max(close, open), _lower_wick = Math.min(close, open) - low;
      const _is_pin_bull = _lower_wick > _body * 2 && _lower_wick > _upper_wick * 2;
      const _is_pin_bear = _upper_wick > _body * 2 && _upper_wick > _lower_wick * 2;

      // ── TAD / TL ──
      const tl_cross_bull = s(C, i, 1) <= s(tadBuy, i, 1) && close > tadBuy[i];
      const tl_cross_bear = s(C, i, 1) >= s(tadSell, i, 1) && close < tadSell[i];
      const price_at_tma_upper = high >= tadSell[i] * 0.999 && close < tadSell[i];
      const price_at_tma_lower = low <= tadBuy[i] * 1.001 && close > tadBuy[i];
      atTmaUp[i] = price_at_tma_upper; atTmaLo[i] = price_at_tma_lower;
      const tma_rejection_bear = price_at_tma_upper && _bear_body;
      const tma_rejection_bull = price_at_tma_lower && _bull_body;
      const stmn_bear = close >= tadSell[i], stmn_bull = close <= tadBuy[i];
      stmnBear[i] = stmn_bear; stmnBull[i] = stmn_bull;
      // ── STMN (TAD-style): close beyond the as-of-bar outer UML band, at most once per hour per side.
      // Entry box: entry at the band, stop = entry ± stmnStopAtr × ATR(14), targets at 0.75R / 1.5R / 2R.
      if (stmnBox && stmnBox.status === 'open' && i > stmnBox.bar) {
        const d = stmnBox.dir, tp = stmnBox.tps;
        if (d === -1 ? high >= stmnBox.sl : low <= stmnBox.sl) { stmnBox.status = 'stopped'; stmnBox.endBar = i; }
        else { const hit = tp.filter((p) => (d === -1 ? low <= p : high >= p)).length; stmnBox.hit = Math.max(stmnBox.hit || 0, hit); if (hit === tp.length) { stmnBox.status = 'target'; stmnBox.endBar = i; } }
      }
      if (isConfirmed && !isNa(umlUpC[i]) && !isNa(A)) {
        const mk = (d) => {
          const el = d === -1 ? umlUpC[i] : umlLoC[i], risk = (+o.stmnStopAtr || 1.5) * A;
          stmnBox = { dir: d, bar: i, el, sl: el - d * risk, risk, tps: [0.75, 1.5, 2].map((r) => el + d * r * risk), status: 'open', hit: 0 };
          stmnSetups.push({ bar: i, dir: d, el, sl: stmnBox.sl, tps: stmnBox.tps });
        };
        if (close >= umlUpC[i] && i - lastStmnB >= stmnCd) { stmnLbls.push({ bar: i, text: 'STMN-', color: col('tan', 10), style: 'down', kind: 'stmn', y: high, gap: 4 }); mk(-1); lastStmnB = i; }
        if (close <= umlLoC[i] && i - lastStmnU >= stmnCd) { stmnLbls.push({ bar: i, text: 'STMN+', color: col('tan', 10), style: 'up', kind: 'stmn', y: low, gap: 4 }); mk(1); lastStmnU = i; }
      }

      // ── HTF BIAS ──
      const htf_15_bull = h1.ema[i] > h1.ema1[i] && close > h1.ema[i];
      const htf_15_bear = h1.ema[i] < h1.ema1[i] && close < h1.ema[i];
      const htf_1h_bull = h2.ema[i] > h2.ema1[i] && h2.close[i] > h2.ema[i];
      const htf_1h_bear = h2.ema[i] < h2.ema1[i] && h2.close[i] < h2.ema[i];
      const htf_bull_score = (htf_15_bull ? 1 : 0) + (htf_1h_bull ? 1 : 0);
      const htf_bear_score = (htf_15_bear ? 1 : 0) + (htf_1h_bear ? 1 : 0);
      const htf_bull = htf_bull_score >= 1, htf_bear = htf_bear_score >= 1;
      const htf_strong_bull = htf_bull_score === 2, htf_strong_bear = htf_bear_score === 2;

      // ── VOLUME ──
      const vol_bull = volume > volSma[i] * 1.3 && close > open;
      const vol_bear = volume > volSma[i] * 1.3 && close < open;
      const vol_climax = volume > volSma[i] * 2.5;

      // ── TMN SCORING ──
      const c1gt = c1[i] > c2[i], c1lt = c1[i] < c2[i];
      const _tmn_bear_count = (stmn_bear ? 1 : 0) + (price_at_tma_upper ? 1 : 0) + (_bear_body ? 1 : 0) + (rsi14[i] > 55 ? 1 : 0) + (price_below_ema ? 1 : 0) + (c1gt ? 1 : 0) + (price_at_bb_upper ? 1 : 0) + (htf_bear ? 1 : 0) + (vol_bear ? 1 : 0);
      const _tmn_bull_count = (stmn_bull ? 1 : 0) + (price_at_tma_lower ? 1 : 0) + (_bull_body ? 1 : 0) + (rsi14[i] < 45 ? 1 : 0) + (price_above_ema ? 1 : 0) + (c1lt ? 1 : 0) + (price_at_bb_lower ? 1 : 0) + (htf_bull ? 1 : 0) + (vol_bull ? 1 : 0);
      const _tmn_bear_prev = (b(stmnBear, i, 1) ? 1 : 0) + (b(atTmaUp, i, 1) ? 1 : 0) + (s(C, i, 1) < s(O, i, 1) ? 1 : 0) + (s(rsi14, i, 1) > 55 ? 1 : 0) + (b(belowEma, i, 1) ? 1 : 0) + (s(c1, i, 1) > s(c2, i, 1) ? 1 : 0) + (b(atBbUp, i, 1) ? 1 : 0);
      const _tmn_bull_prev = (b(stmnBull, i, 1) ? 1 : 0) + (b(atTmaLo, i, 1) ? 1 : 0) + (s(C, i, 1) > s(O, i, 1) ? 1 : 0) + (s(rsi14, i, 1) < 45 ? 1 : 0) + (b(aboveEma, i, 1) ? 1 : 0) + (s(c1, i, 1) < s(c2, i, 1) ? 1 : 0) + (b(atBbLo, i, 1) ? 1 : 0);

      const bias_bear_pts = (_struct_bear ? 2 : 0) + (bias_bear ? 1 : 0) + (ema_trend === -1 ? 1 : 0) + (price_below_ema ? 1 : 0) + (htf_bear ? 1 : 0) + (htf_strong_bear ? 1 : 0) + (a5_trend === -1 ? 1 : 0) + (c1gt ? 1 : 0);
      const bias_bull_pts = (_struct_bull ? 2 : 0) + (bias_bull ? 1 : 0) + (ema_trend === 1 ? 1 : 0) + (price_above_ema ? 1 : 0) + (htf_bull ? 1 : 0) + (htf_strong_bull ? 1 : 0) + (a5_trend === 1 ? 1 : 0) + (c1lt ? 1 : 0);
      const bias_net = bias_bull_pts - bias_bear_pts;

      const _tmn_bull_guard = stmn_bull && close > open && !htf_bear && !bias_bear && bias_net >= -1;
      const _tmn_bear_guard = stmn_bear && close < open && !htf_bull && !bias_bull && bias_net <= -1;
      const tmn_bear_signal = ((_tmn_bear_count >= 4 && _tmn_bear_prev >= 3) || tl_cross_bear) && _tmn_bear_guard;
      const tmn_bull_signal = ((_tmn_bull_count >= 4 && _tmn_bull_prev >= 3) || tl_cross_bull) && _tmn_bull_guard;

      // ── CHANCE LABEL (A5 touch) ──
      const a5_cool = isNa(last_enter_bar) || i - last_enter_bar >= R.enterCooldown;
      const _bear_context_a5 = a5[i] > pl[i] && (ema_falling || ema_trend === -1) && price_below_ema;
      const _bull_context_a5 = a5[i] < pl[i] && (ema_rising || ema_trend === 1) && price_above_ema;
      const _a5_touch_trend_ok = bias_bear || bias_bull || (!_bear_context_a5 && !_bull_context_a5);
      const a5_touch_ok = a5_touches && a5_cool && _a5_touch_trend_ok && (!prox_lbl || i - last_prox_bar >= R.enterCooldown * 3);
      if (a5_touch_ok) {
        labels.del(confirm_lbl); confirm_lbl = null; confirm_bar = NA; confirm_dir = 0;
        labels.del(ready_lbl); ready_lbl = null;
        if (!breakout_alerted) ready_fired = false;
        last_enter_bar = i; last_chance_bar = i;
        const text = bias_bear ? 'Chance SELL?' : bias_bull ? 'Chance BUY?' : 'Chance';
        const c = bias_bear ? col('red', 40) : bias_bull ? col('green', 40) : col('purple', 10);
        labels.del(chance_lbl);
        chance_lbl = labels.add({ bar: i, text, color: c, style: bias_bear ? 'down' : 'up', kind: 'chance', y: bias_bear ? high + A * 0.8 : low - A * 0.8, y2: bias_bear ? high : low, line: c });
      }

      // ── PEAK LABEL ──
      if (a5_bend_up && !b(a5Touch, i, 2)) {
        last_peak_level = s(a5, i, 1); last_peak_dir = -1; last_peak_bar = i - 1;
        if (last_peak_lbl) last_peak_lbl.color = col('red', 20);
        last_peak_lbl = labels.add({ bar: i - 1, text: 'Peak', color: col('blue', 20), style: 'up', kind: 'peak', y: Math.min(s(L, i, 1), s(a5, i, 1)) - A * 2.5, ly1: s(a5, i, 1), y2: s(L, i, 1), line: col('blue', 40) });
        if (!breakout_alerted) { labels.del(ready_lbl); ready_lbl = null; ready_fired = false; }
      }
      if (a5_bend_down && !b(a5Touch, i, 2)) {
        last_peak_level = s(a5, i, 1); last_peak_dir = 1; last_peak_bar = i - 1;
        if (last_peak_lbl) last_peak_lbl.color = col('red', 20);
        last_peak_lbl = labels.add({ bar: i - 1, text: 'Peak', color: col('blue', 20), style: 'down', kind: 'peak', y: Math.max(s(H, i, 1), s(a5, i, 1)) + A * 2.5, ly1: s(a5, i, 1), y2: s(H, i, 1), line: col('blue', 40) });
        if (!breakout_alerted) { labels.del(ready_lbl); ready_lbl = null; ready_fired = false; }
      }

      // ── PROXIMITY CHANCE ──
      const _prox_atr = A;
      const _prox_dist = Math.abs(close - a5[i]);
      const _prox_active = !breakout_alerted && !confirm_lbl && !a5_touches;
      const _prox_near = _prox_dist <= _prox_atr * 1.5;
      const _prox_cool = isNa(last_prox_bar) || i - last_prox_bar >= R.enterCooldown * 3;
      const _prox_above = close > a5[i] && s(C, i, 1) > a5[i];
      const _p_dir_pre = _prox_above ? -1 : 1;
      const _bear_context = _bear_context_a5, _bull_context = _bull_context_a5;
      const _p_bias_ok = !((bias_bear || _struct_bear || _bear_context) && _p_dir_pre === 1) && !((bias_bull || _struct_bull || _bull_context) && _p_dir_pre === -1);

      if (prox_lbl) {
        const t = prox_lbl.text;
        const flipBear = (t.includes('BUY') || t.includes('↑')) && (bias_bear || _struct_bear || _bear_context);
        const flipBull = (t.includes('SELL') || t.includes('↓')) && (bias_bull || _struct_bull || _bull_context);
        if (flipBear || flipBull) { labels.del(prox_lbl); prox_lbl = null; prox_fire_bar = NA; }
      }

      if (_prox_active && _prox_near && _prox_cool && !prox_lbl && _p_bias_ok) {
        const d = _prox_above ? -1 : 1;
        const sc = ((d === 1 && a5_trend === -1) || (d === -1 && a5_trend === 1) ? 1 : 0)
          + ((d === 1 && ema_trend === 1) || (d === -1 && ema_trend === -1) ? 1 : 0)
          + ((d === 1 && c1lt) || (d === -1 && c1gt) ? 1 : 0)
          + ((d === 1 && rsi14[i] < 50) || (d === -1 && rsi14[i] > 50) ? 1 : 0)
          + ((d === 1 && price_above_vwap) || (d === -1 && !price_above_vwap) ? 1 : 0)
          + ((d === 1 && (bull_engulf || _is_pin_bull)) || (d === -1 && (bear_engulf || _is_pin_bear)) ? 1 : 0)
          + ((d === 1 && tma_rejection_bull) || (d === -1 && tma_rejection_bear) ? 1 : 0)
          + ((d === 1 && htf_bull) || (d === -1 && htf_bear) ? 1 : 0)
          + ((d === 1 && htf_strong_bull) || (d === -1 && htf_strong_bear) ? 1 : 0)
          + ((d === 1 && vol_bull) || (d === -1 && vol_bear) ? 1 : 0);
        const dots = sc >= 8 ? '●●●●●' : sc >= 6 ? '●●●●' : sc >= 4 ? '●●●' : sc >= 2 ? '●●' : sc >= 1 ? '●' : '○';
        const action = d === 1 ? 'BUY' : 'SELL';
        const text = sc >= 2 ? `Chance ${action} ${dots}` : `Watch ${d === 1 ? '↑' : '↓'} ${dots}`;
        const c = sc >= 7 ? col('purple', 0) : sc >= 5 ? col('purple', 10) : sc >= 3 ? col('purple', 25) : sc >= 1 ? col('purple', 45) : col('purple', 60);
        prox_lbl = labels.add({ bar: i, text, color: c, style: d === -1 ? 'down' : 'up', kind: 'prox', y: d === -1 ? high + _prox_atr * 0.8 : low - _prox_atr * 0.8, y2: d === -1 ? high : low, line: c });
        last_prox_bar = i; prox_fire_bar = i;
      } else if (!(_prox_active && _prox_near)) {
        labels.del(prox_lbl); prox_lbl = null; prox_fire_bar = NA;
      }

      // ── BREAKOUT WARNING ──
      if (!isNa(last_peak_level) && !breakout_alerted && i > last_peak_bar + 1 && i <= last_peak_bar + 20) {
        if (last_peak_dir === -1 && close > last_peak_level && close > open) {
          labels.del(breakout_lbl);
          breakout_lbl = labels.add({ bar: i, text: '⚠ Breakout Up', color: col('orange', 10), style: 'down', kind: 'breakout', y: high + A * 0.8, y2: high, line: col('orange', 30) });
          breakout_alerted = true; breakout_bar = i; breakout_dir = 1;
        }
        if (last_peak_dir === 1 && close < last_peak_level && close < open) {
          labels.del(breakout_lbl);
          breakout_lbl = labels.add({ bar: i, text: '⚠ Breakout Down', color: col('orange', 10), style: 'up', kind: 'breakout', y: low - A * 0.8, y2: low, line: col('orange', 30) });
          breakout_alerted = true; breakout_bar = i; breakout_dir = -1;
        }
      }
      if (!isNa(breakout_bar) && i > breakout_bar) breakout_lbl = null; // stays on chart, no longer tracked

      // ── A5 CROSSOVER SIGNAL ──
      if (a5_cross_up || a5_cross_down) {
        if (confirm_lbl) { labels.del(confirm_lbl); confirm_lbl = null; confirm_bar = NA; confirm_dir = 0; }
        ready_fired = false; breakout_alerted = false;
        labels.del(a5cross_lbl);
        a5cross_lbl = labels.add({ bar: i, text: a5_cross_up ? 'A5 SELL Bias' : 'A5 BUY Bias', color: a5_cross_up ? col('red', 20) : col('green', 20), style: a5_cross_up ? 'down' : 'up', kind: 'a5cross', y: a5_cross_up ? high + A * 1.0 : low - A * 1.0, y2: a5_cross_up ? high : low, line: a5_cross_up ? col('red', 20) : col('green', 20) });
        a5cross_bar = i;
      }

      // ── READY / CONFIRMED ──
      if (breakout_alerted && !isNa(breakout_bar) && i > breakout_bar) {
        const _atr14 = condAtrConfirm.next(i);
        const _cur_up = breakout_dir === 1 && close > open && !bias_bear && !_struct_bear;
        const _cur_down = breakout_dir === -1 && close < open && !bias_bull && !_struct_bull;
        const _cur_match = _cur_up || _cur_down;
        const d = _cur_up ? 1 : -1;
        if (_cur_match && ready_fired) {
          const _bc = Math.abs(close - open), _bp = Math.abs(s(C, i, 1) - s(O, i, 1)), _ba = (_bc + _bp) / 2;
          const ok = {
            ema: (d === 1 && (ema_trend === 1 || price_above_ema)) || (d === -1 && (ema_trend === -1 || price_below_ema)),
            a5: (d === 1 && a5_trend === -1) || (d === -1 && a5_trend === 1),
            sess: (d === 1 && c1lt && close > c1[i]) || (d === -1 && c1gt && close < c1[i]),
            rsi: (d === 1 && rsi14[i] < 55) || (d === -1 && rsi14[i] > 45),
            bb: (d === 1 && (close <= bbLower[i] || bb_expansion)) || (d === -1 && (close >= bbUpper[i] || bb_expansion)),
            vwap: (d === 1 && price_above_vwap && !vwap_extended) || (d === -1 && !price_above_vwap && !vwap_extended),
            cand: (d === 1 && (bull_engulf || _is_pin_bull)) || (d === -1 && (bear_engulf || _is_pin_bear)),
            tma: (d === 1 && tma_rejection_bull) || (d === -1 && tma_rejection_bear),
            htf: (d === 1 && htf_bull) || (d === -1 && htf_bear),
            htfs: (d === 1 && htf_strong_bull) || (d === -1 && htf_strong_bear),
            vol: (d === 1 && vol_bull) || (d === -1 && vol_bear),
          };
          const raw = (_ba >= _atr14 * o.momentumThresh * 0.4 ? 1 : 0) + Object.values(ok).filter(Boolean).length - (vol_climax ? 1 : 0);
          const sc = Math.max(0, raw);
          const strong = sc >= 4 && (_bc >= _atr14 * o.momentumThresh || _bp >= _atr14 * o.momentumThresh);
          const medium = !strong && sc >= 1;
          const dots = sc >= 9 ? '●●●●●' : sc >= 7 ? '●●●●' : sc >= 5 ? '●●●' : sc >= 3 ? '●●' : sc >= 1 ? '●' : '○';
          const tag = dots + (ok.htfs ? ' HTF✓✓' : ok.htf ? ' HTF✓' : '') + (ok.vol ? ' Vol✓' : vol_climax ? ' VolX' : '');
          const text = strong ? `${d === 1 ? 'BUY ' : 'SELL '}✓ ${tag}` : medium ? `${d === 1 ? 'Chance BUY ' : 'Chance SELL '}${tag}` : `Watch ${d === 1 ? '↑' : '↓'} ${tag}`;
          const c = strong ? (d === 1 ? col('green', 0) : col('red', 0)) : medium ? col('orange', 20) : col('purple', 50);
          labels.del(confirm_lbl); labels.del(ready_lbl); ready_lbl = null;
          const lc = strong ? (d === 1 ? col('green', 20) : col('red', 20)) : medium ? col('orange', 40) : col('purple', 60);
          confirm_lbl = labels.add({ bar: i, text, color: c, style: 'up', size: strong ? 'normal' : 'small', kind: 'confirm', y: low - _atr14 * 0.5, y2: low, line: lc });
          confirm_bar = i; confirm_dir = d; ready_fired = false; breakout_alerted = false;
          for (let q = tmnSetups.length - 1; q >= 0; q--) { const su = tmnSetups[q]; if (i - su.bar > R.confirmExpire * 2) break; if (su.dir === d && !su.confirmed) { Object.assign(su, { confirmed: true, cbar: i, entry: close, atrAt: _atr14 }); break; } }
        } else if (_cur_match && !confirm_lbl) {
          const _ratr = condAtrReady.next(i);
          const tl = !isNa(last_peak_level) ? ' ' + num(round(last_peak_level, 1)) : '';
          labels.del(ready_lbl);
          ready_lbl = labels.add({ bar: i, text: (d === 1 ? '▲ TL+ Watch' : '▼ TL- Watch') + tl, color: d === 1 ? col('teal', 20) : col('maroon', 20), style: 'left', kind: 'ready', dx: 1, y: low - _ratr * 0.5, y2: low, line: d === 1 ? col('teal', 50) : col('maroon', 50), hline: { from: -5, color: d === 1 ? col('teal', 20) : col('maroon', 20) } });
          ready_fired = true;
        } else if (!_cur_match) {
          labels.del(ready_lbl); ready_lbl = null; ready_fired = false;
        }
      }

      // ── CONFIRMED EXPIRY ──
      if (confirm_lbl && !isNa(confirm_bar) && i > confirm_bar + R.confirmExpire) {
        const expired = (confirm_dir === 1 && close < s(L, i, R.confirmExpire)) || (confirm_dir === -1 && close > s(H, i, R.confirmExpire));
        if (expired) { labels.del(confirm_lbl); confirm_lbl = null; confirm_bar = NA; confirm_dir = 0; }
      }
      // ── PROXIMITY LABEL EXPIRY (label stays, stops being tracked) ──
      if (prox_lbl && !isNa(prox_fire_bar) && i > prox_fire_bar + R.confirmExpire) { prox_lbl = null; prox_fire_bar = NA; }
      // ── A5 CROSS LABEL FADE ──
      if (a5cross_lbl && !isNa(a5cross_bar) && i === a5cross_bar + R.confirmExpire) {
        a5cross_lbl.color = col('gray', 40); a5cross_lbl.faded = true; a5cross_lbl = null; a5cross_bar = NA;
      }

      // ── TL INVALIDATION + EXPIRY ──
      if (!isNa(tl_fixed) && !isNa(tl_fixed_bar)) {
        const met = tl_fixed_dir === 1 ? close <= tl_fixed : close >= tl_fixed;
        const expired = i - tl_fixed_bar > R.tlTimeout;
        const deviated = tl_fixed_dir === 1 ? close < tl_fixed - tl_fixed_atr * 2.0 : close > tl_fixed + tl_fixed_atr * 2.0;
        if (met || expired || deviated) { tl_fixed = NA; tl_fixed_atr = NA; tl_fixed_bar = NA; tl_fixed_dir = 0; tl_inval_level = NA; }
      }
      // ── TL LINE + LABEL (last bar) ──
      if (isLast) {
        tl_draw = null;
        if (!isNa(tl_fixed) && !isNa(tl_fixed_bar)) {
          const bull = tl_fixed_dir === 1;
          const score = (tl_fixed - close) / atr200[i];
          tl_draw = { price: tl_fixed, fromBar: tl_fixed_bar, bull, score, text: `${bull ? '▲' : '▼'} ${bull ? 'TL+' : 'TL-'}  ${fmt2(tl_fixed)}  ${num(round(score, 4))}`, color: bull ? col('teal', 0) : col('red', 0) };
        }
      }

      // ── SIDEWAYS ──
      const swRange = swHigh[i] - swLow[i];
      const swRangePct = (swRange / close) * 100;
      const swExpected = A * Math.sqrt(R.swBars);
      const swAtrRatio = swRange / swExpected;
      const emaSlope = Math.abs(pl[i] - s(pl, i, 5)) / A;
      const a5Flat = Math.abs(a5[i] - s(a5, i, 6)) < A * 0.3;
      const isSideways = swAtrRatio < 1.2 && a5Flat;
      const mx0 = (x) => (isNa(x) ? NA : Math.max(0, x));
      const swPct = Math.round((mx0(1 - swAtrRatio / 1.2) * 0.4 + mx0(1 - Math.abs(a5[i] - s(a5, i, 6)) / (A * 0.3)) * 0.3 + mx0(1 - emaSlope / 0.5) * 0.2 + (1 - Math.min(1, Math.abs(rsi14[i] - 50) / 25)) * 0.1) * 100);
      if (isLast) {
        panel.sideways = o.showSideways && isSideways && swPct >= 50
          ? { text: `↔ Sideways ${swPct}%\nRange: ${num(round(swRange, 1))}pt  (${num(round(swRangePct, 2))}%)`, color: swPct >= 80 ? col('red', 20) : swPct >= 65 ? col('orange', 20) : col('gray', 20) }
          : null;
      }

      // ── TMN OUTCOME EVALUATION ──
      if (!isNa(tmn_outcome_bar) && !isNa(tmn_outcome_ref)) {
        const since = i - tmn_outcome_bar;
        if (since === R.confirmExpire) {
          const target = A * 1.5;
          const won = (tmn_outcome_dir === 1 && high >= tmn_outcome_ref + target) || (tmn_outcome_dir === -1 && low <= tmn_outcome_ref - target);
          labels.add({ bar: tmn_outcome_bar, text: won ? '✓' : '✗', color: won ? col('green', 20) : col('red', 20), style: tmn_outcome_dir === 1 ? 'up' : 'down', size: 'tiny', kind: 'outcome', y: tmn_outcome_dir === 1 ? s(L, i, since) - A * 1.5 : s(H, i, since) + A * 1.5 });
          tmn_outcome_bar = NA; tmn_outcome_ref = NA;
        }
      }

      // ── TMN LABELS ──
      const tmn_cool = isNa(last_tmn) || i - last_tmn >= R.enterCooldown * 2;
      if (tmn_bear_signal && tmn_cool) {
        if (bias_net >= 2) { counter_tmn_active = true; counter_tmn_bar = i; }
        const td = _tmn_bear_count >= 7 ? '●●●●●' : _tmn_bear_count >= 6 ? '●●●●' : _tmn_bear_count >= 5 ? '●●●' : '●●';
        labels.del(tmn_lbl);
        tmnSetups.push({ bar: i, dir: -1, confirmed: false });
        tmn_lbl = labels.add({ bar: i, text: 'TMN- ' + td, color: col('orange', 10), style: 'down', kind: 'tmn', y: high + A * 0.6, y2: high, line: col('orange', 30) });
        last_tmn = i; tl_fixed = tmaUpper[i]; tl_fixed_atr = A; tl_fixed_bar = i; tl_fixed_dir = -1; tl_inval_level = high;
        tmn_outcome_bar = i; tmn_outcome_dir = -1; tmn_outcome_ref = close;
      }
      if (tmn_bull_signal && tmn_cool) {
        if (bias_net <= -2) { counter_tmn_active = true; counter_tmn_bar = i; }
        const td = _tmn_bull_count >= 7 ? '●●●●●' : _tmn_bull_count >= 6 ? '●●●●' : _tmn_bull_count >= 5 ? '●●●' : '●●';
        labels.del(tmn_lbl);
        tmnSetups.push({ bar: i, dir: 1, confirmed: false });
        tmn_lbl = labels.add({ bar: i, text: 'TMN+ ' + td, color: col('green', 10), style: 'up', kind: 'tmn', y: low - A * 0.6, y2: low, line: col('green', 30) });
        last_tmn = i; tl_fixed = tmaLower[i]; tl_fixed_atr = A; tl_fixed_bar = i; tl_fixed_dir = 1; tl_inval_level = low;
        tmn_outcome_bar = i; tmn_outcome_dir = 1; tmn_outcome_ref = close;
      }

      // ── BIAS LABEL (last bar) ──
      if (isLast) {
        const dir = bias_net >= 2 ? '▲ BIAS UP' : bias_net <= -2 ? '▼ BIAS DOWN' : '◆ NEUTRAL';
        const str = Math.abs(bias_net) >= 6 ? ' ●●●' : Math.abs(bias_net) >= 4 ? ' ●●' : Math.abs(bias_net) >= 2 ? ' ●' : '';
        const htf = htf_strong_bull ? ' | HTF ▲▲' : htf_bull ? ' | HTF ▲' : htf_strong_bear ? ' | HTF ▼▼' : htf_bear ? ' | HTF ▼' : ' | HTF –';
        const dist = round(Math.abs(close - a5[i]) / A, 1);
        panel.bias = {
          text: `${dir}${str}${htf} | A5 ${close > a5[i] ? 'above' : 'below'} ${num(dist)}x`,
          color: bias_net >= 4 ? col('green', 10) : bias_net >= 2 ? col('green', 35) : bias_net <= -4 ? col('red', 10) : bias_net <= -2 ? col('red', 35) : col('gray', 30),
        };
      }

      // ── PROJECTION ──
      const a5SlopeNow = a5[i] - s(a5, i, 3), a5SlopePrev = s(a5, i, 3) - s(a5, i, 6);
      const a5StillDown = a5SlopeNow < 0 && a5SlopePrev < 0, a5StillUp = a5SlopeNow > 0 && a5SlopePrev > 0;
      const emaStillDown = pl[i] - s(pl, i, 3) < 0, emaStillUp = pl[i] - s(pl, i, 3) > 0;
      const m1 = close - s(C, i, 1), m2 = s(C, i, 1) - s(C, i, 2), m3 = s(C, i, 2) - s(C, i, 3);
      const bearAccel = m1 < m2 && m2 < m3, bullAccel = m1 > m2 && m2 > m3;
      const bearFading = m1 < 0 && m1 > m2, bullFading = m1 > 0 && m1 < m2;
      const last3Bear = close < open && s(C, i, 1) < s(O, i, 1) && s(C, i, 2) < s(O, i, 2);
      const last3Bull = close > open && s(C, i, 1) > s(O, i, 1) && s(C, i, 2) > s(O, i, 2);
      const r = rsi14[i];
      const rsiOversold = r < 30, rsiOverbought = r > 70, rsiExtBear = r < 25, rsiExtBull = r > 75;
      const proj_score = (a5StillDown ? -2 : 0) + (a5StillUp ? 2 : 0) + (emaStillDown ? -1 : 0) + (emaStillUp ? 1 : 0)
        + (bearAccel ? -2 : 0) + (bullAccel ? 2 : 0) + (bearFading ? 1 : 0) + (bullFading ? -1 : 0)
        + (last3Bear ? -1 : 0) + (last3Bull ? 1 : 0)
        + (htf_strong_bear ? -2 : htf_bear ? -1 : 0) + (htf_strong_bull ? 2 : htf_bull ? 1 : 0)
        + (rsiExtBear ? 2 : rsiOversold ? 1 : 0) + (rsiExtBull ? -2 : rsiOverbought ? -1 : 0);
      const proj_dir = proj_score <= -5 ? 'CONTINUE DOWN' : proj_score <= -2 ? 'LIKELY DOWN' : proj_score >= 5 ? 'CONTINUE UP' : proj_score >= 2 ? 'LIKELY UP' : 'UNCERTAIN';
      const bounce_bear = proj_score > 0 && bias_net <= -2;
      const bounce_bull = proj_score < 0 && bias_net >= 2;

      if (isLast) {
        const distNow = Math.abs(close - a5[i]) / A;
        const snapImm = distNow >= 3.0, snapExt = distNow >= 4.5;
        const barsEst = snapExt ? 2 : snapImm ? 3 : Math.abs(proj_score) >= 6 ? 5 : 3;
        const minsEst = Math.round(barsEst * (ctx.tfSec / 60));
        const warn = snapExt ? ' ⚡EXTREME STRETCH' : snapImm ? ' ⚠ stretched' : '';
        const rr = num(Math.round(r));
        const rsiStr = rsiExtBear ? ` RSI:${rr} extreme` : rsiOversold ? ` RSI:${rr} oversold` : rsiExtBull ? ` RSI:${rr} extreme` : rsiOverbought ? ` RSI:${rr} overbought` : '';
        const mom = bearAccel ? ' mom:▼▼' : bullAccel ? ' mom:▲▲' : bearFading || bullFading ? ' mom:fade' : '';
        let icon = proj_score <= -5 ? '📉' : proj_score <= -2 ? '🔻' : proj_score >= 5 ? '📈' : proj_score >= 2 ? '🔺' : '↔';
        let dirTxt = proj_dir;
        icon = bounce_bear ? '↩' : bounce_bull ? '↪' : icon;
        dirTxt = bounce_bear ? 'BOUNCE WATCH' : bounce_bull ? 'PULLBACK WATCH' : dirTxt;
        panel.proj = {
          text: `${icon} ${dirTxt} ~${minsEst}-${minsEst * 5}min${warn}${rsiStr}${mom}`,
          color: proj_score <= -3 ? col('red', 20) : proj_score >= 3 ? col('green', 20) : bounce_bear || bounce_bull ? col('orange', 20) : col('gray', 30),
        };
      }

      // ── CLEAR COUNTER TMN FLAG ──
      if (counter_tmn_active && !isNa(counter_tmn_bar) && i - counter_tmn_bar > R.confirmExpire * 2) { counter_tmn_active = false; counter_tmn_bar = NA; }

      // ── WAIT / DO NOTHING (last bar) ──
      if (isLast) {
        panel.wait = null;
        const distA5 = Math.abs(close - a5[i]) / A;
        const between = close > tadBuy[i] && close < tadSell[i];
        const momFading = proj_score > -2 && proj_score < 2;
        const bounceInProg = bounce_bear || bounce_bull;
        const noSignal = !confirm_lbl && !prox_lbl && !breakout_alerted;
        const extendedNoSignal = distA5 >= 2.5 && noSignal;
        const mixedInside = between && Math.abs(bias_net) <= 2 && noSignal;
        const exhausted = momFading && Math.abs(bias_net) >= 2 && noSignal && distA5 >= 1.0;
        const strongDirectional = Math.abs(bias_net) >= 3 && distA5 >= 2.0;
        const shouldWait = !strongDirectional && (bounceInProg || extendedNoSignal || mixedInside || exhausted || counter_tmn_active);
        if (shouldWait) {
          const reason = counter_tmn_active ? `counter-trend signal — bias still ${bias_net <= -2 ? 'DOWN' : 'UP'}, wait`
            : bounceInProg ? 'counter-trend bounce — let it play out'
              : extendedNoSignal ? 'extended from A5 — no reversal signal yet'
                : mixedInside ? 'inside bands — no clear edge'
                  : exhausted ? 'momentum fading — wait for new setup' : 'no clear edge';
          const a5s = num(round(a5[i], 1));
          const watch = bias_net <= -2 ? `Watch: price back to A5 (${a5s}) for SELL setup` : bias_net >= 2 ? `Watch: A5 (${a5s}) cross for BUY setup` : 'Watch: bias label for direction';
          panel.wait = { text: `⏸ DO NOTHING  |  ${reason}\n${watch}`, color: col('gray', 15) };
          do_nothing_reason = reason; do_nothing_watch = watch; do_nothing_active = true;
        } else { do_nothing_reason = ''; do_nothing_watch = ''; do_nothing_active = false; }
      }

      // ── SHORT TRADE MODE ──
      const modeShort = o.tradeMode === 'Short Trade' || o.tradeMode === 'Both';
      const stDist = Math.abs(close - a5[i]) / A;
      const stExtOk = close <= tadBuy[i] || close >= tadSell[i];
      // Pine evaluates this after TMN labels updated last_tmn, so it is false whenever TMN fires (see fixQuickCooldown)
      const stCool = o.fixQuickCooldown ? tmn_cool : isNa(last_tmn) || i - last_tmn >= R.enterCooldown * 2;
      const shortBuy = modeShort && tmn_bull_signal && stCool && stExtOk && bias_net > -2;
      const shortSell = modeShort && tmn_bear_signal && stCool && stExtOk && bias_net < 2;
      if (shortBuy || shortSell) { labels.del(st_lbl); st_lbl = null; st_lines = null; }
      const quick = (dir, atrNow) => {
        const tp = round(atrNow * R.tpAtr, 2), sl = round(atrNow * R.slAtr, 2);
        const tpPrice = close + dir * tp, slPrice = close - dir * sl;
        const rr = round(tp / sl, 1);
        const hold = (stDist >= 3.5 ? 5 : stDist >= 2.5 ? 4 : 3) * Math.round(ctx.tfSec / 60);
        const counter = dir === 1 ? bias_net <= -2 : bias_net >= 2;
        const head = dir === 1 ? '⚡ QUICK BUY' : '⚡ QUICK SELL';
        const detail = `${head}\nEntry: ${fmt2(close)}\nTP: ${dir === 1 ? '+' : '-'}${fmt2(tp)} → ${fmt2(tpPrice)}\nSL: ${dir === 1 ? '-' : '+'}${fmt2(sl)} → ${fmt2(slPrice)}\nR:R = 1:${num(rr)}\nATR: ${fmt2(atrNow)}\nHold ~${hold}min max\nBias: ${counter ? '⚠ Counter-trend' : '✓ With bias'}`;
        st_lbl = labels.add({ bar: i, text: head, detail, color: dir === 1 ? col('teal', 0) : col('orange', 0), style: dir === 1 ? 'up' : 'down', kind: 'quick', y: dir === 1 ? low - atrNow * 1.2 : high + atrNow * 1.2 });
        st_lines = { tp: tpPrice, sl: slPrice, bar: i };
      };
      if (shortBuy) quick(1, condAtrQBuy.next(i));
      if (shortSell) quick(-1, condAtrQSell.next(i));

      if (o.tradeMode === 'Short Trade') {
        if (confirm_lbl) { labels.del(confirm_lbl); confirm_lbl = null; }
        if (ready_lbl) { labels.del(ready_lbl); ready_lbl = null; }
        if (breakout_lbl) { labels.del(breakout_lbl); breakout_lbl = null; }
        if (tmn_lbl) { labels.del(tmn_lbl); tmn_lbl = null; }
      }
      if (st_lbl) {
        const isBuy = st_lbl.text.includes('QUICK BUY'), isSell = st_lbl.text.includes('QUICK SELL');
        if ((isBuy && bias_net <= -2) || (isSell && bias_net >= 2)) { labels.del(st_lbl); st_lbl = null; st_lines = null; }
      }

      // ── ALERTS (JSON payload as in Pine) ──
      const biasDirStr = bias_net >= 2 ? 'BIAS UP' : bias_net <= -2 ? 'BIAS DOWN' : 'NEUTRAL';
      const common = () => ({
        symbol: ctx.ticker, timeframe: String(Math.round(ctx.tfSec / 60)), price: round(close, 2), atr: round(A, 4), rsi: round(r, 2),
        bias_score: bias_net, bias_dir: biasDirStr, a5_dist: round(Math.abs(close - a5[i]) / A, 3), stmn: stmn_bull || stmn_bear ? 1 : 0,
        tma_lower: round(tmaLower[i], 2), tma_middle: round(a5[i], 2), tma_upper: round(tmaUpper[i], 2),
        uml_upper: round(umlUp[i], 2), uml_middle: round(umlMid[i], 2), uml_lower: round(umlLo[i], 2),
        buy_thresh: round(tadBuy[i], 2), sell_thresh: round(tadSell[i], 2),
        tl_score: !isNa(tl_fixed) ? round((tl_fixed - close) / atr200[i], 4) : 0.0,
        sym_mode: R.isCrypto ? 'Crypto' : 'Metals',
        htf: htf_strong_bull ? 'UP_STRONG' : htf_bull ? 'UP' : htf_strong_bear ? 'DOWN_STRONG' : htf_bear ? 'DOWN' : 'NEUTRAL',
        projection: proj_dir, do_nothing: do_nothing_active ? 1 : 0, dn_reason: do_nothing_reason, dn_watch: do_nothing_watch,
      });
      const alert = (signal, extra = {}) => res.alerts.push({ bar: i, time: T[i], payload: { signal, ...extra, ...common() } });
      if (isConfirmed) {
        if (tmn_bull_signal && tmn_cool) alert('TMN+');
        if (tmn_bear_signal && tmn_cool) alert('TMN-');
        if (confirm_lbl && confirm_dir === 1) alert('BUY');
        if (confirm_lbl && confirm_dir === -1) alert('SELL');
        if (ready_fired && last_peak_dir === -1) alert('TMN+ Watch');
        if (ready_fired && last_peak_dir === 1) alert('TMN- Watch');
        if (biasDirStr !== prev_bias_dir && prev_bias_dir !== '') alert('BIAS CHANGE', { prev_bias: prev_bias_dir });
        prev_bias_dir = biasDirStr;
        if (proj_dir !== prev_proj_dir && prev_proj_dir !== '') alert('PROJ CHANGE', { prev_proj: prev_proj_dir });
        prev_proj_dir = proj_dir;
        if (do_nothing_active !== prev_do_nothing) alert('DO NOTHING');
        prev_do_nothing = do_nothing_active;
        if (stmn_bear && !prev_stmn_bear) alert('STMN-', { zone: 'ABOVE SELL THRESHOLD' });
        if (stmn_bull && !prev_stmn_bull) alert('STMN+', { zone: 'BELOW BUY THRESHOLD' });
        prev_stmn_bear = stmn_bear; prev_stmn_bull = stmn_bull;
      }

      if (isLast) {
        res.data = {
          ATR14: A, RSI14: r, BIAS_NET: bias_net, A5_DIST: Math.abs(close - a5[i]) / A, STMN: stmn_bull || stmn_bear ? 1 : 0,
          TMA_LOWER: tmaLower[i], TMA_MIDDLE: a5[i], TMA_UPPER: tmaUpper[i], UML_UPPER: umlUp[i], UML_MIDDLE: umlMid[i], UML_LOWER: umlLo[i], BUY_THRESH: tadBuy[i], SELL_THRESH: tadSell[i],
          TL_SCORE: !isNa(tl_fixed) ? (tl_fixed - close) / atr200[i] : NA, PROJ_SCORE: proj_score,
          HTF1: `${R.htf1}${isNa(h1.ema[i]) ? ' (no data)' : ''}`, HTF2: `${R.htf2}${isNa(h2.ema[i]) ? ' (no data)' : ''}`,
        };
      }
    }

    // ── Output ──
    for (let i = 0; i < n; i++) {
      const t = T[i];
      if (!isNa(pl[i])) res.plots.pl.push({ time: t, value: pl[i] });
      if (!isNa(a5[i])) res.plots.a5.push({ time: t, value: a5[i] });
      res.plots.c1.push({ time: t, value: c1[i] });
      res.plots.c2.push({ time: t, value: c2[i] });
      if (!isNa(tmaUpper[i])) res.plots.tmaU.push({ time: t, value: tmaUpper[i] });
      if (!isNa(tmaLower[i])) res.plots.tmaL.push({ time: t, value: tmaLower[i] });
      if (!isNa(umlMid[i]) && !isNa(umlRange[i])) {
        res.plots.umlU.push({ time: t, value: umlUp[i] }); res.plots.umlL.push({ time: t, value: umlLo[i] });
        res.plots.umlM.push({ time: t, value: umlMid[i], color: i && umlMid[i] < umlMid[i - 1] ? '#B22833' : '#1B7F5C' });
        res.plots.umlUA.push({ time: t, value: umlUpA[i] }); res.plots.umlLA.push({ time: t, value: umlLoA[i] });
      }
    }
    res.labels = labels.live().map((l) => ({ ...l, time: T[Math.max(0, Math.min(n - 1, l.bar))], css: rgba(l.color), lineCss: l.line ? rgba(l.line) : null, hline: l.hline ? { ...l.hline, css: rgba(l.hline.color) } : null }));
    for (const k of Object.keys(panel)) if (panel[k]) panel[k].css = rgba(panel[k].color);
    if (st_lbl && st_lbl.alive) panel.quick = { text: st_lbl.detail, css: rgba(st_lbl.color) };
    if (tl_draw) { tl_draw.css = rgba(tl_draw.color); panel.tl = { text: tl_draw.text, css: tl_draw.css }; }
    res.panel = panel;
    // STMN statistics over the loaded bars (TAD-style table): a setup is confirmed when price closes back inside the band
    // within the cooldown window; it then wins if the chosen target is reached before the stop, otherwise loses; unresolved = open.
    const st = { buy: { setups: 0, confirmed: 0, w: 0, l: 0, open: 0 }, sell: { setups: 0, confirmed: 0, w: 0, l: 0, open: 0 } };
    const tpIdx = { TP1: 0, TP2: 1, TP3: 2 }[o.statsWin] ?? 0;
    const days = Math.max(1, +o.statsDays || 30), cutoff = T[n - 1] - days * 86400;
    for (const su of stmnSetups) {
      if (T[su.bar] < cutoff) continue;
      const b = su.dir === 1 ? st.buy : st.sell, d = su.dir; b.setups++;
      let cbar = -1;
      for (let k = su.bar + 1; k < Math.min(n, su.bar + 1 + stmnCd); k++) if (d === -1 ? C[k] < su.el : C[k] > su.el) { cbar = k; break; }
      if (cbar < 0) continue;
      b.confirmed++;
      let r = 'open';
      for (let k = cbar + 1; k < n; k++) {
        if (d === -1 ? H[k] >= su.sl : L[k] <= su.sl) { r = 'l'; break; }
        if (d === -1 ? L[k] <= su.tps[tpIdx] : H[k] >= su.tps[tpIdx]) { r = 'w'; break; }
      }
      b[r === 'open' ? 'open' : r]++;
    }
    const fromIdx = T.findIndex((t) => t >= cutoff);
    res.stats = { ...st, from: T[Math.max(0, fromIdx)], to: T[n - 1], bars: n - Math.max(0, fromIdx), tfSec: ctx.tfSec, days, partial: T[0] > cutoff + 3600 };
    res.stmnSetups = stmnSetups.map((su) => ({ ...su, time: T[su.bar], risk: Math.abs(su.el - su.sl) }));
    res.stmnCd = stmnCd;
    res.stmnLabels = stmnLbls.slice(-50).map((l) => ({ ...l, time: T[l.bar], css: rgba(l.color) }));
    res.stmnBox = stmnBox && stmnBox.bar >= n - 60 ? { ...stmnBox, time: T[stmnBox.bar], endTime: stmnBox.endBar != null ? T[stmnBox.endBar] : null } : null;
    res.lines = { tl: tl_draw, quick: st_lbl && st_lbl.alive ? st_lines : null };
    return res;
  }

  // Human-readable alert text, worded like the on-chart cards (the JSON payload stays available for webhooks).
  function describeAlert(p) {
    if (!p) return '';
    const f = (x, d = 2) => (typeof x === 'number' && Number.isFinite(x) ? x.toLocaleString(undefined, { minimumFractionDigits: d, maximumFractionDigits: d }) : '—');
    const htf = { UP_STRONG: 'HTF ▲▲', UP: 'HTF ▲', DOWN_STRONG: 'HTF ▼▼', DOWN: 'HTF ▼', NEUTRAL: 'HTF –' }[p.htf] || '';
    const bias = p.bias_dir === 'BIAS UP' ? '▲ BIAS UP' : p.bias_dir === 'BIAS DOWN' ? '▼ BIAS DOWN' : '◆ NEUTRAL';
    const ctxLine = `${bias} | ${htf} | ${p.projection || ''} | price ${f(p.price)} · RSI ${f(p.rsi, 0)} · A5 ${f(p.tma_middle, 1)}`;
    let head;
    switch (p.signal) {
      case 'DO NOTHING':
        head = p.do_nothing ? `⏸ DO NOTHING | ${p.dn_reason || 'no clear edge'}\n${p.dn_watch || ''}` : `▶ SETUP ACTIVE AGAIN | ${bias}, ${String(p.projection || '').toLowerCase()}`;
        break;
      case 'BUY': head = `🟢 BUY CONFIRMED at ${f(p.price)}`; break;
      case 'SELL': head = `🔴 SELL CONFIRMED at ${f(p.price)}`; break;
      case 'TMN+': head = `▲ TMN+ | reversal-up signal at ${f(p.price)}`; break;
      case 'TMN-': head = `▼ TMN- | reversal-down signal at ${f(p.price)}`; break;
      case 'TMN+ Watch': head = '👀 TMN+ WATCH | possible reversal up forming'; break;
      case 'TMN- Watch': head = '👀 TMN- WATCH | possible reversal down forming'; break;
      case 'BIAS CHANGE': head = `🔄 BIAS CHANGE | ${p.prev_bias || '—'} → ${p.bias_dir} (score ${p.bias_score})`; break;
      case 'PROJ CHANGE': head = `📊 PROJECTION | ${p.prev_proj || '—'} → ${p.projection}`; break;
      case 'STMN-': head = `⚠ STMN- | stretched above the sell threshold (${f(p.sell_thresh)})`; break;
      case 'STMN+': head = `⚠ STMN+ | stretched below the buy threshold (${f(p.buy_thresh)})`; break;
      default: head = String(p.signal || 'Signal');
    }
    return p.signal === 'DO NOTHING' && p.do_nothing ? head : `${head}\n${ctxLine}`;
  }

  // ── STMN backtest: trade-by-trade simulation of the STMN entry boxes ──────────────────────────
  // candles: the bars compute() ran on; out: its result (uses out.stmnSetups / out.stmnCd / out.stats).
  // Triggers are evaluated on the (mid) bar prices; fills pay half the spread on entry and on exit.
  // Within a bar the price path is O → … → C; `ambiguity` picks the order of the high and the low:
  //   'sl'   worst case: the adverse extreme comes first (after a fill on the same bar), so SL wins ties
  //   'tp'   best case: the favourable extreme comes first
  //   'ohlc' bar direction: up bars go O→L→H→C, down bars O→H→L→C
  const BT_DEFAULTS = {
    entry: 'limit',      // 'limit' (EL touched after the signal) | 'close' (signal bar close) | 'confirm' (close of the confirmation bar)
    exit: 'TP1',         // 'TP1' | 'TP2' | 'TP3' | 'scale' (1/3 at each target)
    breakeven: true,     // scale-out only: stop to entry after TP1
    ambiguity: 'sl', spread: 0, commission: 0, // spread in price units; commission in $ per lot, round turn
    riskUsd: 50, contract: 1, minLot: 0.01, lotStep: 0.01, maxLot: 0,
    fillBars: 0,         // limit entry: bars the order stays working (0 → the STMN cooldown, 1 h)
    oneAtATime: false,   // skip setups while an earlier trade is still working
    days: 0,             // simulate setups from the last N days only (0 → all loaded bars)
    statsWin: 'TP1', statsDays: 30,
  };
  function stmnBacktest(candles, out, opts = {}) {
    const p = { ...BT_DEFAULTS, ...opts };
    const n = candles.length, setups = (out && out.stmnSetups) || [];
    const res = { opts: p, trades: [], skipped: { notConfirmed: 0, noFill: 0, invalidated: 0, beyondStop: 0, targetPassed: 0, busy: 0, pending: 0 }, summary: null, equity: [], compare: null };
    if (!n) return res;
    const O = candles.map((x) => x.open), H = candles.map((x) => x.high), L = candles.map((x) => x.low), C = candles.map((x) => x.close), T = candles.map((x) => x.time);
    const cd = Math.max(1, out.stmnCd || 12), fillBars = +p.fillBars > 0 ? Math.round(+p.fillBars) : cd;
    const half = Math.max(0, +p.spread || 0) / 2, comm = Math.max(0, +p.commission || 0), contract = +p.contract > 0 ? +p.contract : 1;
    const scale = p.exit === 'scale', tpIdx = { TP1: 0, TP2: 1, TP3: 2 }[p.exit] ?? 0;
    const step = +p.lotStep > 0 ? +p.lotStep : 0.01, minLot = +p.minLot > 0 ? +p.minLot : step;
    const lotsFor = (risk) => {
      let lots = Math.max(minLot, Math.floor((+p.riskUsd || 50) / (risk * contract) / step + 1e-9) * step);
      if (+p.maxLot > 0) lots = Math.min(lots, +p.maxLot);
      return Number(lots.toFixed(8));
    };
    const from = +p.days > 0 ? T[n - 1] - p.days * 86400 : -Infinity;
    const MODE = p.ambiguity === 'tp' || p.ambiguity === 'ohlc' ? p.ambiguity : 'sl';
    let busyUntil = -1;

    for (const su of setups) {
      if (su.bar >= n || T[su.bar] < from) continue;
      if (p.oneAtATime && su.bar <= busyUntil) { res.skipped.busy++; continue; }
      const t = simulate(su);
      if (typeof t === 'string') { res.skipped[t]++; continue; }
      res.trades.push(t);
      busyUntil = t.status === 'open' ? n : t.exitBar;
    }

    function simulate(su) {
      const d = su.dir, el = su.el, tps = su.tps;
      let state = 'pending', entry = NaN, entryBar = -1, k0;
      if (p.entry === 'close' || p.entry === 'confirm') {
        let eb = su.bar;
        if (p.entry === 'confirm') {
          eb = -1;
          for (let k = su.bar + 1; k < Math.min(n, su.bar + 1 + cd); k++) if (d === -1 ? C[k] < el : C[k] > el) { eb = k; break; }
          if (eb < 0) return su.bar + cd >= n ? 'pending' : 'notConfirmed';
        }
        entry = C[eb]; entryBar = eb; state = 'open'; k0 = eb + 1;
        if (d === 1 ? entry <= su.sl : entry >= su.sl) return 'beyondStop';
        if (!opts._keepPassed && (d === 1 ? entry >= tps[scale ? 0 : tpIdx] : entry <= tps[scale ? 0 : tpIdx])) return 'targetPassed';
      } else k0 = su.bar + 1;
      const plannedEntry = state === 'open' ? entry : el, risk = Math.abs(plannedEntry - su.sl);
      if (!(risk > 0)) return 'beyondStop';
      const lots = lotsFor(risk);
      let sl = su.sl, next = scale ? 0 : tpIdx, rem = 1;
      const legs = [];
      const hit = (lvl, up, a, b) => (up ? (a >= lvl ? a : b >= lvl ? lvl : null) : (a <= lvl ? a : b <= lvl ? lvl : null));
      for (let k = k0; k < n; k++) {
        if (state === 'pending' && k > su.bar + fillBars) return 'noFill';
        const adv = d === 1 ? L[k] : H[k], fav = d === 1 ? H[k] : L[k];
        let path;
        if (MODE === 'ohlc') path = C[k] >= O[k] ? [O[k], L[k], H[k], C[k]] : [O[k], H[k], L[k], C[k]];
        else {
          const reach = state === 'pending' && (d === -1 ? O[k] > el && L[k] <= el : O[k] < el && H[k] >= el);
          const mid = MODE === 'sl' ? [adv, fav] : [fav, adv];
          path = reach ? [O[k], el, ...mid, C[k]] : [O[k], ...mid, C[k]];
        }
        for (let s = 0; s < path.length; s++) {
          let a = s === 0 ? path[0] : path[s - 1];
          const b = path[s];
          for (let guard = 0; guard < 8; guard++) {
            // candidate events on a → b: [price, kind]
            let ev = null;
            const consider = (lvl, up, kind) => {
              const at = hit(lvl, up, a, b);
              if (at == null) return;
              const dist = Math.abs(at - a);
              if (!ev || dist < ev.dist) ev = { at, kind, dist };
            };
            if (state === 'pending') { consider(el, d === 1, 'fill'); consider(su.sl, d === -1, 'cancel'); }
            else { consider(sl, d === -1, 'sl'); if (next < 3) consider(tps[next], d === 1, 'tp'); }
            if (!ev) break;
            a = ev.at;
            if (ev.kind === 'cancel') return 'invalidated';
            if (ev.kind === 'fill') { state = 'open'; entry = ev.at; entryBar = k; continue; }
            if (ev.kind === 'sl') {
              legs.push({ frac: rem, px: ev.at, bar: k, why: legs.length && Math.abs(sl - entry) < 1e-12 ? 'BE' : 'SL' }); rem = 0;
            } else {
              const frac = scale ? (next === 2 ? rem : 1 / 3) : 1;
              legs.push({ frac, px: ev.at, bar: k, why: 'TP' + (next + 1) }); rem -= frac;
              if (scale && next === 0 && p.breakeven) sl = entry;
              next = scale ? next + 1 : 3;
            }
            if (rem <= 1e-9) return finish(su, d, entry, entryBar, lots, legs, 'closed');
          }
        }
      }
      if (state === 'pending') return 'pending';
      if (rem > 1e-9) legs.push({ frac: rem, px: C[n - 1], bar: n - 1, why: 'open' });
      return finish(su, d, entry, entryBar, lots, legs, 'open');
    }
    function finish(su, d, entry, entryBar, lots, legs, status) {
      const ePx = entry + d * half;
      const perUnit = legs.reduce((s, g) => s + g.frac * d * (g.px - d * half - ePx), 0);
      const exitPx = legs.reduce((s, g) => s + g.frac * g.px, 0) - d * half;
      const R = perUnit / Math.abs(entry - su.sl);
      const pnl = perUnit * lots * contract - comm * lots;
      const last = legs[legs.length - 1];
      const reason = status === 'open' ? 'open' : scale ? legs.map((g) => g.why).join('+') : last.why;
      return { setupBar: su.bar, time: T[su.bar], side: d === 1 ? 'buy' : 'sell', dir: d, el: su.el, sl: su.sl, tps: su.tps,
        entryBar, entryTime: T[entryBar], entry: ePx, exitBar: last.bar, exitTime: T[last.bar], exit: exitPx, reason, status, R, pnl, lots,
        legs: legs.map((g) => ({ frac: g.frac, px: g.px, time: T[g.bar], why: g.why })) };
    }

    // summary over closed trades, equity in exit order
    const closed = res.trades.filter((t) => t.status === 'closed');
    const byExit = [...closed].sort((a, z) => a.exitBar - z.exitBar || a.setupBar - z.setupBar);
    let eq = 0, peak = 0, dd = 0, ddR = 0, eqR = 0, peakR = 0;
    for (const t of byExit) {
      eq += t.pnl; eqR += t.R; peak = Math.max(peak, eq); peakR = Math.max(peakR, eqR);
      dd = Math.max(dd, peak - eq); ddR = Math.max(ddR, peakR - eqR);
      res.equity.push({ time: t.exitTime, eq, eqR });
    }
    const wins = closed.filter((t) => t.pnl > 0), losses = closed.filter((t) => t.pnl < 0);
    const gw = wins.reduce((s, t) => s + t.pnl, 0), gl = -losses.reduce((s, t) => s + t.pnl, 0);
    const sumR = closed.reduce((s, t) => s + t.R, 0);
    const open = res.trades.filter((t) => t.status === 'open');
    res.summary = {
      setups: setups.filter((su) => su.bar < n && T[su.bar] >= from).length, trades: closed.length, open: open.length, openPnl: open.reduce((s, t) => s + t.pnl, 0),
      wins: wins.length, losses: losses.length, flat: closed.length - wins.length - losses.length,
      targetExits: closed.filter((t) => /^TP/.test(t.reason)).length, stopExits: closed.filter((t) => !/^TP/.test(t.reason)).length,
      winRate: closed.length ? wins.length / closed.length : null, avgR: closed.length ? sumR / closed.length : null, sumR,
      expectancy: closed.length ? (gw - gl) / closed.length : null, netPnl: gw - gl, grossWin: gw, grossLoss: gl,
      avgWin: wins.length ? gw / wins.length : null, avgLoss: losses.length ? -gl / losses.length : null,
      profitFactor: gl > 0 ? gw / gl : gw > 0 ? Infinity : null, maxDD: dd, maxDDR: ddR,
      from: T[0], to: T[n - 1], bars: n,
    };

    // comparison with the stats table: same window, the table's rules replayed here, then the chosen rules
    if (!opts._nested && out.stats) {
      const days = Math.max(1, +p.statsDays || 30);
      const wnd = { ...opts, days, oneAtATime: false, _nested: true };
      const replica = stmnBacktest(candles, out, { ...wnd, entry: 'confirm', exit: p.statsWin || 'TP1', ambiguity: 'sl', spread: 0, commission: 0, _keepPassed: true });
      const mine = stmnBacktest(candles, out, { ...opts, days, _nested: true });
      const S = out.stats, all = (k) => S.buy[k] + S.sell[k];
      // the table scores a setup by which level is reached first (TP → w, SL → l), so the replica counts exits by level, not by $ sign
      const tally = (r) => ({ setups: r.summary.setups, trades: r.summary.trades, wins: r.summary.wins, losses: r.summary.losses, targetExits: r.summary.targetExits, stopExits: r.summary.stopExits, open: r.summary.open, netPnl: r.summary.netPnl, skipped: r.skipped });
      res.compare = { days, stats: { setups: all('setups'), confirmed: all('confirmed'), w: all('w'), l: all('l'), open: all('open') }, replica: tally(replica), mine: tally(mine) };
    }
    return res;
  }

  // CSV of the trades table
  function stmnBacktestCSV(bt, fmtTime = (t) => new Date(t * 1000).toISOString()) {
    const rows = [['signal_time', 'side', 'entry_time', 'entry', 'exit_time', 'exit', 'reason', 'status', 'R', 'pnl_usd', 'lots', 'EL', 'SL', 'TP1', 'TP2', 'TP3']];
    for (const t of bt.trades) rows.push([fmtTime(t.time), t.side, fmtTime(t.entryTime), t.entry, fmtTime(t.exitTime), t.exit, t.reason, t.status, t.R.toFixed(3), t.pnl.toFixed(2), t.lots, t.el, t.sl, ...t.tps]);
    return rows.map((r) => r.map((v) => (typeof v === 'number' ? String(Number(v.toPrecision(10))) : /[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v))).join(',')).join('\n') + '\n';
  }

  window.AIChance = { compute, resolve, DEFAULTS, HTF_RES, RES_SEC, rgba, describeAlert, stmnBacktest, stmnBacktestCSV, BT_DEFAULTS };
})();
