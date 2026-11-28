/* Son's manual book + shared guardrail features (server.js: MANCFG/SONCFG, manualEnterB, manageManB, guardCfg/cleanGuard, partial close in manualCloseBook, sonRoute/sonAuthed, deckOut, histOut; signals.js: levels). James 2026-11-27: "one shared paper account ... keep all his stats separate ... not a separate server just a new page on mine"; "close 1 contract when you have more than 1"; "guardrails on/off with the ability to change the %".
   Behaviour under test: the son's entries go to r.sonk only (never r.mank), his stop flag is his own (James's r.shut never blocks him and his r.sonShut never blocks James), his orders write nothing to James's signal list and do not count in James's correlation cap, his guard settings are his own; partial close sells n of N contracts at the bid, journals one row, keeps peak and the armed trail; guardrail percentages are bounded by the server; close-at-gain mode sells at +gain; the son's key reaches only the son routes and a key equal to ADMIN_KEY is ignored; scoreOf and the days list never count sonk; CSK starts OFF on a new day record; levels are plain reference prices. Mock quotes and clock, no network, no orders, no keys. Run: node test/son_book.test.js */
'use strict';
const assert = require('assert'), fs = require('fs'), path = require('path');
const SRC = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8'), SIG = require('../signals.js');
let pass = 0; const tests = []; const t = (n, f) => tests.push([n, f]);
function fn(name) { let i = SRC.indexOf('async function ' + name + '('); if (i < 0) i = SRC.indexOf('function ' + name + '('); assert.ok(i >= 0, 'missing ' + name); let d = 0; for (let k = SRC.indexOf('{', i); k < SRC.length; k++) { if (SRC[k] === '{') d++; else if (SRC[k] === '}') { d--; if (d === 0) return SRC.slice(i, k + 1); } } throw new Error('unbalanced ' + name); }
const line = start => { const i = SRC.indexOf(start); assert.ok(i >= 0, 'missing ' + start); return SRC.slice(i, SRC.indexOf('\n', i)); };
const CODE = [line('const MAN_ON'), line('const MANCFG'), ...['corrGroupOpenRiskUSD', 'cskReservedUSD', 'manGuardOn', 'cleanGuard', 'guardCfg', 'corrCapBlocks', 'manualEnter', 'manualEnterB', 'manualEnterSon', 'manageMan', 'manageManB', 'manageSon', 'manualCloseBook'].map(fn), "const MANUAL_BOOKS = { man: ['mank', manageMan], son: ['sonk', manageSon] };"].join('\n');
const NAMES = ['P', 'CFG', 'marketOpen', 'nowET', 'pickContract', 'logSignal', 'saveRec', 'rh', 'iso', 'CORR_GROUPS', 'CORR_CAP_USD', 'CSK_ON', 'CSK', 'CSK2', 'pBars'];
function build(o) {
  o = o || {}; const calls = { sig: [], pick: 0 }, env = { open: true, min: 700, bid: 2.0, ask: 2.1, stale: false };
  const P = { busy: false, info: { SPY: { bar: { c: 710, t: Date.now() - 30000 } }, QQQ: { bar: { c: 640, t: Date.now() - 30000 } } }, rec: { shut: '', csk: { done: {}, open: [] }, x9k: { open: o.x9 || [] }, orbk: { open: [] } } };
  const pickContract = async (sym, dir) => { calls.pick++; return { qAge: 1000, inst: 'opt-' + sym, strike: 710, exp: '2026-11-27', type: dir > 0 ? 'call' : 'put', ask: env.ask, bid: env.bid, iv: 0.2, delta: dir * 0.5 }; };
  const rh = async (n, a) => ({ results: a.instrument_ids.map(i => ({ quote: { instrument_id: i, bid_price: String(env.bid), ask_price: String(env.ask), updated_at: new Date(Date.now() - (env.stale ? 600000 : 1000)).toISOString() } })) });
  const stubs = [P, { syms: ['SPY', 'QQQ'] }, () => env.open, () => ({ min: env.min, day: '2026-11-27' }), pickContract, (...a) => { calls.sig.push(a); }, () => {}, rh, d => new Date(d).toISOString(), ['SPY', 'QQQ'], o.cap === undefined ? 1200 : o.cap, false, { syms: ['SPY', 'QQQ'], width: 2, min: 660 }, { on: true, min: 750 }, async () => [{ t: Date.now() - 30000, c: 200 }]];
  const api = new Function(...NAMES, CODE + '\nreturn { manualEnter, manualEnterSon, manageMan, manageSon, manualCloseBook, guardCfg, cleanGuard, MAN, MANCFG, SONCFG };')(...stubs);
  return Object.assign({ P, env, calls }, api);
}

