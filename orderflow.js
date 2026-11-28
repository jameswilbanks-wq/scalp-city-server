/* Order flow for the open trade cards (James approved the mockup 2026-11-28). DISPLAY ONLY: nothing here is read by tick(), a stop, an entry or an exit.
   It shares the Alpaca data key with the calls the stops depend on, so it is capped on purpose: one cache per symbol shared by every viewer, a refresh at most every 15 s per symbol,
   at most MAX_PAGES pages per refresh, at most BUDGET requests a minute in total (the free plan allows 200), a 60 s pause for all symbols after any 429, and a timeout on every call.
   Only trades that already happened (no order book). Feed is IEX, one exchange. */
const WINDOW = 30 * 60000, TTL = 15000, MAX_PAGES = 4, BUDGET = 30, PAUSE = 60000, TIMEOUT = 8000, MAX_TRADES = 60000, MAX_BUBBLES = 140, MAX_ROWS = 24;
const STEPS = [0.01, 0.02, 0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10];
const r2 = v => Math.round(v * 100) / 100;

/* trades: [{ms,p,s,d}] oldest first, d = +1 price ticked up, -1 ticked down, 0 unknown. Returns the compact picture the page draws. */
function aggregate(trades, now) {
  const from = Math.floor(now / 60000) * 60000 - (WINDOW - 60000), list = trades.filter(x => x.ms >= from && x.ms <= now); // 30 clock-minute columns (the newest still filling), so a column never moves between refreshes
  if (!list.length) return { from, to: now, n: 0, step: null, line: [], bubbles: [], profile: [], poc: null, lo: null, hi: null, last: null };
  let lo = Infinity, hi = -Infinity; for (const x of list) { if (x.p < lo) lo = x.p; if (x.p > hi) hi = x.p; }
  const step = STEPS.find(s => (hi - lo) / s < MAX_ROWS) || STEPS[STEPS.length - 1];
  const prof = new Map(), bub = new Map(), line = new Map();
  for (const x of list) {
    const m = Math.min(29, Math.floor((x.ms - from) / 60000)), b = Math.round(x.p / step), k = m + '|' + b + '|' + x.d;
    prof.set(b, (prof.get(b) || 0) + x.s);
    const g = bub.get(k) || { m, v: 0, pv: 0, d: x.d }; g.v += x.s; g.pv += x.p * x.s; bub.set(k, g);
    line.set(m, x); // the last trade of each minute
  }
  const profile = [...prof].sort((a, b) => a[0] - b[0]).map(([b, v]) => [r2(b * step), v]);
  const poc = profile.reduce((a, c) => c[1] > a[1] ? c : a, profile[0])[0];
  const bubbles = [...bub.values()].sort((a, b) => b.v - a.v).slice(0, MAX_BUBBLES).map(g => [g.m, r2(g.pv / g.v), g.v, g.d]);
  const last = list[list.length - 1];
  return { from, to: now, n: list.length, step, line: [...line].sort((a, b) => a[0] - b[0]).map(([, x]) => [Math.round((x.ms - from) / 6000) / 10, r2(x.p)]), bubbles, profile, poc, lo: r2(lo), hi: r2(hi), last: { ms: last.ms, p: r2(last.p) } };
}

/* get(path, query) is the server's Alpaca data reader. clock() is injectable for the tests. */
function create(get, clock) {
  const now = clock || Date.now, cache = {}, used = []; let pausedUntil = 0;
  const room = () => { const t = now(); while (used.length && t - used[0] > 60000) used.shift(); return used.length < BUDGET; };
  const timed = p => new Promise((ok, no) => { const h = setTimeout(() => no(new Error('timeout')), TIMEOUT); p.then(v => { clearTimeout(h); ok(v); }, e => { clearTimeout(h); no(e); }); });

  async function refresh(sym, c) {
    const t = now(), floor = t - WINDOW;
    if (c.trades.length && c.trades[c.trades.length - 1].ms < floor) { c.trades = []; c.cursor = null; }
    const startMs = c.cursor ? Math.max(c.cursor.ms, floor) : floor, start = c.cursor && c.cursor.ms >= floor ? c.cursor.t : new Date(startMs).toISOString();
    let token = '', pages = 0;
    do {
      if (now() < pausedUntil || !room()) { c.behind = true; return; }
      used.push(now()); pages++;
      const d = await timed(get('/v2/stocks/trades', { symbols: sym, start, feed: 'iex', limit: 10000, sort: 'asc', page_token: token }));
      for (const z of ((d.trades || {})[sym] || [])) {
        const ms = Date.parse(z.t), p = +z.p, s = +z.s; if (!(ms > 0) || !(p > 0) || !(s > 0)) continue;
        if (c.cursor) { if (ms < c.cursor.ms) continue; if (ms === c.cursor.ms && c.cursor.ids.has(z.i)) continue; }
        const prev = c.trades[c.trades.length - 1], dir = !prev ? 0 : p > prev.p ? 1 : p < prev.p ? -1 : prev.d;
        c.trades.push({ ms, p, s, d: dir });
        if (!c.cursor || ms > c.cursor.ms) c.cursor = { ms, t: z.t, ids: new Set([z.i]) }; else c.cursor.ids.add(z.i);
      }
      token = d.next_page_token || '';
    } while (token && pages < MAX_PAGES);
    c.behind = !!token; // more trades are waiting; the next refresh continues from the last one kept
  }

  function drop(c) { const floor = now() - WINDOW; let i = 0; while (i < c.trades.length && c.trades[i].ms < floor) i++; if (c.trades.length - i > MAX_TRADES) i = c.trades.length - MAX_TRADES; if (i) c.trades.splice(0, i); }

  async function view(sym) {
    const c = cache[sym] = cache[sym] || { trades: [], cursor: null, at: 0, goodAt: 0, busy: null, behind: false, err: '' };
    if (!c.busy && now() - c.at >= TTL && now() >= pausedUntil && room()) {
      c.at = now();
      c.busy = refresh(sym, c).then(() => { c.err = ''; c.goodAt = now(); }, e => { const msg = String((e && e.message) || e); c.err = msg.slice(0, 120); if (/\b429\b/.test(msg)) pausedUntil = now() + PAUSE; }).finally(() => { c.busy = null; });
    }
    if (c.busy) await c.busy;
    drop(c);
    if (c.behind) return { state: 'loading' }; // never show a part of the window as the whole 30 minutes
    if (!c.goodAt) return { state: 'unavailable', err: c.err };
    const stale = now() - c.goodAt > 90000, a = aggregate(c.trades, c.goodAt);
    return Object.assign({ state: a.n ? 'ok' : 'empty', stale }, a);
  }
  return { view, stats: () => ({ requestsLastMinute: (room(), used.length), pausedUntil }), cache };
}
module.exports = { aggregate, create, WINDOW, TTL, MAX_PAGES, BUDGET, PAUSE, MAX_BUBBLES };
