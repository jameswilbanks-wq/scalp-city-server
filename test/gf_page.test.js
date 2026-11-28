/* The gf page (/gf): a third deck, like the son's, on screen in Latin American Spanish. James 2026-11-28: "create a third site, same as the one for my son, but this time call it gf ... make all the script on the screen in spanish (latin american)". Runs the REAL request handler, routers and manual-book code pulled out of server.js with stubs (no server, network, broker or database), and reads public/deck.html. Behaviour under test: GF_KEY opens only /, /gf and /api/gf/*; the gf key and the son key never reach each other's page; a GF_KEY equal to ADMIN_KEY or SON_KEY is ignored; gf trades go to r.gfk only, with their own stop flag and guardrail settings, partial close works, nothing lands in James's or the son's book or signal list; the tick manages the gf book (stops and end-of-day sell); the gf page calls only /api/gf/ routes; server refusal messages have a Spanish translation. Related: son_access.test.js, son_book.test.js, deck_page.test.js. Run: node test/gf_page.test.js */
'use strict';
const assert = require('assert'), fs = require('fs'), path = require('path');
const SRC = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8'), HTML = fs.readFileSync(path.join(__dirname, '..', 'public', 'deck.html'), 'utf8');
let pass = 0; const tests = []; const t = (n, f) => tests.push([n, f]);
function fn(name) { let i = SRC.indexOf('async function ' + name + '('); if (i < 0) i = SRC.indexOf('function ' + name + '('); assert.ok(i >= 0, 'missing ' + name); let d = 0; for (let k = SRC.indexOf('{', i); k < SRC.length; k++) { if (SRC[k] === '{') d++; else if (SRC[k] === '}') { d--; if (d === 0) return SRC.slice(i, k + 1); } } throw new Error('unbalanced ' + name); }
const line = start => { const i = SRC.indexOf(start); assert.ok(i >= 0, 'missing ' + start); return SRC.slice(i, SRC.indexOf('\n', i)); };
const h0 = SRC.indexOf('const server = http.createServer('), HANDLER = SRC.slice(h0, SRC.indexOf('\n});', h0) + 4);

function web(ADMIN_KEY, SON_KEY, GF_KEY) {
  const touched = [], seen = [], keys = new Function('ADMIN_KEY', 'SON_KEY', 'process', [line('const authed'), line('const sonAuthed'), line('const GF_KEY'), line('const gfAuthed')].join('\n') + '\nreturn { authed, sonAuthed, gfAuthed };')(ADMIN_KEY, SON_KEY, { env: { SON_KEY, GF_KEY } });
  const stub = name => (...a) => { touched.push(name); seen.push([name, a]); return Promise.resolve({ ok: true }); };
  const base = { http: { createServer: f => f }, ADMIN_KEY, SON_KEY, GF_KEY, authed: keys.authed, sonAuthed: keys.sonAuthed, gfAuthed: keys.gfAuthed, send: (res, code, body) => { res.out = { code, body }; return res.out; },
    S: { authUrl: '', connected: true, transport: {} }, P: { rec: { day: '2026-11-30', gfk: { open: [{ sym: 'SPY', t0: 1 }] }, sonk: { open: [{ sym: 'QQQ', t0: 2 }] } } }, CITY: 'CITY', CITY_GZ: '', DECK: 'DECKHTML', DECK_GZ: '', SON: 'SONHTML', SON_GZ: '', GF: 'GFHTML', GF_GZ: '', GUIDES: { son: 'GUIDE_EN', gf: 'GUIDE_ES' }, DASH: '', BT: {}, WATCH: null, CSK_ON: true, MAN: {}, HIST: {},
    SONCFG: { key: 'sonk', book: 'son', who: 'son', shut: 'sonShut', guest: true }, GFCFG: { key: 'gfk', book: 'gf', who: 'gf', shut: 'gfShut', guest: true }, MANCFG: { guest: false }, setImmediate: () => {} };
  const scope = new Proxy(base, { has: (o, k) => typeof k === 'string' && !(k in globalThis) && k !== 'arguments', get: (o, k) => k === Symbol.unscopables ? undefined : (k in o ? o[k] : stub(String(k))) });
  const make = code => new Function('scope', 'with (scope) { ' + code + ' }')(scope);
  const routes = make([fn('guestRoute'), fn('sonRoute'), fn('gfRoute')].join('\n') + '\nreturn { sonRoute, gfRoute };'); base.sonRoute = routes.sonRoute; base.gfRoute = routes.gfRoute;
  const handler = make(HANDLER + '\nreturn server;');
  return async (method, url, key) => { const sep = url.indexOf('?') < 0 ? '?' : '&', res = { out: null, writeHead(c, h) { this.out = { code: c, headers: h }; }, end(b) { this.out = Object.assign(this.out || {}, { body: b }); } };
    touched.length = 0; seen.length = 0; await handler({ method, url: url + (key === undefined ? '' : sep + 'key=' + key), headers: {} }, res); return { code: res.out && res.out.code, body: res.out && res.out.body, headers: res.out && res.out.headers, touched: touched.slice(), seen: seen.slice() }; };
}

