'use strict';

// Historical candles from Dukascopy's public datafeed (free, no account).
//
// Files (month is zero-based in URLs, all periods are UTC):
//   {INSTR}/{YYYY}/{MM0}/{DD}/{BID|ASK}_candles_min_1.bi5   minute bars of one day
//   {INSTR}/{YYYY}/{MM0}/{BID|ASK}_candles_hour_1.bi5       hour bars of one month
//   {INSTR}/{YYYY}/{BID|ASK}_candles_day_1.bi5              day bars of one year
//   {INSTR}/{YYYY}/{MM0}/{DD}/{HH}h_ticks.bi5               ticks of one hour
// Candle records are 24-byte big-endian: int32 offset seconds from the period
// start, int32 open, int32 close, int32 low, int32 high, float32 volume.
// Tick records are 20-byte big-endian: int32 offset ms from the hour start,
// int32 ask, int32 bid, float32 ask volume, float32 bid volume.
//
// Aggregate files only appear once their period has ended (the current day's
// minute file, current month's hour file and current year's day file return
// 404), so unfinished periods are composed from the next finer source, down
// to hourly tick files for the current day.
//
// Closed-market periods are padded by Dukascopy with flat, zero-volume bars
// repeating the last price; those are dropped.

const https = require('https');
const fs = require('fs');
const path = require('path');
const { decompress } = require('./lzma');

const HOST = 'datafeed.dukascopy.com';
const USER_AGENT = 'ig-charts-local/1.0 (personal charting; historical candles)';
const TIMEOUT_MS = 15000;
const MAX_CONCURRENT = 4;
const RETRIES = 2;
const LIVE_TTL_MS = 10 * 60 * 1000;
// A 404 for a period that ended recently may just mean "not published yet".
const PUBLISH_GRACE_SEC = { tick: 3 * 3600, min: 6 * 3600, hour: 2 * 86400, day: 7 * 86400 };
const CACHE_VERSION = 1;

// Price divisor per instrument (Dukascopy stores integer points).
const INSTRUMENTS = {
  XAUUSD: { scale: 1000 },
  XAGUSD: { scale: 1000 },
  EURUSD: { scale: 100000 },
  GBPUSD: { scale: 100000 },
  AUDUSD: { scale: 100000 },
  NZDUSD: { scale: 100000 },
  USDCAD: { scale: 100000 },
  USDCHF: { scale: 100000 },
  EURGBP: { scale: 100000 },
  USDJPY: { scale: 1000 },
  EURJPY: { scale: 1000 },
  GBPJPY: { scale: 1000 },
  AUDJPY: { scale: 1000 },
  BTCUSD: { scale: 10 },
  ETHUSD: { scale: 10 },
};

const STEP_KIND = { 60: 'min', 3600: 'hour', 86400: 'day' };

function supports(instrument) {
  return typeof instrument === 'string' && Object.prototype.hasOwnProperty.call(INSTRUMENTS, instrument.toUpperCase());
}

const NAME_PATTERNS = [
  [/GOLD|XAU/, 'XAUUSD'],
  [/SILVER|XAG/, 'XAGUSD'],
  [/BITCOIN|BTC/, 'BTCUSD'],
  [/ETHER|ETH/, 'ETHUSD'],
];

function instrumentFor({ epic, name } = {}) {
  const texts = [epic, name].filter((s) => typeof s === 'string').map((s) => s.toUpperCase());
  for (const t of texts) {
    for (const [re, instr] of NAME_PATTERNS) if (re.test(t)) return instr;
  }
  for (const t of texts) {
    const compact = t.replace(/[^A-Z]/g, '');
    for (const instr of Object.keys(INSTRUMENTS)) {
      if (instr.length === 6 && compact.includes(instr)) return instr;
    }
  }
  return null;
}

// ---------------------------------------------------------------- networking

let active = 0;
const waiters = [];

function abortError() {
  const e = new Error('aborted');
  e.name = 'AbortError';
  return e;
}

function acquire(signal) {
  if (active < MAX_CONCURRENT) {
    active++;
    return Promise.resolve();
  }
  return new Promise((resolve, reject) => {
    const w = { resolve, reject, signal, onAbort: null };
    if (signal) {
      w.onAbort = () => {
        const i = waiters.indexOf(w);
        if (i >= 0) waiters.splice(i, 1);
        reject(abortError());
      };
      signal.addEventListener('abort', w.onAbort, { once: true });
    }
    waiters.push(w);
  });
}

function release() {
  const w = waiters.shift();
  if (w) {
    if (w.signal) w.signal.removeEventListener('abort', w.onAbort);
    w.resolve();
  } else {
    active--;
  }
}

