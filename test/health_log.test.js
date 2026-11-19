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
console.log(pass + ' passed');
