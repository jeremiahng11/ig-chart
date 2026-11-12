/* IG Charts — symbol notes (TradingView-style Notes panel).
 * Self-mounting: adds a "Notes" side-panel pane + sidebar button, a note badge on charts and watchlist rows.
 * Storage: IGC store key 'notes' (server-synced via SYNC_KEYS) = [{ id, symbol, title, body, created, updated, anchor?: { t, p, interval }, drawingId? }].
 * Public: window.IGNotes = { list(symbol?), add(note), update(id, patch), remove(id), forSymbol(symbol), open() }.
 */
window.IGC.ready.then(() => {
  const C = window.IGC;
  const { $, esc, uid, store, bus, nameOf, fmtTime, toast } = C;
  const KEY = 'notes';
  const load = () => { const v = store.get(KEY, []); return Array.isArray(v) ? v.filter((n) => n && typeof n.id === 'string' && typeof n.symbol === 'string') : []; };
  let notes = load();
  const save = () => { store.set(KEY, notes); refreshAll(); };
  const app = () => window.IGApp;
  const active = () => (app() ? app().active : null);
  const curSym = () => (active() && active().symbol) || null;
  const forSymbol = (s) => notes.filter((n) => n.symbol === s);
  const ui = { scope: 'symbol', q: '', editing: null, open: null, confirm: null };

  // ── styles (injected so index.html/style.css need no change) ──
  const css = document.createElement('style');
  css.id = 'notes-css';
  css.textContent = `
.nt-head { display: flex; align-items: center; gap: 6px; padding: 8px 10px; border-bottom: 1px solid var(--line); }
.nt-head b { font-size: 13px; }
.nt-head .spacer { flex: 1; }
.nt-btn { background: transparent; border: 1px solid var(--line); color: var(--text); border-radius: 5px; padding: 3px 8px; cursor: pointer; font: inherit; font-size: 12px; }
.nt-btn:hover { background: var(--hover); }
.nt-btn.primary { background: var(--accent); border-color: var(--accent); color: #fff; }
.nt-btn.danger { border-color: var(--down); color: var(--down); }
.nt-seg { display: inline-flex; border: 1px solid var(--line); border-radius: 5px; overflow: hidden; }
.nt-seg button { background: none; border: 0; color: var(--muted); padding: 3px 8px; cursor: pointer; font: inherit; font-size: 12px; }
.nt-seg button.active { background: var(--accent-soft); color: var(--accent); }
.nt-search { margin: 8px 10px 4px; }
.nt-search input, .nt-form input[type=text], .nt-form textarea { width: 100%; background: var(--bg); color: var(--text); border: 1px solid var(--line); border-radius: 5px; padding: 6px 8px; font: inherit; outline: none; }
.nt-search input:focus, .nt-form input:focus, .nt-form textarea:focus { border-color: var(--accent); }
.nt-list { list-style: none; margin: 0; padding: 4px 6px 10px; overflow: auto; flex: 1; min-height: 0; }
.nt-item { border: 1px solid var(--line); border-radius: 7px; padding: 7px 9px; margin: 6px 4px; cursor: pointer; background: var(--panel-2); }
.nt-item:hover { border-color: var(--accent); }
.nt-item .nt-title { font-weight: 600; display: flex; gap: 6px; align-items: baseline; }
.nt-item .nt-title span { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.nt-item .nt-meta { color: var(--muted); font-size: 11px; margin-top: 2px; display: flex; gap: 6px; flex-wrap: wrap; }
.nt-item .nt-snip { color: var(--muted); font-size: 12px; margin-top: 4px; overflow: hidden; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; }
.nt-item .nt-body { margin-top: 6px; font-size: 12.5px; line-height: 1.45; word-wrap: break-word; }
.nt-body h4 { margin: 6px 0 2px; font-size: 13px; } .nt-body ul { margin: 2px 0; padding-left: 18px; } .nt-body p { margin: 3px 0; }
.nt-body code { background: var(--hover); padding: 0 3px; border-radius: 3px; font-size: 11.5px; }
.nt-body a { color: var(--accent); }
.nt-actions { display: flex; gap: 6px; margin-top: 8px; flex-wrap: wrap; }
.nt-form { padding: 8px 10px; display: flex; flex-direction: column; gap: 8px; border-bottom: 1px solid var(--line); }
.nt-form textarea { min-height: 120px; resize: vertical; font-family: inherit; }
.nt-form label { font-size: 12px; color: var(--muted); display: flex; gap: 6px; align-items: center; }
.nt-empty { color: var(--muted); padding: 18px 12px; text-align: center; font-size: 12px; }
.nt-tag { font-size: 10.5px; color: var(--accent); background: var(--accent-soft); border-radius: 8px; padding: 0 6px; }
#sidebtns button[data-sb=notes] { position: relative; }
#sidebtns button[data-sb=notes] .nt-dot { position: absolute; top: 3px; right: 3px; min-width: 14px; height: 14px; padding: 0 3px; border-radius: 7px; background: #f7b924; color: #131722; font-size: 9.5px; font-weight: 700; line-height: 14px; text-align: center; }
.nt-chip { position: absolute; bottom: 34px; left: 8px; z-index: 7; background: rgba(247,185,36,.92); color: #131722; border: 0; border-radius: 10px; padding: 1px 8px; font-size: 11px; font-weight: 600; cursor: pointer; }
.nt-chip:hover { background: #f7b924; }
`;
  document.head.appendChild(css);
  const wlCss = document.createElement('style');
  wlCss.id = 'notes-wl-css';
  document.head.appendChild(wlCss);

  // ── markdown-lite (escape first, then a small safe subset) ──
  function md(text) {
    const inline = (s) => esc(s)
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>')
      .replace(/(^|[^*])\*([^*]+)\*/g, '$1<i>$2</i>')
      .replace(/\bhttps?:\/\/[^\s<]+/g, (u) => `<a href="${u}" target="_blank" rel="noopener noreferrer">${u}</a>`);
    const out = [];
    let list = false;
    for (const raw of String(text || '').split('\n')) {
      const l = raw.trimEnd(), li = /^\s*[-*]\s+(.*)$/.exec(l), h = /^#{1,3}\s+(.*)$/.exec(l);
      if (li) { if (!list) { out.push('<ul>'); list = true; } out.push(`<li>${inline(li[1])}</li>`); continue; }
      if (list) { out.push('</ul>'); list = false; }
      if (h) out.push(`<h4>${inline(h[1])}</h4>`);
      else if (l) out.push(`<p>${inline(l)}</p>`);
    }
    if (list) out.push('</ul>');
    return out.join('');
  }
  const plain = (s) => String(s || '').replace(/[`*#>-]/g, ' ').replace(/\s+/g, ' ').trim();

  // ── crosshair tracking: remembers the last hovered bar/price per view so "Note at this bar" works after the mouse leaves the chart ──
  const lastHover = new WeakMap(), hooked = new WeakSet();
  function hook(v) {
    if (!v || !v.chart || hooked.has(v)) return;
    hooked.add(v);
    v.chart.subscribeCrosshairMove((p) => {
      if (!p || p.time == null || !p.point || !v.overlay) return;
      const price = v.overlay.coordinateToPrice(p.point.y);
      if (Number.isFinite(price)) lastHover.set(v, { t: p.time, p: price, sym: v.symbol });
    });
  }
  function barAnchor(v) {
    if (!v) return null;
    const h = lastHover.get(v);
    if (h && h.sym === v.symbol) return { t: h.t, p: h.p, interval: v.interval };
    const b = v.basis && v.basis[v.basis.length - 1];
    return b ? { t: b.time, p: b.close, interval: v.interval } : null;
  }

  // ── chart Note drawing via the drawings engine's public importAll(merge) ──
  function addDrawing(v, note) {
    const d = v && v.draw;
    if (!d || typeof d.importAll !== 'function' || !note.anchor) return null;
    const id = 'note-' + note.id, text = (note.title || plain(note.body).slice(0, 60) || 'Note').slice(0, 80);
    const n = d.importAll({ [v.symbol]: [{ id, tool: 'note', type: 'note', color: '#f7b924', width: 1, style: 0, pts: [{ t: note.anchor.t, p: note.anchor.p }], text, name: 'Note: ' + text }] }, { merge: true });
    return n ? id : null;
  }
  function removeDrawing(note) {
    if (!note.drawingId) return;
    for (const v of (app() && app().views) || []) if (v.symbol === note.symbol && v.draw && v.draw.remove) v.draw.remove(note.drawingId);
  }

  // ── DOM mount ──
  let pane, btn;
  function mount() {
    const sidebar = $('sidebar'), sidebtns = $('sidebtns');
    if (!sidebar || !sidebtns || $('notesPane')) return !!$('notesPane');
    pane = document.createElement('div');
    pane.className = 'sb-pane' + (store.get('sbOpen', 'watchlist') === 'notes' ? '' : ' hidden');
    pane.dataset.sb = 'notes'; pane.id = 'notesPane';
    sidebar.appendChild(pane);
    btn = document.createElement('button');
    btn.dataset.sb = 'notes'; btn.title = 'Notes (per-symbol)';
    btn.innerHTML = '<svg class="ico" viewBox="0 0 18 18"><path d="M3 3h12v8l-4 4H3zM11 15v-4h4M6 7h6M6 10h3" /></svg><span class="nt-dot hidden"></span>';
    const sep = sidebtns.querySelector('.lt-sep');
    sidebtns.insertBefore(btn, sep || null);
    // panels.js toggles every [data-sb] pane/button via its delegated click handler; re-render when ours opens
    btn.addEventListener('click', () => setTimeout(render, 0));
    pane.addEventListener('click', onClick);
    pane.addEventListener('input', onInput);
    pane.addEventListener('keydown', (e) => { if ((e.metaKey || e.ctrlKey) && e.key === 'Enter' && ui.editing) { e.preventDefault(); commit(); } if (e.key === 'Escape' && ui.editing) { e.stopPropagation(); ui.editing = null; render(); } });
    // keep typing in the panel from triggering chart shortcuts
    pane.addEventListener('keydown', (e) => { if (e.target.matches('input, textarea')) e.stopPropagation(); });
    return true;
  }
  const isOpen = () => pane && !pane.classList.contains('hidden');
  function openPane() { if (!isOpen() && btn) btn.click(); else render(); }

  function visible() {
    const s = curSym(), q = ui.q.trim().toLowerCase();
    return notes
      .filter((n) => ui.scope === 'all' || n.symbol === s)
      .filter((n) => !q || `${n.title}\n${n.body}\n${n.symbol}\n${nameOf(n.symbol)}`.toLowerCase().includes(q))
      .sort((a, b) => b.updated - a.updated);
  }
  function editorHtml(n0) {
    const n = { ...n0, ...((ui.editing && ui.editing.draft) || {}) };
    const v = active(), anc = n.anchor || (n.id ? null : barAnchor(v)), fmtP = (p) => (v ? v.fmt(p) : String(p));
    return `<div class="nt-form" data-form>
      <input type="text" data-f="title" placeholder="Title" maxlength="200" value="${esc(n.title || '')}" />
      <textarea data-f="body" placeholder="Write a note… (**bold**, *italic*, \`code\`, - lists, # heading, links)">${esc(n.body || '')}</textarea>
      ${anc ? `<label><input type="checkbox" data-f="anchor" ${n.anchor || ui.editing.atBar ? 'checked' : ''} /> Link to bar ${esc(fmtTime(anc.t))} @ ${esc(fmtP(anc.p))}</label>` : ''}
      ${!n.id && anc ? `<label><input type="checkbox" data-f="drawing" ${ui.editing.atBar ? 'checked' : ''} /> Also place a Note drawing on the chart</label>` : ''}
      <div class="nt-actions"><button class="nt-btn primary" data-a="save">Save</button><button class="nt-btn" data-a="cancel">Cancel</button><span class="muted" style="font-size:11px;align-self:center">${esc(nameOf(n.symbol || curSym() || ''))} · ⌘↵ to save</span></div>
    </div>`;
  }
  function itemHtml(n) {
    const open = ui.open === n.id, v = active(), fmtP = (p) => (v && v.symbol === n.symbol ? v.fmt(p) : (+p).toPrecision(6));
    return `<li class="nt-item" data-id="${esc(n.id)}">
      <div class="nt-title"><span>${esc(n.title || plain(n.body).slice(0, 60) || 'Untitled')}</span>${n.anchor ? '<small class="nt-tag" title="Linked to a bar">bar</small>' : ''}</div>
      <div class="nt-meta">${ui.scope === 'all' ? `<span>${esc(nameOf(n.symbol))}</span>·` : ''}<span title="Created ${esc(fmtTime(n.created / 1000))}">${esc(fmtTime(n.updated / 1000))}</span>${n.anchor ? `· <span>bar ${esc(fmtTime(n.anchor.t))} @ ${esc(fmtP(n.anchor.p))}</span>` : ''}</div>
      ${open ? `<div class="nt-body">${md(n.body) || '<p class="muted">(empty)</p>'}</div>
        <div class="nt-actions"><button class="nt-btn" data-a="edit">Edit</button>${n.anchor ? '<button class="nt-btn" data-a="goto">Go to bar</button>' : ''}${n.symbol !== curSym() ? '<button class="nt-btn" data-a="symbol">Open chart</button>' : ''}<button class="nt-btn danger" data-a="del">${ui.confirm === n.id ? 'Confirm delete' : 'Delete'}</button></div>`
        : `<div class="nt-snip">${esc(plain(n.body).slice(0, 160))}</div>`}
    </li>`;
  }
  function render() {
    if (!pane) return;
    const s = curSym(), list = visible(), ed = ui.editing, focus = document.activeElement && pane.contains(document.activeElement) ? document.activeElement.dataset.f || (document.activeElement.dataset.search != null ? 'search' : null) : null;
    pane.innerHTML = `<div class="nt-head"><b>Notes</b><span class="nt-seg"><button data-scope="symbol" class="${ui.scope === 'symbol' ? 'active' : ''}" title="${esc(s ? nameOf(s) : '')}">This symbol</button><button data-scope="all" class="${ui.scope === 'all' ? 'active' : ''}">All (${notes.length})</button></span><span class="spacer"></span>
        <button class="nt-btn" data-a="new" title="New note for ${esc(s ? nameOf(s) : 'this symbol')}" ${s ? '' : 'disabled'}>＋</button><button class="nt-btn" data-a="atbar" title="Note at the last hovered bar (or the latest bar)" ${s ? '' : 'disabled'}>📍</button></div>
      <div class="nt-search"><input type="search" data-search placeholder="Search notes" value="${esc(ui.q)}" /></div>
      ${ed && !ed.id ? editorHtml({ symbol: s }) : ''}
      <ul class="nt-list">${list.map((n) => (ed && ed.id === n.id ? `<li>${editorHtml(n)}</li>` : itemHtml(n))).join('') || `<li class="nt-empty">${ui.q ? 'No matching notes' : ui.scope === 'all' ? 'No notes yet' : `No notes for ${esc(s ? nameOf(s) : 'this chart')} — click ＋ to add one`}</li>`}</ul>`;
    if (focus) { const el = focus === 'search' ? pane.querySelector('[data-search]') : pane.querySelector(`[data-f="${focus}"]`); if (el) { el.focus(); if (el.setSelectionRange && el.value != null && el.type !== 'checkbox') { const L = el.value.length; try { el.setSelectionRange(L, L); } catch {} } } }
    else if (ed) { const t = pane.querySelector('[data-f="title"]'); t && t.focus(); }
  }
  function commit() {
    const ed = ui.editing, f = pane.querySelector('[data-form]');
    if (!ed || !f) return;
    const title = f.querySelector('[data-f="title"]').value.trim(), body = f.querySelector('[data-f="body"]').value.replace(/\s+$/, '');
    if (!title && !body) { toast('Write a title or some text first'); return; }
    const anchorOn = f.querySelector('[data-f="anchor"]'), drawOn = f.querySelector('[data-f="drawing"]'), now = Date.now();
    if (ed.id) {
      const n = notes.find((x) => x.id === ed.id);
      if (n) { n.title = title; n.body = body; n.updated = now; if (anchorOn && !anchorOn.checked) delete n.anchor; }
      ui.open = ed.id;
    } else {
      const v = active(), sym = curSym();
      if (!sym) return;
      const n = { id: uid(), symbol: sym, title, body, created: now, updated: now };
      if (anchorOn && anchorOn.checked) { const a = barAnchor(v); if (a) n.anchor = a; }
      if (drawOn && drawOn.checked && n.anchor) { const id = addDrawing(v, n); if (id) n.drawingId = id; else toast('Note saved (chart drawing unavailable)'); }
      notes.push(n);
      ui.open = n.id;
    }
    ui.editing = null;
    save();
  }
  function onClick(e) {
    const sc = e.target.closest('[data-scope]');
    if (sc) { ui.scope = sc.dataset.scope; render(); return; }
    const a = e.target.closest('[data-a]'), item = e.target.closest('.nt-item'), id = item && item.dataset.id, n = id && notes.find((x) => x.id === id);
    if (!a) { if (item && !e.target.closest('a')) { ui.open = ui.open === id ? null : id; ui.confirm = null; render(); } return; }
    switch (a.dataset.a) {
      case 'new': ui.editing = { id: null, atBar: false }; render(); break;
      case 'atbar': ui.editing = { id: null, atBar: true }; render(); break;
      case 'save': commit(); break;
      case 'cancel': ui.editing = null; render(); break;
      case 'edit': ui.editing = { id }; render(); break;
      case 'del':
        if (ui.confirm !== id) { ui.confirm = id; render(); break; }
        if (n) removeDrawing(n);
        notes = notes.filter((x) => x.id !== id); ui.confirm = null; ui.open = null; save(); break;
      case 'symbol': if (n && active()) active().setSymbol(n.symbol); break;
      case 'goto': {
        if (!n || !n.anchor || !active()) break;
        const v = active();
        if (v.symbol !== n.symbol) { v.setSymbol(n.symbol); setTimeout(() => v.goTo && v.goTo(n.anchor.t), 1200); } else if (v.goTo) v.goTo(n.anchor.t);
        break;
      }
    }
  }
  function onInput(e) {
    if (e.target.matches('[data-search]')) { ui.q = e.target.value; render(); return; }
    const f = e.target.dataset.f;
    if (ui.editing && (f === 'title' || f === 'body')) (ui.editing.draft = ui.editing.draft || {})[f] = e.target.value;
  }

  // ── indicators: sidebar badge, chart chip, watchlist marker ──
  const chips = new WeakMap();
  function refreshIndicators() {
    const s = curSym(), cnt = s ? forSymbol(s).length : 0;
    if (btn) { const dot = btn.querySelector('.nt-dot'); dot.textContent = cnt > 9 ? '9+' : String(cnt); dot.classList.toggle('hidden', !cnt); btn.title = cnt ? `Notes — ${cnt} for ${nameOf(s)}` : 'Notes (per-symbol)'; }
    for (const v of (app() && app().views) || []) {
      hook(v);
      const host = v.root && v.root.querySelector('.pane.main');
      if (!host) continue;
      let chip = chips.get(v);
      const k = v.symbol ? forSymbol(v.symbol).length : 0;
      if (!chip) { chip = document.createElement('button'); chip.className = 'nt-chip hidden'; chip.onclick = (e) => { e.stopPropagation(); if (app().active !== v) app().setActive(v); ui.scope = 'symbol'; openPane(); }; host.appendChild(chip); chips.set(v, chip); }
      chip.classList.toggle('hidden', !k);
      chip.textContent = `✎ ${k}`;
      chip.title = k ? `${k} note${k > 1 ? 's' : ''} for ${nameOf(v.symbol)} — click to open` : '';
    }
    const syms = [...new Set(notes.map((n) => n.symbol))];
    wlCss.textContent = syms.map((sym) => `.wl-list li[data-epic="${CSS.escape(sym)}"] .nm::before`).join(',\n') + (syms.length ? ' { content: "✎ "; color: #f7b924; font-size: 11px; }' : '');
  }
  function refreshAll() { refreshIndicators(); if (isOpen()) render(); }

  // ── wiring ──
  let lastSyms = '';
  function boot() {
    if (!mount()) return false;
    render(); refreshIndicators();
    bus.on('active-changed', () => { ui.editing = ui.editing && ui.editing.id ? ui.editing : null; refreshAll(); });
    bus.on('state-remote', (k) => { if (k === KEY) { notes = load(); refreshAll(); } });
    // views can change symbol without becoming active (linked/synced charts): cheap poll of the symbol set
    setInterval(() => { const s = ((app() && app().views) || []).map((v) => v.symbol).join('|'); if (s !== lastSyms) { lastSyms = s; refreshIndicators(); } }, 1500);
    return true;
  }
  (function wait(k = 0) { if (window.IGApp && boot()) return; if (k < 200) setTimeout(() => wait(k + 1), 100); })();

  window.IGNotes = {
    list: (symbol) => (symbol ? forSymbol(symbol) : notes).map((n) => ({ ...n })),
    forSymbol: (s) => forSymbol(s).map((n) => ({ ...n })),
    add(n) { const now = Date.now(), x = { id: uid(), symbol: n.symbol || curSym(), title: String(n.title || ''), body: String(n.body || ''), created: now, updated: now, ...(n.anchor ? { anchor: n.anchor } : {}) }; if (!x.symbol) return null; notes.push(x); save(); return x.id; },
    update(id, patch) { const n = notes.find((x) => x.id === id); if (!n) return false; for (const k of ['title', 'body']) if (k in patch) n[k] = String(patch[k]); n.updated = Date.now(); save(); return true; },
    remove(id) { const n = notes.find((x) => x.id === id); if (!n) return false; removeDrawing(n); notes = notes.filter((x) => x !== n); save(); return true; },
    open: openPane,
  };
});
