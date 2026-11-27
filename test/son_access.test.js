/* Access boundary of the son's page, run against the REAL request handler and the REAL sonRoute / authed / sonAuthed code pulled out of server.js (same extraction style as the other tests), with every dependency stubbed and recorded. James 2026-11-27: the son gets a page on the same server, "his will only have the option for paper account", his own stats. Behaviour under test: the son's key (SON_KEY) opens only / (redirect to /son), /son and /api/son/*; on every other route it reaches no stubbed function and returns a non-200; no key or a wrong key gets 401 everywhere except /health; James's key (ADMIN_KEY) opens everything including /son; a SON_KEY equal to ADMIN_KEY or empty gives the son nothing extra and never routes to sonRoute. No server is booted, no network, no broker, no database. Related: son_book.test.js (logic), deck_page.test.js (page). Run: node test/son_access.test.js */
'use strict';
const assert = require('assert'), fs = require('fs'), path = require('path');
const SRC = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
let pass = 0; const tests = []; const t = (n, f) => tests.push([n, f]);
function fn(name) { let i = SRC.indexOf('async function ' + name + '('); if (i < 0) i = SRC.indexOf('function ' + name + '('); assert.ok(i >= 0, 'missing ' + name); let d = 0; for (let k = SRC.indexOf('{', i); k < SRC.length; k++) { if (SRC[k] === '{') d++; else if (SRC[k] === '}') { d--; if (d === 0) return SRC.slice(i, k + 1); } } throw new Error('unbalanced ' + name); }
const line = start => { const i = SRC.indexOf(start); assert.ok(i >= 0, 'missing ' + start); return SRC.slice(i, SRC.indexOf('\n', i)); };
const h0 = SRC.indexOf('const server = http.createServer('), h1 = SRC.indexOf('\n});', h0) + 4; assert.ok(h0 > 0 && h1 > h0);
const HANDLER = SRC.slice(h0, h1), SONROUTE = fn('sonRoute');

function build(ADMIN_KEY, SON_KEY) {
  const touched = [], keys = new Function('ADMIN_KEY', 'SON_KEY', line('const authed') + '\n' + line('const sonAuthed') + '\nreturn { authed, sonAuthed };')(ADMIN_KEY, SON_KEY);
  const stub = name => (...a) => { touched.push(name); return Promise.resolve({ ok: true, stub: name }); };
  const base = {
    http: { createServer: f => f }, ADMIN_KEY, SON_KEY, authed: keys.authed, sonAuthed: keys.sonAuthed,
    send: (res, code, body, type) => { res.out = { code, body, type }; return res.out; },
    S: { authUrl: '', connected: true, transport: { finishAuth: stub('finishAuth') } }, P: { rec: { day: '2026-11-27', pos: null, sonk: { open: [] } }, ctl: {}, manGuard: undefined },
    CITY: 'CITYHTML', CITY_GZ: 'CITYGZ', DECK: 'DECKHTML', DECK_GZ: 'DECKGZ', SON: 'SONHTML', SON_GZ: 'SONGZ', DASH: 'DASHHTML', BT: { run: false, res: { ok: 1 } }, WATCH: null, CSK_ON: true, MAN: { gLoss: 30, gGain: 100 }, HIST: {},
    SONCFG: { son: true }, MANCFG: { son: false }, setImmediate: () => {}
  };
  const scope = new Proxy(base, { has: (o, k) => typeof k === 'string' && !(k in globalThis) && k !== 'arguments', get: (o, k) => k === Symbol.unscopables ? undefined : (k in o ? o[k] : stub(String(k))) });
  const make = code => new Function('scope', 'with (scope) { ' + code + ' }')(scope);
  base.sonRoute = make('return (' + SONROUTE + ');'); const handler = make(HANDLER + '\nreturn server;');
  return async (method, url, key, extra) => {
    const sep = url.indexOf('?') < 0 ? '?' : '&', res = { out: null, writeHead(c, h) { this.out = { code: c, headers: h }; }, end(b) { this.out = Object.assign(this.out || {}, { body: b }); } };
    touched.length = 0; await handler({ method, url: url + (key === undefined ? '' : sep + 'key=' + key), headers: Object.assign({}, extra) }, res);
    return { code: res.out && res.out.code, body: res.out && res.out.body, headers: res.out && res.out.headers, touched: touched.slice() };
  };
}
const JAMES_GET = ['/api/deck', '/api/deck/history', '/api/city', '/api/bt', '/api/status', '/api/live', '/api/real', '/city', '/ops', '/auth'];
const JAMES_POST = ['/api/ondemand?sym=SPY&side=call&qty=1', '/api/closebook?book=orb&sym=SPY&t0=1', '/api/stopday', '/api/resumeday', '/api/cskday?on=1', '/api/manguard?on=0', '/api/control?run=1', '/api/close', '/api/watch?syms=SPY', '/api/real/anything'];

