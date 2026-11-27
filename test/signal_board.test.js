/* Signal board wiring test (server.js sigTick / sigOut, cityData `sg`, the sgBox table in public/city.html). Behaviour under test: every 60 s while the market is open and Robinhood is connected, the ten manual tickers are evaluated; each light change is journaled once in r.sgk (capped at 400) and saved; one failing ticker never stops the others and shows as stale; nothing runs when the market is closed or disconnected; the board never calls an order or quote function and is wired into the page data and the table. Mock bars and clock, no network. Related: test/signals.test.js (the engine itself). Run: node test/signal_board.test.js */
'use strict';
const assert = require('assert'), fs = require('fs'), path = require('path');
const SRC = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8'), HTML = fs.readFileSync(path.join(__dirname, '..', 'public', 'city.html'), 'utf8');
let pass = 0; const tests = []; const t = (n, f) => tests.push([n, f]);
function fn(name) { let i = SRC.indexOf('async function ' + name + '('); if (i < 0) i = SRC.indexOf('function ' + name + '('); assert.ok(i >= 0, 'missing ' + name); let d = 0; for (let k = SRC.indexOf('{', i); k < SRC.length; k++) { if (SRC[k] === '{') d++; else if (SRC[k] === '}') { d--; if (d === 0) return SRC.slice(i, k + 1); } } throw new Error('unbalanced ' + name); }
const SYMS = ['SPY', 'QQQ', 'AAPL', 'MSFT', 'GOOGL', 'AMZN', 'NVDA', 'META', 'TSLA', 'PLTR'];
function build() {
  const env = { open: true, res: {}, fail: {}, saves: 0, pulls: [] }, P = { rec: { day: '2026-11-27' } }, S = { connected: true };
  const SigEng = { NEED: 3, computeSignals: (bars, o) => { const sym = bars.sym; return env.res[sym] || { state: 'none', nBuy: 0, nSell: 0, nUse: 5, sigs: {}, px: 1, asOf: 1, stale: false, idx: !!o.index }; } };
  const pBars = async sym => { env.pulls.push(sym); if (env.fail[sym]) throw Object.assign(new Error('boom'), { code: 'rh_error' }); const b = []; b.sym = sym; return b; };
  const MAN = { syms: SYMS, idx: ['SPY', 'QQQ'] };
  const api = new Function('SigEng', 'P', 'S', 'marketOpen', 'MAN', 'pBars', 'saveRec', fn('sigTick') + '\n' + fn('sigOut') + '\nreturn { sigTick, sigOut };')(SigEng, P, S, () => env.open, MAN, pBars, () => { env.saves++; });
  return Object.assign({ P, S, env }, api);
}
const buy = { state: 'buy', nBuy: 3, nSell: 0, nUse: 5, sigs: { vwap: { v: 1 }, orb: { v: 1 }, rsi: { v: 0 }, ema: { v: 1 }, ihh: { v: null } }, px: 701.5, asOf: 5, stale: false };