t('the son enters into r.sonk only: r.mank stays empty, the position is tagged book son, James\'s signal list is untouched', async () => {
  const w = build(), r = await w.manualEnterSon('SPY', 'call', 2); assert.deepStrictEqual([r.ok, r.qty], [true, 2]);
  assert.strictEqual(w.P.rec.sonk.open.length, 1); assert.strictEqual(w.P.rec.sonk.open[0].book, 'son'); assert.ok(!w.P.rec.mank, 'James\'s book not created'); assert.strictEqual(w.calls.sig.length, 0, 'no logSignal for the son'); assert.strictEqual(w.P.sonBusy, false); assert.ok(w.P.manBusy === undefined || w.P.manBusy === false);
  const j = await w.manualEnter('QQQ', 'put', 1); assert.strictEqual(j.ok, true); assert.strictEqual(w.P.rec.mank.open.length, 1); assert.strictEqual(w.P.rec.sonk.open.length, 1, 'James\'s order did not touch his'); assert.strictEqual(w.calls.sig.length, 1, 'James still logs signals');
});
t('stop flags are separate: James\'s r.shut never blocks the son; the son\'s r.sonShut never blocks James', async () => {
  const w = build(); w.P.rec.shut = 'stopped by you'; assert.strictEqual((await w.manualEnterSon('SPY', 'call', 1)).ok, true); assert.strictEqual((await w.manualEnter('SPY', 'call', 1)).ok, false);
  const v = build(); v.P.rec.sonShut = 'stopped by you'; const s = await v.manualEnterSon('SPY', 'call', 1); assert.strictEqual(s.ok, false); assert.ok(/stopped/.test(s.error)); assert.strictEqual((await v.manualEnter('SPY', 'call', 1)).ok, true);
});
t('the son has the same entry rules (symbols, qty 1-3, 3 open) but his orders are outside James\'s correlation cap, and his positions do not count in it', async () => {
  const w = build({ cap: 100 }); assert.strictEqual((await w.manualEnter('SPY', 'call', 1)).ok, false, 'James is capped at $100'); assert.strictEqual((await w.manualEnterSon('SPY', 'call', 3)).ok, true, 'the son is not');
  assert.strictEqual((await w.manualEnterSon('ZZZ', 'call', 1)).ok, false); assert.strictEqual((await w.manualEnterSon('SPY', 'call', 4)).ok, false);
  const x = build(); for (let i = 0; i < 3; i++) assert.strictEqual((await x.manualEnterSon('QQQ', 'call', 1)).ok, true); assert.ok(/already open/.test((await x.manualEnterSon('QQQ', 'call', 1)).error));
  const cap = new Function('CORR_GROUPS', fn('corrGroupOpenRiskUSD') + '\nreturn corrGroupOpenRiskUSD;')(['SPY', 'QQQ']); assert.strictEqual(cap({ sonk: { open: [{ sym: 'SPY', entryAsk: 5, qty: 3 }] } }), 0, 'sonk is not in the cap sum');
});
t('guard settings are separate and bounded: defaults 30/100/25 trail; clean ranges loss 5-90, gain 10-1000, trail 5-60; bad values are dropped', () => {
  const w = build(); assert.deepStrictEqual(w.guardCfg(w.MANCFG), { on: true, loss: 30, gain: 100, trail: 25, mode: 'trail' }); w.P.sonG = { loss: 20, mode: 'close' }; w.P.sonGuard = false; assert.deepStrictEqual(w.guardCfg(w.SONCFG), { on: false, loss: 20, gain: 100, trail: 25, mode: 'close' }); assert.strictEqual(w.guardCfg(w.MANCFG).loss, 30, 'James\'s unchanged');
  assert.deepStrictEqual(w.cleanGuard({ loss: '4', gain: '9', trail: '61' }), {}); assert.deepStrictEqual(w.cleanGuard({ loss: '5', gain: '1000', trail: '60', mode: 'close' }), { loss: 5, gain: 1000, trail: 60, mode: 'close' }); assert.deepStrictEqual(w.cleanGuard({ loss: 'abc', mode: 'x', gain: '' }), {}, 'non-numeric and unknown mode dropped');
});
t('the son\'s own guard: a custom -20% stop sells at the bid (reason guard stop); James\'s default is unaffected; OFF means no guard sell', async () => {
  const w = build(); await w.manualEnterSon('SPY', 'call', 1); await w.manualEnter('SPY', 'call', 1); w.P.sonG = { loss: 20 }; w.env.bid = 1.6; await w.manageSon(); await w.manageMan();
  assert.deepStrictEqual([w.P.rec.sonk.open.length, w.P.rec.sonk.trades[0].reason, w.P.rec.sonk.trades[0].pnl], [0, 'guard stop', -50], '(1.60-2.10) x 100 = -50, down 23.8% vs the -20% setting'); assert.strictEqual(w.P.rec.mank.open.length, 1, 'James at -30%: stays');
  const v = build(); await v.manualEnterSon('SPY', 'call', 1); v.P.sonGuard = false; v.env.bid = 0.2; await v.manageSon(); assert.strictEqual(v.P.rec.sonk.open.length, 1);
});
t('close-at-gain mode: at +100% the position is sold at the bid (reason guard target), no trailing arm; the default mode still only arms a trail', async () => {
  const w = build(); await w.manualEnterSon('SPY', 'call', 2); w.P.sonG = { mode: 'close' }; w.env.bid = 4.2; await w.manageSon(); const tr = w.P.rec.sonk.trades[0]; assert.deepStrictEqual([w.P.rec.sonk.open.length, tr.reason, tr.pnl, tr.trailArmT], [0, 'guard target', 420, null]);
  const v = build(); await v.manualEnterSon('SPY', 'call', 1); v.env.bid = 4.2; await v.manageSon(); assert.deepStrictEqual([v.P.rec.sonk.open.length, !!v.P.rec.sonk.open[0].trailAt], [1, true], 'default: armed, not sold');
  const x = build(); await x.manualEnter('QQQ', 'put', 1); x.P.manG = { gain: 50 }; x.env.bid = 3.2; await x.manageMan(); assert.strictEqual(x.P.rec.mank.open[0].trailAt > 0, true, 'James custom +50% arms at 3.15');
});
t('partial close: selling 1 of 3 books one row at the bid (reason manual partial, qty 1, P&L x1), leaves 2 open with peak and the armed trail kept; a second partial and then a full close work', async () => {
  const w = build(); await w.manualEnterSon('SPY', 'call', 3); const p = w.P.rec.sonk.open[0], t0 = p.t0; w.env.bid = 4.2; await w.manageSon(); assert.ok(p.trailAt > 0); w.env.bid = 5.0; await w.manageSon(); const peak = p.peak;
  const r = await w.manualCloseBook('son', 'SPY', t0, 1); assert.deepStrictEqual([r.ok, r.closed, r.partial, r.sold, r.left], [true, false, true, 1, 2]); const tr = w.P.rec.sonk.trades; assert.deepStrictEqual([tr.length, tr[0].qty, tr[0].reason, tr[0].pnl], [1, 1, 'manual partial', 290], '(5.00-2.10) x 100 x 1');
  assert.deepStrictEqual([p.qty, p.peak, p.trailAt > 0, !!p.sellQty, w.P.rec.sonk.open.length], [2, peak, true, false, 1]); assert.strictEqual(w.P.rec.sonk.pnl, 290);
  const r2 = await w.manualCloseBook('son', 'SPY', t0, 1); assert.deepStrictEqual([r2.partial, r2.left], [true, 1]); const r3 = await w.manualCloseBook('son', 'SPY', t0, 1); assert.deepStrictEqual([r3.closed, r3.reason], [true, 'manual'], 'n >= qty closes the whole position'); assert.strictEqual(w.P.rec.sonk.open.length, 0); assert.strictEqual(w.P.rec.sonk.trades.length, 3);
  assert.strictEqual(w.P.rec.sonk.pnl, 290 * 3, 'three rows at 5.00'); assert.strictEqual(w.P.busy, false);
});
t('partial close also works on James\'s book (book man) even on a stale quote; n of 0 or n >= qty means close all; only the two manual books support it', async () => {
  const w = build(); await w.manualEnter('SPY', 'call', 2); const t0 = w.P.rec.mank.open[0].t0; w.env.stale = true; w.env.bid = 2.6; const r = await w.manualCloseBook('man', 'SPY', t0, 1); assert.deepStrictEqual([r.partial, r.left, r.pnl], [true, 1, 50]);
  const x = build(); await x.manualEnter('SPY', 'call', 2); const r2 = await x.manualCloseBook('man', 'SPY', x.P.rec.mank.open[0].t0, 5); assert.strictEqual(r2.closed, true); const y = build(); await y.manualEnter('SPY', 'call', 2); const r3 = await y.manualCloseBook('man', 'SPY', y.P.rec.mank.open[0].t0, 0); assert.strictEqual(r3.closed, true);
  assert.ok(/\(book === 'man' \|\| book === 'son' \|\| book === 'gf'\) && n >= 1/.test(fn('manualCloseBook')), 'partial is for the two manual books only');
});
t('son access: the key is compared only, reaches only sonRoute, is ignored when equal to ADMIN_KEY, "/" sends him to /son, James-key routes sit after the admin check', () => {
  assert.ok(/const SON_KEY = process\.env\.SON_KEY \|\| ''/.test(SRC)); const sa = line('const sonAuthed'); assert.ok(/SON_KEY !== ADMIN_KEY/.test(sa) && /!!SON_KEY/.test(sa));
  const h = SRC.slice(SRC.indexOf('const server = http.createServer'), SRC.indexOf('const DASH = '));
  const iSon = h.indexOf('if (sonAuthed(u, req))'), iAdm = h.indexOf('if (!authed(u, req))'); assert.ok(iSon > 0 && iAdm > iSon); const sonLine = h.slice(iSon, h.indexOf('\n', iSon)); assert.ok(/return sonRoute\(u, req, res\)/.test(sonLine) && /location: '\/son\?key='/.test(sonLine));
  assert.ok(h.indexOf("u.pathname === '/api/deck'") > iAdm && h.indexOf("u.pathname.startsWith('/api/son/')") > iAdm, 'James key routes after the admin check');
  const sr = fn('guestRoute'); assert.ok(/function sonRoute\(u, req, res\) \{ return guestRoute\(SONCFG, SON, SON_GZ, u, req, res\); \}/.test(SRC), 'the son router serves only the son book'); assert.ok(!/closebook|\/api\/ondemand|manguard|cskday|\/api\/control|\/api\/real|\/api\/stopday|\/api\/close'/.test(sr), 'the son routes expose no James or real-money route');
  assert.ok(!/console\.log\([^)]*SON_KEY|slog\([^)]*SON_KEY|send\([^)]*SON_KEY/.test(SRC), 'the key is never logged or returned');
  for (const p of ['enter', 'close', 'closeall', 'guard', 'stopday', 'resume']) assert.ok(sr.includes("p === '" + p + "'"), p); assert.ok(sr.indexOf('if (!post)') > 0 && sr.indexOf('if (!post)') < sr.indexOf("p === 'enter'"), 'every write is POST only'); assert.ok(sr.includes("const base = '/api/' + cfg.who + '/'") && sr.includes('if (!u.pathname.startsWith(base)) return send(res, 404'), 'a guest router answers only its own prefix');
});
t('the son\'s numbers stay out of James\'s: scoreOf, the days list and recOut never read sonk; the manual-book core sends nothing to a broker', () => {
  assert.ok(!/gfk/.test(fn('scoreOf')) && !/gfk/.test(fn('recOut')) && !/gfk/.test(SRC.slice(SRC.indexOf('async function cityData'), SRC.indexOf('const authed = '))), 'no gfk in scoreOf, recOut or cityData'); assert.ok(!/sonk/.test(fn('scoreOf')) && !/sonk/.test(fn('recOut')) && !/sonk/.test(SRC.slice(SRC.indexOf('async function cityData'), SRC.indexOf('const authed = '))), 'no sonk in scoreOf, recOut or cityData');
  const blk = SRC.slice(SRC.indexOf('async function manualEnterB('), SRC.indexOf('const MANUAL_BOOKS')).replace(/\/\*[\s\S]*?\*\//g, ''); assert.ok(!/apTrade|place_option_order|place_equity_order|fetch\(|\/v2\/orders|https?:\/\//.test(blk), 'no order or network call in the manual-book core');
  const deck = fn('deckOut'); assert.ok(/cfg\.guest/.test(deck) && /if \(!cfg\.guest\)/.test(deck), 'son payload has no CSK switch and no other-books list');
});
t('histOut reads one book key only and averages over the days that book traded; the history never mixes books', async () => {
  const kscan = async () => [{ key: 'rec:2026-11-26', value: { day: '2026-11-26', mank: { trades: [{ exitT: 'x', pnl: 100 }] }, sonk: { trades: [{ exitT: 'x', pnl: -20 }, { exitT: 'x', pnl: 10 }] } } }, { key: 'rec:2026-11-27', value: { day: '2026-11-27', sonk: { trades: [{ exitT: 'x', pnl: 30 }] } } }];
  const f = new Function('kscan', 'HIST', fn('histOut') + '\nreturn histOut;')(kscan, {}), son = await f('sonk'), man = await f('mank'); assert.deepStrictEqual([son.nDays, son.total, son.avgPerDay], [2, 20, 10]); assert.deepStrictEqual([man.nDays, man.total], [1, 100]);
});
t('CSK starts OFF on every new day record (James 2026-11-27); the existing per-day switch still controls it', () => {
  const nr = new Function(fn('newRec') + '\nreturn newRec;')()('2026-11-30'); assert.strictEqual(nr.cskOff, true); assert.ok(/cd: \{ on: !r\.cskOff, master: CSK_ON \}/.test(SRC) && /out\.cd = \{ on: !\(r && r\.cskOff\), master: CSK_ON \}/.test(SRC));
});
t('levels: prior-day, day and opening-range reference prices from the bars; OR only after 10:00; prior day only when the window holds it; nothing on thin data', () => {
  const mk = (day, min, o, h, l, c, v) => ({ day, min, t: Date.parse(day + 'T14:00:00Z') + min * 60000, o, h, l, c, v: v || 100 });
  const bars = [mk('2026-11-25', 570, 100, 101, 99, 100.5), mk('2026-11-25', 900, 100.5, 103, 98, 102), mk('2026-11-26', 570, 102, 104, 101, 103), mk('2026-11-26', 599, 103, 105, 102, 104), mk('2026-11-26', 610, 104, 106, 103, 105)];
  const lv = SIG.levels(bars); assert.deepStrictEqual([lv.px, lv.dh, lv.dl, lv.orh, lv.orl, lv.pdh, lv.pdl, lv.pdc], [105, 106, 101, 105, 101, 103, 98, 102]); assert.ok(lv.vwap > 100 && lv.vwap < 106);
  const early = SIG.levels([bars[2], bars[3]]); assert.deepStrictEqual([early.orh, early.orl, early.pdh], [null, null, null], 'no OR before 10:00, no prior day in the window'); assert.strictEqual(SIG.levels([]), null); assert.strictEqual(SIG.levels([bars[0]]), null);
  assert.ok(!/\brh\(|place_|alpaca/i.test(fn('sigTick')), 'levels are computed inside the existing display-only loop');
});
(async () => { for (const [n, f] of tests) { try { await f(); pass++; console.log('ok   ' + n); } catch (e) { console.log('FAIL ' + n + '\n' + (e && e.stack || e)); } } console.log(pass + '/' + tests.length + ' passed'); process.exit(pass === tests.length ? 0 : 1); })();
