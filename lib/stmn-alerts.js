'use strict';

// Server-side STMN alerts (kind 'stmn'): on every closed bar of (epic, interval) the AI Chance port
// (public/aichance.js, run in its own vm sandbox) is evaluated on the recent closed bars; a NEW STMN label on the
// just-closed bar fires the alert with its setup box (EL / SL / TP1-3 / lots). STMN only reads the bar OHLC, the
// UML band and ATR(14), so no higher-timeframe data is fetched.
//
// server.js wires it in (see register()): parseAlert → parse/label, reindex → sync, alertsOnTick → evaluate,
// evalStatus → status, alertMessage → message.

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const AC_FILE = path.join(__dirname, '..', 'public', 'aichance.js');
const SEED_BARS = 500, MAX_BARS = 2000, MAX_SERIES = 50;
const SIDES = ['both', 'buy', 'sell'];
const UML_PRICES = ['weighted', 'close', 'typical', 'median', 'open'];
const BANDS = ['as-of-bar', 'drawn'];

let depsOf = null;
const D = () => {
  if (!depsOf) throw new Error('stmn-alerts: register() was not called');
  return typeof depsOf === 'function' ? depsOf() : depsOf;
};
// deps: { loadLibs, getHistory, mock, MOCK, bad, parseEpic, parseAlertInterval, fireAlert, decimalsOf, marketName, DEFAULT_MESSAGE }
// (an object, or a function returning it so it can be registered before those bindings are initialised)
function register(deps) { depsOf = deps; }

let ac = null, acStamp = 0;
function loadAC() {
  let stamp = 0;
  try { stamp = fs.statSync(AC_FILE).mtimeMs; } catch {}
  if (ac && stamp === acStamp) return ac;
  try {
    const window = {};
    vm.runInContext(fs.readFileSync(AC_FILE, 'utf8'), vm.createContext({ window, console, Intl }), { filename: AC_FILE, timeout: 5000 });
    if (typeof window.AIChance?.compute !== 'function') throw new Error('AIChance not defined');
    ac = window.AIChance; acStamp = stamp;
  } catch (e) {
    console.warn('[stmn] loading aichance.js failed:', e.message);
    if (!ac) { const err = new Error(`AI Chance library unavailable: ${e.message}`); err.status = 503; throw err; }
  }
  return ac;
}

// ---- parsing
function num(v, where, lo, hi, int = false) {
  const x = typeof v === 'string' && v.trim() !== '' ? Number(v) : v;
  if (typeof x !== 'number' || !Number.isFinite(x) || x < lo || x > hi) D().bad(`${where} must be a number within ${lo}..${hi}`);
  return int ? Math.round(x) : x;
}
function parseOpts(o) {
  if (o != null && (typeof o !== 'object' || Array.isArray(o))) D().bad('opts must be an object');
  o = o || {};
  const out = {};
  const opt = (k, f) => { if (o[k] != null && o[k] !== '') out[k] = f(o[k], `opts.${k}`); };
  opt('umlPrice', (v, w) => (UML_PRICES.includes(v) ? v : D().bad(`${w} must be one of ${UML_PRICES.join(', ')}`)));
  opt('umlHalf', (v, w) => num(v, w, 1, 500, true));
  opt('umlAtrPeriod', (v, w) => num(v, w, 1, 1000, true));
  opt('umlAtrShift', (v, w) => num(v, w, 0, 500, true));
  opt('umlBandMult', (v, w) => num(v, w, 0.01, 50));
  opt('stmnBand', (v, w) => (BANDS.includes(v) ? v : D().bad(`${w} must be one of ${BANDS.join(', ')}`)));
  opt('stmnStopAtr', (v, w) => num(v, w, 0.01, 50));
  opt('riskUsd', (v, w) => num(v, w, 0.01, 1e9));
  // lot sizing (the paper engine's contract spec for this market, sent by the client)
  opt('contract', (v, w) => num(v, w, 1e-9, 1e9));
  opt('minLot', (v, w) => num(v, w, 1e-9, 1e9));
  opt('lotStep', (v, w) => num(v, w, 1e-9, 1e9));
  return out;
}
// → fields merged into the alert by parseAlert. `source/condition/value` keep the generic alert list readable.
function parse(m) {
  const d = D();
  const sides = m.sides == null || m.sides === '' ? 'both' : SIDES.includes(m.sides) ? m.sides : d.bad(`sides must be one of ${SIDES.join(', ')}`);
  const a = { epic: d.parseEpic(m.epic), interval: d.parseAlertInterval(m.interval), sides, opts: parseOpts(m.opts), source: 'mid', condition: 'stmn' };
  a.symbol = m.symbol == null ? '' : String(m.symbol).slice(0, 60);
  a.value = `${ivLabel(a.interval)} · ${sides}`;
  const k = keyOf(a);
  if (!series.has(k) && series.size >= MAX_SERIES) d.bad(`at most ${MAX_SERIES} distinct (epic, interval) series for STMN alerts`);
  return a;
}
const ivLabel = (iv) => { try { return D().loadLibs().IGTypes.label(iv); } catch { return String(iv); } };
const label = (a) => `STMN ${a.symbol || a.epic} ${ivLabel(a.interval)} ${a.sides === 'both' ? 'buy+sell' : a.sides}`;