t('one pass evaluates all ten manual tickers (index flag only for SPY/QQQ) and fills the board; the first sighting journals nothing', async () => {
  const w = build(); await w.sigTick(); assert.deepStrictEqual(w.env.pulls, SYMS); assert.deepStrictEqual(Object.keys(w.P.sg), SYMS); assert.ok(w.P.sgAt > 0); assert.strictEqual(w.P.rec.sgk, undefined); assert.strictEqual(w.env.saves, 0); assert.strictEqual(w.P.sgBusy, false);
  assert.deepStrictEqual(SYMS.map(s => w.P.sg[s].idx), [true, true, false, false, false, false, false, false, false, false], 'index-only signal is enabled for SPY and QQQ only');
  const o = w.sigOut(); assert.deepStrictEqual([o.need, o.syms, o.idx], [3, SYMS, ['SPY', 'QQQ']]); assert.strictEqual(Object.keys(o.rows).length, 10);
});
t('a light change is journaled once in r.sgk with from, to, counts, price and the five values, and the day row is saved; no change = no entry', async () => {
  const w = build(); await w.sigTick(); w.env.res.NVDA = buy; await w.sigTick();
  assert.strictEqual(w.P.rec.sgk.length, 1); const k = w.P.rec.sgk[0]; assert.deepStrictEqual([k.sym, k.from, k.to, k.nb, k.ns, k.px, k.v], ['NVDA', 'none', 'buy', 3, 0, 701.5, [1, 1, 0, 1, null]]); assert.ok(k.t > 0); assert.strictEqual(w.env.saves, 1);
  await w.sigTick(); assert.strictEqual(w.P.rec.sgk.length, 1, 'same state again: nothing new'); assert.strictEqual(w.env.saves, 1);
  w.env.res.NVDA = { state: 'none', nBuy: 2, nSell: 0, nUse: 5, sigs: { vwap: { v: 1 }, orb: { v: 1 }, rsi: { v: 0 }, ema: { v: 0 }, ihh: { v: null } }, px: 700, asOf: 6, stale: false }; await w.sigTick(); assert.deepStrictEqual([w.P.rec.sgk.length, w.P.rec.sgk[1].from, w.P.rec.sgk[1].to], [2, 'buy', 'none']);
});
t('the journal list is capped at 400 per day', async () => {
  const w = build(); await w.sigTick(); w.P.rec.sgk = Array.from({ length: 400 }, (_, i) => ({ t: i, sym: 'SPY', from: 'none', to: 'buy' })); w.env.res.SPY = buy; await w.sigTick(); assert.strictEqual(w.P.rec.sgk.length, 400); assert.strictEqual(w.P.rec.sgk[399].to, 'buy'); assert.strictEqual(w.P.rec.sgk[0].t, 1, 'oldest dropped');
});
t('one failing ticker shows as a dark, stale row with the reason and never stops the other nine; the next pass recovers it', async () => {
  const w = build(); w.env.fail.TSLA = true; w.env.res.AAPL = buy; await w.sigTick();
  assert.deepStrictEqual([w.P.sg.TSLA.state, w.P.sg.TSLA.stale], ['none', true]); assert.ok(/data error: rh_error/.test(w.P.sg.TSLA.why)); assert.strictEqual(w.P.sg.AAPL.state, 'buy'); assert.strictEqual(w.P.sg.PLTR.stale, false); assert.strictEqual(w.P.sgBusy, false);
  w.env.fail.TSLA = false; await w.sigTick(); assert.strictEqual(w.P.sg.TSLA.stale, false);
});
t('nothing runs when the market is closed, Robinhood is disconnected, the journal is not loaded, or a pass is already running', async () => {
  const w = build(); w.env.open = false; await w.sigTick(); assert.strictEqual(w.env.pulls.length, 0);
  const x = build(); x.S.connected = false; await x.sigTick(); assert.strictEqual(x.env.pulls.length, 0);
  const y = build(); y.P.rec = null; await y.sigTick(); assert.strictEqual(y.env.pulls.length, 0);
  const z = build(); z.P.sgBusy = true; await z.sigTick(); assert.strictEqual(z.env.pulls.length, 0);
});
t('wiring: cityData carries sg, a 60 s interval and a boot kick start the loop, the page shows the table and repaints it with every data load', () => {
  assert.ok(/sg: sigOut\(\)/.test(SRC)); assert.ok(/setInterval\(\(\) => \{ sigTick\(\); \}, 60000\)/.test(SRC)); assert.ok(/setTimeout\(\(\) => \{ sigTick\(\); \}, 15000\)/.test(SRC)); assert.ok(/require\('\.\/signals\.js'\)/.test(SRC));
  assert.ok(/id="sgBox"/.test(HTML) && /id="sgBody"/.test(HTML) && /sgPaint:function/.test(HTML) && /Web\.sgPaint\(\)/.test(HTML) && /\$\('sgBox'\)\.hidden=false/.test(HTML), 'table, painter, call and reveal');
  assert.ok(/class="odr"><b>SIGNALS<\/b>/.test(HTML) && /lights at 3 of 5/.test(HTML)); for (const h of ['VWAP', 'Opening range', 'RSI', 'EMA 9', 'First half hour']) assert.ok(HTML.includes(h), 'header tip ' + h);
  assert.ok(/tr\.sgbuy|sgbuy/.test(HTML) && /sgsell/.test(HTML), 'row lights');
});
t('source guard: the board code makes no broker, quote or order call, does not touch any other book, and sits in its own try/catch', () => {
  const code = fn('sigTick') + fn('sigOut'); assert.ok(!/\brh\(|place_|alpaca|manualEnter|closePaper|mank|orbk|csk|x9k|fpk|cdrk|r\.pos|P\.rec\.pos/i.test(code), 'no order path, no other book'); assert.ok(/try \{/.test(code) && /catch \(err\)/.test(code)); assert.ok(/pBars\(sym\)/.test(code), 'only the minute-bar reader');
});

(async () => { for (const [n, f] of tests) { try { await f(); pass++; console.log('ok   ' + n); } catch (e) { console.log('FAIL ' + n + '\n' + (e && e.stack || e)); } } console.log(pass + '/' + tests.length + ' passed'); process.exit(pass === tests.length ? 0 : 1); })();