t('the gf key: / redirects to /gf; the gf routes reach only the gf book', async () => {
  const go = web('A', 'S', 'G'); const a = await go('GET', '/', 'G'); assert.deepStrictEqual([a.code, a.headers.location], [302, '/gf?key=G']);
  const b = await go('GET', '/gf', 'G'); assert.deepStrictEqual([b.code, b.body], [200, 'GFHTML']);
  const s = await go('GET', '/api/gf/state', 'G'); assert.strictEqual(s.seen[0][0], 'deckOut'); assert.strictEqual(s.seen[0][1][0].key, 'gfk');
  const e = await go('POST', '/api/gf/enter?sym=SPY&side=call&qty=1', 'G'); assert.strictEqual(e.seen[0][0], 'manualEnterB'); assert.strictEqual(e.seen[0][1][0].key, 'gfk');
  const c = await go('POST', '/api/gf/closeall', 'G'); assert.deepStrictEqual(c.seen.map(x => [x[0], x[1][0], x[1][1]]), [['manualCloseBook', 'gf', 'SPY']], 'closes only gf positions');
  const st = await go('POST', '/api/gf/stopday', 'G'); assert.deepStrictEqual(st.seen.filter(x => x[0] === 'manualCloseBook').map(x => x[1][0]), ['gf']);
});
t('the gf and son keys never reach each other or James; wrong or missing keys get 401', async () => {
  const go = web('A', 'S', 'G');
  for (const p of ['/son', '/api/son/state', '/api/son/enter?sym=SPY&side=call&qty=1', '/api/deck', '/city', '/api/ondemand?sym=SPY&side=call&qty=1', '/api/stopday', '/api/closebook?book=son&sym=QQQ&t0=2', '/api/manguard?on=0', '/api/real', '/api/status']) for (const m of ['GET', 'POST']) { const r = await go(m, p, 'G'); assert.notStrictEqual(r.code, 200, 'gf key on ' + p); assert.deepStrictEqual(r.touched, [], 'gf key touched ' + r.touched + ' via ' + p); }
  for (const p of ['/gf', '/api/gf/state', '/api/gf/enter?sym=SPY&side=call&qty=1', '/api/gf/stopday']) for (const m of ['GET', 'POST']) { const r = await go(m, p, 'S'); assert.notStrictEqual(r.code, 200, 'son key on ' + p); assert.deepStrictEqual(r.touched, []); }
  for (const key of [undefined, '', 'X', 'g']) for (const p of ['/gf', '/api/gf/state', '/api/gf/enter?sym=SPY&side=call&qty=1']) { const r = await go('POST', p, key); assert.strictEqual(r.code, 401); assert.deepStrictEqual(r.touched, []); }
  const adm = await go('GET', '/gf', 'A'); assert.deepStrictEqual([adm.code, adm.body], [200, 'GFHTML'], 'James can look at it');
  const g = await go('GET', '/api/gf/enter?sym=SPY&side=call&qty=1', 'G'); assert.notStrictEqual(g.code, 200, 'writes are POST only'); assert.deepStrictEqual(g.touched, []);
});
t('a GF_KEY that repeats the son or admin key, or is empty, is ignored', async () => {
  const dupSon = web('A', 'S', 'S'); const a = await dupSon('GET', '/', 'S'); assert.strictEqual(a.headers.location, '/son?key=S'); assert.strictEqual((await dupSon('GET', '/gf', 'S')).code === 200, false);
  const dupAdm = web('A', 'S', 'A'); const b = await dupAdm('GET', '/', 'A'); assert.deepStrictEqual([b.code, b.body], [200, 'DECKHTML']);
  const none = web('A', 'S', ''); assert.strictEqual((await none('GET', '/gf', '')).code, 401);
  assert.ok(!/console\.log\([^)]*GF_KEY|slog\([^)]*GF_KEY|send\([^)]*GF_KEY/.test(SRC), 'the key is never logged or returned');
});

