'use strict';

// Historical OHLC from Bitstamp's public API (no account). Same feed TradingView uses for "BTCUSD · Bitstamp".
// https://www.bitstamp.net/api/v2/ohlc/{pair}/?step=&limit=1000&start=&end=   (times are bar opens, unix seconds)
// Complete UTC days are cached on disk and never re-fetched; today's day is re-fetched after 2 minutes.

const https = require('https');
const fs = require('fs');
const path = require('path');

const STEPS = [60, 180, 300, 900, 1800, 3600, 7200, 14400, 21600, 43200, 86400, 259200];
const PAIRS = { BTCUSD: 'btcusd', ETHUSD: 'ethusd', LTCUSD: 'ltcusd', XRPUSD: 'xrpusd', SOLUSD: 'solusd', BCHUSD: 'bchusd', LINKUSD: 'linkusd', ADAUSD: 'adausd', DOGEUSD: 'dogeusd' };
const LIVE_TTL_MS = 2 * 60 * 1000;
const agent = new https.Agent({ keepAlive: true, maxSockets: 2 });

function instrumentFor({ epic = '', name = '' }) {
  const s = `${epic} ${name}`.toUpperCase();
  if (/BITCOIN CASH|BCH/.test(s)) return 'BCHUSD';
  if (/BITCOIN|\bBTC/.test(s)) return 'BTCUSD';
  if (/ETHER|\bETH/.test(s)) return 'ETHUSD';
  if (/LITECOIN|\bLTC/.test(s)) return 'LTCUSD';
  if (/RIPPLE|\bXRP/.test(s)) return 'XRPUSD';
  if (/SOLANA|\bSOL\b/.test(s)) return 'SOLUSD';
  if (/CHAINLINK|\bLINK/.test(s)) return 'LINKUSD';
  if (/CARDANO|\bADA/.test(s)) return 'ADAUSD';
  if (/DOGE/.test(s)) return 'DOGEUSD';
  return null;
}
const supports = (instrument) => !!PAIRS[instrument];
// Largest Bitstamp step that divides the wanted bar size (so it can be aggregated exactly).
const stepFor = (sec) => STEPS.filter((s) => s <= sec && sec % s === 0).pop() || 60;

function get(url, signal) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { agent, timeout: 15000, headers: { 'User-Agent': 'ig-charts-local/1.0 (personal charting; historical candles)', Accept: 'application/json' } }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (d) => { body += d; });
      res.on('end', () => {
        if (res.statusCode !== 200) return reject(Object.assign(new Error(`Bitstamp HTTP ${res.statusCode}`), { status: res.statusCode }));
        try { resolve(JSON.parse(body)); } catch (e) { reject(e); }
      });
    });
    req.on('timeout', () => req.destroy(new Error('Bitstamp timeout')));
    req.on('error', reject);
    if (signal) signal.addEventListener('abort', () => req.destroy(Object.assign(new Error('aborted'), { name: 'AbortError' })), { once: true });
  });
}
async function getRetry(url, signal) {
  for (let a = 0; ; a++) {
    try { return await get(url, signal); } catch (e) {
      if (a >= 2 || e.name === 'AbortError' || (e.status && e.status < 500 && e.status !== 429)) throw e;
      await new Promise((r) => setTimeout(r, 800 * (a + 1)));
    }
  }
}

async function fetchDay(pair, step, day, signal) {
  const out = [];
  for (let start = day; start < day + 86400;) {
    const end = Math.min(day + 86400 - step, start + 999 * step);
    const d = await getRetry(`https://www.bitstamp.net/api/v2/ohlc/${pair}/?step=${step}&limit=1000&start=${start}&end=${end}`, signal);
    for (const r of (d.data && d.data.ohlc) || []) {
      const t = +r.timestamp;
      if (t >= day && t < day + 86400) out.push([t, +r.open, +r.high, +r.low, +r.close, +r.volume]);
    }
    start = end + step;
  }
  const seen = new Set();
  return out.filter((r) => !seen.has(r[0]) && seen.add(r[0])).sort((a, b) => a[0] - b[0]);
}

const inflight = new Map();
async function day(pair, step, dayStart, cacheDir, signal) {
  const file = path.join(cacheDir, 'bitstamp', pair, String(step), new Date(dayStart * 1000).toISOString().slice(0, 10) + '.json');
  const complete = dayStart + 86400 <= Date.now() / 1000 - 300;
  try {
    const c = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (c.complete || Date.now() - c.fetchedAt < LIVE_TTL_MS) return c.rows;
  } catch {}
  if (inflight.has(file)) return inflight.get(file);
  const p = (async () => {
    const rows = await fetchDay(pair, step, dayStart, signal);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file + '.tmp', JSON.stringify({ v: 1, fetchedAt: Date.now(), complete, rows }));
    fs.renameSync(file + '.tmp', file);
    return rows;
  })().finally(() => inflight.delete(file));
  inflight.set(file, p);
  return p;
}

// [fromSec, toSec) at `step` (a Bitstamp step), ascending { time, open, high, low, close, volume }.
async function getCandles({ instrument, fromSec, toSec, step, cacheDir, signal }) {
  const pair = PAIRS[instrument];
  if (!pair) throw new Error(`Bitstamp has no pair for ${instrument}`);
  if (!STEPS.includes(step)) throw new Error(`unsupported Bitstamp step ${step}`);
  const days = [];
  for (let d = Math.floor(fromSec / 86400) * 86400; d < toSec; d += 86400) days.push(d);
  const rows = [];
  for (let k = 0; k < days.length; k += 3) {
    const part = await Promise.all(days.slice(k, k + 3).map((d) => day(pair, step, d, cacheDir, signal)));
    for (const r of part) rows.push(...r);
  }
  return rows.filter((r) => r[0] >= fromSec && r[0] < toSec).map(([time, open, high, low, close, volume]) => ({ time, open, high, low, close, volume }));
}

module.exports = { STEPS, PAIRS, supports, instrumentFor, stepFor, getCandles };
