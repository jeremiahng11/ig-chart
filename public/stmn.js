/* STMN tools: "Alert" (server-side STMN alert, kind 'stmn') and "Backtest" (trade-by-trade simulation of the STMN boxes)
 * buttons under the AI Chance STMN stats table. Self-mounting: watches the DOM for .ac-stats tables. */
(() => {
  const IGC = window.IGC, AC = window.AIChance;
  if (!IGC || !AC || !AC.stmnBacktest) return;
  const { esc } = IGC;
  const KEY = 'stmnBt.v1';

  const css = `
.ac-stats .stmn-tools { display: flex; gap: 4px; padding: 3px 6px 5px; border-top: 1px solid var(--line); }
.ac-stats .stmn-tools button { pointer-events: auto; flex: 1; background: transparent; color: var(--text); border: 1px solid var(--line); border-radius: 3px; padding: 2px 6px; font: inherit; font-size: 10.5px; cursor: pointer; }
.ac-stats .stmn-tools button:hover { border-color: var(--accent); color: var(--accent); }
.modal-card.stmn-card { width: min(1040px, 100%); }
.modal-card.stmn-card.narrow { width: min(520px, 100%); }
.stmn-card .modal-body { overflow: auto; padding: 12px 16px; }
.stmn-form { display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: 8px 12px; margin-bottom: 10px; }
.stmn-form label { display: flex; flex-direction: column; gap: 3px; font-size: 11px; color: var(--muted); }
.stmn-form label.chk { flex-direction: row; align-items: center; gap: 6px; color: var(--text); }
.stmn-form input, .stmn-form select { font: inherit; font-size: 12px; padding: 4px 6px; background: var(--bg, transparent); color: var(--text); border: 1px solid var(--line); border-radius: 4px; }
.stmn-form .wide { grid-column: 1 / -1; }
.stmn-note { font-size: 11px; color: var(--muted); line-height: 1.45; margin: 6px 0; }
.stmn-kpis { display: grid; grid-template-columns: repeat(auto-fill, minmax(118px, 1fr)); gap: 6px; margin: 8px 0; }
.stmn-kpis div { border: 1px solid var(--line); border-radius: 6px; padding: 5px 8px; }
.stmn-kpis small { display: block; font-size: 10px; color: var(--muted); }
.stmn-kpis b { font-size: 14px; font-variant-numeric: tabular-nums; }
.stmn-pos { color: var(--up); } .stmn-neg { color: var(--down); }
.stmn-spark { width: 100%; height: 56px; display: block; margin: 4px 0 8px; }
.stmn-cmp { font-size: 11.5px; line-height: 1.5; border-left: 3px solid var(--accent); padding: 4px 10px; margin: 8px 0; }
.stmn-cmp ul { margin: 4px 0 0 16px; padding: 0; color: var(--muted); }
.stmn-trades { max-height: 42vh; overflow: auto; border: 1px solid var(--line); border-radius: 6px; }
.stmn-trades table { width: 100%; border-collapse: collapse; font: 11px ui-monospace, SFMono-Regular, Menlo, monospace; font-variant-numeric: tabular-nums; }
.stmn-trades th { position: sticky; top: 0; background: var(--panel); text-align: right; padding: 4px 6px; border-bottom: 1px solid var(--line); font-weight: 600; }
.stmn-trades td { text-align: right; padding: 3px 6px; white-space: nowrap; border-bottom: 1px solid color-mix(in srgb, var(--line) 50%, transparent); }
.stmn-trades th:nth-child(-n+2), .stmn-trades td:nth-child(-n+2) { text-align: left; }
.stmn-trades tbody tr { cursor: pointer; } .stmn-trades tbody tr:hover { background: color-mix(in srgb, var(--accent) 12%, transparent); }
.stmn-trades tr.open td { opacity: .6; }
.stmn-back { position: fixed; bottom: 18px; left: 50%; transform: translateX(-50%); z-index: 40; background: var(--accent); color: #fff; border: 0; border-radius: 16px; padding: 7px 14px; font-size: 12px; cursor: pointer; box-shadow: var(--shadow); }
`;
  const style = document.createElement('style');
  style.id = 'stmn-css'; style.textContent = css;
  document.head.appendChild(style);

  const load = () => { try { return JSON.parse(localStorage.getItem('igc.' + KEY) || '{}') || {}; } catch { return {}; } };
  const save = (v) => { try { localStorage.setItem('igc.' + KEY, JSON.stringify(v)); } catch {} };
  const app = () => window.IGApp;
  const viewOf = (el) => { const A = app(); if (!A) return null; return (A.views || []).find((v) => v.root && v.root.contains(el)) || A.active; };
  const ivLabel = (iv) => { try { return window.IGTypes ? window.IGTypes.label(iv) : iv; } catch { return iv; } };
  const nameOf = (e) => (IGC.nameOf ? IGC.nameOf(e) : e);
  const specOf = (sym) => {
    const P = window.IGPaper && window.IGPaper.engine;
    if (!P) return { contract: 1, minLot: 0.01, lotStep: 0.01 };
    const acct = IGC.store.get('mod.paper.v1', null);
    return P.specOf(acct && acct.specs ? acct : P.create(), sym);
  };
  const fmtN = (x, d = 2) => (x == null || !Number.isFinite(x) ? (x === Infinity ? '∞' : '—') : x.toLocaleString(undefined, { minimumFractionDigits: d, maximumFractionDigits: d }));
  const usd = (x) => (x == null || !Number.isFinite(x) ? '—' : (x < 0 ? '−$' : '$') + fmtN(Math.abs(x)));
  const cls = (x) => (x > 0 ? 'stmn-pos' : x < 0 ? 'stmn-neg' : '');
  const time = (t) => (IGC.fmtTime ? IGC.fmtTime(t) : new Date(t * 1000).toLocaleString());

  // ── mount the buttons under every STMN stats table (chartview re-renders the table on each AI Chance run) ──
  function mount(el) {
    if (el.querySelector(':scope > .stmn-tools')) return;
    const d = document.createElement('div');
    d.className = 'stmn-tools';
    d.innerHTML = '<button data-stmn="alert" title="Server-side alert on new STMN signals (works with the browser closed)">Alert…</button><button data-stmn="bt" title="Trade-by-trade simulation of the STMN boxes over the loaded bars">Backtest…</button>';
    d.addEventListener('click', (e) => {
      const b = e.target.closest('[data-stmn]'); if (!b) return;
      e.stopPropagation();
      const v = viewOf(el); if (!v) return;
      if (b.dataset.stmn === 'alert') openAlert(v); else openBacktest(v);
    });
    el.appendChild(d);
  }
  const scan = () => document.querySelectorAll('.ac-stats').forEach(mount);
  new MutationObserver(scan).observe(document.body, { childList: true, subtree: true });
  scan();

  // ── STMN alert ──
  const STMN_OPTS = ['umlPrice', 'umlHalf', 'umlAtrPeriod', 'umlAtrShift', 'umlBandMult', 'stmnBand', 'stmnStopAtr', 'riskUsd'];
  function openAlert(v) {
    const A = app(), sym = v.state.symbol, iv = v.state.interval;
    if (!sym) return IGC.toast('Open a symbol first');
    const o = { ...AC.DEFAULTS, ...v.shell.acOpts() }, sp = specOf(sym);
    const opts = Object.fromEntries(STMN_OPTS.map((k) => [k, o[k]]));
    Object.assign(opts, { contract: sp.contract, minLot: sp.minLot, lotStep: sp.lotStep });
    const nm = nameOf(sym);
    const body = `<form class="stmn-form">
      <label class="wide">Name<input name="name" value="${esc(`STMN ${nm} ${ivLabel(iv)}`)}"></label>
      <label>Sides<select name="sides"><option value="both">Buy + sell</option><option value="buy">Buy (STMN+) only</option><option value="sell">Sell (STMN−) only</option></select></label>
      <label>Trigger<select name="trigger"><option value="every_time">Every signal</option><option value="once">Once</option></select></label>
      <label>Risk $<input name="riskUsd" type="number" min="0.01" step="any" value="${esc(opts.riskUsd)}"></label>
      <label class="chk"><input type="checkbox" name="notify" checked> Push / in-app</label>
      <label class="chk"><input type="checkbox" name="telegram" checked> Telegram</label>
      <label class="chk"><input type="checkbox" name="email" checked> E-mail</label>
      <label class="wide">Webhook URL (optional)<input name="webhook" type="url" placeholder="https://…"></label>
    </form>
    <div class="stmn-note">${esc(nm)} · ${esc(ivLabel(iv))} — evaluated on the server at every bar close; fires when the just-closed bar prints a new STMN label
      (close beyond the ${esc(o.stmnBand === 'drawn' ? 'drawn' : 'as-of-bar')} UML band, at most once per hour per side). Band: ${esc(o.umlPrice)}, half ${esc(o.umlHalf)}, ATR ${esc(o.umlAtrPeriod)}/${esc(o.umlAtrShift)} × ${esc(o.umlBandMult)};
      stop ${esc(o.stmnStopAtr)} × ATR(14); lots from contract ${esc(sp.contract)} (min ${esc(sp.minLot)}, step ${esc(sp.lotStep)}).</div>`;
    const m = A.modal('stmnAlertModal', 'STMN alert', body, '<button data-close>Cancel</button><button class="primary" data-go>Create alert</button>', 'stmn-card narrow');
    m.querySelector('[data-go]').onclick = async () => {
      const f = m.querySelector('form'), val = (n) => f.elements[n].value, chk = (n) => f.elements[n].checked;
      const risk = +val('riskUsd');
      const payload = {
        kind: 'stmn', epic: sym, interval: iv, sides: val('sides'), symbol: nm, name: val('name').trim(), trigger: val('trigger'),
        opts: { ...opts, riskUsd: risk > 0 ? risk : opts.riskUsd }, notify: chk('notify'), telegram: chk('telegram'), email: chk('email'),
        ...(val('webhook').trim() ? { webhook: { url: val('webhook').trim() } } : {}),
      };
      try {
        await IGC.api('/api/alerts', { method: 'POST', body: payload });
        m.classList.add('hidden');
        IGC.toast(`STMN alert created: ${nm} ${ivLabel(iv)}`);
      } catch (e) { IGC.toast(`STMN alert: ${e.message}`); }
    };
  }

  // ── backtest ──
  let last = null; // { view, bt } for the "back to report" chip
  function openBacktest(v, keep) {
    const A = app();
    if (!v.candles || !v.candles.length) return IGC.toast('No bars loaded');
    const o = { ...AC.DEFAULTS, ...v.shell.acOpts() }, sp = specOf(v.state.symbol), q = (IGC.quotes || {})[v.state.symbol];
    const liveSpread = q && q.offer != null && q.bid != null ? Math.max(0, q.offer - q.bid) : 0;
    const s = { ...AC.BT_DEFAULTS, riskUsd: o.riskUsd, spread: Number(liveSpread.toPrecision(4)), ...load() };
    const sel = (n, opts) => `<select name="${n}">${opts.map(([k, t]) => `<option value="${k}"${String(s[n]) === k ? ' selected' : ''}>${esc(t)}</option>`).join('')}</select>`;
    const body = `<form class="stmn-form">
      <label>Entry${sel('entry', [['limit', 'EL touch (limit)'], ['close', 'Signal bar close'], ['confirm', 'After confirmation']])}</label>
      <label>Exit${sel('exit', [['TP1', 'TP1 (0.75R)'], ['TP2', 'TP2 (1.5R)'], ['TP3', 'TP3 (2R)'], ['scale', 'Scale out ⅓ each']])}</label>
      <label class="chk"><input type="checkbox" name="breakeven"${s.breakeven ? ' checked' : ''}> SL to breakeven after TP1 (scale-out)</label>
      <label>Same-bar SL &amp; TP${sel('ambiguity', [['sl', 'Worst case: SL first'], ['tp', 'Best case: TP first'], ['ohlc', 'Bar direction']])}</label>
      <label>Spread (price)<input name="spread" type="number" min="0" step="any" value="${esc(s.spread)}"></label>
      <label>Commission $/lot (round turn)<input name="commission" type="number" min="0" step="any" value="${esc(s.commission)}"></label>
      <label>Risk $ per trade<input name="riskUsd" type="number" min="0.01" step="any" value="${esc(s.riskUsd)}"></label>
      <label>Last N days (0 = all bars)<input name="days" type="number" min="0" step="1" value="${esc(s.days)}"></label>
      <label>Limit order lifetime (bars, 0 = 1 h)<input name="fillBars" type="number" min="0" step="1" value="${esc(s.fillBars)}"></label>
      <label class="chk"><input type="checkbox" name="oneAtATime"${s.oneAtATime ? ' checked' : ''}> One trade at a time</label>
    </form>
    <div class="stmn-note">${esc(nameOf(v.state.symbol))} · ${esc(ivLabel(v.state.interval))} · ${v.candles.length.toLocaleString()} bars · contract ${esc(sp.contract)} per lot (min ${esc(sp.minLot)}, step ${esc(sp.lotStep)}) — paper engine spec.
      Triggers use the chart's bar prices; fills pay half the spread on entry and on exit. Lots = risk $ ÷ (|entry − SL| × contract), rounded down to the lot step.</div>
    <div class="stmn-out"></div>`;
    const m = A.modal('stmnBtModal', 'STMN backtest', body, '<button data-csv disabled>Export CSV</button><span style="flex:1"></span><button data-close>Close</button><button class="primary" data-run>Run</button>', 'stmn-card');
    const f = m.querySelector('form');
    const read = () => {
      const n = (k) => { const x = +f.elements[k].value; return Number.isFinite(x) && x >= 0 ? x : 0; };
      return { entry: f.elements.entry.value, exit: f.elements.exit.value, breakeven: f.elements.breakeven.checked, ambiguity: f.elements.ambiguity.value,
        spread: n('spread'), commission: n('commission'), riskUsd: n('riskUsd') || o.riskUsd, days: Math.round(n('days')), fillBars: Math.round(n('fillBars')), oneAtATime: f.elements.oneAtATime.checked };
    };
    const run = () => {
      const p = read(); save(p);
      let out, bt;
      try {
        out = AC.compute(v.candles, (v.ac && v.ac.htf) || {}, v.shell.acOpts(), v.acCtx());
        bt = AC.stmnBacktest(v.candles, out, { ...p, contract: sp.contract, minLot: sp.minLot, lotStep: sp.lotStep, maxLot: sp.maxLot, statsWin: o.statsWin, statsDays: o.statsDays });
      } catch (e) { console.error('[stmn backtest]', e); m.querySelector('.stmn-out').innerHTML = `<div class="stmn-note">Backtest failed: ${esc(e.message)}</div>`; return; }
      last = { view: v, bt, symbol: v.state.symbol, interval: v.state.interval };
      render(m, v, bt, p, o);
    };
    m.querySelector('[data-run]').onclick = run;
    m.querySelector('[data-csv]').onclick = () => {
      if (!last || !last.bt) return;
      IGC.download(`stmn-backtest-${String(last.symbol).replace(/[^\w.-]+/g, '_')}-${ivLabel(last.interval)}.csv`, AC.stmnBacktestCSV(last.bt, (t) => new Date(t * 1000).toISOString()));
    };
    if (keep && last && last.view === v) render(m, v, last.bt, read(), o); else run();
  }

  function render(m, v, bt, p, o) {
    const S = bt.summary, el = m.querySelector('.stmn-out');
    m.querySelector('[data-csv]').disabled = !bt.trades.length;
    const kpi = (label, val, c = '') => `<div><small>${esc(label)}</small><b class="${c}">${val}</b></div>`;
    const span = `${time(S.from)} → ${time(S.to)}${p.days ? ` · last ${p.days} d` : ''}`;
    const kpis = kpi('Trades (closed)', S.trades + (S.open ? ` <small style="display:inline">+${S.open} open</small>` : ''))
      + kpi('Win rate', S.winRate == null ? '—' : Math.round(S.winRate * 100) + '%')
      + kpi('Avg R', fmtN(S.avgR), cls(S.avgR)) + kpi('Expectancy', usd(S.expectancy), cls(S.expectancy))
      + kpi('Profit factor', S.profitFactor == null ? '—' : fmtN(S.profitFactor)) + kpi('Net P&L', usd(S.netPnl), cls(S.netPnl))
      + kpi('Max drawdown', usd(-S.maxDD), S.maxDD ? 'stmn-neg' : '') + kpi('Sum R', fmtN(S.sumR), cls(S.sumR))
      + (S.open ? kpi('Open P&L', usd(S.openPnl), cls(S.openPnl)) : '');
    el.innerHTML = `<div class="stmn-note">${esc(span)} · ${S.setups} setups</div><div class="stmn-kpis">${kpis}</div>${spark(bt.equity)}${compare(bt, p, o)}
      <div class="stmn-trades"><table><thead><tr><th>Signal</th><th>Side</th><th>Entry time</th><th>Entry</th><th>Exit time</th><th>Exit</th><th>Reason</th><th>R</th><th>Lots</th><th>P&amp;L</th></tr></thead><tbody>
      ${bt.trades.map((t, i) => `<tr data-i="${i}" class="${t.status}" title="Show on chart"><td>${esc(time(t.time))}</td><td class="${t.dir === 1 ? 'stmn-pos' : 'stmn-neg'}">${t.side}</td><td>${esc(time(t.entryTime))}</td><td>${esc(v.fmt(t.entry))}</td><td>${t.status === 'open' ? '—' : esc(time(t.exitTime))}</td><td>${esc(v.fmt(t.exit))}</td><td>${esc(t.reason)}</td><td class="${cls(t.R)}">${fmtN(t.R)}</td><td>${t.lots}</td><td class="${cls(t.pnl)}">${usd(t.pnl)}</td></tr>`).join('') || '<tr><td colspan="10" style="text-align:center">No trades.</td></tr>'}
      </tbody></table></div>`;
    el.querySelector('tbody').onclick = (e) => {
      const tr = e.target.closest('tr[data-i]'); if (!tr) return;
      const t = bt.trades[+tr.dataset.i];
      m.classList.add('hidden');
      v.goTo(t.time);
      if (v.showCrosshairAt) setTimeout(() => v.showCrosshairAt(t.entryTime), 60);
      backChip(v);
    };
  }

  function spark(eq) {
    if (!eq.length) return '';
    const W = 600, H = 56, ys = [0, ...eq.map((x) => x.eq)], lo = Math.min(...ys), hi = Math.max(...ys), k = hi - lo || 1;
    const pts = ys.map((y, i) => `${((i / (ys.length - 1)) * W).toFixed(1)},${(H - 3 - ((y - lo) / k) * (H - 6)).toFixed(1)}`).join(' ');
    const zero = (H - 3 - ((0 - lo) / k) * (H - 6)).toFixed(1), endUp = ys[ys.length - 1] >= 0;
    return `<svg class="stmn-spark" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="Equity curve"><line x1="0" x2="${W}" y1="${zero}" y2="${zero}" stroke="var(--line)" stroke-dasharray="3 3" vector-effect="non-scaling-stroke"/><polyline points="${pts}" fill="none" stroke="var(${endUp ? '--up' : '--down'})" stroke-width="1.6" vector-effect="non-scaling-stroke"/></svg>`;
  }

  function compare(bt, p, o) {
    const c = bt.compare; if (!c) return '';
    const st = c.stats, rp = c.replica, me = c.mine, sk = me.skipped;
    const match = rp.trades + rp.open === st.confirmed && rp.targetExits === st.w && rp.stopExits === st.l;
    const entry = { limit: 'EL touched after the signal', close: 'signal bar close', confirm: 'confirmation close' }[p.entry];
    const why = [];
    if (p.entry !== 'confirm') why.push(`The table only scores setups that close back inside the band within 1 h (${st.confirmed} of ${st.setups}); the backtest enters at the ${entry} instead${sk.invalidated ? ` — ${sk.invalidated} EL orders were cancelled because the SL traded first` : ''}${sk.noFill ? `, ${sk.noFill} never filled` : ''}${sk.beyondStop ? `, ${sk.beyondStop} signal closes were already beyond the SL` : ''}.`);
    else if (sk.targetPassed) why.push(`${sk.targetPassed} confirmation closes were already beyond the target and are skipped here (the table still scores them).`);
    why.push(`The table scores which level is touched first (from the bar after confirmation, SL first on ties); the backtest counts $ P&L, so a "TP" reached from an entry beyond the target can lose${p.spread || p.commission ? ', and it pays spread/commission' : ''}.`);
    if (p.exit !== (o.statsWin || 'TP1')) why.push(`Exit ${p.exit === 'scale' ? 'scale-out' : p.exit} vs the table's ${o.statsWin || 'TP1'}.`);
    if (p.ambiguity !== 'sl') why.push(`Same-bar rule: ${p.ambiguity === 'tp' ? 'best case' : 'bar direction'} (the table assumes SL first).`);
    if (p.oneAtATime) why.push(`${sk.busy} setups skipped while a trade was open.`);
    return `<div class="stmn-cmp"><b>vs stats table (last ${c.days} d):</b> ${st.setups} setups · ${st.confirmed} confirmed · w/l ${st.w}-${st.l}${st.open ? ` · ${st.open} open` : ''}.
      Table rules replayed here (confirmation-close entry, ${esc(o.statsWin || 'TP1')}, SL first, no costs): ${rp.trades + rp.open} entries · ${rp.targetExits}-${rp.stopExits} by first level touched${match ? ' — matches' : ' — differs'}; by $ sign ${rp.wins}-${rp.losses}.
      Your rules, same window: ${me.trades} closed trades${me.open ? ` + ${me.open} open` : ''} · ${me.wins}-${me.losses} · net ${usd(me.netPnl)}.
      <ul>${why.map((x) => `<li>${esc(x)}</li>`).join('')}</ul></div>`;
  }

  function backChip(v) {
    let b = document.querySelector('.stmn-back');
    if (!b) { b = document.createElement('button'); b.className = 'stmn-back'; document.body.appendChild(b); }
    b.textContent = '◂ Back to STMN backtest';
    b.onclick = () => { b.remove(); openBacktest(v, true); };
    clearTimeout(backChip.t); backChip.t = setTimeout(() => b.remove(), 60000);
  }

  window.IGStmn = { openAlert, openBacktest, get last() { return last; } };
})();
