'use strict';

// Extended history: IG supplies the recent bars; older bars come from a free source and are stitched on in front.
//   crypto → Bitstamp (the feed TradingView's "BTCUSD · Bitstamp" uses), everything Dukascopy knows → Dukascopy.
// The older bars are shifted by the median close difference measured where both feeds overlap, so there is no
// price jump at the seam (broker feeds differ by a small, slowly varying offset). Volume is rescaled the same way.

const path = require('path');
const duka = require('./dukascopy');
const bitstamp = require('./bitstamp');

const MEM_TTL_MS = 10 * 60 * 1000;
const mem = new Map();

function pick({ epic, name }) {
  const order = String(process.env.HISTORY_PROVIDERS || 'bitstamp,dukascopy').split(',').map((s) => s.trim().toLowerCase());
  for (const p of order) {
    if (p === 'bitstamp') { const i = bitstamp.instrumentFor({ epic, name }); if (i && bitstamp.supports(i)) return { provider: 'bitstamp', instrument: i }; }
    if (p === 'dukascopy') { const i = duka.instrumentFor({ epic, name }); if (i && duka.supports(i)) return { provider: 'dukascopy', instrument: i }; }
  }
  return null;
}
// Whether this market has an extended source (used to lift the bar cap).
const available = (m, sec) => process.env.HISTORY_EXT !== '0' && sec >= 60 && sec <= 86400 && !!pick(m);

const median = (a) => { if (!a.length) return NaN; const s = [...a].sort((x, y) => x - y), k = s.length >> 1; return s.length % 2 ? s[k] : (s[k - 1] + s[k]) / 2; };

function aggregate(bars, sec) {
  const out = [];
  let cur = null;
  for (const b of bars) {
    const t = Math.floor(b.time / sec) * sec;
    if (!cur || cur.time !== t) { cur = { time: t, open: b.open, high: b.high, low: b.low, close: b.close, volume: b.volume || 0, n: 1 }; out.push(cur); }
    else { cur.high = Math.max(cur.high, b.high); cur.low = Math.min(cur.low, b.low); cur.close = b.close; cur.volume += b.volume || 0; cur.n++; }
  }
  return out;
}

async function fetchBase({ provider, instrument }, sec, side, fromSec, toSec, cacheDir) {
  if (provider === 'bitstamp') {
    const step = bitstamp.stepFor(sec);
    return { step, bars: await bitstamp.getCandles({ instrument, fromSec, toSec, step, cacheDir }) };
  }
  const step = sec < 3600 ? 60 : sec < 86400 ? 3600 : 86400;
  return { step, bars: await duka.getCandles({ instrument, side: side.toUpperCase(), fromSec, toSec, step, cacheDir: path.join(cacheDir, 'dukascopy') }) };
}

// Background fill: fetch [fromSec, toSec) one day at a time, newest first, retrying each day patiently.
// Finished days are disk-cached by the providers, so later loads get the full range quickly. One job per series.
const warming = new Map();
function warm(src, sec, side, fromSec, toSec, cacheDir, log = () => {}) {
  const key = [src.provider, src.instrument, sec < 3600 ? 60 : sec < 86400 ? 3600 : 86400, side].join('|');
  const job = warming.get(key);
  if (job && job.from <= fromSec) return job.promise;
  const state = { from: fromSec };
  state.promise = (async () => {
    let ok = 0, failed = 0;
    const span = sec < 3600 ? 86400 : sec < 86400 ? 31 * 86400 : 366 * 86400;
    for (let hi = toSec; hi > fromSec; hi -= span) {
      const lo = Math.max(fromSec, hi - span);
      for (let attempt = 0; attempt < 5; attempt++) {
        try { await fetchBase(src, sec, side, lo, hi, cacheDir); ok++; break; } catch (e) {
          if (attempt === 4) { failed++; log(`[history-ext] ${src.instrument} ${new Date(lo * 1000).toISOString().slice(0, 10)} gave up: ${e.message}`); }
          else await new Promise((r) => setTimeout(r, 5000 * (attempt + 1)));
        }
      }
    }
    log(`[history-ext] ${src.instrument} ${side} background fill done: ${ok} periods ok, ${failed} failed`);
  })().finally(() => warming.delete(key));
  warming.set(key, state);
  return state.promise;
}
// Pre-fill a market's older history in the background (called at server start).
function prefetch({ epic, name, days = 45, side = 'mid', cacheDir, log }) {
  const src = pick({ epic, name });
  if (!src) return null;
  const now = Math.floor(Date.now() / 1000);
  const minute = warm(src, 300, side, now - days * 86400, now, cacheDir, log);
  return minute.then(() => warm(src, 3600, side, now - 365 * 86400, now, cacheDir, log));
}

