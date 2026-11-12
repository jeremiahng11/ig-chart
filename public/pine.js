/* IG Charts — Pine Script interpreter (window.IGPine; also loads inside a Web Worker as self.IGPine).
 *
 * Runs a practical subset of TradingView Pine Script v5 (and v4 names) over the app's candles, bar by bar, with Pine
 * series semantics: every variable is a series (x[n] reads its history), `var`/`varip` keep state across bars, na is NaN,
 * and every ta.* call site and user-function call site keeps its own state (Pine's per-call-instance semantics).
 * Source → logical lines (4-space blocks, wrapped lines) → AST → closures (one per node) → executed once per bar.
 *
 * Output: plots / hlines / fills / bgcolor / plotshape / labels / lines / boxes mapped onto the app's indicator contract
 * (indicators.js: outputs, colors, markers, graphics, fills), and for strategies a broker emulator whose fills are handed
 * to the strategy tester (strategy.js backtest(), "orders" mode).
 *
 * Deliberate approximations (documented in IGPine.LIMITS):
 *  - request.security() supports the chart symbol only; higher timeframes are aggregated from the loaded chart bars
 *    (UTC-aligned buckets). lookahead_off: confirmed HTF values on history, the developing value on the last bar.
 *  - Time functions, sessions and daily VWAP anchors use UTC (the exchange time zone is not known).
 *  - History inside if/for blocks is indexed by bar; inside user functions by call (as Pine does).
 * Anything outside the subset is a compile or runtime error with line:column — never a silent substitution.
 */