// ---- bar series per (epic, interval), shared by every STMN alert on it
const series = new Map();
const state = new Map(); // alert id → { lastBar, lastEvalAt, lastSignal, pending, error }
const keyOf = (a) => `${a.epic}|${ivLabel(a.interval)}`;

function sync(alerts) {
  const want = new Map();
  for (const a of alerts) if (a.kind === 'stmn' && a.enabled) want.set(keyOf(a), a);
  for (const [k, S] of series) if (!want.has(k)) { clearTimeout(S.timer); series.delete(k); }
  for (const [k, a] of want) {
    if (series.has(k)) continue;
    const S = { key: k, epic: a.epic, interval: a.interval, bars: [], status: 'seeding', error: null, retryAt: null, backoff: 0, timer: null, closed: 0, cache: new Map(), lastTick: null, justClosed: false };
    series.set(k, S);
    seed(S);
  }
  for (const id of state.keys()) if (!alerts.some((a) => a.id === id && a.kind === 'stmn')) state.delete(id);
}

async function seed(S) {
  const d = D();
  S.timer = null; S.status = 'seeding';
  try {
    const T = d.loadLibs().IGTypes;
    const spec = T.parseInterval(String(S.interval));
    const base = T.baseResolution(spec, Object.keys(d.RES_SECONDS));
    const ratio = Math.max(1, Math.round(spec.sec / base.sec));
    const max = Math.min(SEED_BARS * ratio, MAX_BARS);
    if (d.MOCK && !d.mock.markets[S.epic]) d.bad(`no simulated data for ${S.epic}`);
    const { candles } = d.MOCK ? { candles: d.mock.history(S.epic, base.resolution, max) } : await d.getHistory(S.epic, base.resolution, max);
    if (series.get(S.key) !== S) return;
    if (!candles || !candles.length) d.bad('no history returned');
    S.tfSec = spec.sec;
    S.bars = T.aggregate(candles, String(S.interval)).slice(-SEED_BARS);
    S.bucket = (t) => T.aggregate([{ time: t, open: 1, high: 1, low: 1, close: 1 }], String(S.interval))[0].time;
    Object.assign(S, { status: 'ready', error: null, retryAt: null, backoff: 0, base: base.resolution });
    S.closed++;
  } catch (e) {
    if (series.get(S.key) !== S) return;
    S.backoff = Math.min(Math.max(30, S.backoff * 2), 1800);
    Object.assign(S, { status: 'waiting-data', error: e.body?.error || e.message, retryAt: Date.now() + S.backoff * 1000 });
    S.timer = setTimeout(() => seed(S), S.backoff * 1000);
    console.warn(`[stmn] seeding ${S.key} failed (${S.error}); retry in ${S.backoff}s`);
  }
}

