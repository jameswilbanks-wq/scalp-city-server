/* Observability safety test: the new logging (slog / noteMsg / heartbeat) must never throw, never leak secrets, and log status only on change.
   The real source is extracted from server.js (never started). Synthetic state only. Run: node test/health_log.test.js */
'use strict';
const assert = require('assert'), fs = require('fs'), path = require('path');
let pass = 0; const t = (n, f) => { try { f(); pass++; console.log('ok   ' + n); } catch (e) { console.error('FAIL ' + n + '\n' + (e && e.stack || e)); process.exitCode = 1; } };

const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8').replace(/\r\n/g, '\n');
const a = src.indexOf('/* ---------- observability'), b = src.indexOf('\n}\n', src.indexOf('function heartbeat()'));
assert.ok(a > 0 && b > a, 'could not locate the observability block in server.js');
const body = src.slice(a, b + 3);
function build(P, S) {
  const lines = []; const log = { log: (s) => lines.push(s) };
  const make = new Function('P', 'S', 'marketOpen', 'console', body + '\nreturn { slog, noteMsg, heartbeat };');
  return { fns: make(P, S, () => true, log), lines, parsed: () => lines.map(l => JSON.parse(l)) };
}
const goodP = () => ({ ctl: { running: true }, busy: true, busySince: Date.now() - 5000, stage: 'bars:SPY', lastTick: Date.now() - 3000, msg: 'Running. Last check 15:01:02 UTC.', tickErr: '', saveErr: '', scan: ['SPY', 'QQQ'], bars: { SPY: new Array(80), QQQ: null },
  orbErr: 'boom', rec: { day: '2026-11-19', trades: [1, 2], shut: '', pos: { sym: 'SPY' }, orbk: { open: [1] }, csk: { open: [] } } });