const agent = new https.Agent({ keepAlive: true, maxSockets: MAX_CONCURRENT, keepAliveMsecs: 15000 });
const stats = { requests: 0, retries: 0 };

function httpGet(urlPath, signal) {
  return new Promise((resolve, reject) => {
    if (signal && signal.aborted) return reject(abortError());
    stats.requests++;
    const req = https.get(
      { host: HOST, path: urlPath, agent, headers: { 'User-Agent': USER_AGENT, Accept: 'application/octet-stream' }, timeout: TIMEOUT_MS },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks) }));
        res.on('error', reject);
      }
    );
    const onAbort = () => req.destroy(abortError());
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
    req.on('timeout', () => req.destroy(Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' })));
    req.on('error', reject);
    req.on('close', () => signal && signal.removeEventListener('abort', onAbort));
  });
}

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal && signal.aborted) return reject(abortError());
    const t = setTimeout(() => {
      if (signal) signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(abortError());
    };
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
  });
}

// Returns a Buffer (possibly empty) or null for 404.
async function fetchFile(urlPath, signal) {
  await acquire(signal);
  try {
    for (let attempt = 0; ; attempt++) {
      let res;
      try {
        res = await httpGet(urlPath, signal);
      } catch (err) {
        if (err.name === 'AbortError' || attempt >= RETRIES) throw err;
        stats.retries++;
        await sleep(750 * 2 ** attempt, signal);
        continue;
      }
      if (res.status === 200) return res.body;
      if (res.status === 404) return null;
      if (res.status >= 500 && attempt < RETRIES) {
        stats.retries++;
        await sleep(750 * 2 ** attempt, signal);
        continue;
      }
      throw new Error(`Dukascopy HTTP ${res.status} for ${urlPath}`);
    }
  } finally {
    release();
  }
}

// ------------------------------------------------------------------ decoding

function decodeCandles(buf, baseSec) {
  if (!buf || buf.length === 0) return [];
  const raw = decompress(buf);
  if (raw.length % 24 !== 0) throw new Error(`candle payload length ${raw.length} is not a multiple of 24`);
  const rows = [];
  for (let i = 0; i < raw.length; i += 24) {
    const o = raw.readInt32BE(i + 4);
    const c = raw.readInt32BE(i + 8);
    const l = raw.readInt32BE(i + 12);
    const h = raw.readInt32BE(i + 16);
    const v = raw.readFloatBE(i + 20);
    if (v === 0 && o === c && o === l && o === h) continue;
    rows.push([baseSec + raw.readInt32BE(i), o, h, l, c, Math.round(v * 1e6) / 1e6]);
  }
  return rows;
}

// Minute bars for both sides built from one hour of ticks.
function decodeTicksToMinutes(buf, baseSec) {
  const out = { BID: [], ASK: [] };
  if (!buf || buf.length === 0) return out;
  const raw = decompress(buf);
  if (raw.length % 20 !== 0) throw new Error(`tick payload length ${raw.length} is not a multiple of 20`);
  let cur = null;
  const flush = () => {
    if (cur) {
      out.ASK.push([cur.t, ...cur.a]);
      out.BID.push([cur.t, ...cur.b]);
    }
  };
  for (let i = 0; i < raw.length; i += 20) {
    const t = baseSec + Math.floor(raw.readInt32BE(i) / 60000) * 60;
    const ask = raw.readInt32BE(i + 4);
    const bid = raw.readInt32BE(i + 8);
    const av = raw.readFloatBE(i + 12);
    const bv = raw.readFloatBE(i + 16);
    if (!cur || cur.t !== t) {
      flush();
      cur = { t, a: [ask, ask, ask, ask, 0], b: [bid, bid, bid, bid, 0] };
    }
    for (const [bar, p, v] of [[cur.a, ask, av], [cur.b, bid, bv]]) {
      if (p > bar[1]) bar[1] = p;
      if (p < bar[2]) bar[2] = p;
      bar[3] = p;
      bar[4] += v;
    }
  }
  flush();
  for (const side of ['BID', 'ASK']) for (const r of out[side]) r[5] = Math.round(r[5] * 1e6) / 1e6;
  return out;
}

function aggregate(rows, step) {
  const out = [];
  let cur = null;
  for (const [t, o, h, l, c, v] of rows) {
    const b = t - (t % step);
    if (!cur || cur[0] !== b) {
      if (cur) out.push(cur);
      cur = [b, o, h, l, c, v];
    } else {
      if (h > cur[2]) cur[2] = h;
      if (l < cur[3]) cur[3] = l;
      cur[4] = c;
      cur[5] += v;
    }
  }
  if (cur) out.push(cur);
  for (const r of out) r[5] = Math.round(r[5] * 1e6) / 1e6;
  return out;
}

