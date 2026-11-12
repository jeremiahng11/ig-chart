'use strict';

// Real IG order placement (REST /positions/otc, /workingorders/otc, /confirms) behind server-enforced gates.
//
// Every mutating action is two-step: POST /api/trade/preview validates the request against live market
// details and returns a normalized summary plus a single-use confirm token (30 s, bound to the exact
// request params, account and environment); POST /api/trade/place executes the order stored with that
// token. MOCK mode replaces IG with an in-memory simulated broker that fills at the mock quote.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const TOKEN_TTL_MS = 30000;
const MAX_TOKENS = 200;
const MAX_LOG = 5000;
const SNAPSHOT_TTL_MS = 1500;
const RULES_TTL_MS = 15000;
const ACCOUNTS_TTL_MS = 20000;
const FAR_LEVEL = 0.5; // levels more than 50% from the market are rejected as fat-finger input
const DIRS = ['BUY', 'SELL'];
const ORDER_TYPES = ['MARKET', 'LIMIT', 'STOP'];
const ACTIONS = ['open', 'close', 'amend', 'order-amend', 'order-cancel'];
const EPIC_RE = /^[A-Za-z0-9._-]{1,80}$/;
const DEAL_ID_RE = /^[A-Za-z0-9._-]{1,64}$/;

