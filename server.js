// IG Charts — backend
// - Logs in to IG REST (v2 session: CST / X-SECURITY-TOKEN), keeps credentials server-side
// - Proxies market search + price history (with caching, IG allows 10k history points / week)
// - Holds ONE Lightstreamer connection and fans live ticks out to browsers over WebSocket
// - Evaluates persisted price / indicator / drawing alerts and delivers them over WebSocket, webhooks and web push
// - Syncs app state across devices, proxies an economic calendar and news feeds
require('dotenv').config();
const http = require('http');
const https = require('https');
const crypto = require('crypto');
const path = require('path');
const vm = require('vm');
const zlib = require('zlib');
const express = require('express');
const { WebSocketServer } = require('ws');

const env = (k, d = '') => (process.env[k] ?? d).trim();
const MOCK = env('MOCK') === '1' || !env('IG_API_KEY');
const IG_BASE = env('IG_ENV', 'DEMO').toUpperCase() === 'LIVE'
  ? 'https://api.ig.com/gateway/deal'
  : 'https://demo-api.ig.com/gateway/deal';
const PORT = Number(env('PORT', '3000'));
const MAX_STREAM_SUBS = 40; // IG streaming limit

// ---------------------------------------------------------------- IG REST
const session = { cst: null, xst: null, accountId: null, lsEndpoint: null, loggingIn: null };
const allowance = { remaining: null, total: null, resetSeconds: null };

async function login() {
  if (session.loggingIn) return session.loggingIn;
  session.loggingIn = (async () => {
    const headers = (version) => ({
      'X-IG-API-KEY': env('IG_API_KEY'),
      'Content-Type': 'application/json; charset=UTF-8',
      Accept: 'application/json; charset=UTF-8',
      VERSION: version,
    });
    const postSession = (payload) => fetch(`${IG_BASE}/session`, {
      method: 'POST', headers: headers('2'), body: JSON.stringify(payload),
    });

    let res = await postSession({ identifier: env('IG_USERNAME'), password: env('IG_PASSWORD') });
    let body = await res.json().catch(() => ({}));

    // Some IG entities (e.g. Singapore) require an RSA-encrypted password
    if (!res.ok && body.errorCode === 'error.public-api.failure.encryption.required') {
      const kr = await fetch(`${IG_BASE}/session/encryptionKey`, { headers: headers('1') });
      const kb = await kr.json().catch(() => ({}));
      if (!kr.ok) throw new Error(`IG encryption key fetch failed (${kr.status}): ${kb.errorCode || JSON.stringify(kb)}`);
      const encrypted = crypto.publicEncrypt(
        {
          key: Buffer.from(kb.encryptionKey, 'base64'),
          format: 'der',
          type: 'spki',
          padding: crypto.constants.RSA_PKCS1_PADDING,
        },
        Buffer.from(Buffer.from(`${env('IG_PASSWORD')}|${kb.timeStamp}`).toString('base64')),
      ).toString('base64');
      res = await postSession({ identifier: env('IG_USERNAME'), password: encrypted, encryptedPassword: true });
      body = await res.json().catch(() => ({}));
    }
    if (!res.ok) throw new Error(`IG login failed (${res.status}): ${body.errorCode || JSON.stringify(body)}`);
    session.cst = res.headers.get('CST');
    session.xst = res.headers.get('X-SECURITY-TOKEN');
    session.accountId = body.currentAccountId;
    session.lsEndpoint = body.lightstreamerEndpoint;
    session.tzOffset = Number.isFinite(body.timezoneOffset) ? body.timezoneOffset : null;

    const wanted = env('IG_ACCOUNT_ID');
    if (wanted && wanted !== session.accountId) {
      const sw = await igRaw('PUT', '/session', '1', { accountId: wanted, defaultAccount: false });
      if (sw.res.ok) {
        session.xst = sw.res.headers.get('X-SECURITY-TOKEN') || session.xst;
        session.accountId = wanted;
      } else {
        console.warn('Could not switch to IG_ACCOUNT_ID', wanted, sw.body);
      }
    }
    console.log(`[IG] logged in → account ${session.accountId} @ ${IG_BASE}`);
    return session;
  })();
  try { return await session.loggingIn; } finally { session.loggingIn = null; }
}