// Folds a tick into the series once (several alerts may share it); → true when it opened a new bar (the previous one closed).
function feed(S, tick) {
  if (S.lastTick === tick) return S.justClosed;
  S.lastTick = tick; S.justClosed = false;
  const p = tick.bid != null && tick.offer != null ? (tick.bid + tick.offer) / 2 : tick.bid ?? tick.offer;
  if (p == null || !Number.isFinite(p)) return false;
  const k = S.bucket(Math.floor(tick.t / 1000)), last = S.bars[S.bars.length - 1];
  if (last && k < last.time) return false;
  if (last && k === last.time) {
    if (p > last.high) last.high = p;
    if (p < last.low) last.low = p;
    last.close = p; last.volume = (last.volume || 0) + 1;
    return false;
  }
  S.bars.push({ time: k, open: p, high: p, low: p, close: p, volume: 1 });
  if (S.bars.length > MAX_BARS) S.bars.splice(0, S.bars.length - MAX_BARS);
  if (last) { S.closed++; S.justClosed = true; }
  return S.justClosed;
}

// Pure: STMN setups on the last bar of `closedBars` (all bars closed), honouring `sides`. Also returns the last setup in the window.
function evaluateBars(closedBars, { tfSec, opts = {}, sides = 'both', ticker = '' }) {
  const AC = loadAC();
  const bars = closedBars.slice(-SEED_BARS);
  const out = AC.compute(bars, {}, { ...opts, showStmn: true }, { tfSec, ticker, confirmLast: true });
  const last = bars.length - 1;
  const want = (su) => sides === 'both' || (sides === 'buy' ? su.dir === 1 : su.dir === -1);
  const fired = (out.stmnSetups || []).filter((su) => su.bar === last && want(su)).map((su) => ({ ...su, close: bars[last].close }));
  const setups = (out.stmnSetups || []).filter(want);
  return { fired, lastSetup: setups.length ? { ...setups[setups.length - 1], close: bars[setups[setups.length - 1].bar].close } : null, bars: bars.length };
}

function evaluate(a, tick, now) {
  const S = series.get(keyOf(a));
  if (!S || S.status !== 'ready') return;
  if (!feed(S, tick)) return;
  let st = state.get(a.id);
  if (!st || st.key !== S.key) { st = { key: S.key }; state.set(a.id, st); } // new alert, or edited to another series
  try {
    const ck = `${S.closed}|${a.sides}|${JSON.stringify(a.opts || {})}`;
    let r = S.cache.get(ck);
    if (!r) {
      S.cache.clear();
      r = evaluateBars(S.bars.slice(0, -1), { tfSec: S.tfSec, opts: a.opts, sides: a.sides, ticker: `${a.epic} ${a.symbol || ''}` });
      S.cache.set(ck, r);
    }
    Object.assign(st, { lastEvalAt: now, error: null, lastSetup: r.lastSetup ? brief(a, r.lastSetup) : st.lastSetup || null });
    for (const su of r.fired) {
      if (st.lastBar != null && su.time <= st.lastBar) continue;
      st.lastBar = su.time;
      st.pending = su; st.lastSignal = brief(a, su);
      D().fireAlert(a, a.epic, su.close, now);
      if (!a.enabled) break;
    }
  } catch (e) { st.error = e.message; }
}