t('the son key: / redirects to /son, /son and /api/son/state work and reach only the son code', async () => {
  const go = build('A', 'S'); const a = await go('GET', '/', 'S'); assert.deepStrictEqual([a.code, a.headers.location], [302, '/son?key=S']); assert.deepStrictEqual(a.touched, []);
  const b = await go('GET', '/son', 'S'); assert.deepStrictEqual([b.code, b.body], [200, 'SONHTML']); const c = await go('GET', '/api/son/state', 'S'); assert.strictEqual(c.code, 200); assert.deepStrictEqual(c.touched, ['deckOut']);
  const d = await go('POST', '/api/son/enter?sym=SPY&side=call&qty=1', 'S'); assert.strictEqual(d.code, 200); assert.deepStrictEqual(d.touched, ['manualEnterSon']); const e = await go('POST', '/api/son/close?sym=SPY&t0=1&n=1', 'S'); assert.deepStrictEqual(e.touched, ['manualCloseBook']);
  const x = await go('GET', '/api/son/state', 'S', { 'x-key': undefined }); assert.strictEqual(x.code, 200);
});
t('the son key reaches NOTHING else: every James, admin, studies, CSK, stop-day, control and real-money route, GET or POST, answers non-200 and calls no stubbed function', async () => {
  const go = build('A', 'S');
  for (const p of JAMES_GET) for (const m of ['GET', 'POST']) { const r = await go(m, p, 'S'); assert.notStrictEqual(r.code, 200, m + ' ' + p); assert.deepStrictEqual(r.touched, [], m + ' ' + p + ' touched ' + r.touched); }
  for (const p of JAMES_POST) for (const m of ['GET', 'POST']) { const r = await go(m, p, 'S'); assert.notStrictEqual(r.code, 200, m + ' ' + p); assert.deepStrictEqual(r.touched, [], m + ' ' + p + ' touched ' + r.touched); }
  const hdr = await go('POST', '/api/stopday', undefined, { 'x-key': 'S' }); assert.notStrictEqual(hdr.code, 200); assert.deepStrictEqual(hdr.touched, [], 'the x-key header carries no extra rights');
});
t('no key or a wrong key: 401 on the page and on every route, nothing called; /health stays open', async () => {
  const go = build('A', 'S');
  for (const key of [undefined, '', 'X', 'a', 's']) for (const p of ['/', '/son', '/api/son/state', '/api/deck', '/api/ondemand?sym=SPY&side=call&qty=1', '/api/son/stopday', '/city']) for (const m of ['GET', 'POST']) { const r = await go(m, p, key); assert.strictEqual(r.code, 401, m + ' ' + p + ' key ' + key); assert.deepStrictEqual(r.touched, []); }
  assert.strictEqual((await go('GET', '/health')).code, 200);
});
t('James\'s key opens everything the deck needs, including /son to look at it; / is the deck and /city the classic page', async () => {
  const go = build('A', 'S'); const a = await go('GET', '/', 'A'); assert.deepStrictEqual([a.code, a.body], [200, 'DECKHTML']); const b = await go('GET', '/city', 'A'); assert.deepStrictEqual([b.code, b.body], [200, 'CITYHTML']);
  const c = await go('GET', '/son', 'A'); assert.deepStrictEqual([c.code, c.body], [200, 'SONHTML']); const d = await go('GET', '/api/son/state', 'A'); assert.deepStrictEqual([d.code, d.touched], [200, ['deckOut']]); const e = await go('GET', '/api/deck', 'A'); assert.deepStrictEqual([e.code, e.touched], [200, ['deckOut']]);
  const f = await go('POST', '/api/cskday?on=1', 'A'); assert.strictEqual(f.code, 200); const g = await go('POST', '/api/closebook?book=orb&sym=SPY&t0=1&n=1', 'A'); assert.deepStrictEqual(g.touched, ['manualCloseBook']);
});
t('a SON_KEY equal to ADMIN_KEY or empty gives nothing extra: the key acts as the admin key only, never as the son key; an empty SON_KEY never matches an empty key', async () => {
  const same = build('K', 'K'); const a = await same('GET', '/', 'K'); assert.deepStrictEqual([a.code, a.body], [200, 'DECKHTML'], 'treated as admin, not redirected'); const none = build('A', ''); assert.strictEqual((await none('GET', '/son', '')).code, 401); assert.strictEqual((await none('GET', '/son', undefined)).code, 401);
  const noAdmin = build('', 'S'); assert.strictEqual((await noAdmin('GET', '/api/deck', 'S')).code === 200, false); const ok = await noAdmin('GET', '/api/son/state', 'S'); assert.strictEqual(ok.code, 200, 'the son key still works with no admin key set');
});
t('the son routes accept only POST for writes and never expose a stop-day or close that touches James: /api/son/stopday only calls the son close path', async () => {
  const go = build('A', 'S'); const g = await go('GET', '/api/son/enter?sym=SPY&side=call&qty=1', 'S'); assert.notStrictEqual(g.code, 200); assert.deepStrictEqual(g.touched, []); const g2 = await go('GET', '/api/son/stopday', 'S'); assert.notStrictEqual(g2.code, 200);
  const s = await go('POST', '/api/son/stopday', 'S'); assert.strictEqual(s.code, 200); assert.ok(!s.touched.includes('manualClose') && !s.touched.includes('closePaper'), 'no James close path: ' + s.touched);
});
(async () => { for (const [n, f] of tests) { try { await f(); pass++; console.log('ok   ' + n); } catch (e) { console.log('FAIL ' + n + '\n' + (e && e.stack || e)); } } console.log(pass + '/' + tests.length + ' passed'); process.exit(pass === tests.length ? 0 : 1); })();