t('heartbeat reports stage, busy time, per-book errors, scan bar counts and open positions', () => {
  const x = build(goodP(), { connected: true }); x.fns.heartbeat();
  const h = x.parsed()[0];
  assert.strictEqual(h.tag, 'heartbeat'); assert.strictEqual(h.stage, 'bars:SPY'); assert.ok(h.busyS >= 4 && h.busyS <= 7); assert.strictEqual(h.bookErr.orb, 'boom');
  assert.deepStrictEqual(h.scanBars, { SPY: 80, QQQ: 0 }); assert.strictEqual(h.open.main, true); assert.strictEqual(h.open.orbk, 1); assert.strictEqual(h.open.csk, 0); assert.strictEqual(h.trades, 2);
});
t('heartbeat never throws on missing or garbage state (fail open)', () => {
  [{}, { rec: null }, { ctl: null, rec: { orbk: null } }, { scan: ['X'], bars: null }].forEach(P => { const x = build(P, {}); x.fns.heartbeat(); assert.ok(x.lines.length >= 1); });
  const x = build(goodP(), null); x.fns.heartbeat(); assert.strictEqual(x.parsed()[0].tag, 'heartbeat_error');
});
t('slog never throws (circular object) and adds a timestamp and tag', () => {
  const x = build(goodP(), {}); const c = {}; c.c = c; assert.doesNotThrow(() => x.fns.slog('x', c)); x.fns.slog('ok', { a: 1 });
  const r = x.parsed()[0]; assert.strictEqual(r.tag, 'ok'); assert.ok(!Number.isNaN(Date.parse(r.t)));
});
t('noteMsg logs only when the status changes, ignoring the clock time inside it', () => {
  const P = goodP(), x = build(P, {});
  P.msg = 'Running. Last check 15:01:02 UTC.'; x.fns.noteMsg(); P.msg = 'Running. Last check 15:01:22 UTC.'; x.fns.noteMsg(); assert.strictEqual(x.lines.length, 1);
  P.msg = 'Could not check the market this round (alpaca 401). Retrying.'; x.fns.noteMsg(); x.fns.noteMsg(); assert.strictEqual(x.lines.length, 2);
  assert.ok(/alpaca 401/.test(x.parsed()[1].msg));
});
t('no secrets are logged: environment values never appear in heartbeat output', () => {
  process.env.ALPACA_SECRET = 'SECRET-VALUE-XYZ'; process.env.DATABASE_URL = 'postgres://user:PASSWORD-XYZ@host/db';
  const x = build(goodP(), { connected: true }); x.fns.heartbeat(); x.fns.noteMsg();
  const all = x.lines.join('\n'); assert.ok(!all.includes('SECRET-VALUE-XYZ') && !all.includes('PASSWORD-XYZ'));
  assert.ok(!/ALPACA_SECRET|DATABASE_URL|process\.env/.test(body), 'logging block must not read env vars');
});
t('the instrumented tick() releases the busy flag in finally and the logging block places no trades', () => {
  const tk = src.slice(src.indexOf('async function tick()'), src.indexOf('async function manualClose()'));
  assert.ok(/finally \{ P\.busy = false; P\.busySince = 0; P\.stage = ''; noteMsg\(\); \}/.test(tk));
  assert.ok(!/closePaper|alpacaBuy|alpacaSell|placeOrder|apTrade/.test(body), 'logging block must not place or close trades');
});
/* ---- bookDiag: read-only per-book scan state ---- */
const da = src.indexOf('function bookDiag()'), db = src.indexOf('\nasync function manualClose()');
assert.ok(da > 0 && db > da, 'could not locate bookDiag');
const diagSrc = src.slice(da, db);
function diag(rec, min, open, over) {
  const cfg = Object.assign({ ORB_ON: true, ORB_MODE: '15', CSK_ON: true, X9_ON: true, FP_ON: true, CDR_ON: true }, over || {});
  const f = new Function('P', 'nowET', 'marketOpen', 'ORB_ON', 'ORB_MODE', 'CSK_ON', 'CSK', 'X9_ON', 'FP_ON', 'CDR_ON', 'CDR', diagSrc + '\nreturn bookDiag();');
  return f({ rec }, () => ({ min }), () => open, cfg.ORB_ON, cfg.ORB_MODE, cfg.CSK_ON, { min: 660 }, cfg.X9_ON, cfg.FP_ON, cfg.CDR_ON, { entryFrom: 640, entryTo: 750 });
}
const rec0 = () => ({ trades: [], signals: [], orbk: { open: [], trades: [], done: { SPY: true } }, csk: { open: [], trades: [], done: {} }, cdrk: { open: [], trades: [], done: {}, haltedToday: false } });
t('bookDiag says why each book is quiet: in window, outside window, market closed, off, shut, halted', () => {
  let d = diag(rec0(), 600, true); assert.strictEqual(d.fp.state, 'in window'); assert.strictEqual(d.csk.state, 'outside window'); assert.strictEqual(d.cdr.state, 'outside window'); assert.deepStrictEqual(d.orb.done, ['SPY']);
  d = diag(rec0(), 670, true); assert.strictEqual(d.csk.state, 'in window'); assert.strictEqual(d.cdr.state, 'in window'); assert.strictEqual(d.fp.state, 'outside window');
  assert.strictEqual(diag(rec0(), 700, false).x9.state, 'market closed');
  assert.strictEqual(diag(rec0(), 700, true, { X9_ON: false }).x9.state, 'off');
  const s = rec0(); s.shut = 'stopped by you'; assert.strictEqual(diag(s, 700, true).fp.state, 'shut:stopped by you');
  const h = rec0(); h.cdrk.haltedToday = true; assert.strictEqual(diag(h, 700, true).cdr.state, 'halted today');
});
t('bookDiag reports signals by action, the last signal, open and closed counts, and never mutates the record', () => {
  const r = rec0(); r.signals = [{ t: 'a', sym: 'SPY', trig: 'orb5', action: 'skipped', why: 'x'.repeat(300) }, { t: 'b', sym: 'QQQ', trig: 'cspread', action: 'taken', why: '' }];
  r.orbk.open = [1]; r.fpk = { open: [], trades: [1, 2] }; const before = JSON.stringify(r);
  const d = diag(r, 700, true);
  assert.deepStrictEqual(d.signals, { skipped: 1, taken: 1 }); assert.strictEqual(d.lastSignal.sym, 'QQQ'); assert.strictEqual(d.orb.open, 1); assert.strictEqual(d.fp.closed, 2); assert.strictEqual(JSON.stringify(r), before);
  r.signals.reverse(); assert.ok(diag(r, 700, true).lastSignal.why.length <= 140);
});
t('bookDiag never throws and returns null with no record', () => {
  assert.strictEqual(diag(null, 700, true), null);
  const d = diag({ signals: 5, orbk: 3 }, 700, true); assert.ok(d === null || typeof d === 'object');
});
t('only logging/diagnostic additions: logSignal still pushes the same row, bookDiag has no writes', () => {
  assert.ok(/P\.rec\.signals\.push\(\{ t: iso\(Date\.now\(\)\), sym, dir: sig\.dir, trig: sig\.trig, px, action, why: why \|\| '' \}\);/.test(src));
  assert.ok(!/\.push\(|\bdelete\b|saveRec|logSignal\(/.test(diagSrc.replace(/sigs\.forEach[^\n]*/, '')), 'bookDiag must not write');
});
t('pickContract quote-age logging is additive: decision lines unchanged, log wrapped in try/catch', () => {
  assert.ok(src.includes("if (q.updated_at && Date.now() - Date.parse(q.updated_at) > 120000) { stale = true; _ages.push("), 'stale threshold must stay 120000 ms');
  assert.ok(src.includes("return { why: cheapest === null ? (stale ? 'option quotes are stale' : 'no live quotes')"), 'returned reason text must be unchanged');
  assert.ok(/\{ try \{ _ages\.sort[\s\S]*?slog\('quote_check'[\s\S]*?\} catch \(e\) \{\} \}/.test(src), 'quote_check log must be inside try/catch');
  assert.ok(src.includes("if (age > 180000) { slog('quote_check'") && src.includes("logSignal(s, fake, px, 'skipped', 'call spread: quotes are stale'); continue; }"), 'csk stale limit and reason unchanged');
  assert.ok(src.includes('if (ask * 100 > maxPrem) continue;') && src.includes('if ((ask - bid) / ask > CFG.maxSpread) continue;'));
});
/* ---- quoteSample: read-only option-quote age sampler ---- */
const qa = src.indexOf('let _qsBusy = false;'), qb = src.indexOf('/* Read-only per-book scan state');
assert.ok(qa > 0 && qb > qa, 'could not locate quoteSample');
const qsSrc = src.slice(qa, qb);
function runSample(o) {
  const lines = [], calls = [];
  const f = new Function('S', 'marketOpen', 'CFG', 'P', 'getChain', 'pickExpiry', 'getInst', 'rh', 'slog', qsSrc + '\nreturn quoteSample;');
  const P = { rec: { signals: [], pos: null }, info: { SPY: { bar: { c: 738.2 } }, QQQ: { bar: { c: 660 } } } }, before = JSON.stringify(P.rec);
  const fn = f({ connected: o.connected !== false }, () => o.open !== false, { syms: ['SPY', 'QQQ'], dte: 0 }, P, async () => ({}), () => o.noExp ? null : '2026-11-19',
    async (ch, exp, type) => [736, 737, 738, 739, 740, 741].map(k => ({ id: type + k, strike: k })),
    async (tool, a) => { calls.push([tool, a.instrument_ids.length]); if (o.fail) throw new Error('boom'); return { results: a.instrument_ids.map(id => id.endsWith('739') ? {} : { quote: { instrument_id: id, bid_price: 0.5, ask_price: 0.52, updated_at: new Date(Date.now() - 30000).toISOString() } }) }; },
    (tag, x) => lines.push({ tag, x }));
  return { fn, lines, calls, P, before };
}
const asyncQ = []; const ta = (n, f) => asyncQ.push([n, f]);
ta('quoteSample logs ages for nearest-the-money calls and puts, flags missing quotes, and never touches the journal', async () => {
  const r = runSample({}); await r.fn();
  const s = r.lines.filter(l => l.tag === 'quote_sample'); assert.strictEqual(s.length, 2);
  const spy = s[0].x; assert.strictEqual(spy.sym, 'SPY'); assert.deepStrictEqual(spy.call.map(x => x.k).sort(), [737, 738, 739]);
  assert.ok(spy.call.find(x => x.k === 739).none && spy.call.find(x => x.k === 738).ageS >= 29 && spy.call.find(x => x.k === 738).spread === 0.02);
  assert.strictEqual(JSON.stringify(r.P.rec), r.before); assert.ok(r.calls.every(c => c[0] === 'get_option_quotes' && c[1] === 3));
});
ta('quoteSample is a no-op when the market is closed or the connection is down, and never throws on a data error', async () => {
  let r = runSample({ open: false }); await r.fn(); assert.strictEqual(r.lines.length, 0); assert.strictEqual(r.calls.length, 0);
  r = runSample({ connected: false }); await r.fn(); assert.strictEqual(r.calls.length, 0);
  r = runSample({ fail: true }); await r.fn(); assert.strictEqual(r.lines[0].tag, 'quote_sample_error');
  r = runSample({ noExp: true }); await r.fn(); assert.strictEqual(r.lines.length, 0);
});
t('quoteSample code has no order, journal-write or logSignal calls', () => {
  assert.ok(!/closePaper|alpacaBuy|alpacaSell|apTrade|saveRec|logSignal|\.push\(/.test(qsSrc.replace(/\(qd\.results \|\| \[\]\)\.forEach[^\n]*/, '')), 'sampler must be read-only');
});
(async () => {
  for (const [n, f] of asyncQ) { try { await f(); pass++; console.log('ok   ' + n); } catch (e) { console.error('FAIL ' + n + '\n' + (e && e.stack || e)); process.exitCode = 1; } }
  console.log(pass + ' passed');
})();