// ---- message
function lotsFor(a, su) {
  const o = a.opts || {};
  const contract = o.contract || autoContract(a.epic), step = o.lotStep || 0.01, min = o.minLot || 0.01;
  const raw = (o.riskUsd || 50) / (Math.abs(su.el - su.sl) * contract);
  const lots = Math.max(min, Math.floor(raw / step + 1e-9) * step);
  return Number(lots.toFixed(8));
}
// same defaults as the paper engine's autoContract (public/paper.js)
function autoContract(epic) {
  const e = String(epic || '').toUpperCase();
  if (/GOLD|XAU/.test(e)) return 100;
  if (/SILVER|XAG/.test(e)) return 5000;
  if (/BTC|BITCOIN|ETH|ETHER|XRP|LTC|SOL|CRYPTO/.test(e)) return 1;
  if (/(^|\.)(AUD|CAD|CHF|EUR|GBP|JPY|NZD|USD|SGD|HKD|NOK|SEK|ZAR|MXN|CNH|TRY)(AUD|CAD|CHF|EUR|GBP|JPY|NZD|USD|SGD|HKD|NOK|SEK|ZAR|MXN|CNH|TRY)(\.|$)/.test(e)) return 100000;
  return 1;
}
function fmtPx(a, p) {
  if (p == null || !Number.isFinite(p)) return '—';
  let d;
  try { d = D().decimalsOf(a.epic); } catch {}
  if (!Number.isInteger(d) || d < 0 || d > 10) d = Math.abs(p) >= 10000 ? 0 : Math.abs(p) >= 100 ? 2 : Math.abs(p) >= 1 ? 4 : 6;
  return p.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
}
function brief(a, su) {
  return { time: su.time, dir: su.dir, side: su.dir === 1 ? 'buy' : 'sell', el: su.el, sl: su.sl, tps: su.tps, lots: lotsFor(a, su), close: su.close };
}
function text(a, su) {
  let sym = a.symbol;
  if (!sym) { try { sym = D().marketName(a.epic); } catch { sym = a.epic; } }
  const tp = su.tps.map((p, i) => `TP${i + 1} ${fmtPx(a, p)}`).join(' / ');
  return `STMN${su.dir === 1 ? '+' : '−'} ${sym} ${ivLabel(a.interval)} · ${su.dir === 1 ? 'buy' : 'sell'} setup · EL ${fmtPx(a, su.el)} · SL ${fmtPx(a, su.sl)} · ${tp} · risk $${(a.opts && a.opts.riskUsd) || 50} = ${lotsFor(a, su)} lots`;
}
// alertMessage hook: the setup that just fired (or, for a test, the last setup in the window)
function message(a, epic, price, at) {
  const st = state.get(a.id) || {};
  const su = st.pending || (st.lastSetup ? { ...st.lastSetup } : null);
  st.pending = null;
  const body = su ? text(a, su) : `STMN ${a.symbol || a.epic} ${ivLabel(a.interval)}: test — no STMN setup in the evaluated window yet`;
  const d = D();
  if (!a.message || a.message === d.DEFAULT_MESSAGE) return body;
  const vars = {
    stmn: body, name: a.name, ticker: epic, market: a.symbol || epic, interval: a.interval, time: new Date(at).toISOString(),
    price: fmtPx(a, price), side: su ? (su.dir === 1 ? 'buy' : 'sell') : '', signal: su ? (su.dir === 1 ? 'STMN+' : 'STMN-') : '',
    el: su ? fmtPx(a, su.el) : '', sl: su ? fmtPx(a, su.sl) : '', tp1: su ? fmtPx(a, su.tps[0]) : '', tp2: su ? fmtPx(a, su.tps[1]) : '', tp3: su ? fmtPx(a, su.tps[2]) : '',
    lots: su ? String(lotsFor(a, su)) : '', risk: String((a.opts && a.opts.riskUsd) || 50),
  };
  return String(a.message).replace(/\{\{\s*(\w+)\s*\}\}/g, (m, k) => (vars[k] ?? m));
}

function status(a) {
  const st = state.get(a.id) || {};
  const S = series.get(keyOf(a));
  const base = { lastEvalAt: st.lastEvalAt ?? null, lastSignal: st.lastSignal || null, lastSetup: st.lastSetup || null };
  if (!a.enabled || !S) return { ...base, status: a.enabled ? 'idle' : 'disabled' };
  return { ...base, status: st.error ? 'error' : S.status, error: st.error || S.error || null, retryAt: S.retryAt, bars: S.bars.length, barTime: S.bars.length ? S.bars[S.bars.length - 1].time : null, baseResolution: S.base || null };
}

module.exports = { register, parse, label, sync, evaluate, evaluateBars, message, status, loadAC, _series: series, _state: state };
