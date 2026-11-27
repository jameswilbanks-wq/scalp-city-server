/* CSK per-day ON/OFF switch (server.js: r.cskOff checked in cskLook and cskReservedUSD, POST /api/cskday, page data cd; public/city.html: #cskDay button, Web.cskDayTap / cskDayPaint) test. Behaviour under test: with the switch OFF today the CSK auto entry (cskLook) makes no entry, loads no option chain and sets no done-flag, and the correlation-cap reserve owed to CSK is zero so other books are not blocked by a spread that will not come; with it ON (default, field absent) cskLook proceeds as before; the switch lives on today's record so it resets to ON on the next trading day; the route needs the key, accepts only on=1/0, and saves the record; the page data carries cd and the page has the button. Mock clock and data, no network, no orders. Related tests: csk2.test.js (slots), csk_priority.test.js (reserve), ondemand.test.js (guardrails switch pattern). Run: node test/csk_day_switch.test.js */
'use strict';
const assert = require('assert'), fs = require('fs'), path = require('path');
const SRC = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8'), HTML = fs.readFileSync(path.join(__dirname, '..', 'public', 'city.html'), 'utf8');
let pass = 0; const tests = []; const t = (n, f) => tests.push([n, f]);
function fn(name) { let i = SRC.indexOf('async function ' + name + '('); if (i < 0) i = SRC.indexOf('function ' + name + '('); assert.ok(i >= 0, 'missing ' + name); let d = 0; for (let k = SRC.indexOf('{', i); k < SRC.length; k++) { if (SRC[k] === '{') d++; else if (SRC[k] === '}') { d--; if (d === 0) return SRC.slice(i, k + 1); } } throw new Error('unbalanced ' + name); }

function lookHarness(cskOff) {
  const calls = { chain: 0, sig: [] }, P = { rec: { shut: '', csk: { done: {}, open: [], trades: [], pnl: 0 } }, info: { SPY: { bar: { c: 700, t: Date.now() } }, QQQ: { bar: { c: 630, t: Date.now() } } } };
  if (cskOff !== undefined) P.rec.cskOff = cskOff;
  const mk = new Function('P', 'CSK_ON', 'CSK', 'CSK2', 'marketOpen', 'nowET', 'cskSlot', 'getChain', 'logSignal', 'saveRec', 'slog', 'return ' + fn('cskLook') + ';');
  const look = mk(P, true, { syms: ['SPY', 'QQQ'], pct: 0.0045, width: 2, min: 660 }, { on: true, min: 750 }, () => true, () => ({ min: 665, day: '2026-11-25' }), () => ({ n: 1, tag: '' }), async () => { calls.chain++; return { dates: [] }; }, (s, f, px, a, why) => calls.sig.push([s, a, why]), () => { calls.saved = true; }, () => {});
  return { look, P, calls };
}
t('switch OFF: cskLook makes no entry, loads no option chain, sets no done-flag and logs nothing', async () => {
  const h = lookHarness(true); await h.look(); assert.strictEqual(h.calls.chain, 0); assert.deepStrictEqual(h.P.rec.csk.done, {}); assert.strictEqual(h.calls.sig.length, 0); assert.strictEqual(h.P.rec.csk.open.length, 0);
});
t('switch ON (field absent, or explicitly false): cskLook proceeds as before - it reaches the option chain for both symbols and sets the done-flags', async () => {
  for (const v of [undefined, false]) { const h = lookHarness(v); await h.look(); assert.strictEqual(h.calls.chain, 2, 'cskOff=' + v); assert.deepStrictEqual(Object.keys(h.P.rec.csk.done).sort(), ['QQQ', 'SPY']); }
});
t('turning it back ON inside the window works: the same record, flag flipped, entries happen then', async () => {
  const h = lookHarness(true); await h.look(); assert.strictEqual(h.calls.chain, 0); h.P.rec.cskOff = false; await h.look(); assert.strictEqual(h.calls.chain, 2);
});
t('correlation-cap reserve owed to CSK is zero while the switch is OFF (other books are not blocked by a spread that will not come); unchanged when ON', () => {
  const f = new Function('CORR_GROUPS', 'CORR_CAP_USD', 'CSK_ON', 'CSK', 'CSK2', 'nowET', fn('cskReservedUSD') + '\nreturn cskReservedUSD;')(['SPY', 'QQQ'], 1200, true, { syms: ['SPY', 'QQQ'], width: 2, min: 660 }, { on: true, min: 750 }, () => ({ min: 600 }));
  assert.strictEqual(f({ csk: { done: {} } }), 640); assert.strictEqual(f({ csk: { done: {} }, cskOff: true }), 0); assert.strictEqual(f({ csk: { done: {} }, cskOff: false }), 640);
});
t('open spreads are still managed while OFF: cskManage and cskClose never read cskOff, and the tick still calls cskManage', () => {
  assert.ok(!/cskOff/.test(fn('cskManage')) && !/cskOff/.test(fn('cskClose')), 'exit code untouched'); assert.ok(/if \(open\) await cskLook\(\); await cskManage\(\);/.test(SRC), 'manage runs regardless');
});
t('route: POST /api/cskday behind the key, on=1 or 0 only, 503 without a record, sets today\'s record flag, saves it; page data carries cd', () => {
  const auth = SRC.indexOf('if (!authed(u, req))'), route = SRC.indexOf("u.pathname === '/api/cskday'"); assert.ok(auth > 0 && route > auth, 'after the key check');
  const rt = SRC.slice(route, SRC.indexOf('\n', route)); assert.ok(/req\.method === 'POST'/.test(SRC.slice(route - 40, route + 40)) && /on !== '1' && on !== '0'/.test(rt) && /P\.rec\.cskOff = on === '0'/.test(rt) && /saveRec\(\)/.test(rt) && /503/.test(rt));
  assert.ok(/cd: \{ on: !r\.cskOff, master: CSK_ON \}/.test(SRC), 'page data');
});
t('page: the CSK button, its tap (POST /api/cskday?on=) and repaint after every data load; wording says new entries only, resets tomorrow', () => {
  assert.ok(/id="cskDay"/.test(HTML) && /\/api\/cskday\?on=/.test(HTML) && /Web\.cskDayPaint\(\)/.test(HTML) && /\$\('cskDay'\)\.addEventListener\('click'/.test(HTML));
  assert.ok(/CSK OFF today · no new entries/.test(HTML) && /Every new trading day starts OFF/.test(HTML));
});
(async () => { for (const [n, f] of tests) { try { await f(); pass++; console.log('ok   ' + n); } catch (e) { console.error('FAIL ' + n + '\n' + (e && e.stack || e)); process.exitCode = 1; } } console.log(pass + '/' + tests.length + ' passed'); })();