// ig: ascending IG candles (the recent part). Returns { candles, source } with up to `want` bars in total.
async function extend({ epic, name, sec, ig, want, side = 'mid', cacheDir }) {
  const src = pick({ epic, name });
  if (!src || ig.length >= want || !available({ epic, name }, sec)) return { candles: ig, source: null };
  // No IG bars (e.g. IG allowance exhausted): the free source supplies everything up to now, unaligned.
  const nowBar = Math.floor(Date.now() / 1000 / sec) * sec;
  const missing = want - ig.length, igFirst = ig.length ? ig[0].time : nowBar + sec, igLast = ig.length ? ig[ig.length - 1].time : nowBar;
  const key = [src.provider, src.instrument, sec, side, igFirst, missing].join('|');
  const hit = mem.get(key);
  if (hit && Date.now() - hit.at < MEM_TTL_MS) return { candles: hit.older.concat(ig), source: hit.source };

  const crypto = src.provider === 'bitstamp' || /BTC|ETH/.test(src.instrument);
  // Calendar span needed for `missing` bars: markets that close need extra room for weekends and daily breaks.
  const span = crypto ? missing * sec + 2 * sec : Math.ceil(missing * sec * 1.5) + 4 * 86400;
  const now = Math.floor(Date.now() / 1000);
  // Overlap window for alignment: the first hours of the IG data (Dukascopy publishes about an hour late).
  const toSec = Math.min(igLast + sec, igFirst + Math.max(6 * 3600, 60 * sec), now - (src.provider === 'dukascopy' ? 2 * 3600 : 0));
  const fromSec = Math.floor((igFirst - span) / sec) * sec;
  // Newest-first 5-day chunks: a failing chunk (free feeds have outage bursts) keeps what is already contiguous to the seam.
  const parts = [];
  let partial = null;
  for (let hi = Math.max(toSec, igFirst); hi > fromSec;) {
    const lo = Math.max(fromSec, hi - 5 * 86400);
    try { parts.unshift((await fetchBase(src, sec, side, lo, hi, cacheDir)).bars); } catch (e) {
      partial = e.message;
      warm(src, sec, side, fromSec, lo + 86400, cacheDir, console.warn).catch(() => {});
      if (!parts.length) throw e;
      break;
    }
    hi = lo;
  }
  const agg = aggregate(parts.flat(), sec);

  const igAt = new Map(ig.map((c) => [c.time, c]));
  const dPx = [], rVol = [];
  for (const b of agg) {
    const c = igAt.get(b.time);
    if (!c || b.time + sec > toSec) continue;
    dPx.push(c.close - b.close);
    if (b.volume > 0 && c.volume > 0) rVol.push(c.volume / b.volume);
  }
  const offset = dPx.length >= 5 ? median(dPx) : 0, vk = rVol.length >= 5 ? median(rVol) : 1;
  const older = agg.filter((b) => b.time < igFirst).slice(-missing).map((b) => ({
    time: b.time, open: b.open + offset, high: b.high + offset, low: b.low + offset, close: b.close + offset, volume: Math.round(b.volume * vk * 100) / 100,
  }));
  const source = older.length ? {
    provider: src.provider, instrument: src.instrument, bars: older.length, from: older[0].time, to: igFirst,
    offset: Math.round(offset * 1e5) / 1e5, matched: dPx.length, ...(partial ? { partial } : {}),
  } : null;
  // A partial result is only kept briefly so the next load retries the missing chunks (finished files are disk-cached).
  mem.set(key, { at: partial ? Date.now() - MEM_TTL_MS + 30000 : Date.now(), older, source });
  if (mem.size > 40) mem.delete(mem.keys().next().value);
  return { candles: older.concat(ig), source };
}

module.exports = { extend, available, pick, prefetch };