(() => {
  'use strict';
  const G = typeof window !== 'undefined' ? window : typeof self !== 'undefined' ? self : globalThis;
  const NA = NaN;
  const isNa = (v) => v === null || v === undefined || (typeof v === 'number' && v !== v);
  const ok = Number.isFinite;

  class PineError extends Error {
    constructor(msg, line, col, phase) {
      super(msg);
      this.name = 'PineError'; this.line = line || null; this.col = col || null; this.phase = phase || 'compile';
    }
    get where() { return this.line ? `line ${this.line}${this.col ? `:${this.col}` : ''}` : ''; }
    toString() { return `${this.where ? `${this.where}: ` : ''}${this.message}`; }
  }
  const perr = (msg, node, phase = 'compile') => new PineError(msg, node && node.line, node && node.col, phase);

  // ── Lexer ─────────────────────────────────────────────
  const OPS = [':=', '+=', '-=', '*=', '/=', '%=', '==', '!=', '<=', '>=', '=>', '+', '-', '*', '/', '%', '<', '>', '=', '?', ':', '(', ')', '[', ']', ',', '.'];
  const CONT_END = new Set([',', '+', '-', '*', '/', '%', '?', ':', '==', '!=', '<', '>', '<=', '>=', '(', '[', ':=', '=']);
  const CONT_START = new Set(['?', ':', '+', '*', '/', '%', '==', '!=', '<', '>', '<=', '>=', '.', ')', ']', ',']);

  function lexLine(text, lineNo) {
    const toks = [];
    let i = 0, ind = 0;
    while (i < text.length && (text[i] === ' ' || text[i] === '\t')) { ind += text[i] === '\t' ? 4 : 1; i++; }
    const n = text.length;
    let ann = null;
    while (i < n) {
      const ch = text[i], col = i + 1;
      if (ch === ' ' || ch === '\t') { i++; continue; }
      if (ch === '/' && text[i + 1] === '/') { ann = text.slice(i + 2); break; }
      if (/[0-9]/.test(ch) || (ch === '.' && /[0-9]/.test(text[i + 1] || ''))) {
        const m = /^(\d+\.?\d*(?:[eE][+-]?\d+)?|\.\d+(?:[eE][+-]?\d+)?)/.exec(text.slice(i));
        const s = m[1];
        toks.push({ t: 'num', v: +s, f: /[.eE]/.test(s), line: lineNo, col });
        i += s.length; continue;
      }
      if (/[A-Za-z_]/.test(ch)) {
        const m = /^[A-Za-z_][A-Za-z0-9_]*/.exec(text.slice(i));
        toks.push({ t: 'id', v: m[0], line: lineNo, col });
        i += m[0].length; continue;
      }
      if (ch === '"' || ch === "'") {
        let j = i + 1, s = '';
        while (j < n && text[j] !== ch) {
          if (text[j] === '\\' && j + 1 < n) {
            const e = text[j + 1];
            s += e === 'n' ? '\n' : e === 't' ? '\t' : e === 'r' ? '' : e;
            j += 2; continue;
          }
          s += text[j++];
        }
        if (j >= n) throw new PineError('unterminated string literal', lineNo, col);
        toks.push({ t: 'str', v: s, line: lineNo, col });
        i = j + 1; continue;
      }
      if (ch === '#') {
        const m = /^#([0-9a-fA-F]{8}|[0-9a-fA-F]{6})(?![0-9a-zA-Z_])/.exec(text.slice(i));
        if (!m) throw new PineError('invalid color literal (use #RRGGBB or #RRGGBBAA)', lineNo, col);
        toks.push({ t: 'color', v: m[0].toUpperCase(), line: lineNo, col });
        i += m[0].length; continue;
      }
      const op = OPS.find((o) => text.startsWith(o, i));
      if (!op) throw new PineError(`unexpected character '${ch}'`, lineNo, col);
      toks.push({ t: 'op', v: op, line: lineNo, col });
      i += op.length;
    }
    return { ind, toks, ann };
  }

  // Physical lines → logical lines { indent (block level), toks, line }. A line continues the previous one when brackets
  // are open, when it is indented by a non-multiple of 4 (Pine's wrapping rule), or when the previous line ends with a
  // binary operator / comma, or this one starts with one.
  function lex(src) {
    const phys = String(src).replace(/\r\n?/g, '\n').split('\n');
    const out = [];
    let depth = 0, version = null;
    for (let k = 0; k < phys.length; k++) {
      const { ind, toks, ann } = lexLine(phys[k], k + 1);
      if (ann !== null && !toks.length) {
        const m = /^\s*@version\s*=\s*(\d+)/.exec(ann);
        if (m) version = +m[1];
      }
      if (!toks.length) continue;
      const last = out[out.length - 1];
      const lt = last && last.toks[last.toks.length - 1];
      const contEnd = lt && ((lt.t === 'op' && CONT_END.has(lt.v)) || (lt.t === 'id' && (lt.v === 'and' || lt.v === 'or' || lt.v === 'not')));
      const f = toks[0];
      const contStart = last && ind > last.indent * 4 && ((f.t === 'op' && CONT_START.has(f.v)) || (f.t === 'id' && (f.v === 'and' || f.v === 'or')));
      if (last && (depth > 0 || ind % 4 !== 0 || contEnd || contStart)) last.toks.push(...toks);
      else out.push({ indent: ind / 4, toks: toks.slice(), line: k + 1 });
      for (const t of toks) if (t.t === 'op') { if (t.v === '(' || t.v === '[') depth++; else if (t.v === ')' || t.v === ']') depth = Math.max(0, depth - 1); }
    }
    return { lines: out, version };
  }

  // ── Parser ────────────────────────────────────────────
  const KEYWORDS = new Set(['if', 'else', 'for', 'to', 'by', 'in', 'while', 'switch', 'var', 'varip', 'and', 'or', 'not', 'true', 'false', 'break', 'continue', 'import', 'export', 'type', 'method', 'enum']);
  const QUALIFIERS = new Set(['const', 'simple', 'series', 'input']);
  const TYPES = new Set(['int', 'float', 'bool', 'string', 'color', 'line', 'label', 'box', 'table', 'linefill', 'polyline', 'array', 'matrix', 'map']);

  class Parser {
    constructor(lines) { this.L = lines; this.li = 0; this.toks = []; this.p = 0; }
    begin(ln) { this.toks = ln.toks; this.p = 0; this.ln = ln; }
    peek(k = 0) { return this.toks[this.p + k]; }
    next() { return this.toks[this.p++]; }
    atEnd() { return this.p >= this.toks.length; }
    isOp(v, k = 0) { const t = this.peek(k); return !!t && t.t === 'op' && t.v === v; }
    isKw(v, k = 0) { const t = this.peek(k); return !!t && t.t === 'id' && t.v === v; }
    fail(t, msg) {
      if (t) return new PineError(msg, t.line, t.col);
      const lt = this.toks[this.toks.length - 1];
      return new PineError(msg, lt ? lt.line : this.ln && this.ln.line, lt ? lt.col + String(lt.v).length : 1);
    }
    expectOp(v) {
      const t = this.next();
      if (!t || t.t !== 'op' || t.v !== v) throw this.fail(t, `expected '${v}'${t ? ` but found '${t.v}'` : ' at end of line'}`);
      return t;
    }
    expectId(what = 'identifier') {
      const t = this.next();
      if (!t || t.t !== 'id' || KEYWORDS.has(t.v)) throw this.fail(t, `expected ${what}${t ? ` but found '${t.v}'` : ' at end of line'}`);
      return t;
    }
    endOfLine() { if (!this.atEnd()) { const t = this.peek(); throw this.fail(t, `unexpected '${t.v}'`); } }

    program() {
      const body = [];
      while (this.li < this.L.length) {
        const ln = this.L[this.li];
        if (ln.indent !== 0) throw new PineError('unexpected indentation (blocks are indented by 4 spaces or a tab)', ln.line, ln.toks[0].col);
        this.li++; this.begin(ln);
        body.push(this.statement(0, true));
      }
      return body;
    }
    // Lines at indent `ind` (at least one) form a block.
    block(ind, head) {
      const body = [];
      while (this.li < this.L.length) {
        const ln = this.L[this.li];
        if (ln.indent < ind) break;
        if (ln.indent > ind) throw new PineError('unexpected indentation', ln.line, ln.toks[0].col);
        this.li++; this.begin(ln);
        body.push(this.statement(ind, false));
      }
      if (!body.length) throw perr('expected an indented block on the next line', head);
      return body;
    }
    nextLineStarts(ind, kw) {
      const ln = this.L[this.li];
      return ln && ln.indent === ind && ln.toks[0].t === 'id' && ln.toks[0].v === kw;
    }

    statement(ind, top) {
      const t = this.peek();
      const at = { line: t.line, col: t.col };
      if (t.t === 'id') {
        switch (t.v) {
          case 'if': { const s = this.ifExpr(ind); return { type: 'expr', expr: s, ...at }; }
          case 'for': return { type: 'expr', expr: this.forExpr(ind), ...at };
          case 'while': return { type: 'expr', expr: this.whileExpr(ind), ...at };
          case 'switch': return { type: 'expr', expr: this.switchExpr(ind), ...at };
          case 'break': case 'continue': this.next(); this.endOfLine(); return { type: t.v, ...at };
          case 'import': return this.importStmt(top, at);
          case 'export': {
            this.next();
            if (!top) throw this.fail(t, "'export' is only allowed in the global scope of a library");
            const nx = this.peek();
            if (!nx) throw this.fail(null, "expected a function, method or type after 'export'");
            const s = nx.t === 'id' && nx.v === 'enum' ? this.enumDef(ind, top, at) : nx.t === 'id' && nx.v === 'type' ? this.typeDef(ind, top, at) : nx.t === 'id' && nx.v === 'method' ? (this.next(), this.funcDef(ind, top, true, at)) : this.funcDef(ind, top, false, at);
            s.exported = true;
            return s;
          }
          case 'type': return this.typeDef(ind, top, at);
          case 'enum': return this.enumDef(ind, top, at);
          case 'method': this.next(); return this.funcDef(ind, top, true, at);
          default:
        }
      }
      if (this.isOp('[') && this.tupleHead()) return this.tupleDecl(ind, at);
      if (t.t === 'id' && !KEYWORDS.has(t.v) && this.isOp('(', 1) && this.funcHead()) return this.funcDef(ind, top, false, at);
      const d = this.declHead();
      if (d) {
        const value = this.rhs(ind);
        return { type: 'decl', mode: d.mode, vtype: d.vtype, name: d.name, value, ...at, nline: d.tok.line, ncol: d.tok.col };
      }
      if (t.t === 'id' && !KEYWORDS.has(t.v)) {
        const op = this.peek(1);
        if (op && op.t === 'op' && [':=', '+=', '-=', '*=', '/=', '%='].includes(op.v)) {
          this.p += 2;
          return { type: 'assign', op: op.v, name: t.v, value: this.rhs(ind), ...at };
        }
        if (this.isOp('.', 1)) {
          // obj.field[.field] := value (user-defined type fields)
          let k = 1;
          while (this.isOp('.', k) && this.peek(k + 1) && this.peek(k + 1).t === 'id') k += 2;
          const op2 = this.peek(k);
          if (op2 && op2.t === 'op' && [':=', '+=', '-=', '*=', '/=', '%='].includes(op2.v)) {
            let target = { type: 'id', name: t.v, line: t.line, col: t.col };
            for (let j = 2; j < k; j += 2) { const nm = this.peek(j); target = { type: 'member', obj: target, name: nm.v, line: t.line, col: t.col, ncol: nm.col }; }
            this.p += k + 1;
            return { type: 'fassign', op: op2.v, target, value: this.rhs(ind), ...at };
          }
        }
      }
      const e = this.expr();
      this.endOfLine();
      return { type: 'expr', expr: e, ...at };
    }
    // `= if ...` / `= switch ...` / `= for ...` / `= while ...` take the following indented lines.
    rhs(ind) {
      const t = this.peek();
      if (!t) throw this.fail(null, 'expected an expression');
      if (t.t === 'id' && t.v === 'if') return this.ifExpr(ind);
      if (t.t === 'id' && t.v === 'switch') return this.switchExpr(ind);
      if (t.t === 'id' && t.v === 'for') return this.forExpr(ind);
      if (t.t === 'id' && t.v === 'while') return this.whileExpr(ind);
      const e = this.expr();
      this.endOfLine();
      return e;
    }
    tupleHead() {
      let k = 1;
      for (;;) {
        const t = this.peek(k);
        if (!t || t.t !== 'id') return false;
        k++;
        if (this.isOp(',', k)) { k++; continue; }
        if (this.isOp(']', k)) { k++; break; }
        return false;
      }
      return this.isOp('=', k) || this.isOp(':=', k);
    }
    tupleDecl(ind, at) {
      this.expectOp('[');
      const names = [];
      for (;;) { names.push(this.expectId('variable name').v); if (this.isOp(',')) { this.next(); continue; } this.expectOp(']'); break; }
      const op = this.next();
      if (op.v === ':=') throw this.fail(op, 'tuple reassignment with := is not supported; declare the tuple with =');
      return { type: 'tuple', names, value: this.rhs(ind), ...at };
    }
    funcHead() {
      let k = 1, d = 0;
      for (; this.peek(k); k++) {
        const t = this.peek(k);
        if (t.t === 'op' && (t.v === '(' || t.v === '[')) d++;
        else if (t.t === 'op' && (t.v === ')' || t.v === ']')) { d--; if (d === 0) break; }
      }
      return this.isOp('=>', k + 1);
    }
    typeSpec() {
      // [qualifier] type [<...>] [[]]
      const save = this.p;
      const parts = [];
      while (this.peek() && this.peek().t === 'id' && QUALIFIERS.has(this.peek().v)) this.next();
      const t = this.peek();
      if (!t || t.t !== 'id' || KEYWORDS.has(t.v)) { this.p = save; return null; }
      this.next();
      let name = t.v;
      while (this.isOp('.') && this.peek(1) && this.peek(1).t === 'id') { this.next(); name += `.${this.next().v}`; }
      parts.push(name);
      if (this.isOp('<')) {
        let d = 0;
        do { const x = this.next(); if (!x) { this.p = save; return null; } if (x.t === 'op' && x.v === '<') d++; else if (x.t === 'op' && x.v === '>') d--; } while (d > 0);
      }
      if (this.isOp('[') && this.isOp(']', 1)) { this.p += 2; name += '[]'; }
      return name;
    }
    declHead() {
      const save = this.p;
      let mode = null;
      if (this.isKw('var') || this.isKw('varip')) { mode = this.next().v; }
      // name = ...
      const a = this.peek();
      if (a && a.t === 'id' && !KEYWORDS.has(a.v) && this.isOp('=', 1)) { this.p += 2; return { mode, vtype: null, name: a.v, tok: a }; }
      const vtype = this.typeSpec();
      if (vtype) {
        const b = this.peek();
        if (b && b.t === 'id' && !KEYWORDS.has(b.v) && this.isOp('=', 1)) { this.p += 2; return { mode, vtype, name: b.v, tok: b }; }
      }
      if (mode) throw this.fail(this.peek(), `expected a variable declaration after '${mode}'`);
      this.p = save;
      return null;
    }
    funcDef(ind, top, isMethod, at) {
      const nameTok = this.expectId('function name');
      if (!top) throw this.fail(nameTok, 'functions can only be declared in the global scope');
      this.expectOp('(');
      const params = [];
      if (!this.isOp(')')) {
        for (;;) {
          // [qualifier] [type] name [= default]
          while (this.peek() && this.peek().t === 'id' && QUALIFIERS.has(this.peek().v) && this.peek(1) && this.peek(1).t === 'id') this.next();
          let ptype = null;
          const t0 = this.peek(), t1 = this.peek(1);
          const t2 = this.peek(2), t3 = this.peek(3);
          if (t0 && t0.t === 'id' && ((t1 && t1.t === 'id') || (t1 && t1.t === 'op' && (t1.v === '<' || t1.v === '[')) || (t1 && t1.t === 'op' && t1.v === '.' && t2 && t2.t === 'id' && t3 && t3.t === 'id'))) ptype = this.typeSpec();
          const pn = this.expectId('parameter name');
          let def = null;
          if (this.isOp('=')) { this.next(); def = this.ternary(); }
          params.push({ name: pn.v, ptype, def, line: pn.line, col: pn.col });
          if (this.isOp(',')) { this.next(); continue; }
          break;
        }
      }
      this.expectOp(')');
      this.expectOp('=>');
      let body;
      if (this.atEnd()) body = this.block(ind + 1, nameTok);
      else {
        const t = this.peek();
        const e = this.expr();
        this.endOfLine();
        body = [{ type: 'expr', expr: e, line: t.line, col: t.col }];
      }
      return { type: 'func', name: nameTok.v, params, body, method: isMethod, ...at };
    }
    // import <publisher>/<Name>/<version> [as alias]
    importStmt(top, at) {
      const kw = this.next();
      if (!top) throw this.fail(kw, "'import' is only allowed in the global scope");
      const parts = [];
      for (;;) {
        const t = this.next();
        if (!t || (t.t !== 'id' && t.t !== 'num')) throw this.fail(t, 'expected an import path like user/LibraryName/1');
        parts.push(String(t.v));
        if (this.isOp('/')) { this.next(); continue; }
        break;
      }
      if (parts.length < 2) throw this.fail(kw, 'expected an import path like user/LibraryName/1');
      let alias = null;
      if (this.isKw('as')) { this.next(); alias = this.expectId('alias name').v; }
      this.endOfLine();
      const hasVer = /^\d+$/.test(parts[parts.length - 1]);
      const name = hasVer ? parts[parts.length - 2] : parts[parts.length - 1];
      return { type: 'import', path: parts.join('/'), name, version: hasVer ? +parts[parts.length - 1] : null, alias: alias || name, ...at };
    }
    // type Name
    //     [varip] <type> field [= default]
    typeDef(ind, top, at) {
      const kw = this.next();
      if (!top) throw this.fail(kw, 'types can only be declared in the global scope');
      const nm = this.expectId('type name');
      this.endOfLine();
      const fields = [];
      while (this.li < this.L.length && this.L[this.li].indent === ind + 1) {
        const ln = this.L[this.li++];
        this.begin(ln);
        if (this.isKw('varip')) this.next();
        const ft = this.typeSpec();
        const fn = this.expectId('field name');
        if (!ft) throw this.fail(fn, 'expected a field type (e.g. float price = na)');
        let def = null;
        if (this.isOp('=')) { this.next(); def = this.expr(); }
        this.endOfLine();
        if (fields.some((f) => f.name === fn.v)) throw this.fail(fn, `field '${fn.v}' is declared twice`);
        fields.push({ name: fn.v, ftype: ft, def, line: fn.line, col: fn.col });
      }
      if (!fields.length) throw perr(`type ${nm.v} needs at least one field on the following indented lines`, kw);
      if (this.li < this.L.length && this.L[this.li].indent > ind + 1) { const ln = this.L[this.li]; throw new PineError('unexpected indentation', ln.line, ln.toks[0].col); }
      return { type: 'udt', name: nm.v, fields, ...at };
    }
    // enum Name
    //     field [= "title"]
    enumDef(ind, top, at) {
      const kw = this.next();
      if (!top) throw this.fail(kw, 'enums can only be declared in the global scope');
      const nm = this.expectId('enum name');
      this.endOfLine();
      const fields = [];
      while (this.li < this.L.length && this.L[this.li].indent === ind + 1) {
        const ln = this.L[this.li++];
        this.begin(ln);
        const fn = this.expectId('enum field name');
        let title = null;
        if (this.isOp('=')) {
          this.next();
          const t = this.next();
          if (!t || t.t !== 'str') throw this.fail(t, 'an enum field title must be a string literal');
          title = t.v;
        }
        this.endOfLine();
        if (fields.some((f) => f.name === fn.v)) throw this.fail(fn, `enum field '${fn.v}' is declared twice`);
        fields.push({ name: fn.v, title, line: fn.line, col: fn.col });
      }
      if (!fields.length) throw perr(`enum ${nm.v} needs at least one field on the following indented lines`, kw);
      if (this.li < this.L.length && this.L[this.li].indent > ind + 1) { const ln = this.L[this.li]; throw new PineError('unexpected indentation', ln.line, ln.toks[0].col); }
      return { type: 'enum', name: nm.v, fields, ...at };
    }
    ifExpr(ind) {
      const kw = this.next();
      const cond = this.expr();
      this.endOfLine();
      const then = this.block(ind + 1, kw);
      let els = null;
      if (this.nextLineStarts(ind, 'else')) {
        const ln = this.L[this.li++];
        this.begin(ln);
        const ek = this.next();
        if (this.isKw('if')) els = [{ type: 'expr', expr: this.ifExpr(ind), line: ek.line, col: ek.col }];
        else { this.endOfLine(); els = this.block(ind + 1, ek); }
      }
      return { type: 'if', cond, then, els, line: kw.line, col: kw.col };
    }
    forExpr(ind) {
      const kw = this.next();
      if (this.isOp('[')) {
        this.next();
        const a = this.expectId('index variable'); this.expectOp(',');
        const b = this.expectId('value variable'); this.expectOp(']');
        if (!this.isKw('in')) throw this.fail(this.peek(), "expected 'in'");
        this.next();
        const arr = this.expr(); this.endOfLine();
        return { type: 'forin', idx: a.v, name: b.v, arr, body: this.block(ind + 1, kw), line: kw.line, col: kw.col };
      }
      const v = this.expectId('loop variable');
      if (this.isKw('in')) {
        this.next();
        const arr = this.expr(); this.endOfLine();
        return { type: 'forin', idx: null, name: v.v, arr, body: this.block(ind + 1, kw), line: kw.line, col: kw.col };
      }
      this.expectOp('=');
      const from = this.expr();
      if (!this.isKw('to')) throw this.fail(this.peek(), "expected 'to' in for loop");
      this.next();
      const to = this.expr();
      let step = null;
      if (this.isKw('by')) { this.next(); step = this.expr(); }
      this.endOfLine();
      return { type: 'for', name: v.v, from, to, step, body: this.block(ind + 1, kw), line: kw.line, col: kw.col };
    }
    whileExpr(ind) {
      const kw = this.next();
      const cond = this.expr(); this.endOfLine();
      return { type: 'while', cond, body: this.block(ind + 1, kw), line: kw.line, col: kw.col };
    }
    switchExpr(ind) {
      const kw = this.next();
      const subject = this.atEnd() ? null : this.expr();
      this.endOfLine();
      const cases = [];
      let def = null;
      while (this.li < this.L.length && this.L[this.li].indent === ind + 1) {
        const ln = this.L[this.li++];
        this.begin(ln);
        const t = this.peek();
        let when = null;
        if (this.isOp('=>')) this.next();
        else { when = this.expr(); this.expectOp('=>'); }
        let body;
        if (this.atEnd()) body = this.block(ind + 2, t);
        else { const bt = this.peek(); const e = this.expr(); this.endOfLine(); body = [{ type: 'expr', expr: e, line: bt.line, col: bt.col }]; }
        if (when) cases.push({ when, body }); else def = body;
      }
      if (!cases.length && !def) throw perr('switch needs at least one case on the following indented lines', kw);
      return { type: 'switch', subject, cases, def, line: kw.line, col: kw.col };
    }

    // ── expressions ──
    expr() { return this.ternary(); }
    ternary() {
      const c = this.orE();
      if (this.isOp('?')) {
        const q = this.next();
        const a = this.ternary();
        this.expectOp(':');
        const b = this.ternary();
        return { type: 'tern', c, a, b, line: q.line, col: q.col };
      }
      return c;
    }
    orE() { let l = this.andE(); while (this.isKw('or')) { const t = this.next(); l = { type: 'or', l, r: this.andE(), line: t.line, col: t.col }; } return l; }
    andE() { let l = this.eqE(); while (this.isKw('and')) { const t = this.next(); l = { type: 'and', l, r: this.eqE(), line: t.line, col: t.col }; } return l; }
    eqE() { let l = this.cmpE(); while (this.isOp('==') || this.isOp('!=')) { const t = this.next(); l = { type: 'bin', op: t.v, l, r: this.cmpE(), line: t.line, col: t.col }; } return l; }
    cmpE() { let l = this.addE(); while (this.isOp('<') || this.isOp('>') || this.isOp('<=') || this.isOp('>=')) { const t = this.next(); l = { type: 'bin', op: t.v, l, r: this.addE(), line: t.line, col: t.col }; } return l; }
    addE() { let l = this.mulE(); while (this.isOp('+') || this.isOp('-')) { const t = this.next(); l = { type: 'bin', op: t.v, l, r: this.mulE(), line: t.line, col: t.col }; } return l; }
    mulE() { let l = this.unary(); while (this.isOp('*') || this.isOp('/') || this.isOp('%')) { const t = this.next(); l = { type: 'bin', op: t.v, l, r: this.unary(), line: t.line, col: t.col }; } return l; }
    unary() {
      if (this.isOp('-') || this.isOp('+')) { const t = this.next(); const e = this.unary(); return t.v === '-' ? { type: 'neg', e, line: t.line, col: t.col } : e; }
      if (this.isKw('not')) { const t = this.next(); return { type: 'not', e: this.unary(), line: t.line, col: t.col }; }
      return this.postfix();
    }
    genericAhead() {
      // < id[.id] (, id)* > (
      if (!this.isOp('<')) return 0;
      let k = 1, d = 1;
      while (this.peek(k) && d > 0) {
        const t = this.peek(k);
        if (t.t === 'op' && t.v === '<') d++;
        else if (t.t === 'op' && t.v === '>') d--;
        else if (!(t.t === 'id' || (t.t === 'op' && (t.v === ',' || t.v === '.' || t.v === '[' || t.v === ']')))) return 0;
        k++;
      }
      return d === 0 && this.isOp('(', k) ? k : 0;
    }
    postfix() {
      let e = this.primary();
      for (;;) {
        if (this.isOp('[')) {
          const t = this.next();
          const idx = this.expr();
          this.expectOp(']');
          e = { type: 'hist', e, idx, line: t.line, col: t.col };
        } else if (this.isOp('.')) {
          this.next();
          const nm = this.next();
          if (!nm || nm.t !== 'id') throw this.fail(nm, 'expected a name after "."');
          e = { type: 'member', obj: e, name: nm.v, line: e.line, col: e.col, ncol: nm.col };
        } else if (this.isOp('(') || (e.type === 'member' || e.type === 'id') && this.genericAhead()) {
          let generic = null;
          const gk = this.genericAhead();
          if (gk) { generic = this.toks.slice(this.p + 1, this.p + gk - 1).map((x) => x.v).join(''); this.p += gk; }
          const t = this.expectOp('(');
          const args = [];
          if (!this.isOp(')')) {
            for (;;) {
              const a = this.peek();
              if (a && a.t === 'id' && this.isOp('=', 1)) { this.p += 2; args.push({ name: a.v, e: this.expr(), line: a.line, col: a.col }); }
              else args.push({ name: null, e: this.expr(), line: a && a.line, col: a && a.col });
              if (this.isOp(',')) { this.next(); continue; }
              break;
            }
          }
          this.expectOp(')');
          e = { type: 'call', fn: e, args, generic, line: e.line, col: e.col, pline: t.line };
        } else break;
      }
      return e;
    }
    primary() {
      const t = this.next();
      if (!t) throw this.fail(null, 'expected an expression');
      if (t.t === 'num') return { type: 'num', v: t.v, isInt: !t.f, line: t.line, col: t.col };
      if (t.t === 'str') return { type: 'str', v: t.v, line: t.line, col: t.col };
      if (t.t === 'color') return { type: 'color', v: t.v, line: t.line, col: t.col };
      if (t.t === 'id') {
        if (t.v === 'true' || t.v === 'false') return { type: 'bool', v: t.v === 'true', line: t.line, col: t.col };
        if (t.v === 'if' || t.v === 'switch' || t.v === 'for' || t.v === 'while') throw this.fail(t, `'${t.v}' can only start a statement or the right side of a declaration`);
        if (KEYWORDS.has(t.v) && !['na'].includes(t.v)) throw this.fail(t, `unexpected keyword '${t.v}'`);
        return { type: 'id', name: t.v, line: t.line, col: t.col };
      }
      if (t.t === 'op' && t.v === '(') { const e = this.expr(); this.expectOp(')'); return e; }
      if (t.t === 'op' && t.v === '[') {
        const items = [];
        if (!this.isOp(']')) for (;;) { items.push(this.expr()); if (this.isOp(',')) { this.next(); continue; } break; }
        this.expectOp(']');
        return { type: 'tuple', items, line: t.line, col: t.col };
      }
      throw this.fail(t, `unexpected '${t.v}'`);
    }
  }

  const PARSE_CACHE = new Map();
  function parse(code) {
    let r = PARSE_CACHE.get(code);
    if (r) return r;
    const { lines, version } = lex(code);
    if (!lines.length) throw new PineError('the script is empty', 1, 1);
    const body = new Parser(lines).program();
    r = { body, version };
    if (PARSE_CACHE.size > 30) PARSE_CACHE.clear();
    PARSE_CACHE.set(code, r);
    return r;
  }

  // ── Values ────────────────────────────────────────────
  class PArray {
    constructor(a, et) { this.a = a; this.et = et || 'float'; }
  }
  const isArrV = (v) => v instanceof PArray;
  class Tuple { constructor(items) { this.items = items; } }
  // Objects of user-defined types: T is the compiled type ({ name, fields }), f the field values (references, as in Pine).
  class PObj { constructor(T, f) { this.T = T; this.f = f; } }
  // map<K, V>: insertion-ordered like Pine's maps.
  class PMap { constructor(m) { this.m = m || new Map(); } }
  // enum fields: one object per field, so ==, switch and map keys compare by identity. title defaults to the field name
  // (str.tostring() returns the title when one is declared, else the field name).
  class PEnum { constructor(E, name, title) { this.E = E; this.name = name; this.title = title === null || title === undefined ? name : title; } }
  // matrix<T>: d is an array of row arrays.
  class PMatrix { constructor(d, c) { this.d = d; this.c = c; } get r() { return this.d.length; } }
  const valueNs = (o) => (o instanceof PArray ? 'array' : o instanceof PMap ? 'map' : o instanceof PMatrix ? 'matrix' : o instanceof PObj ? 'udt' : o && o.__t ? o.__t : typeof o === 'string' ? 'str' : null);

  // Colors are CSS strings: '#RRGGBB' or 'rgba(r,g,b,a)'.
  const NAMED = { aqua: '#00BCD4', black: '#363A45', blue: '#2196F3', fuchsia: '#E040FB', gray: '#787B86', green: '#4CAF50', lime: '#00E676', maroon: '#880E4F', navy: '#311B92', olive: '#808000', orange: '#FF9800', purple: '#9C27B0', red: '#FF5252', silver: '#B2B5BE', teal: '#00897B', white: '#FFFFFF', yellow: '#FFEB3B' };
  function parseColor(c) {
    if (typeof c !== 'string') return null;
    let m = /^#([0-9a-f]{6})([0-9a-f]{2})?$/i.exec(c);
    if (m) { const x = parseInt(m[1], 16); return [x >> 16, (x >> 8) & 255, x & 255, m[2] ? parseInt(m[2], 16) / 255 : 1]; }
    m = /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+)\s*)?\)$/i.exec(c);
    if (m) return [+m[1], +m[2], +m[3], m[4] === undefined ? 1 : +m[4]];
    return null;
  }
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
  function mkColor(r, g, b, a) {
    r = Math.round(clamp(r, 0, 255)); g = Math.round(clamp(g, 0, 255)); b = Math.round(clamp(b, 0, 255));
    if (!(a < 1)) return `#${((1 << 24) | (r << 16) | (g << 8) | b).toString(16).slice(1).toUpperCase()}`;
    return `rgba(${r},${g},${b},${+clamp(a, 0, 1).toFixed(3)})`;
  }
  const withTransp = (c, transp) => { const p = parseColor(c); if (!p || isNa(transp)) return isNa(transp) ? c : null; return mkColor(p[0], p[1], p[2], (100 - clamp(transp, 0, 100)) / 100); };
  const colorAlpha = (c) => { const p = parseColor(c); return p ? p[3] : 0; };

  // ── Timeframes (Pine strings ↔ seconds, UTC buckets) ──
  function tfSecOf(tf) {
    const m = /^\s*(\d*)\s*([SDWMH]?)\s*$/i.exec(String(tf));
    if (!m || (!m[1] && !m[2])) return null;
    const n = m[1] ? +m[1] : 1, u = m[2].toUpperCase();
    if (!(n > 0)) return null;
    return u === 'S' ? n : u === 'H' ? n * 3600 : u === 'D' ? n * 86400 : u === 'W' ? n * 604800 : u === 'M' ? n * 2592000 : n * 60;
  }
  function tfString(sec) {
    if (!(sec > 0)) return '';
    if (sec % 2592000 === 0) return sec === 2592000 ? 'M' : `${sec / 2592000}M`;
    if (sec % 604800 === 0) return sec === 604800 ? 'W' : `${sec / 604800}W`;
    if (sec % 86400 === 0) return sec === 86400 ? 'D' : `${sec / 86400}D`;
    if (sec % 60 === 0) return String(sec / 60);
    return `${sec}S`;
  }
  // Start (seconds) of the bucket of `tfSec` that contains t. Months use calendar months, weeks start on Monday (UTC).
  function bucketOf(t, tfSec) {
    if (tfSec % 2592000 === 0) {
      const k = tfSec / 2592000, d = new Date(t * 1000), idx = d.getUTCFullYear() * 12 + d.getUTCMonth(), b = Math.floor(idx / k) * k;
      return Date.UTC(Math.floor(b / 12), b % 12, 1) / 1000;
    }
    if (tfSec % 604800 === 0) { const day = Math.floor(t / 86400), w = Math.floor((day + 3) / (7 * (tfSec / 604800))); return (w * 7 * (tfSec / 604800) - 3) * 86400; }
    return Math.floor(t / tfSec) * tfSec;
  }
  function aggregateBars(c, tfSec) {
    const out = [], idx = new Int32Array(c.length);
    let cur = null;
    for (let i = 0; i < c.length; i++) {
      const x = c[i], b = bucketOf(x.time, tfSec);
      if (!cur || b !== cur.time) { cur = { time: b, open: x.open, high: x.high, low: x.low, close: x.close, volume: x.volume || 0 }; out.push(cur); }
      else { if (x.high > cur.high) cur.high = x.high; if (x.low < cur.low) cur.low = x.low; cur.close = x.close; cur.volume += x.volume || 0; }
      idx[i] = out.length - 1;
    }
    return { bars: out, idx };
  }

  // ── Number / string formatting ────────────────────────
  function decimalsOf(mintick) { if (!(mintick > 0)) return 2; let d = 0; while (d < 10 && Math.abs(Math.round(mintick * 10 ** d) - mintick * 10 ** d) > 1e-9) d++; return d; }
  function patternFmt(v, pat) {
    const m = /^([^#0,.]*)([#0,]*)(?:\.([#0]+))?(.*)$/.exec(pat);
    if (!m) return String(v);
    const [, pre, ip, fp = '', post] = m;
    const minD = (fp.match(/0/g) || []).length, maxD = fp.length;
    let s = Math.abs(v).toFixed(maxD);
    if (maxD > minD) s = s.replace(new RegExp(`0{1,${maxD - minD}}$`), '').replace(/\.$/, '');
    let [a, b] = s.split('.');
    if (ip.includes(',')) a = a.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    const minI = (ip.replace(/,/g, '').match(/0/g) || []).length;
    while (a.length < minI) a = `0${a}`;
    return `${v < 0 ? '-' : ''}${pre}${a}${b ? `.${b}` : ''}${post}`;
  }
  function tostr(v, fmt, R) {
    if (v === true || v === false) return String(v);
    if (typeof v === 'string') return v;
    if (isNa(v)) return 'NaN';
    if (v instanceof PEnum) return v.title;
    if (isArrV(v)) return `[${v.a.map((x) => tostr(x, fmt, R)).join(', ')}]`;
    if (v instanceof PMatrix) return v.d.map((row) => `[${row.map((x) => tostr(x, fmt, R)).join(', ')}]`).join('\n');
    if (typeof v !== 'number') return String(v);
    if (fmt === 'mintick') return v.toFixed(decimalsOf(R ? R.mintick : 0.01));
    if (fmt === 'percent') return `${patternFmt(v, '#.##')}%`;
    if (fmt === 'volume') { const a = Math.abs(v); return a >= 1e9 ? `${patternFmt(v / 1e9, '#.###')}B` : a >= 1e6 ? `${patternFmt(v / 1e6, '#.###')}M` : a >= 1e3 ? `${patternFmt(v / 1e3, '#.###')}K` : patternFmt(v, '#.###'); }
    if (fmt === 'price' || fmt === 'inherit' || fmt === undefined || fmt === null) {
      if (Number.isInteger(v)) return String(v);
      return String(parseFloat(v.toFixed(10)));
    }
    return patternFmt(v, String(fmt));
  }
  function strFormat(R, f, args) {
    return String(f).replace(/\{(\d+)(?:,\s*(number|date|time)(?:,\s*([^}]*))?)?\}/g, (_, k, kind, pat) => {
      const v = args[+k];
      if (v === undefined) return '';
      if (kind === 'number') return pat === 'integer' ? tostr(Math.round(v), null, R) : pat === 'percent' ? `${patternFmt(v * 100, '#.##')}%` : pat === 'currency' ? patternFmt(v, '#,##0.00') : pat ? patternFmt(v, pat.trim()) : tostr(v, null, R);
      if (kind === 'date' || kind === 'time') return new Date(v).toISOString().replace('T', ' ').slice(0, kind === 'date' ? 10 : 19);
      return tostr(v, null, R);
    });
  }

  // ── TA: stateful, one state object per call site (Pine call-instance semantics) ──
  // Numerical definitions follow indicators.js (Pine semantics: EMA/RMA seeded by the SMA of the first `length` values).
  const num = (v) => (typeof v === 'number' ? v : v === true ? 1 : v === false ? 0 : NA);
  const L = (len) => { const n = Math.floor(num(len)); return n >= 1 ? n : 0; };
  const buf = (st, k, v) => { const b = st[k] || (st[k] = []); b.push(v); return b; };
  function smaS(st, x, len) {
    const n = L(len); const b = buf(st, 'b', x);
    if (!n) return NA;
    if (st.len !== n) {
      st.len = n; st.sum = 0; st.nas = 0;
      for (let k = Math.max(0, b.length - n); k < b.length; k++) { const v = b[k]; if (ok(v)) st.sum += v; else st.nas++; }
    } else {
      if (ok(x)) st.sum += x; else st.nas++;
      if (b.length > n) { const o = b[b.length - 1 - n]; if (ok(o)) st.sum -= o; else st.nas--; }
    }
    return b.length >= n && st.nas === 0 ? st.sum / n : NA;
  }
  function smoothS(st, v, n, alpha) {
    if (st.seen === undefined) { st.seen = 0; st.sum = 0; st.prev = NA; }
    if (!ok(v) || !n) return NA;
    if (!ok(st.prev)) { st.sum += v; st.seen++; if (st.seen === n) { st.prev = st.sum / n; return st.prev; } return NA; }
    st.prev = alpha * v + (1 - alpha) * st.prev;
    return st.prev;
  }
  const emaS = (st, v, len) => { const n = L(len); return smoothS(st, num(v), n, 2 / (n + 1)); };
  const rmaS = (st, v, len) => { const n = L(len); return smoothS(st, num(v), n, 1 / n); };
  function wmaS(st, x, len) {
    const n = L(len), b = buf(st, 'b', x), i = b.length - 1;
    if (!n || b.length < n) return NA;
    const d = (n * (n + 1)) / 2;
    let s = 0;
    for (let k = 0; k < n; k++) { const v = b[i - k]; if (!ok(v)) return NA; s += v * (n - k); }
    return s / d;
  }
  function windowOf(b, n) { return b.length >= n ? b.length - n : -1; }
  function stdevS(st, x, len, biased) {
    const n = L(len), m = smaS(st.m || (st.m = {}), x, n), b = st.m.b, i = b.length - 1;
    if (!ok(m)) return NA;
    let acc = 0;
    for (let k = 0; k < n; k++) acc += (b[i - k] - m) ** 2;
    return Math.sqrt(acc / (biased === false && n > 1 ? n - 1 : n));
  }
  function extremeS(st, x, len, hi, bars) {
    const n = L(len), b = buf(st, 'b', x), i = b.length - 1;
    if (!n || b.length < n) return NA;
    let m = hi ? -Infinity : Infinity, at = 0;
    for (let k = 0; k < n; k++) {
      const v = b[i - k];
      if (bars) { if (!ok(v)) continue; if (hi ? v > m : v < m) { m = v; at = k; } }
      else m = hi ? Math.max(m, v) : Math.min(m, v);
    }
    return bars ? (ok(m) ? -at : NA) : m;
  }
  const trAt = (R, i, handleNa) => {
    const h = R.H[i], l = R.Lo[i];
    if (i === 0) return handleNa ? h - l : NA;
    const pc = R.C[i - 1];
    return Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc));
  };
  function rsiS(st, x, len) {
    const n = L(len);
    let u = NA, d = NA;
    if (st.has) { const ch = x - st.px; u = Math.max(ch, 0); d = Math.max(-ch, 0); if (!ok(ch)) u = d = NA; }
    st.has = true; st.px = x;
    const ru = rmaS(st.u || (st.u = {}), u, n), rd = rmaS(st.d || (st.d = {}), d, n);
    if (!ok(ru) || !ok(rd)) return NA;
    return rd === 0 ? 100 : ru === 0 ? 0 : 100 - 100 / (1 + ru / rd);
  }
  function crossS(st, a, b, mode) {
    a = num(a); b = num(b);
    const pa = st.a, pb = st.b, init = st.init;
    st.a = a; st.b = b; st.init = true;
    if (!init) return false;
    const up = a > b && pa <= pb, dn = a < b && pa >= pb;
    return mode === 1 ? up : mode === -1 ? dn : up || dn;
  }
  function changeS(st, x, len) {
    const n = len === undefined ? 1 : Math.floor(num(len)), b = buf(st, 'b', x), i = b.length - 1;
    if (typeof x === 'boolean') return i - n >= 0 ? x !== b[i - n] : false;
    return n >= 0 && i - n >= 0 ? x - b[i - n] : NA;
  }
  function linregS(st, x, len, off) {
    const n = L(len), b = buf(st, 'b', x), i = b.length - 1;
    if (!n || b.length < n) return NA;
    const sx = (n * (n - 1)) / 2, sxx = ((n - 1) * n * (2 * n - 1)) / 6, den = n * sxx - sx * sx;
    let sy = 0, sxy = 0;
    for (let k = 0; k < n; k++) { const v = b[i - n + 1 + k]; if (!ok(v)) return NA; sy += v; sxy += k * v; }
    const slope = den ? (n * sxy - sx * sy) / den : 0, icpt = (sy - slope * sx) / n;
    return icpt + slope * (n - 1 - (num(off) || 0));
  }
  function supertrendS(st, R, factor, atrLen) {
    const i = R.bar, a = rmaS(st.a || (st.a = {}), trAt(R, i, true), atrLen);
    const src = (R.H[i] + R.Lo[i]) / 2;
    let ub = src + factor * a, lb = src - factor * a;
    const pl = ok(st.lb) ? st.lb : 0, pu = ok(st.ub) ? st.ub : 0, pc = i > 0 ? R.C[i - 1] : NA;
    lb = lb > pl || pc < pl ? lb : pl;
    ub = ub < pu || pc > pu ? ub : pu;
    let dir;
    if (!ok(st.pa)) dir = 1;
    else if (st.st === st.ub) dir = R.C[i] > ub ? -1 : 1;
    else dir = R.C[i] < lb ? 1 : -1;
    const v = dir === -1 ? lb : ub;
    st.pa = a; st.lb = lb; st.ub = ub; st.st = v;
    return new Tuple([v, dir]);
  }
  function sarS(st, R, start, inc, max) {
    const i = R.bar, H = R.H, Lo = R.Lo, C = R.C;
    if (st.res === undefined) { st.res = NA; st.mm = NA; st.acc = NA; st.below = false; st.n = -1; }
    st.n++;
    const bi = st.n;
    let first = false;
    if (bi === 1) {
      if (C[i] > C[i - 1]) { st.below = true; st.mm = H[i]; st.res = Lo[i - 1]; }
      else { st.below = false; st.mm = Lo[i]; st.res = H[i - 1]; }
      first = true; st.acc = start;
    }
    st.res = st.res + st.acc * (st.mm - st.res);
    if (st.below) { if (st.res > Lo[i]) { first = true; st.below = false; st.res = Math.max(H[i], st.mm); st.mm = Lo[i]; st.acc = start; } }
    else if (st.res < H[i]) { first = true; st.below = true; st.res = Math.min(Lo[i], st.mm); st.mm = H[i]; st.acc = start; }
    if (!first) {
      if (st.below) { if (H[i] > st.mm) { st.mm = H[i]; st.acc = Math.min(st.acc + inc, max); } }
      else if (Lo[i] < st.mm) { st.mm = Lo[i]; st.acc = Math.min(st.acc + inc, max); }
    }
    if (st.below) { st.res = Math.min(st.res, i > 0 ? Lo[i - 1] : NA); if (bi > 1) st.res = Math.min(st.res, Lo[i - 2]); }
    else { st.res = Math.max(st.res, i > 0 ? H[i - 1] : NA); if (bi > 1) st.res = Math.max(st.res, H[i - 2]); }
    return st.res;
  }
  function dmiS(st, R, diLen, adxLen) {
    const i = R.bar;
    const up = i > 0 ? R.H[i] - R.H[i - 1] : NA, dn = i > 0 ? -(R.Lo[i] - R.Lo[i - 1]) : NA;
    const pdm = !ok(up) ? NA : up > dn && up > 0 ? up : 0, mdm = !ok(dn) ? NA : dn > up && dn > 0 ? dn : 0;
    const tr = rmaS(st.t || (st.t = {}), trAt(R, i, false), diLen);
    let plus = (100 * rmaS(st.p || (st.p = {}), pdm, diLen)) / tr, minus = (100 * rmaS(st.m || (st.m = {}), mdm, diLen)) / tr;
    if (ok(plus)) st.lp = plus; else plus = ok(st.lp) ? st.lp : NA;
    if (ok(minus)) st.lm = minus; else minus = ok(st.lm) ? st.lm : NA;
    const s = plus + minus, adx = 100 * rmaS(st.x || (st.x = {}), Math.abs(plus - minus) / (s === 0 ? 1 : s), adxLen);
    return new Tuple([plus, minus, adx]);
  }
  function pivotS(st, x, left, right, hi) {
    const l = Math.floor(num(left)), r = Math.floor(num(right)), b = buf(st, 'b', x), i = b.length - 1, c = i - r;
    if (c - l < 0 || r < 0 || l < 0) return NA;
    const v = b[c];
    if (!ok(v)) return NA;
    for (let k = 1; k <= l; k++) { const u = b[c - k]; if (!ok(u) || (hi ? u > v : u < v)) return NA; }
    for (let k = 1; k <= r; k++) { const u = b[c + k]; if (!ok(u) || (hi ? u >= v : u <= v)) return NA; }
    return v;
  }
  function almaS(st, x, len, off, sigma, floor) {
    const n = L(len), b = buf(st, 'b', x), i = b.length - 1;
    if (!n || b.length < n) return NA;
    if (st.n !== n || st.o !== off || st.s !== sigma) {
      const m = floor ? Math.floor(off * (n - 1)) : off * (n - 1), s = n / sigma;
      st.w = []; st.norm = 0;
      for (let k = 0; k < n; k++) { st.w[k] = Math.exp(-((k - m) ** 2) / (2 * s * s)); st.norm += st.w[k]; }
      st.n = n; st.o = off; st.s = sigma;
    }
    let sum = 0;
    for (let k = 0; k < n; k++) { const v = b[i - n + 1 + k]; if (!ok(v)) return NA; sum += v * st.w[k]; }
    return sum / st.norm;
  }
  function percentrankS(st, x, len) {
    const n = L(len), b = buf(st, 'b', x), i = b.length - 1;
    if (!n || i < n || !ok(x)) return NA;
    let cnt = 0;
    for (let k = 1; k <= n; k++) { const v = b[i - k]; if (!ok(v)) return NA; if (v <= x) cnt++; }
    return (100 * cnt) / n;
  }
  function correlationS(st, x, y, len) {
    const n = L(len), a = buf(st, 'a', x), b = buf(st, 'b', y), i = a.length - 1;
    if (!n || a.length < n) return NA;
    let sx = 0, sy = 0;
    for (let k = 0; k < n; k++) { sx += a[i - k]; sy += b[i - k]; }
    const mx = sx / n, my = sy / n;
    let cov = 0, vx = 0, vy = 0;
    for (let k = 0; k < n; k++) { const dx = a[i - k] - mx, dy = b[i - k] - my; cov += dx * dy; vx += dx * dx; vy += dy * dy; }
    return vx > 0 && vy > 0 ? cov / Math.sqrt(vx * vy) : NA;
  }
  function devS(st, x, len) {
    const n = L(len), m = smaS(st.m || (st.m = {}), x, n), b = st.m.b, i = b.length - 1;
    if (!ok(m)) return NA;
    let s = 0;
    for (let k = 0; k < n; k++) s += Math.abs(b[i - k] - m);
    return s / n;
  }
  function sumS(st, x, len) {
    const n = L(len), b = buf(st, 'b', x), i = b.length - 1;
    if (!n || b.length < n) return NA;
    let s = 0;
    for (let k = 0; k < n; k++) { const v = b[i - k]; if (!ok(v)) return NA; s += v; }
    return s;
  }

  // ── Strategy broker emulator ──────────────────────────
  // Pine order semantics: market orders placed on bar i fill at the open of bar i+1 (or at bar i's close when the tester's
  // "Process orders on" is "Signal bar close"); limit/stop entries and strategy.exit brackets are checked intrabar along
  // open → nearer extreme → farther extreme → close (gaps fill at the open). Sizing, commission and slippage use the
  // tester's properties with the same arithmetic as strategy.js backtest(), which replays the emitted fills.
  class Broker {
    constructor(R, props) {
      const p = props || {};
      this.R = R;
      this.cap = ok(+p.capital) ? +p.capital : 10000;
      this.sizeType = p.sizeType || 'percent'; this.size = ok(+p.size) ? +p.size : 100;
      this.pyr = Math.max(1, (p.pyramiding | 0) || 1);
      this.pctComm = p.commType !== 'cash'; this.comm = +p.commission || 0; this.slip = +p.slippage || 0;
      this.onClose = p.fill === 'close';
      this.allow = p.direction === 'long' || p.direction === 'short' ? p.direction : 'both';
      this.trades = []; this.closed = []; this.fills = []; this.pend = [];
      this.entries = new Map(); this.exits = new Map();
      this.realized = 0; this.openComm = 0; this.nextKey = 1;
      this.gp = 0; this.gl = 0; this.wins = 0; this.losses = 0; this.evens = 0; this.peak = this.cap; this.maxDD = 0;
    }
    fee(px, q) { return this.pctComm ? (px * q * this.comm) / 100 : this.comm; }
    dir() { return this.trades.length ? this.trades[0].dir : 0; }
    size_() { let s = 0; for (const e of this.trades) s += e.dir * e.qty; return s; }
    avg() { let q = 0, v = 0; for (const e of this.trades) { q += e.qty; v += e.qty * e.px; } return q ? v / q : NA; }
    openProfit(px) { let u = 0; for (const e of this.trades) u += e.dir * (px - e.px) * e.qty; return u; }
    equityAt(px) { return this.cap + this.realized + this.openProfit(px) - this.openComm; }
    allowed(d) { return this.allow === 'both' || (this.allow === 'long' ? d > 0 : d < 0); }

    defQty(fill) { return this.sizeType === 'qty' ? this.size : this.sizeType === 'cash' ? this.size / fill : (this.equityAt(fill) * this.size) / 100 / fill; }
    open(d, px, qty, id, comment, i, slipOn) {
      const fill = slipOn ? px + d * this.slip : px;
      const q = ok(qty) && qty > 0 ? qty : this.defQty(fill);
      if (!(q > 0) || !ok(q)) return 0;
      const f = this.fee(fill, q);
      this.openComm += f;
      const key = this.nextKey++;
      this.trades.push({ key, id, dir: d, qty: q, px: fill, bar: i, time: this.R.T[i], comm: f });
      this.fills.push({ i, kind: 'entry', key, dir: d, px, qty: q, id, comment: comment || '', slip: !!slipOn });
      return q;
    }
    closeTrade(e, px, qty, reason, i, slipOn) {
      const ex = slipOn ? px - e.dir * this.slip : px;
      const q = ok(qty) && qty > 0 && qty < e.qty - 1e-12 ? qty : e.qty;
      const share = e.comm * (q / e.qty), f = this.fee(ex, q);
      const pnl = e.dir * (ex - e.px) * q - share - f;
      this.realized += pnl; this.openComm -= share;
      if (pnl > 0) { this.gp += pnl; this.wins++; } else if (pnl < 0) { this.gl -= pnl; this.losses++; } else this.evens++;
      this.closed.push({ id: e.id, dir: e.dir, qty: q, entryPx: e.px, exitPx: ex, entryBar: e.bar, exitBar: i, entryTime: e.time, exitTime: this.R.T[i], pnl, comm: share + f, exitId: reason });
      this.fills.push({ i, kind: 'exit', key: e.key, px, qty: q, reason, slip: !!slipOn });
      e.qty -= q; e.comm -= share;
      if (e.qty <= 1e-12) { const k = this.trades.indexOf(e); if (k >= 0) this.trades.splice(k, 1); }
    }
    // → the quantity filled (0 when the order was rejected), for OCA groups
    execEntry(d, px, qty, id, comment, i, slipOn) {
      if (!this.allowed(d)) {
        if (this.dir() === -d) for (const e of this.trades.slice()) this.closeTrade(e, px, NA, comment || id, i, slipOn);
        return 0;
      }
      if (this.dir() === -d) for (const e of this.trades.slice()) this.closeTrade(e, px, NA, 'Reverse', i, slipOn);
      else if (this.dir() === d && this.trades.length >= this.pyr) return 0;
      return this.open(d, px, qty, id, comment, i, slipOn);
    }
    // strategy.order(): buys/sells qty regardless of pyramiding — it first reduces an opposite position (oldest trades first),
    // and whatever is left opens a trade in its own direction (so a larger qty reverses the position).
    execOrder(d, px, qty, id, comment, i, slipOn) {
      const q = ok(qty) && qty > 0 ? qty : this.defQty(slipOn ? px + d * this.slip : px);
      if (!(q > 0) || !ok(q)) return 0;
      let done = 0;
      if (this.dir() === -d) {
        for (const e of this.trades.slice()) {
          if (q - done <= 1e-12) break;
          const k = Math.min(e.qty, q - done);
          this.closeTrade(e, px, k, comment || id, i, slipOn);
          done += k;
        }
      }
      const rest = q - done;
      if (rest > 1e-12 && this.allowed(d)) done += this.open(d, px, rest, id, comment, i, slipOn);
      return done;
    }
    execOrderLike(o, px, i, slipOn) { return o.order ? this.execOrder(o.dir, px, o.qty, o.id, o.comment, i, slipOn) : this.execEntry(o.dir, px, o.qty, o.id, o.comment, i, slipOn); }
    // OCA groups (TradingView): when an order of a group fills, oca.cancel cancels the group's other orders and oca.reduce
    // lowers their quantity by the filled amount (cancelling those that reach 0); oca.none orders are not grouped. The filled
    // order's type decides. strategy.exit legs with an oca_name are oca.reduce members.
    ocaFire(oca, q, self) {
      if (!oca || !oca.name || oca.type === 'none' || !(q > 0)) return;
      const hit = (o) => o !== self && !o.dead && o.oca && o.oca.name === oca.name && o.oca.type !== 'none';
      const apply = (o, px) => {
        if (oca.type === 'cancel') { o.dead = true; return; }
        const cur = ok(o.qty) && o.qty > 0 ? o.qty : this.defQty(px);
        o.qty = cur - q;
        if (!(o.qty > 1e-12)) o.dead = true;
      };
      for (const o of this.entries.values()) if (hit(o)) apply(o, ok(o.limit) ? o.limit : o.stop);
      for (const o of this.pend) if (o.type === 'entry' && hit(o)) apply(o, this.R.C[this.R.bar]);
      if (this.batch) for (const o of this.batch) if (o.type === 'entry' && hit(o)) apply(o, this.R.O[this.R.bar]);
      for (const r of this.exits.values()) {
        if (!hit(r)) continue;
        if (oca.type === 'cancel') r.dead = true;
        else if (ok(r.qty) && r.qty > 0) { r.qty -= q; if (!(r.qty > 1e-12)) r.dead = true; }
      }
      for (const [k, o] of this.entries) if (o.dead) this.entries.delete(k);
      for (const [k, r] of this.exits) if (r.dead) this.exits.delete(k);
      this.pend = this.pend.filter((o) => !o.dead);
    }
    execClose(o, px, i) {
      const list = o.all ? this.trades.slice() : this.trades.filter((e) => e.id === o.id);
      if (!list.length) return;
      const total = list.reduce((s, e) => s + e.qty, 0);
      let left = ok(o.qty) && o.qty > 0 ? Math.min(o.qty, total) : ok(o.pct) ? (total * clamp(o.pct, 0, 100)) / 100 : total;
      const reason = o.comment || (o.all ? 'Close all' : `Close ${o.id}`);
      for (const e of list) { if (left <= 1e-12) break; const q = Math.min(left, e.qty); left -= q; this.closeTrade(e, px, q, reason, i, true); }
    }
    execMarket(o, px, i) {
      if (o.dead) return;
      if (o.type === 'entry') this.ocaFire(o.oca, this.execOrderLike(o, px, i, true), o);
      else this.execClose(o, px, i);
    }
    runPending(px, i) {
      const list = this.pend;
      this.pend = []; this.batch = list;
      try { for (const o of list) this.execMarket(o, px, i); } finally { this.batch = null; }
    }

    // ── calls from the script ──
    // strategy.entry (order=false) / strategy.order (order=true). Calling again with the same id replaces the pending order.
    // With both stop and limit it is a stop-limit order: reaching the stop activates a limit order at `limit`; a stop-limit
    // that already triggered stays a limit order when the script re-issues it.
    entry(id, d, qty, limit, stop, comment, oca, order) {
      const i = this.R.bar, old = this.entries.get(id);
      this.pend = this.pend.filter((o) => !(o.type === 'entry' && o.id === id));
      this.entries.delete(id);
      const g = oca && oca.name ? oca : null;
      if (ok(limit) || ok(stop)) {
        const sl = ok(limit) && ok(stop);
        this.entries.set(id, { id, dir: d, qty, limit: ok(limit) ? limit : NA, stop: ok(stop) ? stop : NA, comment, bar: old && old.triggered && sl ? old.bar : i, oca: g, order: !!order, triggered: !!(old && old.triggered && sl) });
        return;
      }
      this.pend.push({ type: 'entry', id, dir: d, qty, comment, bar: i, oca: g, order: !!order });
    }
    close(id, comment, qty, pct, immediately, all) {
      const o = { type: 'close', id, all: !!all, qty, pct, comment };
      if (immediately) { this.execClose(o, this.R.C[this.R.bar], this.R.bar); return; }
      this.pend.push(o);
    }
    exit(a) {
      const key = `${a.id}\u0001${a.from || ''}`, old = this.exits.get(key);
      if (![a.profit, a.limit, a.loss, a.stop, a.trailPrice, a.trailPoints].some(ok)) {
        if (old) this.exits.delete(key);
        return;
      }
      this.exits.set(key, { ...a, oca: a.ocaName ? { name: a.ocaName, type: 'reduce' } : null, bar: this.R.bar, done: old ? old.done : new Set(), trail: old ? old.trail : new Map(), armed: old ? old.armed : false });
    }
    cancel(id) { this.entries.delete(id); this.pend = this.pend.filter((o) => !(o.type === 'entry' && o.id === id)); for (const [k, r] of this.exits) if (r.id === id) this.exits.delete(k); }
    cancelAll() { this.entries.clear(); this.pend = this.pend.filter((o) => o.type !== 'entry'); this.exits.clear(); }

    // ── bar processing ──
    beforeBar(i) {
      if (i > 0 && !this.onClose && this.pend.length) this.runPending(this.R.O[i], i);
      if (i > 0 && (this.entries.size || this.exits.size)) this.intrabar(i);
      this.cleanupExits();
    }
    afterBar(i) {
      if (this.onClose && this.pend.length) this.runPending(this.R.C[i], i);
      const eq = this.equityAt(this.R.C[i]);
      if (eq > this.peak) this.peak = eq;
      if (this.peak - eq > this.maxDD) this.maxDD = this.peak - eq;
    }
    cleanupExits() {
      for (const [k, r] of this.exits) {
        const m = this.trades.some((e) => !r.from || e.id === r.from);
        if (m) r.armed = true;
        else if (r.armed) this.exits.delete(k);
      }
    }
    candidates(i) {
      const out = [], mt = this.R.mintick;
      for (const o of this.entries.values()) {
        if (o.bar >= i) continue;
        if (ok(o.stop) && (!ok(o.limit) || !o.triggered)) out.push({ ent: o, X: o.stop, up: o.dir > 0, slip: true, trig: ok(o.limit) });
        else out.push({ ent: o, X: o.limit, up: o.dir < 0, slip: false });
      }
      for (const r of this.exits.values()) {
        if (r.bar >= i) continue;
        for (const e of this.trades) {
          if ((r.from && e.id !== r.from) || r.done.has(e.key)) continue;
          const d = e.dir;
          const stop = ok(r.stop) ? r.stop : ok(r.loss) ? e.px - d * r.loss * mt : NA;
          const lim = ok(r.limit) ? r.limit : ok(r.profit) ? e.px + d * r.profit * mt : NA;
          if (ok(stop)) out.push({ ex: r, e, X: stop, up: d < 0, slip: true, why: 'stop' });
          if (ok(lim)) out.push({ ex: r, e, X: lim, up: d > 0, slip: false, why: 'limit' });
          const ts = r.trail.get(e.key);
          if (ts && ts.act) out.push({ ex: r, e, X: ts.ext - d * (num(r.trailOffset) || 0) * mt, up: d < 0, slip: true, why: 'trail' });
        }
      }
      return out;
    }
    fillCand(c, X, i) {
      if (c.ent) {
        if (c.trig) { c.ent.triggered = true; return; }
        this.entries.delete(c.ent.id);
        this.ocaFire(c.ent.oca, this.execOrderLike(c.ent, X, i, c.slip), c.ent);
        return;
      }
      const r = c.ex, e = c.e;
      const q = ok(r.qty) && r.qty > 0 ? Math.min(r.qty, e.qty) : ok(r.pct) ? (e.qty * clamp(r.pct, 0, 100)) / 100 : e.qty;
      r.done.add(e.key);
      const why = c.why === 'stop' ? r.commentLoss || r.comment || `${r.id} (stop)` : c.why === 'limit' ? r.commentProfit || r.comment || `${r.id} (limit)` : r.commentTrail || r.comment || `${r.id} (trail)`;
      this.closeTrade(e, X, q, why, i, c.slip);
      if (r.oca) this.ocaFire(r.oca, q, r);
    }
    trailUpdate(a, b) {
      for (const r of this.exits.values()) {
        if (!(ok(r.trailPrice) || ok(r.trailPoints))) continue;
        for (const e of this.trades) {
          if ((r.from && e.id !== r.from) || r.done.has(e.key)) continue;
          let ts = r.trail.get(e.key);
          if (!ts) { ts = { act: false, ext: NA }; r.trail.set(e.key, ts); }
          const fav = e.dir > 0 ? Math.max(a, b) : Math.min(a, b);
          const actAt = ok(r.trailPrice) ? r.trailPrice : e.px + e.dir * r.trailPoints * this.R.mintick;
          if (!ts.act) { if (e.dir > 0 ? fav >= actAt : fav <= actAt) { ts.act = true; ts.ext = fav; } }
          else ts.ext = e.dir > 0 ? Math.max(ts.ext, fav) : Math.min(ts.ext, fav);
        }
      }
    }
    intrabar(i) {
      const R = this.R, o = R.O[i], h = R.H[i], l = R.Lo[i], c = R.C[i];
      const path = h - o < o - l ? [o, h, l, c] : [o, l, h, c];
      let pos = o, seg = 0, guard = 0;
      while (seg < 3 && guard++ < 200) {
        const cs = this.candidates(i);
        if (!cs.length) return;
        // already beyond a level at the current point (gap at the open, or a newly active order): fill here
        const now = cs.filter((x) => (x.up ? pos >= x.X : pos <= x.X));
        if (now.length) { now.sort((x, y) => (x.ent ? 1 : 0) - (y.ent ? 1 : 0)); this.fillCand(now[0], pos, i); continue; }
        const b = path[seg + 1], rising = b > pos;
        let best = null, dist = Infinity;
        for (const x of cs) {
          if (x.up !== rising) continue;
          const hit = rising ? x.X > pos && x.X <= b : x.X < pos && x.X >= b;
          if (hit && Math.abs(x.X - pos) < dist) { dist = Math.abs(x.X - pos); best = x; }
        }
        if (best) { pos = best.X; this.fillCand(best, best.X, i); continue; }
        this.trailUpdate(pos, b);
        pos = b; seg++;
      }
    }
  }

  // ── Constants (namespace members that are plain values) ──
  const CONSTS = { 'math.pi': Math.PI, 'math.e': Math.E, 'math.phi': 1.618033988749895, 'math.rphi': 0.6180339887498948 };
  for (const [k, v] of Object.entries(NAMED)) CONSTS[`color.${k}`] = v;
  const addC = (ns, names, f = (x) => x) => { for (const n of names) CONSTS[`${ns}.${n}`] = f(n); };
  addC('shape', ['xcross', 'cross', 'circle', 'triangleup', 'triangledown', 'flag', 'arrowup', 'arrowdown', 'square', 'diamond', 'labelup', 'labeldown']);
  addC('location', ['abovebar', 'belowbar', 'top', 'bottom', 'absolute']);
  addC('size', ['auto', 'tiny', 'small', 'normal', 'large', 'huge']);
  addC('plot', ['style_line', 'style_linebr', 'style_stepline', 'style_stepline_diamond', 'style_steplinebr', 'style_histogram', 'style_cross', 'style_area', 'style_areabr', 'style_columns', 'style_circles']);
  addC('hline', ['style_solid', 'style_dotted', 'style_dashed']);
  addC('line', ['style_solid', 'style_dotted', 'style_dashed', 'style_arrow_left', 'style_arrow_right', 'style_arrow_both']);
  addC('label', ['style_none', 'style_xcross', 'style_cross', 'style_triangleup', 'style_triangledown', 'style_flag', 'style_circle', 'style_arrowup', 'style_arrowdown', 'style_label_up', 'style_label_down', 'style_label_left', 'style_label_right', 'style_label_lower_left', 'style_label_lower_right', 'style_label_upper_left', 'style_label_upper_right', 'style_label_center', 'style_square', 'style_diamond', 'style_text_outline']);
  addC('box', ['style_solid', 'style_dotted', 'style_dashed']);
  addC('extend', ['none', 'left', 'right', 'both']);
  addC('xloc', ['bar_index', 'bar_time']);
  addC('yloc', ['price', 'abovebar', 'belowbar']);
  addC('text', ['align_left', 'align_center', 'align_right', 'align_top', 'align_bottom', 'wrap_auto', 'wrap_none']);
  addC('position', ['top_left', 'top_center', 'top_right', 'middle_left', 'middle_center', 'middle_right', 'bottom_left', 'bottom_center', 'bottom_right']);
  addC('display', ['all', 'none', 'data_window', 'pane', 'price_scale', 'status_line']);
  addC('format', ['inherit', 'price', 'volume', 'percent', 'mintick']);
  addC('barmerge', ['lookahead_on', 'lookahead_off', 'gaps_on', 'gaps_off']);
  addC('alert', ['freq_once_per_bar', 'freq_all', 'freq_once_per_bar_close']);
  addC('order', ['ascending', 'descending']);
  addC('font', ['family_default', 'family_monospace']);
  addC('session', ['regular', 'extended']);
  addC('adjustment', ['none', 'splits', 'dividends']);
  addC('currency', ['NONE', 'USD', 'EUR', 'GBP', 'JPY', 'CHF', 'AUD', 'CAD', 'NZD', 'BTC', 'ETH', 'USDT']);
  Object.assign(CONSTS, {
    'strategy.long': 'long', 'strategy.short': 'short', 'strategy.fixed': 'qty', 'strategy.cash': 'cash', 'strategy.percent_of_equity': 'percent',
    'strategy.commission.percent': 'percent', 'strategy.commission.cash_per_contract': 'cash', 'strategy.commission.cash_per_order': 'cash',
    'strategy.direction.long': 'long', 'strategy.direction.short': 'short', 'strategy.direction.all': 'both', 'strategy.oca.cancel': 'cancel', 'strategy.oca.reduce': 'reduce', 'strategy.oca.none': 'none',
    'dayofweek.sunday': 1, 'dayofweek.monday': 2, 'dayofweek.tuesday': 3, 'dayofweek.wednesday': 4, 'dayofweek.thursday': 5, 'dayofweek.friday': 6, 'dayofweek.saturday': 7,
    'input.integer': 'int', 'input.float': 'float', 'input.bool': 'bool', 'input.string': 'string', 'input.source': 'source', 'input.resolution': 'timeframe', 'input.session': 'session', 'input.color': 'color', 'input.time': 'time', 'input.symbol': 'symbol', 'input.price': 'price',
    'chart.bg_color': '#131722', 'chart.fg_color': '#D1D4DC', 'chart.is_standard': true, 'chart.is_heikinashi': false, 'chart.is_renko': false,
  });
  const V4_ALIAS = {
    sma: 'ta.sma', ema: 'ta.ema', rma: 'ta.rma', wma: 'ta.wma', vwma: 'ta.vwma', hma: 'ta.hma', swma: 'ta.swma', alma: 'ta.alma', linreg: 'ta.linreg', rsi: 'ta.rsi', macd: 'ta.macd',
    stoch: 'ta.stoch', atr: 'ta.atr', tr: 'ta.tr', bb: 'ta.bb', bbw: 'ta.bbw', highest: 'ta.highest', lowest: 'ta.lowest', highestbars: 'ta.highestbars', lowestbars: 'ta.lowestbars',
    crossover: 'ta.crossover', crossunder: 'ta.crossunder', cross: 'ta.cross', change: 'ta.change', mom: 'ta.mom', roc: 'ta.roc', stdev: 'ta.stdev', dev: 'ta.dev', variance: 'ta.variance',
    cci: 'ta.cci', mfi: 'ta.mfi', obv: 'ta.obv', vwap: 'ta.vwap', supertrend: 'ta.supertrend', pivothigh: 'ta.pivothigh', pivotlow: 'ta.pivotlow', valuewhen: 'ta.valuewhen',
    barssince: 'ta.barssince', cum: 'ta.cum', sar: 'ta.sar', dmi: 'ta.dmi', percentrank: 'ta.percentrank', correlation: 'ta.correlation', tsi: 'ta.tsi', wpr: 'ta.wpr', kc: 'ta.kc', kcw: 'ta.kcw',
    rising: 'ta.rising', falling: 'ta.falling', median: 'ta.median', range: 'ta.range', cog: 'ta.cog', accdist: 'ta.accdist',
    abs: 'math.abs', ceil: 'math.ceil', floor: 'math.floor', round: 'math.round', sqrt: 'math.sqrt', pow: 'math.pow', exp: 'math.exp', log: 'math.log', log10: 'math.log10',
    max: 'math.max', min: 'math.min', avg: 'math.avg', sum: 'math.sum', sign: 'math.sign', sin: 'math.sin', cos: 'math.cos', tan: 'math.tan', asin: 'math.asin', acos: 'math.acos', atan: 'math.atan',
    tostring: 'str.tostring', tonumber: 'str.tonumber', security: 'request.security', study: 'indicator', iff: 'iff', offset: 'offset',
  };
  const SOURCE_NAMES = new Set(['open', 'high', 'low', 'close', 'volume', 'hl2', 'hlc3', 'ohlc4', 'hlcc4']);
  const NAMESPACES = new Set(['ta', 'math', 'str', 'color', 'array', 'input', 'strategy', 'request', 'label', 'line', 'box', 'linefill', 'table', 'syminfo', 'timeframe', 'barstate', 'shape', 'location', 'size', 'plot', 'hline', 'extend', 'xloc', 'yloc', 'display', 'format', 'position', 'text', 'font', 'order', 'alert', 'barmerge', 'currency', 'dayofweek', 'session', 'adjustment', 'map', 'matrix', 'ticker', 'chart', 'runtime', 'log', 'polyline', 'dividends', 'earnings', 'splits', 'timezone']);
  const UNSUPPORTED_NS = { dividends: 'dividends.* (no corporate-actions data source)', earnings: 'earnings.* (no corporate-actions data source)', splits: 'splits.* (no corporate-actions data source)' };
  // chart.point: a built-in object type with the fields of TradingView's chart.point (field access / := work as for UDTs)
  const CHART_POINT = { name: 'chart.point', exported: false, fields: [{ name: 'time', base: 'int' }, { name: 'index', base: 'int' }, { name: 'price', base: 'float' }] };
  const chartPoint = (time, index, price) => { const f = Object.create(null); f.time = time; f.index = index; f.price = price; return new PObj(CHART_POINT, f); };
  const FLOW_BREAK = 1, FLOW_CONT = 2;

  // ── Builtin functions: path → { p: param names | '...', st: needs call-site state, f } ──
  function makeBuiltins(R) {
    const B = {};
    const d = (path, p, f, st) => { B[path] = { p: p === '...' ? '...' : p.split(','), f, st: !!st }; };
    const bar = () => R.bar;
    // core
    d('na', 'x', (x) => isNa(x));
    d('nz', 'source,replacement', (x, y) => (isNa(x) ? (y === undefined ? 0 : y) : x));
    d('fixnan', 'source', (st, x) => { if (!isNa(x)) st.v = x; return st.v === undefined ? NA : st.v; }, true);
    d('iff', 'condition,then,_else', (c, a, b) => (c ? a : b));
    d('int', 'x', (x) => (isNa(x) ? NA : Math.trunc(num(x))));
    d('float', 'x', (x) => num(x));
    d('bool', 'x', (x) => !!x && !isNa(x));
    d('string', 'x', (x) => (isNa(x) ? null : String(x)));
    d('color', 'x', (x) => (isNa(x) ? null : x));
    for (const t of ['label', 'line', 'box', 'linefill', 'table']) d(t, 'x', (x) => (isNa(x) ? null : x));
    d('max_bars_back', 'var,num', () => NA);
    d('runtime.error', 'message', (m) => { throw perr(String(m), R.at, 'runtime'); });
    for (const k of ['info', 'warning', 'error']) d(`log.${k}`, '...', (...a) => { if (R.logs.length < 200) R.logs.push(`${k}: ${a.length > 1 ? strFormat(R, a[0], a.slice(1)) : tostr(a[0], null, R)}`); return NA; });

    // ta
    d('ta.sma', 'source,length', (st, x, n) => smaS(st, num(x), n), true);
    d('ta.ema', 'source,length', (st, x, n) => emaS(st, x, n), true);
    d('ta.rma', 'source,length', (st, x, n) => rmaS(st, x, n), true);
    d('ta.wma', 'source,length', (st, x, n) => wmaS(st, num(x), n), true);
    d('ta.vwma', 'source,length', (st, x, n) => { const v = R.V[bar()], a = smaS(st.a || (st.a = {}), num(x) * v, n), b = smaS(st.b || (st.b = {}), v, n); return b ? a / b : NA; }, true);
    d('ta.hma', 'source,length', (st, x, len) => { const n = L(len); const a = wmaS(st.a || (st.a = {}), num(x), Math.max(1, Math.floor(n / 2))), b = wmaS(st.b || (st.b = {}), num(x), n); return wmaS(st.c || (st.c = {}), 2 * a - b, Math.max(1, Math.floor(Math.sqrt(n)))); }, true);
    d('ta.swma', 'source', (st, x) => { const b = buf(st, 'b', num(x)), i = b.length - 1; return i >= 3 ? (b[i - 3] + 2 * b[i - 2] + 2 * b[i - 1] + b[i]) / 6 : NA; }, true);
    d('ta.alma', 'series,length,offset,sigma,floor', (st, x, n, o, s, f) => almaS(st, num(x), n, o === undefined ? 0.85 : o, s === undefined ? 6 : s, !!f), true);
    d('ta.linreg', 'source,length,offset', (st, x, n, o) => linregS(st, num(x), n, o || 0), true);
    d('ta.rsi', 'source,length', (st, x, n) => rsiS(st, num(x), n), true);
    d('ta.macd', 'source,fastlen,slowlen,siglen', (st, x, f, s, g) => {
      const m = emaS(st.f || (st.f = {}), x, f) - emaS(st.s || (st.s = {}), x, s), sg = emaS(st.g || (st.g = {}), m, g);
      return new Tuple([m, sg, m - sg]);
    }, true);
    d('ta.stoch', 'source,high,low,length', (st, x, h, l, n) => { const hh = extremeS(st.h || (st.h = {}), num(h), n, true), ll = extremeS(st.l || (st.l = {}), num(l), n, false); return hh - ll ? (100 * (num(x) - ll)) / (hh - ll) : NA; }, true);
    d('ta.atr', 'length', (st, n) => rmaS(st, trAt(R, bar(), true), n), true);
    d('ta.tr', 'handle_na', (h) => trAt(R, bar(), !!h));
    d('ta.bb', 'series,length,mult', (st, x, n, m) => { const b = smaS(st.s || (st.s = {}), num(x), n), dv = num(m) * stdevS(st, num(x), n, true); return new Tuple([b, b + dv, b - dv]); }, true);
    d('ta.bbw', 'series,length,mult', (st, x, n, m) => { const b = smaS(st.s || (st.s = {}), num(x), n), dv = num(m) * stdevS(st, num(x), n, true); return (b + dv - (b - dv)) / b; }, true);
    const ext = (hi, bars) => (st, a, b) => (b === undefined ? extremeS(st, hi ? R.H[bar()] : R.Lo[bar()], a, hi, bars) : extremeS(st, num(a), b, hi, bars));
    d('ta.highest', 'source,length', ext(true, false), true);
    d('ta.lowest', 'source,length', ext(false, false), true);
    d('ta.highestbars', 'source,length', ext(true, true), true);
    d('ta.lowestbars', 'source,length', ext(false, true), true);
    d('ta.crossover', 'source1,source2', (st, a, b) => crossS(st, a, b, 1), true);
    d('ta.crossunder', 'source1,source2', (st, a, b) => crossS(st, a, b, -1), true);
    d('ta.cross', 'source1,source2', (st, a, b) => crossS(st, a, b, 0), true);
    d('ta.change', 'source,length', (st, x, n) => changeS(st, typeof x === 'boolean' ? x : num(x), n), true);
    d('ta.mom', 'source,length', (st, x, n) => changeS(st, num(x), n), true);
    d('ta.roc', 'source,length', (st, x, len) => { const n = Math.floor(num(len)), b = buf(st, 'b', num(x)), i = b.length - 1; const p = i - n >= 0 ? b[i - n] : NA; return p ? (100 * (num(x) - p)) / p : NA; }, true);
    d('ta.stdev', 'source,length,biased', (st, x, n, bi) => stdevS(st, num(x), n, bi !== false), true);
    d('ta.dev', 'source,length', (st, x, n) => devS(st, num(x), n), true);
    d('ta.variance', 'source,length,biased', (st, x, n, bi) => { const s = stdevS(st, num(x), n, bi !== false); return s * s; }, true);
    d('ta.cci', 'source,length', (st, x, len) => {
      const n = L(len), m = smaS(st.m || (st.m = {}), num(x), n), b = st.m.b, i = b.length - 1;
      if (!ok(m)) return NA;
      let md = 0; for (let k = 0; k < n; k++) md += Math.abs(b[i - k] - m); md /= n;
      return md ? (num(x) - m) / (0.015 * md) : 0;
    }, true);
    d('ta.mfi', 'series,length', (st, x, n) => {
      const v = R.V[bar()], ch = changeS(st.c || (st.c = {}), num(x), 1);
      const u = sumS(st.u || (st.u = {}), v * (ch <= 0 ? 0 : num(x)), n), dn = sumS(st.d || (st.d = {}), v * (ch >= 0 ? 0 : num(x)), n);
      if (!ok(u)) return NA;
      return dn === 0 ? 100 : 100 - 100 / (1 + u / dn);
    }, true);
    d('ta.supertrend', 'factor,atrPeriod', (st, f, n) => supertrendS(st, R, num(f), n), true);
    d('ta.pivothigh', 'source,leftbars,rightbars', (st, a, b, c) => (c === undefined ? pivotS(st, R.H[bar()], a, b, true) : pivotS(st, num(a), b, c, true)), true);
    d('ta.pivotlow', 'source,leftbars,rightbars', (st, a, b, c) => (c === undefined ? pivotS(st, R.Lo[bar()], a, b, false) : pivotS(st, num(a), b, c, false)), true);
    d('ta.valuewhen', 'condition,source,occurrence', (st, c, x, occ) => { const v = st.v || (st.v = []); if (c && !isNa(c)) v.push(x); const k = v.length - 1 - (Math.floor(num(occ)) || 0); return k >= 0 ? v[k] : NA; }, true);
    d('ta.barssince', 'condition', (st, c) => { st.k = (st.k === undefined ? -1 : st.k) + 1; if (c && !isNa(c)) st.last = st.k; return st.last === undefined ? NA : st.k - st.last; }, true);
    d('ta.cum', 'source', (st, x) => { st.s = (st.s || 0) + (ok(num(x)) ? num(x) : 0); return st.s; }, true);
    d('ta.sar', 'start,inc,max', (st, a, b, c) => sarS(st, R, num(a), num(b), num(c)), true);
    d('ta.dmi', 'diLength,adxSmoothing', (st, a, b) => dmiS(st, R, a, b), true);
    d('ta.percentrank', 'source,length', (st, x, n) => percentrankS(st, num(x), n), true);
    d('ta.correlation', 'source1,source2,length', (st, a, b, n) => correlationS(st, num(a), num(b), n), true);
    d('ta.tsi', 'source,short_length,long_length', (st, x, s, l) => {
      const pc = changeS(st.c || (st.c = {}), num(x), 1);
      const nn = emaS(st.a2 || (st.a2 = {}), emaS(st.a1 || (st.a1 = {}), pc, l), s), dd = emaS(st.b2 || (st.b2 = {}), emaS(st.b1 || (st.b1 = {}), Math.abs(pc), l), s);
      return dd ? nn / dd : NA;
    }, true);
    d('ta.wpr', 'length', (st, n) => { const h = extremeS(st.h || (st.h = {}), R.H[bar()], n, true), l = extremeS(st.l || (st.l = {}), R.Lo[bar()], n, false); return h - l ? (-100 * (h - R.C[bar()])) / (h - l) : NA; }, true);
    const kc = (w) => (st, x, n, m, useTr) => {
      const b = emaS(st.b || (st.b = {}), x, n), rg = useTr === false ? R.H[bar()] - R.Lo[bar()] : trAt(R, bar(), true), r = emaS(st.r || (st.r = {}), rg, n);
      return w ? (2 * num(m) * r) / b : new Tuple([b, b + num(m) * r, b - num(m) * r]);
    };
    d('ta.kc', 'series,length,mult,useTrueRange', kc(false), true);
    d('ta.kcw', 'series,length,mult,useTrueRange', kc(true), true);
    d('ta.rising', 'source,length', (st, x, len) => { const n = L(len), b = buf(st, 'b', num(x)), i = b.length - 1; if (i < n) return false; for (let k = 1; k <= n; k++) if (!(x > b[i - k])) return false; return true; }, true);
    d('ta.falling', 'source,length', (st, x, len) => { const n = L(len), b = buf(st, 'b', num(x)), i = b.length - 1; if (i < n) return false; for (let k = 1; k <= n; k++) if (!(x < b[i - k])) return false; return true; }, true);
    d('ta.median', 'source,length', (st, x, len) => { const n = L(len), b = buf(st, 'b', num(x)); if (!n || b.length < n) return NA; const w = b.slice(-n); if (w.some((v) => !ok(v))) return NA; w.sort((p, q) => p - q); return n % 2 ? w[(n - 1) / 2] : (w[n / 2 - 1] + w[n / 2]) / 2; }, true);
    d('ta.range', 'source,length', (st, x, n) => extremeS(st.h || (st.h = {}), num(x), n, true) - extremeS(st.l || (st.l = {}), num(x), n, false), true);
    d('ta.max', 'source', (st, x) => { if (ok(num(x)) && !(st.v >= x)) st.v = x; return st.v === undefined ? NA : st.v; }, true);
    d('ta.min', 'source', (st, x) => { if (ok(num(x)) && !(st.v <= x)) st.v = x; return st.v === undefined ? NA : st.v; }, true);
    d('ta.cog', 'source,length', (st, x, len) => { const n = L(len), b = buf(st, 'b', num(x)), i = b.length - 1; if (!n || b.length < n) return NA; let s = 0, w = 0; for (let k = 0; k < n; k++) { s += b[i - k]; w += b[i - k] * (k + 1); } return s ? -w / s : NA; }, true);
    d('ta.vwap', 'source,anchor,stdev_mult', (st, x, anchor, mult) => {
      const i = bar(), v = R.V[i];
      const reset = anchor === undefined ? i === 0 || Math.floor(R.T[i] / 86400) !== Math.floor(R.T[i - 1] / 86400) : !!anchor;
      if (reset || st.pv === undefined) { st.pv = 0; st.vv = 0; st.p2 = 0; }
      st.pv += num(x) * v; st.vv += v; st.p2 += num(x) * num(x) * v;
      const w = st.vv ? st.pv / st.vv : NA;
      if (mult === undefined) return w;
      const sd = Math.sqrt(Math.max(0, st.p2 / st.vv - w * w)) * num(mult);
      return new Tuple([w, w + sd, w - sd]);
    }, true);

    // math
    const m1 = (k, f) => d(`math.${k}`, 'number', (x) => f(num(x)));
    m1('abs', Math.abs); m1('ceil', Math.ceil); m1('floor', Math.floor); m1('sqrt', Math.sqrt); m1('exp', Math.exp); m1('log', Math.log); m1('log10', Math.log10);
    m1('sign', Math.sign); m1('sin', Math.sin); m1('cos', Math.cos); m1('tan', Math.tan); m1('asin', Math.asin); m1('acos', Math.acos); m1('atan', Math.atan);
    m1('todegrees', (x) => (x * 180) / Math.PI); m1('toradians', (x) => (x * Math.PI) / 180);
    d('math.round', 'number,precision', (x, p) => { x = num(x); if (!ok(x)) return NA; const f = 10 ** (Math.floor(num(p)) || 0); return (Math.sign(x) * Math.round(Math.abs(x) * f)) / f; });
    d('math.round_to_mintick', 'number', (x) => (ok(num(x)) ? Math.round(num(x) / R.mintick) * R.mintick : NA));
    d('math.pow', 'base,exponent', (a, b) => num(a) ** num(b));
    d('math.max', '...', (...a) => { let m = -Infinity; for (const v of a) { const x = num(v); if (!ok(x)) return NA; if (x > m) m = x; } return m; });
    d('math.min', '...', (...a) => { let m = Infinity; for (const v of a) { const x = num(v); if (!ok(x)) return NA; if (x < m) m = x; } return m; });
    d('math.avg', '...', (...a) => { let s = 0; for (const v of a) s += num(v); return s / a.length; });
    d('math.sum', 'source,length', (st, x, n) => sumS(st, num(x), n), true);
    d('math.random', 'min,max,seed', (lo, hi) => { const a = lo === undefined ? 0 : num(lo), b = hi === undefined ? 1 : num(hi); R.rng = (R.rng * 16807) % 2147483647; return a + ((R.rng - 1) / 2147483646) * (b - a); });

    // str
    d('str.tostring', 'value,format', (v, f) => tostr(v, f, R));
    d('str.format', '...', (f, ...a) => strFormat(R, f, a));
    d('str.length', 'string', (s) => (isNa(s) ? NA : String(s).length));
    d('str.contains', 'source,str', (s, t) => !isNa(s) && String(s).includes(String(t)));
    d('str.startswith', 'source,str', (s, t) => !isNa(s) && String(s).startsWith(String(t)));
    d('str.endswith', 'source,str', (s, t) => !isNa(s) && String(s).endsWith(String(t)));
    d('str.pos', 'source,str', (s, t) => { const k = String(s).indexOf(String(t)); return k < 0 ? NA : k; });
    d('str.replace', 'source,target,replacement,occurrence', (s, t, r, o) => { s = String(s); t = String(t); let k = -1; for (let q = 0; q <= (o || 0); q++) { k = s.indexOf(t, k + 1); if (k < 0) return s; } return s.slice(0, k) + r + s.slice(k + t.length); });
    d('str.replace_all', 'source,target,replacement', (s, t, r) => String(s).split(String(t)).join(String(r)));
    d('str.substring', 'source,begin_pos,end_pos', (s, a, b) => String(s).substring(num(a), b === undefined ? undefined : num(b)));
    d('str.upper', 'source', (s) => String(s).toUpperCase());
    d('str.lower', 'source', (s) => String(s).toLowerCase());
    d('str.trim', 'source', (s) => String(s).trim());
    d('str.repeat', 'source,repeat,separator', (s, n, sep) => Array(Math.max(0, num(n) | 0)).fill(String(s)).join(sep === undefined ? '' : String(sep)));
    d('str.tonumber', 'string', (s) => { const x = parseFloat(String(s)); return /^\s*[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?\s*$/.test(String(s)) ? x : NA; });
    d('str.split', 'string,separator', (s, sep) => new PArray(String(s).split(String(sep)), 'string'));
    d('str.format_time', 'time,format,timezone', (t, f) => { const dt = new Date(num(t)), p = (x, w = 2) => String(x).padStart(w, '0'); return String(f === undefined ? "yyyy-MM-dd'T'HH:mm:ssZ" : f).replace(/yyyy|MM|dd|HH|mm|ss|'([^']*)'/g, (m, q) => (q !== undefined ? q : m === 'yyyy' ? dt.getUTCFullYear() : m === 'MM' ? p(dt.getUTCMonth() + 1) : m === 'dd' ? p(dt.getUTCDate()) : m === 'HH' ? p(dt.getUTCHours()) : m === 'mm' ? p(dt.getUTCMinutes()) : p(dt.getUTCSeconds()))); });

    // color
    d('color.new', 'color,transp', (c, t) => (isNa(c) ? null : withTransp(c, t === undefined ? 0 : num(t))));
    d('color.rgb', 'red,green,blue,transp', (r, g, b, t) => mkColor(num(r), num(g), num(b), (100 - (t === undefined ? 0 : num(t))) / 100));
    const ch = (k) => (c) => { const p = parseColor(c); return p ? (k === 3 ? Math.round((1 - p[3]) * 100) : p[k]) : NA; };
    d('color.r', 'color', ch(0)); d('color.g', 'color', ch(1)); d('color.b', 'color', ch(2)); d('color.t', 'color', ch(3));
    d('color.from_gradient', 'value,bottom_value,top_value,bottom_color,top_color', (v, lo, hi, c1, c2) => {
      if (isNa(v)) return null;
      const k = hi === lo ? 1 : clamp((num(v) - num(lo)) / (num(hi) - num(lo)), 0, 1), a = parseColor(c1) || [0, 0, 0, 1], b = parseColor(c2) || [0, 0, 0, 1];
      return mkColor(a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k, a[2] + (b[2] - a[2]) * k, a[3] + (b[3] - a[3]) * k);
    });

    // time
    const tparts = (t) => new Date(num(t));
    d('year', 'time,timezone', (t) => tparts(t).getUTCFullYear());
    d('month', 'time,timezone', (t) => tparts(t).getUTCMonth() + 1);
    d('dayofmonth', 'time,timezone', (t) => tparts(t).getUTCDate());
    d('dayofweek', 'time,timezone', (t) => tparts(t).getUTCDay() + 1);
    d('hour', 'time,timezone', (t) => tparts(t).getUTCHours());
    d('minute', 'time,timezone', (t) => tparts(t).getUTCMinutes());
    d('second', 'time,timezone', (t) => tparts(t).getUTCSeconds());
    d('weekofyear', 'time,timezone', (t) => isoWeek(num(t)));
    d('timestamp', '...', (...a) => {
      let off = 0;
      if (typeof a[0] === 'string' && a.length === 1) { const x = Date.parse(a[0]); return ok(x) ? x : NA; }
      if (typeof a[0] === 'string') { off = tzOffset(a.shift()); }
      const [y, mo, dd, h = 0, mi = 0, s = 0] = a.map(num);
      return Date.UTC(y, mo - 1, dd, h, mi, s) - off * 3600000;
    });
    d('time', 'timeframe,session,timezone', (tf, sess, tz) => timeFn(R, tf, sess, tz, false));
    d('time_close', 'timeframe,session,timezone', (tf, sess, tz) => timeFn(R, tf, sess, tz, true));
    d('timeframe.in_seconds', 'timeframe', (tf) => (tf === undefined || tf === '' ? R.tfSec : tfSecOf(tf) || NA));
    d('timeframe.from_seconds', 'seconds', (s) => tfString(num(s)));
    d('timeframe.change', 'timeframe', (tf) => { const s = tf === undefined || tf === '' ? R.tfSec : tfSecOf(tf); const i = bar(); return i === 0 || bucketOf(R.T[i], s) !== bucketOf(R.T[i - 1], s); });

    // arrays
    const A = (x, path) => { if (!isArrV(x)) throw perr(`${path}: the first argument must be an array${isNa(x) ? ' (it is na)' : ''}`, R.at, 'runtime'); return x.a; };
    const IX = (a, i, path) => { let k = Math.floor(num(i)); if (k < 0) k += a.length; if (!(k >= 0 && k < a.length)) throw perr(`${path}: index ${num(i)} is out of bounds (array size ${a.length})`, R.at, 'runtime'); return k; };
    const newArr = (et) => (n, v) => { const sz = n === undefined ? 0 : Math.floor(num(n)); if (!(sz >= 0) || sz > 100000) throw perr(`array size ${n} is invalid (0–100000)`, R.at, 'runtime'); return new PArray(new Array(sz).fill(v === undefined ? (et === 'bool' ? false : et === 'float' || et === 'int' ? NA : null) : v), et); };
    for (const et of ['float', 'int', 'bool', 'string', 'color', 'line', 'label', 'box', 'linefill', 'table']) d(`array.new_${et}`, 'size,initial_value', newArr(et));
    d('array.new', 'size,initial_value', newArr('float'));
    d('array.from', '...', (...a) => new PArray(a.slice()));
    d('array.size', 'id', (x) => A(x, 'array.size').length);
    d('array.push', 'id,value', (x, v) => { A(x, 'array.push').push(v); return NA; });
    d('array.unshift', 'id,value', (x, v) => { A(x, 'array.unshift').unshift(v); return NA; });
    d('array.pop', 'id', (x) => { const a = A(x, 'array.pop'); if (!a.length) throw perr('array.pop: the array is empty', R.at, 'runtime'); return a.pop(); });
    d('array.shift', 'id', (x) => { const a = A(x, 'array.shift'); if (!a.length) throw perr('array.shift: the array is empty', R.at, 'runtime'); return a.shift(); });
    d('array.get', 'id,index', (x, i) => { const a = A(x, 'array.get'); return a[IX(a, i, 'array.get')]; });
    d('array.set', 'id,index,value', (x, i, v) => { const a = A(x, 'array.set'); a[IX(a, i, 'array.set')] = v; return NA; });
    d('array.first', 'id', (x) => { const a = A(x, 'array.first'); if (!a.length) throw perr('array.first: the array is empty', R.at, 'runtime'); return a[0]; });
    d('array.last', 'id', (x) => { const a = A(x, 'array.last'); if (!a.length) throw perr('array.last: the array is empty', R.at, 'runtime'); return a[a.length - 1]; });
    d('array.clear', 'id', (x) => { A(x, 'array.clear').length = 0; return NA; });
    d('array.insert', 'id,index,value', (x, i, v) => { const a = A(x, 'array.insert'); let k = Math.floor(num(i)); if (k < 0) k += a.length; if (!(k >= 0 && k <= a.length)) throw perr(`array.insert: index ${i} is out of bounds (array size ${a.length})`, R.at, 'runtime'); a.splice(k, 0, v); return NA; });
    d('array.remove', 'id,index', (x, i) => { const a = A(x, 'array.remove'); return a.splice(IX(a, i, 'array.remove'), 1)[0]; });
    d('array.includes', 'id,value', (x, v) => A(x, 'array.includes').includes(v));
    d('array.indexof', 'id,value', (x, v) => A(x, 'array.indexof').indexOf(v));
    d('array.lastindexof', 'id,value', (x, v) => A(x, 'array.lastindexof').lastIndexOf(v));
    const nums = (x, p) => A(x, p).map(num);
    d('array.sum', 'id', (x) => nums(x, 'array.sum').reduce((s, v) => s + v, 0));
    d('array.avg', 'id', (x) => { const a = nums(x, 'array.avg'); return a.length ? a.reduce((s, v) => s + v, 0) / a.length : NA; });
    d('array.min', 'id,nth', (x, k) => { const a = nums(x, 'array.min').filter(ok).sort((p, q) => p - q); const i = Math.floor(num(k)) || 0; return i < a.length ? a[i] : NA; });
    d('array.max', 'id,nth', (x, k) => { const a = nums(x, 'array.max').filter(ok).sort((p, q) => q - p); const i = Math.floor(num(k)) || 0; return i < a.length ? a[i] : NA; });
    d('array.median', 'id', (x) => { const a = nums(x, 'array.median').filter(ok).sort((p, q) => p - q), n = a.length; return n ? (n % 2 ? a[(n - 1) / 2] : (a[n / 2 - 1] + a[n / 2]) / 2) : NA; });
    const avar = (x, biased, p) => { const a = nums(x, p), n = a.length; if (!n) return NA; const m = a.reduce((s, v) => s + v, 0) / n; return a.reduce((s, v) => s + (v - m) ** 2, 0) / (biased === false && n > 1 ? n - 1 : n); };
    d('array.variance', 'id,biased', (x, b) => avar(x, b, 'array.variance'));
    d('array.stdev', 'id,biased', (x, b) => Math.sqrt(avar(x, b, 'array.stdev')));
    d('array.covariance', 'id1,id2,biased', (x, y, b) => { const a = nums(x, 'array.covariance'), c = nums(y, 'array.covariance'), n = Math.min(a.length, c.length); if (!n) return NA; const ma = a.reduce((s, v) => s + v, 0) / a.length, mc = c.reduce((s, v) => s + v, 0) / c.length; let s = 0; for (let k = 0; k < n; k++) s += (a[k] - ma) * (c[k] - mc); return s / (b === false && n > 1 ? n - 1 : n); });
    d('array.range', 'id', (x) => { const a = nums(x, 'array.range').filter(ok); return a.length ? Math.max(...a) - Math.min(...a) : NA; });
    d('array.sort', 'id,order', (x, o) => { A(x, 'array.sort').sort((p, q) => (typeof p === 'string' ? String(p).localeCompare(q) : num(p) - num(q)) * (o === 'descending' ? -1 : 1)); return NA; });
    d('array.sort_indices', 'id,order', (x, o) => { const a = A(x, 'array.sort_indices'); return new PArray(a.map((_, k) => k).sort((p, q) => (num(a[p]) - num(a[q])) * (o === 'descending' ? -1 : 1)), 'int'); });
    d('array.reverse', 'id', (x) => { A(x, 'array.reverse').reverse(); return NA; });
    d('array.slice', 'id,index_from,index_to', (x, f, t) => new PArray(A(x, 'array.slice').slice(num(f), t === undefined ? undefined : num(t)), x.et));
    d('array.concat', 'id1,id2', (x, y) => { A(x, 'array.concat').push(...A(y, 'array.concat')); return x; });
    d('array.copy', 'id', (x) => new PArray(A(x, 'array.copy').slice(), x.et));
    d('array.fill', 'id,value,index_from,index_to', (x, v, f, t) => { A(x, 'array.fill').fill(v, f === undefined ? 0 : num(f), t === undefined ? undefined : num(t)); return NA; });
    d('array.join', 'id,separator', (x, s) => A(x, 'array.join').map((v) => tostr(v, null, R)).join(s === undefined ? ',' : String(s)));
    d('array.abs', 'id', (x) => new PArray(nums(x, 'array.abs').map(Math.abs), x.et));
    d('array.every', 'id', (x) => A(x, 'array.every').every((v) => !!v));
    d('array.some', 'id', (x) => A(x, 'array.some').some((v) => !!v));

    // drawings
    defineDrawings(R, d);
    defineTables(R, d);
    defineMaps(R, d);
    defineTickers(R, d);
    defineMatrices(R, d);
    return B;
  }

  // table objects (kept in R.objs.table; their state after the last bar is drawn by pine-render.js as an HTML overlay)
  function defineTables(R, d) {
    const T = (o, fn) => { if (isNa(o)) return null; if (!o || o.__t !== 'table') throw perr(`${fn}: expected a table object`, R.at, 'runtime'); return o.deleted ? null : o; };
    const cellAt = (t, c, r, fn, create) => {
      const ci = Math.floor(num(c)), ri = Math.floor(num(r));
      if (!(ci >= 0 && ci < t.cols && ri >= 0 && ri < t.rows)) throw perr(`${fn}: cell (column ${num(c)}, row ${num(r)}) is outside the table (${t.cols} columns × ${t.rows} rows)`, R.at, 'runtime');
      const k = ri * t.cols + ci;
      let x = t.cells.get(k);
      if (!x && create) { x = { c: ci, r: ri, text: '', width: 0, height: 0, tc: '#000000', halign: 'center', valign: 'center', size: 'normal', bg: null, tooltip: '' }; t.cells.set(k, x); }
      return x;
    };
    d('table.new', 'position,columns,rows,bgcolor,frame_color,frame_width,border_color,border_width,force_overlay', (pos, cols, rows, bg, fc, fw, bc, bw) => {
      const nc = Math.floor(num(cols)), nr = Math.floor(num(rows));
      if (!(nc >= 1 && nr >= 1) || nc * nr > 10000) throw perr(`table.new: invalid size ${num(cols)} × ${num(rows)} (1–10000 cells)`, R.at, 'runtime');
      const t = { __t: 'table', position: isNa(pos) ? 'top_right' : String(pos), cols: nc, rows: nr, bg: bg === undefined || isNa(bg) ? null : bg, frame: fc === undefined || isNa(fc) ? null : fc, frameW: fw === undefined ? 0 : num(fw) || 0, border: bc === undefined || isNa(bc) ? null : bc, borderW: bw === undefined ? 0 : num(bw) || 0, cells: new Map(), merges: [], seq: R.tableSeq = (R.tableSeq || 0) + 1 };
      if (!R.sub) R.objs.table.push(t);
      return t;
    });
    d('table.cell', 'table_id,column,row,text,width,height,text_color,text_halign,text_valign,text_size,bgcolor,tooltip,text_font_family,text_formatting', (o, c, r, text, w, h, tc, ha, va, sz, bg, tip, ff) => {
      const t = T(o, 'table.cell'); if (!t) return NA;
      cellAt(t, c, r, 'table.cell', false);
      const k = Math.floor(num(r)) * t.cols + Math.floor(num(c));
      t.cells.set(k, { c: Math.floor(num(c)), r: Math.floor(num(r)), text: text === undefined || isNa(text) ? '' : tostr(text, null, R), width: w === undefined ? 0 : num(w) || 0, height: h === undefined ? 0 : num(h) || 0,
        tc: tc === undefined ? '#000000' : isNa(tc) ? null : tc, halign: ha === undefined || isNa(ha) ? 'center' : String(ha).replace('align_', ''), valign: va === undefined || isNa(va) ? 'center' : String(va).replace('align_', ''),
        size: sz === undefined || isNa(sz) ? 'normal' : typeof sz === 'number' ? sz : String(sz), bg: bg === undefined || isNa(bg) ? null : bg, tooltip: tip === undefined || isNa(tip) ? '' : String(tip), mono: ff === 'family_monospace' });
      return NA;
    });
    const cs = (k, apply) => d(`table.cell_set_${k}`, 'table_id,column,row,value', (o, c, r, v) => { const t = T(o, `table.cell_set_${k}`); if (t) apply(cellAt(t, c, r, `table.cell_set_${k}`, true), v); return NA; });
    cs('text', (x, v) => { x.text = isNa(v) ? '' : tostr(v, null, R); });
    cs('bgcolor', (x, v) => { x.bg = isNa(v) ? null : v; });
    cs('text_color', (x, v) => { x.tc = isNa(v) ? null : v; });
    cs('text_size', (x, v) => { x.size = typeof v === 'number' ? v : String(v); });
    cs('width', (x, v) => { x.width = num(v) || 0; });
    cs('height', (x, v) => { x.height = num(v) || 0; });
    cs('tooltip', (x, v) => { x.tooltip = isNa(v) ? '' : String(v); });
    cs('text_halign', (x, v) => { x.halign = String(v).replace('align_', ''); });
    cs('text_valign', (x, v) => { x.valign = String(v).replace('align_', ''); });
    cs('text_font_family', (x, v) => { x.mono = v === 'family_monospace'; });
    cs('text_formatting', () => {});
    d('table.merge_cells', 'table_id,start_column,start_row,end_column,end_row', (o, c0, r0, c1, r1) => {
      const t = T(o, 'table.merge_cells'); if (!t) return NA;
      const a = [c0, r0, c1, r1].map((v) => Math.floor(num(v)));
      cellAt(t, a[0], a[1], 'table.merge_cells', false); cellAt(t, a[2], a[3], 'table.merge_cells', false);
      if (a[2] < a[0] || a[3] < a[1]) throw perr('table.merge_cells: the end cell must be below/right of the start cell', R.at, 'runtime');
      if (t.merges.some((m) => !(a[2] < m.c0 || a[0] > m.c1 || a[3] < m.r0 || a[1] > m.r1))) throw perr('table.merge_cells: the range overlaps an already merged range', R.at, 'runtime');
      t.merges.push({ c0: a[0], r0: a[1], c1: a[2], r1: a[3] });
      return NA;
    });
    d('table.clear', 'table_id,start_column,start_row,end_column,end_row', (o, c0, r0, c1, r1) => {
      const t = T(o, 'table.clear'); if (!t) return NA;
      const a0 = Math.floor(num(c0)), b0 = Math.floor(num(r0)), a1 = c1 === undefined ? a0 : Math.floor(num(c1)), b1 = r1 === undefined ? b0 : Math.floor(num(r1));
      cellAt(t, a0, b0, 'table.clear', false); cellAt(t, a1, b1, 'table.clear', false);
      for (const [k, x] of t.cells) if (x.c >= a0 && x.c <= a1 && x.r >= b0 && x.r <= b1) t.cells.delete(k);
      t.merges = t.merges.filter((m) => !(m.c0 >= a0 && m.c1 <= a1 && m.r0 >= b0 && m.r1 <= b1));
      return NA;
    });
    d('table.delete', 'table_id', (o) => { if (isNa(o)) return NA; T(o, 'table.delete'); o.deleted = true; const l = R.objs.table, k = l.indexOf(o); if (k >= 0) l.splice(k, 1); return NA; });
    const ts = (k, apply) => d(`table.set_${k}`, 'table_id,value', (o, v) => { const t = T(o, `table.set_${k}`); if (t) apply(t, v); return NA; });
    ts('position', (t, v) => { t.position = String(v); });
    ts('bgcolor', (t, v) => { t.bg = isNa(v) ? null : v; });
    ts('frame_color', (t, v) => { t.frame = isNa(v) ? null : v; });
    ts('frame_width', (t, v) => { t.frameW = num(v) || 0; });
    ts('border_color', (t, v) => { t.border = isNa(v) ? null : v; });
    ts('border_width', (t, v) => { t.borderW = num(v) || 0; });
  }

  // ── Ticker ids with modifiers ──
  // A plain id is "PREFIX:SYMBOL"; with modifiers it is "=" + JSON, the form TradingView uses (e.g.
  // ={"symbol":"IG:X","type":"heikinashi"}). request.security() decodes it with parseTicker().
  const TICKER_KEYS = ['adjustment', 'backadjustment', 'session', 'settlement_as_close', 'symbol', 'type'];
  function parseTicker(id) {
    const s = String(isNa(id) ? '' : id).trim();
    if (!s.startsWith('=')) return { symbol: s };
    let o;
    try { o = JSON.parse(s.slice(1)); } catch (e) { o = null; }
    if (!o || typeof o !== 'object' || typeof o.symbol !== 'string') return { symbol: s, bad: true };
    return o;
  }
  function tickerId(o) {
    const keys = TICKER_KEYS.filter((k) => o[k] !== undefined && o[k] !== null && o[k] !== '' && !(k === 'type' && o[k] === 'standard'));
    if (keys.length === 1 && keys[0] === 'symbol') return o.symbol;
    const out = {};
    for (const k of keys) out[k] = o[k];
    return `=${JSON.stringify(out)}`;
  }
  const NON_TIME_TICKERS = { renko: 'Renko', linebreak: 'Line Break', kagi: 'Kagi', pointfigure: 'Point & Figure' };
  function defineTickers(R, d) {
    const sym = (v) => (v === undefined || isNa(v) || v === '' ? R.tickerid : String(v));
    const mods = (o, session, adjustment, back, settle) => {
      if (session !== undefined && !isNa(session)) o.session = String(session);
      if (adjustment !== undefined && !isNa(adjustment)) o.adjustment = String(adjustment);
      if (back !== undefined && !isNa(back)) o.backadjustment = String(back).replace(/^backadjustment\./, '');
      if (settle !== undefined && !isNa(settle)) o.settlement_as_close = String(settle).replace(/^settlement_as_close\./, '');
      return o;
    };
    d('ticker.new', 'prefix,ticker,session,adjustment,backadjustment,settlement_as_close', (p, t, s, a, b, c) => tickerId(mods({ symbol: isNa(p) || p === '' ? String(t) : `${p}:${t}` }, s, a, b, c)));
    d('ticker.modify', 'tickerid,session,adjustment,backadjustment,settlement_as_close', (id, s, a, b, c) => tickerId(mods({ ...parseTicker(sym(id)) }, s, a, b, c)));
    d('ticker.standard', 'symbol', (id) => parseTicker(sym(id)).symbol);
    d('ticker.inherit', 'from_tickerid,symbol', (from, id) => { const f = parseTicker(sym(from)); return tickerId({ ...f, symbol: parseTicker(sym(id)).symbol }); });
    d('ticker.heikinashi', 'symbol', (id) => tickerId({ ...parseTicker(sym(id)), type: 'heikinashi' }));
  }
  // Heikin-Ashi bars of OHLC columns: HA close = ohlc4, HA open = (prev HA open + prev HA close) / 2 (first: (open + close) / 2),
  // HA high/low = the extremes of high/low and the HA open/close.
  function heikinAshi(c) {
    const n = c.n, O = new Float64Array(n), H = new Float64Array(n), Lo = new Float64Array(n), C = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      C[i] = (c.O[i] + c.H[i] + c.Lo[i] + c.C[i]) / 4;
      O[i] = i ? (O[i - 1] + C[i - 1]) / 2 : (c.O[i] + c.C[i]) / 2;
      H[i] = Math.max(c.H[i], O[i], C[i]); Lo[i] = Math.min(c.Lo[i], O[i], C[i]);
    }
    return { T: c.T, O, H, Lo, C, V: c.V, n };
  }

  // map<K, V>
  function defineMaps(R, d) {
    const M = (x, fn) => { if (!(x instanceof PMap)) throw perr(`${fn}: the first argument must be a map${isNa(x) ? ' (it is na)' : ''}`, R.at, 'runtime'); return x.m; };
    const key = (k, fn) => { if (isNa(k)) throw perr(`${fn}: map keys cannot be na`, R.at, 'runtime'); return k; };
    d('map.new', '', () => new PMap());
    d('map.put', 'id,key,value', (x, k, v) => { const m = M(x, 'map.put'), had = m.has(key(k, 'map.put')), old = m.get(k); m.set(k, v); return had ? old : NA; });
    d('map.put_all', 'id,id2', (x, y) => { const m = M(x, 'map.put_all'); for (const [k, v] of M(y, 'map.put_all')) m.set(k, v); return NA; });
    d('map.get', 'id,key', (x, k) => { const m = M(x, 'map.get'); return m.has(k) ? m.get(k) : NA; });
    d('map.contains', 'id,key', (x, k) => M(x, 'map.contains').has(k));
    d('map.remove', 'id,key', (x, k) => { const m = M(x, 'map.remove'); if (!m.has(k)) return NA; const v = m.get(k); m.delete(k); return v; });
    d('map.keys', 'id', (x) => new PArray([...M(x, 'map.keys').keys()]));
    d('map.values', 'id', (x) => new PArray([...M(x, 'map.values').values()]));
    d('map.size', 'id', (x) => M(x, 'map.size').size);
    d('map.clear', 'id', (x) => { M(x, 'map.clear').clear(); return NA; });
    d('map.copy', 'id', (x) => new PMap(new Map(M(x, 'map.copy'))));
  }

  // matrix<T>: the common subset (construction, element access, rows/columns, fill, copy, transpose, mult, sum, diff, avg/min/max)
  function defineMatrices(R, d) {
    const X = (x, fn) => { if (!(x instanceof PMatrix)) throw perr(`${fn}: the first argument must be a matrix${isNa(x) ? ' (it is na)' : ''}`, R.at, 'runtime'); return x; };
    const ri = (m, r, fn, extra = 0) => { const k = Math.floor(num(r)); if (!(k >= 0 && k < m.r + extra)) throw perr(`${fn}: row ${num(r)} is out of bounds (matrix has ${m.r} rows)`, R.at, 'runtime'); return k; };
    const ci = (m, c, fn, extra = 0) => { const k = Math.floor(num(c)); if (!(k >= 0 && k < m.c + extra)) throw perr(`${fn}: column ${num(c)} is out of bounds (matrix has ${m.c} columns)`, R.at, 'runtime'); return k; };
    const all = (m) => { const o = []; for (const row of m.d) for (const v of row) o.push(num(v)); return o; };
    d('matrix.new', 'rows,columns,initial_value', (r, c, v) => {
      const nr = r === undefined ? 0 : Math.floor(num(r)), nc = c === undefined ? 0 : Math.floor(num(c));
      if (!(nr >= 0 && nc >= 0) || nr * nc > 100000) throw perr(`matrix.new: invalid size ${num(r)} × ${num(c)} (0–100000 elements)`, R.at, 'runtime');
      const iv = v === undefined ? NA : v;
      return new PMatrix(Array.from({ length: nr }, () => new Array(nc).fill(iv)), nc);
    });
    d('matrix.get', 'id,row,column', (x, r, c) => { const m = X(x, 'matrix.get'); return m.d[ri(m, r, 'matrix.get')][ci(m, c, 'matrix.get')]; });
    d('matrix.set', 'id,row,column,value', (x, r, c, v) => { const m = X(x, 'matrix.set'); m.d[ri(m, r, 'matrix.set')][ci(m, c, 'matrix.set')] = v; return NA; });
    d('matrix.rows', 'id', (x) => X(x, 'matrix.rows').r);
    d('matrix.columns', 'id', (x) => X(x, 'matrix.columns').c);
    d('matrix.elements_count', 'id', (x) => { const m = X(x, 'matrix.elements_count'); return m.r * m.c; });
    d('matrix.is_square', 'id', (x) => { const m = X(x, 'matrix.is_square'); return m.r === m.c; });
    d('matrix.row', 'id,row', (x, r) => { const m = X(x, 'matrix.row'); return new PArray(m.d[ri(m, r, 'matrix.row')].slice()); });
    d('matrix.col', 'id,column', (x, c) => { const m = X(x, 'matrix.col'); const k = ci(m, c, 'matrix.col'); return new PArray(m.d.map((row) => row[k])); });
    d('matrix.add_row', 'id,row,array_id', (x, r, a) => {
      const m = X(x, 'matrix.add_row'), k = r === undefined ? m.r : ri(m, r, 'matrix.add_row', 1);
      let row;
      if (a === undefined || isNa(a)) row = new Array(m.c).fill(NA);
      else { if (!isArrV(a)) throw perr('matrix.add_row: array_id must be an array', R.at, 'runtime'); if (m.r === 0 && m.c === 0) m.c = a.a.length; if (a.a.length !== m.c) throw perr(`matrix.add_row: the array has ${a.a.length} elements, the matrix has ${m.c} columns`, R.at, 'runtime'); row = a.a.slice(); }
      m.d.splice(k, 0, row);
      return NA;
    });
    d('matrix.add_col', 'id,column,array_id', (x, c, a) => {
      const m = X(x, 'matrix.add_col'), k = c === undefined ? m.c : ci(m, c, 'matrix.add_col', 1);
      if (a !== undefined && !isNa(a)) {
        if (!isArrV(a)) throw perr('matrix.add_col: array_id must be an array', R.at, 'runtime');
        if (m.r === 0 && m.c === 0) for (let i = 0; i < a.a.length; i++) m.d.push([]);
        if (a.a.length !== m.r) throw perr(`matrix.add_col: the array has ${a.a.length} elements, the matrix has ${m.r} rows`, R.at, 'runtime');
        m.d.forEach((row, i) => row.splice(k, 0, a.a[i]));
      } else m.d.forEach((row) => row.splice(k, 0, NA));
      m.c++;
      return NA;
    });
    d('matrix.remove_row', 'id,row', (x, r) => { const m = X(x, 'matrix.remove_row'); if (!m.r) throw perr('matrix.remove_row: the matrix is empty', R.at, 'runtime'); const k = r === undefined ? m.r - 1 : ri(m, r, 'matrix.remove_row'); return new PArray(m.d.splice(k, 1)[0]); });
    d('matrix.remove_col', 'id,column', (x, c) => { const m = X(x, 'matrix.remove_col'); if (!m.c) throw perr('matrix.remove_col: the matrix has no columns', R.at, 'runtime'); const k = c === undefined ? m.c - 1 : ci(m, c, 'matrix.remove_col'); const out = m.d.map((row) => row.splice(k, 1)[0]); m.c--; return new PArray(out); });
    d('matrix.fill', 'id,value,from_row,to_row,from_column,to_column', (x, v, r0, r1, c0, c1) => {
      const m = X(x, 'matrix.fill'), a = r0 === undefined ? 0 : Math.floor(num(r0)), b = r1 === undefined ? m.r : Math.floor(num(r1)), p = c0 === undefined ? 0 : Math.floor(num(c0)), q = c1 === undefined ? m.c : Math.floor(num(c1));
      for (let i = Math.max(0, a); i < Math.min(m.r, b); i++) for (let j = Math.max(0, p); j < Math.min(m.c, q); j++) m.d[i][j] = v;
      return NA;
    });
    d('matrix.copy', 'id', (x) => { const m = X(x, 'matrix.copy'); return new PMatrix(m.d.map((row) => row.slice()), m.c); });
    d('matrix.transpose', 'id', (x) => { const m = X(x, 'matrix.transpose'); return new PMatrix(Array.from({ length: m.c }, (_, j) => m.d.map((row) => row[j])), m.r); });
    const ew = (fn, op) => (x, y) => {
      const m = X(x, fn);
      if (y instanceof PMatrix) {
        if (y.r !== m.r || y.c !== m.c) throw perr(`${fn}: matrices must have the same size (${m.r}×${m.c} vs ${y.r}×${y.c})`, R.at, 'runtime');
        return new PMatrix(m.d.map((row, i) => row.map((v, j) => op(num(v), num(y.d[i][j])))), m.c);
      }
      const s = num(y);
      return new PMatrix(m.d.map((row) => row.map((v) => op(num(v), s))), m.c);
    };
    d('matrix.sum', 'id1,id2', ew('matrix.sum', (a, b) => a + b));
    d('matrix.diff', 'id1,id2', ew('matrix.diff', (a, b) => a - b));
    d('matrix.mult', 'id1,id2', (x, y) => {
      const m = X(x, 'matrix.mult');
      if (y instanceof PMatrix) {
        if (m.c !== y.r) throw perr(`matrix.mult: the first matrix has ${m.c} columns but the second has ${y.r} rows`, R.at, 'runtime');
        const out = Array.from({ length: m.r }, (_, i) => Array.from({ length: y.c }, (__, j) => { let s = 0; for (let k = 0; k < m.c; k++) s += num(m.d[i][k]) * num(y.d[k][j]); return s; }));
        return new PMatrix(out, y.c);
      }
      if (isArrV(y)) {
        if (y.a.length !== m.c) throw perr(`matrix.mult: the array has ${y.a.length} elements but the matrix has ${m.c} columns`, R.at, 'runtime');
        return new PArray(m.d.map((row) => row.reduce((s, v, k) => s + num(v) * num(y.a[k]), 0)));
      }
      const s = num(y);
      return new PMatrix(m.d.map((row) => row.map((v) => num(v) * s)), m.c);
    });
    d('matrix.avg', 'id', (x) => { const a = all(X(x, 'matrix.avg')); return a.length ? a.reduce((s, v) => s + v, 0) / a.length : NA; });
    d('matrix.max', 'id', (x) => { const a = all(X(x, 'matrix.max')); return a.length ? Math.max(...a) : NA; });
    d('matrix.min', 'id', (x) => { const a = all(X(x, 'matrix.min')); return a.length ? Math.min(...a) : NA; });
  }
  const MATRIX_FNS = 'new, get, set, rows, columns, elements_count, is_square, row, col, add_row, add_col, remove_row, remove_col, fill, copy, transpose, mult, sum, diff, avg, max, min';
  function isoWeek(ms) { const dt = new Date(ms); const t = Date.UTC(dt.getUTCFullYear(), dt.getUTCMonth(), dt.getUTCDate()); const day = (new Date(t).getUTCDay() + 6) % 7; const th = t - day * 86400000 + 3 * 86400000; const y0 = Date.UTC(new Date(th).getUTCFullYear(), 0, 4); return 1 + Math.round((th - y0) / 604800000 - ((new Date(y0).getUTCDay() + 6) % 7 - 3) / 7); }
  function tzOffset(tz) { const m = /^(?:UTC|GMT)\s*([+-])\s*(\d{1,2})(?::?(\d{2}))?$/i.exec(String(tz || '').trim()); if (!m) return 0; return (m[1] === '-' ? -1 : 1) * (+m[2] + (m[3] ? +m[3] / 60 : 0)); }
  // time(tf, session, tz): bucket start (ms) of tf containing the bar, or na when the bar is outside the session.
  function timeFn(R, tf, sess, tz, close) {
    const i = R.bar, t = R.T[i], s = tf === undefined || tf === '' ? R.tfSec : tfSecOf(tf);
    if (!s) return NA;
    if (sess !== undefined && sess !== null && sess !== '' && !inSession(t, String(sess), tzOffset(tz))) return NA;
    const b = s === R.tfSec ? t : bucketOf(t, s);
    return (close ? b + s : b) * 1000;
  }
  function inSession(t, sess, offH) {
    if (/^24x7$/i.test(sess)) return true;
    const [spans, days] = sess.split(':');
    const lt = t + offH * 3600, dt = new Date(lt * 1000), dow = dt.getUTCDay() + 1, mins = dt.getUTCHours() * 60 + dt.getUTCMinutes();
    if (days && !days.includes(String(dow))) return false;
    return spans.split(',').some((sp) => {
      const m = /^(\d{2})(\d{2})-(\d{2})(\d{2})$/.exec(sp.trim());
      if (!m) return false;
      const a = +m[1] * 60 + +m[2], b = +m[3] * 60 + +m[4];
      return a < b ? mins >= a && mins < b : a === b ? true : mins >= a || mins < b;
    });
  }

  // label / line / box / linefill objects (kept in R.objs; the newest max_*_count of each are drawn)
  function defineDrawings(R, d) {
    const keep = (kind, o) => {
      if (R.sub) return o;
      const list = R.objs[kind];
      list.push(o);
      const max = R.maxObjs[kind];
      while (list.length > max) { const x = list.shift(); x.deleted = true; }
      return o;
    };
    const live = (o, kind, fn) => { if (isNa(o)) return false; if (!o || o.__t !== kind) throw perr(`${fn}: expected a ${kind} object`, R.at, 'runtime'); return !o.deleted; };
    const del = (kind) => (o) => { if (isNa(o)) return NA; o.deleted = true; const l = R.objs[kind], k = l.indexOf(o); if (k >= 0) l.splice(k, 1); return NA; };
    const setter = (kind, fn, apply) => (o, ...a) => { if (live(o, kind, fn)) apply(o, ...a); return NA; };
    const getter = (kind, fn, get) => (o) => (isNa(o) ? NA : get(o));
    // label
    d('label.new', 'x,y,text,xloc,yloc,color,style,textcolor,size,textalign,tooltip,text_font_family,force_overlay', (x, y, text, xloc, yloc, color, style, tc, size, ta) => keep('label', {
      __t: 'label', x: num(x), y: num(y), text: isNa(text) ? '' : String(text), xloc: xloc || 'bar_index', yloc: yloc || 'price', color: color === undefined ? NAMED.blue : color, style: style || 'style_label_down', textcolor: tc === undefined ? '#FFFFFF' : tc, size: size || 'normal', textalign: ta || 'align_center', bar: R.bar,
    }));
    const L1 = (k, f) => d(`label.${k}`, k.startsWith('get') ? 'id' : 'id,v1,v2', k.startsWith('get') ? getter('label', `label.${k}`, f) : setter('label', `label.${k}`, f));
    L1('set_xy', (o, x, y) => { o.x = num(x); o.y = num(y); }); L1('set_x', (o, x) => { o.x = num(x); }); L1('set_y', (o, y) => { o.y = num(y); });
    L1('set_text', (o, t) => { o.text = isNa(t) ? '' : String(t); }); L1('set_color', (o, c) => { o.color = c; }); L1('set_textcolor', (o, c) => { o.textcolor = c; });
    L1('set_style', (o, s) => { o.style = s; }); L1('set_size', (o, s) => { o.size = s; }); L1('set_xloc', (o, x, l) => { o.x = num(x); o.xloc = l; }); L1('set_yloc', (o, l) => { o.yloc = l; });
    L1('set_textalign', (o, a) => { o.textalign = a; }); L1('set_tooltip', () => {}); L1('set_text_font_family', () => {});
    L1('get_x', (o) => o.x); L1('get_y', (o) => o.y); L1('get_text', (o) => o.text);
    d('label.delete', 'id', del('label'));
    d('label.copy', 'id', (o) => (isNa(o) ? null : keep('label', { ...o, deleted: false })));
    // line
    d('line.new', 'x1,y1,x2,y2,xloc,extend,color,style,width,force_overlay', (x1, y1, x2, y2, xloc, ext, color, style, width) => keep('line', {
      __t: 'line', x1: num(x1), y1: num(y1), x2: num(x2), y2: num(y2), xloc: xloc || 'bar_index', extend: ext || 'none', color: color === undefined ? NAMED.blue : color, style: style || 'style_solid', width: width === undefined ? 1 : num(width),
    }));
    const N1 = (k, f, p = 'id,v1,v2') => d(`line.${k}`, k.startsWith('get') ? 'id,x' : p, k.startsWith('get') ? (o, x) => (isNa(o) ? NA : f(o, x)) : setter('line', `line.${k}`, f));
    N1('set_xy1', (o, x, y) => { o.x1 = num(x); o.y1 = num(y); }); N1('set_xy2', (o, x, y) => { o.x2 = num(x); o.y2 = num(y); });
    N1('set_x1', (o, x) => { o.x1 = num(x); }); N1('set_x2', (o, x) => { o.x2 = num(x); }); N1('set_y1', (o, y) => { o.y1 = num(y); }); N1('set_y2', (o, y) => { o.y2 = num(y); });
    N1('set_color', (o, c) => { o.color = c; }); N1('set_width', (o, w) => { o.width = num(w); }); N1('set_style', (o, s) => { o.style = s; }); N1('set_extend', (o, e) => { o.extend = e; });
    N1('set_xloc', (o, a, b, l) => { o.x1 = num(a); o.x2 = num(b); o.xloc = l; }, 'id,v1,v2,v3');
    N1('get_x1', (o) => o.x1); N1('get_x2', (o) => o.x2); N1('get_y1', (o) => o.y1); N1('get_y2', (o) => o.y2);
    N1('get_price', (o, x) => (o.x2 === o.x1 ? o.y1 : o.y1 + ((o.y2 - o.y1) * (num(x) - o.x1)) / (o.x2 - o.x1)));
    d('line.delete', 'id', del('line'));
    d('line.copy', 'id', (o) => (isNa(o) ? null : keep('line', { ...o, deleted: false })));
    // box
    d('box.new', 'left,top,right,bottom,border_color,border_width,border_style,extend,xloc,bgcolor,text,text_size,text_color,text_halign,text_valign,text_wrap,text_font_family,force_overlay', (l, t, r, b, bc, bw, bs, ext, xloc, bg, text, ts, tc) => keep('box', {
      __t: 'box', left: num(l), top: num(t), right: num(r), bottom: num(b), border: bc === undefined ? NAMED.blue : bc, bw: bw === undefined ? 1 : num(bw), bstyle: bs || 'style_solid', extend: ext || 'none', xloc: xloc || 'bar_index', bg: bg === undefined ? NAMED.blue : bg, text: isNa(text) ? '' : String(text), tc: tc === undefined ? '#000000' : tc,
    }));
    const X1 = (k, f) => d(`box.${k}`, k.startsWith('get') ? 'id' : 'id,v1,v2', k.startsWith('get') ? getter('box', `box.${k}`, f) : setter('box', `box.${k}`, f));
    X1('set_lefttop', (o, l, t) => { o.left = num(l); o.top = num(t); }); X1('set_rightbottom', (o, r, b) => { o.right = num(r); o.bottom = num(b); });
    X1('set_left', (o, v) => { o.left = num(v); }); X1('set_right', (o, v) => { o.right = num(v); }); X1('set_top', (o, v) => { o.top = num(v); }); X1('set_bottom', (o, v) => { o.bottom = num(v); });
    X1('set_bgcolor', (o, c) => { o.bg = c; }); X1('set_border_color', (o, c) => { o.border = c; }); X1('set_border_width', (o, w) => { o.bw = num(w); }); X1('set_border_style', (o, s) => { o.bstyle = s; });
    X1('set_extend', (o, e) => { o.extend = e; }); X1('set_text', (o, t) => { o.text = isNa(t) ? '' : String(t); }); X1('set_text_color', (o, c) => { o.tc = c; });
    for (const k of ['set_text_size', 'set_text_halign', 'set_text_valign', 'set_text_wrap', 'set_text_font_family']) X1(k, () => {});
    X1('get_left', (o) => o.left); X1('get_right', (o) => o.right); X1('get_top', (o) => o.top); X1('get_bottom', (o) => o.bottom);
    d('box.delete', 'id', del('box'));
    d('box.copy', 'id', (o) => (isNa(o) ? null : keep('box', { ...o, deleted: false })));
    // linefill
    d('linefill.new', 'line1,line2,color', (a, b, c) => keep('linefill', { __t: 'linefill', a, b, color: c }));
    d('linefill.set_color', 'id,color', (o, c) => { if (!isNa(o)) o.color = c; return NA; });
    d('linefill.delete', 'id', del('linefill'));
    d('linefill.get_line1', 'id', (o) => (isNa(o) ? null : o.a));
    d('linefill.get_line2', 'id', (o) => (isNa(o) ? null : o.b));
    // chart.point
    const cpNum = (v) => (v === undefined ? NA : num(v));
    d('chart.point.new', 'time,index,price', (t, i, p) => chartPoint(cpNum(t), cpNum(i), cpNum(p)));
    d('chart.point.from_index', 'index,price', (i, p) => chartPoint(NA, cpNum(i), cpNum(p)));
    d('chart.point.from_time', 'time,price', (t, p) => chartPoint(cpNum(t), NA, cpNum(p)));
    d('chart.point.now', 'price', (p) => chartPoint(R.T[R.bar] * 1000, R.bar, p === undefined ? R.C[R.bar] : num(p)));
    d('chart.point.copy', 'id', (o) => { if (isNa(o)) return null; if (!(o instanceof PObj) || o.T !== CHART_POINT) throw perr('chart.point.copy: expected a chart.point', R.at, 'runtime'); return chartPoint(o.f.time, o.f.index, o.f.price); });
    // polyline: the points are copied when it is created (TradingView polylines cannot be edited afterwards)
    d('polyline.new', 'points,curved,closed,xloc,line_color,fill_color,line_style,line_width,force_overlay', (pts, curved, closed, xloc, lc, fc, ls, lw) => {
      if (!isArrV(pts)) throw perr(`polyline.new: points must be an array of chart.point${isNa(pts) ? ' (it is na)' : ''}`, R.at, 'runtime');
      if (pts.a.length > 10000) throw perr(`polyline.new: ${pts.a.length} points (a polyline has at most 10000)`, R.at, 'runtime');
      const xl = xloc === undefined || isNa(xloc) ? 'bar_index' : String(xloc);
      const points = [];
      for (const q of pts.a) {
        if (isNa(q)) continue;
        if (!(q instanceof PObj) || q.T !== CHART_POINT) throw perr('polyline.new: points must be an array of chart.point', R.at, 'runtime');
        points.push({ x: xl === 'bar_time' ? num(q.f.time) : num(q.f.index), p: num(q.f.price) });
      }
      return keep('polyline', { __t: 'polyline', points, curved: curved === true, closed: closed === true, xloc: xl, color: lc === undefined ? NAMED.blue : isNa(lc) ? null : lc, fill: fc === undefined || isNa(fc) ? null : fc, style: ls === undefined || isNa(ls) ? 'style_solid' : String(ls), width: lw === undefined ? 1 : num(lw) || 1 });
    });
    d('polyline.delete', 'id', del('polyline'));
  }

  // ── Strategy builtins (need the broker) ──
  function defineStrategy(R, B) {
    const d = (path, p, f) => { B[path] = { p: p.split(','), f, st: false }; };
    const br = () => R.broker;
    const dirOf = (v) => {
      if (v === 'long' || v === true) return 1;
      if (v === 'short' || v === false) return -1;
      throw perr(`strategy direction must be strategy.long or strategy.short (got ${tostr(v, null, R)})`, R.at, 'runtime');
    };
    const str = (v) => (isNa(v) ? '' : String(v));
    const ocaOf = (name, type) => {
      if (name === undefined || isNa(name) || name === '') return null;
      const t = type === undefined || isNa(type) ? 'none' : String(type);
      if (!['none', 'cancel', 'reduce'].includes(t)) throw perr(`oca_type must be strategy.oca.none, strategy.oca.cancel or strategy.oca.reduce (got ${tostr(type, null, R)})`, R.at, 'runtime');
      return { name: String(name), type: t };
    };
    const orderFn = (order) => (id, dir, qty, limit, stop, oca, ocat, comment, am, da, when) => {
      if (!br() || when === false) return NA;
      br().entry(str(id), dirOf(dir), num(qty), num(limit), num(stop), comment === undefined ? '' : str(comment), ocaOf(oca, ocat), order);
      return NA;
    };
    d('strategy.entry', 'id,direction,qty,limit,stop,oca_name,oca_type,comment,alert_message,disable_alert,when', orderFn(false));
    d('strategy.order', 'id,direction,qty,limit,stop,oca_name,oca_type,comment,alert_message,disable_alert,when', orderFn(true));
    d('strategy.close', 'id,comment,qty,qty_percent,alert_message,immediately,disable_alert,when', (id, comment, qty, pct, am, imm, da, when) => {
      if (!br() || when === false) return NA;
      br().close(str(id), comment === undefined ? '' : str(comment), num(qty), num(pct), !!imm, false);
      return NA;
    });
    d('strategy.close_all', 'comment,alert_message,immediately,disable_alert,when', (comment, am, imm, da, when) => {
      if (!br() || when === false) return NA;
      br().close('', comment === undefined ? '' : str(comment), NA, NA, !!imm, true);
      return NA;
    });
    d('strategy.exit', 'id,from_entry,qty,qty_percent,profit,limit,loss,stop,trail_price,trail_points,trail_offset,oca_name,comment,comment_profit,comment_loss,comment_trailing,alert_message,alert_profit,alert_loss,alert_trailing,disable_alert,when', (...a) => {
      if (!br() || a[21] === false) return NA;
      const [id, from, qty, pct, profit, limit, loss, stop, tp, tpts, toff, oca, comment, cp, cl, ct] = a;
      br().exit({ id: str(id), from: from === undefined ? '' : str(from), qty: num(qty), pct: num(pct), profit: num(profit), limit: num(limit), loss: num(loss), stop: num(stop), trailPrice: num(tp), trailPoints: num(tpts), trailOffset: num(toff), comment: comment === undefined ? '' : str(comment), commentProfit: cp === undefined ? '' : str(cp), commentLoss: cl === undefined ? '' : str(cl), commentTrail: ct === undefined ? '' : str(ct), ocaName: oca === undefined || isNa(oca) ? '' : str(oca) });
      return NA;
    });
    d('strategy.cancel', 'id,when', (id, when) => { if (br() && when !== false) br().cancel(str(id)); return NA; });
    d('strategy.cancel_all', 'when', (when) => { if (br() && when !== false) br().cancelAll(); return NA; });
    d('strategy.risk.allow_entry_in', 'value', (v) => { if (br()) br().allow = v === 'long' || v === 'short' ? v : 'both'; return NA; });
    const ct = (k, f) => d(`strategy.closedtrades.${k}`, 'trade_num', (n) => { const t = br() && br().closed[Math.floor(num(n))]; return t ? f(t) : NA; });
    ct('profit', (t) => t.pnl); ct('entry_price', (t) => t.entryPx); ct('exit_price', (t) => t.exitPx); ct('entry_bar_index', (t) => t.entryBar); ct('exit_bar_index', (t) => t.exitBar);
    ct('entry_time', (t) => t.entryTime * 1000); ct('exit_time', (t) => t.exitTime * 1000); ct('size', (t) => t.dir * t.qty); ct('entry_id', (t) => t.id); ct('exit_id', (t) => t.exitId); ct('commission', (t) => t.comm);
    const ot = (k, f) => d(`strategy.opentrades.${k}`, 'trade_num', (n) => { const t = br() && br().trades[Math.floor(num(n))]; return t ? f(t) : NA; });
    ot('entry_price', (t) => t.px); ot('entry_bar_index', (t) => t.bar); ot('entry_time', (t) => t.time * 1000); ot('size', (t) => t.dir * t.qty); ot('entry_id', (t) => t.id); ot('commission', (t) => t.comm);
    ot('profit', (t) => t.dir * (R.C[R.bar] - t.px) * t.qty - t.comm);
  }

  // ── Frames ────────────────────────────────────────────
  function newFrame(ctx) {
    const v = new Array(ctx.slots);
    for (let k = 0; k < ctx.slots; k++) v[k] = [];
    return { t: -1, v, init: new Uint8Array(ctx.slots), sites: new Array(ctx.sites) };
  }
  function enterFrame(F, ctx) {
    const t = ++F.t, vs = ctx.varSlots;
    for (let k = 0; k < vs.length; k++) { const s = vs[k]; if (F.init[s]) F.v[s][t] = F.v[s][t - 1]; }
  }
  const histVal = (v) => (v === undefined ? NA : v);
  const baseTypeOf = (t) => (!t ? null : t.endsWith('[]') ? 'array' : t);
  const blankOf = (base) => (base === 'bool' ? false : base === 'float' || base === 'int' ? NA : null);
  const flatten = (e) => (e.type === 'id' ? e.name : e.type === 'member' ? (() => { const p = flatten(e.obj); return p ? `${p}.${e.name}` : null; })() : null);
  const rootId = (e) => (e.type === 'id' ? e.name : e.type === 'member' ? rootId(e.obj) : null);

  // Constant folding for declaration arguments (literals, constants, unary minus).
  function constVal(e) {
    if (!e) return undefined;
    switch (e.type) {
      case 'num': case 'str': case 'bool': case 'color': return e.v;
      case 'neg': { const v = constVal(e.e); return typeof v === 'number' ? -v : undefined; }
      case 'member': { const p = flatten(e); return p && p in CONSTS ? CONSTS[p] : undefined; }
      case 'id': return e.name === 'na' ? NA : undefined;
      default: return undefined;
    }
  }
  const DECL_P = {
    indicator: 'title,shorttitle,overlay,format,precision,scale,max_bars_back,timeframe,timeframe_gaps,explicit_plot_zorder,max_lines_count,max_labels_count,max_boxes_count,calc_bars_count,max_polylines_count,dynamic_requests,behind_chart',
    strategy: 'title,shorttitle,overlay,format,precision,scale,pyramiding,calc_on_order_fills,calc_on_every_tick,max_bars_back,backtest_fill_limits_assumption,default_qty_type,default_qty_value,initial_capital,currency,slippage,commission_type,commission_value,process_orders_on_close,close_entries_rule,margin_long,margin_short,explicit_plot_zorder,max_lines_count,max_labels_count,max_boxes_count,calc_bars_count,risk_free_rate,use_bar_magnifier,fill_orders_on_standard_ohlc,max_polylines_count,dynamic_requests,behind_chart',
  };
  DECL_P.study = DECL_P.indicator;
  DECL_P.library = 'title,overlay,dynamic_requests';
  function findDecl(body, version) {
    for (const s of body) {
      if (s.type !== 'expr' || s.expr.type !== 'call' || s.expr.fn.type !== 'id') continue;
      const name = s.expr.fn.name;
      if (!DECL_P[name]) continue;
      if (name === 'study' && !(version <= 4)) throw perr("study() is Pine v4; use indicator() in v5 (or add //@version=4)", s.expr);
      const p = DECL_P[name].split(','), args = {};
      s.expr.args.forEach((a, k) => { const key = a.name || p[k]; if (key) args[key] = { v: constVal(a.e), node: a.e }; });
      const v = (k, def) => (args[k] && args[k].v !== undefined ? args[k].v : def);
      if (args.timeframe && v('timeframe', '') !== '') throw perr("indicator(timeframe=...) is not supported — use the indicator's 'Calculate on' setting instead", args.timeframe.node);
      return { kind: name === 'strategy' ? 'strategy' : name === 'library' ? 'library' : 'indicator', title: v('title', 'Pine script'), shorttitle: v('shorttitle', ''), overlay: !!v('overlay', false), args, v, node: s };
    }
    throw new PineError('missing declaration: the script must call indicator(), strategy(), library() or study() (v4)', 1, 1);
  }
  // Tester properties requested by strategy() (only arguments that were given).
  function declProps(decl) {
    if (!decl || decl.kind !== 'strategy') return {};
    const v = decl.v, a = decl.args, out = {};
    if (a.initial_capital) out.capital = v('initial_capital');
    if (a.default_qty_type) out.sizeType = v('default_qty_type');
    if (a.default_qty_value) out.size = v('default_qty_value');
    if (a.pyramiding) out.pyramiding = Math.max(1, v('pyramiding') | 0);
    if (a.commission_type) out.commType = v('commission_type');
    if (a.commission_value) out.commission = v('commission_value');
    if (a.slippage) out.slippageTicks = v('slippage');
    if (a.process_orders_on_close) out.fill = v('process_orders_on_close') ? 'close' : 'open';
    if (a.margin_long) out.marginLong = v('margin_long');
    if (a.margin_short) out.marginShort = v('margin_short');
    for (const k of Object.keys(out)) if (out[k] === undefined || (typeof out[k] === 'number' && !ok(out[k]))) delete out[k];
    return out;
  }

  const TF_OPTIONS = ['', '1', '3', '5', '15', '30', '45', '60', '120', '180', '240', 'D', 'W', 'M'];
  const SHAPE = { triangleup: 'arrowUp', arrowup: 'arrowUp', labelup: 'arrowUp', triangledown: 'arrowDown', arrowdown: 'arrowDown', labeldown: 'arrowDown', circle: 'circle', square: 'square', diamond: 'square', xcross: 'circle', cross: 'circle', flag: 'square' };
  const MSIZE = { tiny: 0.5, small: 0.75, normal: 1, auto: 1, large: 1.5, huge: 2 };

  // ── Compiler: AST → closures (F) => value ─────────────
  class Compiler {
    constructor(R, parsed) {
      this.R = R; this.version = parsed.version; this.v4 = parsed.version != null && parsed.version <= 4;
      this.B = makeBuiltins(R);
      defineStrategy(R, this.B);
      this.fns = new Map(); this.methods = new Map(); this.types = new Map(); this.enums = new Map(); this.nsFns = new Map(); this.libStack = []; this.libNames = new Set();
      this.mainCtx = { fn: null, slots: 0, varSlots: [], sites: 0, scope: { vars: new Map(), parent: null } };
      this.ctx = this.mainCtx; this.scope = this.mainCtx.scope; this.depth = 0; this.loop = 0;
      this.secN = 0; this.warned = new Set();
    }
    warn(key, msg, node) { if (this.warned.has(key)) return; this.warned.add(key); this.R.warnings.push(`${node && node.line ? `line ${node.line}: ` : ''}${msg}`); }
    newSlot(isVar) { const s = this.ctx.slots++; if (isVar) this.ctx.varSlots.push(s); return s; }
    newSite() { return this.ctx.sites++; }
    lookup(name) { for (let s = this.scope; s; s = s.parent) { const v = s.vars.get(name); if (v) return v; } return null; }
    declare(name, isVar, node) {
      if (this.scope.vars.has(name)) throw perr(`'${name}' is already declared in this scope (use := to reassign)`, node);
      const info = { slot: this.newSlot(isVar), ctx: this.ctx, isVar, name };
      this.scope.vars.set(name, info);
      return info;
    }
    global() { return this.ctx !== this.mainCtx || this.depth > 0; }

    program(body) {
      this.decl = findDecl(body, this.version);
      this.isStrategy = this.decl.kind === 'strategy';
      const list = body.map((s) => this.stmt(s)).filter(Boolean);
      return this.seq(list);
    }
    seq(list) {
      const R = this.R;
      if (!list.length) return () => NA;
      if (list.length === 1) return list[0];
      return (F) => { let v; for (let i = 0; i < list.length; i++) { v = list[i](F); if (R.flow) break; } return v; };
    }
    block(stmts) {
      const save = this.scope;
      this.scope = { vars: new Map(), parent: save }; this.depth++;
      try { return this.seq(stmts.map((s) => this.stmt(s)).filter(Boolean)); } finally { this.depth--; this.scope = save; }
    }
    stmt(s) {
      const R = this.R;
      switch (s.type) {
        case 'expr': return this.expr(s.expr);
        case 'decl': {
          const val = this.expr(s.value);
          const { slot } = this.declare(s.name, !!s.mode, { line: s.nline, col: s.ncol });
          if (s.mode) return (F) => { if (!F.init[slot]) { F.init[slot] = 1; return (F.v[slot][F.t] = val(F)); } return F.v[slot][F.t]; };
          return (F) => (F.v[slot][F.t] = val(F));
        }
        case 'assign': {
          const info = this.lookup(s.name);
          if (!info) throw perr(`undeclared identifier '${s.name}' (declare it with = before reassigning with ${s.op})`, s);
          if (info.ctx !== this.ctx) throw perr(`cannot modify global variable '${s.name}' inside a function`, s);
          const val = this.expr(s.value), sl = info.slot;
          switch (s.op) {
            case ':=': return (F) => (F.v[sl][F.t] = val(F));
            case '+=': return (F) => { const h = F.v[sl]; return (h[F.t] = h[F.t] + val(F)); };
            case '-=': return (F) => { const h = F.v[sl]; return (h[F.t] = h[F.t] - val(F)); };
            case '*=': return (F) => { const h = F.v[sl]; return (h[F.t] = h[F.t] * val(F)); };
            case '/=': return (F) => { const h = F.v[sl]; const q = h[F.t] / val(F); return (h[F.t] = ok(q) ? q : NA); };
            default: return (F) => { const h = F.v[sl]; return (h[F.t] = h[F.t] % val(F)); };
          }
        }
        case 'tuple': {
          const val = this.expr(s.value);
          const slots = s.names.map((nm) => this.declare(nm, false, s).slot);
          return (F) => {
            const v = val(F), it = v instanceof Tuple ? v.items : null;
            for (let k = 0; k < slots.length; k++) F.v[slots[k]][F.t] = it && k < it.length ? it[k] : NA;
            return v;
          };
        }
        case 'func': this.defineFn(s); return null;
        case 'udt': this.defineType(s); return null;
        case 'enum': this.defineEnum(s); return null;
        case 'import': this.importLib(s); return null;
        case 'fassign': return this.fieldAssign(s);
        case 'break': case 'continue': {
          if (!this.loop) throw perr(`'${s.type}' outside a loop`, s);
          const f = s.type === 'break' ? FLOW_BREAK : FLOW_CONT;
          return () => { R.flow = f; return NA; };
        }
        default: throw perr(`unsupported statement '${s.type}'`, s);
      }
    }
    defineFn(s) {
      const def = { name: s.name, params: s.params, method: s.method, node: s };
      const ctx = { fn: def, slots: 0, varSlots: [], sites: 0, scope: { vars: new Map(), parent: this.mainCtx.scope } };
      def.defaults = s.params.map((p) => (p.def ? this.expr(p.def) : null));
      const save = [this.ctx, this.scope, this.depth, this.loop];
      this.ctx = ctx; this.scope = ctx.scope; this.depth = 0; this.loop = 0;
      try {
        def.pslots = s.params.map((p) => this.declare(p.name, false, p).slot);
        def.body = this.block(s.body);
      } finally { [this.ctx, this.scope, this.depth, this.loop] = save; }
      def.ctx = ctx;
      if (s.method) {
        if (!s.params.length) throw perr(`method ${s.name}() needs at least one parameter (the object it is called on)`, s);
        def.selfType = this.typeTest(s.params[0].ptype);
      }
      const map = s.method ? this.methods : this.fns;
      if (!map.has(s.name)) map.set(s.name, []);
      map.get(s.name).push(def);
    }

    // ── user-defined types ──
    defineType(s) {
      if (this.types.has(s.name)) throw perr(`type '${s.name}' is already declared`, s);
      if (NAMESPACES.has(s.name) || TYPES.has(s.name)) throw perr(`'${s.name}' is a built-in name and cannot be used as a type name`, s);
      const T = { name: s.name, exported: !!s.exported, node: s, fields: [] };
      this.types.set(s.name, T);
      T.fields = s.fields.map((f) => ({ name: f.name, base: baseTypeOf(f.ftype), def: f.def ? this.expr(f.def) : null }));
    }
    defineEnum(s) {
      if (this.types.has(s.name) || this.enums.has(s.name)) throw perr(`'${s.name}' is already declared`, s);
      if (NAMESPACES.has(s.name) || TYPES.has(s.name)) throw perr(`'${s.name}' is a built-in name and cannot be used as an enum name`, s);
      const E = { name: s.name, exported: !!s.exported, fields: new Map() };
      for (const f of s.fields) E.fields.set(f.name, new PEnum(E, f.name, f.title));
      this.enums.set(s.name, E);
    }
    typeTest(pt) {
      if (!pt) return () => true;
      const base = baseTypeOf(pt);
      switch (base) {
        case 'array': return isArrV;
        case 'map': return (o) => o instanceof PMap;
        case 'matrix': return (o) => o instanceof PMatrix;
        case 'float': case 'int': return (o) => typeof o === 'number';
        case 'bool': return (o) => typeof o === 'boolean';
        case 'string': case 'color': return (o) => typeof o === 'string';
        case 'line': case 'label': case 'box': case 'table': case 'linefill': case 'polyline': return (o) => !!o && o.__t === base;
        case 'chart.point': return (o) => o instanceof PObj && o.T === CHART_POINT;
        default: {
          const T = this.types.get(base);
          if (T) return (o) => o instanceof PObj && o.T === T;
          const E = this.enums.get(base);
          return E ? (o) => o instanceof PEnum && o.E === E : () => true;
        }
      }
    }
    udtNew(T, e) {
      const n = T.fields.length, given = new Array(n).fill(null);
      let k = 0;
      for (const a of e.args) {
        if (a.name) {
          const j = T.fields.findIndex((f) => f.name === a.name);
          if (j < 0) throw perr(`type ${T.name} has no field '${a.name}'`, a);
          given[j] = this.expr(a.e);
        } else { if (k >= n) throw perr(`too many arguments for ${T.name}.new() (it has ${n} field(s))`, a); given[k++] = this.expr(a.e); }
      }
      return (F) => {
        const f = Object.create(null);
        for (let j = 0; j < n; j++) { const fd = T.fields[j]; f[fd.name] = given[j] ? given[j](F) : fd.def ? fd.def(F) : blankOf(fd.base); }
        return new PObj(T, f);
      };
    }
    fieldGet(e) {
      const R = this.R, obj = this.expr(e.obj), name = e.name;
      return (F) => {
        const o = obj(F);
        if (o instanceof PObj) { if (name in o.f) return o.f[name]; R.at = e; throw perr(`type ${o.T.name} has no field '${name}'`, e, 'runtime'); }
        R.at = e;
        throw perr(isNa(o) ? `cannot read field '${name}' of an na object (create it with <Type>.new())` : `'.${name}': only objects of user-defined types have fields`, e, 'runtime');
      };
    }
    fieldAssign(s) {
      const R = this.R, obj = this.expr(s.target.obj), name = s.target.name, val = this.expr(s.value), op = s.op;
      return (F) => {
        const o = obj(F);
        if (!(o instanceof PObj)) { R.at = s; throw perr(isNa(o) ? `cannot assign field '${name}' of an na object (create it with <Type>.new())` : `'.${name}': only objects of user-defined types have fields`, s, 'runtime'); }
        if (!(name in o.f)) { R.at = s; throw perr(`type ${o.T.name} has no field '${name}'`, s, 'runtime'); }
        const v = val(F), c = o.f[name];
        let r;
        switch (op) {
          case ':=': r = v; break;
          case '+=': r = c + v; break;
          case '-=': r = c - v; break;
          case '*=': r = c * v; break;
          case '/=': { const q = c / v; r = ok(q) ? q : NA; break; }
          default: r = c % v;
        }
        o.f[name] = r;
        return r;
      };
    }
    // import user/Name/1 as N: a script saved in the app that declares library("Name"). Its functions and types are compiled
    // into this program; exported ones are reachable as N.fn() / N.Type, exported methods by name on matching objects.
    importLib(s) {
      const libs = this.R.opts.libs || {}, keys = Object.keys(libs);
      const key = keys.find((k) => k === s.name) || keys.find((k) => k.toLowerCase() === s.name.toLowerCase());
      if (key === undefined) throw perr(`import ${s.path}: no saved library named "${s.name}" — TradingView's library server is not available here; save a script that declares library("${s.name}") in the Script Editor`, s);
      if (this.libStack.includes(key)) throw perr(`import ${s.path}: circular library import (${[...this.libStack, key].join(' → ')})`, s);
      if (this.libStack.length >= 4) throw perr('libraries nested more than 4 levels deep are not supported', s);
      if (this.libNames.has(s.alias) || this.types.has(s.alias)) throw perr(`'${s.alias}' is already used by another import or type; choose a different alias with 'as'`, s);
      if (s.version !== null) this.warn(`libver:${s.path}`, `import ${s.path}: library versions are not tracked locally — using the saved "${key}" library`, s);
      let parsed;
      try { parsed = parse(libs[key]); } catch (e) { if (e instanceof PineError) throw perr(`library "${key}" has a syntax error${e.line ? ` at its line ${e.line}` : ''}: ${e.message}`, s); throw e; }
      if (!parsed.body.some((st) => st.type === 'expr' && st.expr.type === 'call' && st.expr.fn.type === 'id' && st.expr.fn.name === 'library')) throw perr(`import ${s.path}: the saved script "${key}" is not a library (it must call library("${key}"))`, s);
      const save = [this.fns, this.types, this.enums, this.nsFns, this.libNames];
      this.fns = new Map(); this.types = new Map(); this.enums = new Map(); this.nsFns = new Map(); this.libNames = new Set();
      this.libStack.push(key);
      let libFns, libTypes, libEnums;
      try {
        for (const st of parsed.body) {
          if (st.type !== 'func' && st.type !== 'udt' && st.type !== 'enum' && st.type !== 'import') continue;
          try { this.stmt(st); } catch (e) {
            if (e instanceof PineError && !e.inLib) { e.message = `in library "${key}"${e.line ? ` (its line ${e.line})` : ''}: ${e.message}`; e.inLib = true; e.line = s.line; e.col = s.col; }
            throw e;
          }
        }
        libFns = this.fns; libTypes = this.types; libEnums = this.enums;
      } finally { [this.fns, this.types, this.enums, this.nsFns, this.libNames] = save; this.libStack.pop(); }
      this.libNames.add(s.alias);
      let n = 0;
      for (const [nm, defs] of libFns) { const ex = defs.filter((d) => d.node.exported); if (ex.length) { this.nsFns.set(`${s.alias}.${nm}`, ex); n++; } }
      for (const [nm, T] of libTypes) if (T.exported) { this.types.set(`${s.alias}.${nm}`, T); n++; }
      for (const [nm, E] of libEnums) if (E.exported) { this.enums.set(`${s.alias}.${nm}`, E); n++; }
      if (!n && ![...this.methods.values()].some((l) => l.some((d) => d.node.exported))) this.warn(`libempty:${key}`, `library "${key}" exports nothing (mark functions, methods or types with 'export')`, s);
    }

    // ── expressions ──
    expr(e) {
      const R = this.R;
      switch (e.type) {
        case 'num': case 'str': case 'bool': case 'color': { const v = e.v; return () => v; }
        case 'id': return this.ident(e);
        case 'member': return this.memberValue(e);
        case 'hist': return this.history(e);
        case 'call': return this.call(e);
        case 'bin': return this.binary(e);
        case 'neg': { const a = this.expr(e.e); return (F) => -a(F); }
        case 'not': { const a = this.expr(e.e); return (F) => !a(F); }
        case 'and': { const l = this.expr(e.l), r = this.expr(e.r); return (F) => !!l(F) && !!r(F); }
        case 'or': { const l = this.expr(e.l), r = this.expr(e.r); return (F) => !!l(F) || !!r(F); }
        case 'tern': { const c = this.expr(e.c), a = this.expr(e.a), b = this.expr(e.b); return (F) => (c(F) ? a(F) : b(F)); }
        case 'tuple': { const it = e.items.map((x) => this.expr(x)); return (F) => new Tuple(it.map((f) => f(F))); }
        case 'if': {
          const c = this.expr(e.cond), a = this.block(e.then), b = e.els ? this.block(e.els) : null;
          return b ? (F) => (c(F) ? a(F) : b(F)) : (F) => (c(F) ? a(F) : NA);
        }
        case 'for': return this.forLoop(e);
        case 'forin': return this.forIn(e);
        case 'while': {
          const c = this.expr(e.cond);
          this.loop++;
          const body = this.block(e.body);
          this.loop--;
          return (F) => {
            let v = NA, g = 0;
            while (c(F)) {
              v = body(F);
              if (R.flow) { const f = R.flow; R.flow = 0; if (f === FLOW_BREAK) break; }
              if ((++g & 1023) === 0) R.check(e);
            }
            return v;
          };
        }
        case 'switch': {
          const subj = e.subject ? this.expr(e.subject) : null;
          const cases = e.cases.map((c) => ({ w: this.expr(c.when), b: this.block(c.body) }));
          const def = e.def ? this.block(e.def) : null;
          if (subj) return (F) => { const s = subj(F); for (let k = 0; k < cases.length; k++) if (cases[k].w(F) === s) return cases[k].b(F); return def ? def(F) : NA; };
          return (F) => { for (let k = 0; k < cases.length; k++) if (cases[k].w(F)) return cases[k].b(F); return def ? def(F) : NA; };
        }
        default: throw perr(`unsupported expression '${e.type}'`, e);
      }
    }
    forLoop(e) {
      const R = this.R, from = this.expr(e.from), to = this.expr(e.to), step = e.step ? this.expr(e.step) : null;
      const save = this.scope;
      this.scope = { vars: new Map(), parent: save };
      const s = this.declare(e.name, false, e).slot;
      this.loop++;
      const body = this.block(e.body);
      this.loop--; this.scope = save;
      return (F) => {
        const a = num(from(F)), b = num(to(F));
        if (!ok(a) || !ok(b)) return NA;
        let st = step ? Math.abs(num(step(F))) : 1;
        if (!(st > 0)) throw perr('for loop step must be a positive number', e, 'runtime');
        if (a > b) st = -st;
        let v = NA, g = 0;
        const h = F.v[s];
        for (let i = a; st > 0 ? i <= b : i >= b; i += st) {
          h[F.t] = i;
          v = body(F);
          if (R.flow) { const f = R.flow; R.flow = 0; if (f === FLOW_BREAK) break; }
          if ((++g & 1023) === 0) R.check(e);
        }
        return v;
      };
    }
    forIn(e) {
      const R = this.R, arr = this.expr(e.arr);
      const save = this.scope;
      this.scope = { vars: new Map(), parent: save };
      const si = e.idx ? this.declare(e.idx, false, e).slot : -1, sv = this.declare(e.name, false, e).slot;
      this.loop++;
      const body = this.block(e.body);
      this.loop--; this.scope = save;
      return (F) => {
        let x = arr(F), keys = null;
        if (x instanceof PMap) { keys = [...x.m.keys()]; x = { a: [...x.m.values()] }; }
        else if (x instanceof PMatrix) x = { a: x.d.map((row) => new PArray(row.slice())) };
        else if (!isArrV(x)) throw perr('for ... in needs an array, a map or a matrix', e, 'runtime');
        const a = x.a, n = a.length;
        let v = NA;
        for (let k = 0; k < n && k < a.length; k++) {
          if (si >= 0) F.v[si][F.t] = keys ? keys[k] : k;
          F.v[sv][F.t] = a[k];
          v = body(F);
          if (R.flow) { const f = R.flow; R.flow = 0; if (f === FLOW_BREAK) break; }
          if ((k & 1023) === 1023) R.check(e);
        }
        return v;
      };
    }
    binary(e) {
      const l = this.expr(e.l), r = this.expr(e.r);
      switch (e.op) {
        case '+': return (F) => l(F) + r(F);
        case '-': return (F) => l(F) - r(F);
        case '*': return (F) => l(F) * r(F);
        case '/': return (F) => { const q = l(F) / r(F); return q === Infinity || q === -Infinity ? NA : q; };
        case '%': return (F) => l(F) % r(F);
        case '<': return (F) => l(F) < r(F);
        case '>': return (F) => l(F) > r(F);
        case '<=': return (F) => l(F) <= r(F);
        case '>=': return (F) => l(F) >= r(F);
        case '==': return (F) => { const a = l(F), b = r(F); return a === b && a === a; };
        case '!=': return (F) => { const a = l(F), b = r(F); return a !== b && a === a && b === b; };
        default: throw perr(`unsupported operator ${e.op}`, e);
      }
    }
    readVar(info) {
      const s = info.slot, R = this.R;
      if (info.ctx === this.ctx) return (F) => F.v[s][F.t];
      return () => { const M = R.main; return M.v[s][M.t]; };
    }
    ident(e) {
      const name = e.name;
      if (name === 'na') return () => NA;
      const info = this.lookup(name);
      if (info) return this.readVar(info);
      const bv = this.builtinVar(name, e);
      if (bv) return bv;
      if (this.fns.has(name) || this.B[name]) throw perr(`'${name}' is a function — call it with ()`, e);
      throw perr(`undeclared identifier '${name}'`, e);
    }
    memberValue(e) {
      const root = rootId(e), path = flatten(e);
      if (!path || (root && this.lookup(root))) return this.fieldGet(e);
      if (this.types.has(path)) throw perr(`'${path}' is a type — create objects with ${path}.new()`, e);
      const ep = flatten(e.obj);
      if (ep && this.enums.has(ep)) {
        const v = this.enums.get(ep).fields.get(e.name);
        if (!v) throw perr(`enum ${ep} has no field '${e.name}'`, e);
        return () => v;
      }
      if (this.enums.has(path)) throw perr(`'${path}' is an enum — use one of its fields (${path}.<field>)`, e);
      if (path in CONSTS) { const v = CONSTS[path]; return () => v; }
      const bv = this.builtinVar(path, e);
      if (bv) return bv;
      if (UNSUPPORTED_NS[root]) throw perr(`${UNSUPPORTED_NS[root]} is not supported`, e);
      if (this.B[path]) throw perr(`'${path}' is a function — call it with ()`, e);
      throw perr(`unknown or unsupported '${path}'`, e);
    }
    builtinVar(name, node) {
      const R = this.R, b = () => R.bar;
      const t = () => R.T[R.bar] * 1000;
      const dt = () => new Date(R.T[R.bar] * 1000);
      if (name.startsWith('strategy.') && !this.isStrategy && /^strategy\.(position|open|closed|win|loss|even|net|gross|equity|initial|max_)/.test(name)) throw perr(`'${name}' needs a strategy() script`, node);
      const BR = (f, d = 0) => () => (R.broker ? f(R.broker) : d);
      switch (name) {
        case 'open': return () => R.O[b()];
        case 'high': return () => R.H[b()];
        case 'low': return () => R.Lo[b()];
        case 'close': return () => R.C[b()];
        case 'volume': return () => R.V[b()];
        case 'hl2': return () => (R.H[b()] + R.Lo[b()]) / 2;
        case 'hlc3': return () => (R.H[b()] + R.Lo[b()] + R.C[b()]) / 3;
        case 'ohlc4': return () => (R.O[b()] + R.H[b()] + R.Lo[b()] + R.C[b()]) / 4;
        case 'hlcc4': return () => (R.H[b()] + R.Lo[b()] + 2 * R.C[b()]) / 4;
        case 'time': return t;
        case 'time_close': return () => (R.T[R.bar] + R.tfSec) * 1000;
        case 'time_tradingday': return () => Math.floor(R.T[R.bar] / 86400) * 86400000;
        case 'timenow': return () => Date.now();
        case 'bar_index': return b;
        case 'last_bar_index': return () => R.n - 1;
        case 'last_bar_time': return () => R.T[R.n - 1] * 1000;
        case 'year': return () => dt().getUTCFullYear();
        case 'month': return () => dt().getUTCMonth() + 1;
        case 'dayofmonth': return () => dt().getUTCDate();
        case 'dayofweek': return () => dt().getUTCDay() + 1;
        case 'hour': return () => dt().getUTCHours();
        case 'minute': return () => dt().getUTCMinutes();
        case 'second': return () => dt().getUTCSeconds();
        case 'weekofyear': return () => isoWeek(t());
        case 'syminfo.tickerid': return () => R.tickerid;
        case 'syminfo.ticker': case 'syminfo.root': return () => R.ticker;
        case 'syminfo.prefix': return () => 'IG';
        case 'syminfo.description': return () => R.description;
        case 'syminfo.currency': case 'syminfo.basecurrency': return () => 'USD';
        case 'syminfo.type': return () => 'cfd';
        case 'syminfo.mintick': return () => R.mintick;
        case 'syminfo.pointvalue': return () => 1;
        case 'syminfo.minmove': return () => 1;
        case 'syminfo.pricescale': return () => Math.round(1 / R.mintick);
        case 'syminfo.session': return () => 'regular';
        case 'syminfo.timezone': return () => 'Etc/UTC';
        case 'syminfo.volumetype': return () => 'tick';
        case 'timeframe.period': case 'timeframe.main_period': return () => R.tfStr;
        case 'timeframe.multiplier': return () => { const s = R.tfSec; return s % 2592000 === 0 ? s / 2592000 : s % 604800 === 0 ? s / 604800 : s % 86400 === 0 ? s / 86400 : s % 60 === 0 ? s / 60 : s; };
        case 'timeframe.isintraday': return () => R.tfSec < 86400;
        case 'timeframe.isdaily': return () => R.tfSec >= 86400 && R.tfSec < 604800;
        case 'timeframe.isweekly': return () => R.tfSec >= 604800 && R.tfSec < 2592000;
        case 'timeframe.ismonthly': return () => R.tfSec >= 2592000;
        case 'timeframe.isdwm': return () => R.tfSec >= 86400;
        case 'timeframe.isminutes': return () => R.tfSec < 86400 && R.tfSec % 60 === 0;
        case 'timeframe.isseconds': return () => R.tfSec < 60;
        case 'timeframe.isticks': return () => false;
        case 'barstate.isfirst': return () => R.bar === 0;
        case 'barstate.islast': return () => R.bar === R.n - 1;
        case 'barstate.ishistory': return () => true;
        case 'barstate.isrealtime': return () => false;
        case 'barstate.isnew': case 'barstate.isconfirmed': return () => true;
        case 'barstate.islastconfirmedhistory': return () => R.bar === R.n - 1;
        case 'ta.tr': return () => trAt(R, R.bar, false);
        case 'ta.obv': return this.lazySeries('obv', (n) => { const o = new Float64Array(n); let s = 0; for (let i = 0; i < n; i++) { if (i) s += R.C[i] > R.C[i - 1] ? R.V[i] : R.C[i] < R.C[i - 1] ? -R.V[i] : 0; o[i] = s; } return o; });
        case 'ta.accdist': return this.lazySeries('ad', (n) => { const o = new Float64Array(n); let s = 0; for (let i = 0; i < n; i++) { const h = R.H[i], l = R.Lo[i]; s += h - l ? (((R.C[i] - l) - (h - R.C[i])) / (h - l)) * R.V[i] : 0; o[i] = s; } return o; });
        case 'ta.vwap': return this.lazySeries('vwap', (n) => { const o = new Float64Array(n); let pv = 0, vv = 0; for (let i = 0; i < n; i++) { if (!i || Math.floor(R.T[i] / 86400) !== Math.floor(R.T[i - 1] / 86400)) { pv = 0; vv = 0; } const s = (R.H[i] + R.Lo[i] + R.C[i]) / 3; pv += s * R.V[i]; vv += R.V[i]; o[i] = vv ? pv / vv : NA; } return o; });
        case 'strategy.position_size': return BR((x) => x.size_());
        case 'strategy.position_avg_price': return BR((x) => x.avg(), NA);
        case 'strategy.position_entry_name': return BR((x) => (x.trades.length ? x.trades[x.trades.length - 1].id : ''), '');
        case 'strategy.opentrades': return BR((x) => x.trades.length);
        case 'strategy.closedtrades': return BR((x) => x.closed.length);
        case 'strategy.wintrades': return BR((x) => x.wins);
        case 'strategy.losstrades': return BR((x) => x.losses);
        case 'strategy.eventrades': return BR((x) => x.evens);
        case 'strategy.netprofit': return BR((x) => x.realized);
        case 'strategy.grossprofit': return BR((x) => x.gp);
        case 'strategy.grossloss': return BR((x) => x.gl);
        case 'strategy.openprofit': return BR((x) => x.openProfit(R.C[R.bar]) - x.openComm);
        case 'strategy.equity': return BR((x) => x.equityAt(R.C[R.bar]));
        case 'strategy.initial_capital': return BR((x) => x.cap);
        case 'strategy.max_drawdown': return BR((x) => x.maxDD);
        case 'strategy.account_currency': return () => 'USD';
        case 'polyline.all': return () => new PArray(R.objs.polyline.slice(), 'polyline');
        default: return null;
      }
    }
    lazySeries(key, build) {
      const R = this.R;
      return () => { let a = R.lazy[key]; if (!a) a = R.lazy[key] = build(R.n); return a[R.bar]; };
    }
    history(e) {
      const R = this.R, k = this.expr(e.idx);
      const idx = (F) => { const x = Math.floor(num(k(F))); if (!(x >= 0)) throw perr(`history reference [${num(k(F))}] must be a non-negative integer`, e, 'runtime'); return x; };
      const inner = e.e;
      if (inner.type === 'id') {
        const info = this.lookup(inner.name);
        if (info) {
          const s = info.slot;
          if (info.ctx === this.ctx) return (F) => { const j = F.t - idx(F); return j >= 0 ? histVal(F.v[s][j]) : NA; };
          return (F) => { const M = R.main, j = M.t - idx(F); return j >= 0 ? histVal(M.v[s][j]) : NA; };
        }
        const arrs = { open: 'O', high: 'H', low: 'Lo', close: 'C', volume: 'V' };
        if (arrs[inner.name]) { const key = arrs[inner.name]; return (F) => { const j = R.bar - idx(F); return j >= 0 ? R[key][j] : NA; }; }
        if (inner.name === 'time') return (F) => { const j = R.bar - idx(F); return j >= 0 ? R.T[j] * 1000 : NA; };
        if (inner.name === 'bar_index') return (F) => { const j = R.bar - idx(F); return j >= 0 ? j : NA; };
      }
      // any other expression: evaluate it here every time and keep its history in a hidden slot
      const v = this.expr(inner), s = this.newSlot(false);
      return (F) => { const x = v(F), h = F.v[s]; h[F.t] = x; const j = F.t - idx(F); return j >= 0 ? histVal(h[j]) : NA; };
    }

    // ── calls ──
    call(e) {
      const fn = e.fn;
      if (fn.type === 'id') {
        const name = fn.name;
        if (this.fns.has(name)) return this.userCall(this.pick(this.fns.get(name), e, 0), e, null);
        if (this.lookup(name)) throw perr(`'${name}' is a variable, not a function`, fn);
        if (this.methods.has(name) && !this.B[name] && !this.isSpecial(name)) return this.userCall(this.pick(this.methods.get(name), e, 0), e, null);
        let path = name;
        if (!this.B[path] && !this.isSpecial(path) && V4_ALIAS[name]) path = V4_ALIAS[name];
        if (!this.v4 && path !== name && !['study'].includes(name)) this.warn(`v4:${name}`, `'${name}()' is a Pine v4 name; using '${path}()'`, fn);
        return this.builtinCall(path, e);
      }
      if (fn.type === 'member') {
        const root = rootId(fn), objPath = flatten(fn.obj), path = flatten(fn);
        if (objPath && !this.lookup(root) && this.types.has(objPath)) {
          const T = this.types.get(objPath);
          if (fn.name === 'new') return this.udtNew(T, e);
          if (fn.name === 'copy') {
            if (e.args.length !== 1) throw perr(`${objPath}.copy() takes 1 argument`, e);
            const a = this.expr(e.args[0].e), R = this.R;
            return (F) => { const o = a(F); if (isNa(o)) return null; if (!(o instanceof PObj)) { R.at = e; throw perr(`${objPath}.copy(): expected a ${objPath} object`, e, 'runtime'); } return new PObj(o.T, Object.assign(Object.create(null), o.f)); };
          }
          throw perr(`'${objPath}.${fn.name}()': user-defined types only provide new() and copy()`, e);
        }
        if (path && !this.lookup(root) && this.nsFns.has(path)) return this.userCall(this.pick(this.nsFns.get(path), e, 0), e, null);
        if (path && !this.lookup(root) && this.libNames.has(root)) throw perr(`library '${root}' has no exported function or type '${path.slice(root.length + 1)}'`, e);
        if (root && !this.lookup(root) && NAMESPACES.has(root) && !this.fns.has(root)) return this.builtinCall(flatten(fn), e);
        return this.methodCall(fn.obj, fn.name, e);
      }
      throw perr('this expression cannot be called', e);
    }
    pick(defs, e, extra) {
      const n = e.args.length + extra;
      const fit = defs.filter((d) => n <= d.params.length && n >= d.params.filter((p) => !p.def).length);
      if (!fit.length) { const d = defs[defs.length - 1]; throw perr(`${d.name}() takes ${d.params.length} argument(s), got ${n}`, e); }
      return fit[fit.length - 1];
    }
    userCall(def, e, selfNode) {
      const R = this.R, ps = def.params, given = new Array(ps.length).fill(null);
      let k = 0;
      if (selfNode) given[k++] = typeof selfNode === 'function' ? selfNode : this.expr(selfNode);
      for (const a of e.args) {
        if (a.name) {
          const j = ps.findIndex((p) => p.name === a.name);
          if (j < 0) throw perr(`${def.name}() has no parameter '${a.name}'`, a);
          given[j] = this.expr(a.e);
        } else { if (k >= ps.length) throw perr(`too many arguments for ${def.name}()`, a); given[k++] = this.expr(a.e); }
      }
      const argC = ps.map((p, j) => { if (given[j]) return given[j]; if (def.defaults[j]) return def.defaults[j]; throw perr(`missing argument '${p.name}' for ${def.name}()`, e); });
      const site = this.newSite(), pslots = def.pslots, n = argC.length, vals = new Array(n);
      return (F) => {
        let inst = F.sites[site];
        if (!inst) inst = F.sites[site] = newFrame(def.ctx);
        for (let j = 0; j < n; j++) vals[j] = argC[j](F);
        enterFrame(inst, def.ctx);
        for (let j = 0; j < n; j++) inst.v[pslots[j]][inst.t] = vals[j];
        return def.body(inst);
      };
    }
    // obj.name(...): user methods whose first parameter type matches the object (checked at run time, in declaration order),
    // then the built-in namespace of the value (array / map / matrix / line / label / box / linefill / table / str).
    methodCall(objNode, name, e) {
      const R = this.R, B = this.B, n = e.args.length + 1;
      const all = this.methods.get(name) || [];
      const defs = all.filter((d) => n <= d.params.length && n >= d.params.filter((p) => !p.def).length);
      const nss = ['array', 'label', 'line', 'box', 'linefill', 'polyline', 'str', 'table', 'map', 'matrix'].filter((ns) => B[`${ns}.${name}`]);
      const isCopy = name === 'copy' && !e.args.length;
      if (!defs.length && !nss.length && !isCopy) {
        if (all.length) throw perr(`method ${name}() takes ${all[0].params.length - 1} argument(s), got ${e.args.length}`, e);
        throw perr(`unknown method '.${name}()'`, e);
      }
      const obj = this.expr(objNode);
      let cur;
      const selfC = () => cur;
      const users = defs.map((d) => ({ test: d.selfType, call: this.userCall(d, e, selfC) }));
      const args = nss.length ? e.args.map((a) => ({ name: a.name, f: this.expr(a.e) })) : [];
      return (F) => {
        const o = obj(F);
        for (let k = 0; k < users.length; k++) if (users[k].test(o)) { cur = o; return users[k].call(F); }
        if (isCopy && o instanceof PObj) return new PObj(o.T, Object.assign(Object.create(null), o.f));
        const ns = valueNs(o);
        const spec = ns && B[`${ns}.${name}`];
        if (!spec) { R.at = e; throw perr(`method '.${name}()' is not available on ${isNa(o) ? 'na' : ns === 'udt' ? `type ${o.T.name}` : ns || typeof o}`, e, 'runtime'); }
        const vals = [o];
        for (const a of args) {
          if (a.name && Array.isArray(spec.p)) { const j = spec.p.indexOf(a.name); vals[j < 0 ? vals.length : j] = a.f(F); } else vals.push(a.f(F));
        }
        R.at = e;
        return spec.f(...vals);
      };
    }
    bindArgs(p, e, path) {
      if (p === '...') {
        for (const a of e.args) if (a.name) throw perr(`${path}() does not take named arguments`, a);
        return e.args.map((a) => this.expr(a.e));
      }
      const out = [];
      let k = 0;
      for (const a of e.args) {
        let j;
        if (a.name) { j = p.indexOf(a.name); if (j < 0) throw perr(`${path}() has no parameter '${a.name}'`, a); }
        else { j = k++; if (j >= p.length) throw perr(`too many arguments for ${path}()`, a); }
        out[j] = this.expr(a.e);
      }
      for (let j = 0; j < out.length; j++) if (!out[j]) out[j] = () => undefined;
      return out;
    }
    argNodes(p, e, path, alias = {}) {
      const pl = p.split(','), out = {};
      let k = 0;
      for (const a of e.args) {
        let key;
        if (a.name) { key = alias[a.name] || a.name; if (!pl.includes(key)) throw perr(`${path}() has no parameter '${a.name}'`, a); }
        else { if (k >= pl.length) throw perr(`too many arguments for ${path}()`, a); key = pl[k++]; }
        out[key] = a.e;
      }
      return out;
    }
    isSpecial(path) { return /^(indicator|study|strategy|library|input(\..+)?|plot|plotshape|plotchar|plotarrow|plotcandle|plotbar|hline|fill|bgcolor|barcolor|alertcondition|alert|request\..+|array\.new)$/.test(path); }
    builtinCall(path, e) {
      if (this.isSpecial(path)) return this.special(path, e);
      const root = path.split('.')[0];
      if (UNSUPPORTED_NS[root]) throw perr(`${UNSUPPORTED_NS[root]} is not supported`, e);
      const nt = root === 'ticker' && NON_TIME_TICKERS[path.slice(7)];
      if (nt) throw perr(`${path}() is not supported: ${nt} bars are not time-based, so request.security() cannot align them with the chart bars (ticker.heikinashi() is the supported chart type)`, e);
      if (path.startsWith('strategy.') && !this.isStrategy) throw perr(`${path}() needs a strategy() script`, e);
      if (path.startsWith('strategy.risk.') && path !== 'strategy.risk.allow_entry_in') throw perr(`${path}() is not supported — use the tester's risk properties`, e);
      const spec = this.B[path];
      if (!spec && root === 'matrix') throw perr(`${path}() is not supported (supported matrix functions: ${MATRIX_FNS})`, e);
      if (!spec) throw perr(`unsupported function '${path}()'`, e);
      return this.mkCall(spec, this.bindArgs(spec.p, e, path), e);
    }
    mkCall(spec, a, e) {
      const R = this.R, f = spec.f, n = a.length;
      if (spec.st) {
        const site = this.newSite();
        const S = (F) => F.sites[site] || (F.sites[site] = {});
        switch (n) {
          case 0: return (F) => { R.at = e; return f(S(F)); };
          case 1: return (F) => { const x = a[0](F); R.at = e; return f(S(F), x); };
          case 2: return (F) => { const x = a[0](F), y = a[1](F); R.at = e; return f(S(F), x, y); };
          case 3: return (F) => { const x = a[0](F), y = a[1](F), z = a[2](F); R.at = e; return f(S(F), x, y, z); };
          default: return (F) => { const v = a.map((g) => g(F)); R.at = e; return f(S(F), ...v); };
        }
      }
      switch (n) {
        case 0: return () => { R.at = e; return f(); };
        case 1: return (F) => { const x = a[0](F); R.at = e; return f(x); };
        case 2: return (F) => { const x = a[0](F), y = a[1](F); R.at = e; return f(x, y); };
        case 3: return (F) => { const x = a[0](F), y = a[1](F), z = a[2](F); R.at = e; return f(x, y, z); };
        default: return (F) => { const v = a.map((g) => g(F)); R.at = e; return f(...v); };
      }
    }
    // request.* calls inside plot()/barcolor()/… arguments must still run in request.security() sub-runs (they produce the
    // captured values), while the rest of those output calls is skipped there. User function / method calls count as possible.
    mayRequest(n) {
      if (!n || typeof n !== 'object') return false;
      if (Array.isArray(n)) return n.some((x) => this.mayRequest(x));
      if (n.type === 'call') {
        const p = flatten(n.fn);
        if (!p || p.startsWith('request.') || this.fns.has(p) || this.nsFns.has(p) || (n.fn.type === 'member' && (this.methods.has(n.fn.name) || this.lookup(rootId(n.fn) || '')))) return true;
      }
      for (const k of Object.keys(n)) { const v = n[k]; if (v && typeof v === 'object' && this.mayRequest(v)) return true; }
      return false;
    }
    subOnly(nodes, fns) { const f = fns.filter((g, k) => g && this.mayRequest(nodes[k])); return f.length ? (F) => { for (const g of f) g(F); } : null; }
    opt(nodes, k, def) { return nodes[k] ? this.expr(nodes[k]) : () => def; }
    once(F, site, build) { const R = this.R; let v = R.once[site]; if (v === undefined) v = R.once[site] = build(F); return v; }

    special(path, e) {
      const R = this.R;
      if (path === 'indicator' || path === 'study' || path === 'strategy' || path === 'library') {
        if (this.global()) throw perr(`${path}() must be called in the global scope`, e);
        return () => NA;
      }
      if (path === 'array.new') {
        const et = (e.generic || 'float').replace(/[^a-z_]/gi, '');
        const spec = this.B[`array.new_${et}`] || this.B['array.new_float'];
        return this.mkCall(spec, this.bindArgs(spec.p, e, 'array.new'), e);
      }
      if (path === 'input' || path.startsWith('input.')) return this.inputCall(path, e);
      if (path === 'request.security') return this.security(e, false);
      if (path === 'request.security_lower_tf') return this.security(e, true);
      if (path === 'request.currency_rate') return this.currencyRate(e);
      if (path.startsWith('request.')) throw perr(`${path}() is not supported${REQUEST_WHY[path] ? `: ${REQUEST_WHY[path]}` : ''} (request.security(), request.security_lower_tf() and request.currency_rate() are supported)`, e);
      const local = this.global();
      if (local && path !== 'alert') throw perr(`${path}() cannot be called from a local scope (if/for/function bodies)`, e);
      switch (path) {
        case 'plot': return this.plot(e);
        case 'plotshape': case 'plotchar': case 'plotarrow': return this.plotShape(path, e);
        case 'plotcandle': case 'plotbar': return this.plotCandle(path, e);
        case 'barcolor': return this.barcolor(e);
        case 'hline': return this.hline(e);
        case 'fill': return this.fill(e);
        case 'bgcolor': return this.bgcolor(e);
        case 'alertcondition': {
          const a = this.argNodes('condition,title,message', e, path), c = this.expr(a.condition || { type: 'bool', v: false }), title = constVal(a.title);
          const rec = { title: title === undefined ? `Alert ${R.alertDefs.length + 1}` : String(title), count: 0, last: null };
          R.alertDefs.push(rec);
          return (F) => { if (c(F) && !R.sub) { rec.count++; rec.last = R.bar; } return NA; };
        }
        case 'alert': {
          const a = this.argNodes('message,freq', e, path), m = this.opt(a, 'message', '');
          return (F) => { if (!R.sub) { const msg = m(F); R.alertCalls++; if (R.alertMsgs.length < 100) R.alertMsgs.push({ i: R.bar, message: String(msg) }); } return NA; };
        }
        default: throw perr(`unsupported function '${path}()'`, e);
      }
    }
    colorArg(nodes, key, transpKey, def) {
      const c = nodes[key] ? this.expr(nodes[key]) : null, tr = transpKey && nodes[transpKey] ? this.expr(nodes[transpKey]) : null;
      if (!c && !tr) return null;
      const base = c || (() => def);
      return tr ? (F) => { const v = base(F); return isNa(v) ? null : withTransp(v, num(tr(F))); } : (F) => { const v = base(F); return isNa(v) ? null : v; };
    }
    plot(e) {
      const R = this.R;
      const a = this.argNodes('series,title,color,linewidth,style,trackprice,histbase,offset,join,editable,show_last,display,format,precision,force_overlay,transp', e, 'plot');
      if (!a.series) throw perr('plot() needs a series', e);
      const P = { kind: 'plot', idx: R.plots.length, title: constVal(a.title), values: new Array(R.n), colors: a.color || a.transp ? new Array(R.n) : null, color: NAMED.blue,
        width: constVal(a.linewidth), style: constVal(a.style) || 'style_line', offset: constVal(a.offset) || 0, display: constVal(a.display), histbase: constVal(a.histbase), node: e };
      if (a.color && constVal(a.color) !== undefined && !a.transp) { P.color = constVal(a.color); P.colors = null; }
      R.plots.push(P);
      const s = this.expr(a.series), col = P.colors ? this.colorArg(a, 'color', 'transp', NAMED.blue) : null;
      const title = a.title && P.title === undefined ? this.expr(a.title) : null;
      const ref = { kind: 'plot', idx: P.idx }, sub = this.subOnly([a.series, a.color], [s, col]);
      return (F) => {
        if (R.sub) { if (sub) sub(F); return ref; }
        const i = R.bar;
        P.values[i] = num(s(F));
        if (col) P.colors[i] = col(F);
        if (title && i === 0) P.title = String(title(F));
        return ref;
      };
    }
    plotShape(path, e) {
      const R = this.R;
      const sig = path === 'plotshape' ? 'series,title,style,location,color,offset,text,textcolor,editable,size,show_last,display,format,precision,force_overlay,transp'
        : path === 'plotchar' ? 'series,title,char,location,color,offset,text,textcolor,editable,size,show_last,display,format,precision,force_overlay,transp'
          : 'series,title,colorup,colordown,offset,minheight,maxheight,editable,show_last,display,format,precision,force_overlay,transp';
      const a = this.argNodes(sig, e, path);
      if (!a.series) throw perr(`${path}() needs a series`, e);
      const rec = { path, title: constVal(a.title), style: constVal(a.style) || (path === 'plotchar' ? 'char' : 'xcross'), ch: constVal(a.char), loc: constVal(a.location) || (path === 'plotarrow' ? null : 'abovebar'), size: constVal(a.size) || 'normal', offset: constVal(a.offset) || 0, hits: [] };
      if (constVal(a.display) === 'none') rec.hidden = true;
      R.shapes.push(rec);
      const s = this.expr(a.series);
      const col = this.colorArg(a, 'color', 'transp', NAMED.blue), up = this.colorArg(a, 'colorup', 'transp', NAMED.green), dn = this.colorArg(a, 'colordown', 'transp', NAMED.red);
      const text = a.text ? this.expr(a.text) : null, sub = this.subOnly([a.series], [s]);
      return (F) => {
        if (R.sub) { if (sub) sub(F); return NA; }
        const v = s(F);
        if (path === 'plotarrow') {
          const x = num(v);
          if (ok(x) && x !== 0) rec.hits.push({ i: R.bar, up: x > 0, color: x > 0 ? (up ? up(F) : NAMED.green) : (dn ? dn(F) : NAMED.red) });
          return NA;
        }
        if (!v || isNa(v)) return NA;
        rec.hits.push({ i: R.bar, price: num(v), color: col ? col(F) : NAMED.blue, text: text ? String(isNa(text(F)) ? '' : text(F)) : '' });
        return NA;
      };
    }
    hline(e) {
      const R = this.R, a = this.argNodes('price,title,color,linestyle,linewidth,editable,display', e, 'hline');
      const H = { kind: 'hline', idx: R.hlines.length, price: NA, title: constVal(a.title), color: constVal(a.color), style: constVal(a.linestyle) || 'style_dashed', width: constVal(a.linewidth) || 1, display: constVal(a.display) };
      if (a.color && H.color === undefined) H.colorF = this.expr(a.color);
      R.hlines.push(H);
      const p = this.expr(a.price), ref = { kind: 'hline', idx: H.idx };
      return (F) => { if (!R.sub && R.bar === 0) { H.price = num(p(F)); if (H.colorF) H.color = H.colorF(F); } return ref; };
    }
    fill(e) {
      const R = this.R;
      // fill(plot1, plot2, top_value, bottom_value, top_color, bottom_color, title, display, fillgaps, editable) is the gradient
      // overload: chosen when one of its named arguments is given, or by six or more positional arguments whose 4th is not a
      // title string and whose 6th is not a bool literal (the 6th of the plain overload is fillgaps).
      const pos = e.args.filter((x) => !x.name);
      const grad = e.args.some((x) => ['top_value', 'bottom_value', 'top_color', 'bottom_color'].includes(x.name)) || (pos.length >= 6 && pos[3].e.type !== 'str' && pos[5].e.type !== 'bool');
      if (grad) return this.gradientFill(e);
      const a = this.argNodes('a,b,color,title,editable,show_last,fillgaps,display,transp', e, 'fill', { hline1: 'a', hline2: 'b', plot1: 'a', plot2: 'b' });
      if (!a.a || !a.b) throw perr('fill() needs two plots or two hlines', e);
      const A = this.expr(a.a), B2 = this.expr(a.b);
      const rec = { a: null, b: null, colors: new Array(R.n), hidden: constVal(a.display) === 'none' };
      R.fills.push(rec);
      const col = this.colorArg(a, 'color', 'transp', withTransp(NAMED.blue, 90)) || (() => withTransp(NAMED.blue, 90)), sub = this.subOnly([a.color], [col]);
      return (F) => {
        if (R.sub) { if (sub) sub(F); return NA; }
        if (R.bar === 0) {
          const x = A(F), y = B2(F);
          if (!x || !y || !x.kind || !y.kind) throw perr('fill() arguments must be plot() or hline() results', e, 'runtime');
          rec.a = x; rec.b = y;
        }
        rec.colors[R.bar] = col(F);
        return NA;
      };
    }
    gradientFill(e) {
      const R = this.R;
      const a = this.argNodes('a,b,top_value,bottom_value,top_color,bottom_color,title,display,fillgaps,editable', e, 'fill', { hline1: 'a', hline2: 'b', plot1: 'a', plot2: 'b' });
      if (!a.a || !a.b) throw perr('fill() needs two plots or two hlines', e);
      for (const k of ['top_value', 'bottom_value', 'top_color', 'bottom_color']) if (!a[k]) throw perr(`gradient fill() needs top_value, bottom_value, top_color and bottom_color (missing ${k})`, e);
      const A = this.expr(a.a), B2 = this.expr(a.b), tv = this.expr(a.top_value), bv = this.expr(a.bottom_value);
      const tc = this.colorArg(a, 'top_color', null, null), bc = this.colorArg(a, 'bottom_color', null, null);
      const n = R.n, rec = { a: null, b: null, top: new Float64Array(n).fill(NA), bot: new Float64Array(n).fill(NA), tc: new Array(n).fill(null), bc: new Array(n).fill(null), hidden: constVal(a.display) === 'none', title: constVal(a.title) };
      R.gradFills.push(rec);
      const sub = this.subOnly([a.top_value, a.bottom_value, a.top_color, a.bottom_color], [tv, bv, tc, bc]);
      return (F) => {
        if (R.sub) { if (sub) sub(F); return NA; }
        if (R.bar === 0) {
          const x = A(F), y = B2(F);
          if (!x || !y || !x.kind || !y.kind) throw perr('fill() arguments must be plot() or hline() results', e, 'runtime');
          rec.a = x; rec.b = y;
        }
        const i = R.bar;
        rec.top[i] = num(tv(F)); rec.bot[i] = num(bv(F)); rec.tc[i] = tc(F); rec.bc[i] = bc(F);
        return NA;
      };
    }
    barcolor(e) {
      const R = this.R, a = this.argNodes('color,offset,editable,show_last,title,display', e, 'barcolor');
      if (!a.color) throw perr('barcolor() needs a color', e);
      if (constVal(a.display) === 'none') return () => NA;
      const off = constVal(a.offset) || 0, col = this.colorArg(a, 'color', null, null);
      if (!R.barColors) R.barColors = new Array(R.n).fill(null);
      const bc = R.barColors, sub = this.subOnly([a.color], [col]);
      return (F) => {
        if (R.sub) { if (sub) sub(F); return NA; }
        const c = col(F), j = R.bar + off;
        if (j >= 0 && j < R.n && c !== null && c !== undefined) bc[j] = c;
        return NA;
      };
    }
    // plotcandle(open, high, low, close, ...) / plotbar(...): an extra OHLC series drawn by pine-render.js.
    plotCandle(path, e) {
      const R = this.R, isBar = path === 'plotbar';
      const a = this.argNodes(isBar ? 'open,high,low,close,title,color,editable,show_last,display,format,precision,force_overlay' : 'open,high,low,close,title,color,wickcolor,editable,show_last,bordercolor,display,format,precision,force_overlay', e, path);
      for (const k of ['open', 'high', 'low', 'close']) if (!a[k]) throw perr(`${path}() needs open, high, low and close`, e);
      const n = R.n, rec = { kind: isBar ? 'bar' : 'candle', idx: R.candles.length, title: constVal(a.title), o: new Float64Array(n).fill(NA), h: new Float64Array(n).fill(NA), l: new Float64Array(n).fill(NA), c: new Float64Array(n).fill(NA), color: new Array(n).fill(null), wick: isBar ? null : new Array(n).fill(null), border: isBar ? null : new Array(n).fill(null), hidden: constVal(a.display) === 'none' };
      R.candles.push(rec);
      const O = this.expr(a.open), H = this.expr(a.high), Lo = this.expr(a.low), C = this.expr(a.close);
      const col = this.colorArg(a, 'color', null, NAMED.blue) || (() => NAMED.blue), wick = a.wickcolor ? this.colorArg(a, 'wickcolor', null, null) : null, border = a.bordercolor ? this.colorArg(a, 'bordercolor', null, null) : null;
      const sub = this.subOnly([a.open, a.high, a.low, a.close, a.color], [O, H, Lo, C, col]);
      return (F) => {
        if (R.sub) { if (sub) sub(F); return NA; }
        const i = R.bar, o = num(O(F)), h = num(H(F)), l = num(Lo(F)), c = num(C(F));
        if (!ok(o) || !ok(h) || !ok(l) || !ok(c)) return NA;
        rec.o[i] = o; rec.h[i] = h; rec.l[i] = l; rec.c[i] = c;
        const cc = col(F);
        rec.color[i] = cc;
        if (!isBar) { rec.wick[i] = wick ? wick(F) : cc; rec.border[i] = border ? border(F) : cc; }
        return NA;
      };
    }
    bgcolor(e) {
      const R = this.R, a = this.argNodes('color,offset,editable,show_last,title,display,transp,force_overlay', e, 'bgcolor');
      const rec = { colors: new Array(R.n), offset: constVal(a.offset) || 0 };
      R.bgs.push(rec);
      const col = this.colorArg(a, 'color', 'transp', null) || (() => null);
      const sub = this.subOnly([a.color], [col]);
      return (F) => { if (!R.sub) rec.colors[R.bar] = col(F); else if (sub) sub(F); return NA; };
    }
    inputCall(path, e) {
      const R = this.R, kind0 = path === 'input' ? 'auto' : path.slice(6);
      const SIGS = {
        auto: this.v4 ? 'defval,title,type,minval,maxval,confirm,step,options,tooltip,inline,group' : 'defval,title,tooltip,inline,group,display',
        int: 'defval,title,minval,maxval,step,tooltip,inline,group,confirm,display,options', float: 'defval,title,minval,maxval,step,tooltip,inline,group,confirm,display,options',
        bool: 'defval,title,tooltip,inline,group,confirm,display', string: 'defval,title,options,tooltip,inline,group,confirm,display', source: 'defval,title,tooltip,inline,group,display',
        timeframe: 'defval,title,options,tooltip,inline,group,confirm,display', color: 'defval,title,tooltip,inline,group,confirm,display', session: 'defval,title,options,tooltip,inline,group,confirm,display',
        time: 'defval,title,tooltip,inline,group,confirm,display', enum: 'defval,title,options,tooltip,inline,group,confirm,display', symbol: 'defval,title,tooltip,inline,group,confirm,display', price: 'defval,title,tooltip,inline,group,confirm,display', text_area: 'defval,title,tooltip,group,confirm,display',
      };
      if (!SIGS[kind0]) throw perr(`${path}() is not supported`, e);
      const a = this.argNodes(SIGS[kind0], e, path);
      if (!a.defval) throw perr(`${path}() needs a default value`, e);
      // third positional of input.int/float may be the options array in the (defval, title, options) overload
      if ((kind0 === 'int' || kind0 === 'float') && a.minval && a.minval.type === 'tuple') { a.options = a.minval; delete a.minval; }
      let kind = kind0;
      if (kind === 'auto') {
        const t = a.type && constVal(a.type);
        if (t) kind = t === 'int' ? 'int' : t === 'float' ? 'float' : t;
        else if (a.defval.type === 'id' && SOURCE_NAMES.has(a.defval.name)) kind = 'source';
        else if (a.defval.type === 'bool') kind = 'bool';
        else if (a.defval.type === 'str') kind = 'string';
        else if (a.defval.type === 'color' || (a.defval.type === 'member' && flatten(a.defval) && flatten(a.defval).startsWith('color.')) || (a.defval.type === 'call' && flatten(a.defval.fn) === 'color.new')) kind = 'color';
        else if (a.defval.type === 'num' || a.defval.type === 'neg') kind = a.defval.type === 'num' && a.defval.isInt ? 'int' : constVal(a.defval) % 1 === 0 && a.defval.type === 'neg' && a.defval.e.isInt ? 'int' : 'float';
        else kind = 'float';
      }
      let srcName = null;
      if (kind === 'source') {
        if (a.defval.type !== 'id' || !SOURCE_NAMES.has(a.defval.name)) throw perr('input.source() default must be a built-in price source (open, high, low, close, volume, hl2, hlc3, ohlc4, hlcc4)', a.defval);
        srcName = a.defval.name;
      }
      const defC = srcName ? null : this.expr(a.defval), title = this.opt(a, 'title', undefined);
      const opts = a.options ? this.expr(a.options) : null, mn = this.opt(a, 'minval', undefined), mx = this.opt(a, 'maxval', undefined), stp = this.opt(a, 'step', undefined);
      const site = R.inSites++;
      const build = (F) => {
        const t = title(F), def = srcName || defC(F);
        let key = isNa(t) || t === undefined || t === '' ? `${kind === 'source' ? 'Source' : 'Input'} ${R.inputs.length + 1}` : String(t);
        while (R.inKeys.has(key)) key += ' ';
        R.inKeys.add(key);
        const o = opts ? opts(F) : null, options = o instanceof Tuple ? o.items : null;
        if (kind === 'enum') {
          if (!(def instanceof PEnum)) throw perr('input.enum() needs an enum field as its default value (e.g. MyEnum.first)', a.defval, 'runtime');
          const list = options || [...def.E.fields.values()];
          if (list.some((x) => !(x instanceof PEnum) || x.E !== def.E)) throw perr(`input.enum(): options must be fields of enum ${def.E.name}`, a.options, 'runtime');
          if (!list.includes(def)) throw perr('input.enum(): the default value must be one of the options', a.defval, 'runtime');
          R.inputs.push({ k: key, label: key.trim(), def: def.title, type: 'select', options: list.map((x) => x.title) });
          const want = R.values[key];
          return { v: list.find((x) => x.title === want) || list.find((x) => x.name === want) || def };
        }
        const sch = { k: key, label: key.trim(), def };
        if (options) Object.assign(sch, { type: 'select', options: options.map((x) => (typeof x === 'number' ? x : String(x))) });
        else if (kind === 'int' || kind === 'float' || kind === 'price') Object.assign(sch, { type: kind === 'int' ? 'int' : 'number', min: num(mn(F)), max: num(mx(F)), step: num(stp(F)) || (kind === 'int' ? 1 : undefined) });
        else if (kind === 'bool') sch.type = 'bool';
        else if (kind === 'source') sch.type = 'source';
        else if (kind === 'timeframe') Object.assign(sch, { type: 'select', options: TF_OPTIONS.includes(String(def)) ? TF_OPTIONS : [String(def), ...TF_OPTIONS] });
        else if (kind === 'color') sch.type = /^#[0-9a-f]{6}$/i.test(String(def)) ? 'color' : 'text';
        else if (kind === 'time') Object.assign(sch, { type: 'time', def: Math.floor(num(def) / 1000) });
        else sch.type = 'text';
        for (const k of ['min', 'max', 'step']) if (!ok(sch[k])) delete sch[k];
        R.inputs.push(sch);
        let v = R.values[key];
        if (v === undefined || v === null || v === '') v = sch.def;
        else if (sch.type === 'int' || sch.type === 'number' || (sch.type === 'select' && typeof def === 'number')) v = ok(+v) ? +v : sch.def;
        else if (sch.type === 'bool') v = v === true || v === 'true' || v === 1;
        else if (sch.type === 'time') v = ok(+v) ? +v : sch.def;
        if (kind === 'int' && ok(v)) v = Math.round(v);
        if (kind === 'time') v *= 1000;
        if (kind === 'source') return { src: R.srcArr(String(v), e) };
        return { v };
      };
      return (F) => {
        let c = R.inCache[site];
        if (!c) c = R.inCache[site] = build(F);
        return c.src ? c.src[R.bar] : c.v;
      };
    }
    security(e, lower) {
      const R = this.R, path = lower ? 'request.security_lower_tf' : 'request.security';
      const a = this.argNodes(lower ? 'symbol,timeframe,expression,ignore_invalid_symbol,currency,ignore_invalid_timeframe,calc_bars_count' : 'symbol,timeframe,expression,gaps,lookahead,ignore_invalid_symbol,currency,calc_bars_count', e, path);
      if (!a.expression) throw perr(`${path}() needs symbol, timeframe and expression`, e);
      const sym = this.opt(a, 'symbol', ''), tf = this.opt(a, 'timeframe', ''), gaps = this.opt(a, 'gaps', 'gaps_off'), la = this.opt(a, 'lookahead', 'lookahead_off'), ign = this.opt(a, 'ignore_invalid_symbol', false);
      if (a.currency) throw perr(`${path}(currency=...) is not supported: the requested symbol's currency is not known here (multiply by request.currency_rate() instead)`, a.currency);
      const ex = this.expr(a.expression), id = this.secN++;
      return (F) => {
        let s = R.sec[id];
        if (!s) s = R.sec[id] = R.setupSecurity(id, sym(F), tf(F), !lower && gaps(F) === 'gaps_on', !lower && la(F) === 'lookahead_on', e, lower, !!ign(F));
        if (s.direct) { const v = ex(F); if (R.capture) (R.capture[id] || (R.capture[id] = []))[R.bar] = v; return lower ? new PArray([v]) : v; }
        return s.at(R.bar);
      };
    }
    // request.currency_rate(from, to): the daily close of the FX pair, requested like request.security(pair, "D", close)
    // (lookahead off: confirmed daily closes on history). The pair is written in market order (EURUSD, USDJPY, …) and
    // inverted when `from` is the quote currency.
    currencyRate(e) {
      const R = this.R, a = this.argNodes('from,to,ignore_invalid_currency', e, 'request.currency_rate');
      if (!a.from || !a.to) throw perr('request.currency_rate() needs from and to currencies', e);
      const from = this.expr(a.from), to = this.expr(a.to), ign = this.opt(a, 'ignore_invalid_currency', false), id = this.secN++;
      return (F) => {
        let s = R.sec[id];
        if (!s) {
          const f = String(isNa(from(F)) ? '' : from(F)).trim().toUpperCase(), t = String(isNa(to(F)) ? '' : to(F)).trim().toUpperCase(), ig = !!ign(F);
          R.at = e;
          if (!/^[A-Z]{3,5}$/.test(f) || !/^[A-Z]{3,5}$/.test(t)) {
            if (!ig) throw perr(`request.currency_rate(): invalid currency '${!/^[A-Z]{3,5}$/.test(f) ? f : t}' (use currency.* or a 3-letter code)`, e, 'runtime');
            s = { direct: false, at: () => NA };
          } else if (f === t || f === 'NONE' || t === 'NONE') s = { direct: false, at: () => 1 };
          else {
            const rk = (c) => { const k = FX_ORDER.indexOf(c); return k < 0 ? FX_ORDER.length : k; };
            const inv = rk(t) < rk(f), pair = inv ? `${t}${f}` : `${f}${t}`;
            let inner;
            try { inner = R.setupSecurity(id, pair, 'D', false, false, e, false, ig); } catch (x) {
              if (x instanceof PineError && /was not found/.test(x.message)) throw perr(`request.currency_rate(): no FX symbol ${pair} was found for ${f} → ${t} (pass ignore_invalid_currency=true to get na instead)`, e, 'runtime');
              throw x;
            }
            s = inner.direct || !inv ? inner : { direct: false, at: (i) => { const v = inner.at(i); return ok(v) && v ? 1 / v : NA; } };
          }
          R.sec[id] = s;
        }
        if (s.direct) { const v = R.C[R.bar]; if (R.capture) (R.capture[id] || (R.capture[id] = []))[R.bar] = v; return v; }
        return s.at(R.bar);
      };
    }
  }

  const FX_ORDER = ['BTC', 'ETH', 'EUR', 'GBP', 'AUD', 'NZD', 'USD', 'CAD', 'CHF', 'JPY'];
  const REQUEST_WHY = {
    'request.financial': 'no fundamental (financial statement) data source is available — only IG price history',
    'request.dividends': 'no corporate-actions (dividends) data source is available',
    'request.earnings': 'no corporate-actions (earnings) data source is available',
    'request.splits': 'no corporate-actions (splits) data source is available',
    'request.economic': 'no economic-indicator data source is available',
    'request.quandl': 'Nasdaq Data Link (Quandl) data is not available',
    'request.seed': 'TradingView Pine Seeds repositories are not available',
    'request.footprint': 'no tick-level volume data is available',
  };

  // ── Execution ─────────────────────────────────────────
  // Candles: an array of { time (s), open, high, low, close, volume } or columns { time, open, high, low, close, volume }
  // of equal-length (typed) arrays.
  function toColumns(c) {
    if (c && !Array.isArray(c) && c.time && c.close) return { T: c.time, O: c.open, H: c.high, Lo: c.low, C: c.close, V: c.volume || new Float64Array(c.time.length), n: c.time.length };
    const n = c.length, T = new Float64Array(n), O = new Float64Array(n), H = new Float64Array(n), Lo = new Float64Array(n), C = new Float64Array(n), V = new Float64Array(n);
    for (let i = 0; i < n; i++) { const x = c[i]; T[i] = x.time; O[i] = x.open; H[i] = x.high; Lo[i] = x.low; C[i] = x.close; V[i] = x.volume || 0; }
    return { T, O, H, Lo, C, V, n };
  }
  function aggColumns(R, tfSec) {
    const n = R.n, idx = new Int32Array(n), T = [], O = [], H = [], Lo = [], C = [], V = [];
    let cur = -1, b0 = NaN;
    for (let i = 0; i < n; i++) {
      const b = bucketOf(R.T[i], tfSec);
      if (b !== b0) { b0 = b; cur++; T.push(b); O.push(R.O[i]); H.push(R.H[i]); Lo.push(R.Lo[i]); C.push(R.C[i]); V.push(R.V[i]); }
      else { if (R.H[i] > H[cur]) H[cur] = R.H[i]; if (R.Lo[i] < Lo[cur]) Lo[cur] = R.Lo[i]; C[cur] = R.C[i]; V[cur] += R.V[i]; }
      idx[i] = cur;
    }
    return { cols: { time: Float64Array.from(T), open: Float64Array.from(O), high: Float64Array.from(H), low: Float64Array.from(Lo), close: Float64Array.from(C), volume: Float64Array.from(V) }, idx };
  }
  function guessTf(T, n) {
    const d = [];
    for (let i = 1; i < Math.min(n, 101); i++) { const x = T[i] - T[i - 1]; if (x > 0) d.push(x); }
    if (!d.length) return 60;
    d.sort((a, b) => a - b);
    return d[d.length >> 1];
  }
  function guessTick(C, n) {
    let dmax = 0;
    for (let i = Math.max(0, n - 200); i < n; i++) { const s = String(+(+C[i]).toFixed(6)); const k = s.indexOf('.'); if (k >= 0 && !/e/i.test(s)) dmax = Math.max(dmax, Math.min(5, s.length - k - 1)); }
    return 10 ** -dmax;
  }

  function runtime(cols, o, parsed) {
    const n = cols.n;
    const tfSec = o.tfSec > 0 ? o.tfSec : guessTf(cols.T, n);
    const mintick = o.mintick > 0 ? o.mintick : Number.isInteger(o.decimals) ? 10 ** -o.decimals : guessTick(cols.C, n);
    const limit = o.timeLimit || 5000;
    const R = {
      n, bar: 0, flow: 0, at: null, T: cols.T, O: cols.O, H: cols.H, Lo: cols.Lo, C: cols.C, V: cols.V,
      tfSec, tfStr: tfString(tfSec), mintick, symbol: o.symbol || '', ticker: o.ticker || o.symbol || 'CHART', tickerid: `IG:${o.ticker || o.symbol || 'CHART'}`, description: o.name || o.symbol || '',
      values: o.values || {}, inputs: [], inKeys: new Set(), inCache: [], inSites: 0, once: [],
      plots: [], hlines: [], fills: [], gradFills: [], bgs: [], shapes: [], alertDefs: [], alertCalls: 0, alertMsgs: [], logs: [], warnings: [], lazy: {},
      objs: { label: [], line: [], box: [], linefill: [], table: [], polyline: [] }, candles: [], barColors: null, needs: [], maxObjs: { label: 50, line: 50, box: 50, linefill: 50, polyline: 50 },
      sec: [], subRuns: {}, capture: o.capture || null, sub: !!o.sub, depth: o.depth || 0, rng: 42,
      deadline: o.deadline || Date.now() + limit, limit, broker: null, parsed, opts: o,
    };
    R.root = o.root || R;
    R.tickType = o.tickType || 'standard';
    R.check = (node) => { if (Date.now() > R.deadline) throw perr(`script exceeded the ${(R.limit / 1000).toFixed(R.limit % 1000 ? 1 : 0)} s time limit`, node || R.at, 'runtime'); };
    R.srcArr = (name, node) => {
      const own = { open: R.O, high: R.H, low: R.Lo, close: R.C, volume: R.V };
      if (!R.sub && typeof o.src === 'function') { const a = o.src(name); if (a && a.length === n) return a; }
      if (own[name]) return own[name];
      const f = { hl2: (i) => (R.H[i] + R.Lo[i]) / 2, hlc3: (i) => (R.H[i] + R.Lo[i] + R.C[i]) / 3, ohlc4: (i) => (R.O[i] + R.H[i] + R.Lo[i] + R.C[i]) / 4, hlcc4: (i) => (R.H[i] + R.Lo[i] + 2 * R.C[i]) / 4 }[name];
      if (!f) throw perr(R.sub ? `the source '${name}' (another indicator's output) cannot be used inside request.security()` : `unknown source '${name}'`, node, 'runtime');
      const a = new Float64Array(n);
      for (let i = 0; i < n; i++) a[i] = f(i);
      return a;
    };
    // request.security / request.security_lower_tf. The chart symbol at its own or a higher timeframe is computed from the
    // chart bars; other symbols and lower timeframes need bars the host loads (o.ext(symbol, tfSec) → candles | 'invalid' | null).
    // A missing series is recorded in R.root.needs and the run stops after the current bar with a 'data' PineError carrying
    // err.need, so the host can fetch and re-run (the interpreter itself is synchronous).
    R.setupSecurity = (id, sym, tf, gaps, la, node, lower, ignoreInvalid) => {
      const fn = lower ? 'request.security_lower_tf()' : 'request.security()';
      const tk = parseTicker(sym), s = tk.symbol, type = tk.type || 'standard';
      if (tk.bad) throw perr(`${fn}: '${s}' is not a valid ticker id`, node, 'runtime');
      if (type !== 'standard' && type !== 'heikinashi') throw perr(`${fn}: ticker type '${type}' is not supported (only standard and heikinashi)`, node, 'runtime');
      if ((tk.session && tk.session !== 'regular') || (tk.adjustment && tk.adjustment !== 'none') || tk.backadjustment || tk.settlement_as_close) {
        const k = 'tickmods';
        if (!R.root.warned) R.root.warned = new Set();
        if (!R.root.warned.has(k)) { R.root.warned.add(k); R.root.warnings.push(`line ${node.line}: ticker session / adjustment modifiers have no effect here (IG history has one session and no dividend/split adjustments)`); }
      }
      const isChart = !s || s === R.tickerid || s === R.ticker || s === R.symbol || s === `IG:${R.symbol}`;
      const want = tf === undefined || isNa(tf) || tf === '' ? R.tfSec : tfSecOf(tf);
      if (!want) throw perr(`invalid timeframe '${tf}'`, node, 'runtime');
      if (lower && want > R.tfSec) throw perr(`${fn}: the timeframe (${tf}) must not be higher than the chart's (${R.tfStr})`, node, 'runtime');
      const own = R.tickType || 'standard', ha = type === 'heikinashi';
      if (isChart && want === R.tfSec && type === own) return { direct: true };
      // inside a Heikin-Ashi context the standard bars of the chart symbol are not at hand (and vice versa)
      if (R.sub && isChart && type !== own) return { direct: false, at: lower ? () => new PArray([]) : () => NA };
      if (R.depth >= 2) throw perr('request.security() nested more than two levels deep is not supported', node, 'runtime');
      const N = R.n, tf0 = R.tfSec;
      if (isChart && want === R.tfSec && ha) {
        let sub = R.subRuns[`ha|${want}`];
        if (!sub) {
          const sr = execute(parsed, heikinAshi(R), { ...o, tfSec: want, sub: true, depth: R.depth + 1, capture: {}, values: R.values, deadline: R.deadline, onProgress: null, src: null, root: R.root, tickType: 'heikinashi' });
          sub = R.subRuns[`ha|${want}`] = { cap: sr.capture };
        }
        const vals = sub.cap[id] || [];
        return { direct: false, at: lower ? (i) => new PArray([histVal(vals[i])]) : (i) => histVal(vals[i]) };
      }
      if (isChart && want > R.tfSec) {
        const sk = ha ? `ha|${want}` : want;
        let sub = R.subRuns[sk];
        if (!sub) {
          const agg = aggColumns(R, want), ac = toColumns(agg.cols);
          const sr = execute(parsed, ha ? heikinAshi(ac) : ac, { ...o, tfSec: want, sub: true, depth: R.depth + 1, capture: {}, values: R.values, deadline: R.deadline, onProgress: null, src: null, root: R.root, tickType: type });
          sub = R.subRuns[sk] = { idx: agg.idx, cap: sr.capture };
        }
        const vals = sub.cap[id] || [], idx = sub.idx;
        const conf = (i) => i === N - 1 || idx[i + 1] !== idx[i];
        return {
          direct: false,
          at(i) {
            const j = idx[i];
            if (gaps) return conf(i) ? histVal(vals[j]) : NA;
            if (la) return histVal(vals[j]);
            return conf(i) ? histVal(vals[j]) : j > 0 ? histVal(vals[j - 1]) : NA;
          },
        };
      }
      // Inside another request.security() context only the chart-symbol paths nest; other symbols / lower timeframes give na
      // there (each context re-runs the whole script, so nesting them would multiply data loads and runs).
      if (R.sub) return { direct: false, at: lower ? () => new PArray([]) : () => NA };
      const symKey = isChart ? R.symbol : s.replace(/^IG:/i, '');
      if (!symKey) throw perr(`${fn}: the chart symbol is not known here, so ${lower || want < R.tfSec ? 'lower-timeframe data' : 'its data'} cannot be loaded`, node, 'runtime');
      const key = `${symKey}|${want}|${type}`;
      let sub = R.subRuns[key];
      if (!sub) {
        const ext = typeof o.ext === 'function' ? o.ext(symKey, want) : null;
        if (ext === 'invalid') {
          if (ignoreInvalid) return { direct: false, at: lower ? () => new PArray([]) : () => NA };
          throw perr(`${fn}: symbol '${s}' was not found (pass ignore_invalid_symbol=true to get na instead)`, node, 'runtime');
        }
        if (!ext) {
          if (!R.root.needs.some((x) => x.symbol === symKey && x.tfSec === want)) R.root.needs.push({ symbol: symKey, tfSec: want, tf: tfString(want), line: node.line, col: node.col });
          return { direct: false, at: () => NA };
        }
        const raw = toColumns(ext), cols = ha ? heikinAshi(raw) : raw;
        const sr = execute(parsed, cols, { ...o, tfSec: want, sub: true, depth: R.depth + 1, capture: {}, values: R.values, deadline: R.deadline, onProgress: null, src: null, root: R.root, symbol: symKey, ticker: symKey, name: symKey, mintick: 0, decimals: undefined, tickType: type });
        sub = R.subRuns[key] = { T: cols.T, n: cols.n, cap: sr.capture };
      }
      const vals = sub.cap[id] || [], ST = sub.T, M = sub.n;
      const lb = (x) => { let lo = 0, hi = M; while (lo < hi) { const m = (lo + hi) >> 1; if (ST[m] < x) lo = m + 1; else hi = m; } return lo; };
      if (lower) {
        return { direct: false, at(i) { const t0 = R.T[i], t1 = t0 + tf0, out = []; for (let j = lb(t0); j < M && ST[j] < t1; j++) out.push(histVal(vals[j])); return new PArray(out); } };
      }
      if (want < tf0) {
        return { direct: false, at(i) { const t0 = R.T[i], j = lb(t0 + tf0) - 1; if (j < 0 || (gaps && ST[j] < t0)) return NA; return histVal(vals[j]); } };
      }
      // another symbol at the same or a higher timeframe: the latest of its bars that started by this chart bar; lookahead_off
      // returns it only once it has closed (its end <= this chart bar's end), else the previous one.
      const endOf = (j) => (want >= 2592000 && j + 1 < M ? ST[j + 1] : ST[j] + want);
      const confAt = (i, j) => i === N - 1 || endOf(j) <= R.T[i] + tf0;
      return {
        direct: false,
        at(i) {
          const t = R.T[i], j = lb(t + 1) - 1;
          if (j < 0) return NA;
          if (la) return histVal(vals[j]);
          const c = confAt(i, j);
          if (gaps) { if (!c) return NA; if (i > 0) { const jp = lb(R.T[i - 1] + 1) - 1; if (jp === j && confAt(i - 1, jp)) return NA; } return histVal(vals[j]); }
          return c ? histVal(vals[j]) : j > 0 ? histVal(vals[j - 1]) : NA;
        },
      };
    };
    return R;
  }

  function needError(R) {
    const nd = R.needs, f = nd[0];
    const e = new PineError(`request.security(): loading ${nd.map((x) => `${x.symbol} (${x.tf})`).join(', ')}`, f.line, f.col, 'data');
    e.need = nd.map((x) => ({ symbol: x.symbol, tfSec: x.tfSec, tf: x.tf }));
    return e;
  }
  function execute(parsed, cols, o) {
    const R = runtime(cols, o, parsed);
    const comp = new Compiler(R, parsed);
    const main = comp.program(parsed.body);
    R.decl = comp.decl;
    const dv = comp.decl.v;
    for (const k of ['label', 'line', 'box']) { const m = dv(`max_${k}s_count`, 50); R.maxObjs[k] = clamp(ok(m) ? m : 50, 1, 500); }
    { const m = dv('max_polylines_count', 50); R.maxObjs.polyline = clamp(ok(m) ? m : 50, 1, 100); }
    if (comp.decl.kind === 'strategy' && !R.sub) R.broker = new Broker(R, o.props);
    const ctx = comp.mainCtx, F = R.main = newFrame(ctx), br = R.broker, n = R.n, prog = o.onProgress;
    try {
      for (let i = 0; i < n; i++) {
        R.bar = i;
        enterFrame(F, ctx);
        if (br) br.beforeBar(i);
        main(F);
        R.flow = 0;
        if (R.root.needs.length) throw needError(R.root);
        if (br) br.afterBar(i);
        if ((i & 63) === 63) { R.check(null); if (prog && (i & 4095) === 4095) prog(i + 1, n); }
      }
    } catch (e) {
      if (e instanceof PineError) throw e;
      throw new PineError(`${e && e.name ? `${e.name}: ` : ''}${(e && e.message) || e}`, R.at && R.at.line, R.at && R.at.col, 'runtime');
    }
    return R;
  }

  // ── Outputs → app shapes ──────────────────────────────
  const LW_STYLE = { style_solid: 0, style_dotted: 1, style_dashed: 2 };
  const G_STYLE = { style_solid: 0, style_dashed: 1, style_dotted: 2, style_arrow_left: 0, style_arrow_right: 0, style_arrow_both: 0 };
  function outputs(R) {
    const n = R.n, T = R.T, warnings = R.warnings.slice();
    const tAt = (x, xloc) => {
      if (xloc === 'bar_time') return Math.round(x / 1000);
      const i = Math.round(x);
      if (i >= 0 && i < n) return T[i];
      return i < 0 ? T[0] + i * R.tfSec : T[n - 1] + (i - n + 1) * R.tfSec;
    };
    const shift = (vals, off) => {
      if (!off) return vals;
      const out = new Array(n).fill(NA);
      for (let i = 0; i < n; i++) { const j = i + off; if (j >= 0 && j < n) out[j] = vals[i]; }
      return out;
    };
    const plots = R.plots.map((P, j) => {
      const hidden = P.display === 'none';
      const st = P.style;
      let values = shift(Array.from(P.values, (v) => (ok(v) ? v : NA)), P.offset);
      let colors = null, color = P.color === null || P.color === undefined ? 'rgba(0,0,0,0)' : P.color;
      if (P.colors) {
        const cs = shift(P.colors, P.offset), seen = new Set();
        for (let i = 0; i < n; i++) if (ok(values[i])) seen.add(cs[i] === null || cs[i] === undefined ? 'na' : cs[i]);
        if (seen.size <= 1) { const c = [...seen][0]; color = !c || c === 'na' ? 'rgba(0,0,0,0)' : c; }
        else { colors = cs.map((c) => (c === null || c === undefined ? 'rgba(0,0,0,0)' : c)); color = colors.find((c) => c !== 'rgba(0,0,0,0)') || NAMED.blue; }
      }
      if (hidden) { color = 'rgba(0,0,0,0)'; colors = null; }
      if (!hidden && colorAlpha(color) === 0 && !colors) values = values.slice();
      const out = { k: `p${j}`, title: P.title ? String(P.title) : `Plot ${j + 1}`, values, colors, color, type: /histogram|columns/.test(st) ? 'histogram' : 'line', width: ok(P.width) ? P.width : 1, dots: /circles|cross/.test(st), hidden };
      if (/stepline/.test(st)) out.lineType = 1;
      if (/area/.test(st) && !hidden) out.area = ok(P.histbase) ? P.histbase : 0;
      return out;
    });
    // style_area / style_areabr: the plot line plus a fill down to histbase (default 0), in the plot's colour at 25 % of its opacity
    const areaFill = (c) => { const q = parseColor(c); return q && q[3] > 0 ? mkColor(q[0], q[1], q[2], q[3] * 0.25) : null; };
    const fillRecs = R.fills.slice();
    plots.forEach((p, j) => {
      if (p.area === undefined) return;
      fillRecs.push({ a: { kind: 'plot', idx: j }, b: { kind: 'const', v: p.area }, colors: p.colors ? p.colors.map(areaFill) : new Array(n).fill(areaFill(p.color)), hidden: false });
    });
    const hlines = R.hlines.map((H, j) => ({ k: `h${j}`, title: H.title ? String(H.title) : `Level ${j + 1}`, price: H.price, color: H.display === 'none' || isNa(H.color) && H.color !== undefined ? 'rgba(0,0,0,0)' : H.color || '#787B86', style: LW_STYLE[H.style] === undefined ? 2 : LW_STYLE[H.style], width: H.width || 1 }));
    const keyOf = (ref) => (ref.kind === 'plot' ? `p${ref.idx}` : ref.kind === 'const' ? ref.v : `h${ref.idx}`);
    const valsOf = (ref) => (ref.kind === 'plot' ? plots[ref.idx].values : null);
    const graphics = [], fills = [];
    // gradient fills (drawn by pine-render.js): per bar, the colour runs from top_color at top_value to bottom_color at bottom_value
    const gradFills = [];
    for (const f of R.gradFills) {
      if (!f.a || f.hidden) continue;
      const side = (ref) => (ref.kind === 'plot' ? { k: plots[ref.idx].k, v: plots[ref.idx].values } : { k: hlines[ref.idx].k, v: new Array(n).fill(hlines[ref.idx].price) });
      const A = side(f.a), Bs = side(f.b);
      gradFills.push({ ka: A.k, kb: Bs.k, a: A.v, b: Bs.v, top: Array.from(f.top), bot: Array.from(f.bot), tc: f.tc.slice(), bc: f.bc.slice() });
    }
    // price bounds for full-height backgrounds
    let lo = Infinity, hi = -Infinity;
    const take = (v) => { if (ok(v)) { if (v < lo) lo = v; if (v > hi) hi = v; } };
    if (R.decl.overlay) for (let i = 0; i < n; i++) { take(R.Lo[i]); take(R.H[i]); }
    for (const p of plots) for (let i = 0; i < n; i++) take(p.values[i]);
    for (const h of hlines) take(h.price);
    for (const f of fillRecs) {
      if (!f.a || f.hidden) continue;
      const seen = new Set(f.colors.filter((c) => c));
      if (seen.size === 1 && f.colors.every((c) => c)) { fills.push({ a: keyOf(f.a), b: keyOf(f.b), color: [...seen][0] }); continue; }
      if (!seen.size) continue;
      const A = valsOf(f.a), Bv = valsOf(f.b), ha = f.a.kind === 'hline' ? hlines[f.a.idx].price : NA, hb = f.b.kind === 'hline' ? hlines[f.b.idx].price : f.b.kind === 'const' ? f.b.v : NA;
      let run = null;
      const flush = () => { if (run && run.top.length > 1) graphics.push({ kind: 'polyline', pts: [...run.top, ...run.bot.reverse()], color: 'transparent', width: 0, style: 0, fill: run.c }); run = null; };
      for (let i = 0; i < n; i++) {
        const va = A ? A[i] : ha, vb = Bv ? Bv[i] : hb, c = f.colors[i];
        if (!ok(va) || !ok(vb) || !c) { flush(); continue; }
        if (run && run.c !== c) { const last = { top: run.top[run.top.length - 1], bot: run.bot[run.bot.length - 1] }; flush(); run = { c, top: [last.top], bot: [last.bot] }; }
        if (!run) run = { c, top: [], bot: [] };
        run.top.push({ t: T[i], p: va }); run.bot.push({ t: T[i], p: vb });
      }
      flush();
    }
    if (R.bgs.length && ok(lo)) {
      const span = hi - lo || Math.abs(hi) || 1, top = hi + span * 20, bot = R.decl.overlay && lo > 0 ? lo / 20 : lo - span * 20;
      for (const bg of R.bgs) {
        const cs = shift(bg.colors, bg.offset);
        let i = 0;
        while (i < n) {
          const c = cs[i];
          if (!c || colorAlpha(c) === 0) { i++; continue; }
          let j = i;
          while (j + 1 < n && cs[j + 1] === c) j++;
          graphics.push({ kind: 'box', t1: T[i], p1: top, t2: j + 1 < n ? T[j + 1] : T[j] + R.tfSec, p2: bot, color: null, fill: c });
          i = j + 1;
        }
      }
    }
    const markers = [];
    for (const s of R.shapes) {
      if (s.hidden) continue;
      for (const h of s.hits) {
        const i = h.i + s.offset;
        if (i < 0 || i >= n) continue;
        if (s.path === 'plotarrow') { markers.push({ time: T[i], position: h.up ? 'belowBar' : 'aboveBar', shape: h.up ? 'arrowUp' : 'arrowDown', color: h.color || (h.up ? NAMED.green : NAMED.red), text: '' }); continue; }
        if (!h.color) continue;
        const loc = s.loc, pos = loc === 'belowbar' || loc === 'bottom' ? 'belowBar' : loc === 'absolute' ? 'inBar' : 'aboveBar';
        const shape = s.path === 'plotchar' ? 'circle' : SHAPE[s.style] || 'circle';
        const text = s.path === 'plotchar' ? `${s.ch === undefined ? '★' : s.ch}${h.text ? ` ${h.text}` : ''}` : h.text;
        markers.push({ time: T[i], position: pos, shape, color: h.color, text, size: (MSIZE[s.size] || 1) * (s.path === 'plotchar' ? 0.4 : 1) });
      }
    }
    markers.sort((a, b) => a.time - b.time);
    if (markers.length > 5000) markers.splice(0, markers.length - 5000);
    for (const o of R.objs.line) {
      if (!ok(o.x1) || !ok(o.x2) || !ok(o.y1) || !ok(o.y2) || isNa(o.color)) continue;
      graphics.push({ kind: 'line', t1: tAt(o.x1, o.xloc), p1: o.y1, t2: tAt(o.x2, o.xloc), p2: o.y2, color: o.color, width: o.width || 1, style: G_STYLE[o.style] || 0, extend: o.extend || 'none' });
    }
    for (const o of R.objs.box) {
      if (![o.left, o.right, o.top, o.bottom].every(ok)) continue;
      const t2 = o.extend === 'right' || o.extend === 'both' ? Math.max(tAt(o.right, o.xloc), T[n - 1]) : tAt(o.right, o.xloc);
      graphics.push({ kind: 'box', t1: tAt(o.left, o.xloc), p1: o.top, t2, p2: o.bottom, color: isNa(o.border) ? null : o.border, fill: isNa(o.bg) ? null : o.bg, text: o.text, textColor: isNa(o.tc) ? null : o.tc });
    }
    for (const o of R.objs.linefill) {
      const a = o.a, b = o.b;
      if (!a || !b || a.deleted || b.deleted || isNa(o.color)) continue;
      graphics.push({ kind: 'polyline', pts: [{ t: tAt(a.x1, a.xloc), p: a.y1 }, { t: tAt(a.x2, a.xloc), p: a.y2 }, { t: tAt(b.x2, b.xloc), p: b.y2 }, { t: tAt(b.x1, b.xloc), p: b.y1 }], color: 'transparent', width: 0, style: 0, fill: o.color });
    }
    const GLYPH = { style_xcross: '✕', style_cross: '+', style_triangleup: '▲', style_triangledown: '▼', style_flag: '⚑', style_circle: '●', style_arrowup: '↑', style_arrowdown: '↓', style_square: '■', style_diamond: '◆' };
    for (const o of R.objs.label) {
      if (!ok(o.x)) continue;
      const i = o.xloc === 'bar_time' ? -1 : Math.round(o.x);
      let p = o.y;
      if (o.yloc === 'abovebar' && i >= 0 && i < n) p = R.H[i];
      if (o.yloc === 'belowbar' && i >= 0 && i < n) p = R.Lo[i];
      if (!ok(p)) continue;
      const st = o.style, g = GLYPH[st];
      let base = 'middle', align = 'center';
      if (st === 'style_label_down' || o.yloc === 'abovebar') base = 'bottom';
      if (st === 'style_label_up' || o.yloc === 'belowbar') base = 'top';
      if (st === 'style_label_left') align = 'left';
      if (st === 'style_label_right') align = 'right';
      if (/lower_left|upper_left/.test(st)) align = 'left';
      if (/lower_right|upper_right/.test(st)) align = 'right';
      if (/upper_/.test(st)) base = 'bottom';
      if (/lower_/.test(st)) base = 'top';
      const plain = g || st === 'style_none' || st === 'style_text_outline';
      const text = `${g || ''}${g && o.text ? ' ' : ''}${o.text}`.replace(/\n/g, '  ');
      if (!text) continue;
      graphics.push({ kind: 'label', t: tAt(o.x, o.xloc), p, text, color: isNa(o.textcolor) ? (plain ? o.color : '#FFFFFF') : plain && g ? o.color || o.textcolor : o.textcolor, bg: plain || isNa(o.color) ? null : o.color, align, base });
    }
    // plotcandle / plotbar: per-bar OHLC + colours (drawn by pine-render.js); barcolor(): one colour (or null) per bar
    const candles = R.candles.filter((c) => !c.hidden).map((c) => ({ k: `c${c.idx}`, kind: c.kind, title: c.title ? String(c.title) : c.kind === 'bar' ? `Bars ${c.idx + 1}` : `Candles ${c.idx + 1}`, o: Array.from(c.o), h: Array.from(c.h), l: Array.from(c.l), c: Array.from(c.c), color: c.color, wick: c.wick, border: c.border }));
    const barColors = R.barColors && R.barColors.some((c) => c) ? R.barColors.slice() : null;
    // polylines (drawn by pine-render.js): points as { t (s), p }; style 0 solid, 1 dashed, 2 dotted
    const polylines = [];
    for (const o of R.objs.polyline) {
      const pts = o.points.filter((q) => ok(q.x) && ok(q.p)).map((q) => ({ t: tAt(q.x, o.xloc), p: q.p }));
      if (pts.length < 2 || (!o.color && !o.fill)) continue;
      polylines.push({ pts, curved: o.curved, closed: o.closed, color: o.color, fill: o.fill, width: o.width, style: G_STYLE[o.style] || 0 });
    }
    // tables: final state after the last bar, in creation order
    const tables = R.objs.table.filter((t) => !t.deleted).map((t) => ({
      position: t.position.replace(/^position\./, ''), cols: t.cols, rows: t.rows, bg: t.bg, frame: t.frame, frameW: t.frameW, border: t.border, borderW: t.borderW,
      cells: [...t.cells.values()].sort((a, b) => a.r - b.r || a.c - b.c).map((x) => ({ ...x })), merges: t.merges.map((m) => ({ ...m })),
    }));
    return { plots, hlines, fills, markers, graphics, warnings, candles, barColors, tables, polylines, gradFills };
  }

  // ── Public API ────────────────────────────────────────
  const PARAM_SOURCES = ['close', 'open', 'high', 'low', 'hl2', 'hlc3', 'ohlc4', 'hlcc4', 'volume'];
  // run(code, candles, { values, tfSec, src(name), symbol, decimals, mintick, props, timeLimit, deadline, onProgress })
  function run(code, candles, o = {}) {
    const t0 = Date.now();
    const parsed = parse(code);
    const cols = toColumns(candles);
    const R = execute(parsed, cols, o);
    const out = outputs(R);
    const br = R.broker;
    return {
      kind: R.decl.kind, version: parsed.version, decl: { kind: R.decl.kind, title: R.decl.title, shorttitle: R.decl.shorttitle, overlay: R.decl.overlay }, declProps: declProps(R.decl),
      inputs: R.inputs, ...out, alerts: R.alertDefs.map((a) => ({ title: a.title, count: a.count, last: a.last })), alertCalls: R.alertCalls, alertMsgs: R.alertMsgs, logs: R.logs,
      orders: br ? br.fills : null, trades: br ? br.closed : null, openTrades: br ? br.trades : null, n: R.n, tfSec: R.tfSec, ms: Date.now() - t0,
    };
  }
  // Static facts without running: kind, title, overlay, declared tester properties. Throws PineError on syntax errors.
  function analyze(code) {
    const parsed = parse(code);
    const d = findDecl(parsed.body, parsed.version);
    return { version: parsed.version, kind: d.kind, title: d.title, shorttitle: d.shorttitle, overlay: d.overlay, props: declProps(d) };
  }
  function detect(code) {
    const s = String(code || '');
    const isPine = /^\s*\/\/\s*@version\s*=\s*\d/m.test(s) || /^\s*(indicator|strategy|study|library)\s*\(/m.test(s);
    return { isPine, kind: /^\s*strategy\s*\(/m.test(s) ? 'strategy' : /^\s*library\s*\(/m.test(s) ? 'library' : 'indicator' };
  }
  // Library registry helpers (no parsing, safe on any text): the title a script declares with library("…"), and the library
  // names a script imports.
  function libraryTitle(code) {
    const m = /^\s*library\s*\(\s*(?:title\s*=\s*)?(["'])((?:(?!\1).)+)\1/m.exec(String(code || ''));
    return m ? m[2] : null;
  }
  function importsOf(code) {
    const out = [];
    for (const m of String(code || '').matchAll(/^\s*import\s+([A-Za-z_]\w*)\s*\/\s*([A-Za-z_]\w*)(?:\s*\/\s*(\d+))?(?:\s+as\s+([A-Za-z_]\w*))?/gm)) out.push({ publisher: m[1], name: m[2], version: m[3] ? +m[3] : null, alias: m[4] || m[2] });
    return out;
  }
  // App input schema (strategy tester / indicator settings). Pine 'source' inputs map to the app's 'source' type.
  const appParams = (inputs) => inputs.map((x) => ({ ...x }));
  const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'script';
  const PALETTE = ['#2962ff', '#ff6d00', '#26a69a', '#ef5350', '#ab47bc', '#f7b924', '#4dd0e1', '#8d6e63'];
  // IGInd definition for a Pine indicator; `sample` is a run() result that fixes the outputs (plot / hline / plotcandle call sites).
  // plotcandle/plotbar series become four transparent outputs (O/H/L/C: legend values and autoscale); pine-render.js draws them.
  const HIDDEN = 'rgba(0,0,0,0)';
  const OHLC = [['o', 'O'], ['h', 'H'], ['l', 'L'], ['c', 'C']];
  function defOutputs(sample) {
    return [
      ...sample.plots.map((p, j) => ({ k: p.k, label: p.title, type: p.type, color: colorAlpha(p.color) === 0 && !p.colors ? HIDDEN : p.color || PALETTE[j % PALETTE.length], width: p.width || 1, style: 0, dots: p.dots || undefined, lineType: p.lineType || undefined })),
      ...sample.hlines.map((h) => ({ k: h.k, label: h.title, type: 'line', color: h.color, width: h.width, style: h.style })),
      ...(sample.candles || []).flatMap((c) => OHLC.map(([s, L]) => ({ k: `${c.k}${s}`, label: `${c.title} ${L}`, type: 'line', color: HIDDEN, width: 1, style: 0 }))),
    ];
  }
  // run() result → IGInd calc() output. Extra Pine visuals ride along in out.pine (chartview ignores unknown keys).
  function indicatorOut(r, n) {
    const out = {}, colors = {};
    for (const p of r.plots) { out[p.k] = p.values; if (p.colors) colors[p.k] = p.colors; }
    for (const h of r.hlines) out[h.k] = new Array(n).fill(h.price);
    for (const c of r.candles || []) for (const [s] of OHLC) out[`${c.k}${s}`] = c[s];
    if (Object.keys(colors).length) out.colors = colors;
    if (r.markers.length) out.markers = r.markers;
    if (r.graphics.length) out.graphics = r.graphics;
    out.pine = { barColors: r.barColors || null, candles: r.candles || [], tables: r.tables || [], polylines: r.polylines || [], gradFills: r.gradFills || [] };
    return out;
  }
  function errorOut(outs, candles, e) {
    const out = {};
    for (const o of outs) out[o.k] = new Array(candles.length).fill(NA);
    const last = candles[candles.length - 1];
    const msg = e instanceof PineError ? e.toString() : (e && e.message) || String(e);
    if (last) out.graphics = [{ kind: 'label', t: last.time, p: last.close, text: `Pine error: ${msg}`, color: '#FFFFFF', bg: '#ef5350', align: 'right', base: 'bottom' }];
    return out;
  }
  function indicatorDef(script, sample) {
    const id = `script:${slug(script.name)}`;
    const outs = defOutputs(sample);
    const def = {
      id, name: script.name, short: sample.decl.shorttitle || script.name, kind: sample.decl.overlay ? 'overlay' : 'pane', category: 'Scripts', script: true, pine: true,
      params: appParams(sample.inputs), outputs: outs, fills: sample.fills.slice(),
      // Synchronous fallback (main thread). strategy.js replaces calc with a worker-backed version for the chart.
      calc(candles, params, cx) {
        let r;
        try {
          r = run(script.code, candles, { values: params || {}, tfSec: cx && cx.tfSec, src: cx && typeof cx.src === 'function' ? cx.src : null, symbol: cx && cx.symbol, decimals: cx && cx.decimals, timeLimit: 3000, libs: script.libs, ext: cx && cx.ext });
        } catch (e) { return errorOut(outs, candles, e); }
        def.fills = r.fills;
        return indicatorOut(r, candles.length);
      },
    };
    return def;
  }
  // Strategy-tester signal object: the broker's fills replayed by strategy.js backtest() ("orders" mode).
  function strategySignals(r, n) {
    const f = new Array(n).fill(false);
    return { long: f, short: f, orders: r.orders || [] };
  }

  const LIMITS = [
    'request.security(): the chart symbol at a higher timeframe is built from the chart bars (UTC buckets); other symbols and lower timeframes are loaded from /api/history before the run (the app\'s epics; other names are looked up with /api/search)',
    'request.security_lower_tf(): intrabar arrays need the lower-timeframe history to reach back far enough; older chart bars get empty arrays',
    'time / session / VWAP anchors use UTC',
    'import: libraries come from scripts saved in the Script Editor that declare library("Name") (matched by name; the version is ignored)',
    'request.currency_rate(): the daily close of the FX pair (e.g. EURUSD, inverted for USD → EUR), loaded like request.security(pair, "D", close)',
    'ticker.*: heikinashi is computed from the requested bars; session / adjustment modifiers are accepted but have no effect (IG history has one session and no adjustments)',
    'not supported: ticker.renko / linebreak / kagi / pointfigure (non-time-based bars), request.financial / dividends / earnings / splits / economic / quandl / seed and dividends.* / earnings.* / splits.* (no data source), request.security(currency=...), strategy.risk.* (except allow_entry_in), matrix functions outside the common subset',
    'drawn approximately: plotchar as small markers; tables show their state after the last bar; curved polylines as a Catmull-Rom spline',
  ];
  G.IGPine = { run, parse, analyze, detect, libraryTitle, importsOf, indicatorDef, indicatorOut, errorOut, defOutputs, strategySignals, PineError, LIMITS, PARAM_SOURCES, tfString, tfSecOf, bucketOf, _internal: { lex, aggregateBars } };
})();