const CODE = [line('const MAN_ON'), line('const MANCFG'), ...['corrGroupOpenRiskUSD', 'cskReservedUSD', 'manGuardOn', 'cleanGuard', 'guardCfg', 'corrCapBlocks', 'manualEnter', 'manualEnterB', 'manualEnterSon', 'manualEnterGf', 'manageMan', 'manageManB', 'manageSon', 'manageGf', 'manualCloseBook'].map(fn), "const MANUAL_BOOKS = { man: ['mank', manageMan], son: ['sonk', manageSon], gf: ['gfk', manageGf] };"].join('\n');
function book() {
  const env = { bid: 2.0, ask: 2.1, min: 700 }, sig = [], P = { busy: false, info: { SPY: { bar: { c: 710, t: Date.now() - 30000 } } }, rec: { shut: '', csk: { done: {}, open: [] }, x9k: { open: [] }, orbk: { open: [] } } };
  const pick = async (sym, dir) => ({ qAge: 1, inst: 'o-' + sym, strike: 710, exp: '2026-11-30', type: dir > 0 ? 'call' : 'put', ask: env.ask, bid: env.bid });
  const rh = async (n, a) => ({ results: a.instrument_ids.map(i => ({ quote: { instrument_id: i, bid_price: String(env.bid), ask_price: String(env.ask), updated_at: new Date().toISOString() } })) });
  const names = ['P', 'CFG', 'marketOpen', 'nowET', 'pickContract', 'logSignal', 'saveRec', 'rh', 'iso', 'CORR_GROUPS', 'CORR_CAP_USD', 'CSK_ON', 'CSK', 'CSK2', 'pBars'];
  const args = [P, { syms: ['SPY', 'QQQ'] }, () => true, () => ({ min: env.min, day: '2026-11-30' }), pick, (...a) => sig.push(a), () => {}, rh, d => new Date(d).toISOString(), ['SPY', 'QQQ'], 1200, false, { syms: [], width: 2, min: 660 }, { on: true, min: 750 }, async () => []];
  return Object.assign({ P, env, sig }, new Function(...names, CODE + '\nreturn { manualEnter, manualEnterSon, manualEnterGf, manageGf, manageSon, manualCloseBook, guardCfg, MANCFG, SONCFG, GFCFG };')(...args));
}
t('gf trades live in r.gfk only, with their own stop flag, guardrails, partial close and end-of-day sell', async () => {
  const w = book(); assert.strictEqual((await w.manualEnterGf('SPY', 'call', 3)).ok, true);
  assert.deepStrictEqual([w.P.rec.gfk.open.length, w.P.rec.gfk.open[0].book, !w.P.rec.mank, !w.P.rec.sonk, w.sig.length], [1, 'gf', true, true, 0]);
  w.P.rec.shut = 'x'; w.P.rec.sonShut = 'x'; assert.strictEqual((await w.manualEnterGf('SPY', 'put', 1)).ok, true, 'other stop flags never block gf');
  w.P.rec.gfShut = 'stopped by you'; assert.strictEqual((await w.manualEnterGf('SPY', 'put', 1)).ok, false); w.P.rec.sonShut = ''; assert.strictEqual((await w.manualEnterSon('SPY', 'call', 1)).ok, true, 'gf stop never blocks the son');
  w.P.gfG = { loss: 10 }; w.P.gfGuard = true; assert.strictEqual(w.guardCfg(w.GFCFG).loss, 10); assert.strictEqual(w.guardCfg(w.SONCFG).loss, 30); assert.strictEqual(w.guardCfg(w.MANCFG).loss, 30);
  const first = w.P.rec.gfk.open[0]; const r = await w.manualCloseBook('gf', 'SPY', first.t0, 1); assert.deepStrictEqual([r.partial, r.left], [true, 2]);
  w.env.bid = 1.8; await w.manageGf(); await w.manageSon(); assert.strictEqual(w.P.rec.gfk.open.length, 0, 'gf -10% stop sold both'); assert.strictEqual(w.P.rec.sonk.open.length, 1, 'son at -30% default stays');
  const x = book(); await x.manualEnterGf('SPY', 'call', 1); x.env.min = 959; await x.manageGf(); assert.deepStrictEqual([x.P.rec.gfk.open.length, x.P.rec.gfk.trades[0].reason], [0, 'time']);
});
t('server wiring: the tick manages the gf book, boot loads its guardrails, the heartbeat counts it, its page is served in es-419', () => {
  assert.ok(/try \{ await manageGf\(\); \} catch/.test(SRC), 'without this line a gf trade would have no stop and no end-of-day sell');
  assert.ok(SRC.includes("kget('gf_guard')") && SRC.includes("gfk: n('gfk')") && SRC.includes("wrapPage('deck.html', 'gf')") && SRC.includes("who === 'gf' ? 'es-419' : 'en'"));
});
t('the gf page calls only /api/gf/ routes, and every refusal the server can send has a Spanish translation', () => {
  const a = HTML.indexOf('if(GF)EP={'), ep = HTML.slice(a, HTML.indexOf('};', a)); assert.ok(a > 0);
  const urls = ep.match(/'\/api\/[^']*'/g); assert.strictEqual(urls.length, 8); /* 8th: the order-flow chart, 2026-11-28 */ urls.forEach(u => assert.ok(u.startsWith("'/api/gf/"), u));
  const i = HTML.indexOf('var SRV=['), SRV = new Function('return ' + HTML.slice(i + 8, HTML.indexOf('\n  ];', i) + 4))();
  const es = m => { const hit = SRV.find(p => p[0].test(m)); assert.ok(hit, 'no Spanish for: ' + m); return m.replace(hit[0], hit[1]); };
  for (const m of ['on-demand orders are switched off (MAN_ON=0)', 'the journal is not loaded yet', 'trading is stopped for today (stopped by you)', 'symbol must be one of SPY, QQQ', 'side must be call or put', 'quantity must be 1 to 3', 'market is closed', 'on-demand entries run 9:30 to 16:00 ET', '3 on-demand positions are already open; close one first', 'another on-demand order is being placed, try again in a moment', 'could not load a AAPL price (x)', 'no fresh SPY price yet (older than 5 minutes)', 'could not load option data (error)', 'no expiry available', 'no strikes near the price', 'option quotes are stale', 'no live quotes', 'the trading day changed or stopped while the order was being placed', 'bad symbol', 'that position is not open (it may have just closed)', 'unknown book', 'Queued: the server is busy; it closes on the next price.', 'Queued: no fresh price yet; it closes on the next price.', 'no journal yet', 'not stopped', 'out of range or invalid: loss (loss 5-90, gain 10-1000, trail 5-60, mode trail or close)', 'on must be 1 or 0', 'Bad reply from the server (502)']) assert.notStrictEqual(es(m), m, m);
  assert.strictEqual(es('nothing near the money under $400 with a tight spread (cheapest ask $512)'), 'no hay ningún contrato cercano al precio por menos de $400 con poca diferencia entre compra y venta (el más barato cuesta $512)', 'dollar amounts survive the translation');
  assert.strictEqual(es('3x SPY call 712 costs $1500, over the $1200 per-order limit; try fewer contracts'), '3x SPY call 712 cuesta $1500, más que el límite de $1200 por orden; prueba con menos contratos');
});
t('the guides: each guest key opens only its own guide; the header button shows on the guest pages only; the files are plain pages with no personal details', async () => {
  const go = web('A', 'S', 'G');
  const a = await go('GET', '/son/guide', 'S'), b = await go('GET', '/gf/guide', 'G'); assert.deepStrictEqual([a.code, a.body, b.code, b.body], [200, 'GUIDE_EN', 200, 'GUIDE_ES']);
  for (const [p, k] of [['/gf/guide', 'S'], ['/son/guide', 'G'], ['/gf/guide', 'X'], ['/son/guide', undefined]]) { const r = await go('GET', p, k); assert.notStrictEqual(r.code, 200, p + ' with ' + k); assert.deepStrictEqual(r.touched, []); }
  assert.strictEqual((await go('GET', '/gf/guide', 'A')).body, 'GUIDE_ES');
  assert.ok(SRC.includes("{ son: readGuide('guide_en.html'), gf: readGuide('guide_es.html') }"));
  assert.ok(/id="guide"[^>]*target="_blank"[^>]*display:none/.test(HTML), 'hidden by default'); assert.ok(HTML.includes("if(GUEST){var gd=$('guide')") && HTML.includes("gd.href=url('/'+(GF?'gf':'son')+'/guide')"));
  const en = fs.readFileSync(path.join(__dirname, '..', 'public', 'guide_en.html'), 'utf8'), es = fs.readFileSync(path.join(__dirname, '..', 'public', 'guide_es.html'), 'utf8');
  for (const h of ['Read this first', 'Your first practice trade', 'Guardrails', 'Signals', 'Support and resistance', 'If something does not work']) assert.ok(en.includes('<h2>' + h), h);
  for (const h of ['Lee esto primero', 'Tu primera operación', 'Las protecciones', 'Las señales', 'Soporte y resistencia', 'Si algo no funciona']) assert.ok(es.includes('<h2>' + h), h);
  assert.ok(es.includes('cuánto aceptas perder') && es.includes('¿Cuántos de 3 quieres vender?') && en.includes('Find the levels.'), 'later corrections carried over');
  for (const g of [en, es]) {
    const pics = g.match(/<image id="[a-z]+" href="[^"]*"/g) || []; assert.strictEqual(pics.length, 9, 'nine pictures'); assert.strictEqual((g.match(/<image /g) || []).length, 9); assert.ok(pics.every(x => /^<image id="[a-z]+" href="data:image\/jpeg;base64,[A-Za-z0-9+\/=]+"$/.test(x)), 'pictures are embedded, never loaded from elsewhere'); assert.ok((g.match(/<use href="[^"]*"/g) || []).every(x => /^<use href="#[a-z]+"$/.test(x)), 'picture slices point inside the page');
    const figs = g.match(/<figure class="fig">[\s\S]*?<\/figure>/g) || []; assert.strictEqual(figs.length, 9);
    for (const f of figs) { assert.ok(/role="img" aria-label="[^"]+"/.test(f), 'picture has a text label'); assert.ok(/made-up numbers|números inventados/.test(f), 'labelled as an example'); assert.strictEqual((f.match(/<circle /g) || []).length, (f.match(/<li>/g) || []).length, 'one key line per arrow'); }
    assert.ok(!/@|wilbanks|james|<\?claude|\*\*|\| ---|src=|https?:/i.test(g.replace(/data:image\/jpeg;base64,[A-Za-z0-9+\/=]+/g, 'PIC').replace(/<style>[\s\S]*?<\/style>/, '')), 'no personal details, leftover markup or outside links');
  }
});
(async () => { for (const [n, f] of tests) { try { await f(); pass++; console.log('ok   ' + n); } catch (e) { console.log('FAIL ' + n + '\n' + (e && e.stack || e)); } } console.log(pass + '/' + tests.length + ' passed'); process.exit(pass === tests.length ? 0 : 1); })();
