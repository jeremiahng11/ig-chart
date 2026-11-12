/* Paper trading: simulated broker, chart trading and price ladder. Simulation only — never sends orders anywhere. */
(function () {
  'use strict';
  const KEY = 'paper.v1', TKEY = 'paper.ticket', CAP = 2000;
  const num = (v) => (v === '' || v == null || !Number.isFinite(+v) ? null : +v);
  const toMs = (t) => (t == null || !Number.isFinite(+t) ? Date.now() : +t < 1e12 ? +t * 1000 : +t);
  const utcDay = (ms) => Math.floor(ms / 86400000);
  const mid = (q) => (q.bid + q.offer) / 2;
  const validQ = (q) => !!q && Number.isFinite(q.bid) && Number.isFinite(q.offer) && q.bid > 0 && q.offer > 0;
  const cleanQty = (x) => Math.round(x * 1e8) / 1e8;
  const TYPES = ['market', 'limit', 'stop', 'stoplimit'];
  const LEVS = [1, 2, 5, 10, 20, 30, 50, 100, 200, 300, 400, 500, 1000];
  const TYPE_LABEL = { market: 'MKT', limit: 'LMT', stop: 'STP', stoplimit: 'STP LMT' };
  const REASON = { market: 'Market', limit: 'Limit', stop: 'Stop', stoplimit: 'Stop-limit', sl: 'Stop loss', tp: 'Take profit', trail: 'Trailing stop', close: 'Close', reverse: 'Reverse', closeall: 'Close all', replayend: 'Replay end' };

  // ── Engine ────────────────────────────────────────────────
  function create(o = {}) {
    const bal = num(o.balance) ?? 100000;
    return { v: 1, startBalance: bal, cash: bal, currency: o.currency || 'USD', leverage: num(o.leverage) ?? (num(o.marginPct) > 0 ? 100 / +o.marginPct : 100), specs: {}, defaultMarginPct: num(o.marginPct) ?? 1, marginPct: {},
      positions: {}, orders: [], orderLog: [], fills: [], trades: [], seq: 0, quotes: {} };
  }
  function normalize(a) {
    if (!a || typeof a !== 'object' || a.v !== 1) return create();
    const d = create({ balance: a.startBalance });
    const legacyLev = a.leverage == null && num(a.defaultMarginPct) > 0 ? Math.max(1, Math.round(100 / a.defaultMarginPct)) : null;
    for (const k of Object.keys(d)) if (a[k] == null || typeof a[k] !== typeof d[k]) a[k] = d[k];
    if (legacyLev) a.leverage = legacyLev;
    return a;
  }
  function reset(a, balance) {
    const n = create({ balance: num(balance) ?? a.startBalance, currency: a.currency, leverage: a.leverage });
    n.specs = a.specs || {};
    for (const k of Object.keys(a)) delete a[k];
    return Object.assign(a, n);
  }
  function configure(a, c = {}) {
    if (c.currency != null) a.currency = String(c.currency).slice(0, 8) || a.currency;
    if (num(c.leverage) >= 1) a.leverage = Math.min(5000, +c.leverage);
    if (num(c.defaultMarginPct) > 0) a.leverage = 100 / +c.defaultMarginPct;
    if (c.epic && c.marginPct !== undefined) { const sp = { ...(a.specs[c.epic] || {}) }; if (num(c.marginPct) > 0) sp.leverage = 100 / +c.marginPct; else delete sp.leverage; if (Object.keys(sp).length) a.specs[c.epic] = sp; else delete a.specs[c.epic]; }
    if (c.epic && c.spec) {
      const cur = a.specs[c.epic] || {}, n = {};
      for (const k of ['contract', 'minLot', 'lotStep', 'maxLot', 'leverage']) { const v = c.spec[k]; if (v === '' || v === null) continue; if (v !== undefined && num(v) > 0) n[k] = +v; else if (v === undefined && cur[k] != null) n[k] = cur[k]; }
      if (Object.keys(n).length) a.specs[c.epic] = n; else delete a.specs[c.epic];
    }
    return a;
  }
  // contract size per lot when the user hasn't set one: metals by the ounce/unit, crypto per coin, FX per 100k
  function autoContract(epic) {
    const e = String(epic || '').toUpperCase();
    if (/GOLD|XAU/.test(e)) return 100;
    if (/SILVER|XAG/.test(e)) return 5000;
    if (/BTC|BITCOIN|ETH|ETHER|XRP|LTC|SOL|CRYPTO/.test(e)) return 1;
    if (/(^|\.)(AUD|CAD|CHF|EUR|GBP|JPY|NZD|USD|SGD|HKD|NOK|SEK|ZAR|MXN|CNH|TRY)(AUD|CAD|CHF|EUR|GBP|JPY|NZD|USD|SGD|HKD|NOK|SEK|ZAR|MXN|CNH|TRY)(\.|$)/.test(e)) return 100000;
    return 1;
  }
  const specOf = (a, epic) => { const s = (a.specs && a.specs[epic]) || {}; return { contract: s.contract ?? autoContract(epic), minLot: s.minLot ?? 0.01, lotStep: s.lotStep ?? 0.01, maxLot: s.maxLot ?? 100, leverage: s.leverage ?? a.leverage ?? 100, custom: s }; };
  const contractOf = (a, epic) => specOf(a, epic).contract;
  const marginPctOf = (a, epic) => 100 / specOf(a, epic).leverage;
  const csOf = (p) => p.cs ?? 1;
  function lotError(a, epic, lots) {
    const s = specOf(a, epic);
    if (!(lots > 0)) return 'Volume must be positive';
    if (lots < s.minLot - 1e-9) return `Minimum volume is ${s.minLot} lots`;
    if (lots > s.maxLot + 1e-9) return `Maximum volume is ${s.maxLot} lots`;
    const k = lots / s.lotStep;
    if (Math.abs(k - Math.round(k)) > 1e-6) return `Volume must be a multiple of ${s.lotStep} lots`;
    return null;
  }
  const exitPx = (qty, q) => (qty > 0 ? q.bid : q.offer);
  const posPnl = (p, q) => (validQ(q) ? (exitPx(p.qty, q) - p.avg) * p.qty * csOf(p) : 0);
  const trim = (arr) => { if (arr.length > CAP) arr.splice(0, arr.length - CAP); };

  function summary(a, quoteOf) {
    const qOf = (e) => { const q = quoteOf && quoteOf(e); return validQ(q) ? q : a.quotes[e]; };
    let unrealised = 0, used = 0;
    const rows = Object.values(a.positions).map((p) => {
      const q = qOf(p.epic), pnl = posPnl(p, q), m = Math.abs(p.qty) * csOf(p) * (validQ(q) ? mid(q) : p.avg) * marginPctOf(a, p.epic) / 100;
      unrealised += pnl; used += m;
      return { epic: p.epic, pnl, margin: m };
    });
    const equity = a.cash + unrealised, free = equity - used, level = used > 0 ? (equity / used) * 100 : null;
    return { balance: a.cash, realised: a.cash - a.startBalance, unrealised, equity, usedMargin: used, freeMargin: free, marginLevel: level, marginCall: used > 0 && equity < used, rows, currency: a.currency };
  }

  function marginOk(a, epic, newQty, price) {
    const p = a.positions[epic], cur = p ? Math.abs(p.qty) : 0;
    if (Math.abs(newQty) <= cur + 1e-12) return true;
    const s = summary(a), q = a.quotes[epic], ref = validQ(q) ? mid(q) : price;
    const cs = p ? csOf(p) : contractOf(a, epic);
    const usedOther = s.usedMargin - cur * cs * ref * marginPctOf(a, epic) / 100;
    return usedOther + Math.abs(newQty) * cs * ref * marginPctOf(a, epic) / 100 <= s.equity + 1e-9;
  }

  function applyBracket(p, b, price) {
    if (!b) return;
    const long = p.qty > 0, dir = long ? 1 : -1;
    if (b.sl != null) p.sl = b.sl; else if (b.slDist > 0) p.sl = price - dir * b.slDist;
    if (b.tp != null) p.tp = b.tp; else if (b.tpDist > 0) p.tp = price + dir * b.tpDist;
    if (b.trail > 0) {
      p.trail = b.trail;
      const t = price - dir * b.trail;
      p.sl = p.sl == null ? t : long ? Math.max(p.sl, t) : Math.min(p.sl, t);
    }
  }

  function applyFill(a, epic, side, qty, price, t, reason, orderId, bracket) {
    const s = side === 'buy' ? 1 : -1;
    let p = a.positions[epic], remaining = qty, realised = 0;
    if (p && Math.sign(p.qty) === -s) {
      const cq = Math.min(remaining, Math.abs(p.qty)), pnl = (price - p.avg) * cq * Math.sign(p.qty) * csOf(p);
      realised += pnl; a.cash += pnl;
      a.trades.push({ id: ++a.seq, epic, dir: p.qty > 0 ? 'long' : 'short', qty: cq, entry: p.avg, exit: price, openT: p.openT, closeT: t, pnl, reason });
      p.qty = cleanQty(p.qty + cq * s); remaining = cleanQty(remaining - cq);
      if (p.qty === 0) { delete a.positions[epic]; p = null; }
    }
    if (remaining > 0) {
      if (!p) p = a.positions[epic] = { epic, qty: 0, avg: price, openT: t, sl: null, tp: null, trail: null, cs: contractOf(a, epic) };
      p.avg = (p.avg * Math.abs(p.qty) + price * remaining) / (Math.abs(p.qty) + remaining);
      p.qty = cleanQty(p.qty + remaining * s);
    }
    if (p && bracket && Math.sign(p.qty) === s) applyBracket(p, bracket, price);
    const f = { id: ++a.seq, orderId: orderId ?? null, epic, side, qty, price, t, reason, realised };
    a.fills.push(f); trim(a.fills); trim(a.trades);
    return f;
  }

  function finish(a, o, status, extra) {
    o.status = status; o.closedT = extra && extra.t; if (extra && extra.reason) o.reason = extra.reason;
    a.orders = a.orders.filter((x) => x !== o);
    a.orderLog.push(o); trim(a.orderLog);
  }

  function evalOrder(a, o, q, t, ev) {
    if (o.status !== 'working') return;
    const buy = o.side === 'buy', px = buy ? q.offer : q.bid;
    const stopHit = (lvl) => (buy ? px >= lvl : px <= lvl), limHit = (lvl) => (buy ? px <= lvl : px >= lvl);
    let hit = false;
    if (o.type === 'market') hit = true;
    else if (o.type === 'limit') hit = limHit(o.price);
    else if (o.type === 'stop') hit = stopHit(o.price);
    else if (o.type === 'stoplimit') {
      if (!o.triggered && stopHit(o.price)) { o.triggered = true; ev.push({ type: 'trigger', order: o, t }); }
      hit = !!o.triggered && limHit(o.limitPrice);
    }
    if (!hit) return;
    const cur = a.positions[o.epic] ? a.positions[o.epic].qty : 0, next = cur + (buy ? o.qty : -o.qty);
    if (!marginOk(a, o.epic, next, px)) { finish(a, o, 'rejected', { t, reason: 'Insufficient margin' }); ev.push({ type: 'reject', order: o, t }); return; }
    finish(a, o, 'filled', { t });
    ev.push({ type: 'fill', order: o, fill: applyFill(a, o.epic, o.side, o.qty, px, t, o.type, o.id, o.bracket), t });
  }

  function tick(a, epic, quote) {
    if (!validQ(quote)) return [];
    const t = toMs(quote.t), q = { bid: +quote.bid, offer: +quote.offer, t };
    a.quotes[epic] = q;
    const ev = [];
    for (const o of a.orders.slice()) if (o.epic === epic && o.tif === 'day' && utcDay(t) > utcDay(o.created)) { finish(a, o, 'expired', { t }); ev.push({ type: 'expire', order: o, t }); }
    const p = a.positions[epic];
    if (p) {
      const long = p.qty > 0, px = exitPx(p.qty, q);
      const slHit = p.sl != null && (long ? px <= p.sl : px >= p.sl), tpHit = p.tp != null && (long ? px >= p.tp : px <= p.tp);
      if (slHit || tpHit) {
        const reason = slHit ? (p.trail ? 'trail' : 'sl') : 'tp';
        ev.push({ type: 'fill', fill: applyFill(a, epic, long ? 'sell' : 'buy', Math.abs(p.qty), px, t, reason), t });
      } else if (p.trail > 0) {
        const c = long ? q.bid - p.trail : q.offer + p.trail;
        if (p.sl == null || (long ? c > p.sl : c < p.sl)) p.sl = c;
      }
    }
    for (const o of a.orders.filter((x) => x.epic === epic).sort((x, y) => x.id - y.id)) evalOrder(a, o, q, t, ev);
    return ev;
  }

  function checkBracket(side, ref, b) {
    if (!b || ref == null) return null;
    const buy = side === 'buy';
    if (b.sl != null && (buy ? b.sl >= ref : b.sl <= ref)) return `Stop loss must be ${buy ? 'below' : 'above'} ${ref}`;
    if (b.tp != null && (buy ? b.tp <= ref : b.tp >= ref)) return `Take profit must be ${buy ? 'above' : 'below'} ${ref}`;
    for (const k of ['slDist', 'tpDist', 'trail']) if (b[k] != null && !(b[k] > 0)) return 'Distances must be positive';
    return null;
  }

  function validateOrder(o, q) {
    if (!o.epic) return 'No market';
    if (o.side !== 'buy' && o.side !== 'sell') return 'Side must be buy or sell';
    if (!TYPES.includes(o.type)) return 'Unknown order type';
    if (!(o.qty > 0)) return 'Quantity must be positive';
    if (o.type !== 'market' && !(o.price > 0)) return 'Price required';
    if (o.type === 'stoplimit' && !(o.limitPrice > 0)) return 'Limit price required';
    if (o.type === 'market' && !validQ(q)) return 'No live price';
    const buy = o.side === 'buy';
    if ((o.type === 'stop' || (o.type === 'stoplimit' && !o.triggered)) && validQ(q) && (buy ? o.price <= q.offer : o.price >= q.bid))
      return `Buy stop must be above the ask / sell stop below the bid`;
    const ref = o.type === 'market' ? (buy ? q.offer : q.bid) : o.type === 'stoplimit' ? o.limitPrice : o.price;
    return checkBracket(o.side, ref, o.bracket);
  }

  function makeBracket(spec) {
    const b = { sl: num(spec.sl), tp: num(spec.tp), slDist: num(spec.slDist), tpDist: num(spec.tpDist), trail: num(spec.trail) };
    return Object.values(b).some((v) => v != null) ? b : null;
  }

  function place(a, spec, quote) {
    const q = validQ(quote) ? { bid: +quote.bid, offer: +quote.offer, t: toMs(quote.t) } : a.quotes[spec.epic];
    const o = { id: 0, epic: spec.epic, side: spec.side, type: spec.type || 'market', qty: num(spec.qty), price: num(spec.price), limitPrice: num(spec.limitPrice),
      tif: spec.tif === 'day' ? 'day' : 'gtc', created: validQ(q) ? q.t : Date.now(), status: 'working', triggered: false, bracket: makeBracket(spec) };
    if (o.type === 'market') { o.price = null; o.limitPrice = null; }
    const err = lotError(a, o.epic, o.qty) || validateOrder(o, q);
    if (err) return { ok: false, error: err, events: [] };
    o.id = ++a.seq;
    a.orders.push(o);
    const ev = [];
    if (validQ(q)) { a.quotes[o.epic] = q; evalOrder(a, o, q, q.t, ev); }
    return { ok: o.status !== 'rejected', order: o, events: ev, error: o.status === 'rejected' ? o.reason : null };
  }

  function cancel(a, id, t) {
    const o = a.orders.find((x) => x.id === id);
    if (!o) return false;
    finish(a, o, 'cancelled', { t: t ?? Date.now() });
    return true;
  }
  function cancelAll(a, epic) { for (const o of a.orders.slice()) if (!epic || o.epic === epic) cancel(a, o.id); }

  function modify(a, id, patch = {}) {
    const o = a.orders.find((x) => x.id === id);
    if (!o) return { ok: false, error: 'Order not found', events: [] };
    const n = { ...o, bracket: o.bracket ? { ...o.bracket } : null };
    for (const k of ['qty', 'price', 'limitPrice']) if (patch[k] !== undefined) n[k] = num(patch[k]);
    if (patch.tif) n.tif = patch.tif === 'day' ? 'day' : 'gtc';
    if (patch.sl !== undefined || patch.tp !== undefined) {
      n.bracket = n.bracket || {};
      if (patch.sl !== undefined) { n.bracket.sl = num(patch.sl); n.bracket.slDist = null; }
      if (patch.tp !== undefined) { n.bracket.tp = num(patch.tp); n.bracket.tpDist = null; }
    }
    const q = a.quotes[o.epic], err = lotError(a, n.epic, n.qty) || validateOrder(n, q);
    if (err) return { ok: false, error: err, events: [] };
    Object.assign(o, n);
    const ev = [];
    if (validQ(q)) evalOrder(a, o, q, q.t, ev);
    return { ok: true, order: o, events: ev };
  }

  function setProtection(a, epic, prot = {}) {
    const p = a.positions[epic];
    if (!p) return { ok: false, error: 'No position' };
    const long = p.qty > 0, q = a.quotes[epic], px = validQ(q) ? exitPx(p.qty, q) : null;
    const sl = prot.sl === undefined ? p.sl : num(prot.sl), tp = prot.tp === undefined ? p.tp : num(prot.tp), trail = prot.trail === undefined ? p.trail : num(prot.trail);
    if (trail != null && !(trail > 0)) return { ok: false, error: 'Trailing distance must be positive' };
    if (px != null) {
      if (sl != null && prot.sl !== undefined && (long ? sl >= px : sl <= px)) return { ok: false, error: `Stop loss must be ${long ? 'below the bid' : 'above the ask'}` };
      if (tp != null && prot.tp !== undefined && (long ? tp <= px : tp >= px)) return { ok: false, error: `Take profit must be ${long ? 'above the bid' : 'below the ask'}` };
    }
    p.sl = sl; p.tp = tp; p.trail = trail;
    if (trail && prot.trail !== undefined && px != null) {
      const c = long ? px - trail : px + trail;
      if (p.sl == null || (long ? c > p.sl : c < p.sl)) p.sl = c;
    }
    return { ok: true, position: p };
  }

  function close(a, epic, qty, quote, reason = 'close') {
    const p = a.positions[epic], q = validQ(quote) ? quote : a.quotes[epic];
    if (!p) return { ok: false, error: 'No position' };
    if (!validQ(q)) return { ok: false, error: 'No live price' };
    const amt = Math.min(num(qty) > 0 ? +qty : Math.abs(p.qty), Math.abs(p.qty)), t = toMs(q.t);
    a.quotes[epic] = { bid: q.bid, offer: q.offer, t };
    return { ok: true, fill: applyFill(a, epic, p.qty > 0 ? 'sell' : 'buy', amt, exitPx(p.qty, q), t, reason) };
  }

  function reverse(a, epic, quote) {
    const p = a.positions[epic], q = validQ(quote) ? quote : a.quotes[epic];
    if (!p) return { ok: false, error: 'No position' };
    if (!validQ(q)) return { ok: false, error: 'No live price' };
    const px = exitPx(p.qty, q), t = toMs(q.t);
    if (!marginOk(a, epic, -p.qty, px)) return { ok: false, error: 'Insufficient margin' };
    a.quotes[epic] = { bid: q.bid, offer: q.offer, t };
    return { ok: true, fill: applyFill(a, epic, p.qty > 0 ? 'sell' : 'buy', Math.abs(p.qty) * 2, px, t, 'reverse') };
  }

  function closeAll(a, quoteOf) {
    const out = [];
    for (const epic of Object.keys(a.positions)) out.push({ epic, ...close(a, epic, null, quoteOf && quoteOf(epic), 'closeall') });
    return out;
  }

  // ── Bar replay: evaluate a whole OHLC bar ─────────────────
  // Chart bars are on the chart's price side (mid / bid / ask); the spread rebuilds the other side.
  // The intrabar path is O→L→H→C for an up bar and O→H→L→C for a down bar. Every order / SL / TP level the
  // path crosses is ticked exactly at that level, so fills land on the level (or on the open after a gap).
  function bookLevels(a, epic) {
    const out = [];
    for (const o of a.orders) if (o.epic === epic && o.status === 'working') {
      const k = o.side === 'buy' ? 'offer' : 'bid';
      if (o.type === 'limit' || o.type === 'stop') out.push([k, o.price]);
      else if (o.type === 'stoplimit') { if (!o.triggered) out.push([k, o.price]); out.push([k, o.limitPrice]); }
    }
    const p = a.positions[epic];
    if (p) { const k = p.qty > 0 ? 'bid' : 'offer'; if (p.sl != null) out.push([k, p.sl]); if (p.tp != null) out.push([k, p.tp]); }
    return out.filter(([, l]) => Number.isFinite(l));
  }
  const sideOff = (s, side) => (side === 'bid' ? s : side === 'ask' ? 0 : s / 2);
  function barQuote(price, spread = 0, side = 'mid', t) {
    const s = Math.max(0, num(spread) || 0), off = sideOff(s, side);
    return { bid: price - (s - off), offer: price + off, t };
  }
  function tickBar(a, epic, bar, opt = {}) {
    const O = +bar.open, H = +bar.high, L = +bar.low, C = +bar.close;
    if (![O, H, L, C].every(Number.isFinite)) return [];
    const s = Math.max(0, num(opt.spread) || 0), side = opt.side || 'mid', off = sideOff(s, side), t = toMs(opt.t ?? bar.time);
    const path = C >= O ? [O, L, H, C] : [O, H, L, C], ev = [];
    ev.push(...tick(a, epic, barQuote(O, s, side, t)));
    for (let i = 1; i < path.length; i++) {
      let cur = path[i - 1];
      const end = path[i], dir = Math.sign(end - cur);
      if (!dir) continue;
      for (let guard = 0; guard < 64; guard++) {
        let best = null;
        for (const [k, lvl] of bookLevels(a, epic)) {
          const p = k === 'offer' ? lvl - off : lvl + (s - off), eps = 1e-9 * Math.max(1, Math.abs(p));
          const inside = dir > 0 ? p > cur + eps && p < end - eps : p < cur - eps && p > end + eps;
          if (inside && (!best || (dir > 0 ? p < best.p : p > best.p))) best = { p, k, lvl };
        }
        if (!best) break;
        ev.push(...tick(a, epic, best.k === 'offer' ? { bid: best.lvl - s, offer: best.lvl, t } : { bid: best.lvl, offer: best.lvl + s, t }));
        cur = best.p;
      }
      ev.push(...tick(a, epic, barQuote(end, s, side, t)));
    }
    return ev;
  }
  // Session results: closed trades plus an equity series (one point per replayed bar close).
  function stats(trades, curve, startBalance) {
    const n = trades.length, wins = trades.filter((r) => r.pnl > 0), losses = trades.filter((r) => r.pnl < 0);
    const sum = (xs) => xs.reduce((x, r) => x + r.pnl, 0), gp = sum(wins), gl = -sum(losses);
    let peak = -Infinity, dd = 0, ddPct = 0;
    for (const e of curve) { if (e > peak) peak = e; const d = peak - e; if (d > dd) { dd = d; ddPct = peak > 0 ? (d / peak) * 100 : 0; } }
    const start = num(startBalance) ?? (curve.length ? curve[0] : 0), endEq = curve.length ? curve[curve.length - 1] : start;
    return { trades: n, wins: wins.length, losses: losses.length, winRate: n ? (wins.length / n) * 100 : null, net: gp - gl, grossProfit: gp, grossLoss: gl,
      profitFactor: gl > 0 ? gp / gl : gp > 0 ? Infinity : null, avgWin: wins.length ? gp / wins.length : null, avgLoss: losses.length ? -gl / losses.length : null,
      largestWin: wins.length ? Math.max(...wins.map((r) => r.pnl)) : null, largestLoss: losses.length ? Math.min(...losses.map((r) => r.pnl)) : null,
      maxDD: dd, maxDDPct: ddPct, startEquity: start, endEquity: endEq, returnPct: start ? ((endEq - start) / start) * 100 : null };
  }

  const csvCell = (v) => { const s = v == null ? '' : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  const iso = (ms) => (ms ? new Date(ms).toISOString() : '');
  function csv(a, kind = 'trades') {
    const rows = kind === 'fills'
      ? [['time', 'epic', 'side', 'qty', 'price', 'reason', 'order_id', 'realised_pnl', 'currency'],
        ...a.fills.map((f) => [iso(f.t), f.epic, f.side, f.qty, f.price, REASON[f.reason] || f.reason, f.orderId, f.realised.toFixed(2), a.currency])]
      : [['opened', 'closed', 'epic', 'direction', 'qty', 'entry', 'exit', 'points', 'pnl', 'reason', 'currency'],
        ...a.trades.map((r) => [iso(r.openT), iso(r.closeT), r.epic, r.dir, r.qty, r.entry, r.exit, ((r.exit - r.entry) * (r.dir === 'long' ? 1 : -1)), r.pnl.toFixed(2), REASON[r.reason] || r.reason, a.currency])];
    return rows.map((r) => r.map(csvCell).join(',')).join('\n') + '\n';
  }

  // ── UI ────────────────────────────────────────────────────
  const CSS = `
.igp { display: flex; flex-direction: column; height: 100%; min-height: 0; background: var(--panel); color: var(--text); font-size: 12px; outline: none; font-variant-numeric: tabular-nums; }
.igp:focus-within, .igp:focus { box-shadow: inset 0 0 0 1px var(--accent-soft); }
.igp button { background: var(--panel-2); border: 1px solid var(--line); color: var(--text); border-radius: 4px; padding: 3px 8px; cursor: pointer; font: inherit; }
.igp button:hover { background: var(--hover); }
.igp input, .igp select { background: var(--bg); color: var(--text); border: 1px solid var(--line); border-radius: 4px; padding: 4px 6px; font: inherit; min-width: 0; width: 100%; }
.igp input:focus, .igp select:focus { border-color: var(--accent); outline: none; }
.igp-sum { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 16px; padding: 6px 10px; border-bottom: 1px solid var(--line); background: var(--panel-2); }
.igp-sum .k { color: var(--muted); margin-right: 5px; }
.igp-sim { background: var(--accent-soft); color: var(--accent); font-weight: 700; font-size: 10.5px; letter-spacing: .5px; padding: 2px 7px; border-radius: 10px; }
.igp-mc { background: var(--down); color: #fff; font-weight: 700; padding: 2px 8px; border-radius: 10px; }
.igp-body { flex: 1; min-height: 0; display: grid; grid-template-columns: 250px minmax(0, 1fr) 256px; grid-template-rows: minmax(0, 1fr); }
.igp-ticket { border-right: 1px solid var(--line); padding: 8px 10px; overflow: auto; display: flex; flex-direction: column; gap: 7px; }
.igp-sym { display: flex; justify-content: space-between; align-items: baseline; gap: 6px; }
.igp-sym b { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.igp-bs { display: grid; grid-template-columns: 1fr auto 1fr; gap: 4px; align-items: stretch; }
.igp .igp-sell, .igp .igp-buy { border: 0; color: #fff; padding: 6px 4px; border-radius: 5px; display: flex; flex-direction: column; align-items: center; line-height: 1.2; }
.igp .igp-sell { background: var(--down); } .igp .igp-buy { background: var(--up); }
.igp .igp-sell:hover, .igp .igp-buy:hover { filter: brightness(1.12); background: var(--down); }
.igp .igp-buy:hover { background: var(--up); }
.igp-sell small, .igp-buy small { font-size: 10px; opacity: .9; text-transform: uppercase; letter-spacing: .4px; }
.igp-sell b, .igp-buy b { font-size: 15px; }
.igp-spr { align-self: center; color: var(--muted); font-size: 11px; min-width: 28px; text-align: center; }
.igp-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 6px 8px; }
.igp-grid label { display: flex; flex-direction: column; gap: 2px; color: var(--muted); font-size: 11px; }
.igp-grid label.full { grid-column: 1 / -1; }
.igp-hint { color: var(--muted); font-size: 11px; }
.igp-msg { color: var(--down); font-size: 11px; min-height: 14px; }
.igp-main { display: flex; flex-direction: column; min-width: 0; min-height: 0; }
.igp-tabs { display: flex; align-items: center; gap: 2px; padding: 4px 8px 0; border-bottom: 1px solid var(--line); }
.igp .igp-tabs button.tab { background: none; border: 0; border-bottom: 2px solid transparent; border-radius: 0; padding: 6px 10px; color: var(--muted); }
.igp .igp-tabs button.tab.on { color: var(--text); border-bottom-color: var(--accent); }
.igp-tabs .sp { flex: 1; }
.igp-tabbody { flex: 1; min-height: 0; overflow: auto; }
.igp table { width: 100%; border-collapse: collapse; }
.igp th { position: sticky; top: 0; background: var(--panel); color: var(--muted); font-weight: 500; text-align: right; padding: 5px 8px; border-bottom: 1px solid var(--line); white-space: nowrap; z-index: 1; }
.igp td { text-align: right; padding: 4px 8px; border-bottom: 1px solid var(--line); white-space: nowrap; }
.igp th:first-child, .igp td:first-child { text-align: left; }
.igp td.act, .igp th.act { position: sticky; right: 0; background: var(--panel); z-index: 1; box-shadow: -6px 0 6px -6px rgba(0,0,0,.5); }
.igp th.act { z-index: 2; }
.igp td.act > div { display: flex; gap: 4px; justify-content: flex-end; align-items: center; }
.igp td.act input { width: 56px; }
.igp td input { width: 84px; padding: 2px 4px; }
.igp tr:hover td { background: var(--hover); }
.igp td.act button { padding: 2px 7px; }
.igp-empty { color: var(--muted); padding: 18px; text-align: center; }
.igp-sec { padding: 6px 8px 2px; color: var(--muted); font-weight: 600; display: flex; justify-content: space-between; align-items: center; }
.igp-acct { display: grid; grid-template-columns: repeat(auto-fill, minmax(190px, 1fr)); gap: 10px; padding: 10px; }
.igp-acct label { display: flex; flex-direction: column; gap: 3px; color: var(--muted); font-size: 11px; }
.igp-acct .row { display: flex; gap: 6px; }
.igp-rp { background: rgba(255,152,0,.18); color: #ff9800; }
.igp-rstats { display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: 8px 14px; padding: 6px 10px 10px; }
.igp-rstats > div { display: flex; flex-direction: column; gap: 2px; } .igp-rstats .k { color: var(--muted); font-size: 11px; }
.igp-rmodal { height: auto; min-width: min(560px, 80vw); background: transparent; }
.igp-acct label.igp-chk { justify-content: flex-end; } .igp-acct label.igp-chk input { width: auto; margin-right: 6px; vertical-align: middle; }
.igp-body.noladder { grid-template-columns: 250px minmax(0, 1fr); } .igp-body.noladder .igp-ladder { display: none; }
.igp-ladbtn.on, .igp-fillbtn.on { color: var(--accent); }
.igp-float { font-size: 18px; font-weight: 700; font-variant-numeric: tabular-nums; margin: 0 6px; }
.gain { color: #2962ff !important; } .loss { color: #ef5350 !important; }
.igp-type { font-weight: 600; } .igp-type.buy { color: #2962ff; } .igp-type.sell { color: #ef5350; }
.igp-oc { white-space: nowrap; color: var(--muted); } .igp-oc span { color: var(--text); }
.igp-profit { font-size: 14px; font-weight: 700; font-variant-numeric: tabular-nums; white-space: nowrap; }
.igp-delta { font-size: 11px; white-space: nowrap; }
.igp-pos tfoot td { border-top: 1px solid var(--line); font-weight: 600; padding-top: 6px; }
.igp-ladder { border-left: 1px solid var(--line); display: flex; flex-direction: column; min-height: 0; }
.igp-lhead { display: flex; align-items: center; gap: 6px; padding: 6px 8px; border-bottom: 1px solid var(--line); color: var(--muted); font-size: 11px; }
.igp-lhead span { flex: 1; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.igp-lhead span b { color: var(--text); font-weight: 600; }
.igp-lhead select { width: 58px; flex: none; padding: 1px 3px; }
.igp-lcols .ctr { cursor: pointer; } .igp-lcols .ctr:hover { color: var(--text); }
.igp-lcols, .igp-lrow { display: grid; grid-template-columns: 1fr 1.1fr 1fr; }
.igp-lcols span { text-align: center; color: var(--muted); font-size: 10.5px; padding: 3px 0; border-bottom: 1px solid var(--line); }
.igp-lrows { flex: 1; min-height: 0; overflow: hidden; user-select: none; }
.igp-lrow { height: 19px; line-height: 19px; border-bottom: 1px solid var(--line); }
.igp-lrow > div { text-align: center; overflow: hidden; white-space: nowrap; }
.igp-lrow .b, .igp-lrow .s { cursor: pointer; }
.igp-lrow .b:hover { background: rgba(38,166,154,.18); } .igp-lrow .s:hover { background: rgba(239,83,80,.18); }
.igp-lrow .p { color: var(--muted); border-left: 1px solid var(--line); border-right: 1px solid var(--line); }
.igp-lrow.spread .p { background: var(--panel-2); }
.igp-lrow.ask .p { color: var(--up); font-weight: 700; } .igp-lrow.bid .p { color: var(--down); font-weight: 700; }
.igp-lrow.ask .b { background: rgba(38,166,154,.12); } .igp-lrow.bid .s { background: rgba(239,83,80,.12); }
.igp-lrow.pos .p { background: var(--accent-soft); color: var(--text); font-weight: 700; }
.igp-chip { display: inline-block; padding: 0 5px; border-radius: 3px; font-size: 10.5px; line-height: 15px; color: #fff; cursor: pointer; }
.igp-chip.buy { background: var(--up); } .igp-chip.sell { background: var(--down); } .igp-chip.prot { background: var(--accent); }
.igp-lfoot { padding: 4px 8px; color: var(--muted); font-size: 10.5px; border-top: 1px solid var(--line); }
.igp-vol { display: flex; gap: 3px; } .igp-vol input { flex: 1; min-width: 0; text-align: center; } .igp-vol button { width: 26px; border: 1px solid var(--line); background: var(--bg); color: var(--text); border-radius: 4px; cursor: pointer; }
.igp-lotinfo { font-size: 11px; color: var(--muted); padding: 4px 0 0; line-height: 1.4; font-variant-numeric: tabular-nums; }
.igp-spec { grid-column: 1 / -1; border-top: 1px solid var(--line); padding-top: 8px; } .igp-spec-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: 6px 10px; margin: 6px 0; }
@media (max-width: 900px) { .igp-body { grid-template-columns: 1fr; grid-auto-rows: auto; overflow: auto; } .igp-ticket, .igp-ladder { border: 0; border-bottom: 1px solid var(--line); } .igp-lrows { height: 300px; flex: none; } }
`;

  function mount(el, host) {
    if (!document.getElementById('igp-style')) {
      const s = document.createElement('style'); s.id = 'igp-style'; s.textContent = CSS; document.head.appendChild(s);
    }
    const live = normalize(host.store.get(KEY, null));
    let acct = live; // the account the UI acts on: the live paper account, or the replay account while the active chart replays
    const tk = Object.assign({ qty: 0.1, type: 'market', price: '', limitPrice: '', tif: 'gtc', mode: 'dist', sl: '', tp: '', trail: '' }, host.store.get(TKEY, {}) || {});
    const ui = { tab: 'positions', edit: null, sig: '', step: 0, center: null, centerEpic: null, timer: null, last: 0, msgTimer: null, dead: false };
    const save = () => (acct === live ? host.store.set(KEY, live) : saveReplay());
    const saveTk = () => host.store.set(TKEY, tk);
    const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    const act = () => host.active() || {};
    const dec = () => { const d = act().decimals; return Number.isFinite(d) ? d : 2; };
    const quoteOf = (e) => { if (acct !== live) return acct.quotes[e]; const q = host.quote && host.quote(e); return validQ(q) ? q : acct.quotes[e]; };
    const nameOf = (e) => (host.name && host.name(e)) || e;
    const fp = (v) => (v == null || !Number.isFinite(v) ? '—' : host.fmt(v));
    const money = (v, sign) => (v == null || !Number.isFinite(v) ? '—' : (sign && v > 0 ? '+' : v < 0 ? '-' : '') + Math.abs(v).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
    const cls = (v) => (v > 0 ? 'up' : v < 0 ? 'down' : '');
    const roundP = (p) => { const d = dec(); return Math.round(p * 10 ** d) / 10 ** d; };

    el.innerHTML = `<div class="igp" tabindex="0">
      <div class="igp-sum"></div>
      <div class="igp-body">
        <div class="igp-ticket">
          <div class="igp-sym"><b data-r="name"></b><span class="muted" data-r="epic"></span></div>
          <div class="igp-bs">
            <button class="igp-sell" data-a="sell" title="Sell (Shift+S for market)"><small data-r="sellLbl">Sell</small><b data-r="bid">—</b></button>
            <span class="igp-spr" data-r="spr"></span>
            <button class="igp-buy" data-a="buy" title="Buy (Shift+B for market)"><small data-r="buyLbl">Buy</small><b data-r="offer">—</b></button>
          </div>
          <div class="igp-grid">
            <label>Volume (lots)<div class="igp-vol"><button type="button" data-a="lotDn" title="− one lot step">−</button><input data-t="qty" type="number" min="0" step="any"><button type="button" data-a="lotUp" title="+ one lot step">+</button></div></label>
            <label>Order type<select data-t="type"><option value="market">Market</option><option value="limit">Limit</option><option value="stop">Stop</option><option value="stoplimit">Stop-limit</option></select></label>
            <label data-show="price">Price<input data-t="price" type="number" step="any"></label>
            <label data-show="limit">Limit price<input data-t="limitPrice" type="number" step="any"></label>
            <label data-show="tif">Time in force<select data-t="tif"><option value="gtc">GTC</option><option value="day">Day (UTC)</option></select></label>
            <label class="full">Bracket (stop loss / take profit) in<select data-t="mode"><option value="dist">Distance</option><option value="price">Price</option></select></label>
            <label>Stop loss<input data-t="sl" type="number" step="any" min="0"></label>
            <label>Take profit<input data-t="tp" type="number" step="any" min="0"></label>
            <label class="full">Trailing stop distance<input data-t="trail" type="number" step="any" min="0" placeholder="off"></label>
          </div>
          <div class="igp-lotinfo" data-r="lotinfo"></div>
          <div class="igp-msg" data-r="msg"></div>
          <div class="igp-hint" data-r="hint"></div>
        </div>
        <div class="igp-main">
          <div class="igp-tabs">
            <button class="tab" data-tab="positions">Positions</button><button class="tab" data-tab="orders">Orders</button>
            <button class="tab" data-tab="history">History</button><button class="tab" data-tab="account">Account</button><button class="tab" data-tab="replay" title="Paper trading against Bar Replay">Replay</button>
            <span class="sp"></span><button data-a="cancelAll">Cancel all</button><button data-a="closeAll">Close all</button><button data-a="fills" class="igp-fillbtn" title="Show / hide buy and sell fill markers on the chart">Fills on chart</button><button data-a="ladder" class="igp-ladbtn" title="Show / hide the price ladder">Ladder</button>
          </div>
          <div class="igp-tabbody"></div>
        </div>
        <div class="igp-ladder">
          <div class="igp-lhead"><span title="IG provides no market depth, so no size-at-price columns"><b>Price ladder</b> (no depth data)</span>
            <select data-r="step" title="Ticks per row"><option value="0">auto</option><option value="1">1×</option><option value="2">2×</option><option value="5">5×</option><option value="10">10×</option><option value="25">25×</option><option value="100">100×</option></select>
</div>
          <div class="igp-lcols"><span>Buy</span><span class="ctr" data-a="center" title="Re-center on the market">Price ⌖</span><span>Sell</span></div>
          <div class="igp-lrows"></div>
          <div class="igp-lfoot">Click Buy/Sell cell: limit on the passive side, stop beyond the market. Click a chip to cancel.</div>
        </div>
      </div></div>`;
    const root = el.firstElementChild, $r = (k) => root.querySelector(`[data-r="${k}"]`);
    const sumEl = root.querySelector('.igp-sum'), body = root.querySelector('.igp-tabbody'), rowsEl = root.querySelector('.igp-lrows');

    const msg = (text, ok) => {
      const m = $r('msg'); m.textContent = text || ''; m.style.color = ok ? 'var(--up)' : 'var(--down)';
      clearTimeout(ui.msgTimer); if (text) ui.msgTimer = setTimeout(() => { m.textContent = ''; }, 4000);
    };
    const describeFill = (f) => `Paper ${f.side.toUpperCase()} ${f.qty} ${nameOf(f.epic)} @ ${fp(f.price)} (${REASON[f.reason] || f.reason})${f.realised ? ` · P&L ${money(f.realised, true)}` : ''}`;
    const report = (events) => {
      for (const e of events || []) {
        if (e.type === 'fill') host.notify(describeFill(e.fill));
        else if (e.type === 'reject') host.notify(`Paper order #${e.order.id} rejected: ${e.order.reason}`);
        else if (e.type === 'expire') host.notify(`Paper order #${e.order.id} expired (day)`);
        else if (e.type === 'trigger') host.notify(`Paper stop-limit #${e.order.id} triggered`);
      }
    };
    const done = (res, okText) => {
      if (!res || res.ok === false) { msg(res && res.error ? res.error : 'Rejected'); renderOverlay(); return false; }
      if (okText) msg(okText, true);
      report(res.events); if (res.fill) host.notify(describeFill(res.fill));
      save(); refresh(true); return true;
    };

    // Ticket
    const tkInputs = root.querySelectorAll('[data-t]');
    for (const inp of tkInputs) {
      inp.value = tk[inp.dataset.t] ?? '';
      inp.addEventListener('input', () => {
        tk[inp.dataset.t] = inp.value; saveTk();
        if (inp.dataset.t === 'type') { prefillPrice(); syncTicket(); }
        if (inp.dataset.t === 'type' || inp.dataset.t === 'price') updateButtons();
        if (inp.dataset.t === 'qty') lotInfo();
      });
    }
    function prefillPrice() {
      const q = quoteOf(act().epic);
      if (tk.type !== 'market' && validQ(q) && !num(tk.price)) {
        tk.price = String(roundP(mid(q))); root.querySelector('[data-t="price"]').value = tk.price;
        if (tk.type === 'stoplimit' && !num(tk.limitPrice)) { tk.limitPrice = tk.price; root.querySelector('[data-t="limitPrice"]').value = tk.price; }
        saveTk();
      }
    }
    function syncTicket() {
      root.querySelector('[data-show="price"]').style.display = tk.type === 'market' ? 'none' : '';
      root.querySelector('[data-show="limit"]').style.display = tk.type === 'stoplimit' ? '' : 'none';
      root.querySelector('[data-show="tif"]').style.display = tk.type === 'market' ? 'none' : '';
    }
    function ticketSpec(side, over = {}) {
      const s = { epic: act().epic, side, type: tk.type, qty: num(tk.qty), price: num(tk.price), limitPrice: num(tk.limitPrice), tif: tk.tif, trail: num(tk.trail), ...over };
      if (over.type === 'market') { s.price = null; s.limitPrice = null; }
      if (tk.mode === 'price') { if (!over.noPriceBracket) { s.sl = num(tk.sl); s.tp = num(tk.tp); } }
      else { s.slDist = num(tk.sl); s.tpDist = num(tk.tp); }
      return s;
    }
    const submit = (spec) => {
      if (!spec.epic) return msg('No active market');
      const r = place(acct, spec, quoteOf(spec.epic));
      done(r, r.ok && r.order && r.order.status === 'working' ? `Order #${r.order.id} working` : null);
    };
    // MT5-style size readout: units, required margin at the current price, and money per 1.0 price move
    function lotInfo() {
      const e = act().epic, el2 = $r('lotinfo'); if (!el2) return;
      if (!e) { el2.textContent = ''; return; }
      const sp = specOf(acct, e), lots = num(tk.qty) || 0, q = quoteOf(e), px = validQ(q) ? mid(q) : null;
      const units = lots * sp.contract, margin = px ? units * px / sp.leverage : null, perPt = units;
      const err = lots ? lotError(acct, e, lots) : null;
      el2.innerHTML = err ? `<span class="down">${esc(err)}</span>` : `${lots} lot${lots === 1 ? '' : 's'} = ${units.toLocaleString()} units · margin ≈ ${money(margin)} ${esc(acct.currency)} @ 1:${sp.leverage} · 1.0 move = ${money(perPt)} ${esc(acct.currency)}`;
      const qi = root.querySelector('[data-t="qty"]'); qi.step = sp.lotStep; qi.min = sp.minLot; qi.max = sp.maxLot;
    }
    function stepLots(dir) {
      const sp = specOf(acct, act().epic), cur = num(tk.qty) || 0;
      const k = Math.round(cur / sp.lotStep) + dir, v = Math.min(sp.maxLot, Math.max(sp.minLot, k * sp.lotStep));
      tk.qty = String(Math.round(v * 1e8) / 1e8); root.querySelector('[data-t="qty"]').value = tk.qty; saveTk(); lotInfo();
    }
    function applyLadder() {
      root.querySelector('.igp-body').classList.toggle('noladder', !!tk.noLadder);
      const fb = root.querySelector('.igp-fillbtn'); if (fb) fb.classList.toggle('on', !!tk.showFills);
      const b = root.querySelector('.igp-ladbtn'); if (b) { b.classList.toggle('on', !tk.noLadder); b.textContent = tk.noLadder ? 'Ladder ▸' : 'Ladder ◂'; }
      if (!tk.noLadder) renderLadder();
    }
    function updateButtons() {
      const lbl = tk.type === 'market' ? '' : ` ${TYPE_LABEL[tk.type]}`;
      $r('buyLbl').textContent = `Buy${lbl}`; $r('sellLbl').textContent = `Sell${lbl}`;
    }

    // Tabs
    root.querySelector('.igp-tabs').addEventListener('click', (e) => {
      const b = e.target.closest('button'); if (!b) return;
      if (b.dataset.tab) { ui.tab = b.dataset.tab; ui.edit = null; refresh(true); }
    });
    function sigOf() {
      const a = act();
      return JSON.stringify([ui.tab, ui.edit, a.epic, acct === live ? 'live' : 'replay', ui.tab === 'replay' ? [rs.results.length, rs.session && rs.session.idx] : 0, acct.seq, acct.currency, acct.cash, acct.leverage, JSON.stringify(acct.specs[a.epic] || {}),
        Object.values(acct.positions).map((p) => [p.epic, p.qty, p.avg, p.sl, p.tp, p.trail]), acct.orders.map((o) => [o.id, o.triggered])]);
    }
    function renderTab() {
      const t = ui.tab;
      for (const b of root.querySelectorAll('.igp-tabs .tab')) b.classList.toggle('on', b.dataset.tab === t);
      if (t === 'positions') {
        const ps = Object.values(acct.positions);
        body.innerHTML = !ps.length ? '<div class="igp-empty">No open positions</div>' : `<table class="igp-pos"><thead><tr><th>Market</th><th>Type</th><th>Profit</th><th>Open → Current</th><th>Δ</th><th>Stop loss</th><th>Take profit</th><th>Trail</th><th>Margin</th><th class="act"></th></tr></thead><tbody>${ps.map((p) => {
          const ed = ui.edit === 'p:' + p.epic;
          return `<tr data-epic="${esc(p.epic)}"><td title="${esc(p.epic)}">${esc(nameOf(p.epic))}</td><td class="igp-type ${p.qty > 0 ? 'buy' : 'sell'}">${p.qty > 0 ? 'buy' : 'sell'} ${Math.abs(p.qty)}</td><td data-live="pnl" class="igp-profit"></td><td class="igp-oc">${fp(p.avg)} → <span data-live="last"></span></td><td data-live="delta" class="igp-delta"></td>
          ${ed ? `<td><input data-f="sl" type="number" step="any" value="${p.sl ?? ''}"></td><td><input data-f="tp" type="number" step="any" value="${p.tp ?? ''}"></td><td><input data-f="trail" type="number" step="any" min="0" value="${p.trail ?? ''}" placeholder="off"></td>`
            : `<td>${fp(p.sl)}</td><td>${fp(p.tp)}</td><td>${p.trail ? fp(p.trail) : '—'}</td>`}
          <td data-live="margin"></td><td class="act"><div>${ed ? '<button data-a="pSave">Save</button><button data-a="pEditX">Cancel</button>'
            : `<input data-f="cq" type="number" min="0" step="any" value="${Math.abs(p.qty)}" step="${specOf(acct, p.epic).lotStep}" title="Lots to close"><button data-a="pClose">Close</button><button data-a="pRev">Reverse</button><button data-a="pEdit">SL/TP</button>`}</div></td></tr>`;
        }).join('')}</tbody><tfoot><tr><td colspan="2">Floating P&amp;L</td><td data-live="total" class="igp-profit"></td><td colspan="7"></td></tr></tfoot></table>`;
      } else if (t === 'orders') {
        const os = acct.orders.slice().sort((x, y) => x.id - y.id);
        body.innerHTML = !os.length ? '<div class="igp-empty">No working orders</div>' : `<table><thead><tr><th>#</th><th>Market</th><th>Side</th><th>Type</th><th>Qty</th><th>Price</th><th>Limit</th><th>TIF</th><th>Bracket</th><th>Placed</th><th class="act"></th></tr></thead><tbody>${os.map((o) => {
          const ed = ui.edit === 'o:' + o.id, b = o.bracket || {};
          const br = [b.sl != null ? `SL ${fp(b.sl)}` : b.slDist ? `SL −${b.slDist}` : '', b.tp != null ? `TP ${fp(b.tp)}` : b.tpDist ? `TP +${b.tpDist}` : '', b.trail ? `Trail ${b.trail}` : ''].filter(Boolean).join(' · ') || '—';
          return `<tr data-id="${o.id}"><td>${o.id}</td><td title="${esc(o.epic)}">${esc(nameOf(o.epic))}</td><td class="${o.side === 'buy' ? 'up' : 'down'}">${o.side === 'buy' ? 'Buy' : 'Sell'}</td><td>${TYPE_LABEL[o.type]}${o.triggered ? ' (triggered)' : ''}</td>
          ${ed ? `<td><input data-f="qty" type="number" step="any" value="${o.qty}"></td><td><input data-f="price" type="number" step="any" value="${o.price ?? ''}"></td><td>${o.type === 'stoplimit' ? `<input data-f="limitPrice" type="number" step="any" value="${o.limitPrice ?? ''}">` : '—'}</td>`
            : `<td>${o.qty}</td><td>${fp(o.price)}</td><td>${o.type === 'stoplimit' ? fp(o.limitPrice) : '—'}</td>`}
          <td>${o.tif === 'day' ? 'Day' : 'GTC'}</td><td>${br}</td><td>${esc(host.fmtTime(Math.floor(o.created / 1000)))}</td>
          <td class="act"><div>${ed ? '<button data-a="oSave">Save</button><button data-a="oEditX">Cancel</button>' : '<button data-a="oEdit">Modify</button><button data-a="oCancel">Cancel</button>'}</div></td></tr>`;
        }).join('')}</tbody></table>`;
      } else if (t === 'history') {
        const tr = acct.trades.slice(-200).reverse(), fl = acct.fills.slice(-200).reverse(), ol = acct.orderLog.filter((o) => o.status !== 'filled').slice(-50).reverse();
        const tm = (ms) => esc(host.fmtTime(Math.floor(ms / 1000)));
        body.innerHTML = `<div class="igp-sec"><span>Closed trades (${acct.trades.length})</span><span><button data-a="csvTrades">Export trades CSV</button> <button data-a="csvFills">Export fills CSV</button></span></div>
          ${tr.length ? `<table><thead><tr><th>Closed</th><th>Market</th><th>Dir</th><th>Qty</th><th>Entry</th><th>Exit</th><th>P&amp;L</th><th>Exit reason</th></tr></thead><tbody>${tr.map((r) => `<tr><td>${tm(r.closeT)}</td><td>${esc(nameOf(r.epic))}</td><td class="${r.dir === 'long' ? 'up' : 'down'}">${r.dir}</td><td>${r.qty}</td><td>${fp(r.entry)}</td><td>${fp(r.exit)}</td><td class="${cls(r.pnl)}">${money(r.pnl, true)}</td><td>${REASON[r.reason] || r.reason}</td></tr>`).join('')}</tbody></table>` : '<div class="igp-empty">No closed trades</div>'}
          <div class="igp-sec"><span>Fills (${acct.fills.length})</span></div>
          ${fl.length ? `<table><thead><tr><th>Time</th><th>Market</th><th>Side</th><th>Qty</th><th>Price</th><th>Reason</th><th>Realised</th></tr></thead><tbody>${fl.map((f) => `<tr><td>${tm(f.t)}</td><td>${esc(nameOf(f.epic))}</td><td class="${f.side === 'buy' ? 'up' : 'down'}">${f.side}</td><td>${f.qty}</td><td>${fp(f.price)}</td><td>${REASON[f.reason] || f.reason}</td><td class="${cls(f.realised)}">${f.realised ? money(f.realised, true) : ''}</td></tr>`).join('')}</tbody></table>` : '<div class="igp-empty">No fills</div>'}
          ${ol.length ? `<div class="igp-sec"><span>Cancelled / expired / rejected orders</span></div><table><thead><tr><th>#</th><th>Market</th><th>Side</th><th>Type</th><th>Qty</th><th>Price</th><th>Status</th></tr></thead><tbody>${ol.map((o) => `<tr><td>${o.id}</td><td>${esc(nameOf(o.epic))}</td><td>${o.side}</td><td>${TYPE_LABEL[o.type]}</td><td>${o.qty}</td><td>${fp(o.price)}</td><td>${o.status}${o.reason ? ': ' + esc(o.reason) : ''}</td></tr>`).join('')}</tbody></table>` : ''}`;
      } else if (t === 'replay') {
        body.innerHTML = renderReplayTab();
      } else {
        const a = act(), sp = specOf(acct, a.epic);
        body.innerHTML = `<div class="igp-acct">
          <label>Starting balance<div class="row"><input data-f="bal" type="number" min="0" step="any" value="${acct.startBalance}"><button data-a="reset" title="Clear positions, orders and history">Reset</button></div></label>
          <label>Currency label<input data-f="cur" value="${esc(acct.currency)}" maxlength="8"></label>
          <label>Account leverage<select data-f="lev">${LEVS.map((l) => `<option value="${l}" ${+acct.leverage === l ? 'selected' : ''}>1:${l}</option>`).join('')}${LEVS.includes(+acct.leverage) ? '' : `<option selected value="${acct.leverage}">1:${acct.leverage}</option>`}</select></label>
          <div class="igp-spec full"><b>Symbol specification — ${esc(nameOf(a.epic) || '—')}</b>
            <div class="igp-spec-grid">
              <label>Contract size (units per lot)<input data-f="cs" type="number" min="0" step="any" value="${sp.custom.contract ?? ''}" placeholder="auto: ${autoContract(a.epic)}"></label>
              <label>Min lot<input data-f="minl" type="number" min="0" step="any" value="${sp.custom.minLot ?? ''}" placeholder="0.01"></label>
              <label>Lot step<input data-f="stepl" type="number" min="0" step="any" value="${sp.custom.lotStep ?? ''}" placeholder="0.01"></label>
              <label>Max lot<input data-f="maxl" type="number" min="0" step="any" value="${sp.custom.maxLot ?? ''}" placeholder="100"></label>
              <label>Leverage for this symbol<select data-f="slev"><option value="">Account (1:${acct.leverage})</option>${LEVS.map((l) => `<option value="${l}" ${sp.custom.leverage === l ? 'selected' : ''}>1:${l}</option>`).join('')}</select></label>
            </div>
            <small class="muted">Margin = lots × contract size × price ÷ leverage. P&amp;L = price move × lots × contract size. Open positions keep the contract size they were opened with.</small>
          </div>
          <label>&nbsp;<button data-a="saveAcct">Apply settings</button></label>
          <label>Journal<div class="row"><button data-a="csvTrades">Trades CSV</button><button data-a="csvFills">Fills CSV</button></div></label>
        </div><div class="igp-hint" style="padding:0 10px 10px">Amounts are in the account currency label (no FX conversion). Margin call warning when equity falls below used margin. The account syncs to the server with the rest of your workspace.</div>`;
      }
      ui.sig = sigOf();
    }
    function renderLive() {
      if (ui.tab !== 'positions') return;
      const tot = body.querySelector('[data-live="total"]');
      if (tot) { const s0 = summary(acct, quoteOf); tot.textContent = `${money(s0.unrealised, true)} ${acct.currency}`; tot.className = 'igp-profit ' + (s0.unrealised > 0 ? 'gain' : s0.unrealised < 0 ? 'loss' : ''); }
      for (const tr of body.querySelectorAll('tr[data-epic]')) {
        const p = acct.positions[tr.dataset.epic]; if (!p) continue;
        const q = quoteOf(p.epic), pnl = posPnl(p, q);
        const c = (k) => tr.querySelector(`[data-live="${k}"]`);
        c('last').textContent = validQ(q) ? fp(exitPx(p.qty, q)) : '—';
        c('pnl').textContent = money(pnl, true); c('pnl').className = 'igp-profit ' + (pnl > 0 ? 'gain' : pnl < 0 ? 'loss' : '');
        if (validQ(q)) { const dp = (exitPx(p.qty, q) - p.avg) * Math.sign(p.qty); c('delta').textContent = `${dp >= 0 ? '+' : '−'}${fp(Math.abs(dp))} (${dp >= 0 ? '+' : '−'}${Math.abs((dp / p.avg) * 100).toFixed(2)}%)`; c('delta').className = 'igp-delta ' + (dp > 0 ? 'gain' : dp < 0 ? 'loss' : ''); }
        c('margin').textContent = money(Math.abs(p.qty) * csOf(p) * (validQ(q) ? mid(q) : p.avg) * marginPctOf(acct, p.epic) / 100);
      }
    }
    const download = (name, text) => {
      const u = URL.createObjectURL(new Blob([text], { type: 'text/csv' })), l = document.createElement('a');
      l.href = u; l.download = name; document.body.appendChild(l); l.click(); l.remove(); setTimeout(() => URL.revokeObjectURL(u), 1000);
    };
    const stamp = () => new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');

    root.addEventListener('click', (e) => {
      const b = e.target.closest('button[data-a], .ctr'); if (!b || !root.contains(b)) return;
      const a = b.dataset.a, tr = b.closest('tr'), f = (k) => tr && tr.querySelector(`[data-f="${k}"]`);
      const epic = tr && tr.dataset.epic, id = tr && +tr.dataset.id;
      if (a === 'buy' || a === 'sell') return submit(ticketSpec(a));
      if (a === 'lotUp' || a === 'lotDn') return stepLots(a === 'lotUp' ? 1 : -1);
      if (a === 'ladder') { tk.noLadder = !tk.noLadder; saveTk(); applyLadder(); return; }
      if (a === 'fills') { tk.showFills = !tk.showFills; saveTk(); applyLadder(); renderOverlay(); return; }
      if (a === 'closeAll') { if (!Object.keys(acct.positions).length) return msg('No positions'); closeAll(acct, quoteOf).forEach((r) => (r.ok ? host.notify(describeFill(r.fill)) : msg(r.error))); save(); return refresh(true); }
      if (a === 'cancelAll') { cancelAll(acct); save(); return refresh(true); }
      if (a === 'center') { ui.center = null; return renderLadder(); }
      if (a === 'pClose') return done(close(acct, epic, num(f('cq').value), quoteOf(epic)));
      if (a === 'pRev') return done(reverse(acct, epic, quoteOf(epic)));
      if (a === 'pEdit') { ui.edit = 'p:' + epic; return refresh(true); }
      if (a === 'pEditX' || a === 'oEditX') { ui.edit = null; return refresh(true); }
      if (a === 'pSave') { const r = setProtection(acct, epic, { sl: num(f('sl').value), tp: num(f('tp').value), trail: num(f('trail').value) }); if (r.ok) ui.edit = null; return done(r, r.ok ? 'Protection updated' : null); }
      if (a === 'oEdit') { ui.edit = 'o:' + id; return refresh(true); }
      if (a === 'oCancel') { cancel(acct, id); save(); return refresh(true); }
      if (a === 'oSave') { const p = { qty: f('qty').value, price: f('price').value }; if (f('limitPrice')) p.limitPrice = f('limitPrice').value; const r = modify(acct, id, p); if (r.ok) ui.edit = null; return done(r, r.ok ? `Order #${id} modified` : null); }
      if (a === 'csvTrades') return download(`paper-trades-${stamp()}.csv`, csv(acct, 'trades'));
      if (a === 'csvFills') return download(`paper-fills-${stamp()}.csv`, csv(acct, 'fills'));
      if (a === 'saveAcct') {
        const v = (k) => body.querySelector(`[data-f="${k}"]`).value;
        configure(acct, { currency: v('cur'), leverage: v('lev') });
        configure(acct, { epic: act().epic, spec: { contract: v('cs') === '' ? null : v('cs'), minLot: v('minl') === '' ? null : v('minl'), lotStep: v('stepl') === '' ? null : v('stepl'), maxLot: v('maxl') === '' ? null : v('maxl'), leverage: v('slev') === '' ? null : v('slev') } });
        lotInfo();
        save(); msg('Account settings applied', true); return refresh(true);
      }
      if (a === 'rpReset') { resetReplay(); msg('Replay account reset', true); return refresh(true); }
      if (a === 'rpSave') {
        const v = (k) => body.querySelector(`[data-f="${k}"]`);
        const bal = num(v('rpBal').value);
        if (!(bal > 0)) return msg('Balance must be positive');
        rs.cfg = { balance: bal, spread: v('rpSpr').value === '' ? '' : Math.max(0, +v('rpSpr').value || 0), fresh: v('rpFresh').checked };
        host.store.set(RCFG, rs.cfg);
        if (rs.session && v('rpSpr').value !== '') rs.session.spread = rs.cfg.spread;
        msg('Replay settings saved', true); return refresh(true);
      }
      if (a === 'rpShow') { const r = rs.results[+b.dataset.i]; if (r) showResults(r); return; }
      if (a === 'rpClear') { rs.results = []; host.store.set(RRES, rs.results); return refresh(true); }
      if (a === 'reset') {
        const v = num(body.querySelector('[data-f="bal"]').value);
        if (!(v > 0)) return msg('Balance must be positive');
        reset(acct, v); save(); msg('Paper account reset', true); return refresh(true);
      }
    });

    // Ladder
    root.querySelector('[data-r="step"]').addEventListener('change', (e) => { ui.step = +e.target.value || 0; ui.center = null; renderLadder(); });
    rowsEl.addEventListener('wheel', (e) => { if (ui.center == null) return; e.preventDefault(); ui.center += Math.sign(e.deltaY) * 3; renderLadder(); }, { passive: false });
    rowsEl.addEventListener('click', (e) => {
      const chip = e.target.closest('.igp-chip');
      if (chip) { if (chip.dataset.oid) { cancel(acct, +chip.dataset.oid); save(); refresh(true); } return; }
      const cell = e.target.closest('.b, .s'); if (!cell) return;
      const epic = act().epic, q = quoteOf(epic), price = +cell.parentNode.dataset.p;
      if (!validQ(q) || !epic) return msg('No live price');
      const side = cell.classList.contains('b') ? 'buy' : 'sell';
      const type = side === 'buy' ? (price > q.offer ? 'stop' : 'limit') : (price < q.bid ? 'stop' : 'limit');
      submit(ticketSpec(side, { type, price, limitPrice: null, noPriceBracket: true }));
    });
    function renderLadder() {
      if (tk.noLadder) return;
      const a = act(), epic = a.epic, q = quoteOf(epic), d = dec();
      const step = ui.step || (validQ(q) ? [1, 2, 5, 10, 25, 100].find((k) => (q.offer - q.bid) * 10 ** d / k <= 2.5) || 100 : 1), tick = step / 10 ** d;
      const h = rowsEl.clientHeight, n = Math.max(11, Math.min(101, h ? Math.ceil(h / 19) | 1 : 25));
      if (!epic || !validQ(q)) { rowsEl.innerHTML = '<div class="igp-empty">Waiting for prices…</div>'; return; }
      const idx = (p) => Math.round(p / tick), m = idx(mid(q));
      if (ui.centerEpic !== epic + step || ui.center == null || Math.abs(m - ui.center) > n * 0.3) { ui.center = m; ui.centerEpic = epic + step; }
      const top = ui.center + Math.floor(n / 2), bi = idx(q.bid), ai = idx(q.offer), p = acct.positions[epic];
      const byRow = new Map(), put = (i, side, html) => { const k = i + side; byRow.set(k, (byRow.get(k) || '') + html); };
      for (const o of acct.orders) if (o.epic === epic) {
        const lvl = o.type === 'stoplimit' && o.triggered ? o.limitPrice : o.price;
        put(idx(lvl), o.side === 'buy' ? 'b' : 's', `<span class="igp-chip ${o.side}" data-oid="${o.id}" title="#${o.id} ${o.side} ${TYPE_LABEL[o.type]} ${o.qty} @ ${fp(lvl)}: click to cancel">${TYPE_LABEL[o.type]} ${o.qty} ×</span>`);
      }
      if (p) {
        const exit = p.qty > 0 ? 's' : 'b';
        if (p.sl != null) put(idx(p.sl), exit, `<span class="igp-chip prot" title="Stop loss ${fp(p.sl)}">SL</span>`);
        if (p.tp != null) put(idx(p.tp), exit, `<span class="igp-chip prot" title="Take profit ${fp(p.tp)}">TP</span>`);
      }
      const pi = p ? idx(p.avg) : null;
      let html = '';
      for (let i = top; i > top - n; i--) {
        const price = i * tick, c = [i === ai && 'ask', i === bi && 'bid', i < ai && i > bi && 'spread', i === pi && 'pos'].filter(Boolean).join(' ');
        html += `<div class="igp-lrow ${c}" data-p="${price.toFixed(d)}"><div class="b">${byRow.get(i + 'b') || ''}</div><div class="p">${i === pi ? (p.qty > 0 ? '▲ ' : '▼ ') : ''}${price.toFixed(d)}</div><div class="s">${byRow.get(i + 's') || ''}</div></div>`;
      }
      rowsEl.innerHTML = html;
    }

    // Bar replay: a separate account driven by the replayed bars of the active chart
    const RKEY = 'paper.replay', RCFG = 'paper.replayCfg', RRES = 'paper.replayResults';
    const rs = { session: null, saveT: null, cfg: Object.assign({ balance: null, spread: '', fresh: true }, host.store.get(RCFG, {}) || {}), results: host.store.get(RRES, []) };
    if (!Array.isArray(rs.results)) rs.results = [];
    const appViews = () => (window.IGApp && window.IGApp.views) || [];
    const appActive = () => (window.IGApp && window.IGApp.active) || null;
    const replaying = (v) => !!(v && v.rp && v.rp.on && Array.isArray(v.rp.full) && v.rp.full[v.rp.idx]);
    const replayBalance = () => num(rs.cfg.balance) ?? live.startBalance;
    function saveReplay() {
      clearTimeout(rs.saveT);
      rs.saveT = setTimeout(() => { rs.saveT = null; if (rs.session) host.store.set(RKEY, rs.session.acct); }, 500);
    }
    function sessionQuote(s) { const b = s.last || s.full[s.idx]; return barQuote(+b.close, s.spread, s.side, toMs(b.time)); }
    // Lower-timeframe replay: fill against each replayed sub-bar only (never the unreplayed rest of the chart bar).
    function advanceSub(s, b) {
      s.idx = Math.min(s.view.rp.idx, s.full.length - 1); s.last = b;
      const ev = tickBar(s.acct, s.epic, b, { spread: s.spread, side: s.side, t: b.time });
      s.acct.quotes[s.epic] = sessionQuote(s);
      s.curve.push(summary(s.acct).equity);
      if (s.curve.length > 50000) s.curve.splice(1, s.curve.length - 50000);
      if (ev.length) report(ev.slice(-4));
      saveReplay();
    }
    function startSession(v) {
      const epic = v.symbol, full = v.rp.full, idx = v.rp.idx;
      let a = null;
      if (!rs.cfg.fresh) { const st = host.store.get(RKEY, null); if (st && st.v === 1) a = normalize(st); }
      if (!a) { a = create({ balance: replayBalance(), currency: live.currency, leverage: live.leverage }); a.specs = JSON.parse(JSON.stringify(live.specs || {})); }
      const lq = host.quote && host.quote(epic);
      const spread = rs.cfg.spread !== '' && rs.cfg.spread != null && Number.isFinite(+rs.cfg.spread) ? +rs.cfg.spread : validQ(lq) ? Math.round(Math.max(0, lq.offer - lq.bid) * 1e8) / 1e8 : 0;
      const s = { view: v, full, epic, side: (v.state && v.state.side) || 'mid', spread, startIdx: idx, idx, acct: a, tradeFrom: a.trades.length };
      a.quotes[epic] = sessionQuote(s);
      s.startEq = summary(a).equity; s.curve = [s.startEq];
      rs.session = s;
      host.notify(`Replay paper trading: ${nameOf(epic)} · balance ${money(a.cash)} ${a.currency} (live paper account untouched)`);
    }
    function advance(s) {
      const upto = Math.min(s.view.rp.idx, s.full.length - 1), ev = [];
      while (s.idx < upto) {
        s.idx++;
        const bar = s.full[s.idx];
        ev.push(...tickBar(s.acct, s.epic, bar, { spread: s.spread, side: s.side, t: bar.time }));
        s.acct.quotes[s.epic] = sessionQuote(s);
        s.curve.push(summary(s.acct).equity);
      }
      if (s.curve.length > 50000) s.curve.splice(1, s.curve.length - 50000);
      if (ev.length) report(ev.slice(-4));
      saveReplay();
    }
    function endSession(silent) {
      const s = rs.session; if (!s) return;
      rs.session = null; clearTimeout(rs.saveT);
      const a = s.acct;
      cancelAll(a);
      for (const epic of Object.keys(a.positions)) close(a, epic, null, a.quotes[epic], 'replayend');
      if (acct === a) acct = live;
      s.curve.push(a.cash);
      host.store.set(RKEY, a);
      const res = recordResult(s);
      if (silent || !res) return;
      ui.tab = 'replay';
      host.notify(`Replay ended: ${res.trades} trade${res.trades === 1 ? '' : 's'} · net ${money(res.net, true)} ${res.currency} · win rate ${res.winRate == null ? '—' : res.winRate.toFixed(0) + '%'} · max DD ${money(res.maxDD)}`);
      showResults(res);
    }
    function recordResult(s) {
      const a = s.acct, trades = a.trades.slice(s.tradeFrom);
      if (!trades.length && s.idx === s.startIdx) return null;
      const res = { at: Date.now(), epic: s.epic, name: nameOf(s.epic), tf: s.view.interval, from: s.full[s.startIdx].time, to: s.full[s.idx].time, bars: s.idx - s.startIdx, spread: s.spread, currency: a.currency,
        ...stats(trades, s.curve, s.startEq), list: trades.slice(-200).map(({ epic, dir, qty, entry, exit, openT, closeT, pnl, reason }) => ({ epic, dir, qty, entry, exit, openT, closeT, pnl, reason })) };
      if (res.profitFactor === Infinity) res.profitFactor = 'inf';
      rs.results.unshift(res); rs.results.length = Math.min(rs.results.length, 20);
      host.store.set(RRES, rs.results);
      return res;
    }
    function resetReplay() {
      const s = rs.session;
      if (!s) { host.store.set(RKEY, null); return; }
      if (s.acct.trades.length > s.tradeFrom) { s.curve.push(summary(s.acct).equity); recordResult(s); }
      reset(s.acct, replayBalance()); s.acct.specs = JSON.parse(JSON.stringify(live.specs || {}));
      s.acct.quotes[s.epic] = sessionQuote(s);
      s.tradeFrom = 0; s.startIdx = s.idx; s.startEq = summary(s.acct).equity; s.curve = [s.startEq];
      host.store.set(RKEY, s.acct);
    }
    // Called from bus events, active-changed, a 1 s poll and every render; cheap when nothing changed.
    function syncReplay(noRefresh, subBar) {
      let changed = false;
      const s = rs.session;
      if (s) {
        if (!appViews().includes(s.view) || !replaying(s.view) || s.view.rp.full !== s.full || s.view.symbol !== s.epic) { endSession(); changed = true; }
        else if (subBar && subBar.view === s.view) { advanceSub(s, subBar.bar); changed = true; }
        else if (s.view.rp.idx > s.idx) { s.last = null; advance(s); changed = true; }
      }
      if (!rs.session && replaying(appActive())) { startSession(appActive()); changed = true; }
      const next = rs.session && appActive() === rs.session.view ? rs.session.acct : live;
      if (next !== acct) { acct = next; ui.edit = null; ui.center = null; changed = true; }
      if (changed && !noRefresh) refresh(true);
    }
    const pct = (v) => (v == null || !Number.isFinite(v) ? '—' : v.toFixed(Math.abs(v) < 10 ? 2 : 1) + '%');
    const pf = (v) => (v === 'inf' || v === Infinity ? '∞' : v == null || !Number.isFinite(v) ? '—' : v.toFixed(2));
    function statGrid(r) {
      const it = (k, v, c = '') => `<div><span class="k">${k}</span><b class="${c}">${v}</b></div>`;
      return `<div class="igp-rstats">${it('Net P&amp;L', `${money(r.net, true)} ${esc(r.currency || acct.currency)}`, r.net > 0 ? 'gain' : r.net < 0 ? 'loss' : '')}${it('Return', pct(r.returnPct), cls(r.returnPct))}
        ${it('Trades', r.trades)}${it('Win rate', pct(r.winRate))}${it('Wins / losses', `${r.wins} / ${r.losses}`)}${it('Profit factor', pf(r.profitFactor))}
        ${it('Max drawdown', `${money(r.maxDD)} (${pct(r.maxDDPct)})`, r.maxDD > 0 ? 'down' : '')}${it('Avg win / loss', `${money(r.avgWin)} / ${money(r.avgLoss)}`)}
        ${it('Largest win / loss', `${money(r.largestWin)} / ${money(r.largestLoss)}`)}${it('Equity', `${money(r.startEquity)} → ${money(r.endEquity)}`)}</div>`;
    }
    function showResults(r) {
      const tm = (t) => esc(host.fmtTime(Math.floor(t)));
      const html = `<div class="igp igp-rmodal"><div class="igp-hint" style="margin-bottom:8px">${esc(r.name)} · ${esc(r.tf)} · ${tm(r.from)} → ${tm(r.to)} · ${r.bars} bars · spread ${r.spread}</div>${statGrid(r)}
        ${r.list && r.list.length ? `<div style="max-height:260px;overflow:auto;margin-top:8px"><table><thead><tr><th>Closed</th><th>Dir</th><th>Qty</th><th>Entry</th><th>Exit</th><th>P&amp;L</th><th>Reason</th></tr></thead><tbody>${r.list.slice().reverse().map((x) => `<tr><td>${tm(x.closeT / 1000)}</td><td class="${x.dir === 'long' ? 'up' : 'down'}">${x.dir}</td><td>${x.qty}</td><td>${fp(x.entry)}</td><td>${fp(x.exit)}</td><td class="${cls(x.pnl)}">${money(x.pnl, true)}</td><td>${REASON[x.reason] || esc(x.reason)}</td></tr>`).join('')}</tbody></table></div>` : '<div class="igp-empty">No trades closed in this replay.</div>'}</div>`;
      if (window.IGApp && window.IGApp.modal) window.IGApp.modal('igpReplayRes', 'Replay results', html, '<button data-close class="primary">Close</button>');
      else { ui.tab = 'replay'; refresh(true); }
    }
    function renderReplayTab() {
      const s = rs.session, c = rs.cfg, tm = (t) => esc(host.fmtTime(Math.floor(t)));
      const cur = s ? { ...stats(s.acct.trades.slice(s.tradeFrom), s.curve.concat([summary(s.acct).equity]), s.startEq), currency: s.acct.currency } : null;
      return `<div class="igp-acct">
          <label>Replay starting balance<input data-f="rpBal" type="number" min="0" step="any" value="${num(c.balance) ?? ''}" placeholder="${live.startBalance} (paper balance)"></label>
          <label>Simulated spread<input data-f="rpSpr" type="number" min="0" step="any" value="${c.spread ?? ''}" placeholder="auto: live spread at start"></label>
          <label class="igp-chk"><span><input data-f="rpFresh" type="checkbox" ${c.fresh ? 'checked' : ''}> New replay account each session</span></label>
          <label>&nbsp;<div class="row"><button data-a="rpSave">Apply</button><button data-a="rpReset" title="Reset the replay account now (the live paper account is not touched)">Reset replay account</button></div></label>
        </div>
        <div class="igp-sec"><span>${s ? `Replaying ${esc(nameOf(s.epic))} · ${esc(s.view.interval)} · ${tm(s.full[s.startIdx].time)} → ${tm(s.full[s.idx].time)} · ${s.idx - s.startIdx} bars` : 'No replay running'}</span></div>
        ${cur ? statGrid(cur) : '<div class="igp-hint" style="padding:0 10px 8px">Start Bar Replay on the active chart (toolbar ▶ Replay, click a start bar). This panel then trades a separate replay account: market orders fill at the last replayed close, working orders and SL / TP fill inside each replayed bar (O→L→H→C on up bars, O→H→L→C on down bars) at the bar time. Exiting replay closes open replay positions and shows the results.</div>'}
        <div class="igp-sec"><span>Past replay sessions (${rs.results.length})</span>${rs.results.length ? '<button data-a="rpClear">Clear</button>' : ''}</div>
        ${rs.results.length ? `<table><thead><tr><th>Ended</th><th>Market</th><th>TF</th><th>Period</th><th>Bars</th><th>Trades</th><th>Win %</th><th>Net P&amp;L</th><th>Max DD</th><th>PF</th><th class="act"></th></tr></thead><tbody>${rs.results.map((r, i) => `<tr><td>${esc(new Date(r.at).toLocaleString())}</td><td>${esc(r.name)}</td><td>${esc(r.tf)}</td><td>${tm(r.from)} → ${tm(r.to)}</td><td>${r.bars}</td><td>${r.trades}</td><td>${pct(r.winRate)}</td><td class="${cls(r.net)}">${money(r.net, true)}</td><td>${money(r.maxDD)}</td><td>${pf(r.profitFactor)}</td><td class="act"><div><button data-a="rpShow" data-i="${i}">View</button></div></td></tr>`).join('')}</tbody></table>` : ''}`;
    }

    // Chart overlay
    function barTime(ms) {
      const c = act().candles; if (!c || !c.length) return null;
      const s = ms / 1000; if (s < c[0].time) return null;
      let lo = 0, hi = c.length - 1;
      while (lo < hi) { const md = (lo + hi + 1) >> 1; if (c[md].time <= s) lo = md; else hi = md - 1; }
      return c[lo].time;
    }
    function renderOverlay() {
      const a = act(), epic = a.epic; if (!epic) return;
      const th = (host.theme && host.theme()) || {}, up = th.up || '#26a69a', dn = th.down || '#ef5350', ac = th.accent || '#2962ff';
      const lines = [], markers = [], p = acct.positions[epic], q = quoteOf(epic);
      if (p) {
        const pnl = posPnl(p, q), long = p.qty > 0;
        lines.push({ id: 'pos:' + epic, price: p.avg, color: ac, style: 0, draggable: true, title: `${long ? 'LONG' : 'SHORT'} ${Math.abs(p.qty)} @ ${fp(p.avg)} P&L ${money(pnl, true)}` });
        const leg = (lvl) => (lvl - p.avg) * p.qty;
        if (p.sl != null) lines.push({ id: 'sl:' + epic, price: p.sl, color: dn, style: 2, draggable: true, title: `${p.trail ? 'TRAIL' : 'SL'} ${money(leg(p.sl), true)}` });
        if (p.tp != null) lines.push({ id: 'tp:' + epic, price: p.tp, color: up, style: 2, draggable: true, title: `TP ${money(leg(p.tp), true)}` });
      }
      for (const o of acct.orders) if (o.epic === epic) {
        const col = o.side === 'buy' ? up : dn, nm = `${o.side.toUpperCase()} ${TYPE_LABEL[o.type]} ${o.qty}`;
        if (o.type !== 'stoplimit' || !o.triggered) lines.push({ id: 'ord:' + o.id, price: o.price, color: col, style: 1, draggable: true, title: nm });
        if (o.type === 'stoplimit') lines.push({ id: 'lim:' + o.id, price: o.limitPrice, color: col, style: 1, draggable: true, title: `${nm} limit` });
        const b = o.bracket, ref = o.type === 'stoplimit' ? o.limitPrice : o.price, dir = o.side === 'buy' ? 1 : -1;
        if (b && ref) {
          const sl = b.sl ?? (b.slDist ? ref - dir * b.slDist : null), tp = b.tp ?? (b.tpDist ? ref + dir * b.tpDist : null);
          if (sl != null) lines.push({ id: 'osl:' + o.id, price: sl, color: dn, style: 2, draggable: true, title: `#${o.id} SL` });
          if (tp != null) lines.push({ id: 'otp:' + o.id, price: tp, color: up, style: 2, draggable: true, title: `#${o.id} TP` });
        }
      }
      if (tk.showFills) for (const f of acct.fills) if (f.epic === epic) {
        const time = barTime(f.t); if (time == null) continue;
        const buy = f.side === 'buy';
        markers.push({ time, position: buy ? 'belowBar' : 'aboveBar', shape: buy ? 'arrowUp' : 'arrowDown', color: buy ? up : dn, text: `${buy ? 'B' : 'S'} ${f.qty} @ ${fp(f.price)}` });
      }
      markers.sort((x, y) => x.time - y.time);
      host.setOverlay('paper', { markers, lines }, { onDrag });
    }
    function onDrag(id, price) {
      const [kind, ref] = String(id).split(':'), v = roundP(price);
      let r;
      if (kind === 'pos') {
        const p = acct.positions[ref]; if (!p) return renderOverlay();
        const loss = (v - p.avg) * p.qty < 0;
        r = setProtection(acct, ref, loss ? { sl: v } : { tp: v });
      } else if (kind === 'sl') r = setProtection(acct, ref, { sl: v, trail: null });
      else if (kind === 'tp') r = setProtection(acct, ref, { tp: v });
      else if (kind === 'ord') r = modify(acct, +ref, { price: v });
      else if (kind === 'lim') r = modify(acct, +ref, { limitPrice: v });
      else if (kind === 'osl') r = modify(acct, +ref, { sl: v });
      else if (kind === 'otp') r = modify(acct, +ref, { tp: v });
      if (r && !r.ok) host.notify(`Paper: ${r.error}`);
      done(r);
    }

    // Refresh
    function renderTicket() {
      const a = act(), q = quoteOf(a.epic);
      $r('name').textContent = a.name || nameOf(a.epic) || '—'; $r('epic').textContent = a.epic || '';
      $r('bid').textContent = validQ(q) ? fp(q.bid) : '—'; $r('offer').textContent = validQ(q) ? fp(q.offer) : '—';
      $r('spr').textContent = validQ(q) ? (q.offer - q.bid).toFixed(dec()) : '';
      $r('hint').textContent = acct === live ? 'Simulated fills only: buy at ask, sell at bid. Shift+B / Shift+S place market orders while this panel has focus.'
        : 'Replay account: market orders fill at the last replayed close (± spread); stops, limits, SL and TP fill inside each new replayed bar at the bar time.';
    }
    function renderSummary() {
      const s = summary(acct, quoteOf), item = (k, v, c = '') => `<span><span class="k">${k}</span><b class="${c}">${v}</b></span>`;
      const rsn = acct !== live && rs.session, badge = rsn
        ? `<span class="igp-sim igp-rp" title="Separate replay account; the live paper account is untouched">REPLAY</span><span class="muted" title="Replay clock · bars replayed · simulated spread">${esc(host.fmtTime(Math.floor(rsn.full[rsn.idx].time)))} · ${rsn.idx - rsn.startIdx} bars · spr ${(+rsn.spread).toFixed(dec())}</span>`
        : '<span class="igp-sim" title="Simulated account; nothing is sent to IG">PAPER</span>';
      sumEl.innerHTML = `${badge}<span class="igp-float ${s.unrealised > 0 ? 'gain' : s.unrealised < 0 ? 'loss' : ''}" title="Floating profit / loss of open positions">${money(s.unrealised, true)} ${esc(s.currency)}</span>
        ${item('Balance', `${money(s.balance)} ${esc(s.currency)}`)}${item('Equity', money(s.equity))}${item('Unrealised', money(s.unrealised, true), cls(s.unrealised))}
        ${item('Realised', money(s.realised, true), cls(s.realised))}${item('Used margin', money(s.usedMargin))}${item('Free margin', money(s.freeMargin), s.freeMargin < 0 ? 'down' : '')}
        ${item('Margin level', s.marginLevel == null ? '—' : s.marginLevel.toFixed(0) + '%')}${s.marginCall ? '<span class="igp-mc">MARGIN CALL: equity below used margin</span>' : ''}`;
    }
    function render() {
      if (ui.dead) return;
      ui.last = Date.now();
      syncReplay(true);
      renderTicket(); renderSummary();
      const ae = document.activeElement, editing = ae && body.contains(ae) && /^(INPUT|SELECT)$/.test(ae.tagName);
      if (!editing && sigOf() !== ui.sig) renderTab();
      renderLive(); renderLadder(); renderOverlay();
    }
    function refresh(now) {
      if (ui.dead) return;
      lotInfo();
      if (now === true) { clearTimeout(ui.timer); ui.timer = null; ui.sig = ''; return render(); }
      if (ui.timer) return;
      ui.timer = setTimeout(() => { ui.timer = null; render(); }, Math.max(0, 250 - (Date.now() - ui.last)));
    }

    const onKey = (e) => {
      if (!e.shiftKey || e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.target.matches && e.target.matches('textarea, input:not([type=number])')) return;
      const k = e.key.toLowerCase();
      if (k !== 'b' && k !== 's') return;
      e.preventDefault(); e.stopPropagation();
      submit(ticketSpec(k === 'b' ? 'buy' : 'sell', { type: 'market' }));
    };
    root.addEventListener('keydown', onKey);
    const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(() => { if (!ui.dead) render(); }) : null;
    if (ro) ro.observe(rowsEl);

    const unTick = host.onTick((epic, q) => {
      const ev = tick(live, epic, q);
      if (ev.length) { host.store.set(KEY, live); report(ev); }
      if (acct === live && (ev.length || epic === act().epic || live.positions[epic])) refresh();
    });
    const unChange = host.onChange(() => { syncReplay(); ui.center = null; ui.edit = null; refresh(true); });
    const bus = window.IGC && window.IGC.bus, unBus = bus ? ['replay-start', 'replay-bar', 'replay-stop'].map((ev) => bus.on(ev, (e) => syncReplay(false, ev === 'replay-bar' && e && e.sub ? e : null))) : [];
    // Bar replay emits no start event; this cheap check notices a replay that started on the active chart.
    const rpPoll = setInterval(() => syncReplay(), 1000);
    syncTicket(); updateButtons(); applyLadder(); refresh(true);

    return {
      refresh: () => refresh(true),
      destroy() {
        ui.dead = true; clearTimeout(ui.timer); clearTimeout(ui.msgTimer);
        if (typeof unTick === 'function') unTick();
        if (typeof unChange === 'function') unChange();
        unBus.forEach((u) => typeof u === 'function' && u()); clearInterval(rpPoll);
        if (rs.session) endSession(true);
        root.removeEventListener('keydown', onKey); if (ro) ro.disconnect();
        host.clearOverlay('paper'); save(); el.innerHTML = '';
      },
    };
  }

  window.IGPaper = { mount, KEY, engine: { create, normalize, reset, configure, summary, place, cancel, cancelAll, modify, setProtection, close, reverse, closeAll, tick, tickBar, barQuote, stats, csv, marginPctOf, posPnl, specOf, contractOf, lotError, autoContract } };
})();
