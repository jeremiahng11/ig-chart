/* IG Charts — ChartView: one chart in a multi-chart layout (symbol, interval, type, studies, panes, drawings, replay). */
(() => {
  const { esc, uid, settings, T, alpha, fmtTime, tickFmt, fmtNum, fmtVal, durText, api, nameOf, setName, quotes, mid, subscribe, unsubscribe, RES_SEC, RESOLUTIONS } = window.IGC;
  const LW = window.LightweightCharts, IND = window.IGInd, AC = window.AIChance;
  const TY = () => window.IGTypes || {};
  const NA = NaN;
  const ok = Number.isFinite;

  // ── intervals ─────────────────────────────────────────
  const UNIT_SEC = { S: 1, m: 60, H: 3600, D: 86400, W: 604800, M: 2592000 };
  function parseIv(s) {
    const lib = TY().parseInterval && TY().parseInterval(String(s));
    if (lib) return lib;
    const m = String(s).trim().match(/^(\d*)([SHDWMTR]?)$/i);
    if (!m) return null;
    const n = Number(m[1] || 1), u = m[2];
    if (!n) return null;
    if (/T/i.test(u)) return { kind: 'ticks', n };
    if (/R/i.test(u)) return { kind: 'range', size: n };
    const unit = u === '' ? 'm' : u === 'M' ? 'M' : u.toUpperCase();
    return { kind: 'time', unit, n, sec: n * UNIT_SEC[unit] };
  }
  function ivLabel(s) {
    const sp = parseIv(s);
    if (!sp) return String(s);
    if (TY().label) { try { return TY().label(sp); } catch {} }
    if (sp.kind === 'ticks') return `${sp.n}T`;
    if (sp.kind === 'range') return `${sp.size}R`;
    return `${sp.n}${{ S: 's', m: 'm', H: 'H', D: 'D', W: 'W', M: 'M' }[sp.unit]}`;
  }
  const specSec = (sp) => (sp && sp.kind === 'time' ? sp.sec : 60);
  // bar open time for a tick time — must match the aggregation alignment (UTC epoch multiples, Monday weeks, calendar months)
  function barStart(t, sp) {
    if (sp.unit === 'W') { const wk = 604800 * sp.n, off = 4 * 86400; return Math.floor((t - off) / wk) * wk + off; }
    if (sp.unit === 'M') { const d = new Date(t * 1000); const m = Math.floor((d.getUTCFullYear() * 12 + d.getUTCMonth()) / sp.n) * sp.n; return Date.UTC(Math.floor(m / 12), m % 12, 1) / 1000; }
    return Math.floor(t / sp.sec) * sp.sec;
  }
  function baseRes(sp) {
    if (sp.kind !== 'time') return 'MINUTE';
    const lib = TY().baseResolution && TY().baseResolution(sp, RESOLUTIONS);
    if (lib) return typeof lib === 'string' ? lib : lib.resolution || lib.res;
    if (sp.unit === 'M') return 'MONTH';
    if (sp.unit === 'W') return 'WEEK';
    if (sp.unit === 'D') return 'DAY';
    let best = 'SECOND';
    for (const r of RESOLUTIONS) if (r !== 'MONTH' && r !== 'WEEK' && RES_SEC[r] <= sp.sec && sp.sec % RES_SEC[r] === 0) best = r;
    return best;
  }
  function aggregate(bars, sp) {
    if (TY().aggregate) { try { return TY().aggregate(bars, sp); } catch (e) { console.warn('[aggregate]', e); } }
    const out = [];
    for (const b of bars) {
      const t = barStart(b.time, sp), last = out[out.length - 1];
      if (last && last.time === t) { last.high = Math.max(last.high, b.high); last.low = Math.min(last.low, b.low); last.close = b.close; last.volume += b.volume || 0; }
      else out.push({ time: t, open: b.open, high: b.high, low: b.low, close: b.close, volume: b.volume || 0 });
    }
    return out;
  }
  // synthetic tick path through a bar (open → nearer extreme → other extreme → close)
  const barTicks = (b) => {
    const t = b.time * 1000;
    const path = b.close >= b.open ? [b.open, b.low, b.high, b.close] : [b.open, b.high, b.low, b.close];
    return path.map((price, k) => ({ t: t + k * 10, price }));
  };

  // ── spread / formula symbols ──────────────────────────
  const TOKEN_RE = /[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z0-9_]+)+|\d+(?:\.\d+)?|[-+*/()]/g;
  const isExpr = (s) => /[-+*/()]/.test(String(s || '')) && String(s).replace(/\s+/g, '') !== String(s).replace(/[-+*/()\s]/g, '');
  function compileExpr(s) {
    const src = String(s).replace(/\s+/g, '');
    const toks = src.match(TOKEN_RE) || [];
    if (toks.join('') !== src) throw new Error('Unsupported characters in formula');
    const epics = [...new Set(toks.filter((t) => /^[A-Za-z]/.test(t)))];
    if (!epics.length) throw new Error('Formula needs at least one market');
    const js = toks.map((t) => (/^[A-Za-z]/.test(t) ? `v[${epics.indexOf(t)}]` : t)).join(' ');
    const fn = new Function('v', `return (${js});`);
    fn(epics.map(() => 1));
    return { epics, fn };
  }

  const typeMeta = (id) => (TY().CHART_TYPES || []).find((x) => x.id === id) || null;

  class ChartView {
    constructor(container, state, shell) {
      this.shell = shell;
      this.state = {
        symbol: null, interval: '5', type: 'candles', typeOpts: {}, studies: [], compares: [], ac: false, link: 0, scale: 'normal', side: 'mid', invert: false,
        ...state,
      };
      this.state.studies = (this.state.studies || []).map((s) => ({ uid: s.uid || uid(), id: s.id, params: { ...(IND.BY_ID[s.id] ? IND.defaults(IND.BY_ID[s.id]) : {}), ...(s.params || {}) }, styles: s.styles || {}, visible: s.visible !== false, h: s.h, tf: s.tf || '', place: s.place || '' }));
      this.candles = []; this.disp = []; this.basis = []; this.idx = new Map(); this.decimals = 2;
      this.rts = new Map(); this.panes = []; this.series = {}; this.overlay = null; this.mainKind = null;
      this.hostOverlays = new Map(); this.alertPLs = []; this.bidLine = this.askLine = null;
      this.htf = {}; this.compareRT = []; this.spread = null; this.subscribed = [];
      this.rp = { on: false, picking: false, full: null, idx: 0, timer: null };
      this.loadSeq = 0; this.footprint = new Map();
      this.build(container);
      this.load();
    }

    q(sel) { return this.root.querySelector(sel); }
    get symbol() { return this.state.symbol; }
    get interval() { return this.state.interval; }
    get spec() { return parseIv(this.state.interval) || parseIv('5'); }
    get tfSec() { return specSec(this.spec); }
    fmt(v) { return fmtNum(v, this.decimals); }
    title() { return this.spread ? this.state.symbol : nameOf(this.state.symbol || ''); }

    // ── DOM / chart ─────────────────────────────────────
    build(container) {
      const root = (this.root = document.createElement('div'));
      root.className = 'cv';
      root.innerHTML = `<div class="pane main">
          <div class="chart"></div><canvas class="study-layer"></canvas><canvas class="draw-layer"></canvas>
          <div class="tl-stack"><div class="legend"></div>
            <div class="ac-panel hidden"><div class="ac-cards"></div>
              <details class="ac-databox"><summary>Data window</summary><div class="ac-data"></div></details>
              <details class="ac-logbox"><summary>Signals <span class="ac-logcount muted"></span></summary><ul class="ac-log"></ul></details></div></div>
          <div class="tl-bar hidden"></div><div class="tl-hint hidden"></div>
          <div class="replay-bar hidden"><span class="rp-title">Replay</span><button data-rp="play" title="Play / pause (Shift+↓)">▶</button><button data-rp="step" title="Forward one bar (Shift+→)">▶❘</button>
            <select data-rp="speed"><option value="0.5">0.5×</option><option value="1" selected>1×</option><option value="3">3×</option><option value="10">10×</option></select><select data-rp="tf" title="Step by a lower timeframe: the current bar builds up bar by bar"></select><input type="datetime-local" data-rp="date" title="Jump to date and time"><button data-rp="jump" title="Jump to this date">Go</button><span class="rp-info muted"></span><button data-rp="exit" title="Exit replay">✕</button></div>
          <div class="cv-msg hidden"></div>
        </div>`;
      container.appendChild(root);
      this.el = this.q('.chart');
      this.chart = LW.createChart(this.el, this.chartOpts(false));
      root.addEventListener('mousedown', () => this.shell.activate(this), true);
      root.addEventListener('touchstart', () => this.shell.activate(this), { capture: true, passive: true });
      this.el.addEventListener('wheel', () => { this.navAt = Date.now(); }, { capture: true, passive: true });
      this.el.addEventListener('pointerdown', () => { this.navDown = true; }, true);
      window.addEventListener('pointerup', () => { if (this.navDown) { this.navDown = false; this.navAt = Date.now(); } });
      this.chart.timeScale().subscribeVisibleLogicalRangeChange((r) => {
        if (r && !this.syncing) this.syncPanes(this.chart, r);
        if (!this.applyingRange && (this.navDown || Date.now() - (this.navAt || 0) < 400)) this.userNavAt = Date.now();
        if (!this.applyingRange) this.shell.onRange(this);
      });
      this.chart.subscribeCrosshairMove((p) => this.onCrosshair(this.chart, p));
      this.chart.subscribeClick((p) => this.onClick(p));
      this.setupMainSeries();
      this.setupDragLines();
      this.setupPointer();
      this.setupFreeDrag();
      this.setupDrawings();
      this.setupAC();
      this.root.querySelector('.replay-bar').addEventListener('click', (e) => {
        const a = e.target.closest('[data-rp]')?.dataset.rp;
        if (a === 'play') this.replayPlay(); if (a === 'step') { this.replayPause(); this.replayStep(); } if (a === 'exit') this.replayStop();
        if (a === 'jump') { const v = this.q('[data-rp=date]').value; if (v) this.replayJump(Math.floor(new Date(v).getTime() / 1000)); }
      });
      this.q('[data-rp=speed]').onchange = () => { if (this.rp.timer) { this.replayPause(); this.replayPlay(); } };
      this.q('[data-rp=tf]').onchange = (e) => this.replaySetStep(e.target.value);
      this.q('.legend').addEventListener('click', (e) => this.onLegendClick(e));
      this.root.addEventListener('dblclick', (e) => { const row = e.target.closest('.lg-study'); if (row) this.shell.openStudySettings(this, row.dataset.uid); });
      this.raf = requestAnimationFrame(this.frame.bind(this));
    }

    chartOpts(sub) {
      const t = T();
      return {
        autoSize: true,
        layout: { background: { type: 'solid', color: t.bg }, textColor: t.text, fontSize: 11, attributionLogo: false, fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif' },
        grid: { vertLines: { color: t.grid, visible: settings.grid === 'both' || settings.grid === 'vert' }, horzLines: { color: t.grid, visible: settings.grid === 'both' || settings.grid === 'horz' } },
        crosshair: { mode: settings.crosshair === 'magnet' ? LW.CrosshairMode.Magnet : LW.CrosshairMode.Normal, vertLine: { color: t.cross, labelBackgroundColor: t.crossLabel, style: 2 }, horzLine: { color: t.cross, labelBackgroundColor: t.crossLabel, style: 2 } },
        rightPriceScale: { borderColor: t.border, minimumWidth: 74, scaleMargins: sub ? { top: 0.12, bottom: 0.08 } : { top: 0.1, bottom: 0.08 } },
        timeScale: { borderColor: t.border, timeVisible: true, secondsVisible: this.spec && this.spec.kind === 'time' && this.spec.sec < 60, rightOffset: 8, tickMarkFormatter: tickFmt },
        localization: { timeFormatter: (x) => fmtTime(x, this.tfSec < 60), priceFormatter: (p) => this.fmt(p) },
        watermark: sub ? { visible: false } : { visible: settings.watermark, text: this.state.symbol ? `${this.title()} · ${ivLabel(this.state.interval)}` : '', fontSize: 40, color: t.wm, horzAlign: 'center', vertAlign: 'center' },
      };
    }

    applyTheme() {
      this.chart.applyOptions(this.chartOpts(false));
      this.panes.forEach((p) => p.chart.applyOptions(this.chartOpts(true)));
      for (const rt of this.rts.values()) rt.levels.forEach((l) => l.applyOptions({ color: T().level }));
      this.renderMain(true);
      this.removeQuoteLines(); this.updateQuote();
    }

    // ── main series (chart type) ────────────────────────
    setupMainSeries() { this.switchSeries(this.typeInfo().series); }
    typeInfo() {
      const meta = typeMeta(this.state.type);
      if (meta) return { series: meta.series || this.seriesForType(this.state.type), priceBased: !!meta.priceBased, meta };
      return { series: this.seriesForType(this.state.type), priceBased: false, meta: null };
    }
    seriesForType(t) { return { bars: 'bars', line: 'line', line_markers: 'line', step: 'line', area: 'area', hlc_area: 'line', baseline: 'baseline', columns: 'histogram', kagi: 'line' }[t] || 'candles'; }
    makeSeries(kind) {
      const c = this.chart, s = settings;
      if (kind === 'bars') return c.addBarSeries({ upColor: s.up, downColor: s.down, thinBars: false });
      if (kind === 'line') return c.addLineSeries({ color: '#2962ff', lineWidth: 2 });
      if (kind === 'area') return c.addAreaSeries({ lineColor: '#2962ff', topColor: 'rgba(41,98,255,.35)', bottomColor: 'rgba(41,98,255,0)', lineWidth: 2 });
      if (kind === 'baseline') return c.addBaselineSeries({ topLineColor: s.up, topFillColor1: alpha(s.up, 0.28), topFillColor2: alpha(s.up, 0.04), bottomLineColor: s.down, bottomFillColor1: alpha(s.down, 0.04), bottomFillColor2: alpha(s.down, 0.28), lineWidth: 2 });
      if (kind === 'histogram') return c.addHistogramSeries({ color: '#2962ff' });
      return c.addCandlestickSeries({ upColor: s.up, downColor: s.down, borderUpColor: s.up, borderDownColor: s.down, wickUpColor: s.up, wickDownColor: s.down, borderVisible: true });
    }
    switchSeries(kind) {
      if (this.overlay && this.mainKind === kind) return false;
      this.removeQuoteLines();
      for (const o of this.hostOverlays.values()) o.pls = [];
      this.alertPLs = []; if (this.ac) this.ac.priceLines = [];
      if (this.overlay) this.chart.removeSeries(this.overlay);
      this.overlay = this.makeSeries(kind);
      this.mainKind = kind;
      // like TradingView, keep visible AI Chance labels inside the auto-scaled price range
      this.overlay.applyOptions({ autoscaleInfoProvider: (orig) => {
        const base = this.lockedRange(orig());
        if (this.state.lockRatio) return base;
        const L = this.state.ac && this.acLabels;
        if (!base || !base.priceRange || !L || !L.length) return base;
        const r = this.chart.timeScale().getVisibleLogicalRange();
        if (!r) return base;
        let lo = base.priceRange.minValue, hi = base.priceRange.maxValue;
        for (const l of L) { const i = this.idx.get(l.time); if (i == null || i < r.from - 1 || i > r.to + 1) continue; if (l.y < lo) lo = l.y; if (l.y > hi) hi = l.y; }
        const pad = (hi - lo) * 0.04;
        return { ...base, priceRange: { minValue: lo < base.priceRange.minValue ? lo - pad : lo, maxValue: hi > base.priceRange.maxValue ? hi + pad : hi } };
      } });
      this.overlay.applyOptions({ priceFormat: { type: 'price', precision: this.decimals, minMove: 1 / 10 ** this.decimals } });
      return true;
    }
    setType(type, opts) {
      const wasPB = this.typeInfo().priceBased;
      this.state.type = type;
      if (opts) this.state.typeOpts = { ...(this.state.typeOpts || {}), [type]: opts };
      this.chart.applyOptions({ watermark: this.chartOpts(false).watermark });
      const changed = this.switchSeries(this.typeInfo().series);
      this.renderAll();
      if (wasPB || this.typeInfo().priceBased) this.resetView();
      if (changed) { this.reattach(); }
      this.shell.persist();
    }
    reattach() { this.updateQuote(); this.renderAlertLines(); for (const [owner, o] of this.hostOverlays) this.setOverlay(owner, o.spec, o.handlers); this.acRun(); }

    transformBars(bars) {
      const lib = TY().transform;
      const type = this.state.type;
      if (lib) {
        try {
          const r = lib(type, bars, (this.state.typeOpts || {})[type] || {});
          if (r && r.bars) return r;
        } catch (e) { console.warn('[transform]', type, e); }
      }
      if (type === 'heikin') return { bars: IND.heikinAshi(bars), series: 'candles' };
      if (this.seriesForType(type) !== 'candles' && this.seriesForType(type) !== 'bars') return { bars: bars.map((b) => ({ time: b.time, value: b.close })), series: this.seriesForType(type) };
      return { bars, series: 'candles' };
    }
    toSeriesData(bars, kind) {
      if (kind === 'candles' || kind === 'bars') { const bc = window.IGPineRender && window.IGPineRender.barColors(this, bars); return bc ? bars.map((b, i) => (bc[i] ? { ...b, color: bc[i], borderColor: bc[i], wickColor: bc[i] } : b)) : bars; }
      return bars.map((b) => (b.value !== undefined ? b : { time: b.time, value: b.close, ...(b.color ? { color: b.color } : {}) }));
    }

    renderMain(full) {
      const info = this.typeInfo();
      const r = this.transformBars(this.candles);
      this.typeNote = r.note || '';
      this.typeExtra = r.extra || null;
      this.typeOverlay = r.overlay || null;
      if (r.options) this.overlay.applyOptions(r.options);
      const data = this.toSeriesData(r.bars, this.mainKind);
      if (this.state.type === 'baseline' && data.length) this.overlay.applyOptions({ baseValue: { type: 'price', price: data.reduce((a, x) => a + (x.value ?? x.close), 0) / data.length } });
      const prev = this.disp;
      const sameHead = !full && prev.length && data.length >= prev.length && data.length <= prev.length + 3 && (prev.length < 2 || data[prev.length - 2]?.time === prev[prev.length - 2].time);
      if (sameHead) { for (let i = Math.max(0, prev.length - 1); i < data.length; i++) this.overlay.update(data[i]); }
      else this.overlay.setData(data);
      this.disp = data;
      this.basis = info.priceBased ? r.bars.map((b) => (b.open !== undefined ? b : { time: b.time, open: b.value, high: b.value, low: b.value, close: b.value, volume: 0 })) : this.candles;
      this.idx = new Map(this.basis.map((x, i) => [x.time, i]));
      return sameHead;
    }

    renderAll() {
      this.renderMain(true);
      this.renderStudies('full');
      this.refreshMarkers();
      this.updateLegend();
    }

    // ── data loading ────────────────────────────────────
    wantBars() { return this.loadBars || settings.maxBars || 500; }
    async fetchSeries(epic, sp, want, side = 'mid') {
      const sd = side && side !== 'mid' ? `&side=${side}` : '';
      if (sp.kind === 'time') {
        const res = baseRes(sp), ratio = Math.max(1, Math.round(sp.sec / RES_SEC[res]));
        const max = Math.min(this.serverMaxBars || 30000, Math.ceil(want * ratio) + (ratio > 1 ? ratio : 0));
        const r = await api(`/api/history?epic=${encodeURIComponent(epic)}&resolution=${res}&max=${max}${sd}`);
        this.shell.onAllowance(r.allowance);
        if (epic === this.state.symbol) { this.serverMaxBars = r.maxBars || 5000; this.histSources = r.sources || null; if (r.extError) console.warn('[history] older bars unavailable:', r.extError); }
        const bars = RES_SEC[res] === sp.sec || (sp.unit === 'M' && res === 'MONTH' && sp.n === 1) || (sp.unit === 'W' && res === 'WEEK' && sp.n === 1) ? r.candles : aggregate(r.candles, sp);
        return { bars: bars.slice(-want) };
      }
      const r = await api(`/api/history?epic=${encodeURIComponent(epic)}&resolution=MINUTE&max=${Math.min(1500, want)}${sd}`);
      this.shell.onAllowance(r.allowance);
      const agg = TY().createTickAggregator ? TY().createTickAggregator(sp) : null;
      if (!agg) return { bars: r.candles, agg: null };
      for (const b of r.candles) for (const tk of barTicks(b)) agg.push(tk);
      return { bars: agg.bars().map((b) => ({ ...b })), agg };
    }

    async load(opts = {}) {
      const seq = ++this.loadSeq;
      if (this.rp.on || this.rp.picking) this.replayStop(true);
      this.candlesFor = null;
      const sym = this.state.symbol;
      this.updateSubscriptions();
      if (!sym) { this.candles = []; this.renderAll(); return this.msg('Search for a market to start charting.'); }
      this.msg('Loading…');
      const sp = this.spec, want = opts.bars || this.wantBars();
      try {
        this.spread = null;
        if (isExpr(sym)) {
          const ex = compileExpr(sym);
          const parts = await Promise.all(ex.epics.map((e) => this.fetchSeries(e, sp.kind === 'time' ? sp : parseIv('1'), want)));
          const maps = parts.map((p) => new Map(p.bars.map((b) => [b.time, b])));
          const times = parts[0].bars.map((b) => b.time).filter((t) => maps.every((m) => m.has(t)));
          const f = (k) => (t) => ex.fn(maps.map((m) => m.get(t)[k]));
          const [fo, fh, fl, fc] = ['open', 'high', 'low', 'close'].map(f);
          this.candles = times.map((t) => { const o = fo(t), h = fh(t), l = fl(t), c = fc(t); return { time: t, open: o, high: Math.max(o, h, l, c), low: Math.min(o, h, l, c), close: c, volume: 0 }; }).filter((b) => ok(b.open) && ok(b.close));
          this.spread = { ...ex, vals: ex.epics.map((e) => mid(quotes[e])) };
          this.tickAgg = null;
          this.decimals = 4;
        } else {
          const { bars, agg } = await this.fetchSeries(sym, sp, want, this.state.side);
          if (seq !== this.loadSeq) return;
          this.candles = bars; this.tickAgg = agg || null;
          api(`/api/market/${encodeURIComponent(sym)}`).then((m) => {
            setName(sym, m.name);
            const d = Number.isFinite(m.decimals) && m.decimals >= 0 && m.decimals <= 6 ? m.decimals : 2;
            if (d !== this.decimals) { this.decimals = d; this.applyPrecision(); }
            this.shell.onSymbolMeta(this); this.updateLegend();
          }).catch(() => {});
        }
        if (seq !== this.loadSeq) return;
        this.candlesFor = `${sym}|${this.state.interval}`;
        this.chart.applyOptions({ watermark: this.chartOpts(false).watermark, timeScale: { secondsVisible: sp.kind === 'time' && sp.sec < 60 } });
        this.footprint = new Map();
        this.renderAll();
        const n = this.disp.length, loadedAt = Date.now();
        let span = 150;
        if (opts.span && n) {
          const from = this.candles[this.candles.length - 1].time - opts.span;
          let i = n - 1; while (i > 0 && this.disp[i - 1].time >= from) i--;
          span = n - i;
        }
        this.toLatest(span);
        const reanchor = () => { if (seq === this.loadSeq && !(this.userNavAt > loadedAt)) this.toLatest(span); };
        this.msg(n ? '' : 'No price history for this market / interval.');
        this.applyScale();
        this.loadCompares().then(reanchor, reanchor);
        this.loadHtfStudies().then(reanchor, reanchor);
        this.removeQuoteLines(); this.updateQuote(); this.renderAlertLines();
        this.shell.onLoaded(this);
        if (this.state.ac) { await this.acLoadHtf(); if (seq !== this.loadSeq) return; }
        this.acRun();
        reanchor();
      } catch (e) {
        if (seq !== this.loadSeq) return;
        this.candles = []; this.renderAll(); this.acClear();
        this.msg(e.body && e.body.error === 'historical-data-allowance' || /allowance/.test(e.message)
          ? 'IG weekly historical-data allowance is used up for this request. Live ticks will still build candles.'
          : `Couldn't load: ${e.message}`);
      }
    }
    msg(t) { const m = this.q('.cv-msg'); m.textContent = t || ''; m.classList.toggle('hidden', !t); }

    updateSubscriptions() {
      const want = new Set();
      const sym = this.state.symbol;
      if (sym) { if (isExpr(sym)) { try { compileExpr(sym).epics.forEach((e) => want.add(e)); } catch {} } else want.add(sym); }
      for (const c of this.state.compares) want.add(c.epic);
      const next = [...want];
      subscribe(next); unsubscribe(this.subscribed);
      this.subscribed = next;
    }
    involves(epic) { return this.subscribed.includes(epic); }

    setSymbol(sym, silent) {
      if (!sym || sym === this.state.symbol) return;
      this.state.symbol = sym;
      this.removeQuoteLines();
      this.draw && this.draw.reset();
      this.load();
      this.shell.persist();
      if (!silent) this.shell.onSymbolChanged(this);
    }
    setInterval(iv, opts = {}) {
      if (!parseIv(iv)) return false;
      this.state.interval = String(iv);
      this.load(opts);
      this.shell.persist();
      if (!opts.silent) this.shell.onIntervalChanged(this);
      return true;
    }
    applyPrecision() {
      const pf = { type: 'price', precision: this.decimals, minMove: 1 / 10 ** this.decimals };
      this.overlay.applyOptions({ priceFormat: pf });
      [this.acPL, this.acA5, this.acC1, this.acC2, this.acTU, this.acTL, this.acUU, this.acUM, this.acUL, this.acUUA, this.acULA].forEach((s) => s && s.applyOptions({ priceFormat: pf }));
      for (const rt of this.rts.values()) if (rt.def.kind === 'overlay') Object.values(rt.series).forEach((s) => s.applyOptions({ priceFormat: pf }));
    }

    // ── live ticks ──────────────────────────────────────
    onTick(epic, q) {
      if (epic === this.state.symbol) this.updateQuote();
      const cmp = this.compareRT.find((c) => c.epic === epic);
      if (cmp) this.tickCompare(cmp, q);
      for (const key of Object.keys(this.htf)) this.tickHtf(this.htf[key], epic, q);
      if (this.candlesFor !== `${this.state.symbol}|${this.state.interval}` || this.rp.on || this.rp.picking) return;
      let price;
      if (this.spread) {
        const i = this.spread.epics.indexOf(epic);
        if (i < 0) return;
        this.spread.vals[i] = mid(q);
        if (this.spread.vals.some((v) => !ok(v))) return;
        price = this.spread.fn(this.spread.vals);
      } else {
        if (epic !== this.state.symbol) return;
        price = this.sidePrice(q);
      }
      if (!ok(price)) return;
      const tms = q.t || Date.now();
      if (this.footprintOn()) this.recordFootprint(tms, price);
      const sp = this.spec;
      const c = this.candles;
      if (sp.kind === 'time') {
        const last = c[c.length - 1];
        const t = barStart(Math.floor(tms / 1000), sp);
        if (!last || t < last.time) return;
        if (t === last.time) { last.high = Math.max(last.high, price); last.low = Math.min(last.low, price); last.close = price; last.volume = (last.volume || 0) + 1; }
        else { c.push({ time: t, open: price, high: price, low: price, close: price, volume: 1 }); this.onBarClose(); }
      } else if (this.tickAgg) {
        const r = this.tickAgg.push({ t: tms, price, bid: q.bid, offer: q.offer });
        if (!r || !r.bar) return;
        if (r.isNew || (r.changed && r.changed.length > 1) || !c.length) {
          this.candles = this.tickAgg.bars().slice(-5000).map((b) => ({ ...b }));
          this.scheduleFull = this.candles.length !== c.length + 1;
          this.onBarClose();
        } else Object.assign(c[c.length - 1], r.bar);
      } else return;
      const keep = Math.max(5000, this.wantBars()); if (c.length > keep + 1000) { c.splice(0, c.length - keep); this.scheduleFull = true; }
      this.scheduleLive();
    }
    scheduleLive() {
      if (this.liveRaf) return;
      this.liveRaf = requestAnimationFrame(() => {
        this.liveRaf = 0;
        const full = this.scheduleFull; this.scheduleFull = false;
        const tail = this.renderMain(full);
        this.renderStudies(tail && !full ? 'tail' : 'full');
        if (!tail || full) this.refreshMarkers();
        this.updateLegend();
        this.acSchedule();
      });
    }
    onBarClose() { if (!this.rp.on) setTimeout(() => this.acOnBarClose(), 0); this.shell.onBarClose && this.shell.onBarClose(this); }

    // ── studies ─────────────────────────────────────────
    defOf(st) { return IND.BY_ID[st.id]; }
    paneOpts() { return this.chartOpts(true); }
    createPane(st) {
      const div = document.createElement('div');
      div.className = 'pane sub';
      div.style.height = (st.h || (this.root.clientHeight > 500 ? 140 : 90)) + 'px';
      div.innerHTML = '<div class="pane-div" title="Drag to resize"></div><div class="pane-chart"></div><canvas class="study-layer"></canvas><div class="pane-legend"></div>';
      this.root.appendChild(div);
      const c = LW.createChart(div.querySelector('.pane-chart'), this.paneOpts());
      const anchor = c.addLineSeries({ priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false, color: 'rgba(0,0,0,0)', lineVisible: false });
      const pane = { id: st.uid, div, chart: c, anchor, primary: null, primaryVal: () => NA, legend: div.querySelector('.pane-legend'), canvas: div.querySelector('.study-layer'), st, members: [] };
      this.panes.push(pane);
      c.timeScale().subscribeVisibleLogicalRangeChange((r) => { if (r && !this.syncing) this.syncPanes(c, r); });
      c.subscribeCrosshairMove((p) => this.onCrosshair(c, p));
      div.querySelector('.pane-div').addEventListener('mousedown', (e) => {
        e.preventDefault();
        const y0 = e.clientY, h0 = div.offsetHeight;
        const mv = (ev) => { div.style.height = Math.max(50, Math.min(900, h0 + (y0 - ev.clientY))) + 'px'; };
        const up = () => { window.removeEventListener('mousemove', mv); window.removeEventListener('mouseup', up); pane.st.h = div.offsetHeight; this.shell.persist(); };
        window.addEventListener('mousemove', mv); window.addEventListener('mouseup', up);
      });
      div.addEventListener('dblclick', (e) => { if (!e.target.closest('.pane-legend')) this.toggleMaximize(pane.id); });
      pane.legend.addEventListener('click', (e) => this.onLegendClick(e));
      this.updateTimeAxes();
      return pane;
    }
    removePane(pane) {
      const i = this.panes.indexOf(pane);
      if (i < 0) return;
      if (this.maxed === pane.id) this.maxed = null;
      this.panes.splice(i, 1); pane.chart.remove(); pane.div.remove(); this.applyMaximize();
    }
    updateTimeAxes() {
      const vis = this.panes.filter((p) => p.div.style.display !== 'none');
      const mainShown = this.q('.pane.main').style.display !== 'none';
      this.chart.timeScale().applyOptions({ visible: mainShown && !vis.length });
      this.panes.forEach((p) => p.chart.timeScale().applyOptions({ visible: p === vis[vis.length - 1] }));
    }
    toggleMaximize(id) { this.maxed = this.maxed === id ? null : id; this.applyMaximize(); }
    applyMaximize() {
      const m = this.maxed;
      this.q('.pane.main').style.display = m && m !== 'main' ? 'none' : '';
      for (const p of this.panes) { p.div.style.display = m && m !== p.id ? 'none' : ''; p.div.style.flex = m === p.id ? '1' : ''; }
      this.updateTimeAxes();
      this.root.classList.toggle('maxed', !!m);
    }
    syncPanes(src, r) {
      this.syncing = true;
      for (const c of [this.chart, ...this.panes.map((p) => p.chart)]) if (c !== src) c.timeScale().setVisibleLogicalRange(r);
      this.syncing = false;
      if (src !== this.chart && !this.applyingRange) this.shell.onRange(this);
    }

    outColor(st, o) { return (st.styles[o.k] && st.styles[o.k].color) || o.color; }
    outWidth(st, o) { return (st.styles[o.k] && st.styles[o.k].width) || o.width || 1; }
    priceFmtFor(def) {
      if (def.kind === 'volume' || (/obv|volume|vol/i.test(def.id) && def.kind === 'pane')) return { type: 'volume' };
      if (def.kind === 'pane') return { type: 'price', precision: 2, minMove: 0.01 };
      return { type: 'price', precision: this.decimals, minMove: 1 / 10 ** this.decimals };
    }
    // where a study lives: 'main' (price chart), 'pane' (own pane) or { with: uid } (shares that study's pane)
    placeOf(st, def) {
      const p = st.place || '';
      if (p === 'main') return 'main';
      if (p === 'new') return 'pane';
      if (p.startsWith('with:')) return { with: p.slice(5) };
      return def.kind === 'pane' ? 'pane' : 'main';
    }
    paneOfUid(u) { return this.panes.find((p) => p.members.includes(u)) || null; }
    mountStudy(st) {
      const def = this.defOf(st);
      const rt = { def, series: {}, pane: null, vals: {}, levels: [], markers: [], graphics: [] };
      const place = this.placeOf(st, def);
      let pane = null;
      if (place !== 'main') pane = (place.with && this.paneOfUid(place.with)) || this.createPane(st);
      const host = pane ? pane.chart : this.chart;
      const ownScale = !pane && def.kind === 'pane';
      let scaleId = st.scale === 'left' ? 'left' : 'right';
      if (ownScale && st.scale !== 'left') scaleId = 'ov-' + st.uid;
      else if (!pane && def.kind === 'volume') scaleId = 'vol';
      for (const o of def.outputs || []) {
        const common = { priceLineVisible: false, crosshairMarkerVisible: false, visible: st.visible, priceFormat: this.priceFmtFor(def), lastValueVisible: def.kind === 'pane' || !!pane, priceScaleId: scaleId };
        let s;
        if (o.type === 'histogram') s = host.addHistogramSeries({ ...common, color: this.outColor(st, o), base: 0 });
        else s = host.addLineSeries({ ...common, color: this.outColor(st, o), lineWidth: this.outWidth(st, o), lineStyle: o.style || 0, lineType: o.lineType || 0, lineVisible: !o.dots, pointMarkersVisible: !!o.dots, pointMarkersRadius: 1.6 });
        if (def.range) s.applyOptions({ autoscaleInfoProvider: () => ({ priceRange: { minValue: def.range[0], maxValue: def.range[1] } }) });
        else if (!pane && scaleId === 'right') s.applyOptions({ autoscaleInfoProvider: (orig) => (this.state.scalePriceOnly || this.state.lockRatio ? null : orig()) });
        rt.series[o.k] = s;
      }
      if (scaleId === 'vol') this.chart.priceScale('vol').applyOptions({ scaleMargins: { top: 0.8, bottom: 0 } });
      if (scaleId.startsWith('ov-')) this.chart.priceScale(scaleId).applyOptions({ scaleMargins: { top: 0.72, bottom: 0.02 } });
      if (scaleId === 'left') host.applyOptions({ leftPriceScale: { visible: true, borderColor: T().border } });
      const pk = ((def.outputs || []).find((o) => o.type !== 'histogram') || (def.outputs || [])[0] || {}).k;
      if (pane) {
        pane.members.push(st.uid);
        if (!pane.primary || pane.primary === pane.anchor) {
          pane.primary = rt.series[pk] || pane.anchor;
          pane.primaryVal = (i) => (rt.vals[pk] ? rt.vals[pk][i ?? this.basis.length - 1] : NA);
        }
        rt.pane = pane;
      }
      const lvlHost = rt.series[pk];
      if (lvlHost && (pane || ownScale)) for (const lv of def.levels || []) rt.levels.push(lvlHost.createPriceLine({ price: lv, color: T().level, lineWidth: 1, lineStyle: 2, axisLabelVisible: false }));
      this.rts.set(st.uid, rt);
      return rt;
    }
    unmountStudy(st) {
      const rt = this.rts.get(st.uid);
      if (!rt) return;
      const pane = rt.pane;
      if (pane) {
        pane.members = pane.members.filter((u) => u !== st.uid);
        if (!pane.members.length) this.removePane(pane);
        else {
          for (const s of Object.values(rt.series)) pane.chart.removeSeries(s);
          if (Object.values(rt.series).includes(pane.primary)) {
            const next = this.rts.get(pane.members[0]);
            pane.st = this.state.studies.find((x) => x.uid === pane.members[0]) || pane.st;
            const k = next && ((next.def.outputs || []).find((o) => o.type !== 'histogram') || {}).k;
            pane.primary = (next && next.series[k]) || pane.anchor;
            pane.primaryVal = (i) => (next && next.vals[k] ? next.vals[k][i ?? this.basis.length - 1] : NA);
          }
        }
      } else for (const s of Object.values(rt.series)) this.chart.removeSeries(s);
      this.rts.delete(st.uid);
      const leftLeft = this.state.studies.some((x) => x !== st && x.scale === 'left' && this.rts.has(x.uid) && !this.rts.get(x.uid).pane);
      if (!leftLeft) this.chart.applyOptions({ leftPriceScale: { visible: false } });
    }
    remountStudies() {
      for (const st of [...this.state.studies]) this.unmountStudy(st);
      this.renderStudies('full'); this.buildStudyLegends(); this.refreshMarkers(); this.updateLegend();
      this.shell.onStudiesChanged(this);
    }
    moveStudy(u, where) {
      const list = this.state.studies, i = list.findIndex((s) => s.uid === u);
      if (i < 0) return;
      const st = list[i], def = this.defOf(st);
      if (where === 'main') st.place = 'main';
      else if (where === 'new') st.place = 'new';
      else if (where.startsWith('with:')) st.place = where;
      else if (where === 'up' || where === 'down') {
        const owners = this.panes.map((p) => list.find((s) => s.uid === p.members[0])).filter(Boolean);
        const mine = this.paneOfUid(u), j = this.panes.indexOf(mine), k = where === 'up' ? j - 1 : j + 1;
        if (j < 0 || k < 0 || k >= owners.length) return;
        const groupA = mine.members.map((x) => list.find((s) => s.uid === x)), groupB = this.panes[k].members.map((x) => list.find((s) => s.uid === x));
        const rest = list.filter((s) => !groupA.includes(s) && !groupB.includes(s));
        const first = where === 'up' ? groupA : groupB, second = where === 'up' ? groupB : groupA;
        const at = Math.min(list.indexOf(groupA[0]), list.indexOf(groupB[0]));
        rest.splice(Math.min(at, rest.length), 0, ...first, ...second);
        list.splice(0, list.length, ...rest);
        if (!st.place && def.kind !== 'pane') st.place = 'new';
      }
      this.remountStudies();
    }
    setStudyScale(u, side) { const st = this.state.studies.find((s) => s.uid === u); if (!st) return; st.scale = side === 'left' ? 'left' : ''; this.remountStudies(); }
    studyMenu(u, anchor) {
      this.closeMenu();
      const st = this.state.studies.find((s) => s.uid === u); if (!st) return;
      const rt = this.rts.get(u), inPane = !!(rt && rt.pane);
      const titleOf = (uid) => { const x = this.state.studies.find((s) => s.uid === uid); const d = x && this.defOf(x); return d ? IND.title(d, x.params) : '?'; };
      const others = this.panes.filter((p) => !p.members.includes(u));
      const items = [
        ['set', 'Settings…'], ['alert', 'Add alert…'], ['-'],
        inPane ? ['to:main', 'Move to price chart'] : ['to:new', 'Move to new pane'],
        ...(inPane && rt.pane.members.length > 1 ? [['to:new', 'Move to its own pane']] : []),
        ...others.map((p) => ['to:with:' + p.members[0], 'Merge into pane: ' + esc(titleOf(p.members[0]))]),
        ...(inPane ? [['to:up', 'Move pane up'], ['to:down', 'Move pane down'], ['max', this.maxed === rt.pane.id ? 'Restore pane' : 'Maximize pane']] : []),
        ...(!inPane ? [['-'], ['scale:right', (st.scale !== 'left' ? '● ' : '') + 'Right scale'], ['scale:left', (st.scale === 'left' ? '● ' : '') + 'Left scale']] : []),
        ['-'], ['vis', st.visible ? 'Hide' : 'Show'], ['del', 'Remove'],
      ];
      const m = document.createElement('div');
      m.className = 'cv-menu';
      m.innerHTML = items.map(([k, l]) => (k === '-' ? '<div class="dd-sep"></div>' : '<button data-m="' + k + '">' + l + '</button>')).join('');
      this.root.appendChild(m);
      const r = anchor.getBoundingClientRect(), rr = this.root.getBoundingClientRect();
      m.style.left = Math.max(4, Math.min(r.left - rr.left, rr.width - 240)) + 'px';
      m.style.top = Math.max(4, Math.min(r.bottom - rr.top + 2, rr.height - m.offsetHeight - 4)) + 'px';
      m.onclick = (e) => {
        const k = e.target.closest('[data-m]')?.dataset.m; if (!k) return;
        this.closeMenu();
        const snap = () => this.shell.beforeChange && this.shell.beforeChange(this);
        if (k === 'set') this.shell.openStudySettings(this, u);
        if (k === 'alert') this.shell.openStudyAlert && this.shell.openStudyAlert(this, u);
        if (k.startsWith('to:')) { snap(); this.moveStudy(u, k.slice(3)); }
        if (k.startsWith('scale:')) { snap(); this.setStudyScale(u, k.slice(6)); }
        if (k === 'max') this.toggleMaximize(rt.pane.id);
        if (k === 'vis') this.toggleStudy(u);
        if (k === 'del') { snap(); this.removeStudy(u); }
      };
      setTimeout(() => { this._menuClose = (e) => { if (!m.contains(e.target)) this.closeMenu(); }; document.addEventListener('mousedown', this._menuClose); }, 0);
      this._menu = m;
    }
    closeMenu() { if (this._menu) { this._menu.remove(); this._menu = null; document.removeEventListener('mousedown', this._menuClose); } }
    srcArray(bars, name) {
      switch (name) {
        case 'open': return bars.map((x) => x.open);
        case 'high': return bars.map((x) => x.high);
        case 'low': return bars.map((x) => x.low);
        case 'hl2': return bars.map((x) => (x.high + x.low) / 2);
        case 'hlc3': return bars.map((x) => (x.high + x.low + x.close) / 3);
        case 'ohlc4': return bars.map((x) => (x.open + x.high + x.low + x.close) / 4);
        case 'volume': return bars.map((x) => x.volume || 0);
        case 'close': case undefined: case null: case '': return bars.map((x) => x.close);
        default: {
          const m = /^study:([^:]+):(.+)$/.exec(name);
          const rt = m && this.rts.get(m[1]);
          const v = rt && rt.vals[m[2]];
          return v && v.length === bars.length ? v : bars.map((x) => x.close);
        }
      }
    }
    computeStudy(st, rt) {
      const def = rt.def;
      let bars = this.basis, mapTo = null;
      if (st.tf && st.tf !== this.state.interval && this.htf[st.tf]) { bars = this.htf[st.tf].bars; mapTo = this.basis; }
      else if (st.tf && st.tf !== this.state.interval) return { pending: true };
      const ctx = { src: (name) => (mapTo && /^study:/.test(name) ? this.srcArray(bars, 'close') : this.srcArray(bars, name)), tfSec: mapTo ? specSec(parseIv(st.tf)) : this.tfSec, symbol: this.state.symbol, decimals: this.decimals };
      let out = bars.length ? def.calc(bars, st.params, ctx) : {};
      if (mapTo && bars.length) {
        const times = bars.map((b) => b.time), mapped = {};
        const pos = mapTo.map((b) => { let lo = 0, hi = times.length - 1, r = -1; while (lo <= hi) { const m = (lo + hi) >> 1; if (times[m] <= b.time) { r = m; lo = m + 1; } else hi = m - 1; } return r; });
        for (const o of def.outputs) { const a = out[o.k] || []; mapped[o.k] = pos.map((p) => (p >= 0 ? a[p] : NA)); }
        if (out.colors) { mapped.colors = {}; for (const k of Object.keys(out.colors)) mapped.colors[k] = pos.map((p) => (p >= 0 ? out.colors[k][p] : undefined)); }
        mapped.graphics = out.graphics; mapped.markers = out.markers;
        out = mapped;
      }
      return out;
    }
    pointFor(st, rt, o, i, out) {
      const b = this.basis[i], v = out[o.k] && out[o.k][i];
      if (!ok(v)) return { time: b.time };
      const p = { time: b.time, value: v };
      const dir = out.colors && out.colors[o.k] && out.colors[o.k][i];
      if (dir) {
        const col = dir === 'down' ? (st.styles[o.k]?.colorDown || o.colorDown || this.outColor(st, o)) : dir === 'up' ? this.outColor(st, o) : dir;
        p.color = rt.def.kind === 'volume' ? alpha(col, 0.45) : col;
      }
      return p;
    }
    renderStudies(mode = 'full') {
      const n = this.basis.length;
      let mounted = false;
      for (const st of this.studyOrder()) {
        if (!this.defOf(st)) continue;
        let rt = this.rts.get(st.uid);
        if (!rt) { rt = this.mountStudy(st); mounted = true; mode = 'full'; }
        let out;
        try { out = this.computeStudy(st, rt); } catch (e) { console.error('[study]', st.id, e); continue; }
        if (out.pending) { for (const s of Object.values(rt.series)) s.setData([]); continue; }
        rt.markers = out.markers || []; rt.graphics = out.graphics || [];
        for (const o of rt.def.outputs) {
          rt.vals[o.k] = out[o.k] || [];
          const s = rt.series[o.k];
          if (!n) { s.setData([]); continue; }
          if (mode === 'full') s.setData(this.basis.map((_, i) => this.pointFor(st, rt, o, i, out)));
          else s.update(this.pointFor(st, rt, o, n - 1, out));
        }
        if (rt.pane && rt.markers.length && rt.pane.primary) rt.pane.primary.setMarkers(this.snapMarkers(rt.markers));
      }
      for (const p of this.panes) {
        if (mode === 'full') p.anchor.setData(this.basis.map((x) => ({ time: x.time })));
        else if (n) p.anchor.update({ time: this.basis[n - 1].time });
      }
      if (mounted) {
        this.buildStudyLegends();
        const r = this.chart.timeScale().getVisibleLogicalRange();
        if (r) this.panes.forEach((p) => p.chart.timeScale().setVisibleLogicalRange(r));
      }
      if (mode === 'full') this.refreshMarkers();
    }
    addStudy(id, params, extra = {}) {
      const def = IND.BY_ID[id];
      if (!def) return null;
      if (def.kind === 'volume' && this.state.studies.some((s) => IND.BY_ID[s.id]?.kind === 'volume')) { window.IGC.toast('Volume is already on this chart'); return null; }
      if (this.state.studies.length >= 50) { window.IGC.toast('Limit: 50 indicators per chart'); return null; }
      const st = { uid: uid(), id, params: { ...IND.defaults(def), ...(params || {}) }, styles: {}, visible: true, tf: extra.tf || '' };
      this.state.studies.push(st);
      this.renderStudies('full'); this.buildStudyLegends(); this.updateLegend();
      if (st.tf) this.loadHtfStudies();
      this.shell.onStudiesChanged(this);
      return st;
    }
    removeStudy(u) {
      const i = this.state.studies.findIndex((s) => s.uid === u);
      if (i < 0) return;
      this.unmountStudy(this.state.studies[i]); this.state.studies.splice(i, 1);
      this.buildStudyLegends(); this.refreshMarkers(); this.updateLegend(); this.shell.onStudiesChanged(this);
    }
    toggleStudy(u) {
      const st = this.state.studies.find((s) => s.uid === u); if (!st) return;
      st.visible = !st.visible;
      const rt = this.rts.get(u); if (rt) Object.values(rt.series).forEach((s) => s.applyOptions({ visible: st.visible }));
      this.buildStudyLegends(); this.refreshMarkers(); this.updateLegend(); this.shell.onStudiesChanged(this);
    }
    updateStudy(u, patch) {
      const st = this.state.studies.find((s) => s.uid === u); if (!st) return;
      const tfChanged = patch.tf !== undefined && patch.tf !== st.tf;
      Object.assign(st, patch);
      const rt = this.rts.get(u);
      if (rt) for (const o of rt.def.outputs) { const s = rt.series[o.k]; s.applyOptions(o.type === 'histogram' ? { color: this.outColor(st, o) } : { color: this.outColor(st, o), lineWidth: this.outWidth(st, o) }); }
      if (tfChanged) this.loadHtfStudies();
      this.renderStudies('full'); this.buildStudyLegends(); this.updateLegend(); this.shell.onStudiesChanged(this);
    }
    clearStudies() { for (const st of [...this.state.studies]) this.unmountStudy(st); this.state.studies = []; this.buildStudyLegends(); this.refreshMarkers(); this.shell.onStudiesChanged(this); }
    // Any other study's output can be a source (TradingView-style), except studies that would create a cycle.
    sourceOptions(selfUid) {
      const series = {};
      for (const st of this.state.studies) {
        const def = this.defOf(st); if (!def || !def.outputs.length) continue;
        series[st.uid] = { name: IND.title(def, st.params), params: st.params, outputs: Object.fromEntries(def.outputs.map((o) => [o.k, []])), labels: Object.fromEntries(def.outputs.map((o) => [o.k, o.label])) };
      }
      return IND.sourceOptions({ studySeries: series }, selfUid).map((o) => [o.value, o.label]);
    }
    // Studies in dependency order (sources first); cycles or missing sources keep list order.
    studyOrder() {
      const list = this.state.studies, byUid = new Map(list.map((st) => [st.uid, st])), out = [], state = new Map();
      const visit = (st) => {
        if (state.get(st.uid) === 2) return; if (state.get(st.uid) === 1) return;
        state.set(st.uid, 1);
        for (const d of IND.dependencies(st.params || {})) { const dep = byUid.get(d); if (dep) visit(dep); }
        state.set(st.uid, 2); out.push(st);
      };
      list.forEach(visit);
      return out;
    }

    async loadHtfStudies() {
      const need = [...new Set(this.state.studies.map((s) => s.tf).filter((tf) => tf && tf !== this.state.interval))];
      for (const k of Object.keys(this.htf)) if (!need.includes(k)) delete this.htf[k];
      if (!this.state.symbol || isExpr(this.state.symbol)) return;
      await Promise.all(need.filter((tf) => !this.htf[tf]).map(async (tf) => {
        const sp = parseIv(tf);
        if (!sp || sp.kind !== 'time') return;
        try {
          const want = Math.min(1000, Math.ceil((this.candles.length * this.tfSec) / sp.sec) + 60);
          const { bars } = await this.fetchSeries(this.state.symbol, sp, want, this.state.side);
          this.htf[tf] = { bars, sp };
        } catch (e) { console.warn('[htf]', tf, e.message); }
      }));
      this.renderStudies('full'); this.updateLegend();
    }
    sidePrice(q) { return this.state.side === 'bid' ? q.bid : this.state.side === 'ask' ? (q.offer ?? q.bid) : mid(q); }
    setSide(side) { if (this.state.side === side) return; this.state.side = side; this.load(); this.shell.persist(); this.shell.onStateChanged && this.shell.onStateChanged(this); }
    tickHtf(h, epic, q) {
      if (epic !== this.state.symbol || !h.bars.length) return;
      const price = this.sidePrice(q); if (!ok(price)) return;
      const t = barStart(Math.floor((q.t || Date.now()) / 1000), h.sp), last = h.bars[h.bars.length - 1];
      if (t === last.time) { last.high = Math.max(last.high, price); last.low = Math.min(last.low, price); last.close = price; }
      else if (t > last.time) h.bars.push({ time: t, open: price, high: price, low: price, close: price, volume: 1 });
    }

    // ── markers / graphics / fills ──────────────────────
    snapMarkers(list) {
      const b = this.basis;
      if (!b.length) return [];
      const times = b.map((x) => x.time);
      return list.map((m) => {
        let lo = 0, hi = times.length - 1, r = 0;
        while (lo <= hi) { const k = (lo + hi) >> 1; if (times[k] <= m.time) { r = k; lo = k + 1; } else hi = k - 1; }
        return { ...m, time: times[r] };
      }).sort((a, c) => a.time - c.time);
    }
    refreshMarkers() {
      const all = [];
      if (this.acMarkers) all.push(...this.acMarkers);
      for (const st of this.state.studies) { const rt = this.rts.get(st.uid); if (rt && !rt.pane && st.visible) all.push(...rt.markers); }
      for (const o of this.hostOverlays.values()) if (o.spec && o.spec.markers) all.push(...o.spec.markers);
      if (this.events && this.events.length && this.basis.length) { const t0 = this.basis[0].time, t1 = this.basis[this.basis.length - 1].time + this.tfSec; for (const ev of this.events) if (ev.time >= t0 && ev.time <= t1) all.push({ time: ev.time, position: 'belowBar', shape: 'square', color: ev.impact === 'High' ? '#ef5350' : ev.impact === 'Medium' ? '#ff9800' : '#9598a1', text: ev.short || '' }); }
      try { this.overlay.setMarkers(this.snapMarkers(all)); } catch (e) { console.warn('[markers]', e.message); }
    }

    timeToLogical(t) {
      const c = this.basis, n = c.length, step = this.tfSec;
      if (!n) return null;
      if (t <= c[0].time) return (t - c[0].time) / step;
      if (t >= c[n - 1].time) return n - 1 + (t - c[n - 1].time) / step;
      let lo = 0, hi = n - 1;
      while (hi - lo > 1) { const m = (lo + hi) >> 1; if (c[m].time <= t) lo = m; else hi = m; }
      return lo + (t - c[lo].time) / (c[hi].time - c[lo].time);
    }
    logicalToTime(l) {
      const c = this.basis, n = c.length, step = this.tfSec;
      if (!n || l == null) return null;
      if (l <= 0) return c[0].time + l * step;
      if (l >= n - 1) return c[n - 1].time + (l - (n - 1)) * step;
      const i = Math.floor(l);
      return c[i].time + (l - i) * (c[i + 1].time - c[i].time);
    }
    // logicalToCoordinate only handles whole bar indexes (fractions come back as 0), so interpolate between neighbours
    logicalToX(l, chart = this.chart) {
      const ts = chart.timeScale(), i = Math.floor(l);
      const x0 = ts.logicalToCoordinate(i);
      if (x0 == null || l === i) return x0;
      const x1 = ts.logicalToCoordinate(i + 1);
      return x1 == null ? null : x0 + (l - i) * (x1 - x0);
    }
    toXY(t, p, series = this.overlay, chart = this.chart) {
      const l = this.timeToLogical(t);
      const x = l == null ? null : this.logicalToX(l, chart);
      const y = series.priceToCoordinate(p);
      return x == null || y == null ? null : { x, y };
    }
    fromXY(x, y) {
      if (!this.basis.length) return null;
      const l = this.chart.timeScale().coordinateToLogical(x), p = this.overlay.coordinateToPrice(y);
      return l == null || p == null ? null : { l, t: this.logicalToTime(l), p };
    }

    frame() {
      this.raf = requestAnimationFrame(this.frame.bind(this));
      if (this.draw) this.draw.draw();
      this.renderLayer(this.q('.pane.main .study-layer'), this.chart, this.overlay, (st, rt) => !rt.pane);
      for (const p of this.panes) {
        const rt = this.rts.get(p.st.uid);
        this.renderLayer(p.canvas, p.chart, p.primary || p.anchor, (st) => p.members.includes(st.uid), rt);
      }
    }
    renderLayer(canvas, chart, series, pick) {
      const items = this.state.studies.filter((st) => { const rt = this.rts.get(st.uid); return rt && st.visible && pick(st, rt) && ((rt.graphics && rt.graphics.length) || (rt.def.fills && rt.def.fills.length)); });
      const extra = canvas.parentElement.classList.contains('main') && (this.typeExtra || this.footprintOn() || (this.typeOverlay && this.typeOverlay !== 'footprint') || settings.sessionBreaks || this.zoomBox || (this.trail && this.trail.length) || (this.acLabels && this.acLabels.length) || this.acBox);
      if (!items.length && !extra) { if (canvas._dirty) { canvas.getContext('2d').clearRect(0, 0, canvas.width, canvas.height); canvas._dirty = false; } return; }
      const host = canvas.parentElement, dpr = window.devicePixelRatio || 1, W = host.clientWidth, H = host.clientHeight;
      if (canvas.width !== Math.round(W * dpr) || canvas.height !== Math.round(H * dpr)) { canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr); canvas.style.width = W + 'px'; canvas.style.height = H + 'px'; }
      const g = canvas.getContext('2d');
      g.setTransform(dpr, 0, 0, dpr, 0, 0); g.clearRect(0, 0, W, H); canvas._dirty = true;
      const pw = W - chart.priceScale('right').width(), ph = H - (chart.timeScale().options().visible ? chart.timeScale().height() : 0);
      g.save(); g.beginPath(); g.rect(0, 0, pw, ph); g.clip();
      const xy = (t, p) => this.toXY(t, p, series, chart);
      const vr = chart.timeScale().getVisibleLogicalRange();
      const i0 = vr ? Math.max(0, Math.floor(vr.from) - 1) : 0, i1 = vr ? Math.min(this.basis.length - 1, Math.ceil(vr.to) + 1) : this.basis.length - 1;
      for (const st of items) {
        const rt = this.rts.get(st.uid);
        for (const f of rt.def.fills || []) this.drawFill(g, rt, st, f, rt.series[f.a] || series, chart, i0, i1);
        for (const gr of rt.graphics || []) this.drawGraphic(g, gr, xy, pw, ph);
      }
      if (canvas.parentElement.classList.contains('main')) { this.drawTypeExtras(g, series, chart, i0, i1, pw); this.drawSessionBreaks(g, chart, i0, i1, ph); this.drawACLabels(g, chart, i0, i1); }
      g.restore();
      if (canvas.parentElement.classList.contains('main')) this.drawPointerFx(g);
    }
    drawFill(g, rt, st, f, series, chart, i0, i1) {
      const a = rt.vals[f.a], b = typeof f.b === 'number' ? null : rt.vals[f.b];
      if (!a) return;
      g.fillStyle = f.color || 'rgba(41,98,255,.12)';
      let open = false; const back = [];
      const flush = () => { if (!open) return; for (let k = back.length - 1; k >= 0; k--) g.lineTo(back[k].x, back[k].y); g.closePath(); g.fill(); open = false; back.length = 0; };
      for (let i = i0; i <= i1; i++) {
        const va = a[i], vb = b ? b[i] : f.b;
        if (!ok(va) || !ok(vb)) { flush(); continue; }
        const x = this.logicalToX(i, chart), ya = series.priceToCoordinate(va), yb = series.priceToCoordinate(vb);
        if (x == null || ya == null || yb == null) { flush(); continue; }
        if (!open) { g.beginPath(); g.moveTo(x, ya); open = true; } else g.lineTo(x, ya);
        back.push({ x, y: yb });
      }
      flush();
    }
    drawGraphic(g, gr, xy, pw, ph) {
      const dash = [[], [6, 4], [2, 3]];
      const label = (text, x, y, color, bg, align = 'left', base = 'middle') => {
        g.font = '11px -apple-system, BlinkMacSystemFont, sans-serif';
        const w = g.measureText(text).width + 8, h = 16;
        const bx = align === 'center' ? x - w / 2 : align === 'right' ? x - w : x, by = base === 'middle' ? y - h / 2 : base === 'bottom' ? y - h : y;
        if (bg) { g.fillStyle = bg; g.fillRect(bx, by, w, h); }
        g.fillStyle = color || '#d1d4dc'; g.textBaseline = 'middle'; g.textAlign = 'left'; g.fillText(text, bx + 4, by + h / 2);
      };
      switch (gr.kind) {
        case 'line': {
          let a = xy(gr.t1, gr.p1), b = xy(gr.t2, gr.p2);
          if (!a || !b) return;
          if (gr.extend && gr.extend !== 'none') {
            const dx = b.x - a.x, dy = b.y - a.y, L = Math.hypot(dx, dy) || 1, K = 8000;
            if (gr.extend === 'right' || gr.extend === 'both') b = { x: b.x + (dx / L) * K, y: b.y + (dy / L) * K };
            if (gr.extend === 'left' || gr.extend === 'both') a = { x: a.x - (dx / L) * K, y: a.y - (dy / L) * K };
          }
          g.strokeStyle = gr.color || '#2962ff'; g.lineWidth = gr.width || 1; g.setLineDash(dash[gr.style || 0] || []);
          g.beginPath(); g.moveTo(a.x, a.y); g.lineTo(b.x, b.y); g.stroke(); g.setLineDash([]);
          if (gr.label) label(gr.label, Math.min(Math.max(a.x, b.x), pw - 4), b.y, gr.color, null, 'right', 'bottom');
          return;
        }
        case 'box': {
          const a = xy(gr.t1, gr.p1), b = xy(gr.t2, gr.p2);
          if (!a || !b) return;
          const x = Math.min(a.x, b.x), y = Math.min(a.y, b.y), w = Math.abs(b.x - a.x), h = Math.abs(b.y - a.y);
          if (gr.fill) { g.fillStyle = gr.fill; g.fillRect(x, y, w, h); }
          if (gr.color) { g.strokeStyle = gr.color; g.lineWidth = 1; g.strokeRect(x, y, w, h); }
          if (gr.text) label(gr.text, x + 2, y + 9, gr.textColor || gr.color);
          return;
        }
        case 'label': {
          const a = xy(gr.t, gr.p);
          if (a) label(gr.text, a.x, a.y, gr.color, gr.bg, gr.align || 'center', gr.base || 'middle');
          return;
        }
        case 'polyline': {
          const pts = (gr.pts || []).map((p) => xy(p.t, p.p)).filter(Boolean);
          if (pts.length < 2) return;
          g.beginPath(); pts.forEach((p, i) => (i ? g.lineTo(p.x, p.y) : g.moveTo(p.x, p.y)));
          if (gr.fill) { g.fillStyle = gr.fill; g.closePath(); g.fill(); }
          if (gr.color) { g.strokeStyle = gr.color; g.lineWidth = gr.width || 1; g.setLineDash(dash[gr.style || 0] || []); if (!gr.fill) g.stroke(); else { g.beginPath(); pts.forEach((p, i) => (i ? g.lineTo(p.x, p.y) : g.moveTo(p.x, p.y))); g.stroke(); } g.setLineDash([]); }
          return;
        }
        case 'hprofile': case 'tpo': {
          const rows = gr.rows || [];
          if (!rows.length) return;
          const lastT = this.basis.length ? this.basis[this.basis.length - 1].time : gr.t0;
          const a = xy(gr.t0, rows[0].p0), b = xy(gr.t1 == null ? lastT : gr.t1, rows[0].p0);
          if (!a || !b) return;
          let x0, span;
          if (gr.anchor === 'right') { span = pw * (gr.widthPct || 0.25); x0 = pw - span; }
          else { x0 = a.x; span = Math.max(4, (b.x - a.x) * (gr.widthPct || 0.6)); }
          if (x0 > pw || x0 + span < 0) return;
          const max = Math.max(...rows.map((r) => (gr.kind === 'tpo' ? (r.letters || '').length : (r.up || 0) + (r.down || 0))), 1);
          const C = gr.colors || {};
          for (const r of rows) {
            const y0 = this.overlayY(r.p1), y1 = this.overlayY(r.p0);
            if (y0 == null || y1 == null) continue;
            const h = Math.max(1, Math.abs(y1 - y0) - 1), top = Math.min(y0, y1);
            if (top > ph || top + h < 0) continue;
            const inVA = gr.vah != null && r.p0 >= gr.val - 1e-9 && r.p1 <= gr.vah + 1e-9;
            if (gr.kind === 'tpo') {
              const letters = r.letters || '', w = (letters.length / max) * span;
              g.fillStyle = alpha(gr.color || '#2962ff', inVA ? 0.45 : 0.22);
              g.fillRect(gr.anchor === 'right' ? pw - w : x0, top, w, h);
              if (h >= 9) { g.fillStyle = T().text; g.font = `${Math.min(11, h)}px ui-monospace, Menlo, monospace`; g.textBaseline = 'middle'; g.fillText(letters.slice(0, Math.floor(w / 7)), (gr.anchor === 'right' ? pw - w : x0) + 1, top + h / 2); }
              continue;
            }
            const wu = ((r.up || 0) / max) * span, wd = ((r.down || 0) / max) * span;
            const left = gr.anchor === 'right' ? pw - wu - wd : x0;
            g.fillStyle = alpha(C.up || '#26a69a', inVA ? 0.6 : 0.3); g.fillRect(left, top, wu, h);
            g.fillStyle = alpha(C.down || '#ef5350', inVA ? 0.6 : 0.3); g.fillRect(left + wu, top, wd, h);
          }
          if (gr.poc != null) {
            const y = this.overlayY(gr.poc);
            if (y != null) { g.strokeStyle = (gr.colors && gr.colors.poc) || '#f7b924'; g.lineWidth = 1.5; g.beginPath(); g.moveTo(x0, y); g.lineTo(gr.anchor === 'right' ? pw : x0 + span, y); g.stroke(); }
          }
          return;
        }
        default:
      }
    }
    overlayY(p) { return this.overlay.priceToCoordinate(p); }
    drawTypeExtras(g, series, chart, i0, i1, pw) {
      const ex = this.typeExtra;
      if (ex && ex.high && ex.low) {
        g.fillStyle = alpha('#2962ff', 0.15);
        g.beginPath(); let started = false; const back = [];
        for (let i = i0; i <= i1; i++) {
          const x = this.logicalToX(i, chart), yh = series.priceToCoordinate(ex.high[i]), yl = series.priceToCoordinate(ex.low[i]);
          if (x == null || yh == null || yl == null) continue;
          if (!started) { g.moveTo(x, yh); started = true; } else g.lineTo(x, yh);
          back.push({ x, y: yl });
        }
        for (let k = back.length - 1; k >= 0; k--) g.lineTo(back[k].x, back[k].y);
        if (started) { g.closePath(); g.fill(); }
      }
      if (this.footprintOn()) this.drawFootprint(g, chart, i0, i1, pw);
      if (this.typeOverlay === 'tpo' || this.typeOverlay === 'svp') {
        const def = Object.values(IND.BY_ID).find((d) => (this.typeOverlay === 'tpo' ? /tpo|time.?price/i.test(d.id + d.name) : /session.*volume.*profile|svp/i.test(d.id + d.name)));
        if (!def) return;
        if (!this._typeProfile || this._typeProfile.n !== this.basis.length || this._typeProfile.id !== def.id) {
          let out = {};
          try { out = def.calc(this.basis, IND.defaults(def), { src: (k) => this.srcArray(this.basis, k), tfSec: this.tfSec, symbol: this.state.symbol, decimals: this.decimals }); } catch (e) { console.warn(e); }
          this._typeProfile = { n: this.basis.length, id: def.id, graphics: out.graphics || [] };
        }
        const xy = (t, p) => this.toXY(t, p, series, chart);
        for (const gr of this._typeProfile.graphics) this.drawGraphic(g, gr, xy, pw, 1e5);
      }
    }

    // AI Chance labels drawn like Pine label.new(): coloured box with a pointer, white text, dashed connector to the bar
    drawACLabels(g, chart, i0, i1) {
      if (!this.state.ac) return;
      if (this.acBox) this.drawStmnBox(g, chart, this.acBox);
      const L = this.acLabels;
      if (!L || !L.length) return;
      const Y = (p) => (ok(p) ? this.overlay.priceToCoordinate(p) : null);
      const FS = { tiny: 9, small: 11, normal: 13, large: 15 };
      for (const l of L) {
        const i = this.idx.get(l.time);
        if (i == null || i < i0 - 2 || i > i1 + 2) continue;
        if (l.kind === 'stmn' && this.acBox && l.time === this.acBox.time) continue;
        const xb = this.logicalToX(i, chart), x = this.logicalToX(i + (l.dx || 0), chart), y0 = Y(l.y);
        const y = y0 == null || !l.gap ? y0 : y0 + (l.style === 'down' ? -l.gap : l.style === 'up' ? l.gap : 0);
        if (xb == null || x == null || y == null) continue;
        if (l.lineCss && ok(l.y2)) {
          const ya = Y(ok(l.ly1) ? l.ly1 : l.y), yb = Y(l.y2);
          if (ya != null && yb != null) { g.strokeStyle = l.lineCss; g.lineWidth = 1; g.setLineDash([3, 3]); g.beginPath(); g.moveTo(xb, ya); g.lineTo(xb, yb); g.stroke(); g.setLineDash([]); }
        }
        if (l.hline) { const xa = this.logicalToX(i + l.hline.from, chart); if (xa != null) { g.strokeStyle = l.hline.css; g.lineWidth = 1; g.beginPath(); g.moveTo(xa, y); g.lineTo(xb, y); g.stroke(); } }
        const fs = this.acTiny ? Math.min(9, FS[l.size || 'small'] || 9) : FS[l.size || 'small'] || 11;
        g.font = '500 ' + fs + 'px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
        const lines = String(l.text).split('\n'), lh = Math.round(fs * 1.3);
        const w = Math.max(...lines.map((t) => g.measureText(t).width)) + 12, h = lines.length * lh + 6, ptr = 5, r = 3;
        let bx, by;
        if (l.style === 'down') { bx = x - w / 2; by = y - ptr - h; }
        else if (l.style === 'left') { bx = x + ptr; by = y - h / 2; }
        else if (l.style === 'up') { bx = x - w / 2; by = y + ptr; }
        else { bx = x - w / 2; by = y - h / 2; }
        g.fillStyle = l.css;
        g.beginPath();
        if (g.roundRect) g.roundRect(bx, by, w, h, r); else g.rect(bx, by, w, h);
        g.fill();
        g.beginPath();
        if (l.style === 'down') { g.moveTo(x - ptr, by + h); g.lineTo(x + ptr, by + h); g.lineTo(x, y); }
        else if (l.style === 'up') { g.moveTo(x - ptr, by); g.lineTo(x + ptr, by); g.lineTo(x, y); }
        else if (l.style === 'left') { g.moveTo(bx, y - ptr); g.lineTo(bx, y + ptr); g.lineTo(x, y); }
        g.closePath(); g.fill();
        g.fillStyle = '#ffffff'; g.textAlign = 'center'; g.textBaseline = 'middle';
        lines.forEach((t, k) => g.fillText(t, bx + w / 2, by + 3 + lh / 2 + k * lh));
      }
      g.textAlign = 'left';
    }
    // STMN entry box (TAD-style): red stop zone, green target zone with TP lines, info card with entry, risk and lot size
    stmnLots(box) {
      const P = window.IGPaper && window.IGPaper.engine, acct = window.IGC.store.get('mod.paper.v1', null);
      const sp = P ? P.specOf(acct && acct.specs ? acct : P.create(), this.state.symbol) : { contract: 1, minLot: 0.01, lotStep: 0.01 };
      const raw = (+this.shell.acOpts().riskUsd || 50) / (Math.abs(box.el - box.sl) * (sp.contract || 1));
      const lots = Math.max(sp.minLot || 0.01, Math.floor(raw / (sp.lotStep || 0.01) + 1e-9) * (sp.lotStep || 0.01));
      return { lots: Math.round(lots * 100) / 100, contract: sp.contract };
    }
    drawStmnBox(g, chart, b) {
      const i = this.idx.get(b.time);
      if (i == null) return;
      const x0 = this.logicalToX(i + 1, chart), x1 = this.logicalToX(i + 21, chart), Y = (p) => this.overlay.priceToCoordinate(p);
      const yE = Y(b.el), yS = Y(b.sl), yT = b.tps.map(Y);
      if (x0 == null || x1 == null || yE == null || yS == null || yT.some((v) => v == null)) return;
      const done = b.status !== 'open', fade = done ? 0.5 : 1;
      g.fillStyle = 'rgba(239,83,80,' + 0.16 * fade + ')'; g.fillRect(x0, Math.min(yE, yS), x1 - x0, Math.abs(yS - yE));
      g.fillStyle = 'rgba(38,166,154,' + 0.12 * fade + ')'; g.fillRect(x0, Math.min(yE, yT[2]), x1 - x0, Math.abs(yT[2] - yE));
      g.lineWidth = 1.5; g.strokeStyle = 'rgba(178,40,51,' + 0.9 * fade + ')'; g.setLineDash([6, 4]); g.beginPath(); g.moveTo(x0, yS); g.lineTo(x1, yS); g.stroke(); g.setLineDash([]);
      g.strokeStyle = 'rgba(27,94,80,' + fade + ')'; g.beginPath(); g.moveTo(x0, yE); g.lineTo(x1, yE); g.stroke();
      g.lineWidth = 1; g.strokeStyle = 'rgba(27,127,92,' + 0.8 * fade + ')';
      yT.forEach((y, k) => { g.beginPath(); g.moveTo(x0, y); g.lineTo(x1, y); g.stroke(); g.fillStyle = 'rgba(27,127,92,' + fade + ')'; g.font = '10px -apple-system, sans-serif'; g.textAlign = 'right'; g.textBaseline = 'bottom'; g.fillText('TP' + (k + 1) + (b.hit > k ? ' ✓' : ''), x1 - 2, y - 1); });
      const { lots } = this.stmnLots(b);
      const lines = [(b.dir === -1 ? 'STMN −' : 'STMN +') + (done ? (b.status === 'stopped' ? ' · stopped' : ' · target') : ''), 'EL: ' + this.fmt(b.el), 'Risk $' + (+this.shell.acOpts().riskUsd || 50) + ' · ' + lots + ' lots'];
      g.font = '500 11px -apple-system, BlinkMacSystemFont, sans-serif';
      const w = Math.max(...lines.map((t) => g.measureText(t).width)) + 16, h = lines.length * 14 + 8;
      // TAD-style: the card sits right above (short) or below (long) the signal candle and points at it.
      const xs = this.logicalToX(i, chart) ?? x0, cx = xs, bar = this.candles[i];
      const yB = bar ? Y(b.dir === -1 ? bar.high : bar.low) : yE;
      const by = b.dir === -1 ? Math.min(yS, yE, yB ?? yE) - 8 - h : Math.max(yS, yE, yB ?? yE) + 8;
      g.fillStyle = 'rgba(47,111,111,' + 0.92 * fade + ')';
      g.beginPath(); if (g.roundRect) g.roundRect(cx - w / 2, by, w, h, 3); else g.rect(cx - w / 2, by, w, h); g.fill();
      g.beginPath(); if (b.dir === -1) { g.moveTo(cx - 5, by + h); g.lineTo(cx + 5, by + h); g.lineTo(cx, by + h + 6); } else { g.moveTo(cx - 5, by); g.lineTo(cx + 5, by); g.lineTo(cx, by - 6); } g.fill();
      g.fillStyle = '#fff'; g.textAlign = 'center'; g.textBaseline = 'middle';
      lines.forEach((t, k) => g.fillText(t, cx, by + 4 + 7 + k * 14));
      g.textAlign = 'left';
    }
    renderACStats(S) {
      let el = this.q('.ac-stats');
      if (!S) { if (el) el.remove(); return; }
      if (!el) { el = document.createElement('div'); el.className = 'ac-stats'; this.q('.pane.main').appendChild(el); }
      const pct = (x) => (x.w + x.l ? Math.round((100 * x.w) / (x.w + x.l)) + '%' : '—');
      const all = ['setups', 'confirmed', 'w', 'l', 'open'].reduce((a, k) => ({ ...a, [k]: S.buy[k] + S.sell[k] }), {});
      const days = Math.max(1, Math.round((S.to - S.from) / 86400));
      const cap = this.serverMaxBars || 5000, need = Math.min(cap, Math.ceil((S.days * 86400) / (S.tfSec || 300)) + 100);
      const ext = (this.histSources || []).find((x) => x.provider !== 'ig' && x.provider !== 'mock');
      const d = (t) => new Date(t * 1000).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
      const row = (k, f) => '<tr><td>' + k + '</td><td>' + f(S.buy) + '</td><td>' + f(S.sell) + '</td><td>' + f(all) + '</td></tr>';
      el.innerHTML = '<table><thead><tr><th>STMN · ' + esc(ivLabel(this.state.interval)) + '</th><th class="up">BUY</th><th class="down">SELL</th><th>ALL</th></tr></thead><tbody>'
        + row('setups', (x) => x.setups) + row('confirmed', (x) => x.confirmed) + row('w/l', (x) => x.w + '-' + x.l)
        + '<tr class="win"><td>win</td><td>' + pct(S.buy) + '</td><td>' + pct(S.sell) + '</td><td>' + pct(all) + '</td></tr>'
        + row('open', (x) => x.open)
        + '<tr class="win-note"><td title="Statistics cover only the bars inside the window">⚠ window</td><td colspan="3">' + d(S.from) + '–' + d(S.to) + ' · ' + days + 'd · ' + (S.bars >= 1000 ? (S.bars / 1000).toFixed(1) + 'k' : S.bars) + '</td></tr>'
        + (S.partial && need > this.candles.length + 50 ? '<tr class="win-load"><td colspan="4"><button data-act="stats-load" title="' + (cap > 5000 ? 'Recent bars from IG, older bars from a free history source (Bitstamp / Dukascopy), aligned to IG prices' : 'Uses about ' + need + ' points of the IG weekly history allowance') + '">Only ' + days + 'd of ' + S.days + 'd loaded · Load ' + need + ' bars</button></td></tr>' : S.partial ? '<tr class="win-note"><td colspan="4">' + (cap > 5000 ? 'History available: ' : 'IG max 5,000 bars: ') + days + 'd of ' + S.days + 'd</td></tr>' : '')
        + (ext ? '<tr class="win-note"><td colspan="4" title="Bars before ' + d(ext.to) + ' come from ' + esc(ext.provider) + ' ' + esc(ext.instrument) + ', shifted ' + ext.offset + ' to match IG (' + ext.matched + ' overlapping bars)">older bars: ' + esc(ext.provider) + (ext.partial ? ' (partial)' : '') + '</td></tr>' : '')
        + '</tbody></table>';
      const lb = el.querySelector('[data-act=stats-load]');
      if (lb) lb.onclick = () => { this.loadBars = need; this.load({ bars: need }); window.IGC.toast('Loading ' + need + ' bars for the stats window…'); };
    }
    // session breaks: a dashed line where the trading day (in the chosen timezone) or the IG session changes
    drawSessionBreaks(g, chart, i0, i1, ph) {
      if (!settings.sessionBreaks || this.tfSec >= 86400 || !this.basis.length) return;
      const dayKey = (t) => window.IGC.dtf({ year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(t * 1000));
      g.strokeStyle = alpha(T().text === '#9aa4b2' ? '#5d6673' : '#9598a1', 0.9); g.lineWidth = 1; g.setLineDash([4, 4]);
      let prev = i0 > 0 ? dayKey(this.basis[i0 - 1].time) : null;
      for (let i = Math.max(1, i0); i <= i1; i++) {
        const b = this.basis[i]; if (!b) continue;
        const k = dayKey(b.srcTime ?? b.time);
        if (prev && k !== prev) { const x = this.logicalToX(i - 0.5, chart); if (x != null) { g.beginPath(); g.moveTo(x, 0); g.lineTo(x, ph); g.stroke(); } }
        prev = k;
      }
      g.setLineDash([]);
    }
    // pointer effects: demonstration-cursor trail and the zoom-tool box
    drawPointerFx(g) {
      if (this.zoomBox) { const z = this.zoomBox; g.fillStyle = 'rgba(41,98,255,.12)'; g.strokeStyle = '#2962ff'; g.lineWidth = 1; g.fillRect(Math.min(z.x0, z.x1), 0, Math.abs(z.x1 - z.x0), this.el.clientHeight); g.strokeRect(Math.min(z.x0, z.x1), 0, Math.abs(z.x1 - z.x0), this.el.clientHeight); }
      if (this.trail && this.trail.length) {
        const now = performance.now();
        this.trail = this.trail.filter((p) => now - p.t < 700);
        for (let k = 1; k < this.trail.length; k++) { const a = this.trail[k - 1], b = this.trail[k]; g.strokeStyle = 'rgba(255,82,82,' + (1 - (now - b.t) / 700).toFixed(2) + ')'; g.lineWidth = 4; g.lineCap = 'round'; g.beginPath(); g.moveTo(a.x, a.y); g.lineTo(b.x, b.y); g.stroke(); }
      }
    }
    setCursor(mode) {
      this.cursorMode = mode;
      const t = T(), lines = mode === 'cross' || mode === 'demo';
      this.chart.applyOptions({ crosshair: { vertLine: { visible: lines, labelVisible: mode !== 'arrow' }, horzLine: { visible: lines, labelVisible: mode !== 'arrow' } } });
      this.el.dataset.cursor = mode;
      if (mode !== 'demo') this.trail = [];
      void t;
    }
    setupFreeDrag() {
      this.el.addEventListener('mousedown', (e) => {
        if (e.button !== 0 || e.shiftKey || this.zoomTool || (this.draw && this.draw.tool)) return;
        if (this.draw && this.draw.hitAt && this.draw.hitAt(e)) return;
        const r = this.el.getBoundingClientRect(), x = e.clientX - r.left;
        if (x > this.el.clientWidth - this.chart.priceScale('right').width()) return;
        const ps = this.chart.priceScale('right');
        if (!ps.options().autoScale) return;
        ps.applyOptions({ autoScale: false });
        const y0 = e.clientY; let moved = false;
        const mv = (ev) => { if (Math.abs(ev.clientY - y0) > 4) moved = true; };
        const up = () => {
          window.removeEventListener('mousemove', mv); window.removeEventListener('mouseup', up);
          if (!moved) ps.applyOptions({ autoScale: true });
          this.shell.onAutoScale && this.shell.onAutoScale(this);
        };
        window.addEventListener('mousemove', mv); window.addEventListener('mouseup', up);
      }, true);
    }
    isAutoScale() { return !!this.chart.priceScale('right').options().autoScale; }
    setZoomTool(on) { this.zoomTool = on; this.el.dataset.zoom = on ? '1' : ''; }
    setupPointer() {
      this.el.addEventListener('mousemove', (e) => {
        if (this.cursorMode !== 'demo') return;
        const r = this.el.getBoundingClientRect();
        (this.trail = this.trail || []).push({ x: e.clientX - r.left, y: e.clientY - r.top, t: performance.now() });
        if (this.trail.length > 60) this.trail.shift();
      });
      this.el.addEventListener('mousedown', (e) => {
        if (!this.zoomTool || e.button !== 0) return;
        e.stopPropagation(); e.preventDefault();
        const r = this.el.getBoundingClientRect();
        this.zoomBox = { x0: e.clientX - r.left, x1: e.clientX - r.left };
        const mv = (ev) => { this.zoomBox.x1 = ev.clientX - r.left; };
        const up = () => {
          window.removeEventListener('mousemove', mv); window.removeEventListener('mouseup', up);
          const z = this.zoomBox; this.zoomBox = null;
          if (Math.abs(z.x1 - z.x0) < 8) return;
          const ts = this.chart.timeScale(), a = ts.coordinateToLogical(Math.min(z.x0, z.x1)), b = ts.coordinateToLogical(Math.max(z.x0, z.x1));
          if (a == null || b == null) return;
          (this.zoomStack = this.zoomStack || []).push(ts.getVisibleLogicalRange());
          ts.setVisibleLogicalRange({ from: a, to: b });
          this.shell.onZoomed && this.shell.onZoomed(this);
        };
        window.addEventListener('mousemove', mv); window.addEventListener('mouseup', up);
      }, true);
    }
    zoomOut() { const r = (this.zoomStack || []).pop(); if (r) this.chart.timeScale().setVisibleLogicalRange(r); else this.resetView(); }
    setInvert(on) { this.state.invert = !!on; this.chart.priceScale('right').applyOptions({ invertScale: this.state.invert }); this.shell.persist(); }
    setEvents(list) { this.events = list || []; this.refreshMarkers(); }
    // restore a serialized state (undo / redo of indicator and chart changes)
    restoreState(s) {
      const reload = s.symbol !== this.state.symbol || s.interval !== this.state.interval || (s.side || 'mid') !== (this.state.side || 'mid');
      for (const st of [...this.state.studies]) this.unmountStudy(st);
      const copy = JSON.parse(JSON.stringify(s));
      copy.studies = (copy.studies || []).map((x) => ({ ...x, params: { ...(IND.BY_ID[x.id] ? IND.defaults(IND.BY_ID[x.id]) : {}), ...(x.params || {}) }, styles: x.styles || {}, visible: x.visible !== false }));
      Object.assign(this.state, copy);
      this.switchSeries(this.typeInfo().series);
      this.chart.priceScale('right').applyOptions({ invertScale: !!this.state.invert });
      if (reload) this.load();
      else { this.renderAll(); this.reattach(); this.loadCompares(); this.loadHtfStudies(); this.applyScale(); }
      this.buildStudyLegends();
      this.shell.persist();
    }

    // ── footprint (live ticks only: IG has no traded volume at price) ─
    footprintOn() { return this.typeOverlay === 'footprint'; }
    recordFootprint(tms, price) {
      const b = this.candles[this.candles.length - 1];
      if (!b) return;
      const step = 10 ** -this.decimals * (this.decimals > 2 ? 10 : 1) * 10;
      const lvl = Math.round(price / step) * step;
      let m = this.footprint.get(b.time);
      if (!m) { m = { levels: new Map(), last: null }; this.footprint.set(b.time, m); if (this.footprint.size > 400) this.footprint.delete(this.footprint.keys().next().value); }
      const r = m.levels.get(lvl) || { up: 0, down: 0 };
      if (m.last != null) { if (price > m.last) r.up++; else if (price < m.last) r.down++; }
      m.last = price; m.levels.set(lvl, r);
    }
    drawFootprint(g, chart, i0, i1) {
      const ts = chart.timeScale(), bs = Math.max(4, (this.logicalToX(1, chart) - this.logicalToX(0, chart)) || 6);
      g.font = '9px ui-monospace, Menlo, monospace'; g.textBaseline = 'middle';
      for (let i = i0; i <= i1; i++) {
        const b = this.basis[i]; if (!b) continue;
        const m = this.footprint.get(b.time); if (!m) continue;
        const x = this.logicalToX(i, chart); if (x == null) continue;
        for (const [lvl, r] of m.levels) {
          const y = this.overlay.priceToCoordinate(lvl); if (y == null) continue;
          const tot = r.up + r.down || 1;
          g.fillStyle = alpha(r.up >= r.down ? settings.up : settings.down, 0.15 + 0.5 * Math.abs(r.up - r.down) / tot);
          g.fillRect(x - bs / 2, y - 5, bs, 10);
          if (bs > 34) { g.fillStyle = T().text; g.textAlign = 'center'; g.fillText(`${r.down}x${r.up}`, x, y); }
        }
      }
      void ts;
    }

    // ── host overlays (strategy tester, paper trading) ──
    setOverlay(owner, spec, handlers) {
      const prev = this.hostOverlays.get(owner);
      if (prev) for (const pl of prev.pls || []) { try { this.overlay.removePriceLine(pl.handle); } catch {} }
      const o = { spec: spec || {}, handlers: handlers || {}, pls: [] };
      for (const ln of o.spec.lines || []) {
        const handle = this.overlay.createPriceLine({ price: ln.price, color: ln.color || '#2962ff', lineWidth: ln.width || 1, lineStyle: ln.style ?? 0, axisLabelVisible: true, title: ln.title || '' });
        o.pls.push({ ...ln, handle });
      }
      this.hostOverlays.set(owner, o);
      this.refreshMarkers();
    }
    clearOverlay(owner) {
      const o = this.hostOverlays.get(owner);
      if (!o) return;
      for (const pl of o.pls) { try { this.overlay.removePriceLine(pl.handle); } catch {} }
      this.hostOverlays.delete(owner);
      this.refreshMarkers();
    }
    setupDragLines() {
      const hitLine = (y) => {
        for (const [owner, o] of this.hostOverlays) for (const pl of o.pls) {
          if (!pl.draggable) continue;
          const py = this.overlay.priceToCoordinate(pl.price);
          if (py != null && Math.abs(py - y) < 5) return { owner, o, pl };
        }
        return null;
      };
      this.el.addEventListener('mousedown', (e) => {
        if (e.button !== 0) return;
        const r = this.el.getBoundingClientRect(), y = e.clientY - r.top;
        const h = hitLine(y);
        if (!h) return;
        e.stopPropagation(); e.preventDefault();
        const mv = (ev) => { const p = this.overlay.coordinateToPrice(ev.clientY - r.top); if (p != null) { h.pl.price = p; h.pl.handle.applyOptions({ price: p }); } };
        const up = () => { window.removeEventListener('mousemove', mv); window.removeEventListener('mouseup', up); h.o.handlers.onDrag && h.o.handlers.onDrag(h.pl.id, h.pl.price); };
        window.addEventListener('mousemove', mv); window.addEventListener('mouseup', up);
      }, true);
      this.el.addEventListener('mousemove', (e) => { if (e.buttons) return; const r = this.el.getBoundingClientRect(); if (hitLine(e.clientY - r.top)) this.el.style.cursor = 'ns-resize'; });
    }

    // ── alerts lines ────────────────────────────────────
    renderAlertLines() {
      for (const pl of this.alertPLs) { try { this.overlay.removePriceLine(pl); } catch {} }
      this.alertPLs = [];
      for (const a of this.shell.alertLines(this.state.symbol)) this.alertPLs.push(this.overlay.createPriceLine({ price: a.price, color: a.color || '#f7b924', lineWidth: 1, lineStyle: 1, axisLabelVisible: true, title: a.title || '🔔' }));
    }

    // ── compare symbols ─────────────────────────────────
    async loadCompares() {
      for (const c of this.compareRT) this.chart.removeSeries(c.series);
      this.compareRT = [];
      const palette = ['#ff9800', '#e040fb', '#00bcd4', '#8bc34a', '#ffeb3b', '#f06292'];
      for (const [k, c] of this.state.compares.entries()) {
        const series = this.chart.addLineSeries({ color: c.color || palette[k % palette.length], lineWidth: 2, priceLineVisible: false, lastValueVisible: true, title: nameOf(c.epic) });
        const rt = { epic: c.epic, series, bars: [] };
        this.compareRT.push(rt);
        try {
          const sp = this.spec.kind === 'time' ? this.spec : parseIv('1');
          const { bars } = await this.fetchSeries(c.epic, sp, Math.min(this.candles.length || 500, 2000));
          rt.bars = bars;
          series.setData(bars.map((b) => ({ time: b.time, value: b.close })));
        } catch (e) { console.warn('[compare]', c.epic, e.message); }
      }
      this.applyScale(); this.updateLegend();
    }
    tickCompare(rt, q) {
      const price = mid(q), sp = this.spec;
      if (!ok(price) || !rt.bars.length || sp.kind !== 'time') return;
      const t = barStart(Math.floor((q.t || Date.now()) / 1000), sp), last = rt.bars[rt.bars.length - 1];
      if (t < last.time) return;
      if (t === last.time) last.close = price; else rt.bars.push({ time: t, open: price, high: price, low: price, close: price });
      rt.series.update({ time: t, value: price });
    }
    addCompare(epic) {
      if (!epic || epic === this.state.symbol || this.state.compares.some((c) => c.epic === epic)) return;
      this.state.compares.push({ epic });
      this.updateSubscriptions(); this.loadCompares(); this.shell.persist();
    }
    removeCompare(epic) {
      this.state.compares = this.state.compares.filter((c) => c.epic !== epic);
      this.updateSubscriptions(); this.loadCompares(); this.shell.persist();
    }

    // ── scale ───────────────────────────────────────────
    setScale(s) { this.state.scale = this.state.scale === s ? 'normal' : s; this.applyScale(); this.shell.persist(); }
    // Lock price-to-bar ratio: keep (price per pixel × bar spacing) constant while zooming; the range stays centred on the data.
    setLockRatio(on) {
      if (on) {
        const ps = this.chart.priceScale('right'), h = this.mainHeight();
        const top = this.overlay.coordinateToPrice(0), bot = this.overlay.coordinateToPrice(h);
        const bs = this.chart.timeScale().options().barSpacing;
        if (!(h > 0) || top == null || bot == null || this.effectiveScale === 'log') { window.IGC.toast('Ratio lock needs a normal (linear) price scale'); return; }
        this.state.lockRatio = (Math.abs(top - bot) / h) * bs;
        ps.applyOptions({ autoScale: true });
      } else this.state.lockRatio = null;
      this.chart.timeScale().applyOptions({}); this.shell.persist();
    }
    mainHeight() { const r = this.el && this.el.querySelector('canvas'); return (this.chart.paneSize ? this.chart.paneSize().height : 0) || (r ? r.clientHeight : this.el.clientHeight); }
    lockedRange(base) {
      if (!this.state.lockRatio || !base || !base.priceRange) return base;
      const m = this.chart.priceScale('right').options().scaleMargins || { top: 0.1, bottom: 0.08 };
      const h = this.mainHeight() * (1 - m.top - m.bottom), bs = this.chart.timeScale().options().barSpacing;
      if (!(h > 0) || !(bs > 0)) return base;
      const span = (this.state.lockRatio / bs) * this.mainHeight(), c = (base.priceRange.minValue + base.priceRange.maxValue) / 2;
      const inner = span * (h / this.mainHeight());
      return { ...base, priceRange: { minValue: c - inner / 2, maxValue: c + inner / 2 } };
    }
    setScalePriceOnly(on) { this.state.scalePriceOnly = !!on; this.chart.timeScale().applyOptions({}); this.autoFit(); this.shell.persist(); }
    applyScale() {
      const s = this.state.compares.length && this.state.scale === 'normal' ? 'percent' : this.state.scale;
      const mode = s === 'log' ? LW.PriceScaleMode.Logarithmic : s === 'percent' ? LW.PriceScaleMode.Percentage : s === 'indexed' ? LW.PriceScaleMode.IndexedTo100 : LW.PriceScaleMode.Normal;
      this.chart.priceScale('right').applyOptions({ mode, autoScale: true, invertScale: !!this.state.invert });
      this.effectiveScale = s;
    }
    autoFit() { this.chart.priceScale('right').applyOptions({ autoScale: true }); this.shell.onAutoScale && this.shell.onAutoScale(this); }
    resetView() {
      this.autoFit();
      this.toLatest();
    }
    // Anchor on the newest bar. Positions are relative to the right edge, so extra points added to the time scale by
    // other series (AI Chance, compares, other-timeframe studies, stale data from the previous interval) can't shift the view into old bars.
    toLatest(bars = 150) {
      const n = this.disp.length;
      if (!n) return;
      const ts = this.chart.timeScale(), k = Math.max(10, Math.min(bars, n)), RIGHT = 8;
      const w = this.el.clientWidth - (this.chart.priceScale('right').width() || 74);
      this.applyingRange = true;
      if (w > 0) ts.applyOptions({ barSpacing: Math.max(0.5, w / (k + RIGHT)) });
      ts.scrollToPosition(RIGHT, false);
      this.applyingRange = false;
    }
    goTo(t) {
      const l = this.timeToLogical(t);
      if (l == null) return;
      const r = this.chart.timeScale().getVisibleLogicalRange(), w = r ? r.to - r.from : 150;
      this.chart.timeScale().setVisibleLogicalRange({ from: l - w / 2, to: l + w / 2 });
    }

    // ── quote / legend ──────────────────────────────────
    removeQuoteLines() { for (const pl of [this.bidLine, this.askLine]) if (pl) { try { this.overlay.removePriceLine(pl); } catch {} } this.bidLine = this.askLine = null; }
    updateQuote() {
      const q = quotes[this.state.symbol];
      const row = this.q('.lg-q');
      if (row && q) {
        const set = (k, v) => { const e = row.querySelector(`[data-q=${k}]`); if (e) e.textContent = v; };
        const bidEl = row.querySelector('[data-q=bid]'), prev = Number(bidEl && bidEl.dataset.v);
        set('bid', this.fmt(q.bid)); set('ask', this.fmt(q.offer)); set('spr', q.bid != null && q.offer != null ? this.fmt(q.offer - q.bid) : '—');
        const chg = row.querySelector('[data-q=chg]');
        if (chg) { chg.textContent = q.changePct != null ? `${q.changePct > 0 ? '+' : ''}${q.changePct.toFixed(2)}%` : '—'; chg.className = q.changePct > 0 ? 'up' : q.changePct < 0 ? 'down' : ''; }
        if (bidEl) { if (prev && q.bid !== prev) { bidEl.classList.remove('flash-up', 'flash-down'); void bidEl.offsetWidth; bidEl.classList.add(q.bid > prev ? 'flash-up' : 'flash-down'); } bidEl.dataset.v = q.bid; }
      }
      if (!q || q.bid == null || this.spread) return;
      if (settings.bidAsk && !this.rp.on) {
        if (!this.bidLine) {
          this.bidLine = this.overlay.createPriceLine({ price: q.bid, color: settings.down, lineWidth: 1, lineStyle: 2, axisLabelVisible: true, title: 'Bid' });
          this.askLine = this.overlay.createPriceLine({ price: q.offer ?? q.bid, color: settings.up, lineWidth: 1, lineStyle: 2, axisLabelVisible: true, title: 'Ask' });
        } else { this.bidLine.applyOptions({ price: q.bid }); if (q.offer != null) this.askLine.applyOptions({ price: q.offer }); }
      } else if (this.bidLine) this.removeQuoteLines();
    }
    countdown() {
      const last = this.candles[this.candles.length - 1], sp = this.spec;
      let cd = '';
      if (settings.countdown && last && !this.rp.on && sp.kind === 'time') {
        const end = sp.unit === 'M' ? barStart(last.time + 32 * 86400 * sp.n, sp) : last.time + sp.sec;
        const left = Math.round(end - Date.now() / 1000);
        if (left > 0 && left <= sp.sec * 1.2) {
          const d = Math.floor(left / 86400), h = Math.floor((left % 86400) / 3600), m = Math.floor((left % 3600) / 60), s = left % 60;
          cd = (d ? `${d}d ` : '') + (h || d ? `${h}:${String(m).padStart(2, '0')}` : String(m).padStart(2, '0')) + ':' + String(s).padStart(2, '0');
        }
      }
      const el = this.q('[data-q=cd]'); if (el) el.textContent = cd ? `⏱ ${cd}` : '';
      if (this.bidLine) this.bidLine.applyOptions({ title: cd ? `Bid ${cd}` : 'Bid' });
    }

    buildLegend() {
      const L = this.q('.legend');
      L.innerHTML = `<div class="lg-row lg-sym"><span class="lg-title"></span><span class="lg-ohlc"></span></div>
        <div class="lg-row lg-q"><span class="lbl">Bid</span><span data-q="bid">—</span><span class="lbl">Ask</span><span data-q="ask">—</span><span class="lbl">Spr</span><span data-q="spr">—</span><span class="lbl">Day</span><span data-q="chg">—</span><span data-q="cd" class="muted"></span></div>
        <div class="lg-cmp"></div><div class="lg-studies"></div>`;
      this.legendBuilt = true;
    }
    studyRow(st) {
      const def = this.defOf(st);
      if (!def) return `<div class="lg-study off" data-uid="${st.uid}"><span class="lg-name">${esc(st.id)} (not loaded)</span><span class="lg-btns" style="display:inline-flex"><button data-act="del" title="Remove">✕</button></span></div>`;
      return `<div class="lg-study${st.visible ? '' : ' off'}" data-uid="${st.uid}">
        <span class="lg-name">${esc(IND.title(def, st.params))}${st.tf ? ` <small class="muted">${esc(ivLabel(st.tf))}</small>` : ''}</span>
        <span class="lg-vals">${(def.outputs || []).map((o) => `<i data-k="${esc(o.k)}" style="color:${this.outColor(st, o)}"></i>`).join('')}</span>
        <span class="lg-btns"><button data-act="vis" title="${st.visible ? 'Hide' : 'Show'}">${st.visible ? '◉' : '○'}</button><button data-act="set" title="Settings">⚙</button><button data-act="del" title="Remove">✕</button><button data-act="more" title="More: move to pane, scale, maximize">⋯</button></span></div>`;
    }
    buildStudyLegends() {
      if (!this.legendBuilt) this.buildLegend();
      this.q('.lg-studies').innerHTML = this.state.studies.filter((s) => { const rt = this.rts.get(s.uid); return rt ? !rt.pane : this.defOf(s)?.kind !== 'pane'; }).map((s) => this.studyRow(s)).join('');
      for (const p of this.panes) p.legend.innerHTML = p.members.map((u) => this.state.studies.find((s) => s.uid === u)).filter(Boolean).map((s) => this.studyRow(s)).join('');
    }
    onLegendClick(e) {
      const sym = e.target.closest('[data-act=symbol]');
      if (sym) return this.shell.openSearch(this);
      if (e.target.closest('[data-act=link]')) { this.state.link = ((this.state.link || 0) + 1) % 6; this.updateLegend(); this.shell.persist(); return; }
      const cmp = e.target.closest('[data-cmp]');
      if (cmp) return this.removeCompare(cmp.dataset.cmp);
      const b = e.target.closest('[data-act]'), row = e.target.closest('[data-uid]');
      if (!b || !row) return;
      const u = row.dataset.uid;
      if (b.dataset.act === 'del') this.removeStudy(u);
      if (b.dataset.act === 'vis') this.toggleStudy(u);
      if (b.dataset.act === 'set') this.shell.openStudySettings(this, u);
      if (b.dataset.act === 'more') this.studyMenu(u, b);
    }
    updateLegend(i) {
      if (!this.legendBuilt) { this.buildLegend(); this.buildStudyLegends(); }
      const n = this.basis.length;
      if (i == null || i < 0 || i >= n) i = n - 1;
      const meta = typeMeta(this.state.type);
      const LINKC = ['', '#ef5350', '#26a69a', '#2962ff', '#f7b924', '#c77dff'];
      this.q('.lg-title').innerHTML = `<i class="link-dot${this.state.link ? ' on' : ''}" data-act="link" title="Symbol link group (click to change): charts with the same colour follow each other's symbol, also across windows" style="${this.state.link ? `background:${LINKC[this.state.link]}` : ''}"></i><b data-act="symbol" class="lg-symbtn" title="Change symbol">${esc(this.title() || '—')}</b> · ${esc(ivLabel(this.state.interval))}${meta && this.state.type !== 'candles' ? ` · ${esc(meta.label)}` : ''}${this.state.side && this.state.side !== 'mid' ? ` · <span class="side-tag">${this.state.side === 'bid' ? 'BID' : 'ASK'}</span>` : ''}${this.rp.on ? ' · <span class="rp-tag">REPLAY</span>' : ''}${this.typeNote ? ` <span class="muted" title="${esc(this.typeNote)}">ⓘ</span>` : ''}`;
      const bar = this.disp[i] && this.disp[i].open !== undefined ? this.disp[i] : this.basis[i];
      const O = this.q('.lg-ohlc');
      if (!bar) O.innerHTML = '';
      else {
        const prev = i ? (this.basis[i - 1] || {}).close : bar.open, ch = bar.close - prev;
        const cls = bar.close >= bar.open ? 'up' : 'down';
        O.innerHTML = `O<b class="${cls}">${this.fmt(bar.open)}</b> H<b class="${cls}">${this.fmt(bar.high)}</b> L<b class="${cls}">${this.fmt(bar.low)}</b> C<b class="${cls}">${this.fmt(bar.close)}</b> <b class="${ch >= 0 ? 'up' : 'down'}">${ch >= 0 ? '+' : ''}${this.fmt(ch)} (${ch >= 0 ? '+' : ''}${prev ? ((ch / prev) * 100).toFixed(2) : '0.00'}%)</b>`;
      }
      this.q('.lg-cmp').innerHTML = this.compareRT.map((c) => { const b = c.bars[c.bars.length - 1]; return `<span class="lg-cmpi" style="color:${c.series.options().color}">${esc(nameOf(c.epic))} ${b ? fmtNum(b.close, 2) : ''} <button data-cmp="${esc(c.epic)}" title="Remove comparison">✕</button></span>`; }).join('');
      for (const st of this.state.studies) {
        const rt = this.rts.get(st.uid);
        if (!rt) continue;
        const row = (rt.pane ? rt.pane.legend : this.q('.lg-studies')).querySelector(`[data-uid="${st.uid}"]`);
        if (!row) continue;
        for (const o of rt.def.outputs) {
          const cell = row.querySelector(`[data-k="${CSS.escape(o.k)}"]`);
          const v = rt.vals[o.k] && rt.vals[o.k][i];
          if (cell) cell.textContent = ok(v) ? (rt.def.kind === 'overlay' ? this.fmt(v) : fmtVal(v)) : '';
        }
      }
      this.updateQuote();
    }
    dataAt(i) {
      const n = this.basis.length;
      if (i == null || i < 0 || i >= n) i = n - 1;
      const b = this.basis[i];
      if (!b) return null;
      const rows = [['Date', fmtTime(b.time, this.tfSec < 60)], ['Open', this.fmt(b.open)], ['High', this.fmt(b.high)], ['Low', this.fmt(b.low)], ['Close', this.fmt(b.close)], ['Volume', fmtVal(b.volume || 0)]];
      const groups = [];
      for (const st of this.state.studies) {
        const rt = this.rts.get(st.uid); if (!rt) continue;
        groups.push({ title: IND.title(rt.def, st.params), rows: rt.def.outputs.map((o) => [o.label, ok(rt.vals[o.k]?.[i]) ? (rt.def.kind === 'overlay' ? this.fmt(rt.vals[o.k][i]) : fmtVal(rt.vals[o.k][i])) : '—', this.outColor(st, o)]) });
      }
      return { rows, groups };
    }

    onCrosshair(src, p) {
      const i = p && p.time != null ? this.idx.get(p.time) : undefined;
      this.updateLegend(i);
      this.crossIdx = i;
      if (p && p.sourceEvent) this.shell.onCrosshair(this, p.time ?? null, i);
      else if (p && !p.point && src === this.chart) this.shell.onCrosshair(this, null);
      if (!(p.sourceEvent || !p.point)) return;
      for (const c of [this.chart, ...this.panes.map((x) => x.chart)]) {
        if (c === src) continue;
        if (!p.time) { c.clearCrosshairPosition(); continue; }
        if (c === this.chart) { const b = this.basis[i]; if (b) c.setCrosshairPosition(b.close, p.time, this.overlay); continue; }
        const pane = this.panes.find((x) => x.chart === c);
        const v = pane && pane.primaryVal(i);
        if (ok(v)) c.setCrosshairPosition(v, p.time, pane.primary); else c.clearCrosshairPosition();
      }
    }
    showCrosshairAt(t) {
      if (t == null || !this.basis.length) { [this.chart, ...this.panes.map((x) => x.chart)].forEach((c) => c.clearCrosshairPosition()); return; }
      const times = this.basis;
      let lo = 0, hi = times.length - 1, r = -1;
      while (lo <= hi) { const m = (lo + hi) >> 1; if (times[m].time <= t) { r = m; lo = m + 1; } else hi = m - 1; }
      if (r < 0) return;
      this.chart.setCrosshairPosition(times[r].close, times[r].time, this.overlay);
      this.updateLegend(r);
    }
    visibleTimeRange() {
      const r = this.chart.timeScale().getVisibleLogicalRange();
      if (!r || !this.basis.length) return null;
      return { from: this.logicalToTime(r.from), to: this.logicalToTime(r.to) };
    }
    setVisibleTimeRange(tr) {
      if (!tr || !this.basis.length) return;
      const a = this.timeToLogical(tr.from), b = this.timeToLogical(tr.to);
      if (a == null || b == null || b <= a) return;
      this.applyingRange = true;
      this.chart.timeScale().setVisibleLogicalRange({ from: a, to: b });
      this.applyingRange = false;
    }

    onClick(p) {
      if (!p.point) return;
      if (this.rp.picking) return this.replayBegin(this.chart.timeScale().coordinateToLogical(p.point.x));
      if (p.sourceEvent && p.sourceEvent.altKey) { const price = this.overlay.coordinateToPrice(p.point.y); if (price != null) this.shell.openAlert(this, price); }
    }

    // ── drawings ────────────────────────────────────────
    setupDrawings() {
      const view = this;
      this.el.addEventListener('mousedown', (e) => { if (e.shiftKey && this.draw && !this.draw.tool && e.button === 0 && !(this.draw.hitAt && this.draw.hitAt(e))) this.draw.setTool('measure'); }, true);
      this.draw = window.IGDraw.create({
        el: this.el, canvas: this.q('.draw-layer'), toolbar: this.q('.tl-bar'), hint: this.q('.tl-hint'),
        key: () => this.state.symbol,
        load: () => this.shell.drawings,
        save: () => this.shell.saveDrawings(),
        toXY: (t, p) => this.toXY(t, p), fromXY: (x, y) => this.fromXY(x, y),
        pane: () => ({ w: this.el.clientWidth - this.chart.priceScale('right').width(), h: this.el.clientHeight - (this.panes.length ? 0 : this.chart.timeScale().height()) }),
        axisWidth: () => this.chart.priceScale('right').width(),
        timeAxisHeight: () => (this.panes.length ? 0 : this.chart.timeScale().height()),
        fmt: (p) => this.fmt(p), fmtTime: (t) => fmtTime(t), dur: durText,
        bars: (t1, t2) => { const a = this.timeToLogical(t1), b = this.timeToLogical(t2); return a == null || b == null ? 0 : Math.round(b - a); },
        shiftTime: (t, dl) => this.logicalToTime(this.timeToLogical(t) + dl),
        snap: (q, pt) => {
          const i = Math.round(q.l), c = this.basis[i];
          if (!c) return q;
          let best = null;
          for (const v of [c.open, c.high, c.low, c.close]) { const y = this.overlay.priceToCoordinate(v); const d = Math.abs(y - pt.y); if (best == null || d < best.d) best = { v, d }; }
          return best && best.d < (this.shell.magnetStrong ? 1e9 : 40) ? { l: i, t: c.time, p: best.v } : q;
        },
        risk: (price) => { const a = IND.ta.atr(this.basis.slice(-300), 14); const v = a[a.length - 1]; return ok(v) ? v * 1.5 : price * 0.005; },
        candles: (t1, t2) => { const lo = Math.min(t1, t2), hi = Math.max(t1, t2); return this.basis.filter((b) => b.time >= lo && b.time <= hi); },
        get tfSec() { return view.tfSec; },
        theme: () => ({ bg: T().bg }),
        interval: () => view.spec,
        templates: { get: () => window.IGC.store.get('drawTemplates', {}), set: (o) => window.IGC.store.set('drawTemplates', o) },
        onTool: (t) => this.shell.onToolChange(this, t),
        onChange: () => this.shell.onDrawingsChanged(this),
        onSelect: () => this.shell.onDrawingsChanged(this),
      });
      Object.defineProperty(this.draw, '_view', { value: this });
    }

    // ── AI Chance v1.3 ──────────────────────────────────
    setupAC() {
      const ind = (orig) => (this.state.scalePriceOnly || this.state.lockRatio ? null : orig());
      const line = (color, lineWidth) => this.chart.addLineSeries({ color, lineWidth, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false, autoscaleInfoProvider: ind });
      this.acPL = line('#FF9800', 2); this.acA5 = line('#9C27B0', 1); this.acC1 = line('#5C6BC0', 1); this.acC2 = line('#E040FB', 1);
      this.acTU = line('#787B86', 1); this.acTL = line('#787B86', 1);
      this.acUU = line('#787B86', 1); this.acUM = line('#1B7F5C', 1); this.acUL = line('#787B86', 1);
      const dotted = () => this.chart.addLineSeries({ color: 'rgba(210,180,140,.75)', lineWidth: 1, lineStyle: 1, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false, autoscaleInfoProvider: ind });
      this.acUUA = dotted(); this.acULA = dotted();
      this.ac = { htf: {}, priceLines: [], htfSeq: 0, timer: null };
    }
    acCtx(extra) { return { tfSec: this.tfSec, ticker: `${this.state.symbol || ''} ${nameOf(this.state.symbol || '')}`, ...extra }; }
    async acLoadHtf() {
      if (!AC || !this.state.symbol || isExpr(this.state.symbol)) return;
      const seq = ++this.ac.htfSeq;
      const R = AC.resolve(this.shell.acOpts(), this.acCtx());
      const n = this.candles.length || 300, out = {};
      await Promise.all([...new Set([R.htf1Res, R.htf2Res])].map(async (res) => {
        if (!res || RES_SEC[res] === this.tfSec) return;
        const max = Math.min(500, Math.max(60, Math.ceil((n * this.tfSec) / AC.RES_SEC[res]) + 30));
        try { const r = await api(`/api/history?epic=${encodeURIComponent(this.state.symbol)}&resolution=${res}&max=${max}`); out[res] = r.candles; }
        catch (e) { out[res] = []; }
      }));
      if (seq === this.ac.htfSeq) this.ac.htf = out;
    }
    acClear() {
      [this.acPL, this.acA5, this.acC1, this.acC2, this.acTU, this.acTL, this.acUU, this.acUM, this.acUL, this.acUUA, this.acULA].forEach((x) => x.setData([]));
      this.acMarkers = []; this.acLabels = []; this.acBox = null; this.renderACStats(null);
      this.ac.priceLines.forEach((pl) => { try { this.overlay.removePriceLine(pl); } catch {} }); this.ac.priceLines = [];
      this.q('.ac-panel').classList.add('hidden');
      this.refreshMarkers();
    }
    async setAC(on) {
      this.state.ac = on; this.shell.persist();
      if (on) { await this.acLoadHtf(); this.acRun(); } else this.acClear();
    }
    acRun() {
      if (!AC || !this.state.ac || !this.candles.length || this.typeInfo().priceBased) return this.acClear();
      const opts = this.shell.acOpts();
      let out;
      const t0 = performance.now();
      try { out = AC.compute(this.candles, this.ac.htf, opts, this.acCtx()); } catch (e) { console.error('[AI Chance]', e); return; }
      this.ac.ms = performance.now() - t0;
      this.acOut = out;
      this.acPL.setData(opts.showPl ? out.plots.pl : []); this.acA5.setData(opts.showA5 ? out.plots.a5 : []);
      this.acC1.setData(opts.showC1 ? out.plots.c1 : []); this.acC2.setData(opts.showC2 ? out.plots.c2 : []);
      this.acTU.setData(opts.showTma && out.plots.tmaU ? out.plots.tmaU : []); this.acTL.setData(opts.showTma && out.plots.tmaL ? out.plots.tmaL : []);
      const uml = opts.showUml && out.plots.umlM;
      this.acUU.setData(uml ? out.plots.umlU : []); this.acUM.setData(uml ? out.plots.umlM : []); this.acUL.setData(uml ? out.plots.umlL : []);
      const asof = opts.showUmlAsOf !== false && opts.stmnBand !== 'drawn' && out.plots.umlUA;
      this.acUUA.setData(asof ? out.plots.umlUA : []); this.acULA.setData(asof ? out.plots.umlLA : []);
      const SIZE = { tiny: 0.6, small: 1, normal: 1.4 };
      const KIND = { peak: 'lblPeak', breakout: 'lblBreakout', a5cross: 'lblA5cross', chance: 'lblChance', prox: 'lblChance', confirm: 'lblConfirm', tmn: 'lblTmn', ready: 'lblReady', outcome: 'lblOutcome', quick: 'lblQuick' };
      const shown = (l) => !KIND[l.kind] || opts[KIND[l.kind]] !== false;
      this.acTiny = opts.acLabelSize === 'Tiny';
      this.acLabels = [...out.labels.filter((l) => ok(l.y) && shown(l)), ...(opts.showStmn && out.stmnLabels ? out.stmnLabels : [])];
      this.acBox = opts.showStmnBox ? out.stmnBox || null : null;
      this.renderACStats(opts.showStats ? out.stats : null);
      this.acMarkers = out.labels.filter((l) => !ok(l.y) && shown(l)).map((l) => ({ time: l.time, color: l.css, text: l.text, size: SIZE[l.size || 'small'], position: l.style === 'down' ? 'aboveBar' : 'belowBar', shape: l.style === 'down' ? 'arrowDown' : l.style === 'up' ? 'arrowUp' : 'circle' }));
      this.refreshMarkers();
      this.ac.priceLines.forEach((pl) => { try { this.overlay.removePriceLine(pl); } catch {} }); this.ac.priceLines = [];
      const pline = (price, color, title, width = 1) => this.ac.priceLines.push(this.overlay.createPriceLine({ price, color, lineWidth: width, lineStyle: 2, axisLabelVisible: true, title }));
      if (opts.showAcLines !== false && out.lines.tl) pline(out.lines.tl.price, out.lines.tl.css, out.lines.tl.bull ? 'TL+' : 'TL-', 2);
      if (opts.showAcLines !== false && out.lines.quick) { pline(out.lines.quick.tp, 'rgba(76,175,80,.8)', 'TP', 2); pline(out.lines.quick.sl, 'rgba(255,82,82,.8)', 'SL', 2); }
      const big = this.root.clientWidth > 520 && this.root.clientHeight > 360;
      const p = out.panel;
      const warm = this.candles.length < 250 ? [{ text: `Warming up: ${this.candles.length} bars loaded, ATR(200) needs 200+`, css: 'rgba(120,123,134,.7)' }] : [];
      this.q('.ac-cards').innerHTML = [...warm, p.bias, p.proj, p.wait, p.sideways, p.tl, p.quick].filter(Boolean).map((c) => `<div class="ac-card" style="background:${c.css}">${esc(c.text)}</div>`).join('');
      const fv = (v) => (typeof v === 'number' ? (ok(v) ? (Math.abs(v) >= 100 ? v.toFixed(2) : String(Math.round(v * 10000) / 10000)) : '—') : v);
      this.q('.ac-data').innerHTML = Object.entries(out.data).map(([k, v]) => `<span>${esc(k)}</span><span>${esc(fv(v))}</span>`).join('');
      this.q('.ac-panel').classList.toggle('hidden', !big || (opts.showCards === false && opts.showAcExtras === false));
      this.q('.ac-cards').classList.toggle('hidden', opts.showCards === false);
      this.q('.ac-databox').classList.toggle('hidden', opts.showAcExtras === false); this.q('.ac-logbox').classList.toggle('hidden', opts.showAcExtras === false);
      this.acRenderLog();
    }
    acSchedule() { if (this.ac.timer || !this.state.ac) return; this.ac.timer = setTimeout(() => { this.ac.timer = null; this.acRun(); }, Math.max(400, Math.min(5000, 4 * (this.ac.ms || 0)))); }
    acOnBarClose() {
      if (!AC || !this.state.ac || this.rp.on || this.spec.kind !== 'time') return;
      const closed = this.candles.slice(0, -1);
      if (closed.length < 30) return;
      let out;
      try { out = AC.compute(closed, this.ac.htf, this.shell.acOpts(), this.acCtx({ confirmLast: true })); } catch (e) { return; }
      const fired = out.alerts.filter((a) => a.bar === closed.length - 1);
      if (fired.length) this.shell.onACSignals(this, fired);
    }
    acRenderLog() {
      const log = this.shell.acLog();
      this.q('.ac-logcount').textContent = log.length ? `(${log.length})` : '';
      this.q('.ac-log').innerHTML = log.length ? log.slice(0, 50).map((e) => `<li><span class="muted">${esc(new Date(e.at).toLocaleTimeString())} · ${esc(nameOf(e.epic))} · ${esc(ivLabel(e.tf))}</span><div class="ac-text">${esc(AC.describeAlert ? AC.describeAlert(e.payload) : e.payload.signal)}</div><details><summary>details</summary><code>${esc(JSON.stringify(e.payload))}</code></details></li>`).join('') : '<li class="muted">Bar-close alerts from the script appear here while this page is open.</li>';
    }
    aiSignals(bars) {
      if (!AC) return [];
      try { const out = AC.compute(bars, this.ac.htf, this.shell.acOpts(), this.acCtx()); return (out.labels || []).map((l) => ({ time: l.time, signal: l.text })); } catch { return []; }
    }

    // ── bar replay ──────────────────────────────────────
    replayPick() {
      if (!this.candles.length) return;
      if (this.rp.on || this.rp.picking) return this.replayStop();
      this.rp.picking = true;
      const h = this.q('.tl-hint'); h.textContent = 'Replay: click the bar to start from · Esc to cancel'; h.classList.remove('hidden');
      this.shell.onReplayState(this);
    }
    replayBegin(l) {
      this.rp.picking = false; this.q('.tl-hint').classList.add('hidden');
      const n = this.candles.length;
      const i = Math.max(20, Math.min(n - 2, Math.round(l ?? n - 50)));
      this.rp.full = this.candles.map((x) => ({ ...x })); this.rp.idx = i; this.rp.on = true;
      this.removeQuoteLines();
      this.candles = this.rp.full.slice(0, i + 1).map((x) => ({ ...x }));
      this.renderAll(); this.acRun();
      this.rp.sub = null; this.replayStepMenu();
      this.q('.replay-bar').classList.remove('hidden'); this.replayInfo(); this.shell.onReplayState(this);
      window.IGC.bus.emit('replay-start', { view: this, bar: this.rp.full[i] });
    }
    replayStep() {
      if (!this.rp.on) return;
      if (this.rp.sub && this.rp.sub.j < this.rp.sub.bars.length) return this.replaySubStep();
      if (this.rp.idx >= this.rp.full.length - 1) { this.replayPause(); window.IGC.toast('Replay reached the latest bar'); return; }
      this.rp.idx++;
      this.candles.push({ ...this.rp.full[this.rp.idx] });
      const tail = this.renderMain(false);
      this.renderStudies(tail ? 'tail' : 'full'); this.updateLegend(); this.acSchedule(); this.replayInfo();
      const r = this.chart.timeScale().getVisibleLogicalRange();
      if (r && this.disp.length - 1 > r.to - 4) this.chart.timeScale().scrollToRealTime();
      this.shell.onBarClose && this.shell.onBarClose(this);
      window.IGC.bus.emit('replay-bar', { view: this, bar: this.rp.full[this.rp.idx] });
    }
    replayPlay() {
      if (this.rp.timer) return this.replayPause();
      this.rp.timer = setInterval(() => this.replayStep(), 1000 / Number(this.q('[data-rp=speed]').value));
      this.q('[data-rp=play]').textContent = '❚❚';
    }
    replayPause() { clearInterval(this.rp.timer); this.rp.timer = null; this.q('[data-rp=play]').textContent = '▶'; }
    replayInfo() {
      const sb = this.rp.sub && this.rp.sub.j > 0 ? this.rp.sub.bars[this.rp.sub.j - 1] : null;
      this.q('.rp-info').textContent = `${fmtTime(sb ? sb.time : this.rp.full[this.rp.idx].time)} · ${this.rp.full.length - 1 - this.rp.idx} bars left`;
      const d = this.q('[data-rp=date]'); if (d && document.activeElement !== d) { const t = new Date((sb ? sb.time : this.rp.full[this.rp.idx].time) * 1000); d.value = new Date(t.getTime() - t.getTimezoneOffset() * 60000).toISOString().slice(0, 16); }
    }
    // Step menu: the chart's own timeframe plus every lower time-based interval that divides it.
    replayStepMenu() {
      const sel = this.q('[data-rp=tf]'), sp = parseIv(this.state.interval);
      const opts = [['', 'Step: ' + ivLabel(this.state.interval)]];
      if (sp && sp.kind === 'time') for (const iv of ['1', '2', '3', '5', '10', '15', '30', '60', '240']) { const x = parseIv(iv); if (x.sec < sp.sec && sp.sec % x.sec === 0) opts.push([iv, 'Step: ' + ivLabel(iv)]); }
      sel.innerHTML = opts.map(([v, l]) => `<option value="${v}">${l}</option>`).join('');
      sel.disabled = opts.length < 2;
    }
    // Lower-timeframe replay: load the lower bars after the current bar and build the chart's bars from them.
    async replaySetStep(iv) {
      this.replayPause();
      if (!iv) { this.rp.sub = null; return this.replayInfo(); }
      const sp = parseIv(iv), cur = this.rp.full[this.rp.idx], last = this.rp.full[this.rp.full.length - 1];
      const want = Math.min(30000, Math.ceil((last.time - cur.time) / sp.sec) + 50);
      window.IGC.toast('Loading ' + ivLabel(iv) + ' bars for replay…');
      try {
        const { bars } = await this.fetchSeries(this.state.symbol, sp, want, this.state.side);
        const nextT = this.rp.full[this.rp.idx + 1] ? this.rp.full[this.rp.idx + 1].time : Infinity;
        const sub = bars.filter((b) => b.time >= nextT);
        if (!sub.length) { this.q('[data-rp=tf]').value = ''; return window.IGC.toast('No ' + ivLabel(iv) + ' bars available after this point'); }
        this.rp.sub = { iv, bars: sub, j: 0 };
        if (bars[0].time > nextT) window.IGC.toast(ivLabel(iv) + ' history starts ' + fmtTime(bars[0].time) + '; earlier bars step normally');
      } catch (e) { this.q('[data-rp=tf]').value = ''; window.IGC.toast('Could not load ' + ivLabel(iv) + ' bars: ' + e.message); }
    }
    replaySubStep() {
      const sub = this.rp.sub, b = sub.bars[sub.j++];
      const next = this.rp.full[this.rp.idx + 1];
      // before the lower-timeframe data starts, step whole bars
      if (next && b.time >= next.time) {
        // whole bars before the lower-timeframe data are added complete; the bar containing b starts from b
        while (this.rp.full[this.rp.idx + 1] && this.rp.full[this.rp.idx + 1].time <= b.time) {
          this.rp.idx++;
          const nx = this.rp.full[this.rp.idx + 1];
          if (nx && nx.time <= b.time) this.candles.push({ ...this.rp.full[this.rp.idx] });
        }
        const bar = this.rp.full[this.rp.idx];
        this.candles.push({ time: bar.time, open: b.open, high: b.high, low: b.low, close: b.close, volume: b.volume || 0 });
      } else {
        const c = this.candles[this.candles.length - 1];
        c.high = Math.max(c.high, b.high); c.low = Math.min(c.low, b.low); c.close = b.close; c.volume = (c.volume || 0) + (b.volume || 0);
      }
      const tail = this.renderMain(false);
      this.renderStudies(tail ? 'tail' : 'full'); this.updateLegend(); this.acSchedule(); this.replayInfo();
      const r = this.chart.timeScale().getVisibleLogicalRange();
      if (r && this.disp.length - 1 > r.to - 4) this.chart.timeScale().scrollToRealTime();
      // a bar only "closes" when the next lower bar starts a new one
      const nb = sub.bars[sub.j], n2 = this.rp.full[this.rp.idx + 1];
      if (!nb || (n2 && nb.time >= n2.time)) this.shell.onBarClose && this.shell.onBarClose(this);
      window.IGC.bus.emit('replay-bar', { view: this, bar: b, chartBar: this.candles[this.candles.length - 1], sub: true });
      if (sub.j >= sub.bars.length) { this.rp.sub = null; this.q('[data-rp=tf]').value = ''; }
    }
    // Jump to a date: start replay there (loading more history when needed), or move within a running replay.
    async replayJump(t) {
      if (!Number.isFinite(t)) return;
      this.replayPause();
      const src = this.rp.on ? this.rp.full : this.candles;
      if (src.length && t < src[0].time) {
        const sec = specSec(parseIv(this.state.interval));
        const need = Math.min(30000, Math.ceil((src[src.length - 1].time - t) / sec) + 100);
        if (need <= src.length) return window.IGC.toast('That date is before the available history');
        window.IGC.toast('Loading ' + need + ' bars to reach that date…');
        if (this.rp.on) this.replayStop(true);
        this.loadBars = need; await this.load({ bars: need });
        if (!this.candles.length || t < this.candles[0].time) window.IGC.toast('History starts ' + fmtTime(this.candles[0] ? this.candles[0].time : t) + '; replay starts there');
        return this.replayAt(t);
      }
      if (!this.rp.on) return this.replayAt(t);
      let i = this.rp.full.findIndex((x) => x.time > t) - 1; if (i < -1) i = this.rp.full.length - 2; i = Math.max(20, i);
      this.rp.idx = Math.min(this.rp.full.length - 2, i); this.rp.sub = null; this.q('[data-rp=tf]').value = '';
      this.candles = this.rp.full.slice(0, this.rp.idx + 1).map((x) => ({ ...x }));
      this.renderAll(); this.acRun(); this.replayInfo();
      window.IGC.bus.emit('replay-start', { view: this, bar: this.rp.full[this.rp.idx], jump: true });
    }
    replayAt(t) {
      const k = this.candles.findIndex((x) => x.time > t);
      this.replayBegin(k < 0 ? this.candles.length - 2 : k - 1);
    }
    replayStop(silent) {
      this.replayPause();
      const was = this.rp.on;
      this.rp.on = false; this.rp.picking = false; this.rp.sub = null;
      this.q('.replay-bar').classList.add('hidden'); this.q('.tl-hint').classList.add('hidden');
      this.shell.onReplayState(this);
      if (was) window.IGC.bus.emit('replay-stop', { view: this });
      if (was && !silent) this.load();
    }

    // ── export / snapshot ───────────────────────────────
    exportCSV() {
      const head = ['time', 'iso', 'open', 'high', 'low', 'close', 'volume'];
      const cols = [];
      for (const st of this.state.studies) { const rt = this.rts.get(st.uid); if (!rt) continue; for (const o of rt.def.outputs) { head.push(`${IND.title(rt.def, st.params)}: ${o.label}`); cols.push(rt.vals[o.k] || []); } }
      const rows = [head, ...this.basis.map((b, i) => [b.time, new Date(b.time * 1000).toISOString(), b.open, b.high, b.low, b.close, b.volume ?? '', ...cols.map((c) => (ok(c[i]) ? c[i] : ''))])];
      return window.IGC.toCSV(rows);
    }
    snapshot() {
      const shots = [{ c: this.chart.takeScreenshot(), over: [this.q('.pane.main .study-layer'), this.q('.draw-layer')] }, ...this.panes.map((p) => ({ c: p.chart.takeScreenshot(), over: [p.canvas] }))];
      const W = shots[0].c.width, H = shots.reduce((a, s) => a + s.c.height, 0);
      const out = document.createElement('canvas'); out.width = W; out.height = H;
      const g = out.getContext('2d');
      let y = 0;
      for (const s of shots) {
        g.drawImage(s.c, 0, y);
        for (const o of s.over || []) if (o && o.width) g.drawImage(o, 0, y, s.c.width, o.height * (s.c.width / o.width));
        y += s.c.height;
      }
      return out;
    }

    serialize() {
      const s = this.state;
      return { symbol: s.symbol, interval: s.interval, type: s.type, typeOpts: s.typeOpts, studies: s.studies.map(({ uid: u, id, params, styles, visible, h, tf, place }) => ({ uid: u, id, params, styles, visible, h, tf, place })), compares: s.compares, ac: s.ac, link: s.link, scale: s.scale, side: s.side, invert: s.invert };
    }
    destroy() {
      cancelAnimationFrame(this.raf); if (this.liveRaf) cancelAnimationFrame(this.liveRaf);
      this.replayPause(); clearTimeout(this.ac.timer);
      unsubscribe(this.subscribed); this.subscribed = [];
      if (this.draw && this.draw.destroy) this.draw.destroy();
      this.panes.forEach((p) => p.chart.remove());
      this.chart.remove(); this.root.remove();
    }
  }

  window.IGC.ChartView = ChartView;
  window.IGC.iv = { parse: parseIv, label: ivLabel, barStart, baseRes, isExpr, compileExpr };
})();
