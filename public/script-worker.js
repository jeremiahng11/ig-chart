/* IG Charts — script worker. Runs user strategy/indicator scripts (JavaScript and Pine) and backtests off the main thread so a slow
 * or looping script cannot freeze the tab — including the Pine/JS indicators drawn on the chart. Spawned, fed, timed out and
 * terminated by createScriptHost() in strategy.js, which also documents the message protocol. The job logic is
 * IGStrategy.runJob(), the same function the main-thread fallback runs. A Pine 'data' error (request.security on another symbol or
 * a lower timeframe) carries err.need so the host can load those series and re-run the job. */
/* global importScripts */
self.window = self; // indicators.js / pine.js / strategy.js publish onto window.* and touch no DOM at load
importScripts('indicators.js', 'pine.js', 'strategy.js');

const SERIES = new Map(); // key → { cols: { time, open, high, low, close, volume } typed arrays, bars: lazily built objects }
const S = self.IGStrategy;

function patch(m) {
  const base = SERIES.get(m.base);
  if (!base) return false;
  const cols = {};
  for (const k of Object.keys(m.cols)) {
    const a = base.cols[k], t = m.cols[k], out = new Float64Array(m.from + t.length);
    out.set(a.subarray(0, m.from));
    out.set(t, m.from);
    cols[k] = out;
  }
  SERIES.set(m.key, { cols, bars: null });
  return true;
}

self.onmessage = (ev) => {
  const m = ev.data || {};
  try {
    if (m.type === 'series') { SERIES.set(m.key, { cols: m.cols, bars: null }); return; }
    if (m.type === 'patch') { patch(m); return; }
    if (m.type === 'drop') { SERIES.delete(m.key); return; }
    if (m.type !== 'job') return;
    const get = (k) => {
      const s = SERIES.get(k);
      if (!s) return null;
      return s.bars || (s.bars = S.colsToBars(s.cols));
    };
    const result = S.runJob(m.job, get, (data) => self.postMessage({ type: 'progress', id: m.id, data }));
    self.postMessage({ type: 'result', id: m.id, ok: true, result });
  } catch (e) {
    if (m.id) self.postMessage({ type: 'result', id: m.id, ok: false, error: { message: String((e && e.message) || e), line: (e && e.line) || null, col: (e && e.col) || null, phase: (e && e.phase) || 'runtime', need: (e && e.need) || null } });
  }
};
self.postMessage({ type: 'ready' });