const fail = (status, error, code) => { const e = new Error(error); e.status = status; if (code) e.code = code; throw e; };
const bad = (msg) => fail(400, msg, 'INVALID');
const num = (v) => (v === '' || v == null || !Number.isFinite(+v) ? null : +v);
const round = (v, d) => (v == null ? null : Math.round(v * 10 ** d) / 10 ** d);
const onStep = (v, d) => Math.abs(v * 10 ** d - Math.round(v * 10 ** d)) < 1e-6;
const decimalsOf = (v) => { const s = String(v); if (/e-/i.test(s)) return Number(s.split(/e-/i)[1]); const i = s.indexOf('.'); return i < 0 ? 0 : s.length - i - 1; };
const opposite = (d) => (d === 'BUY' ? 'SELL' : 'BUY');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function stableStringify(v) {
  if (v === undefined) return undefined;
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map((x) => stableStringify(x) ?? 'null').join(',')}]`;
  return `{${Object.keys(v).sort().filter((k) => v[k] !== undefined).map((k) => `${JSON.stringify(k)}:${stableStringify(v[k])}`).join(',')}}`;
}

// ── Gate ────────────────────────────────────────────────────────────────────
// LIVE is assumed whenever either the configured environment or the REST base URL is not the demo gateway.
function environmentOf({ env, MOCK, igBase }) {
  if (MOCK) return 'MOCK';
  const live = env('IG_ENV', 'DEMO').toUpperCase() === 'LIVE' || (igBase != null && !/\/\/demo-api\./.test(String(igBase)));
  return live ? 'LIVE' : 'DEMO';
}
function tradingGate(deps) {
  const environment = environmentOf(deps);
  if (deps.env('IG_TRADING') !== '1') return { ok: false, environment, status: 403, code: 'TRADING_DISABLED', error: 'IG trading is disabled. Set IG_TRADING=1 in .env and restart the server.' };
  if (environment === 'LIVE' && deps.env('IG_TRADING_LIVE') !== '1') return { ok: false, environment, status: 403, code: 'LIVE_DISABLED', error: 'LIVE trading is disabled. Set IG_TRADING_LIVE=1 in addition to IG_TRADING=1 to trade a real-money account.' };
  return { ok: true, environment };
}

// ── Market rules ────────────────────────────────────────────────────────────
// Value of a 1.0 move of the quoted price for size 1 (estimate; used for P&L, margin and risk display).
const pointValueOf = (accountType, contractSize, scaling) =>
  (accountType === 'SPREADBET' ? 1 : (num(contractSize) || 1) / (num(scaling) > 1 ? num(scaling) : 1));

function rulesFromIG(d, accountType) {
  const inst = d.instrument || {}, snap = d.snapshot || {}, dr = d.dealingRules || {};
  const ccy = (inst.currencies || []).find((c) => c.isDefault) || (inst.currencies || [])[0] || {};
  const dist = (x) => (x && num(x.value) != null ? { value: +x.value, unit: x.unit } : null);
  return {
    epic: inst.epic, name: inst.name || inst.epic, expiry: inst.expiry || '-', type: inst.type,
    status: snap.marketStatus, bid: num(snap.bid), offer: num(snap.offer), quoteTime: snap.updateTime || null,
    decimals: Number.isInteger(snap.decimalPlacesFactor) ? snap.decimalPlacesFactor : null, scaling: num(snap.scalingFactor),
    minSize: dr.minDealSize && dr.minDealSize.unit !== 'PERCENTAGE' ? num(dr.minDealSize.value) : null,
    minStop: dist(dr.minNormalStopOrLimitDistance), minGuaranteedStop: dist(dr.minControlledRiskStopDistance),
    maxStopLimit: dist(dr.maxStopOrLimitDistance), minStep: dist(dr.minStepDistance),
    trailingAllowed: dr.trailingStopsPreference === 'AVAILABLE',
    guaranteedAllowed: !!inst.controlledRiskAllowed,
    marketOrders: dr.marketOrderPreference !== 'NOT_AVAILABLE',
    currency: ccy.code || null, contractSize: num(inst.contractSize),
    marginFactor: num(inst.marginFactor), marginFactorUnit: inst.marginFactorUnit || null,
    pointValue: pointValueOf(accountType, inst.contractSize, snap.scalingFactor),
  };
}

const distPrice = (dist, price) => (!dist ? null : dist.unit === 'PERCENTAGE' ? (price * dist.value) / 100 : dist.value);

// ── Validation / normalization ─────────────────────────────────────────────
function checkSize(size, rules, label = 'Size') {
  if (size == null || !(size > 0)) bad(`${label} must be a positive number of contracts`);
  const maxDec = Math.max(2, rules.minSize != null ? decimalsOf(rules.minSize) : 0);
  if (!onStep(size, maxDec)) bad(`${label} allows at most ${maxDec} decimals`);
  if (rules.minSize != null && size < rules.minSize - 1e-9) bad(`${label} ${size} is below the minimum deal size ${rules.minSize}`);
  if (size > 1e6) bad(`${label} is implausibly large`);
}
function checkLevel(v, rules, ref, label) {
  if (!(v > 0)) bad(`${label} must be a positive price`);
  if (rules.decimals != null && !onStep(v, rules.decimals)) bad(`${label} ${v} has more than ${rules.decimals} decimals`);
  if (ref > 0 && Math.abs(v - ref) / ref > FAR_LEVEL) bad(`${label} ${v} is more than ${FAR_LEVEL * 100}% away from the market (${ref})`);
}
function checkDistance(v, rules, ref, label) {
  if (!(v > 0)) bad(`${label} must be a positive distance`);
  if (rules.decimals != null && !onStep(v, rules.decimals)) bad(`${label} ${v} has more than ${rules.decimals} decimals`);
  if (ref > 0 && v / ref > FAR_LEVEL) bad(`${label} ${v} is more than ${FAR_LEVEL * 100}% of the price`);
}
const tradeable = (rules, allowEdits) => rules.status === 'TRADEABLE' || (allowEdits && rules.status === 'EDITS_ONLY');
function requireQuote(rules) {
  if (!(rules.bid > 0) || !(rules.offer > 0)) fail(409, `No current quote for ${rules.epic}`, 'NO_QUOTE');
}

// Raw request → normalized open order + display summary. ref = fill price estimate for market orders.
function normOpen(p, rules) {
  if (!EPIC_RE.test(String(p.epic || ''))) bad('epic is required');
  const direction = String(p.direction || '').toUpperCase();
  if (!DIRS.includes(direction)) bad('direction must be BUY or SELL');
  const orderType = String(p.orderType || 'MARKET').toUpperCase();
  if (!ORDER_TYPES.includes(orderType)) bad('orderType must be MARKET, LIMIT or STOP');
  if (!tradeable(rules, false)) fail(409, `Market ${rules.epic} is not tradeable (status ${rules.status || 'unknown'})`, 'MARKET_CLOSED');
  if (orderType === 'MARKET' && !rules.marketOrders) bad('Market orders are not available on this instrument');
  requireQuote(rules);
  const size = num(p.size);
  checkSize(size, rules);
  const quote = direction === 'BUY' ? rules.offer : rules.bid;
  const midQ = (rules.bid + rules.offer) / 2;
  let level = null;
  if (orderType !== 'MARKET') {
    level = num(p.level);
    checkLevel(level, rules, midQ, 'Order level');
    const above = level > quote;
    if (orderType === 'LIMIT' && (direction === 'BUY' ? above : level < quote)) bad(`A ${direction} LIMIT must be ${direction === 'BUY' ? 'below the offer' : 'above the bid'} (${quote})`);
    if (orderType === 'STOP' && (direction === 'BUY' ? level < quote : level > quote)) bad(`A ${direction} STOP must be ${direction === 'BUY' ? 'above the offer' : 'below the bid'} (${quote})`);
  }
  const entry = orderType === 'MARKET' ? quote : level;
  const sgn = direction === 'BUY' ? 1 : -1;
  const trailingStop = !!p.trailingStop;
  const guaranteedStop = !!p.guaranteedStop;
  const out = { epic: rules.epic, expiry: rules.expiry, currencyCode: rules.currency, direction, size, orderType, level,
    stopLevel: null, stopDistance: null, limitLevel: null, limitDistance: null, guaranteedStop, trailingStop, trailingStopIncrement: null,
    forceOpen: p.forceOpen !== false };
  const sl = num(p.stopLevel), sd = num(p.stopDistance), tl = num(p.limitLevel), td = num(p.limitDistance);
  if (sl != null && sd != null) bad('Set either stopLevel or stopDistance, not both');
  if (tl != null && td != null) bad('Set either limitLevel or limitDistance, not both');
  if (sl != null) { checkLevel(sl, rules, entry, 'Stop level'); if (sgn * (entry - sl) <= 0) bad(`Stop level must be ${sgn > 0 ? 'below' : 'above'} the entry price (${entry})`); out.stopLevel = sl; }
  if (sd != null) { checkDistance(sd, rules, entry, 'Stop distance'); out.stopDistance = sd; }
  if (tl != null) { checkLevel(tl, rules, entry, 'Limit level'); if (sgn * (tl - entry) <= 0) bad(`Limit level must be ${sgn > 0 ? 'above' : 'below'} the entry price (${entry})`); out.limitLevel = tl; }
  if (td != null) { checkDistance(td, rules, entry, 'Limit distance'); out.limitDistance = td; }
  const hasStop = out.stopLevel != null || out.stopDistance != null;
  if (guaranteedStop) {
    if (!rules.guaranteedAllowed) bad('Guaranteed stops are not available on this instrument');
    if (!hasStop) bad('A guaranteed stop needs a stop level or distance');
    if (trailingStop) bad('A stop cannot be both guaranteed and trailing');
  }
  if (trailingStop) {
    if (orderType !== 'MARKET') bad('Trailing stops are only available on market orders');
    if (!rules.trailingAllowed) bad('Trailing stops are not available on this instrument/account');
    if (out.stopDistance == null) bad('A trailing stop needs a stop distance (not a level)');
    const inc = num(p.trailingStopIncrement);
    if (!(inc > 0)) bad('A trailing stop needs a positive trailing increment');
    out.trailingStopIncrement = inc;
  }
  if (!out.forceOpen && (hasStop || out.limitLevel != null || out.limitDistance != null)) bad('Stops and limits require forceOpen');
  const stopPx = out.stopLevel ?? (out.stopDistance != null ? round(entry - sgn * out.stopDistance, rules.decimals ?? 8) : null);
  const limitPx = out.limitLevel ?? (out.limitDistance != null ? round(entry + sgn * out.limitDistance, rules.decimals ?? 8) : null);
  const warnings = [];
  const minStop = distPrice(guaranteedStop ? rules.minGuaranteedStop || rules.minStop : rules.minStop, entry);
  if (minStop != null && stopPx != null && Math.abs(entry - stopPx) < minStop - 1e-9) warnings.push(`Stop is closer than the minimum ${guaranteedStop ? 'guaranteed ' : ''}distance (${minStop}); IG may reject or adjust it.`);
  if (minStop != null && limitPx != null && rules.minStop && Math.abs(limitPx - entry) < distPrice(rules.minStop, entry) - 1e-9) warnings.push(`Limit is closer than the minimum distance (${distPrice(rules.minStop, entry)}).`);
  const maxSL = distPrice(rules.maxStopLimit, entry);
  if (maxSL != null && [stopPx, limitPx].some((x) => x != null && Math.abs(x - entry) > maxSL + 1e-9)) warnings.push(`Stop/limit is beyond the maximum distance (${maxSL}).`);
  if (orderType === 'MARKET') warnings.push('Market order: the fill price may differ from the indicative price.');
  if (guaranteedStop) warnings.push('Guaranteed stops carry a premium charged if the stop is triggered.');
  const pv = rules.pointValue || 1;
  const margin = rules.marginFactor == null ? null
    : rules.marginFactorUnit === 'PERCENTAGE' ? (size * pv * entry * rules.marginFactor) / 100 : size * pv * rules.marginFactor;
  return {
    order: out,
    summary: { epic: rules.epic, name: rules.name, expiry: rules.expiry, direction, size, orderType, price: entry,
      priceNote: orderType === 'MARKET' ? `indicative ${direction === 'BUY' ? 'offer' : 'bid'}` : `${orderType.toLowerCase()} entry level`,
      bid: rules.bid, offer: rules.offer, stopLevel: stopPx, stopDistance: out.stopDistance, limitLevel: limitPx, limitDistance: out.limitDistance,
      guaranteedStop, trailingStop, trailingStopIncrement: out.trailingStopIncrement, forceOpen: out.forceOpen,
      marginEst: margin, riskEst: stopPx != null ? Math.abs(entry - stopPx) * size * pv : null, rewardEst: limitPx != null ? Math.abs(limitPx - entry) * size * pv : null,
      instrumentCurrency: rules.currency, marketStatus: rules.status, decimals: rules.decimals, warnings },
  };
}

function normClose(p, pos, rules) {
  const size = p.size == null || p.size === '' ? pos.size : num(p.size);
  checkSize(size, { ...rules, minSize: null }, 'Close size');
  if (size > pos.size + 1e-9) bad(`Close size ${size} exceeds the position size ${pos.size}`);
  if (!tradeable(rules, false)) fail(409, `Market ${pos.epic} is not tradeable (status ${rules.status || 'unknown'})`, 'MARKET_CLOSED');
  requireQuote(rules);
  const remaining = round(pos.size - size, 6);
  const warnings = ['Closes at market: the fill price may differ from the indicative price.'];
  if (remaining > 0 && rules.minSize != null && remaining < rules.minSize - 1e-9) warnings.push(`The remaining ${remaining} would be below the minimum deal size ${rules.minSize}; IG may reject a partial close.`);
  const exit = pos.direction === 'BUY' ? rules.bid : rules.offer;
  const pv = pos.pointValue || rules.pointValue || 1;
  return {
    order: { dealId: pos.dealId, direction: opposite(pos.direction), size, orderType: 'MARKET' },
    summary: { epic: pos.epic, name: pos.name || rules.name, dealId: pos.dealId, direction: opposite(pos.direction), positionDirection: pos.direction,
      size, positionSize: pos.size, remaining, full: remaining <= 0, price: exit, priceNote: `indicative ${pos.direction === 'BUY' ? 'bid' : 'offer'}`, openLevel: pos.level,
      pnlEst: (exit - pos.level) * (pos.direction === 'BUY' ? 1 : -1) * size * pv, instrumentCurrency: pos.currency || rules.currency, marketStatus: rules.status, warnings },
  };
}

function normAmend(p, pos, rules) {
  if (!tradeable(rules, true)) fail(409, `Market ${pos.epic} cannot be edited (status ${rules.status || 'unknown'})`, 'MARKET_CLOSED');
  const pick = (k) => (Object.prototype.hasOwnProperty.call(p, k) ? (p[k] === null || p[k] === '' ? null : num(p[k]) ?? bad(`${k} must be a number or null`)) : pos[k] ?? null);
  const stopLevel = pick('stopLevel'), limitLevel = pick('limitLevel');
  const exit = pos.direction === 'BUY' ? rules.bid : rules.offer;
  const sgn = pos.direction === 'BUY' ? 1 : -1;
  requireQuote(rules);
  if (stopLevel != null) { checkLevel(stopLevel, rules, exit, 'Stop level'); if (sgn * (exit - stopLevel) <= 0) bad(`Stop level must be ${sgn > 0 ? 'below the bid' : 'above the offer'} (${exit})`); }
  if (limitLevel != null) { checkLevel(limitLevel, rules, exit, 'Limit level'); if (sgn * (limitLevel - exit) <= 0) bad(`Limit level must be ${sgn > 0 ? 'above the bid' : 'below the offer'} (${exit})`); }
  if (pos.guaranteedStop && stopLevel == null) bad('A guaranteed stop cannot be removed by amending; close the position instead');
  const stopTouched = Object.prototype.hasOwnProperty.call(p, 'stopLevel') && stopLevel !== pos.stopLevel;
  const keepTrail = pos.trailingStopDistance != null && !stopTouched && stopLevel != null;
  const order = { dealId: pos.dealId, stopLevel, limitLevel, guaranteedStop: !!pos.guaranteedStop, trailingStop: keepTrail,
    trailingStopDistance: keepTrail ? pos.trailingStopDistance : null, trailingStopIncrement: keepTrail ? pos.trailingStep : null };
  const warnings = [];
  if (pos.trailingStopDistance != null && !keepTrail) warnings.push('Changing the stop replaces the trailing stop with a fixed stop.');
  const pv = pos.pointValue || rules.pointValue || 1;
  return {
    order,
    summary: { epic: pos.epic, name: pos.name || rules.name, dealId: pos.dealId, direction: pos.direction, size: pos.size, openLevel: pos.level, price: exit,
      priceNote: 'current exit price', stopLevel, limitLevel, previousStopLevel: pos.stopLevel ?? null, previousLimitLevel: pos.limitLevel ?? null,
      guaranteedStop: !!pos.guaranteedStop, trailingStop: keepTrail, riskEst: stopLevel != null ? (stopLevel - pos.level) * sgn * pos.size * pv : null,
      instrumentCurrency: pos.currency || rules.currency, marketStatus: rules.status, warnings },
  };
}

function normOrderAmend(p, wo, rules) {
  if (!tradeable(rules, true)) fail(409, `Market ${wo.epic} cannot be edited (status ${rules.status || 'unknown'})`, 'MARKET_CLOSED');
  requireQuote(rules);
  const has = (k) => Object.prototype.hasOwnProperty.call(p, k);
  const level = has('level') ? num(p.level) : wo.level;
  const quote = wo.direction === 'BUY' ? rules.offer : rules.bid;
  checkLevel(level, rules, (rules.bid + rules.offer) / 2, 'Order level');
  if (wo.type === 'LIMIT' && (wo.direction === 'BUY' ? level > quote : level < quote)) bad(`A ${wo.direction} LIMIT must be ${wo.direction === 'BUY' ? 'below the offer' : 'above the bid'} (${quote})`);
  if (wo.type === 'STOP' && (wo.direction === 'BUY' ? level < quote : level > quote)) bad(`A ${wo.direction} STOP must be ${wo.direction === 'BUY' ? 'above the offer' : 'below the bid'} (${quote})`);
  const dist = (k) => { if (!has(k)) return wo[k] ?? null; if (p[k] === null || p[k] === '') return null; const v = num(p[k]); checkDistance(v, rules, level, k); return v; };
  const stopDistance = dist('stopDistance'), limitDistance = dist('limitDistance');
  if (wo.guaranteedStop && stopDistance == null) bad('A guaranteed stop cannot be removed from this order');
  const sgn = wo.direction === 'BUY' ? 1 : -1, d = rules.decimals ?? 8;
  return {
    order: { dealId: wo.dealId, level, type: wo.type, timeInForce: wo.timeInForce || 'GOOD_TILL_CANCELLED', stopDistance, limitDistance, guaranteedStop: !!wo.guaranteedStop },
    summary: { epic: wo.epic, name: wo.name || rules.name, dealId: wo.dealId, direction: wo.direction, size: wo.size, orderType: wo.type, price: level, previousLevel: wo.level,
      priceNote: `${String(wo.type).toLowerCase()} entry level`, stopDistance, limitDistance,
      stopLevel: stopDistance != null ? round(level - sgn * stopDistance, d) : null, limitLevel: limitDistance != null ? round(level + sgn * limitDistance, d) : null,
      guaranteedStop: !!wo.guaranteedStop, instrumentCurrency: wo.currency || rules.currency, marketStatus: rules.status, warnings: [] },
  };
}

function normOrderCancel(wo) {
  return { order: { dealId: wo.dealId },
    summary: { epic: wo.epic, name: wo.name, dealId: wo.dealId, direction: wo.direction, size: wo.size, orderType: wo.type, price: wo.level, priceNote: 'order level (cancel)', warnings: [] } };
}

// ── IG REST broker ──────────────────────────────────────────────────────────
function igBroker(deps) {
  const { session, login, igBase, env } = deps;
  async function call(method, p, version, body, extraHeaders = {}) {
    if (deps.MOCK) throw new Error('internal: IG call attempted in MOCK mode');
    if (!session.cst) await login();
    const send = () => fetch(`${igBase}${p}`, {
      method,
      headers: { 'X-IG-API-KEY': env('IG_API_KEY'), CST: session.cst || '', 'X-SECURITY-TOKEN': session.xst || '',
        'Content-Type': 'application/json; charset=UTF-8', Accept: 'application/json; charset=UTF-8', VERSION: version, ...extraHeaders },
      body: body ? JSON.stringify(body) : undefined,
    });
    let res = await send();
    if (res.status === 401) { session.cst = null; await login(); res = await send(); } // 401 = not executed
    const json = await res.json().catch(() => ({}));
    return { ok: res.ok, status: res.status, body: json, headers: res.headers };
  }
  async function ok(method, p, version, body, extra) {
    const r = await call(method, p, version, body, extra);
    if (!r.ok) fail(r.status >= 500 ? 502 : 400, `IG: ${r.body.errorCode || `HTTP ${r.status}`}`, r.body.errorCode || 'IG_ERROR');
    return r.body;
  }
  let accountsCache = null;
  async function accounts(force) {
    if (!force && accountsCache && Date.now() - accountsCache.at < ACCOUNTS_TTL_MS) return accountsCache.list;
    const d = await ok('GET', '/accounts', '1');
    const list = (d.accounts || []).map((a) => ({
      accountId: a.accountId, name: a.accountName, alias: a.accountAlias || null, type: a.accountType, currency: a.currency, status: a.status, preferred: !!a.preferred,
      balance: num(a.balance && a.balance.balance), available: num(a.balance && a.balance.available), profitLoss: num(a.balance && a.balance.profitLoss), deposit: num(a.balance && a.balance.deposit),
      current: a.accountId === session.accountId,
    }));
    accountsCache = { at: Date.now(), list };
    return list;
  }
  const currentType = async () => ((await accounts()).find((a) => a.current) || {}).type;
  const rulesCache = new Map();
  async function rules(epic, force) {
    const c = rulesCache.get(epic);
    if (!force && c && Date.now() - c.at < RULES_TTL_MS) return c.rules;
    const r = rulesFromIG(await ok('GET', `/markets/${encodeURIComponent(epic)}`, '3'), await currentType());
    rulesCache.set(epic, { at: Date.now(), rules: r });
    if (rulesCache.size > 100) rulesCache.delete(rulesCache.keys().next().value);
    return r;
  }
  async function positions() {
    const type = await currentType();
    const d = await ok('GET', '/positions', '2');
    return (d.positions || []).map(({ position: p = {}, market: m = {} }) => ({
      dealId: p.dealId, dealReference: p.dealReference, epic: m.epic, name: m.instrumentName, expiry: m.expiry, direction: p.direction, size: num(p.size), level: num(p.level),
      stopLevel: num(p.stopLevel), limitLevel: num(p.limitLevel), guaranteedStop: !!p.controlledRisk, trailingStopDistance: num(p.trailingStopDistance), trailingStep: num(p.trailingStep),
      currency: p.currency, contractSize: num(p.contractSize), createdUTC: p.createdDateUTC || p.createdDate || null, bid: num(m.bid), offer: num(m.offer), marketStatus: m.marketStatus,
      scaling: num(m.scalingFactor), pointValue: pointValueOf(type, p.contractSize, m.scalingFactor),
    }));
  }
  async function orders() {
    const d = await ok('GET', '/workingorders', '2');
    return (d.workingOrders || []).map(({ workingOrderData: w = {}, marketData: m = {} }) => ({
      dealId: w.dealId, epic: w.epic || m.epic, name: m.instrumentName, expiry: m.expiry, direction: w.direction, size: num(w.orderSize), level: num(w.orderLevel), type: w.orderType,
      timeInForce: w.timeInForce, goodTill: w.goodTillDateISO || w.goodTillDate || null, stopDistance: num(w.stopDistance), limitDistance: num(w.limitDistance),
      guaranteedStop: !!w.guaranteedStop, createdUTC: w.createdDateUTC || w.createdDate || null, currency: w.currencyCode, bid: num(m.bid), offer: num(m.offer), marketStatus: m.marketStatus,
    }));
  }
  async function activity(days) {
    const from = new Date(Date.now() - days * 86400000).toISOString().slice(0, 19);
    const d = await ok('GET', `/history/activity?from=${encodeURIComponent(from)}&detailed=true&pageSize=100`, '3');
    return (d.activities || []).map((a) => ({
      date: a.date, epic: a.epic, dealId: a.dealId, type: a.type, status: a.status, description: a.description, channel: a.channel,
      direction: a.details && a.details.direction, size: num(a.details && a.details.size), level: num(a.details && a.details.level),
      stopLevel: num(a.details && a.details.stopLevel), limitLevel: num(a.details && a.details.limitLevel), currency: a.details && a.details.currency,
    }));
  }
  async function confirm(dealReference) {
    for (let i = 0; i < 10; i++) {
      await sleep(i ? 400 : 150);
      const r = await call('GET', `/confirms/${encodeURIComponent(dealReference)}`, '1');
      if (r.ok) return mapConfirm(r.body);
      if (r.status !== 404) return { dealReference, dealStatus: 'UNKNOWN', reason: r.body.errorCode || `HTTP ${r.status}` };
    }
    return { dealReference, dealStatus: 'UNKNOWN', reason: 'confirmation not available yet — check positions and activity before retrying' };
  }
  const strip = (o) => Object.fromEntries(Object.entries(o).filter(([, v]) => v != null));
  // A transport failure after the request was sent leaves the outcome unknown; never resubmit automatically.
  async function sendDeal(method, p, version, body, extra, dealReference) {
    let r;
    try { r = await call(method, p, version, body, extra); } catch (e) {
      if (!dealReference) return { dealStatus: 'UNKNOWN', reason: `request outcome unknown (${e.message}) — check positions before retrying` };
      return { ...(await confirm(dealReference)), transportError: e.message };
    }
    if (!r.ok) return { dealStatus: 'REJECTED', reason: r.body.errorCode || `HTTP ${r.status}`, httpStatus: r.status };
    return confirm(r.body.dealReference || dealReference);
  }
  return {
    environmentAccount: () => session.accountId,
    accounts, rules, positions, orders, activity,
    async open(o) {
      const dealReference = `IGC${Date.now().toString(36)}${crypto.randomBytes(4).toString('hex')}`.toUpperCase().slice(0, 30);
      if (o.orderType === 'MARKET') {
        return sendDeal('POST', '/positions/otc', '2', strip({ epic: o.epic, expiry: o.expiry, direction: o.direction, size: o.size, orderType: 'MARKET', currencyCode: o.currencyCode,
          forceOpen: o.forceOpen, guaranteedStop: o.guaranteedStop, stopLevel: o.trailingStop ? null : o.stopLevel, stopDistance: o.stopDistance, limitLevel: o.limitLevel, limitDistance: o.limitDistance,
          trailingStop: o.trailingStop, trailingStopIncrement: o.trailingStop ? o.trailingStopIncrement : null, dealReference }), undefined, dealReference);
      }
      return sendDeal('POST', '/workingorders/otc', '2', strip({ epic: o.epic, expiry: o.expiry, direction: o.direction, size: o.size, level: o.level, type: o.orderType, currencyCode: o.currencyCode,
        timeInForce: 'GOOD_TILL_CANCELLED', guaranteedStop: o.guaranteedStop, forceOpen: o.forceOpen, stopLevel: o.stopLevel, stopDistance: o.stopDistance, limitLevel: o.limitLevel, limitDistance: o.limitDistance, dealReference }), undefined, dealReference);
    },
    close: (o) => sendDeal('POST', '/positions/otc', '1', { dealId: o.dealId, direction: o.direction, size: o.size, orderType: 'MARKET' }, { _method: 'DELETE' }),
    amend: (o) => sendDeal('PUT', `/positions/otc/${encodeURIComponent(o.dealId)}`, '2', { stopLevel: o.stopLevel, limitLevel: o.limitLevel, guaranteedStop: o.guaranteedStop, trailingStop: o.trailingStop,
      ...(o.trailingStop ? { trailingStopDistance: o.trailingStopDistance, trailingStopIncrement: o.trailingStopIncrement } : {}) }),
    orderAmend: (o) => sendDeal('PUT', `/workingorders/otc/${encodeURIComponent(o.dealId)}`, '2', strip({ level: o.level, type: o.type, timeInForce: o.timeInForce, stopDistance: o.stopDistance, limitDistance: o.limitDistance, guaranteedStop: o.guaranteedStop })),
    orderCancel: (o) => sendDeal('DELETE', `/workingorders/otc/${encodeURIComponent(o.dealId)}`, '2'),
    async switchAccount(accountId) {
      const r = await call('PUT', '/session', '1', { accountId, defaultAccount: false });
      if (!r.ok) fail(400, `IG: ${r.body.errorCode || `HTTP ${r.status}`}`, r.body.errorCode);
      session.xst = r.headers.get('X-SECURITY-TOKEN') || session.xst;
      session.accountId = accountId;
      accountsCache = null; rulesCache.clear();
      if (deps.onAccountSwitch) deps.onAccountSwitch(accountId);
    },
    currentAccountId: () => session.accountId,
  };
}

const mapConfirm = (c) => ({
  dealReference: c.dealReference, dealId: c.dealId, dealStatus: c.dealStatus, reason: c.reason, status: c.status, epic: c.epic, direction: c.direction,
  size: num(c.size), level: num(c.level), stopLevel: num(c.stopLevel), limitLevel: num(c.limitLevel), guaranteedStop: c.guaranteedStop, trailingStop: c.trailingStop,
  profit: num(c.profit), profitCurrency: c.profitCurrency || null, date: c.date, affectedDeals: c.affectedDeals || [],
});

// ── Simulated broker (MOCK) ─────────────────────────────────────────────────
function mockBroker(deps) {
  const { stream, mock } = deps;
  const accts = [
    { accountId: 'MOCK-CFD', name: 'Demo CFD (simulated)', type: 'CFD', currency: 'USD', cash: 10000 },
    { accountId: 'MOCK-SB', name: 'Demo spread bet (simulated)', type: 'SPREADBET', currency: 'GBP', cash: 5000 },
  ];
  const book = Object.fromEntries(accts.map((a) => [a.accountId, { positions: [], orders: [], activity: [] }]));
  const confirms = new Map();
  let current = accts[0].accountId, seq = 0;
  const id = (p) => `${p}${Date.now().toString(36).toUpperCase()}${(++seq).toString(36).toUpperCase()}`;
  const meta = (epic) => (mock && mock.markets && mock.markets[epic]) || null;
  // Mock ticks are unrounded floats; quote them at the market's decimals like IG does.
  const q = (epic) => {
    const t = stream.last.get(epic);
    if (!t || !(t.bid > 0) || !(t.offer > 0)) return null;
    const d = (meta(epic) || {}).decimals ?? 2;
    return { ...t, bid: round(t.bid, d), offer: round(t.offer, d) };
  };
  const emit = (event, data) => deps.broadcast({ type: 'trade', event, accountId: current, data });
  function rulesOf(epic) {
    const m = meta(epic);
    if (!m) fail(404, `Unknown market ${epic}`, 'UNKNOWN_EPIC');
    const t = q(epic);
    const isCrypto = /BTC/.test(epic);
    return { epic, name: m.name, expiry: '-', type: m.type, status: t ? t.state || 'TRADEABLE' : 'OFFLINE', bid: t ? t.bid : null, offer: t ? t.offer : null,
      quoteTime: t ? new Date(t.t).toISOString() : null, decimals: m.decimals, scaling: 1, minSize: isCrypto ? 0.01 : 0.1,
      minStop: { value: m.spread * 4, unit: 'POINTS' }, minGuaranteedStop: { value: m.spread * 20, unit: 'POINTS' }, maxStopLimit: { value: 75, unit: 'PERCENTAGE' },
      minStep: null, trailingAllowed: true, guaranteedAllowed: true, marketOrders: true, currency: 'USD', contractSize: 1,
      marginFactor: isCrypto ? 50 : 5, marginFactorUnit: 'PERCENTAGE', pointValue: 1 };
  }
  const B = () => book[current];
  const acctOf = () => accts.find((a) => a.accountId === current);
  const exitOf = (p, t) => (p.direction === 'BUY' ? t.bid : t.offer);
  const pnlOf = (p, t) => (t ? (exitOf(p, t) - p.level) * (p.direction === 'BUY' ? 1 : -1) * p.size : 0);
  function summary(a) {
    const bk = book[a.accountId];
    let upl = 0, margin = 0;
    for (const p of bk.positions) { const t = q(p.epic); upl += pnlOf(p, t); margin += p.size * (t ? (t.bid + t.offer) / 2 : p.level) * (/BTC/.test(p.epic) ? 0.5 : 0.05); }
    return { balance: round(a.cash, 2), profitLoss: round(upl, 2), deposit: round(margin, 2), available: round(a.cash + upl - margin, 2) };
  }
  function record({ kind, ...c }) {
    const full = { dealReference: c.dealReference || id('REF'), date: new Date().toISOString(), affectedDeals: [], ...c };
    confirms.set(full.dealReference, full);
    if (confirms.size > 300) confirms.delete(confirms.keys().next().value);
    B().activity.unshift({ date: full.date, epic: full.epic, dealId: full.dealId, type: kind || 'POSITION', status: full.dealStatus === 'ACCEPTED' ? 'ACCEPTED' : 'REJECTED',
      description: `${full.status || full.reason} ${full.direction || ''} ${full.size ?? ''} @ ${full.level ?? ''}`.trim(), direction: full.direction, size: full.size, level: full.level,
      stopLevel: full.stopLevel, limitLevel: full.limitLevel, currency: 'USD' });
    B().activity.length = Math.min(B().activity.length, 500);
    emit('CONFIRMS', full);
    return full;
  }
  const reject = (o, reason) => record({ dealStatus: 'REJECTED', reason, epic: o.epic, direction: o.direction, size: o.size, level: null });
  function bracket(p, o, fill) {
    const sgn = p.direction === 'BUY' ? 1 : -1, d = (meta(p.epic) || {}).decimals ?? 2;
    p.stopLevel = o.stopLevel ?? (o.stopDistance != null ? round(fill - sgn * o.stopDistance, d) : null);
    p.limitLevel = o.limitLevel ?? (o.limitDistance != null ? round(fill + sgn * o.limitDistance, d) : null);
    p.guaranteedStop = !!o.guaranteedStop;
    p.trailingStopDistance = o.trailingStop ? o.stopDistance : null;
    p.trailingStep = o.trailingStop ? o.trailingStopIncrement : null;
  }
  function closePart(p, size, t, reason) {
    const exit = exitOf(p, t), part = Math.min(size, p.size);
    const profit = round((exit - p.level) * (p.direction === 'BUY' ? 1 : -1) * part, 2);
    acctOf().cash += profit;
    p.size = round(p.size - part, 6);
    const full = p.size <= 1e-9;
    if (full) B().positions = B().positions.filter((x) => x !== p);
    emit('OPU', { ...view(p), status: full ? 'DELETED' : 'UPDATED' });
    return { dealStatus: 'ACCEPTED', reason: reason || 'SUCCESS', status: full ? 'FULLY_CLOSED' : 'PARTIALLY_CLOSED', dealId: p.dealId, epic: p.epic,
      direction: opposite(p.direction), size: part, level: exit, profit, profitCurrency: acctOf().currency, affectedDeals: [{ dealId: p.dealId, status: full ? 'FULLY_CLOSED' : 'PARTIALLY_CLOSED' }] };
  }
  function fillOpen(o, t, ref, kind) {
    const fill = o.direction === 'BUY' ? t.offer : t.bid;
    const a = acctOf(), s = summary(a);
    const need = o.size * fill * (/BTC/.test(o.epic) ? 0.5 : 0.05);
    if (need > s.available) return record({ dealReference: ref, dealStatus: 'REJECTED', reason: 'INSUFFICIENT_FUNDS', epic: o.epic, direction: o.direction, size: o.size, kind });
    let left = o.size;
    if (!o.forceOpen) {
      for (const p of B().positions.filter((x) => x.epic === o.epic && x.direction === opposite(o.direction))) {
        if (left <= 0) break;
        const take = Math.min(left, p.size); closePart(p, take, t); left = round(left - take, 6);
      }
      if (left <= 0) return record({ dealReference: ref, dealStatus: 'ACCEPTED', reason: 'SUCCESS', status: 'FULLY_CLOSED', epic: o.epic, direction: o.direction, size: o.size, level: fill, kind });
    }
    const p = { dealId: id('DIAAAA'), dealReference: ref, epic: o.epic, name: (meta(o.epic) || {}).name, expiry: '-', direction: o.direction, size: left, level: fill,
      currency: 'USD', contractSize: 1, createdUTC: new Date().toISOString(), pointValue: 1 };
    bracket(p, o, fill);
    B().positions.push(p);
    emit('OPU', { ...view(p), status: 'OPEN' });
    return record({ dealReference: ref, dealStatus: 'ACCEPTED', reason: 'SUCCESS', status: 'OPEN', dealId: p.dealId, epic: p.epic, direction: p.direction, size: p.size, level: fill,
      stopLevel: p.stopLevel, limitLevel: p.limitLevel, guaranteedStop: p.guaranteedStop, trailingStop: p.trailingStopDistance != null, kind });
  }
  const view = (p) => { const t = q(p.epic); return { ...p, bid: t ? t.bid : null, offer: t ? t.offer : null, marketStatus: t ? t.state || 'TRADEABLE' : 'OFFLINE' }; };
  // Stops, limits, trailing stops and working-order triggers on every mock tick.
  const timer = setInterval(() => {
    for (const a of accts) {
      const prev = current; current = a.accountId;
      try {
        for (const p of [...B().positions]) {
          const t = q(p.epic); if (!t) continue;
          const long = p.direction === 'BUY', x = exitOf(p, t);
          if (p.trailingStopDistance != null) {
            const cand = round(long ? x - p.trailingStopDistance : x + p.trailingStopDistance, (meta(p.epic) || {}).decimals ?? 2);
            const step = p.trailingStep || 0;
            if (p.stopLevel == null || (long ? cand >= p.stopLevel + step : cand <= p.stopLevel - step)) { p.stopLevel = p.stopLevel == null ? cand : long ? Math.max(p.stopLevel, cand) : Math.min(p.stopLevel, cand); emit('OPU', { ...view(p), status: 'UPDATED' }); }
          }
          if (p.stopLevel != null && (long ? x <= p.stopLevel : x >= p.stopLevel)) record({ ...closePart(p, p.size, p.guaranteedStop ? { bid: p.stopLevel, offer: p.stopLevel } : t, 'STOP_TRIGGERED') });
          else if (p.limitLevel != null && (long ? x >= p.limitLevel : x <= p.limitLevel)) record({ ...closePart(p, p.size, t, 'LIMIT_TRIGGERED') });
        }
        for (const w of [...B().orders]) {
          const t = q(w.epic); if (!t) continue;
          const px = w.direction === 'BUY' ? t.offer : t.bid;
          const hit = w.type === 'LIMIT' ? (w.direction === 'BUY' ? px <= w.level : px >= w.level) : (w.direction === 'BUY' ? px >= w.level : px <= w.level);
          if (!hit) continue;
          B().orders = B().orders.filter((x) => x !== w);
          emit('WOU', { ...w, status: 'DELETED' });
          fillOpen({ ...w, orderType: 'MARKET', forceOpen: w.forceOpen !== false, stopLevel: null, limitLevel: null }, t, id('REF'), 'WORKING_ORDER_FILL');
        }
      } finally { current = prev; }
    }
  }, 500);
  if (timer.unref) timer.unref();
  const findPos = (dealId) => B().positions.find((p) => p.dealId === dealId);
  const findOrd = (dealId) => B().orders.find((w) => w.dealId === dealId);
  return {
    async accounts() { return accts.map((a) => ({ accountId: a.accountId, name: a.name, alias: null, type: a.type, currency: a.currency, status: 'ENABLED', preferred: a.accountId === accts[0].accountId, ...summary(a), current: a.accountId === current })); },
    async rules(epic) { return rulesOf(epic); },
    async positions() { return B().positions.map(view); },
    async orders() { return B().orders.map((w) => { const t = q(w.epic); return { ...w, bid: t ? t.bid : null, offer: t ? t.offer : null, marketStatus: t ? t.state || 'TRADEABLE' : 'OFFLINE' }; }); },
    async activity() { return B().activity.slice(0, 100); },
    async open(o) {
      const ref = id('REF'), t = q(o.epic);
      if (!t) return reject(o, 'MARKET_OFFLINE');
      if (o.orderType === 'MARKET') return fillOpen(o, t, ref, 'POSITION');
      if (B().orders.length >= 200) return reject(o, 'MAX_AUTO_SIZE_EXCEEDED');
      const w = { dealId: id('DIAAAW'), epic: o.epic, name: (meta(o.epic) || {}).name, expiry: '-', direction: o.direction, size: o.size, level: o.level, type: o.orderType,
        timeInForce: 'GOOD_TILL_CANCELLED', goodTill: null, guaranteedStop: o.guaranteedStop, forceOpen: o.forceOpen, createdUTC: new Date().toISOString(), currency: 'USD',
        stopDistance: o.stopDistance ?? (o.stopLevel != null ? round(Math.abs(o.level - o.stopLevel), 8) : null),
        limitDistance: o.limitDistance ?? (o.limitLevel != null ? round(Math.abs(o.limitLevel - o.level), 8) : null) };
      B().orders.push(w);
      emit('WOU', { ...w, status: 'OPEN' });
      return record({ dealReference: ref, dealStatus: 'ACCEPTED', reason: 'SUCCESS', status: 'OPEN', dealId: w.dealId, epic: w.epic, direction: w.direction, size: w.size, level: w.level, kind: 'WORKING_ORDER' });
    },
    async close(o) {
      const p = findPos(o.dealId); if (!p) return record({ dealStatus: 'REJECTED', reason: 'POSITION_NOT_FOUND', dealId: o.dealId });
      const t = q(p.epic); if (!t) return record({ dealStatus: 'REJECTED', reason: 'MARKET_OFFLINE', dealId: o.dealId, epic: p.epic });
      return record(closePart(p, o.size, t));
    },
    async amend(o) {
      const p = findPos(o.dealId); if (!p) return record({ dealStatus: 'REJECTED', reason: 'POSITION_NOT_FOUND', dealId: o.dealId });
      p.stopLevel = o.stopLevel; p.limitLevel = o.limitLevel;
      if (!o.trailingStop) { p.trailingStopDistance = null; p.trailingStep = null; }
      emit('OPU', { ...view(p), status: 'UPDATED' });
      return record({ dealStatus: 'ACCEPTED', reason: 'SUCCESS', status: 'AMENDED', dealId: p.dealId, epic: p.epic, direction: p.direction, size: p.size, level: p.level, stopLevel: p.stopLevel, limitLevel: p.limitLevel, kind: 'EDIT_STOP_AND_LIMIT' });
    },
    async orderAmend(o) {
      const w = findOrd(o.dealId); if (!w) return record({ dealStatus: 'REJECTED', reason: 'WORKING_ORDER_NOT_FOUND', dealId: o.dealId });
      Object.assign(w, { level: o.level, stopDistance: o.stopDistance, limitDistance: o.limitDistance });
      emit('WOU', { ...w, status: 'UPDATED' });
      return record({ dealStatus: 'ACCEPTED', reason: 'SUCCESS', status: 'AMENDED', dealId: w.dealId, epic: w.epic, direction: w.direction, size: w.size, level: w.level, kind: 'WORKING_ORDER' });
    },
    async orderCancel(o) {
      const w = findOrd(o.dealId); if (!w) return record({ dealStatus: 'REJECTED', reason: 'WORKING_ORDER_NOT_FOUND', dealId: o.dealId });
      B().orders = B().orders.filter((x) => x !== w);
      emit('WOU', { ...w, status: 'DELETED' });
      return record({ dealStatus: 'ACCEPTED', reason: 'SUCCESS', status: 'DELETED', dealId: w.dealId, epic: w.epic, direction: w.direction, size: w.size, level: w.level, kind: 'WORKING_ORDER' });
    },
    async switchAccount(accountId) { if (!book[accountId]) bad('unknown account'); current = accountId; },
    currentAccountId: () => current,
    stop: () => clearInterval(timer),
  };
}

// ── Trade log (.data/trade-log.json) ────────────────────────────────────────
function tradeLog(file) {
  let entries = [];
  try { entries = JSON.parse(fs.readFileSync(file, 'utf8')); if (!Array.isArray(entries)) entries = []; } catch (e) {
    if (e.code !== 'ENOENT') { try { fs.renameSync(file, `${file}.corrupt-${Date.now()}`); } catch {} }
  }
  return {
    add(entry) {
      entries.push({ t: new Date().toISOString(), ...entry });
      if (entries.length > MAX_LOG) entries.splice(0, entries.length - MAX_LOG);
      try {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        const tmp = `${file}.tmp`;
        fs.writeFileSync(tmp, JSON.stringify(entries, null, 1));
        fs.renameSync(tmp, file);
      } catch (e) { console.warn('[trade] log write failed:', e.message); }
    },
    recent: (n) => entries.slice(-n).reverse(),
  };
}

// ── Lightstreamer TRADE:{accountId} (OPU / WOU / CONFIRMS) ──────────────────
function tradeStream(deps, onEvent) {
  const st = { client: null, accountId: null, sub: null, active: false };
  const tick = () => {
    const s = deps.stream, acct = deps.session && deps.session.accountId;
    if (!s || !s.client || !s.Subscription || !acct) { st.active = false; return; }
    if (st.client === s.client && st.accountId === acct && st.sub) return;
    if (st.sub && st.client) { try { st.client.unsubscribe(st.sub); } catch {} }
    const sub = new s.Subscription('DISTINCT', [`TRADE:${acct}`], ['CONFIRMS', 'OPU', 'WOU']);
    sub.addListener({
      onItemUpdate: (u) => {
        for (const f of ['CONFIRMS', 'OPU', 'WOU']) {
          const raw = u.getValue(f);
          if (!raw || !u.isValueChanged(f)) continue;
          let data; try { data = JSON.parse(raw); } catch { continue; }
          onEvent(f, data);
        }
      },
      onSubscription: () => { st.active = true; },
      onSubscriptionError: (code, msg) => { st.active = false; console.warn('[trade] TRADE subscription error', code, msg); },
      onUnsubscription: () => { st.active = false; },
    });
    s.client.subscribe(sub);
    Object.assign(st, { client: s.client, accountId: acct, sub });
  };
  const timer = setInterval(tick, 3000);
  if (timer.unref) timer.unref();
  setTimeout(tick, 1000);
  return { get active() { return st.active; } };
}

// ── Routes ──────────────────────────────────────────────────────────────────
function register(app, deps) {
  const env = deps.env || ((k, d = '') => (process.env[k] ?? d).trim());
  const D = { ...deps, env };
  const broker = D.MOCK ? mockBroker(D) : igBroker(D);
  const log = tradeLog(path.join(D.dataDir, 'trade-log.json'));
  const tokens = new Map();
  let snapCache = null;
  const invalidate = () => { snapCache = null; };
  const ls = D.MOCK ? null : tradeStream(D, (event, data) => { invalidate(); D.broadcast({ type: 'trade', event, accountId: D.session.accountId, data }); });

  const route = (fn) => (req, res) => Promise.resolve().then(() => fn(req, res)).catch((e) => {
    if (!e.status || e.status >= 500) console.warn('[trade]', req.method, req.path, e.message);
    res.status(e.status && e.status < 600 ? e.status : 502).json({ error: e.message, code: e.code || null });
  });
  const gate = () => { const g = tradingGate(D); if (!g.ok) fail(g.status, g.error, g.code); return g; };
  const sweep = () => { const now = Date.now(); for (const [k, v] of tokens) if (v.expires < now - 60000) tokens.delete(k); while (tokens.size > MAX_TOKENS) tokens.delete(tokens.keys().next().value); };

  async function snapshot(force) {
    if (!force && snapCache && Date.now() - snapCache.at < SNAPSHOT_TTL_MS) return snapCache.data;
    const [accounts, positions, orders] = await Promise.all([broker.accounts(), broker.positions(), broker.orders()]);
    const data = { accounts, positions, orders, accountId: broker.currentAccountId(), environment: environmentOf(D), at: Date.now() };
    snapCache = { at: Date.now(), data };
    return data;
  }
  const accountInfo = async () => (await broker.accounts()).find((a) => a.current) || { accountId: broker.currentAccountId() };

  app.get('/api/trade/status', route(async (req, res) => {
    const g = tradingGate(D);
    res.json({ enabled: g.ok, environment: g.environment, live: g.environment === 'LIVE', reason: g.ok ? null : g.error, code: g.ok ? null : g.code,
      accountId: broker.currentAccountId(), push: D.MOCK ? 'mock' : ls && ls.active ? 'lightstreamer' : 'poll', tokenTtlMs: TOKEN_TTL_MS });
  }));
  app.get('/api/trade/accounts', route(async (req, res) => res.json({ accounts: await broker.accounts(), environment: environmentOf(D) })));
  app.get('/api/trade/snapshot', route(async (req, res) => res.json(await snapshot(req.query.force === '1'))));
  app.get('/api/trade/positions', route(async (req, res) => res.json({ positions: (await snapshot()).positions })));
  app.get('/api/trade/orders', route(async (req, res) => res.json({ orders: (await snapshot()).orders })));
  app.get('/api/trade/activity', route(async (req, res) => res.json({ activities: await broker.activity(Math.min(Math.max(num(req.query.days) || 3, 1), 30)) })));
  app.get('/api/trade/log', route(async (req, res) => res.json({ entries: log.recent(Math.min(Math.max(num(req.query.limit) || 100, 1), 1000)) })));
  app.get('/api/trade/market/:epic', route(async (req, res) => {
    if (!EPIC_RE.test(req.params.epic)) bad('invalid epic');
    res.json(await broker.rules(req.params.epic));
  }));

  app.post('/api/trade/account', route(async (req, res) => {
    gate();
    const accountId = String((req.body || {}).accountId || '');
    if (!DEAL_ID_RE.test(accountId)) bad('accountId is required');
    if (accountId === broker.currentAccountId()) return res.json({ accountId, changed: false });
    if (!(await broker.accounts()).some((a) => a.accountId === accountId)) bad('unknown account');
    await broker.switchAccount(accountId);
    for (const [k, v] of tokens) if (v.accountId !== accountId) tokens.delete(k);
    invalidate();
    log.add({ action: 'switch-account', environment: environmentOf(D), accountId });
    D.broadcast({ type: 'trade', event: 'ACCOUNT', accountId, data: { accountId } });
    res.json({ accountId, changed: true });
  }));

  async function prepare(action, params) {
    if (action === 'open') return normOpen(params, await broker.rules(String(params.epic || ''), true));
    const dealId = String(params.dealId || '');
    if (!DEAL_ID_RE.test(dealId)) bad('dealId is required');
    if (action === 'close' || action === 'amend') {
      const pos = (await broker.positions()).find((p) => p.dealId === dealId) || fail(404, `Position ${dealId} not found`, 'NOT_FOUND');
      const rules = await broker.rules(pos.epic, true);
      return action === 'close' ? normClose(params, pos, rules) : normAmend(params, pos, rules);
    }
    const wo = (await broker.orders()).find((w) => w.dealId === dealId) || fail(404, `Working order ${dealId} not found`, 'NOT_FOUND');
    if (action === 'order-cancel') return normOrderCancel(wo);
    return normOrderAmend(params, wo, await broker.rules(wo.epic, true));
  }
  const cleanParams = (b) => { const p = b && typeof b.params === 'object' && b.params && !Array.isArray(b.params) ? b.params : null; return p || bad('params object is required'); };
  const cleanAction = (b) => { const a = String((b || {}).action || 'open'); return ACTIONS.includes(a) ? a : bad(`action must be one of ${ACTIONS.join(', ')}`); };

  app.post('/api/trade/preview', route(async (req, res) => {
    const g = gate();
    const action = cleanAction(req.body), params = cleanParams(req.body);
    const { order, summary } = await prepare(action, params);
    const acct = await accountInfo();
    sweep();
    const token = crypto.randomBytes(18).toString('base64url');
    const expires = Date.now() + TOKEN_TTL_MS;
    tokens.set(token, { action, binding: stableStringify(params), order, accountId: acct.accountId, environment: g.environment, expires });
    res.json({ token, expiresAt: expires, ttlMs: TOKEN_TTL_MS, action,
      summary: { ...summary, action, environment: g.environment, accountId: acct.accountId, accountName: acct.name || acct.accountId, accountType: acct.type || null, accountCurrency: acct.currency || null } });
  }));

  app.post('/api/trade/place', route(async (req, res) => {
    const g = gate();
    const action = cleanAction(req.body), params = cleanParams(req.body);
    const token = String((req.body || {}).token || '');
    const t = tokens.get(token);
    tokens.delete(token);
    const reject = (status, error, code) => { log.add({ action, environment: g.environment, accountId: broker.currentAccountId(), params, rejected: code }); fail(status, error, code); };
    if (!t) reject(409, 'Confirm token is unknown or was already used. Preview the order again.', 'TOKEN_INVALID');
    if (t.expires < Date.now()) reject(409, 'Confirm token expired. Preview the order again.', 'TOKEN_EXPIRED');
    if (t.action !== action || t.binding !== stableStringify(params)) reject(409, 'Order parameters changed after preview. Preview the order again.', 'TOKEN_MISMATCH');
    if (t.environment !== g.environment || t.accountId !== broker.currentAccountId()) reject(409, 'Account or environment changed after preview. Preview the order again.', 'TOKEN_ACCOUNT');
    const fn = { open: broker.open, close: broker.close, amend: broker.amend, 'order-amend': broker.orderAmend, 'order-cancel': broker.orderCancel }[action];
    let result;
    try { result = await fn(t.order); } catch (e) {
      log.add({ action, environment: g.environment, accountId: t.accountId, order: t.order, error: e.message });
      throw e;
    }
    invalidate();
    log.add({ action, environment: g.environment, accountId: t.accountId, order: t.order, result });
    D.broadcast({ type: 'trade', event: 'RESULT', accountId: t.accountId, data: { action, ...result } });
    res.json({ action, environment: g.environment, accountId: t.accountId, result });
  }));

  return { broker, tokens, stop: () => broker.stop && broker.stop() };
}

module.exports = { register, tradingGate, environmentOf, stableStringify, rulesFromIG, normOpen, normClose, normAmend, normOrderAmend, pointValueOf, TOKEN_TTL_MS };