// --------------------------------------------------------------------- cache

const pad = (n, w = 2) => String(n).padStart(w, '0');

function readCache(file) {
  try {
    const j = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (j && j.v === CACHE_VERSION && Array.isArray(j.rows)) return j;
  } catch (_) {
    /* missing or unreadable: treat as a miss */
  }
  return null;
}

function writeCache(file, entry) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(entry));
    fs.renameSync(tmp, file);
  } catch (_) {
    /* caching is best effort */
  }
}

// An entry is final once fetched after its period ended, and (for a 404 / no
// data) after the publication grace window, so a not-yet-published file is
// re-checked rather than cached as empty forever.
function isFresh(entry, endSec, kind, nowMs) {
  if (!entry) return false;
  const fetchedSec = entry.fetchedAt / 1000;
  if (fetchedSec >= endSec + (entry.found ? 300 : PUBLISH_GRACE_SEC[kind])) return true;
  return nowMs - entry.fetchedAt < LIVE_TTL_MS;
}

const inflight = new Map();

function once(key, fn) {
  let p = inflight.get(key);
  if (!p) {
    p = fn().finally(() => inflight.delete(key));
    inflight.set(key, p);
  }
  return p;
}

// ----------------------------------------------------------------- periods

function utc(y, m, d = 1, h = 0) {
  return Date.UTC(y, m, d, h) / 1000;
}

function dayStart(sec) {
  return sec - (((sec % 86400) + 86400) % 86400);
}

function monthStart(sec) {
  const d = new Date(sec * 1000);
  return utc(d.getUTCFullYear(), d.getUTCMonth());
}

function nextMonth(sec) {
  const d = new Date(sec * 1000);
  return utc(d.getUTCFullYear(), d.getUTCMonth() + 1);
}

function yearStart(sec) {
  return utc(new Date(sec * 1000).getUTCFullYear(), 0);
}

function nextYear(sec) {
  return utc(new Date(sec * 1000).getUTCFullYear() + 1, 0);
}

// Raw integer rows [t, o, h, l, c, v] for one side and one period.
async function loadTickHour(ctx, startSec) {
  const d = new Date(startSec * 1000);
  const ymd = `${d.getUTCFullYear()}/${pad(d.getUTCMonth())}/${pad(d.getUTCDate())}`;
  const id = `${d.toISOString().slice(0, 13)}`;
  const files = {
    BID: path.join(ctx.cacheDir, ctx.instrument, 'BID', 'tick', `${id}.json`),
    ASK: path.join(ctx.cacheDir, ctx.instrument, 'ASK', 'tick', `${id}.json`),
  };
  const endSec = startSec + 3600;
  if (startSec >= ctx.nowMs / 1000) return { BID: [], ASK: [] };
  const cached = { BID: readCache(files.BID), ASK: readCache(files.ASK) };
  if (isFresh(cached.BID, endSec, 'tick', ctx.nowMs) && isFresh(cached.ASK, endSec, 'tick', ctx.nowMs)) {
    return { BID: cached.BID.rows, ASK: cached.ASK.rows };
  }
  return once(files.BID, async () => {
    const buf = await fetchFile(`/datafeed/${ctx.instrument}/${ymd}/${pad(d.getUTCHours())}h_ticks.bi5`, ctx.signal);
    const bars = decodeTicksToMinutes(buf, startSec);
    const fetchedAt = Date.now();
    for (const side of ['BID', 'ASK']) {
      writeCache(files[side], { v: CACHE_VERSION, fetchedAt, found: buf !== null, rows: bars[side] });
    }
    return bars;
  });
}