async function igRaw(method, p, version, body) {
  const res = await fetch(`${IG_BASE}${p}`, {
    method,
    headers: {
      'X-IG-API-KEY': env('IG_API_KEY'),
      CST: session.cst || '',
      'X-SECURITY-TOKEN': session.xst || '',
      'Content-Type': 'application/json; charset=UTF-8',
      Accept: 'application/json; charset=UTF-8',
      VERSION: version,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  return { res, body: json };
}

async function ig(method, p, version = '1', body) {
  if (!session.cst) await login();
  let r = await igRaw(method, p, version, body);
  if (r.res.status === 401) { // token expired → re-login once
    session.cst = null;
    await login();
    r = await igRaw(method, p, version, body);
  }
  if (!r.res.ok) {
    const err = new Error(r.body.errorCode || `IG HTTP ${r.res.status}`);
    err.status = r.res.status;
    throw err;
  }
  return r.body;
}

// ---------------------------------------------------------------- Market helpers
const RES_SECONDS = {
  SECOND: 1, MINUTE: 60, MINUTE_2: 120, MINUTE_3: 180, MINUTE_5: 300, MINUTE_10: 600, MINUTE_15: 900, MINUTE_30: 1800,
  HOUR: 3600, HOUR_2: 7200, HOUR_3: 10800, HOUR_4: 14400, DAY: 86400, WEEK: 604800, MONTH: 2592000,
};
const MAX_HISTORY = 5000;
// Extended history: older bars from a free source (lib/history-ext.js) stitched in front of IG's recent bars.
const histExt = require('./lib/history-ext');
const EXT_MAX = 30000;
const HISTORY_IG_DAYS = Math.max(0.25, Number(process.env.HISTORY_IG_DAYS) || 1);

const bad = (msg) => { const e = new Error(msg); e.status = 400; throw e; };
const parseTime = (v) => {
  if (v == null || v === '') return null;
  const s = String(v).trim();
  const t = /^\d+(\.\d+)?$/.test(s) ? Number(s) : Date.parse(s) / 1000;
  return Number.isFinite(t) ? Math.floor(t) : bad(`invalid time "${s}" (use ISO 8601 or unix seconds)`);
};

const mid = (p) => {
  if (!p) return null;
  if (p.bid != null && p.ask != null) return (p.bid + p.ask) / 2;
  return p.bid ?? p.ask ?? p.lastTraded ?? null;
};

const SIDES = ['mid', 'bid', 'ask'];
const sidePrice = (p, side) => (side === 'mid' || !p ? mid(p) : p[side] ?? mid(p));
const SIDE_KEY = { mid: 'candles', bid: 'bid', ask: 'ask' };

// → { candles (mid), bid, ask } — three time-aligned OHLC series.
function toCandles(prices) {
  const rows = (prices || [])
    .map((p) => ({ p, time: Math.floor(Date.parse((p.snapshotTimeUTC || p.snapshotTime.replace(/\//g, '-').replace(' ', 'T')) + 'Z') / 1000) }))
    .filter((r) => mid(r.p.openPrice) != null && Number.isFinite(r.time))
    .sort((a, b) => a.time - b.time);
  const side = (s) => rows.map(({ p, time }) => ({
    time, open: sidePrice(p.openPrice, s), high: sidePrice(p.highPrice, s), low: sidePrice(p.lowPrice, s), close: sidePrice(p.closePrice, s),
    volume: p.lastTradedVolume || 0,
  }));
  return { candles: side('mid'), bid: side('bid'), ask: side('ask') };
}
// Old cache entries carry only mid candles; their bid/ask fall back to mid per bar until refreshed.
const sideOf = (entry, side) => entry[SIDE_KEY[side]] || entry.candles;
function mergeSides(entry, fresh, keep) {
  const out = {};
  for (const s of SIDES) {
    const merged = new Map(entry.candles.map((c) => [c.time, c]));
    if (s !== 'mid' && entry[SIDE_KEY[s]]) for (const c of entry[SIDE_KEY[s]]) merged.set(c.time, c);
    for (const c of fresh[SIDE_KEY[s]]) merged.set(c.time, c);
    out[SIDE_KEY[s]] = [...merged.values()].sort((a, b) => a.time - b.time).slice(-keep);
  }
  return out;
}

// History cache: epic|resolution → { at, max, candles, bid, ask }. Refreshes fetch only the bars since the
// last cached candle (IG allows 10k history points / week), and the cache is persisted to disk.
const fs = require('fs');
const CACHE_FILE = path.join(__dirname, '.cache', 'history.json');
const historyCache = new Map();
try { for (const [k, v] of Object.entries(JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8')))) historyCache.set(k, { ...v, at: 0 }); } catch {}
let cacheSaveTimer;
function saveHistoryCache() {
  clearTimeout(cacheSaveTimer);
  cacheSaveTimer = setTimeout(() => {
    try {
      fs.mkdirSync(path.dirname(CACHE_FILE), { recursive: true });
      fs.writeFileSync(CACHE_FILE, JSON.stringify(Object.fromEntries(historyCache)));
    } catch (e) { console.warn('[cache] save failed:', e.message); }
  }, 2000);
}
const marketCache = new Map();  // epic → market details

let allowanceAt = 0;
const allowanceErr = (cost) => {
  const e = new Error('historical-data-allowance');
  e.status = 429;
  e.body = { error: 'historical-data-allowance', remaining: allowance.remaining ?? 0, cost, resetSeconds: allowance.resetSeconds };
  return e;
};
// The remembered allowance is only trusted until IG's reported reset time has passed.
function guardAllowance(cost) {
  const known = allowance.remaining != null && !(allowance.resetSeconds && Date.now() > allowanceAt + allowance.resetSeconds * 1000);
  if (known && cost > allowance.remaining) throw allowanceErr(cost);
}
const igTime = (sec) => new Date(sec * 1000).toISOString().slice(0, 19);

// { max } asks for the latest bars; { from, to } (unix seconds) asks for a date range (IG ignores max then).
async function fetchPrices(epic, resolution, { max, from, to, cost }) {
  guardAllowance(cost);
  const q = new URLSearchParams({ resolution, pageSize: '0' });
  if (from != null) { q.set('from', igTime(from)); q.set('to', igTime(to)); } else q.set('max', String(max));
  const prices = [];
  for (let page = 1; page <= 100; page++) {
    let data;
    try { data = await ig('GET', `/prices/${encodeURIComponent(epic)}?${q}`, '3'); } catch (e) {
      if (/allowance/i.test(e.message)) { allowance.remaining = 0; allowanceAt = Date.now(); throw allowanceErr(cost); }
      throw e;
    }
    const a = data.metadata && data.metadata.allowance;
    if (a) { Object.assign(allowance, { remaining: a.remainingAllowance, total: a.totalAllowance, resetSeconds: a.allowanceExpiry }); allowanceAt = Date.now(); }
    prices.push(...(data.prices || []));
    const pd = data.metadata && data.metadata.pageData;
    if (!pd || !pd.pageSize || !(pd.totalPages > page)) break;
    q.set('pageSize', String(pd.pageSize));
    q.set('pageNumber', String(page + 1));
  }
  return toCandles(prices);
}

async function getHistory(epic, resolution, max, side = 'mid') {
  const key = `${epic}|${resolution}`;
  const sec = RES_SECONDS[resolution] || 60;
  // Short TTL: an incremental top-up only costs ~2-3 points, and a stale cache leaves
  // missing candles between the cached last bar and the live one.
  const ttl = Math.min(30, Math.max(1, sec)) * 1000;
  const hit = historyCache.get(key);
  if (hit && hit.max >= max && hit.candles.length) {
    if (Date.now() - hit.at < ttl) return { candles: sideOf(hit, side).slice(-max) };
    const lastT = hit.candles[hit.candles.length - 1].time;
    const need = Math.min(hit.max, Math.ceil((Date.now() / 1000 - lastT) / sec) + 2);
    let fresh;
    try { fresh = await fetchPrices(epic, resolution, { max: need, cost: need }); } catch (e) {
      if (e.status === 429) return { candles: sideOf(hit, side).slice(-max), stale: true };
      throw e;
    }
    Object.assign(hit, mergeSides(hit, fresh, hit.max), { at: Date.now() });
    saveHistoryCache();
    return { candles: sideOf(hit, side).slice(-max) };
  }
  const fresh = await fetchPrices(epic, resolution, { max, cost: max });
  historyCache.set(key, { at: Date.now(), max, ...fresh });
  saveHistoryCache();
  return { candles: sideOf(fresh, side) };
}

// Date-range requests bypass the rolling cache; ranges that ended before the current bar are immutable.
const rangeCache = new Map();
async function getRange(epic, resolution, from, to, est, side = 'mid') {
  const key = `${epic}|${resolution}|${from}|${to}`;
  if (rangeCache.has(key)) return { candles: sideOf(rangeCache.get(key), side) };
  const fresh = await fetchPrices(epic, resolution, { from, to, cost: est });
  if (to < Date.now() / 1000 - RES_SECONDS[resolution]) {
    rangeCache.set(key, fresh);
    if (rangeCache.size > 50) rangeCache.delete(rangeCache.keys().next().value);
  }
  return { candles: sideOf(fresh, side) };
}

const hhmm = (v) => (typeof v === 'string' && /^\d{1,2}:\d{2}/.test(v) ? v.slice(0, 5).padStart(5, '0') : null);
function openingHours(oh) {
  const times = Array.isArray(oh?.marketTimes) ? oh.marketTimes : null;
  const out = (times || []).map((x) => ({ open: hhmm(x.openTime), close: hhmm(x.closeTime) })).filter((x) => x.open && x.close);
  return out.length ? out : null;
}
// IG reports opening hours in the account's time zone (session timezoneOffset, whole hours east of UTC).
const ianaOffset = (h) => (!Number.isInteger(h) ? null : h === 0 ? 'UTC' : `Etc/GMT${h > 0 ? '-' : '+'}${Math.abs(h)}`);

async function getMarket(epic) {
  if (marketCache.has(epic)) return marketCache.get(epic);
  const d = await ig('GET', `/markets/${encodeURIComponent(epic)}`, '3');
  const m = {
    epic,
    name: d.instrument?.name || epic,
    type: d.instrument?.type,
    status: d.snapshot?.marketStatus,
    bid: d.snapshot?.bid,
    offer: d.snapshot?.offer,
    high: d.snapshot?.high,
    low: d.snapshot?.low,
    changePct: d.snapshot?.percentageChange,
    decimals: d.snapshot?.decimalPlacesFactor,
    scaling: d.snapshot?.scalingFactor,
    openingHours: openingHours(d.instrument?.openingHours),
    timezone: ianaOffset(session.tzOffset),
  };
  marketCache.set(epic, m);
  return m;
}

async function search(q) {
  const d = await ig('GET', `/markets?searchTerm=${encodeURIComponent(q)}`, '1');
  return (d.markets || []).map((m) => ({
    epic: m.epic, name: m.instrumentName, type: m.instrumentType, expiry: m.expiry,
    status: m.marketStatus, bid: m.bid, offer: m.offer, changePct: m.percentageChange,
  }));
}

async function discoverDefaults() {
  const out = [];
  const pick = async (envKey, term, re) => {
    if (env(envKey)) return out.push(env(envKey));
    try {
      const list = await search(term);
      const best = list.find((m) => re.test(m.name) && (m.expiry === '-' || m.expiry === 'DFB')) ||
                   list.find((m) => m.expiry === '-' || m.expiry === 'DFB') || list[0];
      if (best) out.push(best.epic);
    } catch (e) { console.warn(`[IG] discover ${term} failed:`, e.message); }
  };
  await pick('GOLD_EPIC', 'spot gold', /spot gold/i);
  await pick('BTC_EPIC', 'bitcoin', /^bitcoin/i);
  return out;
}

// ---------------------------------------------------------------- Streaming (IG → server)
const stream = { client: null, sub: null, status: 'idle', epics: new Set(), last: new Map() };
let broadcast = () => {};

function streamStart() {
  if (MOCK) return;
  const { LightstreamerClient, Subscription } = require('lightstreamer-client-node');
  if (stream.client) { try { stream.client.disconnect(); } catch {} }
  const c = new LightstreamerClient(session.lsEndpoint, null);
  c.connectionDetails.setUser(session.accountId);
  c.connectionDetails.setPassword(`CST-${session.cst}|XST-${session.xst}`);
  c.addListener({
    onStatusChange: (s) => {
      stream.status = s;
      broadcast({ type: 'status', stream: s });
      console.log('[LS]', s);
    },
    onServerError: async (code, msg) => {
      console.warn('[LS] server error', code, msg, '→ re-login');
      stream.status = 'error';
      setTimeout(async () => { try { session.cst = null; await login(); streamStart(); } catch (e) { console.error(e.message); } }, 5000);
    },
  });
  c.connect();
  stream.client = c;
  stream.Subscription = Subscription;
  streamResubscribe();
}

function streamResubscribe() {
  if (MOCK || !stream.client) return;
  if (stream.sub) { try { stream.client.unsubscribe(stream.sub); } catch {} stream.sub = null; }
  const epics = [...stream.epics].slice(0, MAX_STREAM_SUBS);
  if (!epics.length) return;
  // MARKET:<epic> items aren't permitted on some IG entities (e.g. Singapore / APAC
  // servers reply "21 Invalid group"); CHART:<epic>:TICK carries the same live bid/offer.
  const chart = stream.itemMode === 'CHART';
  const sub = chart
    ? new stream.Subscription('DISTINCT', epics.map((e) => `CHART:${e}:TICK`),
      ['BID', 'OFR', 'UTM', 'DAY_HIGH', 'DAY_LOW', 'DAY_PERC_CHG_MID'])
    : new stream.Subscription('MERGE', epics.map((e) => `MARKET:${e}`),
      ['BID', 'OFFER', 'HIGH', 'LOW', 'CHANGE_PCT', 'UPDATE_TIME', 'MARKET_STATE']);
  sub.setRequestedSnapshot('yes');
  sub.addListener({
    onItemUpdate: (u) => {
      const epic = u.getItemName().replace(/^MARKET:/, '').replace(/^CHART:(.+):TICK$/, '$1');
      const num = (f) => { const v = u.getValue(f); return v == null || v === '' ? null : Number(v); };
      const tick = chart
        ? {
          type: 'tick', epic, t: Date.now(),
          bid: num('BID'), offer: num('OFR'), high: num('DAY_HIGH'), low: num('DAY_LOW'),
          changePct: num('DAY_PERC_CHG_MID'), state: null,
        }
        : {
          type: 'tick', epic, t: Date.now(),
          bid: num('BID'), offer: num('OFFER'), high: num('HIGH'), low: num('LOW'),
          changePct: num('CHANGE_PCT'), state: u.getValue('MARKET_STATE'),
        };
      const prev = stream.last.get(epic) || {};
      for (const k of ['bid', 'offer', 'high', 'low', 'changePct', 'state']) if (tick[k] == null) tick[k] = prev[k] ?? null;
      stream.last.set(epic, tick);
      const r = (stream.rate ||= new Map()).get(epic) || [];
      r.push(tick.t); while (r.length && r[0] < tick.t - 60000) r.shift();
      stream.rate.set(epic, r);
      broadcast(tick);
      alertsOnTick(tick);
    },
    onSubscriptionError: (code, msg) => {
      console.warn('[LS] subscription error', code, msg);
      stream.subError = { code, msg, at: new Date().toISOString(), items: epics };
      if (code === 21 && !chart) {
        console.log('[LS] MARKET items not permitted on this account → using CHART:<epic>:TICK');
        stream.itemMode = 'CHART';
        stream.sub = null;
        streamResubscribe();
      }
    },
  });
  stream.client.subscribe(sub);
  stream.sub = sub;
}

function watch(epic) {
  if (stream.epics.has(epic)) return true;
  if (stream.epics.size >= MAX_STREAM_SUBS) return false;
  stream.epics.add(epic);
  clearTimeout(watch._t);
  watch._t = setTimeout(streamResubscribe, 300); // batch adds
  return true;
}

// ---------------------------------------------------------------- Mock mode
const mock = {
  markets: {
    'MOCK.GOLD': { epic: 'MOCK.GOLD', name: 'Spot Gold (simulated)', type: 'CURRENCIES', price: 2650, vol: 0.0006, spread: 0.3, decimals: 2, hours: [{ open: '23:00', close: '22:00' }] },
    'MOCK.BTC': { epic: 'MOCK.BTC', name: 'Bitcoin (simulated)', type: 'CRYPTOCURRENCIES', price: 88000, vol: 0.0015, spread: 30, decimals: 1 },
  },
  // Walks backwards from the live price (or the base price for past ranges) so the last bar meets the tick stream.
  history(epic, resolution, max, end) {
    const m = this.markets[epic];
    if (!m) return null;
    const step = RES_SECONDS[resolution] || 60;
    const last = Math.floor((end ?? Date.now() / 1000) / step) * step;
    const sig = m.vol * Math.min(Math.sqrt(step / 60), 12);
    let c = end == null ? m.price : m.base;
    const out = new Array(max);
    for (let i = max - 1; i >= 0; i--) {
      const o = c * (1 + (Math.random() - 0.5) * sig + (m.base / c - 1) * 0.02);
      const h = Math.max(o, c) + Math.random() * sig * c * 0.5;
      const l = Math.min(o, c) - Math.random() * sig * c * 0.5;
      out[i] = { time: last - (max - 1 - i) * step, open: o, high: h, low: l, close: c, volume: Math.round((50 + Math.random() * 400) * Math.sqrt(step / 60)) };
      c = o;
    }
    return out;
  },
  side(epic, candles, side) {
    const d = side === 'bid' ? -this.markets[epic].spread / 2 : side === 'ask' ? this.markets[epic].spread / 2 : 0;
    return d ? candles.map((c) => ({ ...c, open: c.open + d, high: c.high + d, low: c.low + d, close: c.close + d })) : candles;
  },
  start() {
    for (const m of Object.values(this.markets)) m.base = m.price;
    setInterval(() => {
      for (const m of Object.values(this.markets)) {
        m.price *= 1 + (Math.random() - 0.5) * m.vol * 0.6;
        const tick = { type: 'tick', epic: m.epic, t: Date.now(), bid: m.price - m.spread / 2, offer: m.price + m.spread / 2, state: 'TRADEABLE', changePct: null };
        stream.last.set(m.epic, tick);
        broadcast(tick);
        alertsOnTick(tick);
      }
    }, 500);
    stream.status = 'MOCK';
  },
};

// ---------------------------------------------------------------- Alerts (server-side, persisted in .data/)
const DATA_DIR = path.join(__dirname, '.data');
const ALERTS_FILE = path.join(DATA_DIR, 'alerts.json');
const LOG_FILE = path.join(DATA_DIR, 'alert-log.json');
const MAX_ALERTS = 1000, MAX_LOG = 1000, MAX_CONDS = 10, MAX_WATCHLIST = 200, MAX_WINDOW = 86400;
const CONDITIONS = ['crossing', 'crossing_up', 'crossing_down', 'greater_than', 'less_than', 'entering_channel', 'exiting_channel',
  'inside_channel', 'outside_channel', 'moving_up', 'moving_down', 'moving_up_pct', 'moving_down_pct'];
const CHANNEL = new Set(['entering_channel', 'exiting_channel', 'inside_channel', 'outside_channel']);
const MOVING = new Set(['moving_up', 'moving_down', 'moving_up_pct', 'moving_down_pct']);
const SOURCES = ['bid', 'offer', 'mid'];
const TRIGGERS = ['once', 'once_per_minute', 'every_time'];
const DEFAULT_MESSAGE = '{{name}}: {{ticker}} {{condition}} {{value}} at {{price}}';

// A file that exists but cannot be parsed is moved aside instead of being overwritten by the next save.
function readList(file) {
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); } catch { return []; }
  try { const v = JSON.parse(raw); if (Array.isArray(v)) return v; } catch {}
  const aside = `${file}.bad-${Date.now()}`;
  try { fs.renameSync(file, aside); } catch {}
  console.warn(`[alerts] unreadable ${path.basename(file)} moved to ${aside}`);
  return [];
}
function writeJson(file, v) {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(`${file}.tmp`, JSON.stringify(v));
    fs.renameSync(`${file}.tmp`, file);
  } catch (e) { console.warn('[alerts] save failed:', e.message); }
}
const pendingSaves = new Map();
let saveTimer;
function flushSaves() { clearTimeout(saveTimer); for (const [f, get] of pendingSaves) writeJson(f, get()); pendingSaves.clear(); }
function persist(file, get, now) {
  pendingSaves.set(file, get);
  if (now) return flushSaves();
  clearTimeout(saveTimer);
  saveTimer = setTimeout(flushSaves, 1000);
}

const alerts = readList(ALERTS_FILE);
let alertLog = readList(LOG_FILE).slice(-MAX_LOG);
const saveAlerts = (now) => persist(ALERTS_FILE, () => alerts, now);
const saveLog = () => persist(LOG_FILE, () => alertLog);

// ---- validation
const toNum = (v) => (typeof v === 'string' && v.trim() !== '' ? Number(v) : v);
const finite = (v, what) => { const n = toNum(v); return typeof n === 'number' && Number.isFinite(n) ? n : bad(`${what} must be a finite number`); };
const text = (v, what, max, d) => (v == null ? d : typeof v === 'string' && v.length <= max ? v : bad(`${what} must be a string of at most ${max} chars`));
const EPIC_RE = /^[\w.:-]{1,100}$/;
const parseEpic = (e) => (typeof e === 'string' && EPIC_RE.test(e) ? e : bad(`invalid epic ${JSON.stringify(e)}`));

function parseCond(c, withEpic) {
  if (!c || typeof c !== 'object') bad('condition must be an object');
  const o = withEpic ? { epic: parseEpic(c.epic) } : {};
  o.source = c.source == null ? 'mid' : SOURCES.includes(c.source) ? c.source : bad(`source must be one of ${SOURCES.join(', ')}`);
  o.condition = CONDITIONS.includes(c.condition) ? c.condition : bad(`condition must be one of ${CONDITIONS.join(', ')}`);
  o.value = finite(c.value, 'value');
  o.value2 = null;
  if (CHANNEL.has(o.condition)) {
    const v2 = finite(c.value2, 'value2 (channel upper bound)');
    [o.value, o.value2] = o.value <= v2 ? [o.value, v2] : [v2, o.value];
  }
  if (MOVING.has(o.condition)) {
    if (o.value <= 0) bad('value must be > 0 for moving_* conditions');
    o.value2 = finite(c.value2, 'value2 (window seconds)');
    if (o.value2 < 1 || o.value2 > MAX_WINDOW) bad(`value2 (window seconds) must be 1..${MAX_WINDOW}`);
  }
  return o;
}

function parseWebhook(w) {
  if (w == null || w === '') return null;
  if (typeof w === 'string') w = { url: w };
  if (typeof w !== 'object' || Array.isArray(w)) bad('webhook must be { url, headers?, enabled? }');
  let u;
  try { u = new URL(String(w.url)); } catch { bad('webhook.url must be an absolute http(s) URL'); }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') bad('webhook.url must use http or https');
  const headers = {};
  if (w.headers != null) {
    if (typeof w.headers !== 'object' || Array.isArray(w.headers) || Object.keys(w.headers).length > 20) bad('webhook.headers must be an object of at most 20 string values');
    for (const [k, v] of Object.entries(w.headers)) {
      if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(k) || typeof v !== 'string' || /[\r\n]/.test(v) || v.length > 4096) bad(`invalid webhook header ${JSON.stringify(k)}`);
      headers[k] = v;
    }
  }
  return { url: u.href, headers, enabled: w.enabled !== false };
}

// PATCH merges the body over the stored alert; send `all: null` / `kind: 'price'` to switch kinds.
function parseAlert(b, prev = {}) {
  if (!b || typeof b !== 'object' || Array.isArray(b)) bad('JSON object body required');
  const m = { ...prev, ...b };
  const kind = ['watchlist', 'indicator', 'drawing', 'stmn'].includes(m.kind) ? m.kind : Array.isArray(m.all) && m.all.length ? 'multi' : 'price';
  let expiresAt = null;
  if (m.expiresAt != null && m.expiresAt !== '') {
    expiresAt = typeof m.expiresAt === 'string' && !/^\d+$/.test(m.expiresAt) ? Date.parse(m.expiresAt) : Number(m.expiresAt);
    if (!Number.isFinite(expiresAt)) bad('expiresAt must be unix ms, an ISO date or null');
  }
  const a = { id: prev.id || crypto.randomUUID(), name: '', enabled: m.enabled !== false, kind };
  if (kind === 'price') Object.assign(a, parseCond(m, true));
  if (kind === 'multi') {
    if (m.all.length > MAX_CONDS) bad(`at most ${MAX_CONDS} conditions in all[]`);
    a.all = m.all.map((c) => parseCond(c, true));
  }
  if (kind === 'watchlist') {
    if (!Array.isArray(m.epics) || !m.epics.length || m.epics.length > MAX_WATCHLIST) bad(`epics must be an array of 1..${MAX_WATCHLIST} epics`);
    a.epics = [...new Set(m.epics.map(parseEpic))];
    Object.assign(a, parseCond(m, false));
    a.firedEpics = [];
  }
  if (kind === 'indicator') {
    a.epic = parseEpic(m.epic);
    a.interval = parseAlertInterval(m.interval);
    a.indicator = parseIndicatorRef(m.indicator, 'indicator');
    a.condition = IND_CONDITIONS.includes(m.condition) ? m.condition : bad(`condition must be one of ${IND_CONDITIONS.join(', ')}`);
    a.compare = parseCompare(m.compare, a.condition, a.indicator);
    a.evaluate = m.evaluate == null ? 'bar_close' : EVALUATE.includes(m.evaluate) ? m.evaluate : bad(`evaluate must be one of ${EVALUATE.join(', ')}`);
    if (!seriesMap.has(seriesKey(a)) && seriesMap.size >= MAX_SERIES) bad(`at most ${MAX_SERIES} distinct (epic, interval) series for indicator alerts`);
  }
  if (kind === 'drawing') {
    a.epic = parseEpic(m.epic);
    a.source = m.source == null ? 'mid' : SOURCES.includes(m.source) ? m.source : bad(`source must be one of ${SOURCES.join(', ')}`);
    a.condition = DRAW_CONDITIONS.includes(m.condition) ? m.condition : bad(`condition must be one of ${DRAW_CONDITIONS.join(', ')}`);
    a.geometry = parseGeometry(m.geometry, a.condition);
    a.drawingId = m.drawingId == null ? null : text(String(m.drawingId), 'drawingId', 200);
  }
  if (kind === 'stmn') Object.assign(a, stmnAlerts.parse(m));
  const label = kind === 'stmn' ? stmnAlerts.label(a) : kind === 'multi' ? `${a.all.length} conditions`
    : kind === 'indicator' ? `${a.epic} ${a.interval} ${indTitle(a.indicator)} ${a.condition} ${compareText(a)}`
    : kind === 'drawing' ? `${a.epic} ${a.condition} ${a.geometry.kind}`
    : `${kind === 'watchlist' ? `${a.epics.length} symbols` : a.epic} ${a.condition} ${a.value}`;
  a.name = text(m.name, 'name', 200, '').trim() || label;
  a.trigger = m.trigger == null ? 'once' : TRIGGERS.includes(m.trigger) ? m.trigger : bad(`trigger must be one of ${TRIGGERS.join(', ')}`);
  a.expiresAt = expiresAt;
  a.message = text(m.message, 'message', 4000, '') || DEFAULT_MESSAGE;
  a.webhook = parseWebhook(m.webhook);
  a.notify = m.notify !== false;
  a.telegram = m.telegram !== false;
  a.email = m.email !== false;
  a.createdAt = prev.createdAt || Date.now();
  a.firedCount = prev.firedCount || 0;
  a.lastFiredAt = prev.lastFiredAt || null;
  return a;
}

// ---- evaluation
const alertEpics = (a) => (a.kind === 'watchlist' ? a.epics : a.kind === 'multi' ? [...new Set(a.all.map((c) => c.epic))] : [a.epic]);
const alertIndex = new Map(); // epic → alerts involving it
const alertState = new Map(); // alert id → Map(slot → { prev, was, last })
const rings = new Map();      // epic → { win (s), samples: [{ t, bid, offer }] } for moving_* windows
const RING_POINTS = 2000;

function reindex() {
  alertIndex.clear();
  const wins = new Map();
  for (const a of alerts) {
    for (const e of alertEpics(a)) { if (!alertIndex.has(e)) alertIndex.set(e, []); alertIndex.get(e).push(a); }
    const conds = a.kind === 'multi' ? a.all : a.kind === 'indicator' || a.kind === 'drawing' ? [] : [a];
    for (const c of conds) if (MOVING.has(c.condition)) for (const e of c.epic ? [c.epic] : a.epics) wins.set(e, Math.max(wins.get(e) || 0, c.value2));
  }
  reindexSeries();
  stmnAlerts.sync(alerts);
  for (const e of rings.keys()) if (!wins.has(e)) rings.delete(e);
  for (const [e, win] of wins) { const r = rings.get(e); if (r) r.win = win; else rings.set(e, { win, samples: [] }); }
  for (const e of alertIndex.keys()) {
    watch(e);
    if (!MOCK && session.cst && !marketCache.has(e)) getMarket(e).catch(() => {});
  }
}

const pick = (q, s) => (!q ? null : s === 'bid' ? q.bid : s === 'offer' ? q.offer
  : q.bid != null && q.offer != null ? (q.bid + q.offer) / 2 : q.bid ?? q.offer ?? null);
const stateOf = (id, slot) => {
  if (!alertState.has(id)) alertState.set(id, new Map());
  const m = alertState.get(id);
  if (!m.has(slot)) m.set(slot, {});
  return m.get(slot);
};

function recordSample(tick) {
  const r = rings.get(tick.epic);
  if (!r) return;
  const s = r.samples, gap = (r.win * 1000) / RING_POINTS;
  if (!s.length || tick.t - s[s.length - 1].t >= gap) s.push({ t: tick.t, bid: tick.bid, offer: tick.offer });
  let i = 0;
  while (i < s.length && s[i].t < tick.t - r.win * 1000) i++;
  if (i) s.splice(0, i);
}

function windowRange(epic, source, win, now, p) {
  let lo = p, hi = p;
  for (const x of rings.get(epic)?.samples || []) {
    if (x.t < now - win * 1000) continue;
    const v = pick(x, source);
    if (v == null) continue;
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  return { lo, hi };
}

function evalCond(c, epic, st, now) {
  const p = pick(stream.last.get(epic), c.source);
  const prev = st.prev;
  st.prev = p;
  if (p == null) return false;
  const v = c.value, inside = (x) => x >= v && x <= c.value2;
  switch (c.condition) {
    case 'crossing': return prev != null && ((prev < v && p >= v) || (prev > v && p <= v));
    case 'crossing_up': return prev != null && prev < v && p >= v;
    case 'crossing_down': return prev != null && prev > v && p <= v;
    case 'greater_than': return p > v;
    case 'less_than': return p < v;
    case 'inside_channel': return inside(p);
    case 'outside_channel': return !inside(p);
    case 'entering_channel': return prev != null && !inside(prev) && inside(p);
    case 'exiting_channel': return prev != null && inside(prev) && !inside(p);
    default: {
      const { lo, hi } = windowRange(epic, c.source, c.value2, now, p);
      if (c.condition === 'moving_up') return p - lo >= v;
      if (c.condition === 'moving_down') return hi - p >= v;
      if (c.condition === 'moving_up_pct') return lo > 0 && ((p - lo) / lo) * 100 >= v;
      return hi > 0 && ((hi - p) / hi) * 100 >= v;
    }
  }
}

// once / every_time fire when the condition becomes true; once_per_minute fires while true, at most once a minute.
function gate(a, g, ok, now) {
  const rising = ok && !g.was;
  g.was = ok;
  if (!ok) return false;
  if (a.trigger !== 'once_per_minute') return rising;
  if (g.last && now - g.last < 60000) return false;
  g.last = now;
  return true;
}

function alertsOnTick(tick) {
  try {
    recordSample(tick);
    const closedKeys = seriesOnTick(tick);
    const list = alertIndex.get(tick.epic);
    if (!list) return;
    const now = tick.t;
    for (const a of list) {
      if (!a.enabled || (a.expiresAt && now > a.expiresAt)) continue;
      if (a.kind === 'indicator') evalIndicatorAlert(a, tick, now, closedKeys);
      else if (a.kind === 'drawing') evalDrawingAlert(a, tick, now);
      else if (a.kind === 'stmn') stmnAlerts.evaluate(a, tick, now);
      else if (a.kind === 'watchlist') {
        if (a.trigger === 'once' && a.firedEpics.includes(tick.epic)) continue;
        const st = stateOf(a.id, tick.epic);
        if (gate(a, st, evalCond(a, tick.epic, st, now), now)) fireAlert(a, tick.epic, pick(tick, a.source), now);
      } else if (a.kind === 'multi') {
        const ok = a.all.map((c, i) => evalCond(c, c.epic, stateOf(a.id, i), now)).every(Boolean);
        const src = (a.all.find((c) => c.epic === tick.epic) || {}).source;
        if (gate(a, stateOf(a.id, 'all'), ok, now)) fireAlert(a, tick.epic, pick(tick, src), now);
      } else {
        const st = stateOf(a.id, 0);
        if (gate(a, st, evalCond(a, a.epic, st, now), now)) fireAlert(a, a.epic, pick(tick, a.source), now);
      }
    }
  } catch (e) { console.warn('[alerts] evaluation failed:', e.message); }
}

// ---- indicator & drawing alerts: public/indicators.js + charttypes.js run in a vm sandbox
const LIB_FILES = ['indicators.js', 'charttypes.js'].map((f) => path.join(__dirname, 'public', f));
let libs = null, libStamp = '';
function loadLibs() {
  const stamp = LIB_FILES.map((f) => { try { return fs.statSync(f).mtimeMs; } catch { return 0; } }).join('|');
  if (libs && stamp === libStamp) return libs;
  try {
    const window = {};
    const ctx = vm.createContext({ window, console });
    for (const f of LIB_FILES) vm.runInContext(fs.readFileSync(f, 'utf8'), ctx, { filename: f, timeout: 5000 });
    if (!window.IGInd?.BY_ID || !window.IGTypes?.aggregate) throw new Error('IGInd / IGTypes not defined');
    libs = { IGInd: window.IGInd, IGTypes: window.IGTypes };
    libStamp = stamp;
  } catch (e) {
    console.warn('[alerts] loading indicator libraries failed:', e.message);
    if (!libs) { const err = new Error(`indicator libraries unavailable: ${e.message}`); err.status = 503; throw err; }
  }
  return libs;
}

const SRC_FNS = {
  open: (b) => b.open, high: (b) => b.high, low: (b) => b.low, close: (b) => b.close, volume: (b) => b.volume || 0,
  hl2: (b) => (b.high + b.low) / 2, hlc3: (b) => (b.high + b.low + b.close) / 3, ohlc4: (b) => (b.open + b.high + b.low + b.close) / 4,
};
const IND_CONDITIONS = CONDITIONS.filter((c) => !MOVING.has(c));
const DRAW_CONDITIONS = ['crossing', 'crossing_up', 'crossing_down', 'entering_channel', 'exiting_channel', 'greater_than', 'less_than'];
const EVALUATE = ['bar_close', 'tick'];
const SEED_BARS = 500, MAX_SERIES_BARS = 2000, MAX_SERIES = 50, TICK_EVAL_MS = 250;

function parseParams(def, given, where) {
  if (given != null && (typeof given !== 'object' || Array.isArray(given))) bad(`${where}.params must be an object`);
  const out = {};
  for (const p of def.params || []) {
    let v = given?.[p.k] ?? p.def;
    const w = `${where}.params.${p.k}`;
    if (p.type === 'int' || p.type === 'number' || p.type === 'time') {
      v = finite(v, w);
      if (p.type === 'int') v = Math.round(v);
      if ((p.min != null && v < p.min) || (p.max != null && v > p.max)) bad(`${w} must be within ${p.min ?? '-∞'}..${p.max ?? '∞'}`);
    } else if (p.type === 'bool') v = v === true || v === 'true';
    else if (p.type === 'source') { if (!SRC_FNS[v]) bad(`${w}: server-side alerts support the sources ${Object.keys(SRC_FNS).join(', ')}`); }
    else if (p.type === 'select') {
      const opts = (p.options || []).map((o) => (o && typeof o === 'object' ? o.value : o));
      if (opts.length && !opts.includes(v)) bad(`${w} must be one of ${opts.join(', ')}`);
    } else v = text(v, w, 200, '');
    out[p.k] = v;
  }
  return out;
}
function parseIndicatorRef(x, where, needOutput = true) {
  if (!x || typeof x !== 'object') bad(`${where} must be { id, params, output }`);
  const def = loadLibs().IGInd.BY_ID[x.id];
  if (!def) bad(`${where}.id: unknown indicator ${JSON.stringify(x.id)}`);
  const outs = (def.outputs || []).map((o) => o.k);
  if (!outs.length) bad(`${where}: ${def.id} has no plotted outputs to alert on`);
  const output = x.output == null || x.output === '' ? outs[0] : outs.includes(x.output) ? x.output : bad(`${where}.output must be one of ${outs.join(', ')}`);
  return needOutput ? { id: def.id, params: parseParams(def, x.params, where), output } : { id: def.id, params: parseParams(def, x.params, where) };
}
function parseCompare(c, cond, ind) {
  if (!c || typeof c !== 'object') bad('compare must be an object with type value|output|indicator|price');
  if (CHANNEL.has(cond) && c.type !== 'value') bad(`${cond} needs compare { type:'value', value, value2 }`);
  switch (c.type) {
    case 'value': {
      const o = { type: 'value', value: finite(c.value, 'compare.value'), value2: null };
      if (CHANNEL.has(cond)) {
        const v2 = finite(c.value2, 'compare.value2 (channel upper bound)');
        [o.value, o.value2] = o.value <= v2 ? [o.value, v2] : [v2, o.value];
      }
      return o;
    }
    case 'output': {
      const outs = loadLibs().IGInd.BY_ID[ind.id].outputs.map((o) => o.k);
      return { type: 'output', output: outs.includes(c.output) ? c.output : bad(`compare.output must be one of ${outs.join(', ')}`) };
    }
    case 'indicator': return { type: 'indicator', ...parseIndicatorRef(c, 'compare') };
    case 'price': return { type: 'price', source: c.source == null ? 'mid' : SOURCES.includes(c.source) ? c.source : bad(`compare.source must be one of ${SOURCES.join(', ')}`) };
    default: return bad('compare.type must be value, output, indicator or price');
  }
}
function parseAlertInterval(v) {
  const T = loadLibs().IGTypes;
  const p = typeof v === 'string' || typeof v === 'number' ? T.parseInterval(String(v)) : null;
  if (!p || p.kind !== 'time') bad('interval must be a time interval such as 1, 5, 15, 60, 240, 1D, 1W, 1M');
  const base = T.baseResolution(p, Object.keys(RES_SECONDS));
  if (!base || !RES_SECONDS[base.resolution]) bad(`no IG resolution can build interval ${v}`);
  return String(v).trim();
}

const parseLine = (g, w) => ({ t1: finite(g?.t1, `${w}.t1`), p1: finite(g?.p1, `${w}.p1`), t2: finite(g?.t2, `${w}.t2`), p2: finite(g?.p2, `${w}.p2`), extL: !!g.extL, extR: !!g.extR });
function parseGeometry(g, cond) {
  if (!g || typeof g !== 'object') bad('geometry must be an object');
  let o;
  if (g.kind === 'hline') o = { kind: 'hline', p: finite(g.p, 'geometry.p') };
  else if (g.kind === 'line') { o = { kind: 'line', ...parseLine(g, 'geometry') }; if (o.t1 === o.t2) bad('geometry line needs t1 ≠ t2'); }
  else if (g.kind === 'band') o = { kind: 'band', upper: parseLine(g.upper || {}, 'geometry.upper'), lower: parseLine(g.lower || {}, 'geometry.lower') };
  else if (g.kind === 'box') o = { kind: 'box', t1: finite(g.t1, 'geometry.t1'), t2: finite(g.t2, 'geometry.t2'), p1: finite(g.p1, 'geometry.p1'), p2: finite(g.p2, 'geometry.p2') };
  else bad('geometry.kind must be hline, line, band or box');
  if (CHANNEL.has(cond) && (o.kind === 'hline' || o.kind === 'line')) bad(`${cond} needs a band or box geometry`);
  return o;
}

// Price on a line at time t: linear interpolation between the anchors; beyond the earlier (left) or later
// (right) anchor only when extL / extR is set; otherwise no value.
function lineAt(g, t) {
  if (g.t1 === g.t2) return null;
  const left = Math.min(g.t1, g.t2), right = Math.max(g.t1, g.t2);
  if ((t < left && !g.extL) || (t > right && !g.extR)) return null;
  return g.p1 + ((g.p2 - g.p1) * (t - g.t1)) / (g.t2 - g.t1);
}
function levelsAt(g, t) {
  if (g.kind === 'hline') return { lo: g.p, hi: g.p };
  if (g.kind === 'line') { const v = lineAt(g, t); return v == null ? null : { lo: v, hi: v }; }
  if (g.kind === 'band') {
    const u = lineAt(g.upper, t), l = lineAt(g.lower, t);
    return u == null || l == null ? null : { lo: Math.min(u, l), hi: Math.max(u, l) };
  }
  if (t < Math.min(g.t1, g.t2) || t > Math.max(g.t1, g.t2)) return null;
  return { lo: Math.min(g.p1, g.p2), hi: Math.max(g.p1, g.p2) };
}

// prev / now = { p, lo, hi } (a single level has lo === hi); crossing_* means crossing any boundary in that direction.
function evalLevels(cond, prev, now) {
  if (!now || now.p == null || now.lo == null || now.hi == null) return false;
  const inside = (x) => x.p >= x.lo && x.p <= x.hi;
  switch (cond) {
    case 'greater_than': return now.p > now.hi;
    case 'less_than': return now.p < now.lo;
    case 'inside_channel': return inside(now);
    case 'outside_channel': return !inside(now);
  }
  if (!prev || prev.p == null || prev.lo == null || prev.hi == null) return false;
  const up = (k) => prev.p < prev[k] && now.p >= now[k], down = (k) => prev.p > prev[k] && now.p <= now[k];
  switch (cond) {
    case 'crossing_up': return up('hi') || up('lo');
    case 'crossing_down': return down('hi') || down('lo');
    case 'crossing': return up('hi') || up('lo') || down('hi') || down('lo');
    case 'entering_channel': return !inside(prev) && inside(now);
    case 'exiting_channel': return inside(prev) && !inside(now);
    default: return false;
  }
}

// One bar series per (epic, interval), shared by every indicator alert that needs it.
const seriesMap = new Map();
const evalInfo = new Map(); // alert id → { lastValue, lastCompare, lastEvalAt, error }
const seriesKey = (a) => {
  let l;
  try { l = loadLibs().IGTypes.label(a.interval); } catch { l = String(a.interval); }
  return `${a.epic}|${l}`;
};

async function seedSeries(S) {
  S.timer = null;
  S.status = 'seeding';
  try {
    const T = loadLibs().IGTypes;
    const base = T.baseResolution(S.interval, Object.keys(RES_SECONDS));
    const ratio = Math.max(1, Math.round(T.parseInterval(S.interval).sec / base.sec));
    const max = Math.min(SEED_BARS * ratio, MAX_SERIES_BARS);
    if (MOCK && !mock.markets[S.epic]) bad(`no simulated data for ${S.epic}`);
    const { candles } = MOCK ? { candles: mock.history(S.epic, base.resolution, max) } : await getHistory(S.epic, base.resolution, max);
    if (seriesMap.get(S.key) !== S) return;
    if (!candles.length) bad('no history returned');
    S.bars = T.aggregate(candles, S.interval).slice(-SEED_BARS);
    S.bucket = (t) => T.aggregate([{ time: t, open: 1, high: 1, low: 1, close: 1 }], S.interval)[0].time;
    Object.assign(S, { status: 'ready', error: null, retryAt: null, backoff: 0, base: base.resolution });
    S.version++; S.closed++;
  } catch (e) {
    if (seriesMap.get(S.key) !== S) return;
    S.backoff = Math.min(Math.max(30, S.backoff * 2), 1800);
    Object.assign(S, { status: 'waiting-data', error: e.body?.error || e.message, retryAt: Date.now() + S.backoff * 1000 });
    S.timer = setTimeout(() => seedSeries(S), S.backoff * 1000);
    console.warn(`[alerts] seeding ${S.key} failed (${S.error}); retry in ${S.backoff}s`);
  }
}

function reindexSeries() {
  const want = new Map();
  for (const a of alerts) if (a.kind === 'indicator' && a.enabled) want.set(seriesKey(a), a);
  for (const [k, S] of seriesMap) if (!want.has(k)) { clearTimeout(S.timer); seriesMap.delete(k); }
  for (const [k, a] of want) {
    if (seriesMap.has(k)) { seriesMap.get(k).calc.clear(); continue; }
    const S = { key: k, epic: a.epic, interval: k.slice(a.epic.length + 1), bars: [], status: 'seeding', error: null, retryAt: null, backoff: 0, timer: null, version: 0, closed: 0, calc: new Map(), lastTickEval: 0 };
    seriesMap.set(k, S);
    seedSeries(S);
  }
  for (const id of evalInfo.keys()) if (!alerts.some((a) => a.id === id)) evalInfo.delete(id);
}

// → Set of series keys whose bar closed on this tick
function seriesOnTick(tick) {
  const closed = new Set();
  const p = pick(tick, 'mid');
  if (p == null) return closed;
  const t = Math.floor(tick.t / 1000);
  for (const S of seriesMap.values()) {
    if (S.epic !== tick.epic || S.status !== 'ready') continue;
    const k = S.bucket(t), last = S.bars[S.bars.length - 1];
    if (last && k < last.time) continue;
    S.version++;
    if (last && k === last.time) {
      if (p > last.high) last.high = p;
      if (p < last.low) last.low = p;
      last.close = p;
      last.volume = (last.volume || 0) + 1;
      continue;
    }
    S.bars.push({ time: k, open: p, high: p, low: p, close: p, volume: 1 });
    if (S.bars.length > MAX_SERIES_BARS) S.bars.splice(0, S.bars.length - MAX_SERIES_BARS);
    if (last) { S.closed++; closed.add(S.key); }
  }
  return closed;
}

// Computed once per (series state, indicator, params); closed-bar results exclude the live bar.
function indicatorOut(S, ref, closedOnly) {
  const ver = closedOnly ? S.closed : S.version;
  const ck = `${closedOnly ? 'c' : 'l'}|${ref.id}|${JSON.stringify(ref.params)}`;
  const hit = S.calc.get(ck);
  if (hit && hit.ver === ver) return hit.out;
  const def = loadLibs().IGInd.BY_ID[ref.id];
  if (!def) throw new Error(`unknown indicator ${ref.id}`);
  const bars = closedOnly ? S.bars.slice(0, -1) : S.bars;
  const memo = {};
  const ctx = {
    src: (name) => (SRC_FNS[name] ? (memo[name] ||= bars.map(SRC_FNS[name])) : undefined),
    tfSec: loadLibs().IGTypes.parseInterval(S.interval).sec, symbol: S.epic, decimals: decimalsOf(S.epic),
  };
  const out = def.calc(bars, ref.params, ctx) || {};
  S.calc.set(ck, { ver, out });
  return out;
}
const valAt = (arr, i) => (arr && i >= 0 && Number.isFinite(arr[i]) ? arr[i] : null);

// → { prev, now } as evalLevels points; tick mode supplies only `now` (prev comes from the last evaluation)
function indicatorPoints(a, S, closedOnly, tick) {
  const out = indicatorOut(S, a.indicator, closedOnly);
  const n = closedOnly ? S.bars.length - 1 : S.bars.length;
  const A = out[a.indicator.output], c = a.compare;
  let B;
  if (c.type === 'value') B = null;
  else if (c.type === 'output') B = out[c.output];
  else if (c.type === 'indicator') B = indicatorOut(S, c, closedOnly)[c.output];
  else B = S.bars.slice(0, n).map((b) => b.close);
  const half = c.type === 'price' && c.source !== 'mid' && tick && tick.bid != null && tick.offer != null ? (tick.offer - tick.bid) / 2 : 0;
  const cmp = (i) => (c.type === 'value' ? c.value : c.type === 'price' && !closedOnly && i === n - 1 ? pick(tick, c.source) : valAt(B, i) == null ? null : valAt(B, i) + (c.source === 'bid' ? -half : half));
  const pt = (i) => { const p = valAt(A, i), lo = cmp(i); return { p, lo, hi: c.type === 'value' && c.value2 != null ? c.value2 : lo }; };
  return { prev: n >= 2 ? pt(n - 2) : null, now: n >= 1 ? pt(n - 1) : null };
}

function evalIndicatorAlert(a, tick, now, closedKeys) {
  const S = seriesMap.get(seriesKey(a));
  if (!S || S.status !== 'ready') return;
  const info = evalInfo.get(a.id) || {};
  evalInfo.set(a.id, info);
  const st = stateOf(a.id, 0);
  try {
    let ok, pts;
    if (a.evaluate === 'tick') {
      if (now - (st.evalAt || 0) < TICK_EVAL_MS) return;
      st.evalAt = now;
      pts = indicatorPoints(a, S, false, tick);
      ok = evalLevels(a.condition, st.prev, pts.now);
      st.prev = pts.now;
    } else {
      if (!closedKeys.has(S.key)) return;
      pts = indicatorPoints(a, S, true, tick);
      ok = evalLevels(a.condition, pts.prev, pts.now);
    }
    Object.assign(info, { lastValue: pts.now?.p ?? null, lastCompare: pts.now?.lo ?? null, lastEvalAt: now, error: null });
    if (gate(a, st, ok, now)) fireAlert(a, a.epic, pick(tick, 'mid'), now);
  } catch (e) { info.error = e.message; }
}

function evalDrawingAlert(a, tick, now) {
  const st = stateOf(a.id, 0);
  const lv = levelsAt(a.geometry, now / 1000);
  const p = pick(tick, a.source);
  const pt = lv && p != null ? { p, ...lv } : null;
  const ok = evalLevels(a.condition, st.prev, pt);
  st.prev = pt;
  const info = evalInfo.get(a.id) || {};
  evalInfo.set(a.id, Object.assign(info, { lastValue: p ?? null, lastCompare: lv ? (lv.lo === lv.hi ? lv.lo : [lv.lo, lv.hi]) : null, lastEvalAt: now, status: lv ? 'active' : 'no-value' }));
  if (gate(a, st, ok, now)) fireAlert(a, a.epic, p, now);
}

function evalStatus(a) {
  if (a.kind === 'stmn') return stmnAlerts.status(a);
  if (a.kind !== 'indicator' && a.kind !== 'drawing') return {};
  const info = evalInfo.get(a.id) || {};
  const base = { lastValue: info.lastValue ?? null, lastCompare: info.lastCompare ?? null, lastEvalAt: info.lastEvalAt ?? null };
  if (a.kind === 'drawing') return { ...base, status: !a.enabled ? 'disabled' : info.status || 'waiting-tick' };
  const S = seriesMap.get(seriesKey(a));
  if (!a.enabled || !S) return { ...base, status: a.enabled ? 'idle' : 'disabled' };
  return {
    ...base, status: info.error ? 'error' : S.status, error: info.error || S.error || null, retryAt: S.retryAt,
    bars: S.bars.length, barTime: S.bars.length ? S.bars[S.bars.length - 1].time : null, baseResolution: S.base || null,
  };
}
const indTitle = (ref) => { try { const d = loadLibs().IGInd.BY_ID[ref.id]; return d ? loadLibs().IGInd.title(d, ref.params) : ref.id; } catch { return ref.id; } };
const compareText = (a) => {
  const c = a.compare;
  return c.type === 'value' ? (c.value2 != null ? `${c.value}/${c.value2}` : String(c.value))
    : c.type === 'output' ? c.output : c.type === 'indicator' ? `${indTitle(c)}${c.output ? `.${c.output}` : ''}` : `${c.source} price`;
};

// ---- firing, templating and webhooks
const marketName = (epic) => (MOCK ? mock.markets[epic]?.name : marketCache.get(epic)?.name) || epic;
const decimalsOf = (epic) => (MOCK ? mock.markets[epic]?.decimals : marketCache.get(epic)?.decimals);
const fmtPrice = (epic, p) => {
  if (p == null || !Number.isFinite(p)) return '';
  const d = decimalsOf(epic);
  return Number.isInteger(d) && d >= 0 && d <= 10 ? p.toFixed(d) : String(Number(p.toPrecision(10)));
};
const condText = (a) => (a.kind === 'multi'
  ? a.all.map((c) => `${c.epic} ${c.condition} ${c.value}${c.value2 != null ? `/${c.value2}` : ''}`).join(' AND ')
  : a.kind === 'indicator' ? `${indTitle(a.indicator)} ${a.condition} ${compareText(a)}`
  : a.kind === 'drawing' ? `${a.condition} ${a.geometry.kind}` : a.condition);
const render = (tpl, vars) => String(tpl).replace(/\{\{\s*(\w+)\s*\}\}/g, (m, k) => (vars[k] ?? m));
const jsonText = (s) => { try { const v = JSON.parse(s); return v !== null && typeof v === 'object'; } catch { return false; } };

function postOnce(url, body, headers) {
  return new Promise((resolve) => {
    const u = new URL(url);
    const data = Buffer.from(body);
    let done = false;
    const finish = (r) => { if (!done) { done = true; clearTimeout(timer); resolve(r); } };
    const req = (u.protocol === 'https:' ? https : http).request(u, {
      method: 'POST',
      headers: { 'User-Agent': 'ig-charts-alerts', ...headers, 'Content-Type': 'application/json', 'Content-Length': data.length },
    }, (res) => { res.resume(); res.on('end', () => finish({ status: res.statusCode })); res.on('error', () => finish({ status: res.statusCode })); });
    const timer = setTimeout(() => { req.destroy(); finish({ status: null, error: 'timeout after 5s' }); }, 5000);
    req.on('error', (e) => finish({ status: null, error: e.message }));
    req.end(data);
  });
}

async function deliverWebhook(w, body) {
  let r = await postOnce(w.url, body, w.headers);
  let attempts = 1;
  if (!(r.status >= 200 && r.status < 300)) {
    await new Promise((ok) => setTimeout(ok, 1000));
    r = await postOnce(w.url, body, w.headers);
    attempts = 2;
  }
  return { ...r, attempts, ok: r.status >= 200 && r.status < 300 };
}

const channels = require('./lib/notify-channels');
async function emitEvent({ kind, alert, name, epic, price, at, message, webhook }) {
  const ev = {
    id: crypto.randomUUID(), at, kind, alertId: alert ? alert.id : null, name, epic: epic || null,
    price: price == null || !Number.isFinite(price) ? null : Number(fmtPrice(epic, price)), message,
    webhook: webhook && webhook.enabled ? { url: webhook.url, pending: true, status: null } : null,
  };
  alertLog.push(ev);
  if (alertLog.length > MAX_LOG) alertLog.splice(0, alertLog.length - MAX_LOG);
  saveLog();
  broadcast({
    type: 'alert',
    alert: alert || { id: null, kind: 'notify', name, notify: true },
    event: { id: ev.id, kind, at, epic: ev.epic, price: ev.price, message },
  });
  if (!alert || alert.notify !== false) {
    pushAll({ title: name, body: message, tag: ev.id, url: '/', data: { alertId: ev.alertId, epic: ev.epic, kind } })
      .catch((e) => console.warn('[push] failed:', e.message));
  }
  if (!alert || alert.notify !== false) {
    const ch = channels.status();
    if (ch.telegram || ch.email) channels.deliver({ title: name, message, alert }).then((r) => { if (Object.keys(r).length) { ev.channels = r; saveLog(); } }).catch((e) => console.warn('[alerts] channels:', e.message));
  }
  if (ev.webhook) {
    const body = jsonText(message) ? message
      : JSON.stringify({ alert: name, ticker: ev.epic, price: ev.price, time: new Date(at).toISOString(), message });
    Object.assign(ev.webhook, await deliverWebhook(webhook, body), { pending: false });
    if (!ev.webhook.ok) console.warn('[alerts] webhook failed', webhook.url, ev.webhook.status ?? ev.webhook.error);
    saveLog();
  }
  return ev;
}

function alertMessage(a, epic, price, at) {
  if (a.kind === 'stmn') return stmnAlerts.message(a, epic, price, at);
  const q = stream.last.get(epic) || {};
  const c = a.kind === 'multi' ? a.all[0] : a.kind === 'indicator' ? a.compare : a;
  const info = evalInfo.get(a.id) || {};
  const lvl = Array.isArray(info.lastCompare) ? info.lastCompare : [info.lastCompare, null];
  const num = (v) => (v == null || !Number.isFinite(v) ? '' : String(Number(v.toPrecision(8))));
  const value = a.kind === 'drawing' ? fmtPrice(epic, lvl[0]) : a.kind !== 'indicator' || c.type === 'value' ? String(c.value)
    : c.type === 'price' ? fmtPrice(epic, info.lastCompare) : num(info.lastCompare);
  return render(a.message, {
    ticker: epic, name: a.name, market: marketName(epic), price: fmtPrice(epic, price),
    bid: fmtPrice(epic, q.bid), offer: fmtPrice(epic, q.offer), time: new Date(at).toISOString(),
    condition: condText(a), value, value2: a.kind === 'drawing' ? fmtPrice(epic, lvl[1]) : c.value2 == null ? '' : String(c.value2),
    interval: a.interval || '', indicator: a.indicator ? indTitle(a.indicator) : '',
    plot: a.kind === 'indicator' ? num(info.lastValue) : '',
  });
}

function fireAlert(a, epic, price, at, kind = 'alert') {
  if (kind === 'alert') {
    a.firedCount++;
    a.lastFiredAt = Date.now();
    if (a.trigger === 'once') {
      if (a.kind === 'watchlist') a.firedEpics.push(epic);
      if (a.kind !== 'watchlist' || a.epics.every((e) => a.firedEpics.includes(e))) a.enabled = false;
    }
    saveAlerts();
    if (!a.enabled) broadcast({ type: 'alerts-changed' });
  }
  return emitEvent({ kind, alert: a, name: a.name, epic, price, at, message: alertMessage(a, epic, price, at), webhook: a.webhook })
    .catch((e) => console.warn('[alerts] emit failed:', e.message));
}

const stmnAlerts = require('./lib/stmn-alerts');
stmnAlerts.register(() => ({ loadLibs, getHistory, mock, MOCK, RES_SECONDS, bad, parseEpic, parseAlertInterval, fireAlert, decimalsOf, marketName, DEFAULT_MESSAGE }));
const publicAlert = (a) => ({ ...a, expired: !!(a.expiresAt && Date.now() > a.expiresAt), ...evalStatus(a) });
function streamInfo() {
  const live = new Set([...stream.epics].slice(0, MAX_STREAM_SUBS));
  const eps = [...alertIndex.keys()];
  return {
    max: MAX_STREAM_SUBS, used: live.size,
    unsubscribed: eps.filter((e) => !live.has(e)),
    noData: MOCK ? eps.filter((e) => !mock.markets[e]) : [],
  };
}
function commitAlerts() { reindex(); saveAlerts(true); broadcast({ type: 'alerts-changed' }); }

// ---------------------------------------------------------------- HTTP app
const app = express();
// Behind a TLS-terminating reverse proxy (Coolify/Traefik, Railway) so req.secure reflects https
app.set('trust proxy', 1);
app.get('/healthz', (req, res) => res.json({ ok: true }));

// Optional basic auth — use it if you deploy publicly
// Browsers don't reliably resend basic-auth credentials on WebSocket upgrades, so a
// successful HTTP login also sets a session cookie that the /ws handshake accepts.
const AUTH_COOKIE = 'igc_session';
// Derived from the credentials so it survives server restarts and changes if the password does
const AUTH_TOKEN = crypto.createHmac('sha256', `${env('APP_USER', 'admin')}:${env('APP_PASSWORD')}`)
  .update(`igc-session|${env('IG_API_KEY')}`).digest('hex');
const basicAuthOk = (req) => {
  const [user, pass] = Buffer.from((req.headers.authorization || '').split(' ')[1] || '', 'base64').toString().split(':');
  return user === env('APP_USER', 'admin') && pass === env('APP_PASSWORD');
};
const cookieAuthOk = (req) => (req.headers.cookie || '').split(';').some((c) => c.trim() === `${AUTH_COOKIE}=${AUTH_TOKEN}`);

// ---------------------------------------------------------------- MT5 bridge (read-only)
// The IGChartsBridge EA running inside the user's own MT5 terminal POSTs account, positions, orders and deals here.
// No MT5 password ever reaches this server; the EA authenticates with a bridge token.
const MT5_FILE = path.join(DATA_DIR, 'mt5.json');
const mt5 = { token: '', accounts: {}, saveT: null };
try { Object.assign(mt5, JSON.parse(fs.readFileSync(MT5_FILE, 'utf8'))); } catch {}
if (env('MT5_BRIDGE_TOKEN')) mt5.token = env('MT5_BRIDGE_TOKEN');
if (!mt5.token) mt5.token = crypto.randomBytes(16).toString('hex');
function saveMt5(now) {
  clearTimeout(mt5.saveT);
  const go = () => {
    try {
      fs.mkdirSync(DATA_DIR, { recursive: true });
      const tmp = MT5_FILE + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify({ token: env('MT5_BRIDGE_TOKEN') ? '' : mt5.token, accounts: mt5.accounts }), { mode: 0o600 });
      fs.renameSync(tmp, MT5_FILE);
    } catch (e) { console.warn('[mt5] save failed:', e.message); }
  };
  if (now) go(); else mt5.saveT = setTimeout(go, 1500);
}
saveMt5(true);
const mt5TokenOk = (t) => {
  const a = Buffer.from(String(t || '')), b = Buffer.from(mt5.token);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
};
const n5 = (v) => (v === null || v === undefined || v === '' || !Number.isFinite(+v) ? null : +v);
const s5 = (v, max = 64) => (v == null ? '' : String(v).slice(0, max));
const POS_TYPES = ['buy', 'sell'];
const ORD_TYPES = ['buy', 'sell', 'buy_limit', 'sell_limit', 'buy_stop', 'sell_stop', 'buy_stop_limit', 'sell_stop_limit', 'close_by'];
function cleanMt5(body) {
  const a = body && body.account;
  if (!a || a.login == null) throw Object.assign(new Error('account.login required'), { status: 400 });
  const account = {
    login: s5(a.login, 24), server: s5(a.server, 80), name: s5(a.name, 80), company: s5(a.company, 80), currency: s5(a.currency, 8),
    balance: n5(a.balance), equity: n5(a.equity), margin: n5(a.margin), freeMargin: n5(a.freeMargin), marginLevel: n5(a.marginLevel),
    leverage: n5(a.leverage), profit: n5(a.profit), tradeMode: s5(a.tradeMode, 12),
  };
  const arr = (x, max) => (Array.isArray(x) ? x.slice(0, max) : []);
  const positions = arr(body.positions, 500).map((p) => ({
    ticket: s5(p.ticket, 24), symbol: s5(p.symbol, 32), type: POS_TYPES.includes(p.type) ? p.type : 'buy', volume: n5(p.volume),
    priceOpen: n5(p.priceOpen), priceCurrent: n5(p.priceCurrent), sl: n5(p.sl) || null, tp: n5(p.tp) || null,
    profit: n5(p.profit), swap: n5(p.swap), time: n5(p.time), comment: s5(p.comment, 64), magic: n5(p.magic),
  })).filter((p) => p.symbol && p.priceOpen != null);
  const orders = arr(body.orders, 500).map((o) => ({
    ticket: s5(o.ticket, 24), symbol: s5(o.symbol, 32), type: ORD_TYPES.includes(o.type) ? o.type : 'buy_limit', volume: n5(o.volume),
    priceOpen: n5(o.priceOpen), stopLimit: n5(o.stopLimit) || null, sl: n5(o.sl) || null, tp: n5(o.tp) || null, time: n5(o.time), comment: s5(o.comment, 64),
  })).filter((o) => o.symbol && o.priceOpen != null);
  const deals = arr(body.deals, 3000).map((d) => ({
    ticket: s5(d.ticket, 24), order: s5(d.order, 24), positionId: s5(d.positionId, 24), symbol: s5(d.symbol, 32),
    type: d.type === 'sell' ? 'sell' : d.type === 'buy' ? 'buy' : s5(d.type, 16), entry: ['in', 'out', 'inout', 'out_by'].includes(d.entry) ? d.entry : 'in',
    volume: n5(d.volume), price: n5(d.price), profit: n5(d.profit), commission: n5(d.commission), swap: n5(d.swap), time: n5(d.time), comment: s5(d.comment, 64),
  })).filter((d) => d.symbol && d.price != null && d.time != null);
  return { account, positions, orders, deals, sentAt: n5(body.ts), historyFrom: n5(body.historyFrom) };
}
app.post('/api/mt5/push', express.json({ limit: '4mb', type: () => true }), (req, res) => {
  if (!mt5TokenOk(req.get('X-Bridge-Token') || req.query.token)) return res.status(401).json({ error: 'bad bridge token' });
  let snap;
  try { snap = cleanMt5(req.body); } catch (e) { return res.status(e.status || 400).json({ error: e.message }); }
  const key = snap.account.login;
  const prev = mt5.accounts[key] || { deals: [] };
  const byTicket = new Map((prev.deals || []).map((d) => [d.ticket, d]));
  for (const d of snap.deals) byTicket.set(d.ticket, d);
  const deals = [...byTicket.values()].sort((x, y) => x.time - y.time).slice(-5000);
  const changed = JSON.stringify([prev.positions, prev.orders, prev.account && prev.account.balance]) !== JSON.stringify([snap.positions, snap.orders, snap.account.balance]) || deals.length !== (prev.deals || []).length;
  mt5.accounts[key] = { account: snap.account, positions: snap.positions, orders: snap.orders, deals, lastSeen: Date.now(), historyFrom: snap.historyFrom };
  saveMt5(false);
  broadcast({ type: 'mt5', login: key, changed, lastSeen: Date.now(), account: snap.account, positions: snap.positions, orders: snap.orders });
  res.json({ ok: true, positions: snap.positions.length, orders: snap.orders.length, deals: deals.length });
});

if (env('APP_PASSWORD')) {
  app.use((req, res, next) => {
    if (basicAuthOk(req)) {
      res.cookie(AUTH_COOKIE, AUTH_TOKEN, { httpOnly: true, sameSite: 'strict', secure: req.secure, maxAge: 30 * 24 * 3600 * 1000 });
      return next();
    }
    if (cookieAuthOk(req)) return next();
    res.set('WWW-Authenticate', 'Basic realm="IG Charts"').status(401).send('Auth required');
  });
}

app.use(express.static(path.join(__dirname, 'public')));
app.get('/vendor/lightweight-charts.js', (req, res) =>
  res.sendFile(path.join(__dirname, 'node_modules/lightweight-charts/dist/lightweight-charts.standalone.production.js')));

const wrap = (fn) => (req, res) => fn(req, res).catch((e) => {
  console.warn('[API]', req.path, e.message);
  res.status(e.status && e.status < 500 ? e.status : 502).json(e.body || { error: e.message });
});
app.use('/api/state', express.json({ limit: '6mb' }));
app.use('/api', express.json({ limit: '256kb' }));
// IG order placement (lib/ig-trading.js): off unless IG_TRADING=1; LIVE also needs IG_TRADING_LIVE=1.
require('./lib/ig-trading').register(app, { MOCK, env, session, login, igBase: IG_BASE, stream, mock, dataDir: DATA_DIR, broadcast: (m) => broadcast(m), onAccountSwitch: () => streamStart() });

// MT5 bridge — authenticated routes for the app
app.get('/api/mt5/config', (req, res) => {
  res.json({ token: mt5.token, fromEnv: !!env('MT5_BRIDGE_TOKEN'), pushPath: '/api/mt5/push', accounts: Object.values(mt5.accounts).map((a) => ({ login: a.account.login, name: a.account.name, server: a.account.server, lastSeen: a.lastSeen })) });
});
app.get('/api/mt5/state', (req, res) => {
  const since = Number(req.query.dealsSince) || 0;
  res.json({ accounts: Object.values(mt5.accounts).map((a) => ({ ...a, deals: (a.deals || []).filter((d) => d.time >= since).slice(-2000) })) });
});
app.post('/api/mt5/token/rotate', (req, res) => {
  if (env('MT5_BRIDGE_TOKEN')) return res.status(409).json({ error: 'token is set by MT5_BRIDGE_TOKEN in .env' });
  mt5.token = crypto.randomBytes(16).toString('hex'); saveMt5(true);
  res.json({ token: mt5.token });
});
app.delete('/api/mt5/accounts/:login', (req, res) => {
  if (!mt5.accounts[req.params.login]) return res.status(404).json({ error: 'not-found' });
  delete mt5.accounts[req.params.login]; saveMt5(true);
  broadcast({ type: 'mt5', login: req.params.login, removed: true });
  res.json({ ok: true });
});
app.get('/mt5/IGChartsBridge.mq5', (req, res) => {
  res.type('text/plain').set('Content-Disposition', 'attachment; filename="IGChartsBridge.mq5"').sendFile(path.join(__dirname, 'mt5', 'IGChartsBridge.mq5'));
});


let defaults = [];
app.get('/api/status', wrap(async (req, res) => {
  res.json({
    mode: MOCK ? 'MOCK' : env('IG_ENV', 'DEMO').toUpperCase(),
    account: session.accountId, stream: stream.status, allowance, defaults,
    itemMode: stream.itemMode || 'MARKET', subError: stream.subError || null,
    live: [...stream.epics].map((epic) => {
      const t = stream.last.get(epic);
      const ticksLastMin = (stream.rate?.get(epic) || []).filter((x) => x > Date.now() - 60000).length;
      return { epic, ticksLastMin, lastTickSecAgo: t ? Math.round((Date.now() - t.t) / 1000) : null, bid: t?.bid ?? null, offer: t?.offer ?? null, state: t?.state ?? null };
    }),
  });
}));

app.get('/api/search', wrap(async (req, res) => {
  const q = String(req.query.q || '').trim();
  if (!q) return res.json([]);
  if (MOCK) return res.json(Object.values(mock.markets).filter((m) => m.name.toLowerCase().includes(q.toLowerCase())).map(({ epic, name, type }) => ({ epic, name, type, expiry: '-', status: 'TRADEABLE' })));
  res.json(await search(q));
}));

app.get('/api/market/:epic', wrap(async (req, res) => {
  const { epic } = req.params;
  if (MOCK) {
    const m = mock.markets[epic];
    if (!m) return res.status(404).json({ error: 'unknown' });
    return res.json({ epic, name: m.name, type: m.type, status: 'TRADEABLE', decimals: m.decimals, openingHours: m.hours || null, timezone: 'UTC' });
  }
  res.json(await getMarket(epic));
}));

app.get('/api/history', wrap(async (req, res) => {
  const epic = String(req.query.epic || '');
  const resolution = RES_SECONDS[req.query.resolution] ? req.query.resolution : 'MINUTE_5';
  const sec = RES_SECONDS[resolution];
  let max = Math.min(Math.max(parseInt(req.query.max, 10) || 300, 10), EXT_MAX);
  const side = req.query.side == null || req.query.side === '' ? 'mid' : SIDES.includes(req.query.side) ? req.query.side : bad(`side must be one of ${SIDES.join(', ')}`);
  if (!epic) return res.status(400).json({ error: 'epic required' });
  if (MOCK && !mock.markets[epic]) return res.status(404).json({ error: 'unknown' });
  let from = parseTime(req.query.from), to = parseTime(req.query.to);
  if (from == null && to == null) {
    if (MOCK) return res.json({ candles: mock.side(epic, mock.history(epic, resolution, max), side), allowance, resolution, side, maxBars: EXT_MAX, sources: [{ provider: 'mock', bars: max }] });
    const m = await getMarket(epic).catch(() => null);
    const extOk = req.query.ext !== '0' && m && histExt.available({ epic, name: m.name }, sec);
    if (!extOk) return res.json({ ...(await getHistory(epic, resolution, Math.min(max, MAX_HISTORY), side)), allowance, resolution, side, maxBars: MAX_HISTORY });
    // IG supplies the most recent HISTORY_IG_DAYS (or whatever is already cached); the older bars come from the extended source.
    const cached = historyCache.get(`${epic}|${resolution}`);
    const igWant = Math.min(max, MAX_HISTORY, Math.max(300, Math.ceil((HISTORY_IG_DAYS * 86400) / sec), cached ? cached.max : 0));
    let igRes, igError;
    try { igRes = await getHistory(epic, resolution, igWant, side); } catch (e) {
      if (e.body?.error !== 'historical-data-allowance') throw e;
      igRes = { candles: [] }; igError = e;
    }
    try {
      const { candles, source } = await histExt.extend({ epic, name: m.name, sec, ig: igRes.candles, want: max, side, cacheDir: path.join(__dirname, '.cache', 'ext') });
      if (!candles.length && igError) throw igError;
      return res.json({ ...igRes, candles, sources: [...(source ? [source] : []), { provider: 'ig', bars: igRes.candles.length, from: igRes.candles[0] && igRes.candles[0].time }], allowance, resolution, side, maxBars: EXT_MAX, ...(igError ? { igAllowance: 'exhausted' } : {}) });
    } catch (e) {
      if (igError) throw igError;
      console.warn('[history-ext]', epic, e.message);
      return res.json({ ...igRes, extError: e.message, allowance, resolution, side, maxBars: EXT_MAX });
    }
  }
  to = to ?? Math.floor(Date.now() / 1000);
  from = from ?? to - (max - 1) * sec;
  if (from > to) return res.status(400).json({ error: 'from must be <= to' });
  const est = Math.floor((to - from) / sec) + 1;
  max = Math.min(max, MAX_HISTORY);
  if (est > MAX_HISTORY) return res.status(400).json({ error: 'range-too-large', estimate: est, max: MAX_HISTORY });
  if (MOCK) {
    const live = to >= Date.now() / 1000 - sec;
    const candles = mock.history(epic, resolution, est, live ? undefined : to).filter((c) => c.time >= from && c.time <= to);
    return res.json({ candles: mock.side(epic, candles, side), allowance, resolution, side, from, to });
  }
  res.json({ ...(await getRange(epic, resolution, from, to, est, side)), allowance, resolution, side, from, to });
}));

app.get('/api/quotes', (req, res) => {
  const want = String(req.query.epics || '').split(',').filter(Boolean);
  const all = Object.fromEntries(stream.last);
  res.json(want.length ? Object.fromEntries(want.filter((e) => all[e]).map((e) => [e, all[e]])) : all);
});

// ---------------------------------------------------------------- Alerts API
const findAlert = (id) => alerts.findIndex((a) => a.id === id);
app.get('/api/alerts', (req, res) => res.json({ alerts: alerts.map(publicAlert), max: MAX_ALERTS, stream: streamInfo() }));

app.post('/api/alerts', wrap(async (req, res) => {
  if (alerts.length >= MAX_ALERTS) return res.status(409).json({ error: 'alert-limit', max: MAX_ALERTS });
  const a = parseAlert(req.body);
  alerts.push(a);
  commitAlerts();
  res.status(201).json({ alert: publicAlert(a), stream: streamInfo() });
}));

app.get('/api/alerts/log', (req, res) => {
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 100, 1), MAX_LOG);
  const id = req.query.alertId ? String(req.query.alertId) : null;
  const events = (id ? alertLog.filter((e) => e.alertId === id) : alertLog).slice(-limit).reverse();
  res.json({ events, total: alertLog.length });
});

app.delete('/api/alerts/log', (req, res) => {
  alertLog = [];
  persist(LOG_FILE, () => alertLog, true);
  res.json({ ok: true });
});

app.patch('/api/alerts/:id', wrap(async (req, res) => {
  const i = findAlert(req.params.id);
  if (i < 0) return res.status(404).json({ error: 'not-found' });
  const { id, createdAt, firedCount, lastFiredAt, ...body } = req.body || {};
  alerts[i] = parseAlert(body, alerts[i]);
  alertState.delete(alerts[i].id);
  evalInfo.delete(alerts[i].id);
  commitAlerts();
  res.json({ alert: publicAlert(alerts[i]), stream: streamInfo() });
}));

app.delete('/api/alerts/:id', (req, res) => {
  const i = findAlert(req.params.id);
  if (i < 0) return res.status(404).json({ error: 'not-found' });
  const [a] = alerts.splice(i, 1);
  alertState.delete(a.id);
  commitAlerts();
  res.json({ ok: true });
});

app.post('/api/alerts/:id/test', wrap(async (req, res) => {
  const a = alerts[findAlert(req.params.id)];
  if (!a) return res.status(404).json({ error: 'not-found' });
  const epic = alertEpics(a)[0];
  const src = a.kind === 'multi' ? a.all[0].source : a.source;
  res.json({ event: await fireAlert(a, epic, pick(stream.last.get(epic), src), Date.now(), 'test') });
}));

app.post('/api/notify', wrap(async (req, res) => {
  const b = req.body && typeof req.body === 'object' ? req.body : {};
  const name = text(b.title, 'title', 200, '').trim() || 'Alert';
  const message = text(b.message, 'message', 4000, '') || name;
  const epic = b.epic == null || b.epic === '' ? null : parseEpic(b.epic);
  const price = b.price == null || b.price === '' ? null : finite(b.price, 'price');
  const webhook = parseWebhook(b.webhook);
  res.json({ event: await emitEvent({ kind: 'notify', alert: null, name, epic, price, at: Date.now(), message, webhook }) });
}));

// ---------------------------------------------------------------- State sync (.data/state.json)
const STATE_FILE = path.join(DATA_DIR, 'state.json');
const STATE_KEY_RE = /^[a-z0-9._-]{1,64}$/i;
const MAX_STATE_KEY = 5 * 1024 * 1024, MAX_STATE_TOTAL = 50 * 1024 * 1024;
const appState = (() => {
  let raw;
  try { raw = fs.readFileSync(STATE_FILE, 'utf8'); } catch { return new Map(); }
  try {
    const v = JSON.parse(raw);
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      return new Map(Object.entries(v).map(([k, e]) => [k, { ...e, bytes: Buffer.byteLength(JSON.stringify(e.value)) }]));
    }
  } catch {}
  const aside = `${STATE_FILE}.bad-${Date.now()}`;
  try { fs.renameSync(STATE_FILE, aside); } catch {}
  console.warn(`[state] unreadable state.json moved to ${aside}`);
  return new Map();
})();
const saveState = () => persist(STATE_FILE, () => Object.fromEntries([...appState].map(([k, { version, updatedAt, value }]) => [k, { version, updatedAt, value }])));
const stateBytes = () => { let n = 0; for (const e of appState.values()) n += e.bytes; return n; };
const clientId = (req) => { const v = req.get('X-Client-Id'); return typeof v === 'string' && v.length <= 100 ? v : null; };
const stateKey = (req) => (STATE_KEY_RE.test(req.params.key) ? req.params.key : bad('key must match /^[a-z0-9._-]{1,64}$/i'));

app.get('/api/state', (req, res) => res.json({
  keys: Object.fromEntries([...appState].map(([k, e]) => [k, { version: e.version, updatedAt: e.updatedAt, bytes: e.bytes }])),
  bytes: stateBytes(), maxKeyBytes: MAX_STATE_KEY, maxTotalBytes: MAX_STATE_TOTAL,
}));
app.get('/api/state/:key', wrap(async (req, res) => {
  const e = appState.get(stateKey(req));
  if (!e) return res.status(404).json({ error: 'not-found' });
  res.json({ key: req.params.key, version: e.version, updatedAt: e.updatedAt, value: e.value });
}));
app.put('/api/state/:key', wrap(async (req, res) => {
  const key = stateKey(req);
  const b = req.body;
  if (!b || typeof b !== 'object' || Array.isArray(b) || !('value' in b)) bad('body must be { value, baseVersion }');
  const cur = appState.get(key);
  const base = b.baseVersion ?? null;
  if (cur ? base !== cur.version : base !== null) return res.status(409).json({ error: 'conflict', version: cur ? cur.version : null, value: cur ? cur.value : null });
  const bytes = Buffer.byteLength(JSON.stringify(b.value));
  if (bytes > MAX_STATE_KEY) return res.status(413).json({ error: 'value-too-large', bytes, max: MAX_STATE_KEY });
  if (stateBytes() - (cur ? cur.bytes : 0) + bytes > MAX_STATE_TOTAL) return res.status(413).json({ error: 'state-quota', max: MAX_STATE_TOTAL });
  const e = { version: (cur ? cur.version : 0) + 1, updatedAt: Date.now(), value: b.value, bytes };
  appState.set(key, e);
  saveState();
  broadcast({ type: 'state-changed', key, version: e.version, origin: clientId(req) });
  res.json({ version: e.version, updatedAt: e.updatedAt });
}));
app.delete('/api/state/:key', wrap(async (req, res) => {
  const key = stateKey(req);
  if (!appState.delete(key)) return res.status(404).json({ error: 'not-found' });
  saveState();
  broadcast({ type: 'state-changed', key, version: null, origin: clientId(req) });
  res.json({ ok: true });
}));

// ---------------------------------------------------------------- Economic calendar & news
const FETCH_TIMEOUT = 8000, MAX_FEED_BYTES = 5 * 1024 * 1024;
function httpGet(url, redirects = 3) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = (u.protocol === 'https:' ? https : http).get(u, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; ig-charts/1.0)', Accept: 'application/json, application/rss+xml, application/atom+xml, application/xml, text/xml, */*', 'Accept-Encoding': 'gzip, deflate' },
      timeout: FETCH_TIMEOUT,
    }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirects > 0) {
        res.resume();
        return httpGet(new URL(res.headers.location, u).href, redirects - 1).then(resolve, reject);
      }
      if (res.statusCode !== 200) { res.resume(); return reject(new Error(`HTTP ${res.statusCode} from ${u.host}`)); }
      const enc = res.headers['content-encoding'];
      const body = enc === 'gzip' ? res.pipe(zlib.createGunzip()) : enc === 'deflate' ? res.pipe(zlib.createInflate()) : res;
      const chunks = [];
      let n = 0;
      body.on('data', (c) => { n += c.length; if (n > MAX_FEED_BYTES) { req.destroy(); reject(new Error(`response from ${u.host} exceeds ${MAX_FEED_BYTES} bytes`)); } else chunks.push(c); });
      body.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      body.on('error', reject);
    });
    const timer = setTimeout(() => req.destroy(new Error(`timeout after ${FETCH_TIMEOUT / 1000}s from ${u.host}`)), FETCH_TIMEOUT);
    req.on('close', () => clearTimeout(timer));
    req.on('timeout', () => req.destroy(new Error(`timeout after ${FETCH_TIMEOUT / 1000}s from ${u.host}`)));
    req.on('error', reject);
  });
}

// Cached fetches: fresh results live for `ttl`; failures are remembered for a minute and stale data is served with the error.
function cachedSource(ttl, load) {
  let cur = null, failAt = 0, failMsg = null, inflight = null;
  return async () => {
    const now = Date.now();
    if (cur && now - cur.at < ttl) return cur.value;
    if (failMsg && now - failAt < 60000) return { ...(cur ? cur.value : load.empty), error: failMsg, stale: !!cur };
    inflight ||= load().then((value) => { cur = { at: Date.now(), value }; failMsg = null; return value; })
      .catch((e) => { failAt = Date.now(); failMsg = e.message; return { ...(cur ? cur.value : load.empty), error: e.message, stale: !!cur }; })
      .finally(() => { inflight = null; });
    return inflight;
  };
}

const CURRENCY_COUNTRY = { USD: 'US', EUR: 'EU', GBP: 'GB', JPY: 'JP', AUD: 'AU', NZD: 'NZ', CAD: 'CA', CHF: 'CH', CNY: 'CN', ALL: 'ALL' };
const IMPACTS = ['High', 'Medium', 'Low', 'Holiday'];
const CALENDAR_URL = env('CALENDAR_URL', 'https://nfs.faireconomy.media/ff_calendar_thisweek.json');
const loadCalendar = async () => {
  const data = JSON.parse(await httpGet(CALENDAR_URL));
  if (!Array.isArray(data)) throw new Error('calendar feed did not return an array');
  const events = data.map((e) => {
    const t = Date.parse(e.date);
    const cur = String(e.country || '').toUpperCase();
    const ev = {
      time: Number.isFinite(t) ? Math.floor(t / 1000) : null, country: CURRENCY_COUNTRY[cur] || cur, currency: cur,
      title: String(e.title || ''), impact: IMPACTS.find((x) => x.toLowerCase() === String(e.impact || '').toLowerCase()) || 'Low',
      forecast: e.forecast ?? '', previous: e.previous ?? '',
    };
    if (e.actual != null && e.actual !== '') ev.actual = e.actual;
    return ev;
  }).filter((e) => e.time != null && e.title).sort((a, b) => a.time - b.time);
  return { events, source: CALENDAR_URL, fetchedAt: Date.now() };
};
loadCalendar.empty = { events: [], source: CALENDAR_URL, fetchedAt: null };
const calendar = cachedSource(30 * 60 * 1000, loadCalendar);

const NEWS_FEEDS = env('NEWS_FEEDS', 'https://www.fxstreet.com/rss/news,https://www.investing.com/rss/news_11.rss,https://www.coindesk.com/arc/outboundfeeds/rss/')
  .split(',').map((s) => s.trim()).filter(Boolean);
const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', hellip: '…', mdash: '—', ndash: '–', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“', euro: '€', pound: '£', yen: '¥', copy: '©', reg: '®', trade: '™' };
const decodeEntities = (s) => s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
  if (e[0] === '#') { const n = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10); return n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : m; }
  return ENTITIES[e.toLowerCase()] ?? m;
});
const cdata = (s) => s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, (m, x) => x.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'));
const plain = (s) => decodeEntities(decodeEntities(cdata(s || '')).replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ').replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
const tag = (xml, names) => {
  for (const n of names) {
    const m = new RegExp(`<${n}(?:\\s[^>]*)?>([\\s\\S]*?)</${n}>`, 'i').exec(xml);
    if (m) return m[1];
  }
  return '';
};
const attr = (s, name) => { const m = new RegExp(`\\s${name}\\s*=\\s*("([^"]*)"|'([^']*)')`, 'i').exec(s); return m ? decodeEntities(m[2] ?? m[3]) : null; };
const feedTime = (s) => {
  const v = plain(s);
  if (!v) return null;
  const t = Date.parse(/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(:\d{2})?$/.test(v) ? `${v.replace(' ', 'T')}Z` : v);
  return Number.isFinite(t) ? Math.floor(t / 1000) : null;
};
const clip = (s, n) => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);

function parseFeed(xml, url) {
  const atom = /<feed[\s>]/i.test(xml) && !/<rss[\s>]/i.test(xml);
  const head = xml.replace(/<(item|entry)[\s>][\s\S]*$/i, '');
  const host = new URL(url).host.replace(/^www\./, '');
  const title = plain(tag(head, ['title']));
  const source = !title ? host : title.toLowerCase().includes(host.split('.')[0]) ? title : `${host}: ${title}`;
  const items = [];
  for (const m of xml.matchAll(atom ? /<entry[\s>][\s\S]*?<\/entry>/gi : /<item[\s>][\s\S]*?<\/item>/gi)) {
    const x = m[0];
    let link;
    if (atom) {
      const links = [...x.matchAll(/<link\b[^>]*>/gi)].map((l) => l[0]);
      const alt = links.find((l) => !/\srel\s*=/.test(l) || /rel\s*=\s*["']alternate["']/i.test(l)) || links[0];
      link = alt ? attr(alt, 'href') : null;
    } else link = plain(tag(x, ['link'])) || plain(tag(x, ['guid']));
    const title = plain(tag(x, ['title']));
    if (!title) continue;
    items.push({
      title, link: link || null, source,
      time: feedTime(tag(x, atom ? ['published', 'updated'] : ['pubDate', 'dc:date', 'published', 'updated'])),
      summary: clip(plain(tag(x, atom ? ['summary', 'content'] : ['description', 'content:encoded', 'summary'])), 500),
    });
  }
  return items;
}

const loadNews = async () => {
  const results = await Promise.allSettled(NEWS_FEEDS.map(async (u) => parseFeed(await httpGet(u), u)));
  const errors = results.map((r, i) => (r.status === 'rejected' ? `${NEWS_FEEDS[i]}: ${r.reason.message}` : null)).filter(Boolean);
  if (errors.length === NEWS_FEEDS.length) throw new Error(errors.join('; ') || 'no NEWS_FEEDS configured');
  const seen = new Set(), items = [];
  for (const it of results.flatMap((r) => (r.status === 'fulfilled' ? r.value : []))) {
    const k = it.link || it.title;
    if (seen.has(k)) continue;
    seen.add(k);
    items.push(it);
  }
  items.sort((a, b) => (b.time || 0) - (a.time || 0));
  return { items, fetchedAt: Date.now(), sources: NEWS_FEEDS, ...(errors.length ? { error: errors.join('; ') } : {}) };
};
loadNews.empty = { items: [], fetchedAt: null, sources: NEWS_FEEDS };
const news = cachedSource(5 * 60 * 1000, loadNews);

app.get('/api/calendar', wrap(async (req, res) => res.json(await calendar())));
app.get('/api/news', wrap(async (req, res) => {
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 200);
  const r = await news();
  res.json({ ...r, items: (r.items || []).slice(0, limit) });
}));

// ---------------------------------------------------------------- Web push (VAPID ES256 + RFC 8291 aes128gcm)
const VAPID_FILE = path.join(DATA_DIR, 'vapid.json');
const PUSH_FILE = path.join(DATA_DIR, 'push.json');
const MAX_PUSH_SUBS = 100;
const b64u = (buf) => Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unb64u = (s) => Buffer.from(String(s).replace(/-/g, '+').replace(/_/g, '/'), 'base64');

let vapidKeys = null;
function vapid() {
  if (vapidKeys) return vapidKeys;
  let jwk;
  try { jwk = JSON.parse(fs.readFileSync(VAPID_FILE, 'utf8')).privateJwk; } catch {}
  if (!jwk?.d) {
    jwk = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).privateKey.export({ format: 'jwk' });
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(`${VAPID_FILE}.tmp`, JSON.stringify({ privateJwk: jwk, createdAt: Date.now() }), { mode: 0o600 });
    fs.renameSync(`${VAPID_FILE}.tmp`, VAPID_FILE);
    console.log('[push] generated VAPID keys in .data/vapid.json');
  }
  const privateKey = crypto.createPrivateKey({ key: jwk, format: 'jwk' });
  const publicKey = b64u(Buffer.concat([Buffer.from([4]), unb64u(jwk.x), unb64u(jwk.y)]));
  return (vapidKeys = { privateKey, publicKey });
}
function vapidAuth(endpoint) {
  const { privateKey, publicKey } = vapid();
  const enc = (o) => b64u(JSON.stringify(o));
  const unsigned = `${enc({ typ: 'JWT', alg: 'ES256' })}.${enc({ aud: new URL(endpoint).origin, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: env('VAPID_SUBJECT', 'mailto:ig-charts@example.com') })}`;
  const sig = crypto.sign('sha256', Buffer.from(unsigned), { key: privateKey, dsaEncoding: 'ieee-p1363' });
  return `vapid t=${unsigned}.${b64u(sig)}, k=${publicKey}`;
}

const hmac = (key, data) => crypto.createHmac('sha256', key).update(data).digest();
// RFC 8291 single-record aes128gcm body: salt(16) | rs(4) | idlen(1) | keyid(as_public) | ciphertext
function encryptPush(sub, payload, salt = crypto.randomBytes(16), ecdh = null) {
  const uaPublic = unb64u(sub.keys.p256dh), authSecret = unb64u(sub.keys.auth);
  if (!ecdh) { ecdh = crypto.createECDH('prime256v1'); ecdh.generateKeys(); }
  const asPublic = ecdh.getPublicKey();
  const ikm = hmac(hmac(authSecret, ecdh.computeSecret(uaPublic)), Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, asPublic, Buffer.from([1])]));
  const prk = hmac(salt, ikm);
  const cek = hmac(prk, Buffer.from('Content-Encoding: aes128gcm\0\x01')).subarray(0, 16);
  const nonce = hmac(prk, Buffer.from('Content-Encoding: nonce\0\x01')).subarray(0, 12);
  const c = crypto.createCipheriv('aes-128-gcm', cek, nonce);
  const ct = Buffer.concat([c.update(Buffer.concat([Buffer.from(payload), Buffer.from([2])])), c.final(), c.getAuthTag()]);
  const rs = Buffer.alloc(4);
  rs.writeUInt32BE(4096);
  return Buffer.concat([salt, rs, Buffer.from([asPublic.length]), asPublic, ct]);
}

let pushSubs = readList(PUSH_FILE).filter((s) => s && typeof s.endpoint === 'string' && s.keys?.p256dh && s.keys?.auth);
const savePush = () => persist(PUSH_FILE, () => pushSubs, true);
function parseSubscription(b) {
  let u;
  try { u = new URL(String(b?.endpoint)); } catch { bad('endpoint must be an absolute https URL'); }
  if (u.protocol !== 'https:') bad('endpoint must use https');
  const p256 = typeof b.keys?.p256dh === 'string' ? unb64u(b.keys.p256dh) : null, auth = typeof b.keys?.auth === 'string' ? unb64u(b.keys.auth) : null;
  if (!p256 || p256.length !== 65 || p256[0] !== 4) bad('keys.p256dh must be an uncompressed P-256 public key (base64url)');
  if (!auth || auth.length < 16) bad('keys.auth must be a 16-byte base64url secret');
  return { endpoint: u.href, keys: { p256dh: b.keys.p256dh, auth: b.keys.auth }, createdAt: Date.now() };
}

function sendPush(sub, payload, ttl = 86400) {
  return new Promise((resolve) => {
    let body;
    try { body = encryptPush(sub, payload); } catch (e) { return resolve({ status: null, error: e.message }); }
    const req = https.request(sub.endpoint, {
      method: 'POST',
      headers: { TTL: String(ttl), Urgency: 'high', 'Content-Encoding': 'aes128gcm', 'Content-Type': 'application/octet-stream', 'Content-Length': body.length, Authorization: vapidAuth(sub.endpoint) },
      timeout: FETCH_TIMEOUT,
    }, (res) => {
      let txt = '';
      res.on('data', (c) => { if (txt.length < 500) txt += c; });
      res.on('end', () => resolve({ status: res.statusCode, error: res.statusCode >= 300 ? txt.slice(0, 200) : undefined }));
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', (e) => resolve({ status: null, error: e.message }));
    req.end(body);
  });
}

async function pushAll(msg) {
  if (!pushSubs.length) return { sent: 0, failed: 0, removed: 0 };
  const payload = JSON.stringify({ title: clip(String(msg.title || 'IG Charts'), 120), body: clip(String(msg.body || ''), 800), tag: msg.tag, data: { url: msg.url || '/', ...msg.data } });
  const subs = pushSubs.slice();
  const results = await Promise.all(subs.map((s) => sendPush(s, payload)));
  const gone = new Set(subs.filter((s, i) => results[i].status === 404 || results[i].status === 410).map((s) => s.endpoint));
  if (gone.size) { pushSubs = pushSubs.filter((s) => !gone.has(s.endpoint)); savePush(); }
  results.forEach((r, i) => { if (!(r.status >= 200 && r.status < 300) && !gone.has(subs[i].endpoint)) console.warn('[push] failed', new URL(subs[i].endpoint).host, r.status ?? r.error); });
  return { sent: results.filter((r) => r.status >= 200 && r.status < 300).length, failed: results.filter((r) => !(r.status >= 200 && r.status < 300)).length, removed: gone.size };
}

app.get('/api/push/key', (req, res) => res.json({ publicKey: vapid().publicKey }));
app.post('/api/push/subscribe', wrap(async (req, res) => {
  const s = parseSubscription(req.body);
  const i = pushSubs.findIndex((x) => x.endpoint === s.endpoint);
  if (i >= 0) pushSubs[i] = { ...s, createdAt: pushSubs[i].createdAt };
  else {
    if (pushSubs.length >= MAX_PUSH_SUBS) return res.status(409).json({ error: 'subscription-limit', max: MAX_PUSH_SUBS });
    pushSubs.push(s);
  }
  savePush();
  res.status(i >= 0 ? 200 : 201).json({ ok: true, subscriptions: pushSubs.length });
}));
app.delete('/api/push/subscribe', wrap(async (req, res) => {
  const endpoint = String(req.body?.endpoint || req.query.endpoint || '');
  const n = pushSubs.length;
  pushSubs = pushSubs.filter((s) => s.endpoint !== endpoint);
  if (pushSubs.length === n) return res.status(404).json({ error: 'not-found' });
  savePush();
  res.json({ ok: true, subscriptions: pushSubs.length });
}));
app.get('/api/notify/channels', (req, res) => res.json(channels.status()));
app.post('/api/notify/channels/test', wrap(async (req, res) => {
  const r = await channels.deliver({ title: 'IG Charts', message: 'Test alert — this channel is working.', alert: null });
  res.json({ ...channels.status(), results: r });
}));
app.post('/api/push/test', wrap(async (req, res) => {
  res.json({ subscriptions: pushSubs.length, ...(await pushAll({ title: 'IG Charts', body: 'Test notification — push is working.', tag: 'igc-test', url: '/' })) });
}));

app.use('/api', (err, req, res, next) => {
  if (res.headersSent) return next(err);
  res.status(err.status && err.status < 500 ? err.status : 500).json({ error: err.type === 'entity.parse.failed' ? 'invalid JSON body' : err.message });
});

// ---------------------------------------------------------------- WebSocket (server → browsers)
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

broadcast = (msg) => {
  const data = JSON.stringify(msg);
  for (const ws of wss.clients) {
    if (ws.readyState !== 1) continue;
    if (msg.type === 'tick' && ws.epics && !ws.epics.has(msg.epic)) continue;
    ws.send(data);
  }
};

wss.on('connection', (ws, req) => {
  const ua = (req.headers['user-agent'] || '').slice(0, 60);
  if (env('APP_PASSWORD') && !basicAuthOk(req) && !cookieAuthOk(req)) {
    console.warn('[WS] rejected', req.headers.cookie ? '(stale cookie)' : '(no cookie)', ua);
    return ws.close(4401, 'auth');
  }
  console.log('[WS] browser connected', ua);
  ws.on('close', (code) => console.log('[WS] browser disconnected', code));
  ws.epics = new Set();
  ws.send(JSON.stringify({ type: 'status', stream: stream.status }));
  ws.on('message', (raw) => {
    let msg; try { msg = JSON.parse(raw); } catch { return; }
    if (msg.type === 'subscribe' && Array.isArray(msg.epics)) {
      console.log('[WS] browser subscribed', msg.epics.join(', '));
      for (const e of msg.epics.slice(0, MAX_STREAM_SUBS)) {
        ws.epics.add(e);
        watch(e);
        const last = stream.last.get(e);
        if (last) ws.send(JSON.stringify(last));
      }
    }
    if (msg.type === 'unsubscribe' && Array.isArray(msg.epics)) msg.epics.forEach((e) => ws.epics.delete(e));
  });
});

// ---------------------------------------------------------------- Boot
(async () => {
  if (MOCK) {
    defaults = Object.keys(mock.markets);
    mock.start();
    reindex();
    console.log('[MOCK] simulated prices — set IG_API_KEY/IG_USERNAME/IG_PASSWORD in .env for live IG data');
  } else {
    try {
      await login();
      defaults = await discoverDefaults();
      defaults.forEach((e) => stream.epics.add(e));
      reindex();
      streamStart();
      console.log('[IG] default watchlist:', defaults.join(', ') || '(none found — use search)');
    } catch (e) {
      console.error(e.message);
      stream.status = 'login-failed';
      reindex();
    }
  }
  console.log(`[alerts] ${alerts.length} alerts loaded`);
  server.listen(PORT, () => console.log(`IG Charts → http://localhost:${PORT}`));
  // Fill older gold history (and any HISTORY_PREFETCH markets) in the background; Dukascopy is intermittently slow.
  if (!MOCK && process.env.HISTORY_EXT !== "0") {
    const names = String(process.env.HISTORY_PREFETCH || "Spot Gold,Bitcoin").split(",").map((x) => x.trim()).filter(Boolean);
    for (const name of names) histExt.prefetch({ epic: "", name, days: 45, cacheDir: path.join(__dirname, ".cache", "ext"), log: console.log })?.catch((e) => console.warn("[history-ext] prefetch", name, e.message));
  }
})();

for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { flushSaves(); process.exit(0); });
