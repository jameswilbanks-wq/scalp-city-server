/* Real money page scaffold (server.js: REAL_CHECKLIST, realStatus, the /api/real routes; public/city.html: the PAPER/REAL toggle and #realPage) test. Behaviour under test: this build can NEVER connect to a real account or place an order, even with REAL_ON=1 and credentials present; credentials are never put in a response; the real routes sit behind the key check and refuse anything but a GET of the status; the Real page has no order or close buttons and only calls /api/real. No network, no orders, no keys. No existing test covers this (manual_close.test.js and cskreal_wire.test.js cover other code). Run: node test/real_page.test.js */
'use strict';
const assert = require('assert'), fs = require('fs'), path = require('path');
const SRC = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8'), HTML = fs.readFileSync(path.join(__dirname, '..', 'public', 'city.html'), 'utf8');
let pass = 0; const tests = []; const t = (n, f) => tests.push([n, f]);
const a = SRC.indexOf('const REAL_CHECKLIST'), b = SRC.indexOf('/* ---------- city page (3D view)'); const BLOCK = SRC.slice(a, b);
const status = env => new Function('process', BLOCK + '\nreturn realStatus();')({ env });

t('default: not connected, cannot order, every readiness step undone', () => {
  const s = status({}); assert.strictEqual(s.connected, false); assert.strictEqual(s.canOrder, false); assert.strictEqual(s.account, null); assert.deepStrictEqual(s.positions, []); assert.ok(s.checklist.length >= 9 && s.checklist.every(c => c.done === false)); assert.ok(s.reasons.some(r => /REAL_ON/.test(r)) && s.reasons.some(r => /credentials/.test(r)));
});
t('even with REAL_ON=1 and credentials set it is still not connected and cannot order (no real code exists), and no secret appears in the response', () => {
  const s = status({ REAL_ON: '1', REAL_ALPACA_KEY: 'KEYVALUE123', REAL_ALPACA_SECRET: 'SECRETVALUE456' }); assert.strictEqual(s.connected, false); assert.strictEqual(s.canOrder, false); const j = JSON.stringify(s); assert.ok(!/KEYVALUE123|SECRETVALUE456/.test(j)); assert.ok(s.reasons.some(r => /not built/.test(r)) && !s.reasons.some(r => /REAL_ON|credentials/.test(r)));
});
t('source guard: no live broker URL, the real credential names appear only in the presence check, and the block has no fetch/order call', () => {
  assert.ok(!/https:\/\/api\.alpaca\.markets/.test(SRC), 'no live Alpaca trading URL anywhere'); assert.strictEqual((SRC.match(/REAL_ALPACA_KEY/g) || []).length, 1, 'only in realStatus (presence check)'); assert.strictEqual((BLOCK.match(/REAL_ALPACA_KEY/g) || []).length, 1);
  const code = BLOCK.replace(/\/\*[\s\S]*?\*\//g, ''); assert.ok(!/apTrade|fetch\(|https?:\/\/|\/v2\/orders|rh\(/.test(code), 'no network or order call in the real block');
});
t('routes: GET /api/real returns the status, any other /api/real request is refused 403, both after the key check', () => {
  const auth = SRC.indexOf('if (!authed(u, req))'), get = SRC.indexOf("u.pathname === '/api/real' && req.method === 'GET'"), ref = SRC.indexOf("u.pathname.startsWith('/api/real')"); assert.ok(auth > 0 && get > auth && ref > get, 'ordered after auth: GET then the 403 catch-all');
  assert.ok(/startsWith\('\/api\/real'\)\) return send\(res, 403/.test(SRC));
});
t('page: toggle exists, the Real page has no order/close buttons (only the two toggle buttons), loads only /api/real, and paper stays the default', () => {
  const page = HTML.slice(HTML.indexOf('<div id="realPage"'), HTML.indexOf('<canvas id="gl"')); assert.strictEqual((page.match(/<button/g) || []).length, 2, 'only PAPER/REAL toggle buttons'); assert.ok(!/b(close|exit|buy|sell)b/i.test(page.replace(/no order or close buttons/g, '')), 'no trading words besides the disclaimer');
  assert.ok(/id="acctSwitch"[^>]*hidden/.test(HTML) && /var ACCT='paper'/.test(HTML)); const js = HTML.slice(HTML.indexOf('function realLoad'), HTML.indexOf('function acctSet')); assert.ok(/'\/api\/real'/.test(js) && !/closebook|\/api\/close|\/api\/control/.test(js));
});
(async () => { for (const [n, f] of tests) { try { await f(); pass++; console.log('ok   ' + n); } catch (e) { console.error('FAIL ' + n + '\n' + (e && e.stack || e)); process.exitCode = 1; } } console.log(pass + '/' + tests.length + ' passed'); })();