async function loadPeriod(ctx, side, kind, startSec) {
  const d = new Date(startSec * 1000);
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth();
  let id, urlPath, endSec, compose;
  if (kind === 'min') {
    id = `${y}-${pad(m + 1)}-${pad(d.getUTCDate())}`;
    urlPath = `/datafeed/${ctx.instrument}/${y}/${pad(m)}/${pad(d.getUTCDate())}/${side}_candles_min_1.bi5`;
    endSec = startSec + 86400;
    compose = async () => {
      const hours = [];
      for (let t = startSec; t < endSec; t += 3600) hours.push(loadTickHour(ctx, t));
      return (await Promise.all(hours)).flatMap((h) => h[side]);
    };
  } else if (kind === 'hour') {
    id = `${y}-${pad(m + 1)}`;
    urlPath = `/datafeed/${ctx.instrument}/${y}/${pad(m)}/${side}_candles_hour_1.bi5`;
    endSec = nextMonth(startSec);
    compose = async () => {
      const days = [];
      for (let t = startSec; t < endSec; t += 86400) days.push(loadPeriod(ctx, side, 'min', t));
      return aggregate((await Promise.all(days)).flat(), 3600);
    };
  } else {
    id = `${y}`;
    urlPath = `/datafeed/${ctx.instrument}/${y}/${side}_candles_day_1.bi5`;
    endSec = nextYear(startSec);
    compose = async () => {
      const months = [];
      for (let t = startSec; t < endSec; t = nextMonth(t)) months.push(loadPeriod(ctx, side, 'hour', t));
      return aggregate((await Promise.all(months)).flat(), 86400);
    };
  }

  const nowSec = ctx.nowMs / 1000;
  if (startSec >= nowSec) return [];
  const file = path.join(ctx.cacheDir, ctx.instrument, side, kind, `${id}.json`);
  const cached = readCache(file);
  if (isFresh(cached, endSec, kind, ctx.nowMs)) return cached.rows;

  return once(file, async () => {
    const buf = await fetchFile(urlPath, ctx.signal);
    let rows;
    let found = buf !== null;
    if (buf === null && nowSec < endSec + PUBLISH_GRACE_SEC[kind]) {
      // Aggregate not published yet (current or just-ended period).
      rows = await compose();
      found = false;
    } else {
      rows = decodeCandles(buf, startSec);
    }
    writeCache(file, { v: CACHE_VERSION, fetchedAt: Date.now(), found, rows });
    return rows;
  });
}

function periodStarts(kind, fromSec, toSec) {
  const out = [];
  if (kind === 'min') for (let t = dayStart(fromSec); t < toSec; t += 86400) out.push(t);
  else if (kind === 'hour') for (let t = monthStart(fromSec); t < toSec; t = nextMonth(t)) out.push(t);
  else for (let t = yearStart(fromSec); t < toSec; t = nextYear(t)) out.push(t);
  return out;
}

async function loadSide(ctx, side, kind, fromSec, toSec) {
  const parts = await Promise.all(periodStarts(kind, fromSec, toSec).map((t) => loadPeriod(ctx, side, kind, t)));
  return parts.flat().filter((r) => r[0] >= fromSec && r[0] < toSec);
}

// ---------------------------------------------------------------------- API

async function getCandles({ instrument, side = 'MID', fromSec, toSec, step = 60, cacheDir, signal } = {}) {
  const instr = typeof instrument === 'string' ? instrument.toUpperCase() : '';
  if (!supports(instr)) throw new Error(`unsupported Dukascopy instrument: ${instrument}`);
  const kind = STEP_KIND[step];
  if (!kind) throw new Error(`unsupported step ${step}; use 60, 3600 or 86400`);
  const sideU = String(side).toUpperCase();
  if (!['BID', 'ASK', 'MID'].includes(sideU)) throw new Error(`unsupported side ${side}`);
  if (!Number.isFinite(fromSec) || !Number.isFinite(toSec)) throw new Error('fromSec and toSec must be numbers');
  if (!cacheDir) throw new Error('cacheDir is required');
  if (toSec <= fromSec) return [];

  const nowMs = Date.now();
  const ctx = { instrument: instr, cacheDir, signal, nowMs };
  const scale = INSTRUMENTS[instr].scale;
  const decimals = Math.round(Math.log10(scale));
  const fmt = (n, extra = 0) => Number((n / scale).toFixed(decimals + extra));
  const toCandle = ([t, o, h, l, c, v]) => ({ time: t, open: fmt(o), high: fmt(h), low: fmt(l), close: fmt(c), volume: v });

  if (sideU !== 'MID') return (await loadSide(ctx, sideU, kind, fromSec, toSec)).map(toCandle);

  const [bid, ask] = await Promise.all([
    loadSide(ctx, 'BID', kind, fromSec, toSec),
    loadSide(ctx, 'ASK', kind, fromSec, toSec),
  ]);
  const askByTime = new Map(ask.map((r) => [r[0], r]));
  const out = [];
  for (const b of bid) {
    const a = askByTime.get(b[0]);
    if (!a) continue;
    out.push({
      time: b[0],
      open: fmt((b[1] + a[1]) / 2, 1),
      high: fmt((b[2] + a[2]) / 2, 1),
      low: fmt((b[3] + a[3]) / 2, 1),
      close: fmt((b[4] + a[4]) / 2, 1),
      volume: Math.round(((b[5] + a[5]) / 2) * 1e6) / 1e6,
    });
  }
  return out;
}

module.exports = { INSTRUMENTS, getCandles, supports, instrumentFor, _stats: stats, _internal: { decodeCandles, decodeTicksToMinutes, aggregate } };
